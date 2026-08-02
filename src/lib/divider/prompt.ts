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
STEP B — GOOGLE vs AI (GOOGLE-FIRST PRECEDENT)
────────────────────────────────
DEFAULT: Prefer GOOGLE whenever a real photograph of the subject can exist.
Do NOT jump to AI because a beat feels “emotional” or “hard to film”.
Scan carefully: if Google can return a truthful documentary photo → GOOGLE.

HARD RULES (never break):
1) Named REAL person / place / event / film / podcast / org → MUST be GOOGLE.
   Examples: Mel Gibson, Jesus Christ, Joe Rogan, The Passion of the Christ,
   The Resurrection of the Christ, Randall Wallace, Vatican, Jerusalem, Golgotha.
2) Photographable physical subjects → MUST be GOOGLE even without a proper name:
   tombs, rolling-stone graves, caves, churches, manuscripts, icons, frescoes,
   maps, film sets, podcast studios, archaeological sites, Jerusalem locations.
   Example: “sealed stone tomb” → Google “ancient rolling stone tomb jerusalem”
   NOT AI reconstruction.
3) NEVER invent AI photos of real named people/films/places.

AI ONLY when ALL of these are true:
- no named real entity in the beat, AND
- no physical place/object a camera could document, AND
- the beat is purely abstract (emotion, unseen spiritual claim, metaphor with
  no concrete stand-in).

NO forced Google/AI percentage. Prefer Google whenever a real photo can exist.
More Google is better. Budget: ≤125 Google queries · ≤100 AI stills (pack 2 scenes/query).
AI is last resort only — never strip Google to hit a ratio.

A) GOOGLE — authentic real-world photos (default):
- people, places, films, events, tombs, sites, manuscripts, news, studios

B) AI GENERATE — last resort only:
- pure abstraction with no honest real stand-in photo
- NEVER use AI for tombs/places “because the exact biblical tomb is unknown”
  — use a real ancient Jerusalem / rock-cut tomb photo instead

────────────────────────────────
STEP C — GOOGLE QUERY RULES
────────────────────────────────
- SHORT direct queries: 2–4 words, entity-first. No long negative keyword lists.
- Prefer relatedBeatIds length 2 for back-to-back / same-subject beats
  (ONE Google query → TWO scenes). Required on large films (~350–400 beats).
- HARD BUDGET for a full film: ≤125 Google queries · ≤100 AI stills.
  Pack beats onto shared queries; reuse visuals for consecutive scenes when it makes sense.
- No duplicate exact queries in this batch
- If the beat is about ONE real person, the query MUST name that person
  (e.g. "mel gibson", "joe rogan") — never a vague theme.
- Never aim for posters, thumbnails, memes, quote cards, or logo graphics.

Good: mel gibson interview | joe rogan podcast | dead sea scrolls museum
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

HARD BAN for AI visualIdea (never use these lazy props):
- vacant / empty interview chairs, armchairs, empty seats
- tabletop audio recorders, printed notes “between takes”, empty studio sets
- people, faces, couples, weddings, tourists in place/object beats
For abstract “serious / tension / pause” beats: use a real environmental still
(place, weather, archive, landscape) — or better, assign GOOGLE to the named
person in the film looking serious. Never an empty chair.
For places (Lake Tahoe, parks, underwater): GOOGLE empty landscape / ROV gear only —
never wedding or people stock. AI underwater stills = dark silt, ROV lights, no humans.

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

  const largeFilm =
    (opts?.totalBeats || sceneCount) >= 280
      ? ` LARGE FILM (~${opts?.totalBeats || sceneCount} beats): pack relatedBeatIds=2 (one query → two scenes). Stay under 125 Google queries / 100 AI for the whole film.`
      : "";

  const phaseNote =
    phase === "google-first"
      ? `PHASE: assign Google vs AI for every beat in this batch.
Every beatId must appear exactly once across googleSearches + aiGenerate.
NO % quota — use Google for every beat that has a real photographable subject.
Prefer relatedBeatIds of 2 for back-to-back similar beats. Short 2–4 word queries.
AI only when there is truly no honest real photo. More Google is better.${largeFilm}`
      : `Produce Google + AI for every beat. Prefer Google; pack 2 scenes/query when it fits.${largeFilm}`;

  return `${phaseNote}

${batchNote}

SELECTED NICHE: ${niche.label} ${niche.version}
${niche.promptGuide}

This batch: ${sceneCount} beats · ~${minutes.toFixed(2)} min @ ${niche.wpm} WPM
Film budget: ≤125 Google queries · ≤100 AI stills. Pack/reuse consecutive scenes.
Prefer Google. Short direct queries. Google-first: tombs/places/people/films/manuscripts.

BEATS:
${beatBlock}

Return JSON only. Use only beatIds from the list above. Every listed beatId must appear exactly once.`;
}
