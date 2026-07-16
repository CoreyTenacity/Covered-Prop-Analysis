"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

type AuthMode = "login" | "signup";

export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/my-picks";
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setInfo("");

    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName: displayName.trim(),
          email: email.trim(),
          password,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Something went wrong.");
      }

      if (payload.requiresEmailConfirmation) {
        setInfo("Your account was created. If your Supabase project requires email confirmation, confirm your email first and then log in.");
        return;
      }

      router.push(next);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="eyebrow"><span /> Account foundation</div>
        <h1>{mode === "login" ? "Log in to Covered" : "Create your Covered account"}</h1>
        <p>
          Browsing stays public. Accounts are only here so we can unlock save, track, and sync features without touching the public research experience.
        </p>

        <form className="auth-form" onSubmit={onSubmit}>
          {mode === "signup" ? (
            <label>
              Display name
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Corey" autoComplete="name" />
            </label>
          ) : null}
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" type="email" required />
          </label>
          <label>
            Password
            <input value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} type="password" minLength={8} required />
          </label>

          {error ? <div className="auth-feedback auth-feedback--error">{error}</div> : null}
          {info ? <div className="auth-feedback auth-feedback--info">{info}</div> : null}

          <button className="auth-submit" type="submit" disabled={submitting}>
            {submitting ? "Working…" : mode === "login" ? "Log in" : "Create account"}
          </button>
        </form>

        <div className="auth-footer">
          {mode === "login" ? (
            <p>Need an account? <Link href={`/signup?next=${encodeURIComponent(next)}`}>Create one</Link></p>
          ) : (
            <p>Already have an account? <Link href={`/login?next=${encodeURIComponent(next)}`}>Log in</Link></p>
          )}
          <Link href="/today">Back to public browsing</Link>
        </div>
      </div>
    </div>
  );
}
