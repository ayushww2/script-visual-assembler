import type { Beat, DividerResult } from "./schema";
import { queryFromNamedBeat } from "./namedEntity";

/**
 * Convert every AI / uncovered beat into a Google pack.
 * Used by celebrity google-only experiments — never invent AI stills.
 */
export function forceAllBeatsToGoogle(
  beats: Beat[],
  result: DividerResult,
): DividerResult {
  const google = result.googleSearches.map((p) => ({
    ...p,
    relatedBeatIds: [...p.relatedBeatIds],
  }));
  const covered = new Set<string>();
  for (const pack of google) {
    for (const id of pack.relatedBeatIds) covered.add(id);
  }

  for (const item of result.aiGenerate) {
    for (const id of item.relatedBeatIds) {
      if (covered.has(id)) continue;
      const beat = beats.find((b) => b.id === id);
      const query = (
        item.subject ||
        (beat ? queryFromNamedBeat(beat.text) : "") ||
        "documentary still"
      )
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 5)
        .join(" ");
      google.push({
        query,
        entityContext: beat?.text.slice(0, 160) || item.visualIdea,
        whyGoogle: "google-only mode — no AI stills",
        relatedBeatIds: [id],
        priority: Math.max(60, item.priority || 60),
        alternateQueries: [],
      });
      covered.add(id);
    }
  }

  for (const beat of beats) {
    if (covered.has(beat.id)) continue;
    google.push({
      query: queryFromNamedBeat(beat.text),
      entityContext: beat.text.slice(0, 160),
      whyGoogle: "google-only mode — uncovered beat",
      relatedBeatIds: [beat.id],
      priority: 55,
      alternateQueries: [],
    });
    covered.add(beat.id);
  }

  const byQuery = new Map<string, (typeof google)[number]>();
  for (const pack of google) {
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
    aiGenerate: [],
  };
}
