"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type JobListItem = {
  id: string;
  title: string | null;
  status: string;
  beatCount: number;
  sceneCount: number;
  googleCount: number;
  aiCount: number;
  error: string | null;
  progress: string | null;
  createdAt: string;
};

type Scene = {
  id: string;
  index: number;
  beatId: string;
  scriptText: string;
  start?: number;
  end?: number;
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

export default function Home() {
  const [script, setScript] = useState("");
  const [title, setTitle] = useState("");
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});

  const dayGroups = useMemo(() => groupJobsByDay(jobs), [jobs]);

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
      // Keep newest day open by default
      if (next[dayGroups[0].key] === undefined) next[dayGroups[0].key] = true;
      return next;
    });
  }, [dayGroups]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setSelectedSceneId(null);
      return;
    }
    loadDetail(selectedId).catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load job"),
    );
  }, [selectedId, loadDetail]);

  useEffect(() => {
    const hasActive = jobs.some((j) => isProcessing(j.status));
    if (!hasActive && !(detail && isProcessing(detail.status))) return;

    const timer = setInterval(() => {
      loadJobs().catch(() => undefined);
      if (selectedId) loadDetail(selectedId).catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [jobs, detail, selectedId, loadJobs, loadDetail]);

  const scenes = detail?.scenes || [];
  const selectedScene =
    scenes.find((s) => s.id === selectedSceneId) || null;

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
      // Stay on submit screen — job only appears under Past Jobs as processing
      setSelectedId(null);
      setSelectedSceneId(null);
      setDetail(null);
      await loadJobs();
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
    setSelectedSceneId(null);
    await loadJobs();
    await loadDetail(id);
  }

  function openJob(id: string) {
    setSelectedId(id);
    setSelectedSceneId(null);
    setError(null);
  }

  return (
    <div className="relative z-10 mx-auto grid min-h-screen w-full max-w-7xl gap-0 lg:grid-cols-[320px_1fr]">
      <aside className="border-b border-[var(--line)] bg-[var(--bg-elevated)]/90 px-5 py-8 backdrop-blur lg:min-h-screen lg:border-b-0 lg:border-r">
        <p className="text-xs font-semibold tracking-[0.22em] text-[var(--blue-bright)] uppercase">
          Past jobs
        </p>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">
          Grouped by day. Click a title to open scenes.
        </p>

        <div className="mt-6 space-y-4">
          {dayGroups.length === 0 ? (
            <p className="text-sm text-[var(--ink-soft)]">No jobs yet.</p>
          ) : (
            dayGroups.map((day) => {
              const open = openDays[day.key] ?? false;
              return (
                <div key={day.key} className="border-t border-[var(--line)] pt-3">
                  <button
                    type="button"
                    onClick={() =>
                      setOpenDays((prev) => ({
                        ...prev,
                        [day.key]: !open,
                      }))
                    }
                    className="flex w-full items-center justify-between gap-3 text-left"
                  >
                    <span className="font-[family-name:var(--font-fraunces)] text-lg text-white">
                      {day.label}
                    </span>
                    <span className="rounded-full border border-[var(--line)] px-2.5 py-0.5 text-xs font-semibold text-[var(--blue-bright)]">
                      {day.count}
                    </span>
                  </button>

                  {open ? (
                    <div className="mt-3 space-y-1">
                      {day.jobs.map((job) => {
                        const processing = isProcessing(job.status);
                        return (
                          <button
                            key={job.id}
                            type="button"
                            onClick={() => openJob(job.id)}
                            className={`w-full rounded-lg px-3 py-3 text-left transition ${
                              selectedId === job.id
                                ? "bg-[rgba(59,130,246,0.16)] ring-1 ring-[var(--blue)]"
                                : "hover:bg-white/5"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="line-clamp-2 text-sm font-medium text-white">
                                {job.title || "Untitled"}
                              </span>
                              <span
                                className={`shrink-0 text-[11px] font-semibold tracking-wide uppercase ${
                                  processing
                                    ? "processing-dot text-[var(--blue-bright)]"
                                    : job.status === "failed"
                                      ? "text-[var(--danger)]"
                                      : "text-[var(--ink-soft)]"
                                }`}
                              >
                                {statusLabel(job.status)}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-[var(--ink-soft)]">
                              {processing
                                ? job.progress || "Processing in cloud…"
                                : job.sceneCount
                                  ? `${job.sceneCount} scenes · ${job.googleCount} Google`
                                  : `${job.googleCount} Google packs`}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        {capacity ? (
          <p className="mt-8 text-xs leading-relaxed text-[var(--ink-soft)]">
            Daily Google capacity{" "}
            <span className="text-[var(--blue-bright)]">
              {capacity.usedToday}/{capacity.softLimit}
            </span>
          </p>
        ) : null}
      </aside>

      <main className="px-5 py-8 sm:px-8 lg:px-10">
        {!selectedId ? (
          <section className="fade-up mx-auto max-w-3xl">
            <p className="text-xs font-semibold tracking-[0.22em] text-[var(--blue-bright)] uppercase">
              Script Assembler
            </p>
            <h1 className="mt-3 font-[family-name:var(--font-fraunces)] text-5xl leading-[1.05] tracking-tight text-white sm:text-6xl">
              Queue a script
            </h1>
            <p className="mt-4 max-w-2xl text-lg leading-relaxed text-[var(--ink-soft)]">
              Submit once — it processes in the cloud and only appears under
              Past Jobs while running. Open it later to browse every scene.
            </p>

            <div className="mt-10 space-y-5">
              <div>
                <label className="text-xs font-semibold tracking-[0.16em] text-[var(--ink-soft)] uppercase">
                  Title
                </label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Episode / video title"
                  className="mt-2 w-full rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 py-3 text-[15px] text-white outline-none placeholder:text-[var(--ink-soft)]/50 focus:border-[var(--blue)]"
                />
              </div>

              <div>
                <label className="text-xs font-semibold tracking-[0.16em] text-[var(--ink-soft)] uppercase">
                  Script / Whisper beats
                </label>
                <textarea
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  placeholder="Paste full narration or Whisper JSON…"
                  className="mt-2 min-h-[280px] w-full resize-y rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 py-3 text-[15px] leading-relaxed text-white outline-none placeholder:text-[var(--ink-soft)]/50 focus:border-[var(--blue)]"
                />
              </div>

              <button
                type="button"
                onClick={submitJob}
                disabled={submitting || !script.trim()}
                className="rounded-xl bg-[var(--blue)] px-6 py-3.5 text-sm font-semibold tracking-wide text-white transition hover:bg-[var(--blue-deep)] disabled:opacity-45"
              >
                {submitting ? "Submitting…" : "Submit job"}
              </button>

              {error ? (
                <p className="text-sm font-medium text-[var(--danger)]">{error}</p>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="fade-up">
            <button
              type="button"
              onClick={() => {
                setSelectedId(null);
                setSelectedSceneId(null);
              }}
              className="text-sm font-semibold text-[var(--blue-bright)] hover:text-white"
            >
              ← Back to submit
            </button>

            {detail ? (
              <div className="mt-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold tracking-[0.18em] text-[var(--blue-bright)] uppercase">
                      {statusLabel(detail.status)}
                    </p>
                    <h1 className="mt-2 max-w-3xl font-[family-name:var(--font-fraunces)] text-4xl tracking-tight text-white sm:text-5xl">
                      {detail.title || "Untitled"}
                    </h1>
                    <p className="mt-3 text-sm text-[var(--ink-soft)]">
                      {isProcessing(detail.status)
                        ? detail.progress || "Processing in cloud…"
                        : `${detail.sceneCount || scenes.length} scenes · ${detail.googleCount} Google · ${detail.aiCount} AI`}
                      {detail.model ? ` · ${detail.model}` : ""}
                    </p>
                  </div>
                  {detail.status === "failed" ? (
                    <button
                      type="button"
                      onClick={() => retryJob(detail.id)}
                      className="rounded-xl border border-[var(--line)] px-4 py-2 text-sm font-semibold text-white hover:border-[var(--blue)]"
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
                  <p className="mt-4 text-sm font-medium text-[var(--danger)]">
                    {error}
                  </p>
                ) : null}

                {isProcessing(detail.status) ? (
                  <div className="mt-10 rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)] px-6 py-10">
                    <p className="processing-dot text-sm font-semibold tracking-wide text-[var(--blue-bright)] uppercase">
                      Processing
                    </p>
                    <p className="mt-3 max-w-xl text-[var(--ink-soft)]">
                      This job is running in the cloud. Watch progress in Past
                      Jobs — scenes will appear here when it finishes.
                    </p>
                  </div>
                ) : selectedScene ? (
                  <div className="mt-8 grid gap-6 lg:grid-cols-[220px_1fr]">
                    <div className="max-h-[70vh] space-y-1 overflow-auto pr-1">
                      <button
                        type="button"
                        onClick={() => setSelectedSceneId(null)}
                        className="mb-3 text-xs font-semibold tracking-wide text-[var(--blue-bright)] uppercase"
                      >
                        All scenes
                      </button>
                      {scenes.map((scene) => (
                        <button
                          key={scene.id}
                          type="button"
                          onClick={() => setSelectedSceneId(scene.id)}
                          className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                            selectedSceneId === scene.id
                              ? "bg-[rgba(59,130,246,0.18)] text-white"
                              : "text-[var(--ink-soft)] hover:bg-white/5 hover:text-white"
                          }`}
                        >
                          Scene {scene.index}
                        </button>
                      ))}
                    </div>

                    <article className="rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)] p-6">
                      <p className="text-xs font-semibold tracking-[0.18em] text-[var(--blue-bright)] uppercase">
                        Scene {selectedScene.index} · {selectedScene.visualSource}
                      </p>
                      <h2 className="mt-3 font-[family-name:var(--font-fraunces)] text-3xl text-white">
                        {selectedScene.query ||
                          selectedScene.subject ||
                          `Beat ${selectedScene.beatId}`}
                      </h2>

                      <div className="mt-6 space-y-5">
                        <Field label="Script part">
                          <p className="whitespace-pre-wrap leading-relaxed text-white/90">
                            {selectedScene.scriptText}
                          </p>
                        </Field>

                        {selectedScene.entityContext ? (
                          <Field label="Visual context">
                            <p className="text-white/90">
                              {selectedScene.entityContext}
                            </p>
                          </Field>
                        ) : null}

                        {selectedScene.why ? (
                          <Field label="Why this source">
                            <p className="text-white/90">{selectedScene.why}</p>
                          </Field>
                        ) : null}

                        <div className="grid gap-4 sm:grid-cols-2">
                          <Field label="Image URL">
                            <UrlOrEmpty value={selectedScene.imageUrl} />
                          </Field>
                          <Field label="Source URL">
                            <UrlOrEmpty value={selectedScene.sourceUrl} />
                          </Field>
                          <Field label="R2 URL">
                            <UrlOrEmpty value={selectedScene.r2Url} empty="Not uploaded yet" />
                          </Field>
                          <Field label="Email">
                            <p className="text-[var(--ink-soft)]">
                              {selectedScene.email || "—"}
                            </p>
                          </Field>
                        </div>

                        {selectedScene.thumbnailUrl || selectedScene.imageUrl ? (
                          <div className="overflow-hidden rounded-xl border border-[var(--line)]">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={
                                selectedScene.thumbnailUrl ||
                                selectedScene.imageUrl ||
                                ""
                              }
                              alt={selectedScene.query || "Scene visual"}
                              className="aspect-video w-full object-cover"
                            />
                          </div>
                        ) : null}
                      </div>
                    </article>
                  </div>
                ) : (
                  <div className="mt-8">
                    <h2 className="font-[family-name:var(--font-fraunces)] text-2xl text-white">
                      Scenes
                    </h2>
                    <p className="mt-2 text-sm text-[var(--ink-soft)]">
                      Click a scene to inspect its script slice, Google/AI
                      decision, source URL, and R2 fields.
                    </p>

                    {scenes.length === 0 ? (
                      <p className="mt-8 text-[var(--ink-soft)]">
                        No scenes stored for this job yet.
                      </p>
                    ) : (
                      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {scenes.map((scene) => (
                          <button
                            key={scene.id}
                            type="button"
                            onClick={() => setSelectedSceneId(scene.id)}
                            className="rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)] p-4 text-left transition hover:border-[var(--blue)] hover:bg-[rgba(59,130,246,0.08)]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold tracking-wide text-[var(--blue-bright)] uppercase">
                                Scene {scene.index}
                              </span>
                              <span className="text-[11px] uppercase text-[var(--ink-soft)]">
                                {scene.visualSource}
                              </span>
                            </div>
                            <p className="mt-3 line-clamp-2 text-sm font-medium text-white">
                              {scene.query ||
                                scene.subject ||
                                scene.scriptText.slice(0, 80)}
                            </p>
                            <p className="mt-2 line-clamp-2 text-xs text-[var(--ink-soft)]">
                              {scene.scriptText}
                            </p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-8 text-[var(--ink-soft)]">Loading job…</p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
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
