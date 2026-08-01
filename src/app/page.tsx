"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type NavKey = "new" | "jobs" | "queue";

type NicheOption = {
  id: string;
  label: string;
  version: string;
  description: string;
};

const NICHES: NicheOption[] = [
  {
    id: "mystery",
    label: "Mystery",
    version: "v1",
    description:
      "Clean documentary evidence — maps, artifacts, archives, places, soft investigative tone.",
  },
];

type JobListItem = {
  id: string;
  title: string | null;
  niche: string;
  status: string;
  beatCount: number;
  sceneCount: number;
  googleCount: number;
  aiCount: number;
  error: string | null;
  progress: string | null;
  createdAt: string;
};

function nicheLabel(id?: string | null) {
  const found = NICHES.find((n) => n.id === id);
  return found ? `${found.label} ${found.version}` : id || "Mystery v1";
}

type Scene = {
  id: string;
  index: number;
  beatId: string;
  scriptText: string;
  visualSource: "google" | "ai" | "unassigned";
  query?: string;
  subject?: string;
  entityContext?: string;
  why?: string;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  r2Url?: string | null;
  email?: string | null;
};

type JobDetail = JobListItem & {
  script: string;
  scenes: Scene[] | null;
  model: string | null;
};

type Capacity = {
  usedToday: number;
  softLimit: number;
  remaining: number;
};

type DayGroup = {
  key: string;
  label: string;
  count: number;
  jobs: JobListItem[];
};

function statusLabel(status: string) {
  if (status === "queued" || status === "running") return "Processing";
  if (status === "completed") return "Done";
  if (status === "failed") return "Failed";
  return status;
}

function isProcessing(status: string) {
  return status === "queued" || status === "running";
}

function dayKey(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function groupJobsByDay(jobs: JobListItem[]): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const job of jobs) {
    const key = dayKey(job.createdAt);
    const existing = map.get(key);
    if (existing) {
      existing.jobs.push(job);
      existing.count += 1;
    } else {
      map.set(key, {
        key,
        label: dayLabel(job.createdAt),
        count: 1,
        jobs: [job],
      });
    }
  }
  return Array.from(map.values());
}

const NAV: { key: NavKey; label: string }[] = [
  { key: "new", label: "New Job" },
  { key: "jobs", label: "Jobs" },
  { key: "queue", label: "Render Queue" },
];

