"""One-time login. Run this once; the feed refreshes itself after that.

    python -m app.lightstreamer.authenticate

Prompts for a device-code login only if there is no usable refresh token in
.msal_token_cache.json -- otherwise it refreshes silently and exits. Re-run it
if the feed starts reporting that refresh has failed (see token_manager.py for
what causes that). Nothing needs to be pasted anywhere afterwards.
"""

import time

from app.lightstreamer import token_manager


def main():
    rec = token_manager.get_token()
    mins = int((rec["expires_at"] - time.time()) / 60)
    print(f"Signed in as {rec['upn'] or rec['user']}")
    print(f"Access token valid ~{mins} min, and will be refreshed automatically.")
    print(f"Durable login cached at {token_manager.CACHE_FILE} -- keep it out of version control.")


if __name__ == "__main__":
    main()
