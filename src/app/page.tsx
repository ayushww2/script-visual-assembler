"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  estimateJobCosts,
  formatUsd,
  GPT_IMAGE2_BATCH_USD,
  GPT_IMAGE2_REALTIME_USD,
  type JobCostEstimate,
} from "@/lib/jobs/costEstimate";

type NavKey = "new" | "jobs" | "queue";

type NicheOption = {
  id: string;
  label: string;
  version: string;
  description: string;
  wpm: number;
};

const NICHES: NicheOption[] = [
  {
    id: "mystery",
    label: "Mystery",
    version: "v1",
    wpm: 160,
    description:
      "Clean documentary evidence — maps, artifacts, archives, places, soft investigative tone. VO locked at 160 WPM.",
  },
];

type JobListItem = {
  id: string;
  title: string | null;
  niche: string;
  status: string;
  phase?: string;
  beatCount: number;
  sceneCount: number;
  googleCount: number;
  aiCount: number;
  error: string | null;
  progress: string | null;
  packageReady?: boolean;
  packageUrl?: string | null;
  packageError?: string | null;
  imagesOnly?: boolean;
  voiceoverDurationSec?: number | null;
  aiBatch?: boolean;
  aiBatchId?: string | null;
  createdAt: string;
  completedAt?: string | null;
};

function nicheLabel(id?: string | null) {
  const found = NICHES.find((n) => n.id === id);
  return found ? `${found.label} ${found.version}` : id || "Mystery v1";
}

type Scene = {
  sceneId?: string;
  words?: string;
  id: string;
  index: number;
  beatId: string;
  scriptText: string;
  wordCount?: number;
  startSec?: number;
  endSec?: number;
  durationSec?: number;
  timingSource?: "whisper" | "wpm";
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
  /** Optional Pexels (or other) B-roll clip. */
  videoUrl?: string | null;
  videoQuery?: string | null;
  videoSource?: string | null;
  email?: string | null;
};

function sceneIdOf(scene: Scene) {
  return scene.sceneId || String(scene.index) || scene.id;
}

function sceneWordsOf(scene: Scene) {
  return scene.words || scene.scriptText || "";
}

type JobDetail = JobListItem & {
  script: string;
  scriptFull?: string;
  wpm?: number;
  scenes: Scene[] | null;
  model: string | null;
  packageJson?: unknown;
  reviewStatus?: string | null;
  review?: FinalReviewPayload | null;
};

type FinalReviewIssue = {
  sceneId: string;
  index: number;
  severity: "major" | "minor";
  category: string;
  issue: string;
  words: string;
  fixType: string;
  suggestedQuery?: string;
  startSec?: number;
  endSec?: number;
};

