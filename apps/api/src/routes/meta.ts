import { LLM_MODELS, TTS_PROVIDERS } from "@call-lagao/shared";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";

/** A small curated starter list; any provider voice id can still be typed in the editor. */
const VOICES = [
  { provider: "elevenlabs", voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel (EN, female)" },
  { provider: "elevenlabs", voice_id: "pNInz6obpgDQGcFmaJgB", name: "Adam (EN, male)" },
  { provider: "elevenlabs", voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah (EN, female)" },
  { provider: "cartesia", voice_id: "f786b574-daa5-4673-aa0c-cbe3e8534c02", name: "Katie (EN, female)" },
  { provider: "cartesia", voice_id: "228fca29-3a0a-435c-8728-5cb483251068", name: "Kiefer (EN, male)" },
  { provider: "openai", voice_id: "alloy", name: "Alloy" },
  { provider: "openai", voice_id: "verse", name: "Verse" },
];

const STT_LANGUAGES = ["en", "en-US", "en-GB", "en-IN", "hi", "multi", "es", "fr", "de", "pt", "it", "nl", "ja", "ko", "zh"];

export function metaRoutes(app: FastifyInstance, d: Deps) {
  app.get("/health", async () => ({ ok: true, db: d.db.kind, livekit_configured: d.voice.configured, sip_configured: d.voice.sipConfigured }));

  app.get("/v1/meta/options", async () => ({
    llm_models: [...LLM_MODELS],
    tts_providers: [...TTS_PROVIDERS],
    voices: VOICES,
    stt_languages: STT_LANGUAGES,
  }));
}
