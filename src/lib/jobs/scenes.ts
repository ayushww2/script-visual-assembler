import type { Beat, DividerResult } from "@/lib/divider/schema";
import type { GoogleSearchPreview } from "@/lib/search/google";

export type SceneRecord = {
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
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  r2Url?: string | null;
  email?: string | null;
};

export function buildScenes(input: {
  beats: Beat[];
  result: DividerResult;
  previews?: Record<string, GoogleSearchPreview>;
}): SceneRecord[] {
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

  return input.beats.map((beat, i) => {
    const google = googleByBeat.get(beat.id);
    const ai = aiByBeat.get(beat.id);
    const preview = google ? input.previews?.[google.query] : undefined;
    const hit = preview?.results?.[0];

    if (google) {
      return {
        id: `s${i + 1}`,
        index: i + 1,
        beatId: beat.id,
        scriptText: beat.text,
        start: beat.start,
        end: beat.end,
        visualSource: "google" as const,
        query: google.query,
        subject: google.entityContext,
        entityContext: google.entityContext,
        why: google.whyGoogle,
        priority: google.priority,
        imageUrl: hit?.imageUrl ?? null,
        thumbnailUrl: hit?.thumbnailUrl ?? hit?.imageUrl ?? null,
        sourceUrl: hit?.sourcePageUrl ?? null,
        sourceDomain: hit?.sourceDomain ?? null,
        r2Url: null,
        email: null,
      };
    }

    if (ai) {
      return {
        id: `s${i + 1}`,
        index: i + 1,
        beatId: beat.id,
        scriptText: beat.text,
        start: beat.start,
        end: beat.end,
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
      id: `s${i + 1}`,
      index: i + 1,
      beatId: beat.id,
      scriptText: beat.text,
      start: beat.start,
      end: beat.end,
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
