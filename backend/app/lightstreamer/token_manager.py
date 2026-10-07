"""Unattended Entra auth: log in once, then never again.

Entra access tokens cannot be made permanent -- the exchange issues them with a
hard ~60-90 minute lifetime and that is not a setting anyone can turn up. What
*can* be permanent is the login behind them. MSAL keeps a refresh token in an
on-disk cache; every silent refresh returns a fresh access token and rolls the
refresh token forward, so a process that keeps refreshing keeps working
indefinitely without a prompt.

    python -m app.lightstreamer.authenticate     # once, ever

That writes .msal_token_cache.json (the durable part) into
settings.credentials_dir, and mirrors the current access token into .env as
LIGHTSTREAMER_TOKEN for anything that wants to read it without importing msal.
From then on the feed calls get_token() at startup and start_auto_refresh() to
rotate itself -- no pasting, no restarts.

This authenticates against a dedicated Entra app (CLIENT_ID below) requesting
the Lightstreamer resource's own "access_as_application" scope, not Graph's
User.Read -- the MDS adapter validates the token's audience directly instead
of via Graph. That token carries no delegated identity to read a username
from, so the UPN passed to connectionDetails.setUser() comes from
settings.lightstreamer_user instead of the id_token.

What still ends it, eventually:

  - 90 days with nothing running at all (the refresh token ages out unused);
    anything refreshing on a timer resets that clock every cycle
  - a password change, an admin revoking sessions, or a Conditional Access
    sign-in-frequency policy
  - deleting .msal_token_cache.json

All four are fixed the same way: run `python -m app.lightstreamer.authenticate`
again. If you need auth that survives even those, that is a different
mechanism -- an app registration with a client secret or certificate
(client-credentials flow, no user at all). It needs IT to grant it and the
Lightstreamer metadata adapter to accept an app-only token, which today
expects a username, so it is not a drop-in.

Guard the cache like a credential: .msal_token_cache.json and the
LIGHTSTREAMER_TOKEN line in .env are a live login. Keep both out of version
control (.env and .credentials/ already are, see .gitignore).
"""

import threading
import time

import msal

from app.config import BACKEND_DIR, settings

CACHE_FILE = settings.credentials_dir / ".msal_token_cache.json"
ENV_FILE = BACKEND_DIR / ".env"

# Scope on the Lightstreamer resource app itself, not Microsoft Graph.
SCOPES = ["api://28ab8830-42a2-4400-8ef0-07af1dfc1163/access_as_application"]

# Refresh this long before expiry. Comfortably more than one reconnect takes,
# so a session is never carrying a token that is about to die.
REFRESH_MARGIN = 600
RETRY_DELAY = 60

# MSAL has no default timeout, so a stalled connection to Entra (seen on this
# network) hangs forever instead of raising -- cap it so callers get an
# exception instead of needing Ctrl+C.
HTTP_TIMEOUT = 20

_lock = threading.RLock()
_current = None


def _load_cache():
    cache = msal.SerializableTokenCache()
    if CACHE_FILE.exists():
        cache.deserialize(CACHE_FILE.read_text(encoding="utf-8"))
    return cache


def _app():
    cache = _load_cache()
    app = msal.PublicClientApplication(
        client_id=settings.entra_client_id, authority=settings.entra_authority, token_cache=cache,
        timeout=HTTP_TIMEOUT)
    return app, cache


def _save_cache(cache):
    if cache.has_state_changed:
        CACHE_FILE.write_text(cache.serialize(), encoding="utf-8")


def _store_access_token(access_token):
    """Mirror the current access token into .env as LIGHTSTREAMER_TOKEN, for
    anything that wants to read it without importing msal."""
    token_entry = f"LIGHTSTREAMER_TOKEN={access_token}"
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines() if ENV_FILE.exists() else []

    updated_lines = []
    token_replaced = False

    for line in lines:
        key, separator, _ = line.partition("=")
        if separator and key.strip() == "LIGHTSTREAMER_TOKEN":
            if not token_replaced:
                updated_lines.append(token_entry)
                token_replaced = True
            continue
        updated_lines.append(line)

    if not token_replaced:
        updated_lines.append(token_entry)

    ENV_FILE.write_text("\n".join(updated_lines) + "\n", encoding="utf-8")


def _record(result):
    """Normalise an MSAL result into the shape everything else consumes."""
    global _current
    rec = {
        "access_token": result["access_token"],
        "user": settings.lightstreamer_user,
        "upn": settings.lightstreamer_user,
        "expires_at": time.time() + int(result.get("expires_in", 3600)),
    }
    _store_access_token(rec["access_token"])
    _current = rec
    return rec


def get_token(force_refresh=False, allow_interactive=True):
    """A valid token, refreshing silently if one is cached.

    Only prompts when there is no usable refresh token -- in practice once,
    the first time this project is run on a machine.
    """
    with _lock:
        app, cache = _app()
        accounts = app.get_accounts()
        if accounts:
            result = app.acquire_token_silent_with_error(
                SCOPES, account=accounts[0], force_refresh=force_refresh)
            _save_cache(cache)
            if result and "access_token" in result:
                return _record(result)
            reason = (result or {}).get("error_description") or "no cached refresh token"
            if not allow_interactive:
                raise RuntimeError(f"silent refresh failed: {reason.splitlines()[0]}")
            print(f"[token] silent refresh unavailable ({reason.splitlines()[0]})")

        if not allow_interactive:
            raise RuntimeError("no cached account -- run `python -m app.lightstreamer.authenticate`")

        flow = app.initiate_device_flow(scopes=SCOPES)
        if "user_code" not in flow:
            raise SystemExit(f"Failed to create device flow: {flow.get('error_description')}")
        print(flow["message"])
        result = app.acquire_token_by_device_flow(flow)
        _save_cache(cache)
        if "access_token" not in result:
            raise SystemExit(f"Auth failed: {result.get('error_description', result.get('error'))}")
        return _record(result)


def start_auto_refresh(on_token, margin=REFRESH_MARGIN):
    """Keep the token alive for the life of the process.

    `on_token(rec)` is called with each newly minted token -- the caller uses it
    to move a live session onto the new credentials. Failures are retried
    rather than fatal: a refresh can fail transiently (network), and the current
    token is usually still good for another few minutes.
    """
    def loop():
        while True:
            expires_at = (_current or {}).get("expires_at", 0)
            time.sleep(max(60, expires_at - margin - time.time()))
            try:
                rec = get_token(force_refresh=True, allow_interactive=False)
            except Exception as e:
                left = int(((_current or {}).get("expires_at", 0) - time.time()) / 60)
                print(f"[token] refresh failed ({e}); {left} min left on the current one, "
                      f"retrying in {RETRY_DELAY}s. If this persists, run `python -m app.lightstreamer.authenticate`")
                time.sleep(RETRY_DELAY)
                continue
            mins = int((rec["expires_at"] - time.time()) / 60)
            print(f"[token] refreshed silently, valid ~{mins} min")
            try:
                on_token(rec)
            except Exception as e:
                print(f"[token] rotation callback failed: {e}")

    t = threading.Thread(target=loop, name="token-refresh", daemon=True)
    t.start()
    return t
