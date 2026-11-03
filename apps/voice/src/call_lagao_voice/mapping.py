"""Pure functions that turn an ``AgentConfig`` into LiveKit Agents settings.

Nothing here imports livekit, so it is trivially unit-testable. ``agent.py``
feeds these kwargs into the plugin constructors / ``AgentSession``.
See apps/api/README.md (service contract) section 4.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Literal

from .models import (
    AgentConfig,
    DisconnectionReason,
    EngineConfig,
    SttConfig,
    TurnConfig,
    VoiceConfig,
)

_TEMPLATE_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")


def render_template(text: str, variables: dict[str, str]) -> str:
    """Replace ``{{name}}`` with ``variables[name]``; unknown names are left untouched.

    Mirrors ``renderTemplate`` in packages/shared/src/agent.ts.
    """

    def _sub(m: re.Match[str]) -> str:
        key = m.group(1)
        return str(variables[key]) if key in variables else m.group(0)

    return _TEMPLATE_RE.sub(_sub, text)


# --------------------------------------------------------------------------- turn-taking


@dataclass(frozen=True)
class TurnSettings:
    min_endpointing_delay: float  # seconds
    max_endpointing_delay: float  # seconds
    allow_interruptions: bool
    min_interruption_duration: float  # seconds
    min_interruption_words: int

    def turn_handling(self, turn_detection: Any = None) -> dict[str, Any]:
        """``AgentSession(turn_handling=...)`` dict (livekit-agents 1.8 ``TurnHandlingOptions``).

        The flat ``min_endpointing_delay=`` / ``allow_interruptions=`` kwargs still
        work in 1.8 but are deprecated; this is the same mapping in the new shape.
        ``turn_detection`` is only included when given, so the session can
        auto-select otherwise.
        """
        opts: dict[str, Any] = {
            "endpointing": {
                "mode": "fixed",
                "min_delay": self.min_endpointing_delay,
                "max_delay": self.max_endpointing_delay,
            },
            "interruption": {
                # Pin VAD-based interruption: auto mode picks the cloud "adaptive"
                # detector in dev but not in prod, which would make the contract's
                # duration/word thresholds behave differently per environment.
                "mode": "vad",
                "enabled": self.allow_interruptions,
                "min_duration": self.min_interruption_duration,
                "min_words": self.min_interruption_words,
            },
        }
        if turn_detection is not None:
            opts["turn_detection"] = turn_detection
        return opts


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def map_turn(turn: TurnConfig) -> TurnSettings:
    """service contract §4: responsiveness / interruption_sensitivity -> session settings."""
    r = _clamp01(turn.responsiveness)
    s = _clamp01(turn.interruption_sensitivity)
    if s >= 0.7:
        words = 0
    elif s >= 0.4:
        words = 1
    else:
        words = 2
    return TurnSettings(
        min_endpointing_delay=round(0.2 + (1 - r) * 1.0, 6),
        max_endpointing_delay=round(2.0 + (1 - r) * 3.0, 6),
        allow_interruptions=s > 0,
        min_interruption_duration=round(0.2 + (1 - s) * 1.3, 6),
        min_interruption_words=words,
    )


# --------------------------------------------------------------------------- greeting


@dataclass(frozen=True)
class GreetingPlan:
    """What to do when the call starts.

    ``say``      -> ``session.say(text)``
    ``generate`` -> ``session.generate_reply()``
    ``wait``     -> wait for the user to speak first
    """

    action: Literal["say", "generate", "wait"]
    text: str | None = None


def plan_greeting(engine: EngineConfig, variables: dict[str, str]) -> GreetingPlan:
    if engine.start_speaker == "user":
        return GreetingPlan("wait")
    if engine.begin_message is None:
        return GreetingPlan("generate")
    text = render_template(engine.begin_message, variables).strip()
    # "" means "wait for the user" (agent.ts comment on begin_message).
    return GreetingPlan("say", text) if text else GreetingPlan("wait")


# --------------------------------------------------------------------------- plugins


def stt_kwargs(stt: SttConfig) -> dict[str, Any]:
    """Kwargs for ``livekit.plugins.deepgram.STT``.

    ``language="multi"`` turns on Deepgram's code-switching mode (nova-2/nova-3).
    """
    language = (stt.language or "en").strip() or "en"
    return {"model": stt.model, "language": language}


def llm_kwargs(engine: EngineConfig) -> dict[str, Any]:
    """Kwargs for ``livekit.plugins.openai.LLM``."""
    return {"model": engine.model, "temperature": engine.temperature}


# Defaults used when ``voice.model`` is not set (low-latency models of each provider).
DEFAULT_TTS_MODELS: dict[str, str] = {
    "elevenlabs": "eleven_flash_v2_5",
    "cartesia": "sonic-3",
    "openai": "gpt-4o-mini-tts",
}

# ElevenLabs only accepts speed in [0.8, 1.2] (VoiceSettings.speed).
ELEVENLABS_SPEED_RANGE = (0.8, 1.2)


@dataclass(frozen=True)
class TtsSpec:
    """Which TTS plugin to build and with what constructor kwargs.

    ``elevenlabs_speed`` is set only for ElevenLabs when speed != 1: that plugin
    takes speed through ``VoiceSettings``, which ``agent.build_tts`` constructs.
    """

    provider: Literal["elevenlabs", "cartesia", "openai"]
    kwargs: dict[str, Any]
    elevenlabs_speed: float | None = None


def base_language(language: str) -> str | None:
    """``"hi-IN"`` -> ``"hi"``; ``"multi"`` -> ``None`` (let the provider auto-detect)."""
    lang = (language or "").strip()
    if not lang or lang == "multi":
        return None
    return lang.split("-")[0].lower()


def tts_spec(voice: VoiceConfig, stt_language: str = "en") -> TtsSpec:
    """Plugin + kwargs for the configured TTS provider.

    - elevenlabs: ``elevenlabs.TTS(voice_id=..., model=..., [voice_settings])``
    - cartesia:   ``cartesia.TTS(voice=..., model=..., language=..., [speed])``
    - openai:     ``openai.TTS(voice=..., model=..., speed=...)``
    """
    model = voice.model or DEFAULT_TTS_MODELS[voice.provider]
    if voice.provider == "elevenlabs":
        speed = None
        if voice.speed != 1:
            lo, hi = ELEVENLABS_SPEED_RANGE
            speed = max(lo, min(hi, voice.speed))
        return TtsSpec(
            "elevenlabs", {"voice_id": voice.voice_id, "model": model}, elevenlabs_speed=speed
        )
    if voice.provider == "cartesia":
        kwargs: dict[str, Any] = {
            "voice": voice.voice_id,
            "model": model,
            "language": base_language(stt_language),
        }
        if voice.speed != 1:
            kwargs["speed"] = voice.speed
        return TtsSpec("cartesia", kwargs)
    return TtsSpec("openai", {"voice": voice.voice_id, "model": model, "speed": voice.speed})


def build_instructions(config: AgentConfig, variables: dict[str, str]) -> str:
    return render_template(config.engine.prompt, variables)


# --------------------------------------------------------------------------- lifecycle reasons

USER_IDENTITIES = ("user", "phone_user")

_ERROR_TYPE_TO_REASON: dict[str, DisconnectionReason] = {
    "llm_error": "error_llm",
    "realtime_model_error": "error_llm",
    "stt_error": "error_stt",
    "tts_error": "error_tts",
}


def reason_for_session_close(close_reason: str, error_type: str | None) -> DisconnectionReason:
    """Map an ``AgentSession`` ``close`` event we did not initiate to a disconnection reason.

    ``close_reason`` is ``livekit.agents.voice.events.CloseReason`` (value) and
    ``error_type`` is ``ev.error.type`` (``"llm_error"`` / ``"stt_error"`` / ...).
    """
    if close_reason == "error":
        return _ERROR_TYPE_TO_REASON.get(error_type or "", "error_unknown")
    if close_reason == "participant_disconnected":
        return "user_hangup"
    if close_reason == "job_shutdown":
        return "error_worker"
    return "error_unknown"


def reason_for_participant_left(
    disconnect_reason: str | None, *, answered: bool, is_sip: bool
) -> DisconnectionReason:
    """Reason when the caller participant leaves.

    ``disconnect_reason`` is the ``rtc.DisconnectReason`` *name*
    (``"CLIENT_INITIATED"``, ``"ROOM_DELETED"``, ``"USER_UNAVAILABLE"``, ...).
    A SIP participant that leaves before answering maps to the ``dial_*`` reasons.
    """
    if disconnect_reason == "ROOM_DELETED":
        return "manual_stopped"
    if is_sip and not answered:
        if disconnect_reason == "USER_REJECTED":
            return "dial_busy"
        if disconnect_reason == "SIP_TRUNK_FAILURE":
            return "dial_failed"
        return "dial_no_answer"
    return "user_hangup"


def parse_call_id(job_metadata: str | None, fallback: str | None = None) -> str:
    """``ctx.job.metadata`` is the JSON string ``{"call_id": "..."}`` (service contract §3, apps/api/README.md).

    Falls back to the room name, which is also the call id.
    """
    if job_metadata:
        try:
            data = json.loads(job_metadata)
        except ValueError:
            data = None
        if isinstance(data, dict) and isinstance(data.get("call_id"), str) and data["call_id"]:
            return data["call_id"]
    if fallback:
        return fallback
    raise ValueError("job metadata has no call_id and no fallback room name")
