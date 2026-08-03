import { createContactBoxClient, getContactBoxConfig } from "@/lib/contactbox";
import { beatLooksGoogleable, queryForGoogleableBeat } from "@/lib/divider/googleFirst";
import {
  GPT_IMAGE2_BATCH_USD,
  GPT_IMAGE2_REALTIME_USD,
} from "@/lib/jobs/costEstimate";
import type { SceneRecord } from "@/lib/jobs/scenes";
import { isChairClicheAiScene, isWrongChairPersonSwap } from "@/lib/jobs/repairAiCliche";
import { isMisplacedAiScene } from "@/lib/jobs/repairGoogleFirst";
import { isBadGoogleScenePick } from "@/lib/search/google";
import { resolveGoogleSubject } from "@/lib/search/resolveSubject";
import { TERRA_INPUT_USD_PER_M, TERRA_OUTPUT_USD_PER_M } from "@/lib/jobs/sceneScan";

/** SearchAPI developer tier ≈ $4 / 1k queries. */
export const SEARCHAPI_USD_PER_QUERY = Math.max(
  0,
  Number(process.env.SEARCHAPI_USD_PER_QUERY || 0.004) || 0.004,
);

export type FixType = "google_requery" | "google_repick" | "ai_regenerate" | "none";

export type MajorIssue = {
  sceneId: string;
  index: number;
  severity: "major" | "minor";
  category: string;
  issue: string;
  words: string;
  startSec?: number;
  endSec?: number;
  visualSource?: string;
  fixType: FixType;
  suggestedQuery?: string;
  imageUrl?: string;
};

export type RepairEstimate = {
  googleQueries: number;
  aiGenerations: number;
  googleRepicks: number;
  searchApiUsd: number;
  aiRealtimeUsd: number;
  aiBatchUsd: number;
  totalRepairUsd: number;
};

export type FinalReviewResult = {
  version: 1;
  scannedAt: string;
  topic: string;
  scanned: number;
  majorCount: number;
  minorCount: number;
  ok: number;
  topicSummary: string;
  majorIssues: MajorIssue[];
  repairEstimate: RepairEstimate;
  usage: { inputTokens: number; outputTokens: number };
  scanCostUsd: number;
  model: string;
};

export type ReviewSceneInput = {
  sceneId: string;
  index: number;
  words: string;
  imageUrl: string;
  visualSource?: string;
  subject?: string;
  query?: string;
  sourceDomain?: string;
  startSec?: number;
  endSec?: number;
  why?: string;
};

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Model did not return valid JSON");
  }
}

function costFromUsage(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * TERRA_INPUT_USD_PER_M +
    (outputTokens / 1_000_000) * TERRA_OUTPUT_USD_PER_M
  );
}

function riskySourceDomain(domain: string, why: string, url: string): boolean {
  const blob = `${domain} ${why} ${url}`.toLowerCase();
  return /imdb|youtube|youtu\.be|ytimg|dailymotion|etsy|pixabay|poster|shutterstock|getty|alamy/.test(
    blob,
  );
}

function suggestedQueryForScene(scene: ReviewSceneInput): string {
  const { personName, placeName } = resolveGoogleSubject(
    scene.words,
    scene.query,
    scene.subject,
  );
  if (personName) return personName;
  if (placeName) return placeName;
  const fromBeat = queryForGoogleableBeat(scene.words);
  if (fromBeat) return fromBeat;
  return (scene.query || scene.subject || scene.words.split(/\s+/).slice(0, 4).join(" "))
    .replace(/\bgibson\b/gi, "Mel Gibson")
    .trim();
}

function fixTypeForHeuristic(
  category: string,
  scene: ReviewSceneInput,
): FixType {
  if (category === "missing_image") {
    return beatLooksGoogleable(scene.words) ? "google_requery" : "ai_regenerate";
  }
  if (category === "ai_should_be_google" || category === "bad_google_pick") {
    return "google_requery";
  }
  if (category === "risky_source") return "google_requery";
  if (category === "chair_cliche") {
    return /\b(serious|eyebrow|mel gibson|gibson)\b/i.test(scene.words)
      ? "google_requery"
      : "ai_regenerate";
  }
  if (category === "wrong_chair_swap") return "ai_regenerate";
  return "google_repick";
}

