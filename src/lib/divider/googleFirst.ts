/**
 * Google-first precedent: if a real photo of the subject can exist, use Google.
 * AI only for truly unphotographable / purely abstract beats.
 */

import type { Beat, DividerResult } from "./schema";
import { queryFromNamedBeat } from "./namedEntity";

/** Strong physical / documentary subjects that almost always have real photos. */
const GOOGLEABLE =
  /\b(tomb|tombs|grave|graves|sepulchre|sepulcher|rolling stone|limestone tomb|cave|burial chamber|stone chamber|jerusalem|golgotha|calvary|vatican|church|cathedral|manuscript|scroll|gospel book|bible manuscript|icon|mosaic|fresco|archaeolog(?:y|ical)|excavation|ruins|mount of olives|garden tomb|holy sepulchre|podcast studio|joe rogan|film set|movie set|premiere|red carpet|satellite map|roman soldier|roman guard|earthquake|temple curtain|golgotha|calvary)\b/i;

const PURE_ABSTRACT =
  /\b(tension|fear|legacy|belief|claim|serious|eyebrow|mystery|unseen battle|spiritual conflict|emotional|harder to film|deeper, darker|raising eyebrows)\b/i;

export function beatLooksGoogleable(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return GOOGLEABLE.test(t);
}

export function beatLooksPurelyAbstract(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (beatLooksGoogleable(t)) return false;
  return PURE_ABSTRACT.test(t) && !/\b[A-Z][a-z]+ [A-Z]/.test(t);
}

export function queryForGoogleableBeat(text: string): string {
  const lower = text.toLowerCase();
  if (/\btomb\b/.test(lower) && /\b(seal|stone|round|rolling|closed)\b/.test(lower)) {
    return "ancient rolling stone tomb jerusalem";
  }
  if (/\btomb\b/.test(lower) && /\b(interior|chamber|inside|dark|burial)\b/.test(lower)) {
    return "ancient rock cut tomb interior jerusalem";
  }
  if (/\btomb\b/.test(lower) || /\bgrave\b/.test(lower)) {
    return "ancient jewish rock cut tomb jerusalem";
  }
  if (/\bgolgotha\b/.test(lower)) return "golgotha jerusalem";
  if (/\bcalvary\b/.test(lower)) return "calvary jerusalem";
  if (/\bvatican\b/.test(lower)) return "vatican";
  if (/\bmanuscript\b|\bgospel book\b|\bbible manuscript\b/.test(lower)) {
    return "ancient gospel manuscript";
  }
  if (/\broman (soldier|guard)\b/.test(lower)) return "roman soldier ancient";
  if (/\bpodcast\b|\brogan\b/.test(lower)) return "joe rogan experience studio";
  if (/\bearthquake\b/.test(lower)) return "jerusalem earthquake ruins";
  return queryFromNamedBeat(text) || text.split(/\s+/).slice(0, 4).join(" ").toLowerCase();
}

/**
 * After director: move googleable AI beats onto Google packs.
 * Scans spoken beat + AI subject/visualIdea so “tomb tension” prompts
 * cannot hide behind abstract narration.
 */
export function forceGoogleFirstSubjects(
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
      if (!beat || googleIds.has(id)) {
        keep.push(id);
        continue;
      }
      const scan = [beat.text, item.subject, item.visualIdea]
        .filter(Boolean)
        .join(" ");
      // Force Google when a real photo class clearly exists in beat or AI idea.
      if (!beatLooksGoogleable(scan)) {
        keep.push(id);
        continue;
      }
      const query = queryForGoogleableBeat(scan);
      result.googleSearches.push({
        query,
        entityContext: beat.text.slice(0, 160),
        whyGoogle:
          "Google-first: real photographable subject (place/object/site) exists",
        relatedBeatIds: [id],
        priority: 85,
        alternateQueries: [],
      });
      googleIds.add(id);
    }
    if (keep.length) nextAi.push({ ...item, relatedBeatIds: keep });
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
