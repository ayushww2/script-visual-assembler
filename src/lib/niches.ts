export type NicheId = "mystery";

export type Niche = {
  id: NicheId;
  label: string;
  version: string;
  description: string;
  promptGuide: string;
};

export const NICHES: Niche[] = [
  {
    id: "mystery",
    label: "Mystery",
    version: "v1",
    description:
      "Clean documentary evidence — maps, artifacts, archives, places, soft investigative tone.",
    promptGuide: `NICHE: Mystery documentary (YouTube).
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
