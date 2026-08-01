"use client";

import { useEffect, useState } from "react";

type Health = {
  ok: boolean;
  contactbox?: { configured: boolean; baseURL: string; model: string };
};

type Status = {
  ok: boolean;
  modelCount?: number;
  models?: string[];
  error?: string;
  baseURL?: string;
  model?: string;
};

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false }));
  }, []);

  async function checkContactBox() {
    setChecking(true);
    try {
      const res = await fetch("/api/contactbox/status");
      const data = (await res.json()) as Status;
      setStatus(data);
    } catch (error) {
      setStatus({
        ok: false,
        error: error instanceof Error ? error.message : "Request failed",
      });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 pb-16 pt-10 sm:px-10">
      <header className="animate-[fadeUp_700ms_ease_both]">
        <p className="text-sm font-medium tracking-[0.18em] text-[var(--accent)] uppercase">
          AW Media
        </p>
        <h1
          className="mt-3 max-w-3xl font-[family-name:var(--font-fraunces)] text-5xl leading-[1.05] tracking-tight text-[var(--ink)] sm:text-7xl"
          style={{ animation: "fadeUp 900ms ease both" }}
        >
          Script Visual Assembler
        </h1>
        <p
          className="mt-5 max-w-xl text-lg leading-relaxed text-[var(--ink-soft)] sm:text-xl"
          style={{ animation: "fadeUp 1100ms ease both" }}
        >
          Clean Railway deploy scaffold. ContactBoxTools is wired — build the
          assembler on top.
        </p>
        <div
          className="mt-8 flex flex-wrap gap-3"
          style={{ animation: "fadeUp 1300ms ease both" }}
        >
          <button
            type="button"
            onClick={checkContactBox}
            disabled={checking}
            className="bg-[var(--accent)] px-5 py-3 text-sm font-semibold tracking-wide text-[#f4f7f5] transition hover:bg-[var(--accent-deep)] disabled:opacity-60"
          >
            {checking ? "Checking…" : "Test ContactBox"}
          </button>
          <a
            href="/api/health"
            className="border border-[var(--line)] bg-white/50 px-5 py-3 text-sm font-semibold tracking-wide text-[var(--ink)] backdrop-blur transition hover:border-[var(--accent)]"
          >
            Health JSON
          </a>
        </div>
      </header>

      <section
        className="mt-14 grid gap-6 sm:grid-cols-2"
        style={{ animation: "fadeUp 1500ms ease both" }}
      >
        <div className="border-t border-[var(--line)] pt-5">
          <h2 className="font-[family-name:var(--font-fraunces)] text-2xl">
            Service
          </h2>
          <p className="mt-2 text-[var(--ink-soft)]">
            {health?.ok ? "Online" : health ? "Degraded" : "Checking…"}
          </p>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between gap-4 border-b border-[var(--line)] py-2">
              <dt>ContactBox key</dt>
              <dd className="font-medium">
                {health?.contactbox?.configured ? "Set" : "Missing"}
              </dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-[var(--line)] py-2">
              <dt>Base URL</dt>
              <dd className="truncate font-medium">
                {health?.contactbox?.baseURL ?? "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-[var(--line)] py-2">
              <dt>Default model</dt>
              <dd className="font-medium">
                {health?.contactbox?.model ?? "—"}
              </dd>
            </div>
          </dl>
        </div>

        <div className="border-t border-[var(--line)] pt-5">
          <h2 className="font-[family-name:var(--font-fraunces)] text-2xl">
            ContactBox probe
          </h2>
          <p className="mt-2 text-[var(--ink-soft)]">
            {status
              ? status.ok
                ? `${status.modelCount} models reachable`
                : status.error
              : "Not tested yet"}
          </p>
          {status?.ok && status.models ? (
            <ul className="mt-4 max-h-48 space-y-1 overflow-auto text-sm text-[var(--ink-soft)]">
              {status.models.map((id) => (
                <li key={id} className="border-b border-[var(--line)] py-1.5">
                  {id}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

    </div>
  );
}
