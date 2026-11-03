"""LiveKit Agents (1.8.x) entrypoint for Call Lagao calls.

One job = one call. The room name is the call id, the job metadata is
``{"call_id": "..."}`` (service contract §3, apps/api/README.md). Lifecycle:

1. fetch ``CallContext`` from the API, build STT/LLM/TTS/VAD + tools from it
2. connect, start the ``AgentSession``, wait for ``user`` / ``phone_user``
   (a SIP callee counts once ``sip.callStatus == "active"``)
3. report ``started``, arm the max-duration timer, greet per service contract §4
4. end on the first of: end_call tool, silence (user away), max duration,
   caller hangup, room deleted, session error
5. post ``ended`` exactly once, delete the room, shut the job down
"""

from __future__ import annotations

import asyncio
import logging
import os
import warnings
from typing import Any

import httpx
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    JobProcess,
    RunContext,
    WorkerOptions,
)
from livekit.agents.voice.room_io import RoomOptions
from livekit.plugins import cartesia, deepgram, elevenlabs, openai, silero

with warnings.catch_warnings():
    # Deprecated in 1.8 in favour of inference.TurnDetector, but still the
    # multilingual text EOU model. Importing registers the plugin so that
    # `download-files` fetches its weights.
    warnings.simplefilter("ignore", DeprecationWarning)
    from livekit.plugins import turn_detector as _turn_detector  # noqa: F401
    from livekit.plugins.turn_detector.multilingual import MultilingualModel

from .api_client import InternalApiClient, now_ms
from .config import Settings
from .mapping import (
    USER_IDENTITIES,
    build_instructions,
    llm_kwargs,
    map_turn,
    parse_call_id,
    plan_greeting,
    reason_for_participant_left,
    reason_for_session_close,
    stt_kwargs,
    tts_spec,
)
from .models import AgentConfig, CallContext, DisconnectionReason
from .netguard import ensure_public_url, private_urls_allowed
from .recorder import CallRecorder
from .tools import ToolDeps, build_tools

logger = logging.getLogger("call-lagao.agent")

# How long we wait for the caller to show up / answer before giving up.
PARTICIPANT_JOIN_TIMEOUT_S = float(os.environ.get("CALL_JOIN_TIMEOUT_S") or "120")
# Upper bounds for the goodbye speech and for closing the session.
GOODBYE_TIMEOUT_S = 12.0
END_CALL_FALLBACK_S = 20.0
SESSION_CLOSE_TIMEOUT_S = 5.0
# Grace period after the caller leaves, so a room deletion (manual stop) that
# races the participant-left event is classified as manual_stopped.
HANGUP_GRACE_S = 0.4

INACTIVITY_GOODBYE_INSTRUCTIONS = (
    "The user has been silent for a long time. Politely say you will end the call now "
    "and say goodbye in one short sentence. Do not ask any question."
)
MAX_DURATION_GOODBYE_INSTRUCTIONS = (
    "The maximum call duration has been reached. Politely tell the user you have to end "
    "the call now and say goodbye in one short sentence."
)


# --------------------------------------------------------------------------- plugin builders


def build_stt(config: AgentConfig) -> deepgram.STT:
    return deepgram.STT(**stt_kwargs(config.stt))


def build_llm(config: AgentConfig) -> openai.LLM:
    return openai.LLM(**llm_kwargs(config.engine))


def build_tts(config: AgentConfig) -> Any:
    spec = tts_spec(config.voice, config.stt.language)
    if spec.provider == "elevenlabs":
        kwargs = dict(spec.kwargs)
        if spec.elevenlabs_speed is not None:
            kwargs["voice_settings"] = elevenlabs.VoiceSettings(
                stability=0.5, similarity_boost=0.75, speed=spec.elevenlabs_speed
            )
        return elevenlabs.TTS(**kwargs)
    if spec.provider == "cartesia":
        return cartesia.TTS(**spec.kwargs)
    return openai.TTS(**spec.kwargs)


def build_turn_detector() -> Any:
    """Context-aware end-of-turn model, or ``"vad"`` when it is unavailable.

    ``TURN_DETECTOR`` env: ``multilingual`` (default; text EOU model from
    ``livekit-plugins-turn-detector``, needs ``download-files``), ``inference``
    (livekit-agents 1.8 audio ``inference.TurnDetector``, cloud with local
    fallback), ``vad`` or ``stt``.
    """
    mode = os.environ.get("TURN_DETECTOR", "multilingual").strip().lower()
    if mode in ("vad", "stt"):
        return mode
    try:
        if mode == "inference":
            from livekit.agents import inference

            return inference.TurnDetector()
        return MultilingualModel()
    except Exception:
        logger.warning("turn detector %r unavailable, falling back to VAD", mode, exc_info=True)
        return "vad"


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


