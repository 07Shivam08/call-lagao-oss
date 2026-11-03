from call_lagao_voice.models import (
    AgentConfig,
    CallContext,
    CallEndedReport,
    CustomTool,
    EndCallTool,
)

# defaultAgentConfig() from packages/shared/src/agent.ts, i.e. AgentConfig.parse({}).
TS_DEFAULT_AGENT_CONFIG = {
    "engine": {
        "type": "prompt",
        "prompt": "You are a friendly, concise voice assistant.",
        "begin_message": "Hi! How can I help you today?",
        "start_speaker": "agent",
        "model": "gpt-4.1-mini",
        "temperature": 0.4,
        "tools": [
            {
                "type": "end_call",
                "name": "end_call",
                "description": "End the call when the conversation is complete or the user asks to hang up.",
            }
        ],
    },
    "voice": {"provider": "elevenlabs", "voice_id": "21m00Tcm4TlvDq8ikWAM", "speed": 1},
    "stt": {"provider": "deepgram", "model": "nova-3", "language": "en"},
    "turn": {"interruption_sensitivity": 0.8, "responsiveness": 0.8},
    "call": {"max_call_duration_ms": 1_800_000, "end_call_after_silence_ms": 60_000},
    "analysis": {"model": "gpt-4.1-mini", "fields": []},
    "webhook_url": None,
}


def test_defaults_from_empty_dict_match_ts():
    cfg = AgentConfig.model_validate({})
    dumped = cfg.model_dump(mode="json")
    # voice.model is optional in TS (absent); pydantic dumps it as None.
    assert dumped["voice"].pop("model") is None
    assert dumped == TS_DEFAULT_AGENT_CONFIG


def test_partial_sections_get_defaults():
    cfg = AgentConfig.model_validate({"engine": {"prompt": "x"}, "turn": {"responsiveness": 0.1}})
    assert cfg.engine.prompt == "x"
    assert cfg.engine.model == "gpt-4.1-mini"
    assert cfg.turn.responsiveness == 0.1
    assert cfg.turn.interruption_sensitivity == 0.8
    assert isinstance(cfg.engine.tools[0], EndCallTool)


def test_begin_message_null_and_empty_preserved():
    assert AgentConfig.model_validate({"engine": {"begin_message": None}}).engine.begin_message is None
    assert AgentConfig.model_validate({"engine": {"begin_message": ""}}).engine.begin_message == ""


def test_tools_discriminated_union_and_custom_defaults():
    cfg = AgentConfig.model_validate(
        {
            "engine": {
                "tools": [
                    {"type": "end_call"},
                    {
                        "type": "custom",
                        "name": "lookup_order",
                        "description": "Look up an order",
                        "url": "https://example.com/orders",
                    },
                ]
            }
        }
    )
    end, custom = cfg.engine.tools
    assert isinstance(end, EndCallTool) and end.name == "end_call"
    assert isinstance(custom, CustomTool)
    assert custom.method == "POST"
    assert custom.headers == {}
    assert custom.timeout_ms == 10_000
    assert custom.speak_during_execution is False
    assert custom.parameters.model_dump(exclude_none=True) == {"type": "object", "properties": {}}


def test_call_context_parsing():
    ctx = CallContext.model_validate(
        {
            "call": {
                "call_id": "call_123",
                "call_type": "web_call",
                "direction": None,
                "agent_id": "agent_1",
                "agent_version": 2,
                "from_number": None,
                "to_number": None,
                "metadata": {"k": 1},
            },
            "agent_name": "Support",
            "agent_config": {"voice": {"provider": "cartesia", "voice_id": "abc"}},
            "dynamic_variables": {"name": "Asha"},
        }
    )
    assert ctx.call.call_id == "call_123"
    assert ctx.agent_config.voice.provider == "cartesia"
    assert ctx.agent_config.stt.model == "nova-3"
    assert ctx.dynamic_variables == {"name": "Asha"}


def test_ended_report_payload_omits_unset_optionals():
    report = CallEndedReport.model_validate(
        {
            "ended_at": 1700000000000,
            "disconnection_reason": "user_hangup",
            "transcript": [
                {"role": "agent", "content": "Hi", "start_ms": 0},
                {"role": "user", "content": "Hello"},
                {"role": "tool_call_invocation", "tool_call_id": "t1", "name": "x", "arguments": "{}"},
                {"role": "tool_call_result", "tool_call_id": "t1", "content": "ok", "successful": True},
            ],
        }
    )
    payload = report.to_payload()
    assert "error_message" not in payload
    assert payload["transcript"][0] == {"role": "agent", "content": "Hi", "start_ms": 0}
    assert payload["transcript"][1] == {"role": "user", "content": "Hello"}
    assert payload["latency"] == {"e2e": [], "stt": [], "llm": [], "tts": []}
    assert payload["usage"] == {
        "llm_prompt_tokens": 0,
        "llm_completion_tokens": 0,
        "llm_requests": 0,
        "tts_characters": 0,
        "stt_audio_seconds": 0,
    }
    assert payload["collected_variables"] == {}
