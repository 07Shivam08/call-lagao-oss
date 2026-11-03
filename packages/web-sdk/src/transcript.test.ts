import { describe, expect, it } from "vitest";
import { TranscriptAccumulator } from "./transcript.js";
import { TypedEmitter } from "./emitter.js";

describe("TranscriptAccumulator", () => {
  it("accumulates agent delta chunks within a segment", () => {
    const t = new TranscriptAccumulator();
    t.begin("seg_a", "agent");
    t.append("seg_a", "Hello");
    t.append("seg_a", " there");
    expect(t.items()).toEqual([{ id: "seg_a", role: "agent", content: "Hello there", final: false }]);
    t.markFinal("seg_a");
    expect(t.items()[0]!.final).toBe(true);
  });

  it("replaces user interim results that share a segment id, keeping first-seen order", () => {
    const t = new TranscriptAccumulator();
    t.begin("u1", "user");
    t.append("u1", "I want");
    t.begin("a1", "agent");
    t.append("a1", "Sure");
    t.begin("u1", "user", true);
    t.append("u1", "I want to book a table");
    const items = t.items();
    expect(items.map((i) => i.id)).toEqual(["u1", "a1"]);
    expect(items[0]).toEqual({ id: "u1", role: "user", content: "I want to book a table", final: true });
  });

  it("hides empty segments and clears", () => {
    const t = new TranscriptAccumulator();
    t.begin("x", "agent");
    expect(t.items()).toEqual([]);
    t.set("y", "user", "hi", true);
    expect(t.items()).toHaveLength(1);
    t.clear();
    expect(t.items()).toEqual([]);
  });
});

describe("TypedEmitter", () => {
  class E extends TypedEmitter<{ ping: number }> {
    fire(n: number) {
      this.emit("ping", n);
    }
  }
  it("supports on/once/off", () => {
    const e = new E();
    const seen: number[] = [];
    const l = (n: number) => seen.push(n);
    e.on("ping", l);
    e.once("ping", (n) => seen.push(n * 10));
    e.fire(1);
    e.fire(2);
    e.off("ping", l);
    e.fire(3);
    expect(seen).toEqual([1, 10, 2]);
  });
});
