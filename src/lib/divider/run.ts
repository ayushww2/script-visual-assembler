import { createContactBoxClient, getContactBoxConfig } from "@/lib/contactbox";
import { parseBeats } from "./beats";
import { buildDirectorUserPrompt, DIRECTOR_SYSTEM_PROMPT } from "./prompt";
import {
  dividerResultSchema,
  type Beat,
  type DividerResult,
} from "./schema";
import { DIRECTOR_BATCH_CONCURRENCY } from "@/lib/jobs/limits";
import { forceNamedEntitiesToGoogle } from "@/lib/divider/namedEntity";
import { forceGoogleFirstSubjects } from "@/lib/divider/googleFirst";
import { applyVisualBudget } from "@/lib/divider/budget";
import { forceAllBeatsToGoogle } from "@/lib/divider/googleOnly";
import { getNiche } from "@/lib/niches";

const DIRECTOR_BATCH_SIZE = 40;

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON");
  }
}

async function runDirectorBatch(input: {
  beats: Beat[];
  phase: "google-first" | "full" | "google-only";
  niche?: string | null;
  batchIndex: number;
  batchCount: number;
  totalBeats: number;
}): Promise<{
  result: DividerResult;
  usage?: { inputTokens?: number; outputTokens?: number };
  model: string;
}> {
  const { model } = getContactBoxConfig();
  const client = createContactBoxClient();
  const userPrompt = buildDirectorUserPrompt(
    input.beats,
    input.phase === "google-only" ? "google-only" : input.phase,
    input.niche,
    {
      batchIndex: input.batchIndex,
      batchCount: input.batchCount,
      totalBeats: input.totalBeats,
    },
  );

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: DIRECTOR_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Empty model response");

  const parsed = dividerResultSchema.parse(extractJson(content));
  return {
    result: parsed,
    model,
    usage: {
      inputTokens: completion.usage?.prompt_tokens,
      outputTokens: completion.usage?.completion_tokens,
    },
  };
}

export async function runScriptDivider(input: {
  script: string;
  phase?: "google-first" | "full" | "ai-only" | "google-only";
  niche?: string | null;
}): Promise<{
  beats: Beat[];
  result: DividerResult;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}> {
  const niche = getNiche(input.niche);
  const beats = parseBeats(input.script, {
    nicheId: niche.id,
    wpm: niche.wpm,
  });
  if (beats.length < 1) {
    throw new Error("No beats found. Paste a script or Whisper JSON.");
  }

  // Celebrity experiment defaults to Google-only unless explicitly all-AI.
  const phase =
    input.phase === "ai-only"
      ? "ai-only"
      : input.phase === "google-only" || niche.id === "celebrity"
        ? "google-only"
        : (input.phase ?? "google-first");

  // All-AI mode: skip director Google packs — every beat is an AI still.
  if (phase === "ai-only") {
    return {
      beats,
      result: {
        googleSearches: [],
        aiGenerate: beats.map((beat) => ({
          subject:
            beat.text.split(/\s+/).filter(Boolean).slice(0, 6).join(" ") ||
            "scene",
          visualIdea: `documentary realism evidence still for: ${beat.text}`,
          whyAiNotGoogle: "all-AI mode",
          relatedBeatIds: [beat.id],
          priority: 80,
        })),
      },
      model: "all-ai",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const batches: Beat[][] = [];
  for (let i = 0; i < beats.length; i += DIRECTOR_BATCH_SIZE) {
    batches.push(beats.slice(i, i + DIRECTOR_BATCH_SIZE));
  }

  const merged: DividerResult = { googleSearches: [], aiGenerate: [] };
  let model = getContactBoxConfig().model;
  let inputTokens = 0;
  let outputTokens = 0;

  const dirConcurrency = Math.max(1, DIRECTOR_BATCH_CONCURRENCY);
  const directorPhase: "google-first" | "full" | "google-only" =
    phase === "google-only"
      ? "google-only"
      : phase === "full"
        ? "full"
        : "google-first";

  for (let i = 0; i < batches.length; i += dirConcurrency) {
    const slice = batches.slice(i, i + dirConcurrency);
    const results = await Promise.all(
      slice.map((batchBeats, offset) =>
        runDirectorBatch({
          beats: batchBeats,
          phase: directorPhase,
          niche: input.niche,
          batchIndex: i + offset,
          batchCount: batches.length,
          totalBeats: beats.length,
        }),
      ),
    );
    for (const batch of results) {
      merged.googleSearches.push(...batch.result.googleSearches);
      merged.aiGenerate.push(...batch.result.aiGenerate);
      model = batch.model;
      inputTokens += batch.usage?.inputTokens || 0;
      outputTokens += batch.usage?.outputTokens || 0;
    }
  }

  // Soft-dedupe exact Google queries but KEEP the first pack's relatedBeatIds
  // and merge beat ids when the same query repeats across batches.
  const byQuery = new Map<string, (typeof merged.googleSearches)[number]>();
  for (const pack of merged.googleSearches) {
    const key = pack.query.trim().toLowerCase();
    const existing = byQuery.get(key);
    if (!existing) {
      byQuery.set(key, { ...pack, relatedBeatIds: [...pack.relatedBeatIds] });
      continue;
    }
    const ids = new Set([
      ...existing.relatedBeatIds,
      ...pack.relatedBeatIds,
    ]);
    existing.relatedBeatIds = Array.from(ids);
    if (pack.priority > existing.priority) existing.priority = pack.priority;
  }
  merged.googleSearches = Array.from(byQuery.values());

  // Ensure every beat is covered: missing → AI placeholder (or Google later)
  const covered = new Set<string>();
  for (const pack of merged.googleSearches) {
    for (const id of pack.relatedBeatIds) covered.add(id);
  }
  for (const item of merged.aiGenerate) {
    for (const id of item.relatedBeatIds) covered.add(id);
  }
  for (const beat of beats) {
    if (covered.has(beat.id)) continue;
    merged.aiGenerate.push({
      subject: beat.text.split(/\s+/).slice(0, 4).join(" ") || "scene",
      visualIdea: `documentary realism evidence still for: ${beat.text}`,
      whyAiNotGoogle: "director batch left beat uncovered",
      relatedBeatIds: [beat.id],
      priority: 50,
    });
  }

  // Named people / places / events / films / shows → Google only
  const named = forceNamedEntitiesToGoogle(beats, merged);
  // Photographable places/objects (tombs, sites, etc.) → Google-first, not AI
  const enforced = forceGoogleFirstSubjects(beats, named);

  // Celebrity wants denser unique stills (≥300 on long films) — allow more
  // Google queries and pack less aggressively. Mystery keeps default caps.
  const budgetOpts =
    niche.id === "celebrity" || phase === "google-only"
      ? { maxGoogle: 320, maxAi: 0, perQuery: 1 }
      : undefined;

  let budgeted = applyVisualBudget(beats, enforced, budgetOpts);

  // Celebrity / google-only: strip every AI assignment → Google packs
  if (phase === "google-only") {
    budgeted = forceAllBeatsToGoogle(beats, budgeted);
    budgeted = applyVisualBudget(
      beats,
      {
        googleSearches: budgeted.googleSearches,
        aiGenerate: [],
      },
      budgetOpts,
    );
    budgeted = forceAllBeatsToGoogle(beats, budgeted);
  }

  return {
    beats,
    result: budgeted,
    model,
    usage: { inputTokens, outputTokens },
  };
}