/** Fast local pass — all scenes, no API cost. */
export function runHeuristicReview(scenes: ReviewSceneInput[]): MajorIssue[] {
  const issues: MajorIssue[] = [];
  const seen = new Set<string>();

  for (const s of scenes) {
    const record = s as unknown as SceneRecord;
    const key = (cat: string) => `${s.index}|${cat}`;

    const push = (
      severity: "major" | "minor",
      category: string,
      issue: string,
    ) => {
      const k = key(category);
      if (seen.has(k)) return;
      seen.add(k);
      issues.push({
        sceneId: s.sceneId,
        index: s.index,
        severity,
        category,
        issue,
        words: s.words,
        startSec: s.startSec,
        endSec: s.endSec,
        visualSource: s.visualSource,
        fixType: fixTypeForHeuristic(category, s),
        suggestedQuery: suggestedQueryForScene(s),
        imageUrl: s.imageUrl,
      });
    };

    if (!s.imageUrl?.trim()) {
      push("major", "missing_image", "No still assigned for this beat");
    }

    if (isBadGoogleScenePick(record)) {
      push(
        "major",
        "bad_google_pick",
        "Wrong person, watermark, poster, or place/people mismatch",
      );
    }

    if (isMisplacedAiScene(record)) {
      push(
        "major",
        "ai_should_be_google",
        "Photographable subject should use a real Google photo, not AI",
      );
    }

    if (isChairClicheAiScene(record)) {
      push("major", "chair_cliche", "Empty-chair / vacant interview AI cliché");
    }

    if (isWrongChairPersonSwap(record)) {
      push("minor", "wrong_chair_swap", "Mel Google swap on a non-serious beat");
    }

    if (
      s.visualSource === "google" &&
      riskySourceDomain(s.sourceDomain || "", s.why || "", s.imageUrl)
    ) {
      push(
        "minor",
        "risky_source",
        `Risky source domain (${s.sourceDomain || "unknown"}) — poster/thumbnail/stock likely`,
      );
    }
  }

  return issues.sort((a, b) => a.index - b.index);
}

const REVIEW_SYSTEM = `You are the FINAL REVIEWER for images-only YouTube documentary films.

You receive:
- the film TOPIC (title)
- a batch of scenes with: sceneId, timing (start–end sec), spoken words, visual source (google/ai), subject, query

Judge each scene: does the assigned still (inferred from metadata) honestly match what is being said AT THAT MOMENT, and fit the film topic?

Flag MAJOR issues when:
- wrong person for a named-person beat
- movie poster / meme / quote card / logo graphic likely
- AI used where a real photo clearly exists (tombs, sites, named people, film stills)
- empty-chair prop on a person/event beat
- obvious topic drift (unrelated B-roll for the narration)

Flag MINOR for borderline stock hosts, weak but usable picks.

Return JSON only:
{
  "reviews": [
    {
      "sceneId": "1",
      "severity": "ok"|"minor"|"major",
      "issue": "reason or empty if ok",
      "fixType": "google_requery"|"google_repick"|"ai_regenerate"|"none",
      "suggestedQuery": "2-4 word query if google_requery else empty"
    }
  ]
}`;

