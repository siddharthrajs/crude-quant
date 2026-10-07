from pathlib import Path

from pydantic_settings import BaseSettings

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    app_name: str = "Crude Quant Dashboard API"
    cors_origins: list[str] = ["http://localhost:5173"]

    # Lightstreamer market data feed
    lightstreamer_server: str = "https://ls.prod-live.hertshtengroup.com/"
    lightstreamer_adapter_set: str = "MARKET_DATA"
    lightstreamer_data_adapter: str = "MDS"
    lightstreamer_autostart: bool = True
    instruments_file: Path = BACKEND_DIR / "app" / "lightstreamer" / "data" / "instruments.json"

    # Entra ID (unattended device-code login, see app/lightstreamer/token_manager.py)
    entra_client_id: str = "b6bd48fa-55db-41aa-9af8-e74283e478fb"
    entra_tenant_id: str = "0753c1a4-2be6-4a86-8763-32ae847e1186"
    credentials_dir: Path = BACKEND_DIR / ".credentials"

    # Fixed UPN passed to Lightstreamer's connectionDetails.setUser() -- the
    # access-as-application token no longer carries a delegated identity to
    # read this from.
    lightstreamer_user: str = ""

    # Mirrored into .env by token_manager on every refresh, for anything that
    # wants to read the current token without importing msal. Not read by
    # this process itself -- the feed gets the live token in-memory via
    # token_manager.get_token()/start_auto_refresh(), not from Settings.
    lightstreamer_token: str = ""

    # Postgres (users/auth, see app/db/)
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/postgres"

    # Username/password auth (see app/auth/)
    jwt_secret_key: str = "change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 12

    @property
    def entra_authority(self) -> str:
        return f"https://login.microsoftonline.com/{self.entra_tenant_id}"

    class Config:
        env_file = ".env"


settings = Settings()
settings.credentials_dir.mkdir(parents=True, exist_ok=True)