export default function Home() {
  const [nav, setNav] = useState<NavKey>("new");
  const [script, setScript] = useState("");
  const [title, setTitle] = useState("");
  const [niche, setNiche] = useState("mystery");
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});

  const dayGroups = useMemo(() => groupJobsByDay(jobs), [jobs]);
  const queueJobs = useMemo(
    () => jobs.filter((j) => isProcessing(j.status)),
    [jobs],
  );
  const doneJobs = useMemo(
    () => jobs.filter((j) => !isProcessing(j.status)),
    [jobs],
  );
  const doneDayGroups = useMemo(() => groupJobsByDay(doneJobs), [doneJobs]);

  const loadJobs = useCallback(async () => {
    const res = await fetch("/api/jobs");
    const json = (await res.json()) as {
      jobs?: JobListItem[];
      capacity?: Capacity;
      error?: string;
    };
    if (!res.ok) throw new Error(json.error || "Failed to load jobs");
    setJobs(json.jobs || []);
    if (json.capacity) setCapacity(json.capacity);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/jobs/${id}`);
    const json = (await res.json()) as { job?: JobDetail; error?: string };
    if (!res.ok) throw new Error(json.error || "Failed to load job");
    setDetail(json.job || null);
  }, []);

  useEffect(() => {
    loadJobs().catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load jobs"),
    );
  }, [loadJobs]);

  useEffect(() => {
    if (!dayGroups.length) return;
    setOpenDays((prev) => {
      const next = { ...prev };
      if (next[dayGroups[0].key] === undefined) next[dayGroups[0].key] = true;
      return next;
    });
  }, [dayGroups]);

  useEffect(() => {
    if (!selectedId || nav !== "jobs") {
      if (nav !== "jobs") setDetail(null);
      return;
    }
    loadDetail(selectedId).catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load job"),
    );
  }, [selectedId, nav, loadDetail]);

  useEffect(() => {
    if (!queueJobs.length && !(detail && isProcessing(detail.status))) return;
    const timer = setInterval(() => {
      loadJobs().catch(() => undefined);
      if (selectedId && nav === "jobs") {
        loadDetail(selectedId).catch(() => undefined);
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [queueJobs.length, detail, selectedId, nav, loadJobs, loadDetail]);

  const scenes = detail?.scenes || [];

  async function submitJob() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script,
          title: title.trim() || undefined,
          niche,
          phase: "google-first",
        }),
      });
      const json = (await res.json()) as {
        capacity?: Capacity;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "Submit failed");
      if (json.capacity) setCapacity(json.capacity);
      setScript("");
      setTitle("");
      setNiche("mystery");
      setSelectedId(null);
      setDetail(null);
      await loadJobs();
      setNav("queue");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function retryJob(id: string) {
    setError(null);
    const res = await fetch(`/api/jobs/${id}/retry`, { method: "POST" });
    const json = (await res.json()) as { error?: string };
    if (!res.ok) {
      setError(json.error || "Retry failed");
      return;
    }
    await loadJobs();
    setNav("queue");
    setSelectedId(null);
  }

  function openJob(id: string) {
    setNav("jobs");
    setSelectedId(id);
    setError(null);
  }

  return (
    <div className="flex min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--sidebar)]">
        <div className="border-b border-[var(--line)] px-5 py-6">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-[var(--blue-bright)] uppercase">
            Script Assembler
          </p>
          <h1 className="mt-2 font-[family-name:var(--font-fraunces)] text-xl leading-tight text-white">
            Visual intelligence
          </h1>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
          {NAV.map((item) => {
            const active = nav === item.key;
            const badge =
              item.key === "queue" && queueJobs.length
                ? queueJobs.length
                : item.key === "jobs" && doneJobs.length
                  ? doneJobs.length
                  : null;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  setNav(item.key);
                  if (item.key !== "jobs") setSelectedId(null);
                  setError(null);
                }}
                className={`nav-item flex items-center justify-between rounded-xl px-3 py-3 text-left text-sm font-medium ${
                  active
                    ? "bg-[rgba(59,130,246,0.2)] text-white shadow-[inset_0_0_0_1px_rgba(96,165,250,0.35)]"
                    : "text-[var(--ink-soft)] hover:bg-white/[0.04] hover:text-white"
                }`}
              >
                <span>{item.label}</span>
                {badge ? (
                  <span className="rounded-full bg-[rgba(59,130,246,0.22)] px-2 py-0.5 text-[11px] font-semibold text-[var(--blue-bright)]">
                    {badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        {capacity ? (
          <div className="border-t border-[var(--line)] px-5 py-4 text-xs text-[var(--ink-soft)]">
            Google today{" "}
            <span className="text-[var(--blue-bright)]">
              {capacity.usedToday}/{capacity.softLimit}
            </span>
          </div>
        ) : null}
      </aside>

      <main className="min-w-0 flex-1 overflow-auto px-6 py-8 sm:px-10">
        {nav === "new" ? (
          <section className="mx-auto max-w-3xl">
            <p className="text-xs font-semibold tracking-[0.18em] text-[var(--blue-bright)] uppercase">
              New Job
            </p>
            <h2 className="mt-2 font-[family-name:var(--font-fraunces)] text-4xl text-white">
              Project info
            </h2>
            <p className="mt-3 text-[var(--ink-soft)]">
              Submit a script. It processes in the cloud and shows under Render
              Queue, then Jobs when done.
            </p>

            <div className="mt-8 space-y-6">
              <Panel title="Job title">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Dead Sea wolves episode"
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel-2)] px-4 py-3 text-sm text-white outline-none placeholder:text-[var(--ink-soft)]/55 focus:border-[var(--blue)]"
                />
              </Panel>

              <Panel title="Niche">
                <div className="grid gap-3 sm:grid-cols-2">
                  {NICHES.map((option) => {
                    const selected = niche === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setNiche(option.id)}
                        className={`rounded-xl border px-4 py-4 text-left transition ${
                          selected
                            ? "border-[var(--blue)] bg-[rgba(59,130,246,0.16)] shadow-[inset_0_0_0_1px_rgba(96,165,250,0.35)]"
                            : "border-[var(--line)] bg-[var(--panel-2)] hover:border-[rgba(96,165,250,0.4)]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-semibold text-white">
                            {option.label} {option.version}
                          </p>
                          {selected ? (
                            <span className="text-[11px] font-semibold tracking-wide text-[var(--blue-bright)] uppercase">
                              Selected
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-2 text-sm leading-relaxed text-[var(--ink-soft)]">
                          {option.description}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </Panel>

              <Panel title="Script">
                <textarea
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  placeholder="Paste the full documentary script or Whisper JSON…"
                  className="min-h-[280px] w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--panel-2)] px-4 py-3 text-sm leading-relaxed text-white outline-none placeholder:text-[var(--ink-soft)]/55 focus:border-[var(--blue)]"
                />
              </Panel>

              <button
                type="button"
                onClick={submitJob}
                disabled={submitting || !script.trim()}
                className="rounded-xl bg-[var(--blue)] px-6 py-3.5 text-sm font-semibold text-white shadow-[0_10px_28px_rgba(37,99,235,0.35)] transition hover:bg-[var(--blue-deep)] hover:shadow-[0_14px_34px_rgba(37,99,235,0.45)] disabled:opacity-45 disabled:shadow-none"
              >
                {submitting ? "Submitting…" : "Submit job"}
              </button>

              {error ? (
                <p className="text-sm font-medium text-[var(--danger)]">{error}</p>
              ) : null}
            </div>
          </section>
        ) : null}

        {nav === "queue" ? (
          <section className="mx-auto max-w-4xl">
            <p className="text-xs font-semibold tracking-[0.18em] text-[var(--blue-bright)] uppercase">
              Render Queue
            </p>
            <h2 className="mt-2 font-[family-name:var(--font-fraunces)] text-4xl text-white">
              Processing
            </h2>
            <p className="mt-3 text-[var(--ink-soft)]">
              Cloud jobs currently queued or running.
            </p>

            <div className="mt-8 space-y-3">
              {queueJobs.length === 0 ? (
                <EmptyState text="Queue is empty. Submit a job to see it process here." />
              ) : (
                queueJobs.map((job) => (
                  <div
                    key={job.id}
                    className="fade-rise rounded-2xl border border-[rgba(96,165,250,0.28)] bg-[linear-gradient(180deg,rgba(59,130,246,0.12),rgba(16,21,34,0.96))] px-5 py-5 shadow-[0_12px_40px_rgba(0,0,0,0.28)]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-base font-semibold text-white">
                          {job.title || "Untitled"}
                        </p>
                        <p className="mt-1 text-xs text-[var(--blue-bright)]">
                          {nicheLabel(job.niche)}
                        </p>
                        <p className="mt-2 text-sm text-[var(--ink-soft)]">
                          {job.progress || "Waiting for cloud worker…"}
                        </p>
                        <div className="mt-4 h-1.5 w-48 overflow-hidden rounded-full bg-white/10">
                          <div className="processing-dot h-full w-2/3 rounded-full bg-[var(--blue)]" />
                        </div>
                      </div>
                      <span className="rounded-full border border-[rgba(96,165,250,0.35)] bg-[rgba(59,130,246,0.14)] px-3 py-1 text-[11px] font-semibold tracking-wide text-[var(--blue-bright)] uppercase">
                        Processing
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        ) : null}

        {nav === "jobs" ? (
          <section className="mx-auto max-w-6xl">
            {!selectedId ? (
              <>
                <p className="text-xs font-semibold tracking-[0.18em] text-[var(--blue-bright)] uppercase">
                  Jobs
                </p>
                <h2 className="mt-2 font-[family-name:var(--font-fraunces)] text-4xl text-white">
                  Past jobs
                </h2>
                <p className="mt-3 text-[var(--ink-soft)]">
                  Sorted by day. Click a title to open scenes.
                </p>

                <div className="mt-8 space-y-5">
                  {doneDayGroups.length === 0 ? (
                    <EmptyState text="No finished jobs yet." />
                  ) : (
                    doneDayGroups.map((day) => {
                      const open = openDays[day.key] ?? true;
                      return (
                        <div
                          key={day.key}
                          className="fade-rise overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] shadow-[0_10px_30px_rgba(0,0,0,0.22)]"
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setOpenDays((prev) => ({
                                ...prev,
                                [day.key]: !open,
                              }))
                            }
                            className="click-row flex w-full items-center justify-between border-b border-transparent px-5 py-4 text-left"
                          >
                            <div className="flex items-center gap-3">
                              <span
                                className={`text-[var(--ink-soft)] transition-transform ${open ? "rotate-90" : ""}`}
                                aria-hidden
                              >
                                ▸
                              </span>
                              <span className="font-[family-name:var(--font-fraunces)] text-xl text-white">
                                {day.label}
                              </span>
                            </div>
                            <span className="rounded-full border border-[rgba(96,165,250,0.35)] bg-[rgba(59,130,246,0.12)] px-2.5 py-0.5 text-xs font-semibold text-[var(--blue-bright)]">
                              {day.count} {day.count === 1 ? "job" : "jobs"}
                            </span>
                          </button>
                          {open ? (
                            <div className="space-y-2 px-3 py-3">
                              {day.jobs.map((job) => (
                                <button
                                  key={job.id}
                                  type="button"
                                  onClick={() => openJob(job.id)}
                                  className="click-row flex w-full items-center gap-4 rounded-xl border border-[var(--line)] bg-[var(--panel-2)] px-4 py-4 text-left"
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-base font-semibold text-white">
                                      {job.title || "Untitled"}
                                    </p>
                                    <p className="mt-1 text-xs text-[var(--ink-soft)]">
                                      {nicheLabel(job.niche)}
                                      {" · "}
                                      {job.status === "failed"
                                        ? job.error || "Failed"
                                        : `${job.sceneCount || 0} scenes · ${job.googleCount} Google packs`}
                                    </p>
                                  </div>
                                  <span
                                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide uppercase ${
                                      job.status === "failed"
                                        ? "bg-[rgba(248,113,113,0.12)] text-[var(--danger)]"
                                        : "bg-[rgba(52,211,153,0.12)] text-[var(--ok)]"
                                    }`}
                                  >
                                    {statusLabel(job.status)}
                                  </span>
                                  <span className="chevron shrink-0 text-sm font-semibold text-[var(--ink-soft)]">
                                    Open →
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            ) : detail ? (
              <JobDetailView
                detail={detail}
                scenes={scenes}
                error={error}
                onBack={() => setSelectedId(null)}
                onRetry={() => retryJob(detail.id)}
              />
            ) : (
              <p className="text-[var(--ink-soft)]">Loading job…</p>
            )}
          </section>
        ) : null}
      </main>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5">
      <p className="mb-3 text-xs font-semibold tracking-[0.16em] text-[var(--ink-soft)] uppercase">
        {title}
      </p>
      {children}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--panel)] px-5 py-10 text-sm text-[var(--ink-soft)]">
      {text}
    </div>
  );
}

function JobDetailView({
  detail,
  scenes,
  error,
  onBack,
  onRetry,
}: {
  detail: JobDetail;
  scenes: Scene[];
  error: string | null;
  onBack: () => void;
  onRetry: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function toggleScene(id: string) {
    setExpandedId((current) => (current === id ? null : id));
  }

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="rounded-lg border border-transparent px-2 py-1 text-sm font-semibold text-[var(--blue-bright)] transition hover:border-[rgba(96,165,250,0.35)] hover:bg-[rgba(59,130,246,0.1)] hover:text-white"
      >
        ← All jobs
      </button>

      <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-[var(--blue-bright)] uppercase">
            {statusLabel(detail.status)}
          </p>
          <h2 className="mt-2 max-w-3xl font-[family-name:var(--font-fraunces)] text-4xl text-white">
            {detail.title || "Untitled"}
          </h2>
          <p className="mt-3 text-sm text-[var(--ink-soft)]">
            {nicheLabel(detail.niche)} · {detail.sceneCount || scenes.length}{" "}
            scenes · {detail.googleCount} Google · {detail.aiCount} AI
            {detail.model ? ` · ${detail.model}` : ""}
          </p>
        </div>
        {detail.status === "failed" ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-semibold hover:border-[var(--blue)]"
          >
            Retry
          </button>
        ) : null}
      </div>

      {detail.error ? (
        <p className="mt-4 text-sm font-medium text-[var(--danger)]">
          {detail.error}
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 text-sm font-medium text-[var(--danger)]">{error}</p>
      ) : null}

      <div className="mt-8">
        <h3 className="font-[family-name:var(--font-fraunces)] text-2xl text-white">
          Scenes
        </h3>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">
          Images stay minimized. Click a scene to maximize it — only one open at
          a time.
        </p>

        {scenes.length === 0 ? (
          <p className="mt-6 text-[var(--ink-soft)]">No scenes yet.</p>
        ) : (
          <div className="mt-6 space-y-3">
            {scenes.map((scene) => {
              const open = expandedId === scene.id;
              const thumb = scene.thumbnailUrl || scene.imageUrl;

              return (
                <article
                  key={scene.id}
                  id={scene.id}
                  className={`fade-rise overflow-hidden rounded-2xl border bg-[var(--panel)] transition ${
                    open
                      ? "border-[rgba(96,165,250,0.5)] shadow-[0_14px_36px_rgba(0,0,0,0.3)]"
                      : "border-[var(--line)]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleScene(scene.id)}
                    className="click-row flex w-full items-center gap-4 px-4 py-4 text-left sm:px-5"
                  >
                    <div className="h-14 w-20 shrink-0 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--panel-2)]">
                      {thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={thumb}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-[10px] uppercase tracking-wide text-[var(--ink-soft)]">
                          {scene.visualSource}
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold tracking-[0.16em] text-[var(--blue-bright)] uppercase">
                          Scene {scene.index}
                        </span>
                        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] uppercase text-[var(--ink-soft)]">
                          {scene.visualSource}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-base font-semibold text-white">
                        {scene.query ||
                          scene.subject ||
                          `Beat ${scene.beatId}`}
                      </p>
                      <p className="mt-1 line-clamp-1 text-xs text-[var(--ink-soft)]">
                        {scene.scriptText}
                      </p>
                    </div>

                    <span className="shrink-0 text-xs font-semibold text-[var(--blue-bright)]">
                      {open ? "Minimize" : "Maximize →"}
                    </span>
                  </button>

                  {open ? (
                    <div className="grid gap-5 border-t border-[var(--line)] px-4 py-5 sm:px-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(280px,0.95fr)]">
                      <div className="min-w-0 space-y-4">
                        <Field label="Script part">
                          <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/90">
                            {scene.scriptText}
                          </p>
                        </Field>
                        {scene.entityContext ? (
                          <Field label="Visual context">
                            <p className="text-sm text-white/85">
                              {scene.entityContext}
                            </p>
                          </Field>
                        ) : null}
                        {scene.why ? (
                          <Field label="Why this source">
                            <p className="text-sm text-white/85">{scene.why}</p>
                          </Field>
                        ) : null}
                      </div>

                      <div className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--panel-2)] p-3 sm:p-4">
                        {thumb ? (
                          <div className="overflow-hidden rounded-lg border border-[var(--line)] bg-black/30">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={thumb}
                              alt={scene.query || `Scene ${scene.index}`}
                              className="aspect-video w-full object-cover"
                            />
                          </div>
                        ) : (
                          <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-[var(--line)] bg-black/20 text-sm text-[var(--ink-soft)]">
                            {scene.visualSource === "ai"
                              ? "AI still — no Google image"
                              : "No image preview"}
                          </div>
                        )}

                        <div className="mt-4 space-y-3">
                          <Field label="Image URL">
                            <UrlOrEmpty value={scene.imageUrl} />
                          </Field>
                          <Field label="Source URL">
                            <UrlOrEmpty value={scene.sourceUrl} />
                          </Field>
                          <Field label="R2 URL">
                            <UrlOrEmpty
                              value={scene.r2Url}
                              empty="Not uploaded yet"
                            />
                          </Field>
                          <Field label="Email">
                            <p className="text-sm text-[var(--ink-soft)]">
                              {scene.email || "—"}
                            </p>
                          </Field>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold tracking-[0.16em] text-[var(--ink-soft)] uppercase">
        {label}
      </p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function UrlOrEmpty({
  value,
  empty = "—",
}: {
  value?: string | null;
  empty?: string;
}) {
  if (!value) {
    return <p className="break-all text-sm text-[var(--ink-soft)]">{empty}</p>;
  }
  return (
    <a
      href={value}
      target="_blank"
      rel="noreferrer"
      className="break-all text-sm text-[var(--blue-bright)] hover:text-white"
    >
      {value}
    </a>
  );
}
