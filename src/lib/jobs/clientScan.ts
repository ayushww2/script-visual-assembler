import {
  estimateRepairs,
  runHeuristicReview,
  scenesToReviewInput,
  type FinalReviewResult,
  type MajorIssue,
} from "@/lib/jobs/finalReview";

type ScanApiIssue = {
  sceneId: string;
  index: number;
  severity: string;
  issue: string;
  words: string;
  imageUrl?: string;
};

type ScanApiChunk = {
  issues?: ScanApiIssue[];
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  model?: string;
  error?: string;
};

export type ClientScanProgress = (message: string) => void;

/** Full scan via POST /scan chunks — works on production without /review worker. */
export async function runClientSceneScan(input: {
  jobId: string;
  topic: string;
  scenes: Array<{
    sceneId?: string;
    index?: number;
    words?: string;
    scriptText?: string;
    imageUrl?: string | null;
    visualSource?: string;
    subject?: string;
    query?: string;
    sourceDomain?: string | null;
    startSec?: number;
    endSec?: number;
    why?: string;
  }>;
  chunkSize?: number;
  onProgress?: ClientScanProgress;
}): Promise<FinalReviewResult> {
  const chunkSize = input.chunkSize ?? 20;
  const reviewScenes = scenesToReviewInput(
    input.scenes.map((s, i) => ({
      sceneId: s.sceneId || String(s.index ?? i + 1),
      index: s.index ?? i + 1,
      words: (s.words || s.scriptText || "").trim(),
      imageUrl: s.imageUrl || "",
      visualSource: (s.visualSource || "unassigned") as "google" | "ai" | "unassigned",
      subject: s.subject,
      query: s.query,
      sourceDomain: s.sourceDomain,
      startSec: s.startSec ?? 0,
      endSec: s.endSec ?? 0,
      why: s.why,
      id: s.sceneId || String(i + 1),
      beatId: s.sceneId || String(i + 1),
      scriptText: s.words || s.scriptText || "",
      wordCount: 0,
      durationSec: 0,
      timingSource: "wpm" as const,
    })),
  );

  await input.onProgress?.("Heuristic scan…");
  const heuristic = runHeuristicReview(reviewScenes);

  const total = reviewScenes.length;
  let start = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let scanCostUsd = 0;
  let model = "gpt-5.6-terra";
  const llmIssues: MajorIssue[] = [];

  while (start < total) {
    await input.onProgress?.(
      `ContactBox scan · scenes ${start + 1}–${Math.min(start + chunkSize, total)} of ${total}…`,
    );
    const res = await fetch(
      `/api/jobs/${input.jobId}/scan?mode=text&start=${start}&limit=${chunkSize}`,
      { method: "POST" },
    );
    const chunk = (await res.json()) as ScanApiChunk;
    if (!res.ok) {
      throw new Error(chunk.error || `Scan failed (${res.status})`);
    }

    for (const row of chunk.issues || []) {
      if (row.severity !== "major" && row.severity !== "minor") continue;
      llmIssues.push({
        sceneId: row.sceneId,
        index: row.index,
        severity: row.severity === "major" ? "major" : "minor",
        category: "llm_review",
        issue: row.issue || "Visual mismatch",
        words: row.words,
        imageUrl: row.imageUrl,
        fixType: "google_requery",
      });
    }

    inputTokens += chunk.usage?.inputTokens || 0;
    outputTokens += chunk.usage?.outputTokens || 0;
    scanCostUsd += chunk.costUsd || 0;
    if (chunk.model) model = chunk.model;
    start += chunkSize;
  }

  const byKey = new Map<string, MajorIssue>();
  for (const i of [...heuristic, ...llmIssues]) {
    const k = `${i.index}|${i.category}`;
    const existing = byKey.get(k);
    if (!existing || (i.severity === "major" && existing.severity === "minor")) {
      byKey.set(k, i);
    }
  }
  const merged = Array.from(byKey.values()).sort((a, b) => a.index - b.index);
  const majorIssues = merged.filter((i) => i.severity === "major");
  const minorIssues = merged.filter((i) => i.severity === "minor");

  const topicSummary =
    majorIssues.length > 0
      ? `${majorIssues.length} major and ${minorIssues.length} minor visual issues across ${total} scenes.`
      : "No major visual issues detected.";

  return {
    version: 1,
    scannedAt: new Date().toISOString(),
    topic: input.topic,
    scanned: total,
    majorCount: majorIssues.length,
    minorCount: minorIssues.length,
    ok: total - merged.length,
    topicSummary,
    majorIssues: merged,
    repairEstimate: estimateRepairs(merged),
    usage: { inputTokens, outputTokens },
    scanCostUsd,
    model,
  };
}
