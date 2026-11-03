export type TranscriptRole = "agent" | "user";

export type LiveTranscriptItem = {
  /** LiveKit segment id (`lk.segment_id`), or the stream id when absent. */
  id: string;
  role: TranscriptRole;
  content: string;
  /** True once the segment will no longer change. */
  final: boolean;
};

/** Text-stream attribute names used by LiveKit Agents. */
export const ATTR_SEGMENT_ID = "lk.segment_id";
export const ATTR_TRANSCRIPTION_FINAL = "lk.transcription_final";

/**
 * Accumulates live transcription segments.
 *
 * LiveKit Agents publishes two kinds of streams on `lk.transcription`:
 *  - user (STT): one short stream per interim/final result carrying the full text so far;
 *  - agent (TTS-aligned): one stream per segment whose chunks are text deltas.
 *
 * Both are handled by treating every stream as "replace the segment text with
 * this stream's accumulated text", keyed by segment id, in first-seen order.
 */
export class TranscriptAccumulator {
  private segments = new Map<string, LiveTranscriptItem>();

  /** Begin (or restart) a stream for a segment. Text from a previous stream of the same segment is replaced. */
  begin(id: string, role: TranscriptRole, final = false): void {
    const prev = this.segments.get(id);
    if (prev) {
      prev.role = role;
      prev.content = "";
      prev.final = final;
    } else {
      this.segments.set(id, { id, role, content: "", final });
    }
  }

  /** Append a delta chunk to the segment. */
  append(id: string, delta: string): void {
    const seg = this.segments.get(id);
    if (seg) seg.content += delta;
  }

  /** Replace the full text of a segment (creating it if needed). */
  set(id: string, role: TranscriptRole, content: string, final: boolean): void {
    const seg = this.segments.get(id);
    if (seg) {
      seg.role = role;
      seg.content = content;
      seg.final = final;
    } else {
      this.segments.set(id, { id, role, content, final });
    }
  }

  markFinal(id: string, final = true): void {
    const seg = this.segments.get(id);
    if (seg) seg.final = final;
  }

  clear(): void {
    this.segments.clear();
  }

  /** Snapshot of non-empty segments in first-seen order. */
  items(): LiveTranscriptItem[] {
    const out: LiveTranscriptItem[] = [];
    for (const s of this.segments.values()) {
      if (s.content.trim().length) out.push({ ...s });
    }
    return out;
  }
}
