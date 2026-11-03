"""Worker settings, read from the environment.

The repo-root ``.env`` (``../../.env`` relative to ``apps/voice``) is loaded if it
exists, followed by ``apps/voice/.env``. Real environment variables always win.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# src/call_lagao_voice/config.py -> parents[2] = apps/voice, parents[4] = repo root
_VOICE_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = _VOICE_DIR.parents[1]

DEFAULT_AGENT_NAME = "call-lagao-agent"


def load_env_files() -> None:
    """Load .env files without overriding variables already set in the process."""
    for path in (_REPO_ROOT / ".env", _VOICE_DIR / ".env"):
        if path.is_file():
            load_dotenv(path, override=False)
    # livekit-plugins-elevenlabs only reads ELEVEN_API_KEY; accept the common alias too.
    if not os.environ.get("ELEVEN_API_KEY") and os.environ.get("ELEVENLABS_API_KEY"):
        os.environ["ELEVEN_API_KEY"] = os.environ["ELEVENLABS_API_KEY"]


@dataclass(frozen=True)
class Settings:
    api_base_url: str
    internal_api_secret: str
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    livekit_agent_name: str
    openai_api_key: str
    deepgram_api_key: str
    eleven_api_key: str
    cartesia_api_key: str

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ.get
        return cls(
            api_base_url=(env("API_BASE_URL") or "http://localhost:4000").rstrip("/"),
            internal_api_secret=env("INTERNAL_API_SECRET", ""),
            livekit_url=env("LIVEKIT_URL", ""),
            livekit_api_key=env("LIVEKIT_API_KEY", ""),
            livekit_api_secret=env("LIVEKIT_API_SECRET", ""),
            livekit_agent_name=env("LIVEKIT_AGENT_NAME") or DEFAULT_AGENT_NAME,
            openai_api_key=env("OPENAI_API_KEY", ""),
            deepgram_api_key=env("DEEPGRAM_API_KEY", ""),
            eleven_api_key=env("ELEVEN_API_KEY", "") or env("ELEVENLABS_API_KEY", ""),
            cartesia_api_key=env("CARTESIA_API_KEY", ""),
        )


load_env_files()
