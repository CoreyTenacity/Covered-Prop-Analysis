"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type AccountPayload = {
  user: {
    id: string;
    email: string | null;
    displayName: string;
  } | null;
};

export function AccountStatus() {
  const router = useRouter();
  const [data, setData] = useState<AccountPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => response.json() as Promise<AccountPayload>)
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch(() => {
        if (!cancelled) setData({ user: null });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function logOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    setBusy(false);
    setData({ user: null });
    router.push("/today");
    router.refresh();
  }

  if (loading) {
    return (
      <div className="account-status">
        <small>Account</small>
        <strong>Checking session…</strong>
        <span>Public browsing still works without a login.</span>
      </div>
    );
  }

  if (!data?.user) {
    return (
      <div className="account-status">
        <small>Account</small>
        <strong>Browse freely, sign in to save later</strong>
        <span>Public research stays open. Saving and tracking will live behind your account.</span>
        <div className="account-status__actions">
          <Link href="/login" className="account-status__button">Log in</Link>
          <Link href="/signup" className="account-status__button account-status__button--secondary">Create account</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="account-status">
      <small>Signed in</small>
      <strong>{data.user.displayName}</strong>
      <span>{data.user.email ?? "Covered account active"}</span>
      <div className="account-status__actions">
        <Link href="/my-picks" className="account-status__button">My Picks</Link>
        <button className="account-status__button account-status__button--secondary" type="button" onClick={logOut} disabled={busy}>
          {busy ? "Logging out…" : "Log out"}
        </button>
      </div>
    </div>
  );
}
