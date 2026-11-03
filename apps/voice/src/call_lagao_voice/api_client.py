"""Async client for the API's internal endpoints (service contract §2, apps/api/README.md)."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from .models import CallContext, CallEndedReport

logger = logging.getLogger("call-lagao.api")

SECRET_HEADER = "x-internal-secret"


class InternalApiError(Exception):
    """Non-retryable failure (4xx) or retries exhausted."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


def now_ms() -> int:
    return int(time.time() * 1000)


class InternalApiClient:
    """Talks to ``/internal/calls/:id/*`` with the shared secret header.

    Network errors and 5xx responses are retried ``max_attempts`` times with
    exponential backoff. 4xx responses fail immediately.
    """

    def __init__(
        self,
        base_url: str,
        secret: str,
        *,
        max_attempts: int = 3,
        backoff_base: float = 0.5,
        timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={SECRET_HEADER: secret, "content-type": "application/json"},
            timeout=timeout,
            transport=transport,
        )
        self._max_attempts = max(1, max_attempts)
        self._backoff_base = backoff_base
        self._started_sent: set[str] = set()
        self._ended_sent: set[str] = set()
        self._ended_lock = asyncio.Lock()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "InternalApiClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()

    # ------------------------------------------------------------------ endpoints

    async def get_context(self, call_id: str) -> CallContext:
        data = await self._request("GET", f"/internal/calls/{call_id}/context")
        return CallContext.model_validate(data)

    async def report_started(self, call_id: str, started_at: int | None = None) -> bool:
        """POST ``started`` once per call. Returns False if it was already sent."""
        if call_id in self._started_sent:
            return False
        self._started_sent.add(call_id)
        await self._request(
            "POST",
            f"/internal/calls/{call_id}/started",
            json={"started_at": started_at if started_at is not None else now_ms()},
        )
        return True

    async def report_ended(self, call_id: str, report: CallEndedReport) -> bool:
        """POST ``ended`` exactly once per call (later calls are no-ops returning False).

        The call is marked as sent *before* the request so concurrent end paths
        (hangup + timer + shutdown callback) can never double-post; if every
        retry fails, the error is raised but the call stays marked.
        """
        async with self._ended_lock:
            if call_id in self._ended_sent:
                return False
            self._ended_sent.add(call_id)
        await self._request(
            "POST", f"/internal/calls/{call_id}/ended", json=report.to_payload()
        )
        return True

    def ended_sent(self, call_id: str) -> bool:
        return call_id in self._ended_sent

    # ------------------------------------------------------------------ transport

    async def _request(self, method: str, path: str, json: Any | None = None) -> Any:
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                resp = await self._client.request(method, path, json=json)
            except httpx.TransportError as e:  # connect/read errors, timeouts
                last_error = e
                logger.warning(
                    "internal api %s %s failed (attempt %d/%d): %r",
                    method, path, attempt, self._max_attempts, e,
                )
            else:
                if resp.status_code < 400:
                    return resp.json() if resp.content else None
                if resp.status_code < 500:
                    raise InternalApiError(
                        f"{method} {path} -> {resp.status_code}: {resp.text[:500]}",
                        resp.status_code,
                    )
                last_error = InternalApiError(
                    f"{method} {path} -> {resp.status_code}: {resp.text[:500]}",
                    resp.status_code,
                )
                logger.warning(
                    "internal api %s %s returned %d (attempt %d/%d)",
                    method, path, resp.status_code, attempt, self._max_attempts,
                )
            if attempt < self._max_attempts:
                await asyncio.sleep(self._backoff_base * (2 ** (attempt - 1)))
        raise InternalApiError(f"{method} {path} failed after {self._max_attempts} attempts: {last_error!r}")
