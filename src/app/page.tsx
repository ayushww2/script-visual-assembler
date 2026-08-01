"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type JobListItem = {
  id: string;
  title: string | null;
  status: string;
  phase: string;
  beatCount: number;
  googleCount: number;
  aiCount: number;
  model: string | null;
  error: string | null;
  progress: string | null;
  previewDone: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type Beat = { id: string; text: string; start?: number; end?: number };

type GooglePack = {
  query: string;
  entityContext: string;
  whyGoogle: string;
  relatedBeatIds: string[];
  priority: number;
  alternateQueries?: string[];
};

type AiItem = {
  subject: string;
  visualIdea: string;
  whyAiNotGoogle: string;
  relatedBeatIds: string[];
  priority: number;
};

type PreviewHit = {
  title: string;
  imageUrl: string;
  thumbnailUrl?: string;
  sourceDomain?: string;
};

type PreviewResult = {
  query: string;
  results: PreviewHit[];
  filteredOut: number;
  error?: string;
};

type JobDetail = JobListItem & {
  script: string;
  beats: Beat[] | null;
  result: { googleSearches: GooglePack[]; aiGenerate: AiItem[] } | null;
  previews: Record<string, PreviewResult> | null;
};

type Capacity = {
  usedToday: number;
  softLimit: number;
  remaining: number;
};

function statusLabel(status: string) {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "completed") return "Done";
  if (status === "failed") return "Failed";
  return status;
}

function formatWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function Home() {
  const [script, setScript] = useState("");
  const [title, setTitle] = useState("");
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (!selectedId) {
      setDetail(null);
      return;
    }
    loadDetail(selectedId).catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load job"),
    );
  }, [selectedId, loadDetail]);

  // Poll active job + list
  useEffect(() => {
    const active =
      detail &&
      (detail.status === "queued" || detail.status === "running")
        ? detail.id
        : jobs.find((j) => j.status === "queued" || j.status === "running")?.id;

    if (!active) return;

    const timer = setInterval(() => {
      loadJobs().catch(() => undefined);
      if (selectedId) loadDetail(selectedId).catch(() => undefined);
    }, 2500);

    return () => clearInterval(timer);
  }, [detail, jobs, selectedId, loadJobs, loadDetail]);

  const beatLookup = useMemo(() => {
    const map = new Map<string, string>();
    detail?.beats?.forEach((b) => map.set(b.id, b.text));
    return map;
  }, [detail]);

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
        job?: JobListItem;
        capacity?: Capacity;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "Submit failed");
      if (json.capacity) setCapacity(json.capacity);
      setScript("");
      setTitle("");
      await loadJobs();
      if (json.job) setSelectedId(json.job.id);
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
    await loadDetail(id);
  }

  return (
    <div className="relative z-10 mx-auto grid w-full max-w-6xl gap-10 px-5 pb-20 pt-10 lg:grid-cols-[280px_1fr] sm:px-8">
      <aside className="fade-up">
        <p className="text-sm font-medium tracking-[0.18em] text-[var(--accent)] uppercase">
          Past jobs
        </p>
        <div className="mt-4 space-y-2">
          {jobs.length === 0 ? (
            <p className="text-sm text-[var(--ink-soft)]">No jobs yet.</p>
          ) : (
            jobs.map((job) => (
              <button
                key={job.id}
                type="button"
                onClick={() => setSelectedId(job.id)}
                className={`w-full border-t border-[var(--line)] px-0 py-3 text-left transition ${
                  selectedId === job.id ? "opacity-100" : "opacity-75 hover:opacity-100"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="line-clamp-2 font-medium leading-snug">
                    {job.title || "Untitled"}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--ink-soft)]">
                    {statusLabel(job.status)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[var(--ink-soft)]">
                  {formatWhen(job.createdAt)}
                  {job.googleCount ? ` · ${job.googleCount} queries` : ""}
                </p>
              </button>
            ))
          )}
        </div>
        {capacity ? (
          <p className="mt-6 text-xs leading-relaxed text-[var(--ink-soft)]">
            Daily Google capacity: {capacity.usedToday}/{capacity.softLimit}{" "}
            queries used
            {capacity.remaining === 0 ? " — limit reached" : ""}
          </p>
        ) : null}
      </aside>

      <main>
        <header className="fade-up max-w-3xl">
          <p className="text-sm font-medium tracking-[0.18em] text-[var(--accent)] uppercase">
            Documentary Director
          </p>
          <h1 className="mt-3 font-[family-name:var(--font-fraunces)] text-5xl leading-[1.05] tracking-tight sm:text-6xl">
            Script Divider
          </h1>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-[var(--ink-soft)]">
            Submit a script — it queues on Railway, runs in the background, and
            saves Google packs + SearchAPI previews for later.
          </p>
        </header>

        <section className="fade-up mt-10" style={{ animationDelay: "100ms" }}>
          <label className="block text-sm font-semibold tracking-wide text-[var(--ink-soft)]">
            Optional title
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Dead Sea wolves episode"
            className="mt-2 w-full border border-[var(--line)] bg-white/55 px-4 py-3 text-[15px] outline-none backdrop-blur focus:border-[var(--accent)]"
          />

          <label className="mt-5 block text-sm font-semibold tracking-wide text-[var(--ink-soft)]">
            Script / Whisper beats
          </label>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder={`Paste full narration, or Whisper JSON like:\n{\n  "segments": [{ "id": 1, "text": "...", "start": 0.0, "end": 3.2 }]\n}`}
            className="mt-2 min-h-[200px] w-full resize-y border border-[var(--line)] bg-white/55 px-4 py-3 text-[15px] leading-relaxed outline-none backdrop-blur placeholder:text-[var(--ink-soft)]/55 focus:border-[var(--accent)]"
          />

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={submitJob}
              disabled={submitting || !script.trim()}
              className="bg-[var(--accent)] px-5 py-3 text-sm font-semibold tracking-wide text-[#f4f7f5] transition hover:bg-[var(--accent-deep)] disabled:opacity-50"
            >
              {submitting ? "Queueing…" : "Queue cloud job"}
            </button>
            {selectedId ? (
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="border border-[var(--line)] bg-white/50 px-5 py-3 text-sm font-semibold tracking-wide transition hover:border-[var(--accent)]"
              >
                New job
              </button>
            ) : null}
          </div>
          {error ? (
            <p className="mt-4 text-sm font-medium text-[var(--warn)]">{error}</p>
          ) : null}
        </section>

        {detail ? (
          <section className="mt-12 space-y-8">
            <div className="border-t border-[var(--line)] pt-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-[family-name:var(--font-fraunces)] text-3xl">
                    {detail.title || "Untitled"}
                  </h2>
                  <p className="mt-2 text-sm text-[var(--ink-soft)]">
                    {statusLabel(detail.status)}
                    {detail.progress ? ` — ${detail.progress}` : ""}
                  </p>
                </div>
                {detail.status === "failed" ? (
                  <button
                    type="button"
                    onClick={() => retryJob(detail.id)}
                    className="border border-[var(--line)] bg-white/50 px-4 py-2 text-sm font-semibold"
                  >
                    Retry
                  </button>
                ) : null}
              </div>

              <div className="mt-4 flex flex-wrap gap-5 text-sm text-[var(--ink-soft)]">
                <span>
                  <strong className="text-[var(--ink)]">{detail.beatCount}</strong>{" "}
                  beats
                </span>
                <span>
                  <strong className="text-[var(--ink)]">{detail.googleCount}</strong>{" "}
                  Google packs
                </span>
                <span>
                  <strong className="text-[var(--ink)]">{detail.aiCount}</strong> AI
                </span>
                {detail.model ? <span>model {detail.model}</span> : null}
              </div>

              {detail.error ? (
                <p className="mt-4 text-sm font-medium text-[var(--warn)]">
                  {detail.error}
                </p>
              ) : null}

              {(detail.status === "queued" || detail.status === "running") && (
                <p className="mt-4 text-sm text-[var(--ink-soft)]">
                  Running in the cloud — this page updates automatically.
                </p>
              )}
            </div>

            {detail.result?.googleSearches?.length ? (
              <div>
                <h3 className="font-[family-name:var(--font-fraunces)] text-2xl">
                  Google packs
                </h3>
                <ol className="mt-6 space-y-8">
                  {detail.result.googleSearches
                    .slice()
                    .sort((a, b) => b.priority - a.priority)
                    .map((pack) => {
                      const preview = detail.previews?.[pack.query];
                      return (
                        <li
                          key={`${pack.query}-${pack.relatedBeatIds.join(",")}`}
                          className="border-t border-[var(--line)] pt-5"
                        >
                          <div className="flex flex-wrap items-baseline justify-between gap-3">
                            <h4 className="font-[family-name:var(--font-fraunces)] text-xl">
                              {pack.query}
                            </h4>
                            <span className="text-sm text-[var(--ink-soft)]">
                              priority {pack.priority}
                            </span>
                          </div>
                          <p className="mt-2 text-[var(--ink-soft)]">
                            {pack.entityContext}
                          </p>
                          <p className="mt-1 text-sm text-[var(--ink-soft)]">
                            Why Google: {pack.whyGoogle}
                          </p>
                          <p className="mt-3 text-sm">
                            Beats:{" "}
                            {pack.relatedBeatIds
                              .map((id) => {
                                const text = beatLookup.get(id);
                                return text
                                  ? `${id} (“${text.slice(0, 48)}${text.length > 48 ? "…" : ""}”)`
                                  : id;
                              })
                              .join(" · ")}
                          </p>

                          {preview ? (
                            <div className="mt-4">
                              <p className="text-xs font-semibold tracking-wide text-[var(--ink-soft)] uppercase">
                                Search preview · {preview.results.length} usable
                                {preview.error ? ` · ${preview.error}` : ""}
                              </p>
                              {preview.results.length ? (
                                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                                  {preview.results.map((hit) => (
                                    <a
                                      key={hit.imageUrl}
                                      href={hit.imageUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="group block overflow-hidden border border-[var(--line)] bg-black/5"
                                    >
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img
                                        src={hit.thumbnailUrl || hit.imageUrl}
                                        alt={hit.title}
                                        className="aspect-video w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                                      />
                                      <span className="block truncate px-2 py-1 text-[11px] text-[var(--ink-soft)]">
                                        {hit.sourceDomain || hit.title}
                                      </span>
                                    </a>
                                  ))}
                                </div>
                              ) : (
                                <p className="mt-2 text-sm text-[var(--warn)]">
                                  No strong horizontal hits — query may need
                                  rewriting.
                                </p>
                              )}
                            </div>
                          ) : detail.status === "completed" ? (
                            <p className="mt-3 text-sm text-[var(--ink-soft)]">
                              No preview stored for this query.
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                </ol>
              </div>
            ) : null}

            {detail.result?.aiGenerate?.length ? (
              <div className="border-t border-[var(--line)] pt-8 opacity-70">
                <h3 className="font-[family-name:var(--font-fraunces)] text-2xl">
                  AI candidates (not building yet)
                </h3>
                <ul className="mt-4 space-y-3 text-sm text-[var(--ink-soft)]">
                  {detail.result.aiGenerate.map((item) => (
                    <li key={`${item.subject}-${item.relatedBeatIds.join(",")}`}>
                      <strong className="text-[var(--ink)]">{item.subject}</strong>
                      {" — "}
                      {item.whyAiNotGoogle}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}