export async function runLlmReviewBatch(input: {
  topic: string;
  scenes: ReviewSceneInput[];
  batchIndex: number;
  batchCount: number;
}): Promise<{
  issues: MajorIssue[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}> {
  const { model } = getContactBoxConfig();
  const client = createContactBoxClient();

  const lines = input.scenes.map((s) => {
    const timing =
      s.startSec != null && s.endSec != null
        ? `${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}s`
        : "—";
    return [
      `sceneId=${s.sceneId} index=${s.index} timing=${timing}`,
      `words: ${s.words}`,
      `source: ${s.visualSource || "?"} · subject: ${s.subject || "—"} · query: ${s.query || "—"}`,
    ].join("\n");
  });

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.15,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: REVIEW_SYSTEM },
      {
        role: "user",
        content: `TOPIC: ${input.topic}\nBatch ${input.batchIndex + 1}/${input.batchCount} · ${input.scenes.length} scenes\n\n${lines.join("\n\n---\n\n")}`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Empty review response");

  const parsed = extractJson(content) as {
    reviews?: Array<{
      sceneId?: string;
      severity?: string;
      issue?: string;
      fixType?: string;
      suggestedQuery?: string;
    }>;
  };

  const byId = new Map(input.scenes.map((s) => [s.sceneId, s]));
  const issues: MajorIssue[] = [];

  for (const row of parsed.reviews || []) {
    if (row.severity !== "major" && row.severity !== "minor") continue;
    const scene = byId.get(String(row.sceneId || ""));
    if (!scene) continue;
    const fixType = (
      ["google_requery", "google_repick", "ai_regenerate", "none"].includes(
        row.fixType || "",
      )
        ? row.fixType
        : row.severity === "major"
          ? fixTypeForHeuristic("bad_google_pick", scene)
          : "google_repick"
    ) as FixType;

    issues.push({
      sceneId: scene.sceneId,
      index: scene.index,
      severity: row.severity === "major" ? "major" : "minor",
      category: "llm_review",
      issue: (row.issue || "").trim() || "Visual mismatch with narration/topic",
      words: scene.words,
      startSec: scene.startSec,
      endSec: scene.endSec,
      visualSource: scene.visualSource,
      fixType,
      suggestedQuery: row.suggestedQuery?.trim() || suggestedQueryForScene(scene),
      imageUrl: scene.imageUrl,
    });
  }

  return {
    issues,
    model,
    usage: {
      inputTokens: completion.usage?.prompt_tokens || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
    },
  };
}

export async function runTopicSummary(input: {
  topic: string;
  majorIssues: MajorIssue[];
}): Promise<{
  summary: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  if (!input.majorIssues.length) {
    return {
      summary: "No major visual issues detected. Stills align with narration and topic.",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const { model } = getContactBoxConfig();
  const client = createContactBoxClient();
  const sample = input.majorIssues.slice(0, 20).map((i) => ({
    scene: i.index,
    issue: i.issue,
    words: i.words.slice(0, 80),
  }));

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "Summarize documentary visual QA findings in 2-4 sentences for a producer. Be specific about patterns (wrong sources, AI misuse, topic drift). No bullet lists.",
      },
      {
        role: "user",
        content: `Topic: ${input.topic}\nMajor issues (${input.majorIssues.length} total):\n${JSON.stringify(sample, null, 2)}`,
      },
    ],
  });

  return {
    summary:
      completion.choices[0]?.message?.content?.trim() ||
      `${input.majorIssues.length} major visual issues found.`,
    usage: {
      inputTokens: completion.usage?.prompt_tokens || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
    },
  };
}

export function estimateRepairs(issues: MajorIssue[]): RepairEstimate {
  const majorAndMinor = issues.filter((i) => i.severity === "major" || i.severity === "minor");
  const querySet = new Set<string>();
  let googleQueries = 0;
  let googleRepicks = 0;
  let aiGenerations = 0;

  for (const issue of majorAndMinor) {
    if (issue.fixType === "google_requery") {
      const q = (issue.suggestedQuery || "documentary").trim().toLowerCase();
      if (!querySet.has(q)) {
        querySet.add(q);
        googleQueries += 1;
      }
    } else if (issue.fixType === "google_repick") {
      googleRepicks += 1;
    } else if (issue.fixType === "ai_regenerate") {
      aiGenerations += 1;
    }
  }

  const searchApiUsd = googleQueries * SEARCHAPI_USD_PER_QUERY;
  const aiRealtimeUsd = aiGenerations * GPT_IMAGE2_REALTIME_USD;
  const aiBatchUsd = aiGenerations * GPT_IMAGE2_BATCH_USD;

  return {
    googleQueries,
    aiGenerations,
    googleRepicks,
    searchApiUsd,
    aiRealtimeUsd,
    aiBatchUsd,
    totalRepairUsd: searchApiUsd + aiRealtimeUsd,
  };
}

