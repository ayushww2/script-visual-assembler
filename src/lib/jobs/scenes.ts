import type { Beat, DividerResult } from "@/lib/divider/schema";
import type { GoogleSearchPreview } from "@/lib/search/google";
import {
  countWords,
  durationSecFromWords,
  getNiche,
} from "@/lib/niches";

/**
 * Canonical scene contract for downstream tools:
 *   { sceneId, words, imageUrl }
 * Timing can be Whisper timestamps or derived from niche WPM
 * (Mystery = 160 WPM → durationSec = wordCount / (160/60)).
 */
export type SceneRecord = {
  sceneId: string;
  words: string;
  imageUrl: string | null;

  wordCount: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  timingSource: "whisper" | "wpm";

  /** Internal / UI fields */
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
  priority?: number;
  thumbnailUrl?: string | null;
  /** Alternate Google hits / thumbs for rehost fallback when original 403s. */
  imageCandidates?: string[];
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  r2Url?: string | null;
  email?: string | null;
};

export type JobExportPayload = {
  title: string;
  scriptFull: string;
  niche: string;
  wpm: number;
  scenes: Array<{
    sceneId: string;
    words: string;
    imageUrl: string | null;
    startSec: number;
    endSec: number;
    durationSec: number;
  }>;
};

export function buildScenes(input: {
  beats: Beat[];
  result: DividerResult;
  previews?: Record<string, GoogleSearchPreview>;
  niche?: string | null;
}): SceneRecord[] {
  const niche = getNiche(input.niche);
  const googleByBeat = new Map<
    string,
    DividerResult["googleSearches"][number]
  >();
  const aiByBeat = new Map<string, DividerResult["aiGenerate"][number]>();

  for (const pack of input.result.googleSearches) {
    for (const beatId of pack.relatedBeatIds) {
      const existing = googleByBeat.get(beatId);
      if (!existing || pack.priority > existing.priority) {
        googleByBeat.set(beatId, pack);
      }
    }
  }

  for (const item of input.result.aiGenerate) {
    for (const beatId of item.relatedBeatIds) {
      if (!aiByBeat.has(beatId)) aiByBeat.set(beatId, item);
    }
  }

  let cursorSec = 0;

  return input.beats.map((beat, i) => {
    const google = googleByBeat.get(beat.id);
    const ai = aiByBeat.get(beat.id);
    const preview = google ? input.previews?.[google.query] : undefined;
    const hit = preview?.results?.[0];
    const sceneId = String(i + 1);
    const words = beat.text;
    const wordCount = countWords(words);

    const hasWhisper =
      typeof beat.start === "number" && typeof beat.end === "number";
    const durationSec = hasWhisper
      ? Math.max(0.1, beat.end! - beat.start!)
      : durationSecFromWords(wordCount, niche.id);
    const startSec = hasWhisper ? beat.start! : cursorSec;
    const endSec = hasWhisper ? beat.end! : cursorSec + durationSec;
    if (!hasWhisper) cursorSec = endSec;

    const base = {
      sceneId,
      words,
      wordCount,
      startSec: roundSec(startSec),
      endSec: roundSec(endSec),
      durationSec: roundSec(durationSec),
      timingSource: (hasWhisper ? "whisper" : "wpm") as "whisper" | "wpm",
      id: `s${sceneId}`,
      index: i + 1,
      beatId: beat.id,
      scriptText: words,
      start: beat.start,
      end: beat.end,
    };

    if (google) {
      const hits = preview?.results || [];
      const imageCandidates = uniqueCandidateUrls(
        hits.flatMap((h) => [h.imageUrl, h.thumbnailUrl]),
      );
      return {
        ...base,
        visualSource: "google" as const,
        query: google.query,
        subject: google.entityContext,
        entityContext: google.entityContext,
        why: google.whyGoogle,
        priority: google.priority,
        imageUrl: hit?.imageUrl ?? hits[0]?.thumbnailUrl ?? null,
        thumbnailUrl: hit?.thumbnailUrl ?? hit?.imageUrl ?? null,
        imageCandidates,
        sourceUrl: hit?.sourcePageUrl ?? null,
        sourceDomain: hit?.sourceDomain ?? null,
        r2Url: null,
        email: null,
      };
    }

    if (ai) {
      return {
        ...base,
        visualSource: "ai" as const,
        subject: ai.subject,
        entityContext: ai.visualIdea,
        why: ai.whyAiNotGoogle,
        priority: ai.priority,
        imageUrl: null,
        thumbnailUrl: null,
        sourceUrl: null,
        sourceDomain: null,
        r2Url: null,
        email: null,
      };
    }

    return {
      ...base,
      visualSource: "unassigned" as const,
      imageUrl: null,
      thumbnailUrl: null,
      sourceUrl: null,
      sourceDomain: null,
      r2Url: null,
      email: null,
    };
  });
}

/** Clean downstream payload: title + scriptFull + scenes[{sceneId, words, imageUrl, …}]. */
export function toJobExportPayload(input: {
  title?: string | null;
  script: string;
  niche?: string | null;
  scenes: SceneRecord[];
}): JobExportPayload {
  const niche = getNiche(input.niche);
  return {
    title: input.title?.trim() || "Untitled",
    scriptFull: input.script,
    niche: niche.id,
    wpm: niche.wpm,
    scenes: input.scenes.map((s) => ({
      sceneId: s.sceneId,
      words: s.words,
      imageUrl: s.imageUrl,
      startSec: s.startSec,
      endSec: s.endSec,
      durationSec: s.durationSec,
    })),
  };
}

function roundSec(n: number): number {
  return Math.round(n * 100) / 100;
}

function uniqueCandidateUrls(
  urls: Array<string | null | undefined>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    const v = (u || "").trim();
    if (!v.startsWith("http") || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
