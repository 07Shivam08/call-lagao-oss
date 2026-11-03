import pytest

from call_lagao_voice.mapping import (
    base_language,
    llm_kwargs,
    map_turn,
    parse_call_id,
    plan_greeting,
    reason_for_participant_left,
    reason_for_session_close,
    render_template,
    stt_kwargs,
    tts_spec,
)
from call_lagao_voice.models import AgentConfig, EngineConfig, SttConfig, TurnConfig, VoiceConfig


# ----------------------------------------------------------------- render_template


def test_render_template_substitutes_known_and_keeps_unknown():
    out = render_template("Hi {{name}}, order {{ order_id }} for {{missing}}.", {"name": "Asha", "order_id": "42"})
    assert out == "Hi Asha, order 42 for {{missing}}."


def test_render_template_no_vars_and_repeated():
    assert render_template("plain", {}) == "plain"
    assert render_template("{{a}}{{a}}", {"a": "x"}) == "xx"
    # invalid variable names are not touched (same regex as the TS renderTemplate)
    assert render_template("{{a-b}}", {"a-b": "x"}) == "{{a-b}}"


# ----------------------------------------------------------------- turn mapping (service contract §4, apps/api/README.md)


@pytest.mark.parametrize(
    "r, min_d, max_d",
    [(1.0, 0.2, 2.0), (0.0, 1.2, 5.0), (0.8, 0.4, 2.6), (0.5, 0.7, 3.5)],
)
def test_responsiveness_to_endpointing(r, min_d, max_d):
    t = map_turn(TurnConfig(responsiveness=r))
    assert t.min_endpointing_delay == pytest.approx(min_d)
    assert t.max_endpointing_delay == pytest.approx(max_d)


@pytest.mark.parametrize(
    "s, allow, min_dur, words",
    [
        (0.0, False, 1.5, 2),
        (0.39, True, 0.2 + 0.61 * 1.3, 2),
        (0.4, True, 0.2 + 0.6 * 1.3, 1),
        (0.69, True, 0.2 + 0.31 * 1.3, 1),
        (0.7, True, 0.2 + 0.3 * 1.3, 0),
        (0.8, True, 0.46, 0),
        (1.0, True, 0.2, 0),
    ],
)
def test_interruption_sensitivity(s, allow, min_dur, words):
    t = map_turn(TurnConfig(interruption_sensitivity=s))
    assert t.allow_interruptions is allow
    assert t.min_interruption_duration == pytest.approx(min_dur)
    assert t.min_interruption_words == words


def test_turn_handling_dict_shape():
    t = map_turn(TurnConfig(responsiveness=0.8, interruption_sensitivity=0.0))
    th = t.turn_handling("vad")
    assert th["turn_detection"] == "vad"
    assert th["endpointing"] == {"mode": "fixed", "min_delay": pytest.approx(0.4), "max_delay": pytest.approx(2.6)}
    assert th["interruption"]["enabled"] is False
    assert th["interruption"]["mode"] == "vad"
    assert th["interruption"]["min_words"] == 2
    assert "turn_detection" not in t.turn_handling()


def test_turn_handling_accepted_by_livekit_session():
    """The dict must be a valid livekit-agents 1.8 TurnHandlingOptions."""
    from livekit.agents.voice.turn import _resolve_endpointing, _resolve_interruption

    th = map_turn(TurnConfig()).turn_handling()
    ep = _resolve_endpointing(th["endpointing"])
    it = _resolve_interruption(th["interruption"])
    assert ep["min_delay"] == pytest.approx(0.4)
    assert it["min_duration"] == pytest.approx(0.46)
    assert it["enabled"] is True


# ----------------------------------------------------------------- greeting


def test_greeting_rules():
    vars_ = {"name": "Asha"}
    assert plan_greeting(EngineConfig(begin_message="Hi {{name}}"), vars_).text == "Hi Asha"
    assert plan_greeting(EngineConfig(begin_message="Hi {{name}}"), vars_).action == "say"
    assert plan_greeting(EngineConfig(begin_message=None), vars_).action == "generate"
    assert plan_greeting(EngineConfig(begin_message=""), vars_).action == "wait"
    assert plan_greeting(EngineConfig(start_speaker="user", begin_message="Hi"), vars_).action == "wait"


# ----------------------------------------------------------------- plugins


