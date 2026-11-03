from livekit.agents.llm import ChatMessage, FunctionCall, FunctionCallOutput
from livekit.agents.metrics import LLMMetrics, STTMetrics, TTSMetrics
from livekit.agents.metrics.base import Metadata
from livekit.agents.voice.events import (
    ConversationItemAddedEvent,
    FunctionToolsExecutedEvent,
    MetricsCollectedEvent,
)

from call_lagao_voice.models import CallEndedReport
from call_lagao_voice.recorder import CallRecorder

T0 = 1_700_000_000.0


def _llm(prompt: int, completion: int) -> LLMMetrics:
    return LLMMetrics(
        label="openai.LLM", request_id="r", timestamp=T0, duration=0.5, ttft=0.3, cancelled=False,
        completion_tokens=completion, prompt_tokens=prompt, prompt_cached_tokens=0,
        total_tokens=prompt + completion, tokens_per_second=10.0,
        metadata=Metadata(model_name="gpt-4.1-mini", model_provider="openai"),
    )


def _tts(chars: int) -> TTSMetrics:
    return TTSMetrics(
        label="elevenlabs.TTS", request_id="r", timestamp=T0, ttfb=0.2, duration=1.0,
        audio_duration=2.0, cancelled=False, characters_count=chars, streamed=True,
    )


def _stt(seconds: float) -> STTMetrics:
    return STTMetrics(
        label="deepgram.STT", request_id="r", timestamp=T0, duration=0.0,
        audio_duration=seconds, streamed=True,
    )


def _build_call() -> CallRecorder:
    rec = CallRecorder(llm_model=None, tts_provider="elevenlabs")
    rec.mark_started(T0)

    greeting = ChatMessage(
        role="assistant", content=["Hi! How can I help?"], created_at=T0 + 0.5,
        metrics={"started_speaking_at": T0 + 0.5, "stopped_speaking_at": T0 + 2.0, "tts_node_ttfb": 0.21},
    )
    user = ChatMessage(
        role="user", content=["Where is my order?"], created_at=T0 + 3.0,
        metrics={"started_speaking_at": T0 + 3.0, "stopped_speaking_at": T0 + 4.0, "transcription_delay": 0.12},
    )
    reply = ChatMessage(
        role="assistant", content=["Let me check, it is"], interrupted=True, created_at=T0 + 4.8,
        metrics={
            "started_speaking_at": T0 + 4.8, "stopped_speaking_at": T0 + 5.5,
            "e2e_latency": 0.8, "llm_node_ttft": 0.35, "tts_node_ttfb": 0.18,
        },
    )
    # Events can arrive out of order (agent message is added after playout ends).
    rec.on_conversation_item_added(ConversationItemAddedEvent(item=user))
    rec.on_conversation_item_added(ConversationItemAddedEvent(item=greeting))
    rec.on_conversation_item_added(ConversationItemAddedEvent(item=reply))
    rec.on_conversation_item_added(ConversationItemAddedEvent(item=reply))  # duplicate id ignored

    rec.on_function_tools_executed(
        FunctionToolsExecutedEvent(
            function_calls=[FunctionCall(call_id="t1", name="lookup_order", arguments='{"id":"1"}', created_at=T0 + 4.5)],
            function_call_outputs=[FunctionCallOutput(call_id="t1", output="shipped", is_error=False, created_at=T0 + 4.7)],
        )
    )
    for m in (_llm(100, 20), _llm(150, 30), _tts(40), _tts(25), _stt(1.5), _stt(2.25)):
        rec.on_metrics_collected(MetricsCollectedEvent(metrics=m))
    return rec


def test_report_is_valid_and_time_ordered():
    rec = _build_call()
    report = rec.build_report("agent_hangup", ended_at_ms=1_700_000_010_000)
    payload = report.to_payload()
    # Round-trips through the contract model
    CallEndedReport.model_validate(payload)

    t = payload["transcript"]
    assert [i["role"] for i in t] == ["agent", "user", "tool_call_invocation", "tool_call_result", "agent"]
    assert t[0] == {"role": "agent", "content": "Hi! How can I help?", "start_ms": 500.0, "end_ms": 2000.0}
    assert t[1] == {"role": "user", "content": "Where is my order?", "start_ms": 3000.0, "end_ms": 4000.0}
    assert t[2]["arguments"] == '{"id":"1"}' and t[2]["time_ms"] == 4500.0
    assert t[3]["successful"] is True and t[3]["content"] == "shipped"
    assert t[4]["interrupted"] is True
    assert "interrupted" not in t[0]

    assert payload["latency"] == {"e2e": [800.0], "stt": [120.0], "llm": [350.0], "tts": [210.0, 180.0]}
    assert payload["usage"] == {
        "llm_model": "gpt-4.1-mini",
        "llm_prompt_tokens": 250,
        "llm_completion_tokens": 50,
        "llm_requests": 2,
        "tts_provider": "elevenlabs",
        "tts_characters": 65,
        "stt_audio_seconds": 3.75,
    }
    assert payload["disconnection_reason"] == "agent_hangup"
    assert payload["ended_at"] == 1_700_000_010_000
    assert "error_message" not in payload


def test_error_message_and_empty_messages():
    rec = CallRecorder()
    rec.on_conversation_item_added(ConversationItemAddedEvent(item=ChatMessage(role="user", content=["  "])))
    rec.on_conversation_item_added(ConversationItemAddedEvent(item=ChatMessage(role="system", content=["x"])))
    report = rec.build_report("error_llm", error_message="rate limited")
    assert report.transcript == []
    assert report.to_payload()["error_message"] == "rate limited"


def test_times_before_start_clamp_to_zero():
    rec = CallRecorder()
    rec.mark_started(T0)
    rec.add_agent("early", start=T0 - 5)
    assert rec.transcript()[0].start_ms == 0.0


def test_report_carries_started_at_only_after_answer():
    rec = CallRecorder()
    assert "started_at" not in rec.build_report("user_hangup").to_payload()
    rec.mark_started(1_700_000_000.25)
    assert rec.build_report("user_hangup").to_payload()["started_at"] == 1_700_000_000_250
