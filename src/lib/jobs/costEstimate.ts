import { parseBeats } from "@/lib/divider/beats";
import { MAX_AI_STILLS_PER_JOB } from "@/lib/divider/budget";

/** gpt-image-2 · 1536x1024 · quality=low (override via env). */
export const GPT_IMAGE2_REALTIME_USD = Math.max(
  0,
  Number(process.env.GPT_IMAGE2_REALTIME_USD || 0.005) || 0.005,
);
/** OpenAI Batch ≈ 50% of realtime. */
export const GPT_IMAGE2_BATCH_USD = Math.max(
  0,
  Number(process.env.GPT_IMAGE2_BATCH_USD || GPT_IMAGE2_REALTIME_USD * 0.5) ||
    GPT_IMAGE2_REALTIME_USD * 0.5,
);

export type VisualMode = "google-first" | "ai-only" | "google-only";

export type JobCostEstimate = {
  scenes: number;
  /** Expected AI stills to generate. */
  aiStills: number;
  /** Soft upper for google-first (budget cap). */
  aiCap: number;
  realtimeUsd: number;
  batchUsd: number;
  mode: VisualMode;
};

export function estimateSceneCount(
  script: string,
  nicheId?: string | null,
): number {
  try {
    return parseBeats(script || "", { nicheId }).length;
  } catch {
    return 0;
  }
}

/**
 * Pre-submit cost estimate.
 * google-first: ~28% of scenes as AI, hard-capped at MAX_AI_STILLS_PER_JOB.
 * ai-only: every scene is AI (no Google).
 * google-only: zero AI stills (celebrity experiment).
 */
export function estimateJobCosts(input: {
  script: string;
  mode?: VisualMode;
  nicheId?: string | null;
  /** Override scene count (e.g. known beatCount). */
  scenes?: number;
  /** Override AI still count (e.g. known aiCount after divide). */
  aiStills?: number;
}): JobCostEstimate {
  const mode: VisualMode =
    input.mode === "ai-only"
      ? "ai-only"
      : input.mode === "google-only"
        ? "google-only"
        : "google-first";
  const scenes =
    typeof input.scenes === "number" && input.scenes > 0
      ? input.scenes
      : estimateSceneCount(input.script, input.nicheId);
  const aiCap = MAX_AI_STILLS_PER_JOB;

  let aiStills: number;
  if (typeof input.aiStills === "number" && input.aiStills >= 0) {
    aiStills = input.aiStills;
  } else if (mode === "ai-only") {
    aiStills = scenes;
  } else if (mode === "google-only") {
    aiStills = 0;
  } else {
    aiStills = Math.min(aiCap, Math.max(0, Math.round(scenes * 0.28)));
  }

  return {
    scenes,
    aiStills,
    aiCap,
    realtimeUsd: aiStills * GPT_IMAGE2_REALTIME_USD,
    batchUsd: aiStills * GPT_IMAGE2_BATCH_USD,
    mode,
  };
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
