"""Collects transcript, per-turn latency and usage during a call.

The ``on_*`` handlers take livekit-agents 1.8 event objects (duck-typed, so this
module does not import livekit and is easy to test). The ``add_*`` methods take
plain values. ``build_report`` produces the ``CallEndedReport``.

Event sources (livekit-agents 1.8.9):
- ``conversation_item_added``  -> ``ConversationItemAddedEvent.item`` (``ChatMessage``):
  user/assistant text, ``interrupted`` flag, and ``item.metrics`` (``MetricsReport``)
  with ``started_speaking_at`` / ``stopped_speaking_at`` (epoch s),
  ``transcription_delay`` (user), ``e2e_latency`` / ``llm_node_ttft`` /
  ``tts_node_ttfb`` (assistant), all in seconds.
- ``metrics_collected``        -> ``MetricsCollectedEvent.metrics``: ``LLMMetrics``
  (tokens), ``TTSMetrics`` (characters), ``STTMetrics`` (audio seconds).
- ``function_tools_executed``  -> ``FunctionToolsExecutedEvent`` (calls + outputs);
  used as a fallback for tool items not recorded directly by ``tools.py``.
"""

from __future__ import annotations

import itertools
import json
import time
from dataclasses import dataclass, field
from typing import Any

from .models import (
    AgentTranscriptItem,
    CallEndedReport,
    DisconnectionReason,
    LatencySamples,
    ToolCallInvocationItem,
    ToolCallResultItem,
    UsageReport,
    UserTranscriptItem,
)

MAX_TOOL_RESULT_CHARS = 4000


def _ms(seconds: float | None) -> float | None:
    if seconds is None or seconds < 0:
        return None
    return round(seconds * 1000.0, 1)


@dataclass(order=True)
class _Entry:
    sort_key: float
    seq: int
    item: Any = field(compare=False)


