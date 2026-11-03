import type { CallStatus } from "@call-lagao/shared";
import { Badge } from "./ui";

const TONES: Record<CallStatus, "neutral" | "green" | "yellow" | "red" | "blue"> = {
  registered: "blue",
  ongoing: "green",
  ended: "neutral",
  not_connected: "yellow",
  error: "red",
};

const LABELS: Record<CallStatus, string> = {
  registered: "Registered",
  ongoing: "Ongoing",
  ended: "Ended",
  not_connected: "Not connected",
  error: "Error",
};

export function CallStatusBadge({ status }: { status: CallStatus }) {
  return (
    <Badge tone={TONES[status] ?? "neutral"}>
      {status === "ongoing" && <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />}
      {LABELS[status] ?? status}
    </Badge>
  );
}

export const isLiveStatus = (s: CallStatus) => s === "ongoing" || s === "registered";