def test_stt_kwargs():
    assert stt_kwargs(SttConfig()) == {"model": "nova-3", "language": "en"}
    assert stt_kwargs(SttConfig(language="multi")) == {"model": "nova-3", "language": "multi"}
    assert stt_kwargs(SttConfig(model="nova-2", language="hi")) == {"model": "nova-2", "language": "hi"}


def test_llm_kwargs():
    assert llm_kwargs(EngineConfig(model="gpt-4o", temperature=0.9)) == {"model": "gpt-4o", "temperature": 0.9}


def test_tts_spec_elevenlabs():
    spec = tts_spec(VoiceConfig())
    assert spec.provider == "elevenlabs"
    assert spec.kwargs == {"voice_id": "21m00Tcm4TlvDq8ikWAM", "model": "eleven_flash_v2_5"}
    assert spec.elevenlabs_speed is None
    fast = tts_spec(VoiceConfig(speed=2.0, model="eleven_turbo_v2_5"))
    assert fast.kwargs["model"] == "eleven_turbo_v2_5"
    assert fast.elevenlabs_speed == 1.2  # clamped to ElevenLabs' range


def test_tts_spec_cartesia_and_openai():
    c = tts_spec(VoiceConfig(provider="cartesia", voice_id="v1", speed=1.2), "hi-IN")
    assert c.kwargs == {"voice": "v1", "model": "sonic-3", "language": "hi", "speed": 1.2}
    assert tts_spec(VoiceConfig(provider="cartesia", voice_id="v1"), "multi").kwargs["language"] is None
    o = tts_spec(VoiceConfig(provider="openai", voice_id="alloy"))
    assert o.kwargs == {"voice": "alloy", "model": "gpt-4o-mini-tts", "speed": 1.0}


def test_plugin_kwargs_construct_real_plugins(monkeypatch):
    """Kwargs must be accepted by the installed plugin constructors (no network)."""
    monkeypatch.setenv("DEEPGRAM_API_KEY", "x")
    monkeypatch.setenv("OPENAI_API_KEY", "x")
    monkeypatch.setenv("ELEVEN_API_KEY", "x")
    monkeypatch.setenv("CARTESIA_API_KEY", "x")
    from call_lagao_voice.agent import build_llm, build_stt, build_tts

    cfg = AgentConfig.model_validate({"stt": {"language": "multi"}, "voice": {"speed": 1.1}})
    assert build_stt(cfg).model == "nova-3"
    assert build_llm(cfg).model == "gpt-4.1-mini"
    assert build_tts(cfg).model == "eleven_flash_v2_5"
    for provider in ("cartesia", "openai"):
        cfg = AgentConfig.model_validate({"voice": {"provider": provider, "voice_id": "alloy"}})
        assert build_tts(cfg) is not None


def test_base_language():
    assert base_language("en-US") == "en"
    assert base_language("multi") is None
    assert base_language("") is None


# ----------------------------------------------------------------- lifecycle reasons


def test_reason_for_session_close():
    assert reason_for_session_close("error", "llm_error") == "error_llm"
    assert reason_for_session_close("error", "stt_error") == "error_stt"
    assert reason_for_session_close("error", "tts_error") == "error_tts"
    assert reason_for_session_close("error", None) == "error_unknown"
    assert reason_for_session_close("participant_disconnected", None) == "user_hangup"
    assert reason_for_session_close("job_shutdown", None) == "error_worker"


def test_reason_for_participant_left():
    assert reason_for_participant_left("CLIENT_INITIATED", answered=True, is_sip=False) == "user_hangup"
    assert reason_for_participant_left("ROOM_DELETED", answered=True, is_sip=False) == "manual_stopped"
    assert reason_for_participant_left("USER_REJECTED", answered=False, is_sip=True) == "dial_busy"
    assert reason_for_participant_left("USER_UNAVAILABLE", answered=False, is_sip=True) == "dial_no_answer"
    assert reason_for_participant_left("SIP_TRUNK_FAILURE", answered=False, is_sip=True) == "dial_failed"
    assert reason_for_participant_left("CLIENT_INITIATED", answered=True, is_sip=True) == "user_hangup"


def test_parse_call_id():
    assert parse_call_id('{"call_id": "call_abc"}') == "call_abc"
    assert parse_call_id("", fallback="room_1") == "room_1"
    assert parse_call_id("not json", fallback="room_1") == "room_1"
    with pytest.raises(ValueError):
        parse_call_id(None)
