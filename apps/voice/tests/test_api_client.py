import json

import httpx
import pytest

from call_lagao_voice.api_client import SECRET_HEADER, InternalApiClient, InternalApiError
from call_lagao_voice.models import CallEndedReport

CONTEXT = {
    "call": {
        "call_id": "call_1",
        "call_type": "phone_call",
        "direction": "outbound",
        "agent_id": "agent_1",
        "agent_version": 1,
        "from_number": "+15550001",
        "to_number": "+15550002",
        "metadata": {},
    },
    "agent_name": "Sales",
    "agent_config": {},
    "dynamic_variables": {"name": "Ravi"},
}


def _client(handler, **kw) -> InternalApiClient:
    return InternalApiClient(
        "http://api.test/", "s3cret", transport=httpx.MockTransport(handler), backoff_base=0, **kw
    )


async def test_get_context_sends_secret_header():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(200, json=CONTEXT)

    async with _client(handler) as api:
        ctx = await api.get_context("call_1")
    assert ctx.call.call_type == "phone_call"
    assert ctx.agent_config.engine.model == "gpt-4.1-mini"
    assert seen[0].method == "GET"
    assert str(seen[0].url) == "http://api.test/internal/calls/call_1/context"
    assert seen[0].headers[SECRET_HEADER] == "s3cret"


async def test_started_sent_once_with_body():
    bodies = []

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.headers[SECRET_HEADER] == "s3cret"
        bodies.append((req.url.path, json.loads(req.content)))
        return httpx.Response(200, json={"ok": True})

    async with _client(handler) as api:
        assert await api.report_started("call_1", 1234) is True
        assert await api.report_started("call_1", 5678) is False
    assert bodies == [("/internal/calls/call_1/started", {"started_at": 1234})]


async def test_ended_sent_exactly_once():
    hits = []

    def handler(req: httpx.Request) -> httpx.Response:
        hits.append(json.loads(req.content))
        return httpx.Response(200, json={"ok": True})

    report = CallEndedReport(ended_at=1, disconnection_reason="user_hangup")
    async with _client(handler) as api:
        assert await api.report_ended("call_1", report) is True
        assert await api.report_ended("call_1", report) is False
        assert api.ended_sent("call_1")
    assert len(hits) == 1
    assert hits[0]["disconnection_reason"] == "user_hangup"
    assert "error_message" not in hits[0]


async def test_retries_on_5xx_and_network_errors():
    attempts = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise httpx.ConnectError("down", request=req)
        if attempts["n"] == 2:
            return httpx.Response(503)
        return httpx.Response(200, json={"ok": True})

    async with _client(handler) as api:
        await api.report_ended("call_1", CallEndedReport(ended_at=1, disconnection_reason="inactivity"))
    assert attempts["n"] == 3


async def test_gives_up_after_three_attempts():
    attempts = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(500)

    async with _client(handler) as api:
        with pytest.raises(InternalApiError):
            await api.get_context("call_1")
    assert attempts["n"] == 3


async def test_no_retry_on_4xx():
    attempts = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(401, json={"error": {"code": "unauthorized", "message": "bad secret"}})

    async with _client(handler) as api:
        with pytest.raises(InternalApiError) as ei:
            await api.get_context("call_1")
    assert ei.value.status_code == 401
    assert attempts["n"] == 1