type FinalReviewPayload = {
  version?: number;
  scannedAt?: string;
  topic?: string;
  scanned?: number;
  majorCount?: number;
  minorCount?: number;
  ok?: number;
  topicSummary?: string;
  progress?: string;
  error?: string;
  majorIssues?: FinalReviewIssue[];
  repairEstimate?: {
    googleQueries: number;
    aiGenerations: number;
    googleRepicks: number;
    searchApiUsd: number;
    aiRealtimeUsd: number;
    aiBatchUsd: number;
    totalRepairUsd: number;
  };
  scanCostUsd?: number;
  usage?: { inputTokens: number; outputTokens: number };
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

/** Prefer completedAt so re-packaged / re-finished jobs show under "today". */
function jobListDate(job: JobListItem): string {
  return job.completedAt || job.createdAt;
}

function groupJobsByDay(jobs: JobListItem[]): DayGroup[] {
  // Newest activity first within each day and across days
  const sorted = [...jobs].sort(
    (a, b) =>
      new Date(jobListDate(b)).getTime() - new Date(jobListDate(a)).getTime(),
  );
  const map = new Map<string, DayGroup>();
  for (const job of sorted) {
    const when = jobListDate(job);
    const key = dayKey(when);
    const existing = map.get(key);
    if (existing) {
      existing.jobs.push(job);
      existing.count += 1;
    } else {
      map.set(key, {
        key,
        label: dayLabel(when),
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
  const [aiBatch, setAiBatch] = useState(false);
  const [forceAllAi, setForceAllAi] = useState(false);
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingDocx, setUploadingDocx] = useState(false);
  const [docxName, setDocxName] = useState<string | null>(null);
  const [batchFiles, setBatchFiles] = useState<
    Array<{ name: string; title: string; script: string }>
  >([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});
  const [selectedPackageIds, setSelectedPackageIds] = useState<string[]>([]);
  const [copyLinksMsg, setCopyLinksMsg] = useState<string | null>(null);
  const docxInputRef = useRef<HTMLInputElement>(null);
  const MAX_BATCH_DOCX = 10;
  const MAX_COPY_PACKAGE_LINKS = 10;

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
  const packageJobsById = useMemo(() => {
    const map = new Map<string, JobListItem>();
    for (const job of doneJobs) {
      if (job.packageReady && job.packageUrl) map.set(job.id, job);
    }
    return map;
  }, [doneJobs]);
  const selectedPackageLinks = useMemo(
    () =>
      selectedPackageIds
        .map((id) => packageJobsById.get(id)?.packageUrl)
        .filter((url): url is string => Boolean(url)),
    [selectedPackageIds, packageJobsById],
  );

  const submitEstimates = useMemo(() => {
    const mode = forceAllAi ? "ai-only" : "google-first";
    if (batchFiles.length > 0) {
      return batchFiles.map((f) => ({
        title: f.title,
        estimate: estimateJobCosts({ script: f.script, mode }),
      }));
    }
    if (!script.trim()) return [] as Array<{ title: string; estimate: JobCostEstimate }>;
    return [
      {
        title: title.trim() || "Untitled",
        estimate: estimateJobCosts({ script, mode }),
      },
    ];
  }, [batchFiles, script, title, forceAllAi]);

  const submitTotals = useMemo(() => {
    const scenes = submitEstimates.reduce((n, e) => n + e.estimate.scenes, 0);
    const aiStills = submitEstimates.reduce(
      (n, e) => n + e.estimate.aiStills,
      0,
    );
    return {
      scenes,
      aiStills,
      realtimeUsd: aiStills * GPT_IMAGE2_REALTIME_USD,
      batchUsd: aiStills * GPT_IMAGE2_BATCH_USD,
    };
  }, [submitEstimates]);

  const loadJobs = useCallback(async () => {
    const res = await fetch("/api/jobs");
    const json = (await res.json()) as {
      jobs?: JobListItem[];
      capacity?: Capacity;
      error?: string;
    };
    if (!res.ok) throw new Error(json.error || "Failed to load jobs");
    const nextJobs = json.jobs || [];
    setJobs(nextJobs);
    if (json.capacity) setCapacity(json.capacity);
    setSelectedPackageIds((prev) => {
      if (!prev.length) return prev;
      const ready = new Set(
        nextJobs
          .filter((j) => j.packageReady && j.packageUrl)
          .map((j) => j.id),
      );
      return prev.filter((id) => ready.has(id));
    });
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
    if (!selectedId || nav !== "jobs") return;
    const reviewActive =
      detail?.reviewStatus === "queued" || detail?.reviewStatus === "running";
    if (!reviewActive) return;
    const timer = setInterval(() => {
      loadDetail(selectedId).catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [selectedId, nav, detail?.reviewStatus, loadDetail]);

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

  async function readDocxFile(file: File): Promise<{
    text: string;
    titleSuggestion?: string;
    filename: string;
  }> {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/script/docx", {
      method: "POST",
      body: form,
    });
    const json = (await res.json()) as {
      text?: string;
      titleSuggestion?: string;
      filename?: string;
      error?: string;
    };
    if (!res.ok) throw new Error(json.error || `Failed to read ${file.name}`);
    if (!json.text?.trim()) throw new Error(`No text found in ${file.name}`);
    return {
      text: json.text,
      titleSuggestion: json.titleSuggestion,
      filename: json.filename || file.name,
    };
  }

  async function ingestDocx(file: File) {
    setUploadingDocx(true);
    setError(null);
    try {
      const json = await readDocxFile(file);
      setScript(json.text);
      setDocxName(json.filename);
      setBatchFiles([]);
      if (!title.trim() && json.titleSuggestion) {
        setTitle(json.titleSuggestion);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read DOCX");
    } finally {
      setUploadingDocx(false);
      if (docxInputRef.current) docxInputRef.current.value = "";
    }
  }

  async function ingestDocxBatch(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((f) =>
      /\.docx$/i.test(f.name),
    );
    if (!files.length) {
      setError("Only .docx files are supported");
      return;
    }
    if (files.length > MAX_BATCH_DOCX) {
      setError(`Max ${MAX_BATCH_DOCX} DOCX files at once`);
      return;
    }

    setUploadingDocx(true);
    setError(null);
    try {
      const loaded: Array<{ name: string; title: string; script: string }> = [];
      const fails: string[] = [];
      for (const file of files) {
        try {
          const json = await readDocxFile(file);
          loaded.push({
            name: json.filename,
            title: json.titleSuggestion || json.filename,
            script: json.text,
          });
        } catch (e) {
          fails.push(
            e instanceof Error ? e.message : `Failed to read ${file.name}`,
          );
        }
      }
      if (!loaded.length) {
        throw new Error(fails[0] || "No DOCX files could be read");
      }
      setBatchFiles(loaded);
      setScript("");
      setTitle("");
      setDocxName(null);
      if (fails.length) {
        setError(
          `Loaded ${loaded.length}/${files.length}. Skipped: ${fails.slice(0, 3).join("; ")}`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read DOCX batch");
    } finally {
      setUploadingDocx(false);
      if (docxInputRef.current) docxInputRef.current.value = "";
    }
  }

  function onDocxDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const list = e.dataTransfer.files;
    if (!list?.length) return;
    if (list.length === 1) void ingestDocx(list[0]);
    else void ingestDocxBatch(list);
  }

  async function submitJob() {
    setSubmitting(true);
    setError(null);
    try {
      if (batchFiles.length > 0) {
        const res = await fetch("/api/jobs/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            niche,
            phase: forceAllAi ? "ai-only" : "google-first",
            forceAllAi,
            aiBatch,
            jobs: batchFiles.map((f) => ({
              script: f.script,
              title: f.title,
            })),
          }),
        });
        const json = (await res.json()) as {
          capacity?: Capacity;
          created?: number;
          error?: string;
          errors?: Array<{ index: number; error: string }>;
        };
        if (!res.ok) throw new Error(json.error || "Batch submit failed");
        if (json.capacity) setCapacity(json.capacity);
        setBatchFiles([]);
        setScript("");
        setTitle("");
        setNiche("mystery");
        setAiBatch(false);
        setForceAllAi(false);
        setDocxName(null);
        setSelectedId(null);
        setDetail(null);
        await loadJobs();
        setNav("queue");
        if (json.errors?.length) {
          setError(
            `Queued ${json.created || 0}. Some failed: ${json.errors
              .slice(0, 3)
              .map((e) => e.error)
              .join("; ")}`,
          );
        }
        return;
      }

      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script,
          title: title.trim() || undefined,
          niche,
          phase: forceAllAi ? "ai-only" : "google-first",
          forceAllAi,
          aiBatch,
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
      setAiBatch(false);
      setForceAllAi(false);
      setDocxName(null);
      setBatchFiles([]);
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

  function togglePackageSelect(jobId: string) {
    setCopyLinksMsg(null);
    setSelectedPackageIds((prev) => {
      if (prev.includes(jobId)) return prev.filter((id) => id !== jobId);
      if (prev.length >= MAX_COPY_PACKAGE_LINKS) {
        setCopyLinksMsg(`Max ${MAX_COPY_PACKAGE_LINKS} package links`);
        return prev;
      }
      return [...prev, jobId];
    });
  }

  async function copySelectedPackageLinks() {
    const links = selectedPackageLinks;
    if (!links.length) {
      setCopyLinksMsg("Select jobs with a ready package");
      return;
    }
    try {
      await navigator.clipboard.writeText(links.join("\n"));
      setCopyLinksMsg(`Copied ${links.length} package link${links.length === 1 ? "" : "s"}`);
    } catch {
      setCopyLinksMsg("Clipboard failed — try again");
    }
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
                        <p className="mt-1 text-xs font-medium text-[var(--blue-bright)]">
                          {option.wpm} WPM
                        </p>
                        <p className="mt-2 text-sm leading-relaxed text-[var(--ink-soft)]">
                          {option.description}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </Panel>

              <Panel title="Script">
                <div
                  onDragEnter={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                  }}
                  onDrop={onDocxDrop}
                  className={`mb-4 rounded-xl border border-dashed px-4 py-6 text-center transition ${
                    dragOver
                      ? "border-[var(--blue)] bg-[rgba(59,130,246,0.14)]"
                      : "border-[var(--line)] bg-[var(--panel-2)]"
                  }`}
                >
                  <p className="text-sm font-semibold text-white">
                    {uploadingDocx
                      ? "Reading DOCX…"
                      : "Drag & drop .docx scripts"}
                  </p>
                  <p className="mt-1 text-xs text-[var(--ink-soft)]">
                    One file loads into the editor. Select up to {MAX_BATCH_DOCX}{" "}
                    files to queue them all at once.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      disabled={uploadingDocx}
                      onClick={() => docxInputRef.current?.click()}
                      className="rounded-lg border border-[var(--line)] bg-black/20 px-4 py-2 text-sm font-semibold text-white transition hover:border-[var(--blue)] disabled:opacity-45"
                    >
                      Choose .docx (max {MAX_BATCH_DOCX})
                    </button>
                    {docxName ? (
                      <span className="max-w-[220px] truncate text-xs text-[var(--blue-bright)]">
                        Loaded: {docxName}
                      </span>
                    ) : null}
                    {batchFiles.length ? (
                      <span className="text-xs text-[var(--blue-bright)]">
                        Batch ready: {batchFiles.length} scripts
                      </span>
                    ) : null}
                  </div>
                  <input
                    ref={docxInputRef}
                    type="file"
                    multiple
                    accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    className="hidden"
                    onChange={(e) => {
                      const list = e.target.files;
                      if (!list?.length) return;
                      if (list.length === 1) void ingestDocx(list[0]);
                      else void ingestDocxBatch(list);
                    }}
                  />
                </div>

                {batchFiles.length > 0 ? (
                  <div className="mb-4 rounded-xl border border-[var(--line)] bg-[var(--panel-2)] px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-white">
                        Batch queue · {batchFiles.length}/{MAX_BATCH_DOCX}
                      </p>
                      <button
                        type="button"
                        onClick={() => setBatchFiles([])}
                        className="text-xs font-semibold text-[var(--ink-soft)] hover:text-white"
                      >
                        Clear
                      </button>
                    </div>
                    <ul className="mt-3 max-h-48 space-y-2 overflow-y-auto">
                      {batchFiles.map((f, i) => (
                        <li
                          key={`${f.name}-${i}`}
                          className="flex items-start justify-between gap-3 text-sm"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-white">
                              {i + 1}. {f.title}
                            </span>
                            <span className="block truncate text-xs text-[var(--ink-soft)]">
                              {f.name} · {f.script.length.toLocaleString()} chars
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setBatchFiles((prev) =>
                                prev.filter((_, idx) => idx !== i),
                              )
                            }
                            className="shrink-0 text-xs text-[var(--ink-soft)] hover:text-[var(--danger)]"
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <textarea
                    value={script}
                    onChange={(e) => setScript(e.target.value)}
                    placeholder="Paste the full documentary script, Whisper JSON, or upload a .docx above…"
                    className="min-h-[280px] w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--panel-2)] px-4 py-3 text-sm leading-relaxed text-white outline-none placeholder:text-[var(--ink-soft)]/55 focus:border-[var(--blue)]"
                  />
                )}
              </Panel>

              <Panel title="Visual mode & AI pricing">
                <div className="space-y-3">
                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel-2)] px-4 py-4">
                    <input
                      type="checkbox"
                      checked={forceAllAi}
                      onChange={(e) => setForceAllAi(e.target.checked)}
                      className="mt-1 h-4 w-4 accent-[var(--blue)]"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-white">
                        Make it all AI
                      </span>
                      <span className="mt-1 block text-sm leading-relaxed text-[var(--ink-soft)]">
                        Skip Google Images. Every scene is gpt-image-2 with the
                        tightened Mystery realism filter. Best when you want a
                        fully generated look — costs scale with scene count.
                      </span>
                    </span>
                  </label>

                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel-2)] px-4 py-4">
                    <input
                      type="checkbox"
                      checked={aiBatch}
                      onChange={(e) => setAiBatch(e.target.checked)}
                      className="mt-1 h-4 w-4 accent-[var(--blue)]"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-white">
                        OpenAI Batch API — 50% cheaper
                      </span>
                      <span className="mt-1 block text-sm leading-relaxed text-[var(--ink-soft)]">
                        Same gpt-image-2 quality. AI stills are queued as a batch
                        instead of realtime. Can take up to 24 hours. Leave off for
                        the fast path.
                      </span>
                    </span>
                  </label>

                  {submitEstimates.length > 0 ? (
                    <div className="rounded-xl border border-[rgba(96,165,250,0.28)] bg-[rgba(59,130,246,0.08)] px-4 py-4">
                      <p className="text-xs font-semibold tracking-[0.16em] text-[var(--blue-bright)] uppercase">
                        Estimate
                        {forceAllAi ? " · all AI" : " · Google-first"}
                        {aiBatch ? " · Batch pricing" : " · realtime pricing"}
                      </p>
                      <div className="mt-3 space-y-2">
                        {submitEstimates.map((row, i) => (
                          <div
                            key={`${row.title}-${i}`}
                            className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
                          >
                            <span className="min-w-0 truncate font-medium text-white">
                              {row.title || `Job ${i + 1}`}
                            </span>
                            <span className="text-[var(--ink-soft)]">
                              {row.estimate.scenes} scenes · ~
                              {row.estimate.aiStills} AI ·{" "}
                              {formatUsd(
                                aiBatch
                                  ? row.estimate.batchUsd
                                  : row.estimate.realtimeUsd,
                              )}
                              {!aiBatch ? (
                                <span className="text-[var(--ink-soft)]/70">
                                  {" "}
                                  (batch {formatUsd(row.estimate.batchUsd)})
                                </span>
                              ) : (
                                <span className="text-[var(--ink-soft)]/70">
                                  {" "}
                                  (realtime {formatUsd(row.estimate.realtimeUsd)})
                                </span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                      {submitEstimates.length > 1 ? (
                        <p className="mt-3 border-t border-[var(--line)] pt-3 text-sm font-semibold text-white">
                          Total · {submitTotals.scenes} scenes · ~
                          {submitTotals.aiStills} AI ·{" "}
                          {formatUsd(
                            aiBatch
                              ? submitTotals.batchUsd
                              : submitTotals.realtimeUsd,
                          )}
                        </p>
                      ) : null}
                      <p className="mt-2 text-[11px] text-[var(--ink-soft)]">
                        gpt-image-2 low @ {formatUsd(GPT_IMAGE2_REALTIME_USD)}
                        /image realtime · {formatUsd(GPT_IMAGE2_BATCH_USD)}
                        /image batch.
                        {!forceAllAi
                          ? ` Google-first AI estimate ~28% of scenes (cap ${submitEstimates[0]?.estimate.aiCap ?? 100}).`
                          : " All-AI = 1 image per scene."}
                      </p>
                    </div>
                  ) : null}
                </div>
              </Panel>

              <button
                type="button"
                onClick={submitJob}
                disabled={
                  submitting ||
                  uploadingDocx ||
                  (!script.trim() && batchFiles.length === 0)
                }
                className="rounded-xl bg-[var(--blue)] px-6 py-3.5 text-sm font-semibold text-white shadow-[0_10px_28px_rgba(37,99,235,0.35)] transition hover:bg-[var(--blue-deep)] hover:shadow-[0_14px_34px_rgba(37,99,235,0.45)] disabled:opacity-45 disabled:shadow-none"
              >
                {submitting
                  ? "Submitting…"
                  : (() => {
                      const n =
                        batchFiles.length > 1
                          ? `Queue ${batchFiles.length} jobs`
                          : "Submit job";
                      const tags = [
                        forceAllAi ? "all AI" : null,
                        aiBatch ? "Batch / 50% off" : null,
                      ].filter(Boolean);
                      return tags.length ? `${n} (${tags.join(" · ")})` : n;
                    })()}
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
                    <JobBudgetBar
                      googleCount={job.googleCount}
                      aiCount={job.aiCount}
                      sceneCount={job.sceneCount}
                      aiBatch={job.aiBatch}
                      phase={job.phase}
                    />
                    <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
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
                  Sorted by day. Select up to {MAX_COPY_PACKAGE_LINKS} package-ready
                  jobs to copy JSON links, or open a title for scenes.
                </p>

                <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] px-4 py-3">
                  <button
                    type="button"
                    disabled={!selectedPackageLinks.length}
                    onClick={() => void copySelectedPackageLinks()}
                    className="rounded-lg bg-[var(--blue)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--blue-deep)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Copy package links
                    {selectedPackageIds.length
                      ? ` (${selectedPackageIds.length}/${MAX_COPY_PACKAGE_LINKS})`
                      : ""}
                  </button>
                  {selectedPackageIds.length ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPackageIds([]);
                        setCopyLinksMsg(null);
                      }}
                      className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm font-semibold text-white hover:border-[var(--blue)]"
                    >
                      Clear
                    </button>
                  ) : null}
                  <span className="text-xs text-[var(--ink-soft)]">
                    {copyLinksMsg ||
                      "Check jobs with a ready package.json, then copy."}
                  </span>
                </div>

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
                              {day.jobs.map((job) => {
                                const canSelect = Boolean(
                                  job.packageReady && job.packageUrl,
                                );
                                const selected = selectedPackageIds.includes(
                                  job.id,
                                );
                                return (
                                  <div
                                    key={job.id}
                                    className={`flex items-stretch gap-2 rounded-xl border bg-[var(--panel-2)] px-3 py-3 ${
                                      selected
                                        ? "border-[rgba(96,165,250,0.55)]"
                                        : "border-[var(--line)]"
                                    }`}
                                  >
                                    <label
                                      className={`flex shrink-0 items-center px-1 ${
                                        canSelect
                                          ? "cursor-pointer"
                                          : "cursor-not-allowed opacity-30"
                                      }`}
                                      title={
                                        canSelect
                                          ? "Select package JSON link"
                                          : "No package URL yet"
                                      }
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4 accent-[var(--blue)]"
                                        disabled={!canSelect}
                                        checked={selected}
                                        onChange={() =>
                                          togglePackageSelect(job.id)
                                        }
                                      />
                                    </label>
                                    <button
                                      type="button"
                                      onClick={() => openJob(job.id)}
                                      className="click-row flex min-w-0 flex-1 flex-col gap-2 text-left"
                                    >
                                      <JobBudgetBar
                                        googleCount={job.googleCount}
                                        aiCount={job.aiCount}
                                        sceneCount={job.sceneCount}
                                        aiBatch={job.aiBatch}
                                        phase={job.phase}
                                      />
                                      <div className="flex w-full items-center gap-4">
                                        <div className="min-w-0 flex-1">
                                          <p className="truncate text-base font-semibold text-white">
                                            {job.title || "Untitled"}
                                          </p>
                                          <p className="mt-1 text-xs text-[var(--ink-soft)]">
                                            {nicheLabel(job.niche)}
                                            {job.status === "failed"
                                              ? ` · ${job.error || "Failed"}`
                                              : job.packageReady
                                                ? " · package ready"
                                                : job.packageError
                                                  ? " · package pending"
                                                  : ""}
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
                                      </div>
                                    </button>
                                  </div>
                                );
                              })}
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
                onRefresh={() => loadDetail(detail.id)}
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

function JobBudgetBar({
  googleCount,
  aiCount,
  sceneCount,
  aiBatch,
  phase,
}: {
  googleCount?: number | null;
  aiCount?: number | null;
  sceneCount?: number | null;
  aiBatch?: boolean | null;
  phase?: string | null;
}) {
  const g = googleCount ?? 0;
  const a = aiCount ?? 0;
  const s = sceneCount ?? 0;
  const realtime = a * GPT_IMAGE2_REALTIME_USD;
  const batch = a * GPT_IMAGE2_BATCH_USD;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold tracking-wide">
      {phase === "ai-only" ? (
        <span className="rounded-md border border-[rgba(251,191,36,0.35)] bg-[rgba(251,191,36,0.12)] px-2 py-0.5 text-amber-200">
          all AI
        </span>
      ) : (
        <span className="rounded-md border border-[rgba(96,165,250,0.35)] bg-[rgba(59,130,246,0.14)] px-2 py-0.5 text-[var(--blue-bright)]">
          {g} Google queries
        </span>
      )}
      <span className="rounded-md border border-[rgba(52,211,153,0.3)] bg-[rgba(52,211,153,0.1)] px-2 py-0.5 text-[var(--ok)]">
        {a} AI images
      </span>
      {s > 0 ? (
        <span className="text-[var(--ink-soft)]">{s} scenes</span>
      ) : null}
      {a > 0 ? (
        <span className="rounded-md border border-[var(--line)] px-2 py-0.5 text-[var(--ink-soft)]">
          {aiBatch
            ? `est. batch ${formatUsd(batch)}`
            : `est. ${formatUsd(realtime)}`}
          {aiBatch ? (
            <span className="opacity-70"> · rt {formatUsd(realtime)}</span>
          ) : (
            <span className="opacity-70"> · batch {formatUsd(batch)}</span>
          )}
        </span>
      ) : null}
    </div>
  );
}

function FinalReviewPanel({
  jobId,
  status,
  sceneCount,
  reviewStatus,
  review,
  aiBatch,
  onRefresh,
}: {
  jobId: string;
  status: string;
  sceneCount: number;
  reviewStatus?: string | null;
  review?: FinalReviewPayload | null;
  aiBatch?: boolean;
  onRefresh: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const canRun =
    status === "completed" && sceneCount > 0 && reviewStatus !== "queued" && reviewStatus !== "running";

  async function startReview() {
    setStarting(true);
    setLocalError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/review`, { method: "POST" });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to start review");
      onRefresh();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Review failed");
    } finally {
      setStarting(false);
    }
  }

  const running = reviewStatus === "queued" || reviewStatus === "running";
  const done = reviewStatus === "completed" && review?.version;
  const majorOnly = (review?.majorIssues || []).filter((i) => i.severity === "major");
  const est = review?.repairEstimate;

  return (
    <div className="mt-6 rounded-2xl border border-[var(--line)] bg-[var(--panel)] px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-[var(--blue-bright)] uppercase">
            Final review
          </p>
          <p className="mt-2 text-sm text-[var(--ink-soft)]">
            Scan every scene still against its narration words and the film topic.
            Estimates Google queries and AI generations to fix major issues.
          </p>
        </div>
        {canRun ? (
          <button
            type="button"
            onClick={() => void startReview()}
            disabled={starting}
            className="rounded-lg bg-[var(--blue)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--blue-deep)] disabled:opacity-50"
          >
            {starting ? "Starting…" : "Run final review"}
          </button>
        ) : null}
      </div>

      {localError ? (
        <p className="mt-3 text-sm text-[var(--danger)]">{localError}</p>
      ) : null}

      {running ? (
        <p className="mt-4 text-sm text-white/90">
          {(review as FinalReviewPayload)?.progress || "Review running…"}
        </p>
      ) : null}

      {reviewStatus === "failed" && review?.error ? (
        <p className="mt-4 text-sm text-[var(--danger)]">{review.error}</p>
      ) : null}

      {done ? (
        <div className="mt-5 space-y-5">
          <p className="text-sm leading-relaxed text-white/90">{review.topicSummary}</p>

          <div className="flex flex-wrap gap-4 text-sm">
            <span className="text-white">
              <strong>{review.majorCount ?? 0}</strong> major
            </span>
            <span className="text-[var(--ink-soft)]">
              <strong className="text-white">{review.minorCount ?? 0}</strong> minor
            </span>
            <span className="text-[var(--ink-soft)]">
              <strong className="text-white">{review.ok ?? 0}</strong> ok
            </span>
            <span className="text-[var(--ink-soft)]">
              scan {formatUsd(review.scanCostUsd ?? 0)}
            </span>
          </div>

          {est ? (
            <div className="rounded-xl border border-[rgba(96,165,250,0.28)] bg-[rgba(59,130,246,0.08)] px-4 py-4">
              <p className="text-xs font-semibold tracking-[0.16em] text-[var(--blue-bright)] uppercase">
                Repair estimate
              </p>
              <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <p className="text-white">
                  Google queries:{" "}
                  <strong>{est.googleQueries}</strong>
                  <span className="text-[var(--ink-soft)]">
                    {" "}
                    (~{formatUsd(est.searchApiUsd)} SearchAPI)
                  </span>
                </p>
                <p className="text-white">
                  AI generations:{" "}
                  <strong>{est.aiGenerations}</strong>
                  <span className="text-[var(--ink-soft)]">
                    {" "}
                    (
                    {aiBatch
                      ? `batch ${formatUsd(est.aiBatchUsd)}`
                      : `realtime ${formatUsd(est.aiRealtimeUsd)}`}
                    )
                  </span>
                </p>
                {est.googleRepicks > 0 ? (
                  <p className="text-[var(--ink-soft)] sm:col-span-2">
                    + {est.googleRepicks} scenes can repick from existing search (0 new queries)
                  </p>
                ) : null}
                <p className="font-semibold text-white sm:col-span-2">
                  Total repair est.{" "}
                  {formatUsd(
                    aiBatch
                      ? est.searchApiUsd + est.aiBatchUsd
                      : est.totalRepairUsd,
                  )}
                </p>
              </div>
            </div>
          ) : null}

          {majorOnly.length > 0 ? (
            <div>
              <p className="text-xs font-semibold tracking-[0.16em] text-[var(--danger)] uppercase">
                Major issues ({majorOnly.length})
              </p>
              <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto text-sm">
                {majorOnly.map((issue) => (
                  <li
                    key={`${issue.index}-${issue.category}`}
                    className="rounded-lg border border-[var(--line)] bg-[var(--panel-2)] px-3 py-2"
                  >
                    <span className="font-semibold text-white">
                      Scene {issue.index}
                    </span>
                    {issue.startSec != null ? (
                      <span className="text-[var(--ink-soft)]">
                        {" "}
                        · {issue.startSec.toFixed(1)}s
                      </span>
                    ) : null}
                    <span className="text-[var(--ink-soft)]"> · {issue.fixType}</span>
                    <p className="mt-1 text-white/90">{issue.issue}</p>
                    <p className="mt-1 truncate text-[var(--ink-soft)]">{issue.words}</p>
                    {issue.suggestedQuery ? (
                      <p className="mt-1 font-mono text-xs text-[var(--blue-bright)]">
                        → {issue.suggestedQuery}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-[var(--ink-soft)]">No major issues found.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function JobDetailView({
  detail,
  scenes,
  error,
  onBack,
  onRetry,
  onRefresh,
}: {
  detail: JobDetail;
  scenes: Scene[];
  error: string | null;
  onBack: () => void;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function toggleScene(id: string) {
    setExpandedId((current) => (current === id ? null : id));
  }

  const packageUrl = detail.packageUrl || null;
  const voSec =
    typeof detail.voiceoverDurationSec === "number"
      ? detail.voiceoverDurationSec
      : null;

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="rounded-lg border border-transparent px-2 py-1 text-sm font-semibold text-[var(--blue-bright)] transition hover:border-[rgba(96,165,250,0.35)] hover:bg-[rgba(59,130,246,0.1)] hover:text-white"
      >
        ← All jobs
      </button>

      {packageUrl ? (
        <div className="mt-5 rounded-2xl border border-[rgba(96,165,250,0.45)] bg-[rgba(59,130,246,0.12)] px-5 py-5">
          <p className="text-xs font-semibold tracking-[0.18em] text-[var(--blue-bright)] uppercase">
            Remotion handoff
          </p>
          <p className="mt-2 font-[family-name:var(--font-fraunces)] text-2xl text-white">
            RENDER_PACKAGE_URL
          </p>
          <p className="mt-2 break-all font-mono text-sm text-[var(--blue-bright)]">
            {packageUrl}
          </p>
          <p className="mt-3 text-sm text-[var(--ink-soft)]">
            scenes={detail.sceneCount || scenes.length}
            {" · "}
            vo={voSec != null ? `${voSec.toFixed(1)}s` : "—"}
            {" · "}
            wpm={detail.wpm || 160}
            {" · "}
            package ready
            {detail.imagesOnly ? " · images-only" : ""}
            {detail.aiBatch ? " · AI Batch 50% off" : ""}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(packageUrl)}
              className="rounded-lg bg-[var(--blue)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--blue-deep)]"
            >
              Copy package URL
            </button>
            <a
              href={packageUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-semibold text-white hover:border-[var(--blue)]"
            >
              Open package.json
            </a>
          </div>
        </div>
      ) : detail.status === "completed" && detail.packageError ? (
        <div className="mt-5 rounded-2xl border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] px-5 py-4">
          <p className="text-xs font-semibold tracking-[0.18em] text-[var(--danger)] uppercase">
            Package not ready
          </p>
          <p className="mt-2 text-sm text-white/90">{detail.packageError}</p>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <JobBudgetBar
            googleCount={detail.googleCount}
            aiCount={detail.aiCount}
            sceneCount={detail.sceneCount || scenes.length}
            aiBatch={detail.aiBatch}
            phase={detail.phase}
          />
          <p className="mt-3 text-xs font-semibold tracking-[0.18em] text-[var(--blue-bright)] uppercase">
            {statusLabel(detail.status)}
          </p>
          <h2 className="mt-2 max-w-3xl font-[family-name:var(--font-fraunces)] text-4xl text-white">
            {detail.title || "Untitled"}
          </h2>
          <p className="mt-3 text-sm text-[var(--ink-soft)]">
            {nicheLabel(detail.niche)}
            {detail.wpm ? ` · ${detail.wpm} WPM` : ""}
            {detail.model ? ` · ${detail.model}` : ""}
            {scenes.filter((s) => s.videoUrl).length
              ? ` · ${scenes.filter((s) => s.videoUrl).length} Pexels clips`
              : ""}
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

      <FinalReviewPanel
        jobId={detail.id}
        status={detail.status}
        sceneCount={detail.sceneCount || scenes.length}
        reviewStatus={detail.reviewStatus}
        review={detail.review}
        aiBatch={detail.aiBatch}
        onRefresh={onRefresh}
      />

      <div className="mt-8">
        <h3 className="font-[family-name:var(--font-fraunces)] text-2xl text-white">
          Scenes
        </h3>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">
          Images stay minimized. Click a scene to maximize it — only one open at
          a time.
          {scenes.some((s) => s.videoUrl)
            ? " Scenes with a Pexels badge have a B-roll clip."
            : ""}
        </p>

        {scenes.length === 0 ? (
          <p className="mt-6 text-[var(--ink-soft)]">No scenes yet.</p>
        ) : (
          <div className="mt-6 space-y-3">
            {scenes.map((scene) => {
              const sid = sceneIdOf(scene);
              const words = sceneWordsOf(scene);
              const open = expandedId === scene.id;
              const thumb = scene.thumbnailUrl || scene.imageUrl;
              const hasVideo = Boolean(scene.videoUrl?.trim());

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
                          Scene {sid}
                        </span>
                        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] uppercase text-[var(--ink-soft)]">
                          {scene.visualSource}
                        </span>
                        {hasVideo ? (
                          <span className="rounded-full border border-[rgba(251,191,36,0.4)] bg-[rgba(251,191,36,0.12)] px-2 py-0.5 text-[11px] font-semibold uppercase text-amber-200">
                            Pexels
                          </span>
                        ) : null}
                        {typeof scene.durationSec === "number" ? (
                          <span className="text-[11px] text-[var(--ink-soft)]">
                            {scene.durationSec.toFixed(1)}s
                            {scene.timingSource === "wpm" && detail.wpm
                              ? ` · ${detail.wpm} WPM`
                              : ""}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-base font-semibold text-white">
                        {scene.query ||
                          scene.subject ||
                          `Beat ${scene.beatId}`}
                      </p>
                      <p className="mt-1 line-clamp-1 text-xs text-[var(--ink-soft)]">
                        {words}
                      </p>
                    </div>

                    <span className="shrink-0 text-xs font-semibold text-[var(--blue-bright)]">
                      {open ? "Minimize" : "Maximize →"}
                    </span>
                  </button>

                  {open ? (
                    <div className="grid gap-5 border-t border-[var(--line)] px-4 py-5 sm:px-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(280px,0.95fr)]">
                      <div className="min-w-0 space-y-4">
                        <Field label="Words">
                          <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/90">
                            {words}
                          </p>
                        </Field>
                        {typeof scene.startSec === "number" &&
                        typeof scene.endSec === "number" ? (
                          <Field label="Timing">
                            <p className="text-sm text-white/85">
                              {scene.startSec.toFixed(2)}s –{" "}
                              {scene.endSec.toFixed(2)}s
                              {typeof scene.durationSec === "number"
                                ? ` (${scene.durationSec.toFixed(2)}s)`
                                : ""}
                              {scene.timingSource === "wpm" && detail.wpm
                                ? ` · from ${detail.wpm} WPM`
                                : scene.timingSource === "whisper"
                                  ? " · Whisper"
                                  : ""}
                            </p>
                          </Field>
                        ) : null}
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

                      <div className="min-w-0 space-y-3 rounded-xl border border-[var(--line)] bg-[var(--panel-2)] p-3 sm:p-4">
                        {hasVideo ? (
                          <div className="overflow-hidden rounded-lg border border-[rgba(251,191,36,0.35)] bg-black/30">
                            <video
                              src={scene.videoUrl || undefined}
                              controls
                              playsInline
                              preload="metadata"
                              className="aspect-video w-full bg-black object-cover"
                            />
                            <p className="border-t border-[var(--line)] px-3 py-2 text-[11px] font-semibold tracking-wide text-amber-200 uppercase">
                              Pexels B-roll
                              {scene.videoQuery ? ` · ${scene.videoQuery}` : ""}
                            </p>
                          </div>
                        ) : null}
                        {thumb ? (
                          <div className="overflow-hidden rounded-lg border border-[var(--line)] bg-black/30">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={thumb}
                              alt={scene.query || `Scene ${scene.index}`}
                              className="aspect-video w-full object-cover"
                            />
                          </div>
                        ) : !hasVideo ? (
                          <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-[var(--line)] bg-black/20 text-sm text-[var(--ink-soft)]">
                            {scene.visualSource === "ai"
                              ? "AI still — no Google image"
                              : "No image preview"}
                          </div>
                        ) : null}

                        <div className="mt-4 space-y-3">
                          {hasVideo ? (
                            <Field label="Pexels video URL">
                              <UrlOrEmpty value={scene.videoUrl} />
                            </Field>
                          ) : null}
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
