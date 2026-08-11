export type NicheId = "mystery" | "celebrity";

export type Niche = {
  id: NicheId;
  label: string;
  version: string;
  description: string;
  /** Locked narration rate for VO timing when Whisper timestamps are absent. */
  wpm: number;
  promptGuide: string;
};

export const NICHES: Niche[] = [
  {
    id: "mystery",
    label: "Mystery",
    version: "v1",
    description:
      "Clean documentary evidence — maps, artifacts, archives, places, soft investigative tone. AI stills use Mystery realism (gpt-image-2).",
    wpm: 160,
    promptGuide: `NICHE: Mystery documentary (YouTube).
VO locked at 160 WPM (≈2.67 words/sec). Use that rate for scene timing when Whisper timestamps are missing.
Prefer authentic evidence-style visuals when real photos exist: maps, manuscripts, archaeological finds, named places, archives, news stills, scientific fieldwork.
Use AI for reconstructions, unrecorded ancient moments, speculative/prophetic ideas, impossible camera views, and conceptual tension — never fake “proof” photos.
AI stills will be generated with the locked Mystery realism recipe (field/archive/lab photographic look, slight grain/haze, no glossy CGI).
Queries should feel investigative and entity-first, not sensational filler words like mystery/secret/shocking.`,
  },
  {
    id: "celebrity",
    label: "Celebrity",
    version: "v1-exp",
    description:
      "EXPERIMENT — Google Images only. Entity-locked celebrity docs at 130 WPM. Calm ~4–7s scenes from the script (never cut mid-sentence). Does not change Mystery.",
    wpm: 130,
    promptGuide: `NICHE: Celebrity documentary (EXPERIMENT — Google Images ONLY).
VO locked at 130 WPM (≈2.17 words/sec). Scene lengths come from the spoken line (~4–7s calm cuts). Never invent AI stills.

ENTITY LOCK (hard):
- Search the person / place / object named in THAT line — not a vague theme.
- Marilyn Monroe line → marilyn monroe photo (vary angle/era for consecutive Marilyn lines: portrait, blonde, red dress, 1962, etc.).
- “Frank Sinatra’s daughter” / Tina Sinatra → tina sinatra.
- Her father / Frank → frank sinatra.
- John Kennedy / JFK → john f kennedy.
- Robert Kennedy / RFK → robert kennedy.
- Peter Lawford → peter lawford.
- Tony Oppedisano → tony oppedisano.
- Elvis mentions → elvis presley (with Marilyn only when BOTH are named).
- Old Hollywood → classic hollywood glam / 1950s hollywood (not modern celebs).
- Lake Tahoe → lake tahoe.
- Cal Neva Lodge / Cal-Neva → cal neva lodge.
- Brentwood home / August 4 1962 → marilyn monroe brentwood house / 1962 news still.
- Nembutal / barbiturate / pills → period medicine bottles / archival pills still (no gore).
- Autopsy / toxicology → archival medical report style photo only if clean; else period newsroom/archive.

MULTI-NAME LINES:
- Prefer one primary face that the sentence is about.
- If the line lists several people as a set (Sinatra + Monroe + Kennedy + Lawford), you MAY use a real period group photo query — never ask for a generated split-screen.

QUERY STYLE:
- Short 2–5 word entity-first Google queries.
- Prefer real photos, press stills, portraits, places — never memes, quote cards, thumbnails, or logo graphics.
- Consecutive same-entity beats should still get Google coverage (pack relatedBeatIds=2 only when the SAME entity continues).`,
  },
];

export const DEFAULT_NICHE: NicheId = "mystery";

export function getNiche(id?: string | null): Niche {
  return NICHES.find((n) => n.id === id) ?? NICHES[0];
}

export function isValidNiche(id?: string | null): id is NicheId {
  return Boolean(id && NICHES.some((n) => n.id === id));
}

/** Words per second for a niche (Mystery = 160/60 ≈ 2.67). */
export function nicheWordsPerSecond(id?: string | null): number {
  return getNiche(id).wpm / 60;
}

/** Duration in seconds from word count at niche WPM. */
export function durationSecFromWords(
  wordCount: number,
  nicheId?: string | null,
): number {
  const wps = nicheWordsPerSecond(nicheId);
  return wordCount / wps;
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