function mergeIssues(heuristic: MajorIssue[], llm: MajorIssue[]): MajorIssue[] {
  const byKey = new Map<string, MajorIssue>();
  for (const i of heuristic) byKey.set(`${i.index}|${i.category}`, i);
  for (const i of llm) {
    const k = `${i.index}|${i.category}`;
    const existing = byKey.get(k);
    if (!existing || (i.severity === "major" && existing.severity === "minor")) {
      byKey.set(k, i);
    }
  }
  // Also dedupe same index with different categories — keep all distinct categories
  return Array.from(byKey.values()).sort((a, b) => a.index - b.index);
}

export function scenesToReviewInput(
  scenes: SceneRecord[],
): ReviewSceneInput[] {
  return scenes.map((s, i) => ({
    sceneId: s.sceneId || String(s.index ?? i + 1),
    index: s.index ?? i + 1,
    words: (s.words || s.scriptText || "").trim(),
    imageUrl: s.imageUrl || "",
    visualSource: s.visualSource,
    subject: s.subject,
    query: s.query,
    sourceDomain: s.sourceDomain || undefined,
    startSec: s.startSec,
    endSec: s.endSec,
    why: s.why,
  }));
}

export async function runFinalReview(input: {
  topic: string;
  scenes: ReviewSceneInput[];
  onProgress?: (msg: string) => Promise<void> | void;
  llmBatchSize?: number;
  skipLlm?: boolean;
}): Promise<FinalReviewResult> {
  const withImages = input.scenes.filter((s) => s.words);
  await input.onProgress?.(`Heuristic scan · ${withImages.length} scenes…`);

  const heuristicIssues = runHeuristicReview(withImages);
  let llmIssues: MajorIssue[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let model = getContactBoxConfig().model;

  if (!input.skipLlm && getContactBoxConfig().configured) {
    const batchSize = Math.max(4, input.llmBatchSize ?? 6);
    const batches: ReviewSceneInput[][] = [];
    for (let i = 0; i < withImages.length; i += batchSize) {
      batches.push(withImages.slice(i, i + batchSize));
    }

    await input.onProgress?.(
      `ContactBox topic review · ${batches.length} batches…`,
    );

    for (let i = 0; i < batches.length; i++) {
      await input.onProgress?.(
        `Review batch ${i + 1}/${batches.length}…`,
      );
      try {
        const batch = await runLlmReviewBatch({
          topic: input.topic,
          scenes: batches[i],
          batchIndex: i,
          batchCount: batches.length,
        });
        llmIssues.push(...batch.issues);
        inputTokens += batch.usage.inputTokens;
        outputTokens += batch.usage.outputTokens;
        model = batch.model;
      } catch (err) {
        console.warn("[review] LLM batch failed", i, err);
      }
    }
  }

  const merged = mergeIssues(heuristicIssues, llmIssues);
  const majorIssues = merged.filter((i) => i.severity === "major");
  const minorIssues = merged.filter((i) => i.severity === "minor");

  await input.onProgress?.("Topic summary…");
  let topicSummary = "";
  try {
    const sum = await runTopicSummary({
      topic: input.topic,
      majorIssues,
    });
    topicSummary = sum.summary;
    inputTokens += sum.usage.inputTokens;
    outputTokens += sum.usage.outputTokens;
  } catch {
    topicSummary =
      majorIssues.length > 0
        ? `${majorIssues.length} major and ${minorIssues.length} minor visual issues found.`
        : "Review complete — no major issues.";
  }

  const repairEstimate = estimateRepairs(merged);

  return {
    version: 1,
    scannedAt: new Date().toISOString(),
    topic: input.topic,
    scanned: withImages.length,
    majorCount: majorIssues.length,
    minorCount: minorIssues.length,
    ok: withImages.length - merged.length,
    topicSummary,
    majorIssues: merged,
    repairEstimate,
    usage: { inputTokens, outputTokens },
    scanCostUsd: costFromUsage(inputTokens, outputTokens),
    model,
  };
}
