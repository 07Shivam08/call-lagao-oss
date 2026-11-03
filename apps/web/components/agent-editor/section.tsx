"use client";

import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../ui";

export function Section({
  title,
  description,
  icon,
  children,
  defaultOpen = true,
  badge,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-5 py-3.5 text-left hover:bg-panel-2/60"
        aria-expanded={open}
      >
        <ChevronRight className={cn("size-4 shrink-0 text-subtle transition-transform", open && "rotate-90")} />
        {icon && <span className="text-muted">{icon}</span>}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          {description && !open && <span className="block truncate text-xs text-subtle">{description}</span>}
        </span>
        {badge}
      </button>
      {open && <div className="space-y-4 px-5 pb-5 pt-1">{children}</div>}
    </section>
  );
}

export function PaneTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 flex h-11 items-center justify-between border-b border-line bg-panel/95 px-5 backdrop-blur">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-subtle">{children}</h2>
      {right}
    </div>
  );
}
