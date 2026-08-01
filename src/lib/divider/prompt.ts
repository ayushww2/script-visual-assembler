import type { Beat } from "./schema";
import { estimateDurationMinutes } from "./beats";
import { getNiche } from "@/lib/niches";

export const DIRECTOR_SYSTEM_PROMPT = `You are the DOCUMENTARY DIRECTOR for images-only YouTube documentary films.

Your only job:
1) Decide which beats get GOOGLE IMAGE SEARCH vs AI-GENERATED stills
2) Write Google search queries for Google beats
3) Write AI visualIdea prompts for AI beats

Do NOT write camera directions, layouts, transitions, or full scene art direction.
Every beatId in the batch MUST appear in exactly ONE of: googleSearches.relatedBeatIds OR aiGenerate.relatedBeatIds.

────────────────────────────────
STEP A — UNDERSTAND BEFORE SEARCHING
────────────────────────────────
For each beat/line, identify:
- main subject (person / place / object / process / idea)
- whether a real photo likely exists

Do not search the exact spoken sentence.
Search the underlying visual subject.

────────────────────────────────
STEP B — GOOGLE vs AI (50 / 50)
────────────────────────────────
Target EXACTLY ~50% Google and ~50% AI for this batch of beats (within ±2 beats).

A) GOOGLE — when authentic real-world photos likely exist:
- specific people, named places, wildlife, news photos
- maps, satellite, manuscripts, scientific fieldwork
- Yellowstone / wolves / hunting / known historical events

B) AI GENERATE — when Google cannot give a truthful enough still:
- unrecorded moments, conceptual tension (law, fear, legacy)
- impossible camera views, speculative reconstructions
- anything that would force a misleading “fake real” stock photo

Prefer Google for concrete real entities.
Prefer AI for abstract/policy/emotion beats.

────────────────────────────────
STEP C — GOOGLE QUERY RULES
────────────────────────────────
- 2–4 words (prefer 2–3), entity-first
- searchable photo language, no filler
- Prefer ONE google pack PER google beat (relatedBeatIds length 1)
- Only share a pack across 2 beats when they are the exact same visual subject
- No duplicate exact queries in this batch

Good: yellowstone wolves release | junction butte pack | wolf hunting montana
Bad: something was moving beneath the dead landscape

────────────────────────────────
STEP D — AI STILL RULES
────────────────────────────────
For each AI item:
- subject (2–5 words)
- visualIdea (one documentary realism still idea)
- whyAiNotGoogle
- relatedBeatIds (prefer one beat each)

AI must look real, documentary, naturally imperfect — never fantasy glow / proof-fake.

────────────────────────────────
OUTPUT JSON ONLY
────────────────────────────────
{
  "googleSearches": [
    {
      "query": "yellowstone wolves release",
      "entityContext": "1995 Yellowstone wolf reintroduction",
      "whyGoogle": "real historical event with authentic photos",
      "relatedBeatIds": ["b12"],
      "priority": 80,
      "alternateQueries": ["yellowstone wolf reintroduction"]
    }
  ],
  "aiGenerate": [
    {
      "subject": "policy fear tension",
      "visualIdea": "documentary realism of a rural night road near a park boundary under overcast light",
      "whyAiNotGoogle": "conceptual tension not a single searchable news still",
      "relatedBeatIds": ["b44"],
      "priority": 70
    }
  ]
}`;

export function buildDirectorUserPrompt(
  beats: Beat[],
  phase: "google-first" | "full" = "google-first",
  nicheId?: string | null,
  opts?: { batchIndex?: number; batchCount?: number; totalBeats?: number },
): string {
  const niche = getNiche(nicheId);
  const minutes = estimateDurationMinutes(beats, niche.wpm);
  const sceneCount = beats.length;
  const targetGoogle = Math.floor(sceneCount / 2);
  const targetAi = sceneCount - targetGoogle;

  const beatBlock = beats
    .map((b) => {
      const timing =
        typeof b.start === "number" && typeof b.end === "number"
          ? ` [${b.start.toFixed(2)}s–${b.end.toFixed(2)}s]`
          : "";
      return `${b.id}${timing}: ${b.text}`;
    })
    .join("\n");

  const batchNote =
    opts?.batchCount && opts.batchCount > 1
      ? `BATCH ${((opts.batchIndex ?? 0) + 1)}/${opts.batchCount} of a ~${opts.totalBeats}-beat film. Cover ONLY the beats listed below.`
      : `Full film batch.`;

  const phaseNote =
    phase === "google-first"
      ? `PHASE: assign Google vs AI for every beat in this batch.
Every beatId must appear exactly once across googleSearches + aiGenerate.
Target ~${targetGoogle} Google and ~${targetAi} AI for THIS batch.`
      : `Produce the full Google + AI mix for every beat.`;

  return `${phaseNote}

${batchNote}

SELECTED NICHE: ${niche.label} ${niche.version}
${niche.promptGuide}

This batch: ${sceneCount} beats · ~${minutes.toFixed(2)} min @ ${niche.wpm} WPM
Target split for THIS batch: ~${targetGoogle} Google · ~${targetAi} AI (50/50)

BEATS:
${beatBlock}

Return JSON only. Use only beatIds from the list above. Every listed beatId must appear exactly once.`;
}
