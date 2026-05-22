"""
Dynamic Config Service — DB > .env > default.
Reads settings from app_config table first, falls back to env/defaults.
Sensitive values (API keys, tokens) are encrypted at rest with Fernet.
"""

import base64
import hashlib
from typing import Any, Optional

from cryptography.fernet import Fernet
from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models import AppConfig

# ---------------------------------------------------------------------------
# Encryption helpers
# ---------------------------------------------------------------------------

def _derive_fernet_key(secret: str) -> bytes:
    """Derive a Fernet-compatible key from an arbitrary secret string."""
    digest = hashlib.sha256(secret.encode()).digest()
    return base64.urlsafe_b64encode(digest)


def _is_sensitive(key: str) -> bool:
    """A key is sensitive if it stores raw credentials/API keys."""
    return (
        key in {
            "embedding_api_key", "llm_api_key", "vision_api_key",
            "smtp_password", "webhook_secret", "custom_llm_api_key",
        }
        or key.startswith("embedding_api_key__")  # per-provider keys
    )


# Backward-compat alias: code that compared `key in SENSITIVE_KEYS` should now
# call `_is_sensitive(key)`. Kept for any external callers.
SENSITIVE_KEYS = frozenset({
    "embedding_api_key",
    "llm_api_key",
    "vision_api_key",
})

# Active model selection (canonical spec_id from the respective catalog).
# All three follow the same pattern so the registry resolution code is uniform.
ACTIVE_EMBEDDING_MODEL_KEY = "active_embedding_model_spec_id"
ACTIVE_LLM_MODEL_KEY = "active_llm_model_spec_id"
ACTIVE_VISION_MODEL_KEY = "active_vision_model_spec_id"

# Per-provider embedding API keys: `embedding_api_key__<provider>`. We store
# one key per provider so admins can switch provider without losing the
# previously configured key. Encrypted at rest.
def embedding_api_key_for(provider: str) -> str:
    return f"embedding_api_key__{provider}"


# All config keys that can be managed via UI
ALL_CONFIG_KEYS = [
    # --- Embedding (whitelist-driven) ---
    ACTIVE_EMBEDDING_MODEL_KEY,  # canonical spec_id, e.g. "openai/text-embedding-3-small"
    "embedding_api_key__google",
    "embedding_api_key__openai",
    "embedding_base_url",        # optional, custom endpoint (Ollama, Azure, proxy)

    # --- LLM (catalog-driven; old llm_provider/llm_model_id kept readable below) ---
    ACTIVE_LLM_MODEL_KEY,        # canonical spec_id from LLM_CATALOG, or "custom"
    "llm_api_key",               # Provider API key
    "llm_base_url",              # Custom endpoint

    # --- Custom OpenAI-compatible LLM provider ---
    "custom_llm_base_url",       # e.g. https://my-proxy/v1
    "custom_llm_api_key",        # encrypted; empty = no auth required
    "custom_llm_model_id",       # model ID chosen from /v1/models

    # --- Vision (catalog-driven; old vision_provider/vision_model_id kept below) ---
    ACTIVE_VISION_MODEL_KEY,     # canonical spec_id from VISION_CATALOG
    "vision_api_key",            # Provider API key (or empty = same as embedding)
    "vision_base_url",           # Custom endpoint

    # --- Deprecated LLM/Vision free-form keys (read-only for backward compat) ---
    "llm_provider",
    "llm_model_id",
    "vision_provider",
    "vision_model_id",

    # --- System ---
    "session_timeout_minutes",

    # --- Deprecated embedding keys (kept readable for one release; do not write) ---
    "embedding_provider",
    "embedding_model_id",
    "embedding_api_key",
    "embedding_dimensions",
]


class ConfigService:
    """
    Config priority: DB > .env > default

    Usage:
        config_svc = ConfigService(db_session)
        api_key = await config_svc.get("google_api_key")
        await config_svc.set("google_api_key", "AIza...")
    """

    def __init__(self, db: AsyncSession):
        self.db = db
        self._fernet: Optional[Fernet] = None

    @property
    def fernet(self) -> Fernet:
        if self._fernet is None:
            from app.config import settings
            key = _derive_fernet_key(settings.secret_key)
            self._fernet = Fernet(key)
        return self._fernet

    def _encrypt(self, value: str) -> str:
        """Encrypt a value for storage."""
        return self.fernet.encrypt(value.encode()).decode()

    def _decrypt(self, value: str) -> str:
        """Decrypt a stored value."""
        try:
            return self.fernet.decrypt(value.encode()).decode()
        except Exception:
            # If decryption fails (e.g. key changed), return raw value
            logger.warning("Failed to decrypt config value, returning raw")
            return value

    async def get(self, key: str) -> Optional[str]:
        """
        Get a config value. Priority: DB > .env > default.
        """
        # 1. Try DB first
        stmt = select(AppConfig).where(AppConfig.key == key)
        result = await self.db.execute(stmt)
        row = result.scalar_one_or_none()

        if row and row.value:
            value = row.value
            if _is_sensitive(key):
                value = self._decrypt(value)
            return value

        # 2. Fallback to env/settings
        from app.config import settings
        env_value = getattr(settings, key, None)
        if env_value is not None:
            return str(env_value)

        return None

    async def set(self, key: str, value: str) -> None:
        """Set a config value in DB."""
        store_value = value
        if _is_sensitive(key) and value:
            store_value = self._encrypt(value)

        stmt = select(AppConfig).where(AppConfig.key == key)
        result = await self.db.execute(stmt)
        row = result.scalar_one_or_none()

        if row:
            row.value = store_value
        else:
            self.db.add(AppConfig(key=key, value=store_value))

        await self.db.flush()

    async def get_all(self) -> dict[str, Optional[str]]:
        """Get all config values (decrypted)."""
        result = {}
        for key in ALL_CONFIG_KEYS:
            result[key] = await self.get(key)
        return result

    async def get_all_for_ui(self) -> dict[str, Any]:
        """Get all config values, masking sensitive ones for UI display."""
        all_config = await self.get_all()
        ui_config = {}

        for key, value in all_config.items():
            if _is_sensitive(key) and value:
                # Mask: show only last 4 chars
                if len(value) > 8:
                    ui_config[key] = "•" * 8 + value[-4:]
                else:
                    ui_config[key] = "•" * len(value)
                ui_config[f"{key}_configured"] = True
            else:
                ui_config[key] = value
                if _is_sensitive(key):
                    ui_config[f"{key}_configured"] = bool(value)

        return ui_config

    async def set_batch(self, updates: dict[str, str]) -> dict[str, bool]:
        """Set multiple config values at once. Returns {key: success}."""
        results = {}
        for key, value in updates.items():
            if key not in ALL_CONFIG_KEYS:
                results[key] = False
                continue
            # Skip masked values (user didn't change them)
            if value and value.startswith("••••"):
                results[key] = True
                continue
            await self.set(key, value)
            results[key] = True
        return results


async def get_effective_config(db: AsyncSession) -> dict[str, Optional[str]]:
    """
    Convenience: get all effective config values (DB > env > default).
    Used by services that need the latest config.
    """
    svc = ConfigService(db)
    return await svc.get_all()
