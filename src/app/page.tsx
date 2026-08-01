"use client";

import { useMemo, useState } from "react";

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

type DivideResponse = {
  beats: Beat[];
  result: { googleSearches: GooglePack[]; aiGenerate: AiItem[] };
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
};

type PreviewHit = {
  title: string;
  imageUrl: string;
  thumbnailUrl?: string;
  sourceDomain?: string;
  width?: number;
  height?: number;
};

type PreviewResult = {
  query: string;
  results: PreviewHit[];
  filteredOut: number;
};

export default function Home() {
  const [script, setScript] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DivideResponse | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewResult>>({});

  const googleCount = data?.result.googleSearches.length ?? 0;
  const aiCount = data?.result.aiGenerate.length ?? 0;

  const beatLookup = useMemo(() => {
    const map = new Map<string, string>();
    data?.beats.forEach((b) => map.set(b.id, b.text));
    return map;
  }, [data]);

  async function runDivider() {
    setLoading(true);
    setError(null);
    setPreviews({});
    try {
      const res = await fetch("/api/divide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, phase: "google-first" }),
      });
      const json = (await res.json()) as DivideResponse;
      if (!res.ok) throw new Error(json.error || "Divide failed");
      setData(json);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Divide failed");
    } finally {
      setLoading(false);
    }
  }

  async function previewGoogle() {
    if (!data?.result.googleSearches.length) return;
    setPreviewing(true);
    setError(null);
    try {
      const queries = data.result.googleSearches.map((p) => p.query);
      const res = await fetch("/api/search/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries, num: 5 }),
      });
      const json = (await res.json()) as {
        results?: PreviewResult[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "Preview failed");
      const next: Record<string, PreviewResult> = {};
      for (const item of json.results || []) next[item.query] = item;
      setPreviews(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div className="relative z-10 mx-auto w-full max-w-6xl px-5 pb-20 pt-10 sm:px-8">
      <header className="fade-up max-w-3xl">
        <p className="text-sm font-medium tracking-[0.18em] text-[var(--accent)] uppercase">
          Documentary Director
        </p>
        <h1 className="mt-3 font-[family-name:var(--font-fraunces)] text-5xl leading-[1.05] tracking-tight sm:text-6xl">
          Script Divider
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-[var(--ink-soft)]">
          Phase 1: decide what Google Image Search can honestly cover. Paste a
          full script or Whisper JSON — get entity-first query packs, then
          preview real hits.
        </p>
      </header>

      <section className="fade-up mt-10" style={{ animationDelay: "120ms" }}>
        <label className="block text-sm font-semibold tracking-wide text-[var(--ink-soft)]">
          Script / Whisper beats
        </label>
        <textarea
          value={script}
          onChange={(e) => setScript(e.target.value)}
          placeholder={`Paste full narration, or Whisper JSON like:\n{\n  "segments": [{ "id": 1, "text": "...", "start": 0.0, "end": 3.2 }]\n}`}
          className="mt-3 min-h-[220px] w-full resize-y border border-[var(--line)] bg-white/55 px-4 py-3 text-[15px] leading-relaxed text-[var(--ink)] outline-none backdrop-blur placeholder:text-[var(--ink-soft)]/55 focus:border-[var(--accent)]"
        />
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={runDivider}
            disabled={loading || !script.trim()}
            className="bg-[var(--accent)] px-5 py-3 text-sm font-semibold tracking-wide text-[#f4f7f5] transition hover:bg-[var(--accent-deep)] disabled:opacity-50"
          >
            {loading ? "Dividing…" : "Build Google logic"}
          </button>
          <button
            type="button"
            onClick={previewGoogle}
            disabled={previewing || !googleCount}
            className="border border-[var(--line)] bg-white/50 px-5 py-3 text-sm font-semibold tracking-wide transition hover:border-[var(--accent)] disabled:opacity-50"
          >
            {previewing ? "Searching…" : "Preview Google hits"}
          </button>
        </div>
        {error ? (
          <p className="mt-4 text-sm font-medium text-[var(--warn)]">{error}</p>
        ) : null}
      </section>

      {data ? (
        <section className="mt-12 space-y-10">
          <div className="flex flex-wrap gap-6 border-t border-[var(--line)] pt-5 text-sm text-[var(--ink-soft)]">
            <span>
              <strong className="text-[var(--ink)]">{data.beats.length}</strong>{" "}
              beats
            </span>
            <span>
              <strong className="text-[var(--ink)]">{googleCount}</strong> Google
              packs
            </span>
            <span>
              <strong className="text-[var(--ink)]">{aiCount}</strong> AI
              (deferred)
            </span>
            <span>model {data.model}</span>
          </div>

          <div>
            <h2 className="font-[family-name:var(--font-fraunces)] text-3xl">
              Google packs
            </h2>
            <p className="mt-2 max-w-2xl text-[var(--ink-soft)]">
              Unique real-world subjects bundled across beats. Queries are
              entity-first photo language — not narration sentences.
            </p>

            <ol className="mt-8 space-y-8">
              {data.result.googleSearches
                .slice()
                .sort((a, b) => b.priority - a.priority)
                .map((pack) => {
                  const preview = previews[pack.query];
                  return (
                    <li
                      key={`${pack.query}-${pack.relatedBeatIds.join(",")}`}
                      className="border-t border-[var(--line)] pt-5"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-3">
                        <h3 className="font-[family-name:var(--font-fraunces)] text-2xl">
                          {pack.query}
                        </h3>
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
                      {pack.alternateQueries?.length ? (
                        <p className="mt-2 text-sm text-[var(--ink-soft)]">
                          Alternates: {pack.alternateQueries.join(" · ")}
                        </p>
                      ) : null}

                      {preview ? (
                        <div className="mt-4">
                          <p className="text-xs font-semibold tracking-wide text-[var(--ink-soft)] uppercase">
                            Search preview · {preview.results.length} usable
                            {preview.filteredOut
                              ? ` · ${preview.filteredOut} filtered`
                              : ""}
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
                      ) : null}
                    </li>
                  );
                })}
            </ol>
          </div>

          {data.result.aiGenerate.length ? (
            <div className="border-t border-[var(--line)] pt-8 opacity-70">
              <h2 className="font-[family-name:var(--font-fraunces)] text-2xl">
                AI candidates (not building yet)
              </h2>
              <ul className="mt-4 space-y-3 text-sm text-[var(--ink-soft)]">
                {data.result.aiGenerate.map((item) => (
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
    </div>
  );
}