# --------------------------------------------------------------------------- call controller


class CallController:
    def __init__(self, ctx: JobContext, settings: Settings, call_id: str) -> None:
        self.ctx = ctx
        self.settings = settings
        self.call_id = call_id
        self.api = InternalApiClient(settings.api_base_url, settings.internal_api_secret)
        self._allow_private_urls = private_urls_allowed()
        self.http = httpx.AsyncClient(follow_redirects=self._allow_private_urls)
        self.recorder = CallRecorder()
        self.session: AgentSession | None = None
        self.context: CallContext | None = None

        self._answered = False
        self._caller: rtc.RemoteParticipant | None = None
        self._caller_ready = asyncio.Event()
        self._end_reason: DisconnectionReason | None = None
        self._end_error: str | None = None
        self._ended_at_ms: int | None = None
        self._finished = asyncio.Event()
        self._finish_task: asyncio.Task[None] | None = None
        self._max_duration_handle: asyncio.TimerHandle | None = None
        self._started_task: asyncio.Task[None] | None = None
        self._room_gone = False
        self._tasks: set[asyncio.Task[Any]] = set()

    # ------------------------------------------------------------------ helpers

    def _spawn(self, coro: Any, name: str) -> asyncio.Task[Any]:
        task = asyncio.create_task(coro, name=name)
        self._tasks.add(task)

        def _done(t: asyncio.Task[Any]) -> None:
            self._tasks.discard(t)
            if not t.cancelled() and t.exception() is not None:
                logger.error("task %s failed", name, exc_info=t.exception())

        task.add_done_callback(_done)
        return task

    @property
    def ending(self) -> bool:
        return self._end_reason is not None

    # ------------------------------------------------------------------ main flow

    async def run(self) -> None:
        self.ctx.add_shutdown_callback(self._on_job_shutdown)
        try:
            self.context = await self.api.get_context(self.call_id)
        except Exception as e:
            logger.exception("could not fetch call context for %s", self.call_id)
            self.request_end("error_worker", error_message=f"failed to fetch call context: {e}")
            await self._finished.wait()
            return

        try:
            await self._start()
        except Exception as e:
            logger.exception("call %s failed during start", self.call_id)
            self.request_end("error_worker", error_message=repr(e))
        await self._finished.wait()

    async def _start(self) -> None:
        assert self.context is not None
        config = self.context.agent_config
        variables = dict(self.context.dynamic_variables)
        turn = map_turn(config.turn)

        self.recorder.usage.llm_model = config.engine.model
        self.recorder.usage.tts_provider = config.voice.provider

        tools = build_tools(
            config,
            ToolDeps(
                recorder=self.recorder,
                on_end_call=self._on_end_call_tool,
                http_client=self.http,
                url_guard=None if self._allow_private_urls else ensure_public_url,
            ),
        )
        vad = self.ctx.proc.userdata.get("vad") or silero.VAD.load()

        session: AgentSession = AgentSession(
            stt=build_stt(config),
            llm=build_llm(config),
            tts=build_tts(config),
            vad=vad,
            turn_handling=turn.turn_handling(build_turn_detector()),  # type: ignore[arg-type]
            user_away_timeout=config.call.end_call_after_silence_ms / 1000.0,
        )
        self.session = session
        self._wire_session(session)

        await self.ctx.connect()
        self._wire_room(self.ctx.room)

        agent = Agent(instructions=build_instructions(config, variables), tools=tools)
        await session.start(
            agent=agent,
            room=self.ctx.room,
            # We decide when the call ends (and why), so the session must not
            # close itself when the caller disconnects.
            room_options=RoomOptions(close_on_disconnect=False),
        )

        # Pick up a caller who joined before we subscribed to room events.
        for p in self.ctx.room.remote_participants.values():
            self._on_participant_seen(p)

        try:
            await asyncio.wait_for(self._caller_ready.wait(), timeout=PARTICIPANT_JOIN_TIMEOUT_S)
        except asyncio.TimeoutError:
            if not self.ending:
                self.request_end("dial_no_answer", error_message="caller never joined/answered")
            return
        if self.ending:
            return

        # ---- call is live
        started_at = now_ms()
        self.recorder.mark_started(started_at / 1000.0)
        self._started_task = self._spawn(self._report_started(started_at), "report_started")
        loop = asyncio.get_running_loop()
        self._max_duration_handle = loop.call_later(
            config.call.max_call_duration_ms / 1000.0,
            lambda: self.request_end(
                "max_duration_reached", goodbye_instructions=MAX_DURATION_GOODBYE_INSTRUCTIONS
            ),
        )

        plan = plan_greeting(config.engine, variables)
        if plan.action == "say" and plan.text:
            session.say(plan.text)
        elif plan.action == "generate":
            session.generate_reply()
        # "wait": the user speaks first

    async def _report_started(self, started_at: int) -> None:
        try:
            await self.api.report_started(self.call_id, started_at)
        except Exception:
            logger.exception("failed to report call started")

    # ------------------------------------------------------------------ wiring

    def _wire_session(self, session: AgentSession) -> None:
        rec = self.recorder
        session.on("conversation_item_added", rec.on_conversation_item_added)
        session.on("metrics_collected", rec.on_metrics_collected)
        session.on("function_tools_executed", rec.on_function_tools_executed)

        @session.on("user_state_changed")
        def _on_user_state(ev: Any) -> None:
            if ev.new_state == "away" and self._answered and not self.ending:
                logger.info("user silent for too long, ending call")
                self.request_end("inactivity", goodbye_instructions=INACTIVITY_GOODBYE_INSTRUCTIONS)

        @session.on("error")
        def _on_error(ev: Any) -> None:
            err = getattr(ev, "error", None)
            logger.warning(
                "session error (recoverable=%s): %r",
                getattr(err, "recoverable", None),
                getattr(err, "error", err),
            )

        @session.on("close")
        def _on_close(ev: Any) -> None:
            if self.ending:
                return  # we initiated the close
            err = getattr(ev, "error", None)
            reason_value = getattr(getattr(ev, "reason", None), "value", str(getattr(ev, "reason", "")))
            reason = reason_for_session_close(reason_value, getattr(err, "type", None))
            message = repr(getattr(err, "error", err)) if err is not None else None
            self.request_end(reason, error_message=message)

    def _wire_room(self, room: rtc.Room) -> None:
        room.on("participant_connected", self._on_participant_seen)
        room.on("participant_attributes_changed", lambda _changed, p: self._on_participant_seen(p))

        @room.on("participant_disconnected")
        def _on_left(p: rtc.RemoteParticipant) -> None:
            if p.identity not in USER_IDENTITIES or self.ending:
                return
            self._spawn(self._handle_caller_left(p), "caller_left")

        @room.on("disconnected")
        def _on_disconnected(reason: Any) -> None:
            self._room_gone = True
            if self.ending:
                return
            name = _disconnect_reason_name(reason)
            if name == "ROOM_DELETED":
                self.request_end("manual_stopped")
            else:
                self.request_end("error_worker", error_message=f"agent disconnected from room: {name}")

    def _on_participant_seen(self, p: rtc.RemoteParticipant) -> None:
        if p.identity not in USER_IDENTITIES or self._answered:
            return
        if p.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP:
            # Outbound SIP participants exist while ringing; wait for pickup.
            status = p.attributes.get("sip.callStatus")
            if status is not None and status != "active":
                return
        self._caller = p
        self._answered = True
        self._caller_ready.set()

    async def _handle_caller_left(self, p: rtc.RemoteParticipant) -> None:
        name = _disconnect_reason_name(p.disconnect_reason)
        if name != "ROOM_DELETED":
            await asyncio.sleep(HANGUP_GRACE_S)  # let a racing room deletion win
        if self.ending:
            return
        reason = reason_for_participant_left(
            "ROOM_DELETED" if self._room_gone else name,
            answered=self._answered,
            is_sip=p.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP,
        )
        self.request_end(reason)

    def _on_end_call_tool(self, context: RunContext) -> None:
        """end_call: let the goodbye (the reply to the tool output) finish, then end."""
        if self.ending:
            return
        context.speech_handle.add_done_callback(lambda _h: self.request_end("agent_hangup"))
        # Safety net in case the speech handle never completes.
        asyncio.get_running_loop().call_later(
            END_CALL_FALLBACK_S, lambda: self.request_end("agent_hangup")
        )

    # ------------------------------------------------------------------ ending

    def request_end(
        self,
        reason: DisconnectionReason,
        *,
        error_message: str | None = None,
        goodbye_instructions: str | None = None,
    ) -> None:
        """First caller wins; everything after that is ignored."""
        if self.ending:
            return
        logger.info("ending call %s: %s %s", self.call_id, reason, error_message or "")
        self._end_reason = reason
        self._end_error = error_message
        if self._max_duration_handle is not None:
            self._max_duration_handle.cancel()
        self._caller_ready.set()  # unblock _start if it is still waiting for the caller
        self._finish_task = self._spawn(self._finish(goodbye_instructions), "finish_call")

    async def _finish(self, goodbye_instructions: str | None) -> None:
        assert self._end_reason is not None
        session = self.session
        try:
            if goodbye_instructions and session is not None and not self._room_gone:
                await self._say_goodbye(session, goodbye_instructions)
            if session is not None:
                try:
                    await asyncio.wait_for(session.aclose(), timeout=SESSION_CLOSE_TIMEOUT_S)
                except Exception:
                    logger.warning("session close failed", exc_info=True)
            # The call ends after the goodbye and once the session has flushed its
            # last transcript items.
            self._ended_at_ms = now_ms()
            await self._post_ended()
            if self._end_reason != "manual_stopped" and not self._room_gone:
                try:
                    await self.ctx.delete_room()  # NOT_FOUND is ignored by livekit
                except Exception:
                    logger.warning("delete_room failed", exc_info=True)
        finally:
            await self.http.aclose()
            self._finished.set()
            self.ctx.shutdown(reason=self._end_reason)

    async def _say_goodbye(self, session: AgentSession, instructions: str) -> None:
        try:
            # tool_choice none: the goodbye must not trigger tools (e.g. end_call again)
            handle = session.generate_reply(
                instructions=instructions, tool_choice="none", allow_interruptions=False
            )
            await asyncio.wait_for(handle.wait_for_playout(), timeout=GOODBYE_TIMEOUT_S)
        except Exception:
            logger.warning("goodbye speech failed", exc_info=True)

    async def _post_ended(self) -> None:
        assert self._end_reason is not None
        if self._started_task is not None:
            # never let `ended` overtake an in-flight `started`
            try:
                await asyncio.wait_for(asyncio.shield(self._started_task), timeout=10)
            except Exception:
                pass
        report = self.recorder.build_report(
            self._end_reason, ended_at_ms=self._ended_at_ms, error_message=self._end_error
        )
        try:
            await self.api.report_ended(self.call_id, report)
        except Exception:
            logger.exception("failed to report call ended")
        finally:
            await self.api.aclose()

    async def _on_job_shutdown(self, reason: str) -> None:
        """Safety net: the job is going away (e.g. room closed, worker draining)."""
        if not self.ending:
            self.request_end(
                "manual_stopped" if self._room_gone else "error_worker",
                error_message=None if self._room_gone else f"job shutdown: {reason}",
            )
        if self._finish_task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(self._finish_task), timeout=15)
            except Exception:
                pass


def _disconnect_reason_name(reason: Any) -> str | None:
    if reason is None:
        return None
    try:
        return rtc.DisconnectReason.Name(reason)
    except Exception:
        return str(reason)


# --------------------------------------------------------------------------- entrypoint


async def entrypoint(ctx: JobContext) -> None:
    settings = Settings.from_env()
    if not settings.internal_api_secret:
        logger.warning("INTERNAL_API_SECRET is empty; the API will reject internal calls")
    call_id = parse_call_id(ctx.job.metadata, fallback=ctx.room.name)
    ctx.log_context_fields = {"call_id": call_id}
    controller = CallController(ctx, settings, call_id)
    await controller.run()


def worker_options() -> WorkerOptions:
    settings = Settings.from_env()
    # Setting agent_name turns on explicit dispatch: the API creates a dispatch
    # per call (AgentDispatchClient.createDispatch) instead of auto-joining rooms.
    return WorkerOptions(
        entrypoint_fnc=entrypoint,
        prewarm_fnc=prewarm,
        agent_name=settings.livekit_agent_name,
    )


__all__ = ["entrypoint", "prewarm", "worker_options", "CallController"]

