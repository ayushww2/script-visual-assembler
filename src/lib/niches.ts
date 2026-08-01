export type NicheId = "mystery";

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
      "Clean documentary evidence — maps, artifacts, archives, places, soft investigative tone.",
    wpm: 160,
    promptGuide: `NICHE: Mystery documentary (YouTube).
VO locked at 160 WPM (≈2.67 words/sec). Use that rate for scene timing when Whisper timestamps are missing.
Prefer authentic evidence-style visuals when real photos exist: maps, manuscripts, archaeological finds, named places, archives, news stills, scientific fieldwork.
Use AI for reconstructions, unrecorded ancient moments, speculative/prophetic ideas, impossible camera views, and conceptual tension — never fake “proof” photos.
Queries should feel investigative and entity-first, not sensational filler words like mystery/secret/shocking.`,
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
