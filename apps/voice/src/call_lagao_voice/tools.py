"""Builds LLM tools from ``config.engine.tools``.

Both tool kinds are livekit-agents *raw* function tools
(``function_tool(handler, raw_schema={"name", "description", "parameters"})``),
so names, descriptions and JSON-schema parameters come straight from the agent
config. livekit calls a raw tool as ``handler(raw_arguments=<dict>, context=<RunContext>)``
(see ``livekit.agents.llm.utils._prepare_function_arguments``).
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx
from livekit.agents import RunContext, function_tool
from livekit.agents.llm import RawFunctionTool

from .models import AgentConfig, CustomTool, EndCallTool
from .netguard import BlockedUrlError
from .recorder import MAX_TOOL_RESULT_CHARS, CallRecorder

logger = logging.getLogger("call-lagao.tools")

DEFAULT_EXECUTION_MESSAGE = "One moment, please."
END_CALL_TOOL_OUTPUT = (
    "The call is ending now. Say one short, polite goodbye sentence to the user "
    "and nothing else. Do not call any more tools."
)


@dataclass
class ToolDeps:
    recorder: CallRecorder
    # Called by end_call with the RunContext of the tool call; the controller
    # waits for that speech (the goodbye) to finish, then ends with agent_hangup.
    on_end_call: Callable[[RunContext], None]
    http_client: httpx.AsyncClient
    # SSRF guard for custom tool URLs (netguard.ensure_public_url); None disables it.
    url_guard: Callable[[str], Awaitable[None]] | None = None


def _call_id(context: Any) -> str:
    fc = getattr(context, "function_call", None)
    return getattr(fc, "call_id", None) or f"call_{int(time.time() * 1000)}"


def _call_arguments(context: Any, raw_arguments: dict[str, Any]) -> str:
    fc = getattr(context, "function_call", None)
    args = getattr(fc, "arguments", None)
    return args if isinstance(args, str) and args else json.dumps(raw_arguments, default=str)


def _schema_parameters(params: Any) -> dict[str, Any]:
    schema = params.model_dump(exclude_none=True) if hasattr(params, "model_dump") else dict(params)
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    return schema


# --------------------------------------------------------------------------- end_call


def build_end_call_tool(cfg: EndCallTool, deps: ToolDeps) -> RawFunctionTool:
    async def end_call(raw_arguments: dict[str, Any], context: RunContext) -> str:
        call_id = _call_id(context)
        deps.recorder.add_tool_invocation(call_id, cfg.name, _call_arguments(context, raw_arguments))
        deps.on_end_call(context)
        deps.recorder.add_tool_result(call_id, "call ending", True)
        # The LLM's reply to this output (the goodbye) reuses the same speech
        # handle, so the controller ends the call once that handle is done.
        return END_CALL_TOOL_OUTPUT

    return function_tool(
        end_call,
        raw_schema={
            "name": cfg.name,
            "description": cfg.description,
            "parameters": {"type": "object", "properties": {}},
        },
    )


# --------------------------------------------------------------------------- custom HTTP tools


def _query_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (dict, list)):
        return json.dumps(v, default=str)
    return "" if v is None else str(v)


async def execute_custom_tool(
    cfg: CustomTool,
    args: dict[str, Any],
    client: httpx.AsyncClient,
    url_guard: Callable[[str], Awaitable[None]] | None = None,
) -> tuple[str, bool]:
    """Perform the HTTP request for a custom tool. Returns ``(text, successful)``.

    GET sends the arguments as query params; every other method sends them as a
    JSON body. Never raises: failures are returned as text for the LLM.
    With a ``url_guard``, non-public destinations are refused and redirects are
    not followed (a redirect could point at a private address).
    """
    timeout = cfg.timeout_ms / 1000.0
    headers = dict(cfg.headers)
    if url_guard is not None:
        try:
            await url_guard(cfg.url)
        except BlockedUrlError as e:
            logger.warning("custom tool %s blocked: %s", cfg.name, e)
            return f"Tool request blocked: {e}.", False
    follow = url_guard is None
    try:
        if cfg.method == "GET":
            resp = await client.request(
                cfg.method,
                cfg.url,
                params={k: _query_value(v) for k, v in args.items()},
                headers=headers,
                timeout=timeout,
                follow_redirects=follow,
            )
        else:
            headers.setdefault("content-type", "application/json")
            resp = await client.request(
                cfg.method,
                cfg.url,
                content=json.dumps(args, default=str),
                headers=headers,
                timeout=timeout,
                follow_redirects=follow,
            )
    except httpx.TimeoutException:
        return f"Tool request timed out after {cfg.timeout_ms} ms.", False
    except httpx.HTTPError as e:
        return f"Tool request failed: {e!r}"[:MAX_TOOL_RESULT_CHARS], False

    text = resp.text or ""
    if len(text) > MAX_TOOL_RESULT_CHARS:
        text = text[:MAX_TOOL_RESULT_CHARS] + "...(truncated)"
    if 200 <= resp.status_code < 300:
        return text or "(empty response)", True
    return f"HTTP {resp.status_code}: {text}"[: MAX_TOOL_RESULT_CHARS + 20], False


def build_custom_tool(cfg: CustomTool, deps: ToolDeps) -> RawFunctionTool:
    async def custom_tool(raw_arguments: dict[str, Any], context: RunContext) -> str:
        call_id = _call_id(context)
        deps.recorder.add_tool_invocation(call_id, cfg.name, _call_arguments(context, raw_arguments))
        if cfg.speak_during_execution:
            try:
                context.session.say(
                    cfg.execution_message or DEFAULT_EXECUTION_MESSAGE,
                    allow_interruptions=False,
                )
            except RuntimeError:  # session closing
                pass
        started = time.perf_counter()
        text, ok = await execute_custom_tool(
            cfg, raw_arguments or {}, deps.http_client, deps.url_guard
        )
        logger.info(
            "custom tool %s -> ok=%s in %.0f ms", cfg.name, ok, (time.perf_counter() - started) * 1000
        )
        deps.recorder.add_tool_result(call_id, text, ok)
        return text

    return function_tool(
        custom_tool,
        raw_schema={
            "name": cfg.name,
            "description": cfg.description,
            "parameters": _schema_parameters(cfg.parameters),
        },
    )


def build_tools(config: AgentConfig, deps: ToolDeps) -> list[RawFunctionTool]:
    tools: list[RawFunctionTool] = []
    seen: set[str] = set()
    for t in config.engine.tools:
        if t.name in seen:
            logger.warning("duplicate tool name %r ignored", t.name)
            continue
        seen.add(t.name)
        if isinstance(t, EndCallTool):
            tools.append(build_end_call_tool(t, deps))
        elif isinstance(t, CustomTool):
            tools.append(build_custom_tool(t, deps))
    return tools