class CallRecorder:
    def __init__(self, *, llm_model: str | None = None, tts_provider: str | None = None) -> None:
        # Epoch seconds that "ms since call start" is measured from. Set by
        # mark_started(); until then the recorder creation time is used.
        self.start_time: float = time.time()
        self._entries: list[_Entry] = []
        self._seq = itertools.count()
        self._tool_ids: set[str] = set()
        self._tool_result_ids: set[str] = set()
        self._msg_ids: set[str] = set()
        self.latency = LatencySamples()
        self.usage = UsageReport(llm_model=llm_model, tts_provider=tts_provider)
        self.collected_variables: dict[str, str] = {}

    # ------------------------------------------------------------------ clock

    def mark_started(self, at: float | None = None) -> None:
        self.start_time = at if at is not None else time.time()

    def rel_ms(self, ts: float | None = None) -> float:
        """Epoch seconds -> ms since call start (never negative)."""
        t = time.time() if ts is None else ts
        return max(0.0, round((t - self.start_time) * 1000.0, 1))

    def _push(self, sort_ms: float, item: Any) -> None:
        self._entries.append(_Entry(sort_ms, next(self._seq), item))

    # ------------------------------------------------------------------ plain adders

    def add_user(self, content: str, start: float | None = None, end: float | None = None) -> None:
        content = content.strip()
        if not content:
            return
        start_ms = self.rel_ms(start) if start is not None else None
        end_ms = self.rel_ms(end) if end is not None else None
        item = UserTranscriptItem(content=content, start_ms=start_ms, end_ms=end_ms)
        self._push(start_ms if start_ms is not None else self.rel_ms(), item)

    def add_agent(
        self,
        content: str,
        start: float | None = None,
        end: float | None = None,
        interrupted: bool = False,
    ) -> None:
        content = content.strip()
        if not content:
            return
        start_ms = self.rel_ms(start) if start is not None else None
        end_ms = self.rel_ms(end) if end is not None else None
        item = AgentTranscriptItem(
            content=content,
            start_ms=start_ms,
            end_ms=end_ms,
            interrupted=True if interrupted else None,
        )
        self._push(start_ms if start_ms is not None else self.rel_ms(), item)

    def add_tool_invocation(
        self, tool_call_id: str, name: str, arguments: str | dict[str, Any], at: float | None = None
    ) -> None:
        if tool_call_id in self._tool_ids:
            return
        self._tool_ids.add(tool_call_id)
        args = arguments if isinstance(arguments, str) else json.dumps(arguments, default=str)
        t = self.rel_ms(at)
        self._push(
            t,
            ToolCallInvocationItem(tool_call_id=tool_call_id, name=name, arguments=args, time_ms=t),
        )

    def add_tool_result(
        self, tool_call_id: str, content: str, successful: bool, at: float | None = None
    ) -> None:
        if tool_call_id in self._tool_result_ids:
            return
        self._tool_result_ids.add(tool_call_id)
        t = self.rel_ms(at)
        self._push(
            t,
            ToolCallResultItem(
                tool_call_id=tool_call_id,
                content=content[:MAX_TOOL_RESULT_CHARS],
                successful=successful,
                time_ms=t,
            ),
        )

    def add_turn_latency(
        self,
        *,
        e2e: float | None = None,
        llm: float | None = None,
        tts: float | None = None,
    ) -> None:
        """Assistant-turn samples, in seconds."""
        for name, value in (("e2e", e2e), ("llm", llm), ("tts", tts)):
            ms = _ms(value)
            if ms is not None:
                getattr(self.latency, name).append(ms)

    def add_stt_latency(self, seconds: float | None) -> None:
        ms = _ms(seconds)
        if ms is not None:
            self.latency.stt.append(ms)

    def add_llm_usage(
        self, prompt_tokens: int, completion_tokens: int, model: str | None = None
    ) -> None:
        self.usage.llm_prompt_tokens += int(prompt_tokens or 0)
        self.usage.llm_completion_tokens += int(completion_tokens or 0)
        self.usage.llm_requests += 1
        if model and not self.usage.llm_model:
            self.usage.llm_model = model

    def add_tts_usage(self, characters: int) -> None:
        self.usage.tts_characters += int(characters or 0)

    def add_stt_usage(self, audio_seconds: float) -> None:
        self.usage.stt_audio_seconds = round(
            self.usage.stt_audio_seconds + float(audio_seconds or 0), 3
        )

    # ------------------------------------------------------------------ livekit event handlers

    def on_conversation_item_added(self, ev: Any) -> None:
        item = getattr(ev, "item", None)
        if getattr(item, "type", None) != "message":
            return
        msg_id = getattr(item, "id", None)
        if msg_id is not None:
            if msg_id in self._msg_ids:
                return
            self._msg_ids.add(msg_id)
        role = getattr(item, "role", None)
        text = getattr(item, "text_content", None) or ""
        metrics: dict[str, Any] = dict(getattr(item, "metrics", None) or {})
        start = metrics.get("started_speaking_at") or getattr(item, "created_at", None)
        end = metrics.get("stopped_speaking_at")
        if role == "user":
            self.add_user(text, start, end)
            self.add_stt_latency(metrics.get("transcription_delay"))
        elif role == "assistant":
            self.add_agent(text, start, end, interrupted=bool(getattr(item, "interrupted", False)))
            self.add_turn_latency(
                e2e=metrics.get("e2e_latency"),
                llm=metrics.get("llm_node_ttft"),
                tts=metrics.get("tts_node_ttfb"),
            )

    def on_metrics_collected(self, ev: Any) -> None:
        m = getattr(ev, "metrics", ev)
        kind = getattr(m, "type", None)
        meta = getattr(m, "metadata", None)
        model_name = getattr(meta, "model_name", None) if meta is not None else None
        if kind == "llm_metrics":
            self.add_llm_usage(m.prompt_tokens, m.completion_tokens, model_name)
        elif kind == "tts_metrics":
            self.add_tts_usage(m.characters_count)
        elif kind == "stt_metrics":
            self.add_stt_usage(m.audio_duration)

    def on_function_tools_executed(self, ev: Any) -> None:
        for call in getattr(ev, "function_calls", []) or []:
            self.add_tool_invocation(call.call_id, call.name, call.arguments, call.created_at)
        for out in getattr(ev, "function_call_outputs", []) or []:
            if out is None:
                continue
            self.add_tool_result(out.call_id, out.output, not out.is_error, out.created_at)

    # ------------------------------------------------------------------ report

    def transcript(self) -> list[Any]:
        return [e.item for e in sorted(self._entries)]

    def build_report(
        self,
        reason: DisconnectionReason,
        *,
        ended_at_ms: int | None = None,
        error_message: str | None = None,
    ) -> CallEndedReport:
        return CallEndedReport(
            ended_at=ended_at_ms if ended_at_ms is not None else int(time.time() * 1000),
            disconnection_reason=reason,
            transcript=self.transcript(),
            collected_variables=dict(self.collected_variables),
            latency=self.latency.model_copy(deep=True),
            usage=self.usage.model_copy(deep=True),
            error_message=error_message,
        )
