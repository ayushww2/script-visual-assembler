import type { SceneRecord } from "@/lib/jobs/scenes";

/**
 * Fill scenes missing imageUrl by reusing the nearest existing still.
 * Used when AI budget is exhausted — never invents new AI.
 */
export function fillMissingByNearestReuse(scenes: SceneRecord[]): {
  scenes: SceneRecord[];
  filled: number;
} {
  const out = scenes.map((s) => ({ ...s }));
  const donors = out
    .map((s, i) => ({
      i,
      url: (s.imageUrl || "").trim(),
      src: s.visualSource,
      thumb: s.thumbnailUrl,
      r2: s.r2Url,
      sourceUrl: s.sourceUrl,
      sourceDomain: s.sourceDomain,
    }))
    .filter((d) => d.url);

  let filled = 0;
  for (let i = 0; i < out.length; i++) {
    if ((out[i].imageUrl || "").trim()) continue;
    let best: (typeof donors)[number] | null = null;
    let bestDist = Infinity;
    for (const d of donors) {
      const dist = Math.abs(d.i - i);
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    if (!best) continue;
    out[i] = {
      ...out[i],
      imageUrl: best.url,
      thumbnailUrl: best.thumb || best.url,
      r2Url: best.r2 || null,
      sourceUrl: best.sourceUrl || out[i].sourceUrl,
      sourceDomain: best.sourceDomain || out[i].sourceDomain,
      visualSource: best.src === "google" ? "google" : out[i].visualSource,
      why: `${out[i].why || "scene"} · budget: reused adjacent still`,
    };
    filled += 1;
  }
  return { scenes: out, filled };
}

/** Count AI stills that already have an image attached. */
export function countAiImagesAttached(scenes: SceneRecord[]): number {
  return scenes.filter(
    (s) => s.visualSource === "ai" && Boolean(s.imageUrl?.trim()),
  ).length;
}
