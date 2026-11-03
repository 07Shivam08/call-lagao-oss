"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ChangeEvent, type FormEvent, useState } from "react";
import { api } from "@/lib/api";
import { Alert, Button, Card, Field, Input } from "./ui";

function safeNext(next: string | null): string {
  // Same-origin paths only: reject "//host" and anything with a backslash ("/\host" — browsers treat "\" like "/").
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/agents";
}

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: "", password: "", name: "", org_name: "" });

  const mutation = useMutation({
    mutationFn: () =>
      mode === "login"
        ? api.auth.login({ email: form.email.trim(), password: form.password })
        : api.auth.signup({
            email: form.email.trim(),
            password: form.password,
            name: form.name.trim() || undefined,
            org_name: form.org_name.trim() || undefined,
          }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["session"] });
      router.replace(safeNext(params.get("next")));
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold">{mode === "login" ? "Welcome back" : "Create your account"}</h1>
      <p className="mt-1 text-sm text-muted">
        {mode === "login" ? "Sign in to manage your voice agents." : "Start building voice agents in minutes."}
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        {mode === "signup" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Your name">
              <Input value={form.name} onChange={set("name")} autoComplete="name" placeholder="Asha Rao" />
            </Field>
            <Field label="Organization">
              <Input value={form.org_name} onChange={set("org_name")} autoComplete="organization" placeholder="Acme Inc." />
            </Field>
          </div>
        )}
        <Field label="Email">
          <Input type="email" required value={form.email} onChange={set("email")} autoComplete="email" placeholder="you@company.com" />
        </Field>
        <Field label="Password" hint={mode === "signup" ? "At least 8 characters." : undefined}>
          <Input
            type="password"
            required
            minLength={mode === "signup" ? 8 : undefined}
            value={form.password}
            onChange={set("password")}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </Field>
        {mutation.error && <Alert>{mutation.error.message}</Alert>}
        <Button type="submit" variant="primary" className="w-full" loading={mutation.isPending}>
          {mode === "login" ? "Sign in" : "Create account"}
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-muted">
        {mode === "login" ? (
          <>
            New to Call Lagao?{" "}
            <Link href="/signup" className="text-violet-300 hover:underline">
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-violet-300 hover:underline">
              Sign in
            </Link>
          </>
        )}
      </p>
    </Card>
  );
}
