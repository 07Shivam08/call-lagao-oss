"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, LogOut, Menu, Phone, PhoneCall, Settings, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { type Session, api, isApiError } from "@/lib/api";
import { Logo } from "./logo";
import { Button, ErrorState, Spinner, cn } from "./ui";

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession must be used inside <AppShell>");
  return s;
}

const NAV = [
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/calls", label: "Call History", icon: PhoneCall },
  { href: "/phone-numbers", label: "Phone Numbers", icon: Phone },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);

  const session = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false, staleTime: 60_000 });
  const unauthorized = isApiError(session.error) && session.error.status === 401;

  useEffect(() => {
    if (unauthorized) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [unauthorized, router, pathname]);

  useEffect(() => setMobileOpen(false), [pathname]);

  const logout = useMutation({
    mutationFn: api.auth.logout,
    onSettled: () => {
      qc.clear();
      router.replace("/login");
    },
  });

  if (session.isPending || unauthorized) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (session.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <ErrorState error={session.error} onRetry={() => session.refetch()} />
      </div>
    );
  }

  const { user, org } = session.data;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center justify-between px-4">
        <Link href="/agents">
          <Logo />
        </Link>
        <button className="rounded-md p-1 text-muted hover:text-fg lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close menu">
          <X className="size-4" />
        </button>
      </div>
      <div className="mx-3 mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2">
        <div className="text-[11px] uppercase tracking-wider text-subtle">Organization</div>
        <div className="truncate text-sm font-medium">{org.name}</div>
      </div>
      <nav className="flex-1 space-y-0.5 px-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                active ? "bg-brand-soft text-fg" : "text-muted hover:bg-elevated hover:text-fg",
              )}
            >
              <Icon className={cn("size-4", active && "text-violet-300")} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated text-xs font-semibold uppercase text-muted">
            {(user.name || user.email).slice(0, 2)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user.name || user.email.split("@")[0]}</div>
            <div className="truncate text-xs text-subtle">{user.email}</div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => logout.mutate()} loading={logout.isPending} aria-label="Log out" title="Log out">
            {!logout.isPending && <LogOut className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <SessionContext.Provider value={session.data}>
      <div className="min-h-dvh lg:pl-60">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-panel lg:block">{sidebar}</aside>
        {mobileOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
            <aside className="absolute inset-y-0 left-0 w-64 border-r border-line bg-panel">{sidebar}</aside>
          </div>
        )}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur lg:hidden">
          <button className="rounded-md p-1.5 text-muted hover:bg-elevated hover:text-fg" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <Logo />
        </header>
        <main>{children}</main>
      </div>
    </SessionContext.Provider>
  );
}

/** Standard padded page container. */
export function Page({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div className={cn("mx-auto w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8", narrow ? "max-w-4xl" : "max-w-7xl")}>{children}</div>
  );
}
