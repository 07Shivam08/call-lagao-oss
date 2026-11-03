import { AudioLines } from "lucide-react";

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/20">
        <AudioLines className="size-4" />
      </div>
      {!compact && <span className="text-[15px] font-semibold tracking-tight">Call Lagao</span>}
    </div>
  );
}
