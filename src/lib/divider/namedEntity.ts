/**
 * Detect beats that name real-world people, places, events, films, shows, etc.
 * Those must use Google images (best ranked hit), never AI stills.
 */

import type { Beat, DividerResult } from "./schema";

const KNOWN_TITLES = [
  "the passion of the christ",
  "the resurrection of the christ",
  "the joe rogan experience",
  "joe rogan",
  "mel gibson",
  "jesus christ",
  "jesus of nazareth",
  "passion of the christ",
  "resurrection of the christ",
  "randall wallace",
  "governor pontius pilate",
  "pontius pilate",
  "vatican",
  "golgotha",
  "calvary",
  "jerusalem",
  "governor caesar",
];

/** Proper-noun-ish spans: Mel Gibson, Joe Rogan, Vatican City, etc. */
const PROPER_SPAN =
  /\b([A-Z][a-z]+(?:\s+(?:of|the|and|de|da|van|von|le|la))?[\s-]+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)\b/g;

const SINGLE_FAMOUS =
  /\b(Jesus|Christ|Gibson|Rogan|Vatican|Jerusalem|Golgotha|Calvary|Pilate)\b/;

export function beatLooksLikeNamedRealWorld(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  const lower = t.toLowerCase();

  if (KNOWN_TITLES.some((k) => lower.includes(k))) return true;

  const spans = t.match(PROPER_SPAN);
  if (spans && spans.length > 0) {
    const strong = spans.filter((s) => s.split(/\s+/).length >= 2);
    if (strong.length > 0) return true;
  }

  if (SINGLE_FAMOUS.test(t)) return true;

  return false;
}

/**
 * After the director runs: any named real-world beat stuck on AI
 * is forced onto a Google pack (best image later). Soft 50/50 never
 * overrides this.
 */
export function forceNamedEntitiesToGoogle(
  beats: Beat[],
  result: DividerResult,
): DividerResult {
  const byId = new Map(beats.map((b) => [b.id, b]));
  const googleIds = new Set<string>();
  for (const pack of result.googleSearches) {
    for (const id of pack.relatedBeatIds) googleIds.add(id);
  }

  const nextAi = [];
  for (const item of result.aiGenerate) {
    const keep: string[] = [];
    for (const id of item.relatedBeatIds) {
      const beat = byId.get(id);
      if (
        !beat ||
        !beatLooksLikeNamedRealWorld(beat.text) ||
        googleIds.has(id)
      ) {
        keep.push(id);
        continue;
      }
      const query = queryFromNamedBeat(beat.text);
      result.googleSearches.push({
        query,
        entityContext: beat.text.slice(0, 160),
        whyGoogle: "named real person/place/event/film — Google only",
        relatedBeatIds: [id],
        priority: 95,
        alternateQueries: [],
      });
      googleIds.add(id);
    }
    if (keep.length) {
      nextAi.push({ ...item, relatedBeatIds: keep });
    }
  }

  const byQuery = new Map<string, (typeof result.googleSearches)[number]>();
  for (const pack of result.googleSearches) {
    const key = pack.query.trim().toLowerCase();
    const existing = byQuery.get(key);
    if (!existing) {
      byQuery.set(key, { ...pack, relatedBeatIds: [...pack.relatedBeatIds] });
      continue;
    }
    existing.relatedBeatIds = Array.from(
      new Set([...existing.relatedBeatIds, ...pack.relatedBeatIds]),
    );
    if (pack.priority > existing.priority) existing.priority = pack.priority;
  }

  return {
    googleSearches: Array.from(byQuery.values()),
    aiGenerate: nextAi,
  };
}

/** Build a short Google query from named entities in the beat. */
export function queryFromNamedBeat(text: string): string {
  const t = (text || "").trim();
  const lower = t.toLowerCase();

  // Longest known title first
  const known = [...KNOWN_TITLES].sort((a, b) => b.length - a.length);
  for (const title of known) {
    if (lower.includes(title)) return title;
  }

  const spans = [...t.matchAll(new RegExp(PROPER_SPAN.source, "g"))].map(
    (m) => m[1],
  );
  if (spans.length) {
    const best = spans.sort((a, b) => b.length - a.length)[0];
    return best.toLowerCase();
  }

  if (/\bJesus\b/i.test(t)) return "jesus christ";
  if (/\bGibson\b/i.test(t)) return "mel gibson";
  if (/\bRogan\b/i.test(t)) return "joe rogan experience";

  return t
    .replace(/[^\w\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ")
    .toLowerCase();
}
