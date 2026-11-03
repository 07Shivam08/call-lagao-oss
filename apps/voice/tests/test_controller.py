"""Lifecycle tests for CallController with a mocked JobContext / API (no LiveKit server)."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

from call_lagao_voice.agent import CallController
from call_lagao_voice.config import Settings


class FakeApi:
    def __init__(self) -> None:
        self.ended = []
        self.started = []

    async def report_started(self, call_id, started_at=None):
        self.started.append(started_at)
        return True

    async def report_ended(self, call_id, report):
        self.ended.append((call_id, report))
        return True

    async def get_context(self, call_id):
        raise RuntimeError("api down")

    async def aclose(self):
        pass


def _controller() -> tuple[CallController, FakeApi, MagicMock]:
    ctx = MagicMock()
    ctx.delete_room = AsyncMock()
    settings = Settings.from_env()
    c = CallController(ctx, settings, "call_1")
    api = FakeApi()
    c.api = api  # type: ignore[assignment]
    return c, api, ctx


async def test_first_reason_wins_and_ended_posted_once():
    c, api, ctx = _controller()
    c.request_end("user_hangup")
    c.request_end("inactivity")
    c.request_end("max_duration_reached")
    await asyncio.wait_for(c._finished.wait(), 5)
    assert len(api.ended) == 1
    call_id, report = api.ended[0]
    assert call_id == "call_1" and report.disconnection_reason == "user_hangup"
    ctx.delete_room.assert_awaited_once()
    ctx.shutdown.assert_called_once_with(reason="user_hangup")


async def test_manual_stop_does_not_delete_room():
    c, api, ctx = _controller()
    c.request_end("manual_stopped")
    await asyncio.wait_for(c._finished.wait(), 5)
    assert api.ended[0][1].disconnection_reason == "manual_stopped"
    ctx.delete_room.assert_not_awaited()


async def test_context_failure_reports_error_worker():
    c, api, ctx = _controller()
    await asyncio.wait_for(c.run(), 5)
    report = api.ended[0][1]
    assert report.disconnection_reason == "error_worker"
    assert "failed to fetch call context" in (report.error_message or "")


async def test_job_shutdown_safety_net():
    c, api, ctx = _controller()
    c._room_gone = True
    await c._on_job_shutdown("room disconnected")
    assert api.ended[0][1].disconnection_reason == "manual_stopped"
