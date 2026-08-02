import type { Beat, DividerResult } from "./schema";

/** Per-job caps (override via env). */
export const MAX_GOOGLE_QUERIES_PER_JOB = Math.max(
  1,
  Number(process.env.MAX_GOOGLE_QUERIES_PER_JOB || 125) || 125,
);
export const MAX_AI_STILLS_PER_JOB = Math.max(
  0,
  Number(process.env.MAX_AI_STILLS_PER_JOB || 100) || 100,
);
/** Pack this many beats onto one Google query when subjects align / large films. */
export const GOOGLE_BEATS_PER_QUERY = Math.max(
  1,
  Number(process.env.GOOGLE_BEATS_PER_QUERY || 2) || 2,
);

type GooglePack = DividerResult["googleSearches"][number];
type AiItem = DividerResult["aiGenerate"][number];

function uniqIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function beatNum(id: string): number {
  const m = /^b(\d+)$/i.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Cap Google queries (≤125) and AI stills (≤100).
 * Prefer ~2 beats per Google query (esp. 350–400 scene films).
 * Overflow beats reuse Google packs (same still) rather than more AI/queries.
 */
export function applyVisualBudget(
  beats: Beat[],
  result: DividerResult,
): DividerResult {
  const maxGoogle = MAX_GOOGLE_QUERIES_PER_JOB;
  const maxAi = MAX_AI_STILLS_PER_JOB;
  const perQuery = GOOGLE_BEATS_PER_QUERY;

  let google = result.googleSearches.map((p) => ({
    ...p,
    relatedBeatIds: uniqIds(p.relatedBeatIds).sort(
      (a, b) => beatNum(a) - beatNum(b),
    ),
  }));
  let ai = result.aiGenerate.map((a) => ({
    ...a,
    relatedBeatIds: uniqIds(a.relatedBeatIds),
  }));

  // Large films: force pairing adjacent singleton Google packs
  if (beats.length >= 280 || google.length > maxGoogle) {
    google = packAdjacentGoogleBeats(google, perQuery);
  } else {
    google = packAdjacentGoogleBeats(google, perQuery);
  }

  // Cap Google query count
  if (google.length > maxGoogle) {
    google = google
      .slice()
      .sort((a, b) => b.priority - a.priority || a.query.localeCompare(b.query));
    const keep = google.slice(0, maxGoogle);
    const drop = google.slice(maxGoogle);
    let i = 0;
    for (const pack of drop) {
      const target = keep[i % keep.length];
      target.relatedBeatIds = uniqIds([
        ...target.relatedBeatIds,
        ...pack.relatedBeatIds,
      ]).sort((a, b) => beatNum(a) - beatNum(b));
      i += 1;
    }
    google = keep;
  }

  // Cap AI stills — overflow onto Google packs (reuse)
  const aiBeatIds: string[] = [];
  for (const item of ai) aiBeatIds.push(...item.relatedBeatIds);
  if (aiBeatIds.length > maxAi) {
    const keepIds = new Set(aiBeatIds.slice(0, maxAi));
    const overflow = aiBeatIds.filter((id) => !keepIds.has(id));
    ai = redistributeAi(ai, keepIds);
    if (overflow.length && google.length) {
      let i = 0;
      for (const id of overflow) {
        const target = google[i % google.length];
        target.relatedBeatIds = uniqIds([...target.relatedBeatIds, id]);
        i += 1;
      }
    } else if (overflow.length && ai.length) {
      ai[0].relatedBeatIds = uniqIds([...ai[0].relatedBeatIds, ...overflow]);
      const flat: string[] = [];
      for (const item of ai) flat.push(...item.relatedBeatIds);
      if (flat.length > maxAi) {
        ai = redistributeAi(ai, new Set(flat.slice(0, maxAi)));
      }
    }
  }

  // Cover every beat
  const covered = new Set<string>();
  for (const p of google) for (const id of p.relatedBeatIds) covered.add(id);
  for (const a of ai) for (const id of a.relatedBeatIds) covered.add(id);
  const missing = beats.filter((b) => !covered.has(b.id)).map((b) => b.id);
  if (missing.length) {
    if (google.length) {
      let i = 0;
      for (const id of missing) {
        google[i % google.length].relatedBeatIds = uniqIds([
          ...google[i % google.length].relatedBeatIds,
          id,
        ]);
        i += 1;
      }
    } else {
      const room = Math.max(0, maxAi - countAiBeats(ai));
      const toAi = missing.slice(0, room);
      const rest = missing.slice(room);
      if (toAi.length) {
        ai.push({
          subject: "uncovered beat",
          visualIdea: "documentary realism evidence still",
          whyAiNotGoogle: "budget pass uncovered beat",
          relatedBeatIds: toAi,
          priority: 45,
        });
      }
      if (rest.length && ai.length) {
        ai[0].relatedBeatIds = uniqIds([...ai[0].relatedBeatIds, ...rest]);
      }
    }
  }

  return { googleSearches: google, aiGenerate: ai };
}

function countAiBeats(ai: AiItem[]): number {
  let n = 0;
  for (const a of ai) n += a.relatedBeatIds.length;
  return n;
}

function redistributeAi(ai: AiItem[], keepIds: Set<string>): AiItem[] {
  const next: AiItem[] = [];
  for (const item of ai) {
    const ids = item.relatedBeatIds.filter((id) => keepIds.has(id));
    if (ids.length) next.push({ ...item, relatedBeatIds: ids });
  }
  return next;
}

/**
 * Pair back-to-back singleton packs onto one query when beat ids are adjacent
 * (b12+b13) or queries share a token — reuse visual for consecutive scenes.
 */
function packAdjacentGoogleBeats(
  google: GooglePack[],
  perQuery: number,
): GooglePack[] {
  if (perQuery <= 1 || google.length < 2) return google;

  const sorted = google
    .slice()
    .map((p) => ({
      ...p,
      relatedBeatIds: [...p.relatedBeatIds].sort(
        (a, b) => beatNum(a) - beatNum(b),
      ),
    }))
    .sort((a, b) => {
      const an = beatNum(a.relatedBeatIds[0] || "");
      const bn = beatNum(b.relatedBeatIds[0] || "");
      return an - bn || b.priority - a.priority;
    });

  const out: GooglePack[] = [];
  let i = 0;
  while (i < sorted.length) {
    const cur: GooglePack = {
      ...sorted[i],
      relatedBeatIds: [...sorted[i].relatedBeatIds],
    };
    i += 1;
    while (
      cur.relatedBeatIds.length < perQuery &&
      i < sorted.length &&
      sorted[i].relatedBeatIds.length === 1
    ) {
      const nextId = sorted[i].relatedBeatIds[0];
      const lastId = cur.relatedBeatIds[cur.relatedBeatIds.length - 1];
      const adjacent = Math.abs(beatNum(nextId) - beatNum(lastId)) <= 2;
      const a = cur.query.toLowerCase().split(/\s+/);
      const b = sorted[i].query.toLowerCase().split(/\s+/);
      const share = a.some((t) => t.length > 3 && b.includes(t));
      if (!adjacent && !share) break;
      cur.relatedBeatIds = uniqIds([...cur.relatedBeatIds, nextId]).sort(
        (x, y) => beatNum(x) - beatNum(y),
      );
      if (sorted[i].priority > cur.priority) cur.priority = sorted[i].priority;
      // Keep shorter / clearer query
      if (
        sorted[i].query.trim().split(/\s+/).length <
        cur.query.trim().split(/\s+/).length
      ) {
        cur.query = sorted[i].query;
      }
      i += 1;
    }
    out.push(cur);
  }
  return out;
}
