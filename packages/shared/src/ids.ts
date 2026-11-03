import { ulid } from "ulid";

export type IdPrefix = "org" | "usr" | "agent" | "call" | "key" | "sess" | "whd";

/** Type-prefixed, time-sortable id, e.g. `agent_01jb3k…`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

export function hasPrefix(id: string, prefix: IdPrefix): boolean {
  return id.startsWith(`${prefix}_`);
}
