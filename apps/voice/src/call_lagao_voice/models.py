"""Pydantic mirrors of the TypeScript contract types in ``packages/shared/src``.

Field names and defaults match ``agent.ts`` / ``call.ts`` exactly. Keep them in
sync by hand: ``AgentConfig.model_validate({})`` must equal ``defaultAgentConfig()``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

ToolName = Annotated[str, Field(pattern=r"^[a-zA-Z_][a-zA-Z0-9_]{0,63}$")]

DEFAULT_END_CALL_DESCRIPTION = (
    "End the call when the conversation is complete or the user asks to hang up."
)


class _Model(BaseModel):
    # The API is the validator of record; the worker tolerates extra fields so a
    # newer API never crashes an older worker.
    model_config = ConfigDict(extra="ignore")


# --------------------------------------------------------------------------- tools


class EndCallTool(_Model):
    type: Literal["end_call"] = "end_call"
    name: ToolName = "end_call"
    description: str = DEFAULT_END_CALL_DESCRIPTION


class ToolParameters(_Model):
    model_config = ConfigDict(extra="allow")  # keep extra JSON-schema keys

    type: Literal["object"] = "object"
    properties: dict[str, Any] = Field(default_factory=dict)
    required: list[str] | None = None


class CustomTool(_Model):
    type: Literal["custom"] = "custom"
    name: ToolName
    description: str = Field(min_length=1)
    url: str
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] = "POST"
    headers: dict[str, str] = Field(default_factory=dict)
    parameters: ToolParameters = Field(default_factory=ToolParameters)
    timeout_ms: int = Field(default=10_000, ge=1000, le=120_000)
    speak_during_execution: bool = False
    execution_message: str | None = None


Tool = Annotated[Union[EndCallTool, CustomTool], Field(discriminator="type")]


# --------------------------------------------------------------------------- agent config


class EngineConfig(_Model):
    type: Literal["prompt"] = "prompt"
    prompt: str = "You are a friendly, concise voice assistant."
    # None = let the LLM generate the greeting; "" = wait for the user to speak first.
    begin_message: str | None = "Hi! How can I help you today?"
    start_speaker: Literal["agent", "user"] = "agent"
    model: str = "gpt-4.1-mini"
    temperature: float = Field(default=0.4, ge=0, le=2)
    tools: list[Tool] = Field(default_factory=lambda: [EndCallTool()])


class VoiceConfig(_Model):
    provider: Literal["elevenlabs", "cartesia", "openai"] = "elevenlabs"
    voice_id: str = "21m00Tcm4TlvDq8ikWAM"
    model: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2)


class SttConfig(_Model):
    provider: Literal["deepgram"] = "deepgram"
    model: str = "nova-3"
    language: str = "en"  # BCP-47 or "multi"


class TurnConfig(_Model):
    interruption_sensitivity: float = Field(default=0.8, ge=0, le=1)
    responsiveness: float = Field(default=0.8, ge=0, le=1)


class CallLimits(_Model):
    max_call_duration_ms: int = Field(default=1_800_000, ge=60_000, le=7_200_000)
    end_call_after_silence_ms: int = Field(default=60_000, ge=10_000, le=3_600_000)


class AnalysisField(_Model):
    name: ToolName
    type: Literal["string", "boolean", "number", "enum"]
    description: str = ""
    choices: list[str] | None = None


class AnalysisConfig(_Model):
    model: str = "gpt-4.1-mini"
    fields: list[AnalysisField] = Field(default_factory=list)


class AgentConfig(_Model):
    engine: EngineConfig = Field(default_factory=EngineConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    stt: SttConfig = Field(default_factory=SttConfig)
    turn: TurnConfig = Field(default_factory=TurnConfig)
    call: CallLimits = Field(default_factory=CallLimits)
    analysis: AnalysisConfig = Field(default_factory=AnalysisConfig)
    webhook_url: str | None = None


# --------------------------------------------------------------------------- call context


class CallInfo(_Model):
    call_id: str
    call_type: Literal["web_call", "phone_call"]
    direction: Literal["inbound", "outbound"] | None = None
    agent_id: str
    agent_version: int
    from_number: str | None = None
    to_number: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class CallContext(_Model):
    call: CallInfo
    agent_name: str
    agent_config: AgentConfig = Field(default_factory=AgentConfig)
    dynamic_variables: dict[str, str] = Field(default_factory=dict)


# --------------------------------------------------------------------------- transcript


class AgentTranscriptItem(_Model):
    role: Literal["agent"] = "agent"
    content: str
    start_ms: float | None = None
    end_ms: float | None = None
    interrupted: bool | None = None


class UserTranscriptItem(_Model):
    role: Literal["user"] = "user"
    content: str
    start_ms: float | None = None
    end_ms: float | None = None


class ToolCallInvocationItem(_Model):
    role: Literal["tool_call_invocation"] = "tool_call_invocation"
    tool_call_id: str
    name: str
    arguments: str  # JSON string
    time_ms: float | None = None


class ToolCallResultItem(_Model):
    role: Literal["tool_call_result"] = "tool_call_result"
    tool_call_id: str
    content: str
    successful: bool
    time_ms: float | None = None


TranscriptItem = Annotated[
    Union[AgentTranscriptItem, UserTranscriptItem, ToolCallInvocationItem, ToolCallResultItem],
    Field(discriminator="role"),
]


# --------------------------------------------------------------------------- reports

DisconnectionReason = Literal[
    "user_hangup",
    "agent_hangup",
    "manual_stopped",
    "inactivity",
    "max_duration_reached",
    "dial_failed",
    "dial_no_answer",
    "dial_busy",
    "concurrency_limit_reached",
    "error_llm",
    "error_stt",
    "error_tts",
    "error_worker",
    "error_unknown",
]


class LatencySamples(_Model):
    e2e: list[float] = Field(default_factory=list)
    stt: list[float] = Field(default_factory=list)
    llm: list[float] = Field(default_factory=list)
    tts: list[float] = Field(default_factory=list)


class UsageReport(_Model):
    llm_model: str | None = None
    llm_prompt_tokens: int = 0
    llm_completion_tokens: int = 0
    llm_requests: int = 0
    tts_provider: str | None = None
    tts_characters: int = 0
    stt_audio_seconds: float = 0


class CallStartedReport(_Model):
    started_at: int  # epoch ms


class CallEndedReport(_Model):
    ended_at: int  # epoch ms
    # When the caller joined/answered; lets the API recover if `started` was lost.
    started_at: int | None = None
    disconnection_reason: DisconnectionReason
    transcript: list[TranscriptItem] = Field(default_factory=list)
    collected_variables: dict[str, str] = Field(default_factory=dict)
    latency: LatencySamples = Field(default_factory=LatencySamples)
    usage: UsageReport = Field(default_factory=UsageReport)
    error_message: str | None = None

    def to_payload(self) -> dict[str, Any]:
        """JSON body for the API: optional fields that are unset are omitted, not null."""
        return self.model_dump(mode="json", exclude_none=True)
