from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.yaml"


class AuthConfig(BaseModel):
    username: str = "admin"
    password: str = "admin"
    secret_key: str = "dev-secret-change-me"


class ServerConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 5000


class DatabaseConfig(BaseModel):
    url: str = "sqlite:///./data/tickets.db"


class PathsConfig(BaseModel):
    uploads: str = "./data/uploads"


class DiscordConfig(BaseModel):
    token: str = ""
    channel_id: int = 0


class ReminderConfig(BaseModel):
    days_before: list[int] = Field(default_factory=lambda: [30, 14, 7, 1])
    run_hour: int = 9
    run_minute: int = 0


class ImportDefaultsConfig(BaseModel):
    expiry_months: int = 3


class AppConfig(BaseModel):
    auth: AuthConfig = Field(default_factory=AuthConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    database: DatabaseConfig = Field(default_factory=DatabaseConfig)
    paths: PathsConfig = Field(default_factory=PathsConfig)
    discord: DiscordConfig = Field(default_factory=DiscordConfig)
    reminder: ReminderConfig = Field(default_factory=ReminderConfig)
    import_defaults: ImportDefaultsConfig = Field(default_factory=ImportDefaultsConfig)


def load_config() -> AppConfig:
    if not CONFIG_PATH.exists():
        example = ROOT / "config.example.yaml"
        if example.exists():
            CONFIG_PATH.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
        else:
            return AppConfig()
    raw: dict[str, Any] = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
    return AppConfig.model_validate(raw)


settings = load_config()
