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
STEP B — GOOGLE vs AI
────────────────────────────────
HARD RULE (never break):
If a beat names a REAL person, place, event, movie/film/TV/podcast title,
organization, or other searchable proper noun → MUST be GOOGLE.
Examples: Mel Gibson, Jesus Christ, Joe Rogan, The Passion of the Christ,
The Resurrection of the Christ, Randall Wallace, Vatican, Jerusalem, Golgotha.
Never assign those beats to AI. Write a tight entity-first Google query instead.

Among the REMAINING abstract / conceptual / unrecorded beats only:
- Prefer AI for emotion, unseen spiritual battle, speculative interiors, metaphor
- Soft target overall ~50/50 Google/AI, but NEVER move a named-real beat to AI
  to hit the ratio. Named-real always wins over the ratio.

A) GOOGLE — authentic real-world photos:
- named people, places, films, shows, events, news photos
- maps, satellite, manuscripts, scientific fieldwork

B) AI GENERATE — only when no truthful real photo should exist:
- unrecorded private moments, conceptual tension, unseen spiritual imagery
- impossible camera views, speculative reconstructions
- NEVER invent a fake photo of a real named person/film/place

────────────────────────────────
STEP C — GOOGLE QUERY RULES
────────────────────────────────
- 2–4 words (prefer 2–3), entity-first
- searchable photo language, no filler
- Prefer ONE google pack PER google beat (relatedBeatIds length 1)
- Only share a pack across 2 beats when they are the exact same visual subject
- No duplicate exact queries in this batch
- If the beat is about ONE real person, the query MUST name that person
  (e.g. "mel gibson", "joe rogan", "jesus christ") — never a vague theme.
  Prefer a single-subject photo intent (portrait / interview still), not cast/group.
- Never aim for posters, thumbnails, memes, quote cards, logos, or text overlays.

Good: mel gibson interview | joe rogan podcast | passion of the christ set
Bad: something was moving beneath the dead landscape | raising eyebrows meme

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
Soft target for THIS batch: ~${targetGoogle} Google · ~${targetAi} AI —
but named real people/places/events/movies MUST be Google even if that shifts the mix.

BEATS:
${beatBlock}

Return JSON only. Use only beatIds from the list above. Every listed beatId must appear exactly once.`;
}
