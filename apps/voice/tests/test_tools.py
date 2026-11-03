import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from livekit.agents import RunContext
from livekit.agents.llm import FunctionCall, RawFunctionTool
from livekit.agents.llm.utils import prepare_function_arguments

from call_lagao_voice.models import AgentConfig, CustomTool
from call_lagao_voice.netguard import BlockedUrlError, ensure_public_url
from call_lagao_voice.recorder import CallRecorder
from call_lagao_voice.tools import END_CALL_TOOL_OUTPUT, ToolDeps, build_tools, execute_custom_tool

ORDER_TOOL = {
    "type": "custom",
    "name": "lookup_order",
    "description": "Look up an order by id",
    "url": "https://api.example.com/orders",
    "method": "POST",
    "headers": {"authorization": "Bearer t"},
    "parameters": {
        "type": "object",
        "properties": {
            "order_id": {"type": "string", "description": "Order id"},
            "verbose": {"type": "boolean"},
        },
        "required": ["order_id"],
    },
    "timeout_ms": 5000,
    "speak_during_execution": True,
    "execution_message": "Let me check that.",
}


def _config(*tools):
    return AgentConfig.model_validate({"engine": {"tools": list(tools)}})


def _run_ctx(call_id: str, name: str, arguments: str):
    """A real RunContext (so livekit's argument binding accepts it) over mocks."""
    fc = FunctionCall(call_id=call_id, name=name, arguments=arguments)
    session = MagicMock()
    speech = MagicMock()
    speech.num_steps = 1
    return RunContext(session=session, speech_handle=speech, function_call=fc), session, speech


def _deps(handler, recorder=None, on_end=None):
    return ToolDeps(
        recorder=recorder or CallRecorder(),
        on_end_call=on_end or (lambda ctx: None),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def test_build_tools_raw_schema():
    deps = _deps(lambda r: httpx.Response(200))
    tools = build_tools(_config({"type": "end_call"}, ORDER_TOOL), deps)
    assert [t.info.name for t in tools] == ["end_call", "lookup_order"]
    assert all(isinstance(t, RawFunctionTool) for t in tools)
    schema = tools[1].info.raw_schema
    assert schema["name"] == "lookup_order"
    assert schema["description"] == "Look up an order by id"
    assert schema["parameters"] == ORDER_TOOL["parameters"]
    assert tools[0].info.raw_schema["parameters"] == {"type": "object", "properties": {}}


def test_duplicate_tool_names_ignored():
    deps = _deps(lambda r: httpx.Response(200))
    tools = build_tools(_config({"type": "end_call"}, {"type": "end_call"}), deps)
    assert len(tools) == 1


async def test_custom_tool_post_via_livekit_binding():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, text='{"status": "shipped"}')

    rec = CallRecorder()
    tool = build_tools(_config(ORDER_TOOL), _deps(handler, rec))[0]
    args_json = '{"order_id": "A1", "verbose": true}'
    ctx, session, _ = _run_ctx("call_1", "lookup_order", args_json)

    # Exactly how livekit-agents invokes a raw tool.
    args, kwargs = prepare_function_arguments(fnc=tool, json_arguments=args_json, call_ctx=ctx)
    result = await tool(*args, **kwargs)

    assert result == '{"status": "shipped"}'
    assert seen == {
        "method": "POST",
        "url": "https://api.example.com/orders",
        "auth": "Bearer t",
        "body": {"order_id": "A1", "verbose": True},
    }
    session.say.assert_called_once_with("Let me check that.", allow_interruptions=False)
    inv, res = (i.model_dump(exclude_none=True) for i in rec.transcript())
    assert inv["role"] == "tool_call_invocation" and inv["tool_call_id"] == "call_1"
    assert json.loads(inv["arguments"]) == {"order_id": "A1", "verbose": True}
    assert res["role"] == "tool_call_result" and res["successful"] is True
    assert res["content"] == '{"status": "shipped"}'
    assert "time_ms" in inv and "time_ms" in res


async def test_custom_tool_get_uses_query_params():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = dict(request.url.params)
        seen["body"] = request.content
        return httpx.Response(200, text="ok")

    cfg = CustomTool.model_validate({**ORDER_TOOL, "method": "GET"})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    text, ok = await execute_custom_tool(cfg, {"order_id": "A1", "verbose": False, "n": 3}, client)
    assert ok and text == "ok"
    assert seen["params"] == {"order_id": "A1", "verbose": "false", "n": "3"}
    assert seen["body"] == b""


async def test_custom_tool_errors_and_truncation():
    cfg = CustomTool.model_validate(ORDER_TOOL)

    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500, text="boom")))
    text, ok = await execute_custom_tool(cfg, {}, client)
    assert not ok and text.startswith("HTTP 500")

    def timeout(request):
        raise httpx.ReadTimeout("slow", request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(timeout))
    text, ok = await execute_custom_tool(cfg, {}, client)
    assert not ok and "timed out" in text

    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, text="x" * 10_000)))
    text, ok = await execute_custom_tool(cfg, {}, client)
    assert ok and len(text) < 4100 and text.endswith("(truncated)")


async def test_end_call_tool_hooks_controller():
    calls = []
    rec = CallRecorder()
    tool = build_tools(_config({"type": "end_call"}), _deps(lambda r: httpx.Response(200), rec, calls.append))[0]
    ctx, _, _ = _run_ctx("call_9", "end_call", "{}")
    args, kwargs = prepare_function_arguments(fnc=tool, json_arguments="{}", call_ctx=ctx)
    out = await tool(*args, **kwargs)
    assert out == END_CALL_TOOL_OUTPUT
    assert calls == [ctx]
    roles = [i.role for i in rec.transcript()]
    assert roles == ["tool_call_invocation", "tool_call_result"]


def test_function_tools_executed_fallback_dedupes():
    from livekit.agents.llm import FunctionCallOutput

    rec = CallRecorder()
    rec.add_tool_invocation("c1", "lookup_order", "{}")
    ev = SimpleNamespace(
        function_calls=[FunctionCall(call_id="c1", name="lookup_order", arguments="{}")],
        function_call_outputs=[FunctionCallOutput(call_id="c1", output="done", is_error=False)],
    )
    rec.on_function_tools_executed(ev)
    assert [i.role for i in rec.transcript()] == ["tool_call_invocation", "tool_call_result"]


@pytest.fixture(autouse=True)
def _quiet_livekit_logs(caplog):
    caplog.set_level("CRITICAL", logger="livekit.agents")


# ----------------------------------------------------------------- SSRF guard


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/x",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://100.64.0.1/",
        "file:///etc/passwd",
    ],
)
async def test_guard_blocks_private_destinations(url):
    with pytest.raises(BlockedUrlError):
        await ensure_public_url(url)


async def test_guard_allows_public_ip():
    await ensure_public_url("https://8.8.8.8/lookup")


async def test_blocked_tool_returns_failure_without_request():
    calls = []
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: calls.append(r) or httpx.Response(200)))
    cfg = CustomTool.model_validate({**ORDER_TOOL, "url": "http://169.254.169.254/latest/meta-data/"})
    text, ok = await execute_custom_tool(cfg, {}, client, ensure_public_url)
    assert not ok and "blocked" in text and calls == []
