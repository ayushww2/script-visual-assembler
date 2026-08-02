import type { SceneRecord } from "@/lib/jobs/scenes";
import {
  isBadGoogleScenePick,
  pickBestGoogleHit,
  type GoogleSearchPreview,
} from "@/lib/search/google";
import { resolveGoogleSubject } from "@/lib/search/resolveSubject";

/**
 * If a Google scene looks bad, try the next best hit from the SAME search
 * (no new query). Consecutive scenes can keep sharing a good still.
 */
export function reviewAndRepickFromSameSearch(input: {
  scenes: SceneRecord[];
  previews?: Record<string, GoogleSearchPreview> | null;
}): { scenes: SceneRecord[]; repaired: number } {
  const previews = input.previews || {};
  const used = new Set(
    input.scenes.map((s) => s.imageUrl).filter(Boolean) as string[],
  );
  let repaired = 0;

  const next = input.scenes.map((scene) => {
    if (scene.visualSource !== "google" || !scene.query) return scene;
    if (!isBadGoogleScenePick(scene) && scene.imageUrl?.trim()) return scene;

    const preview = previews[scene.query];
    if (!preview?.results?.length) return scene;

    const { personName, placeName } = resolveGoogleSubject(
      scene.words,
      scene.query,
      scene.subject,
      scene.entityContext,
    );

    // Exclude current bad URL so we get another from the same search
    const exclude = new Set(used);
    if (scene.imageUrl) exclude.add(scene.imageUrl);

    const hit = pickBestGoogleHit(preview, {
      usedUrls: exclude,
      personName,
      placeName,
    });
    if (!hit?.imageUrl || hit.imageUrl === scene.imageUrl) return scene;

    used.add(hit.imageUrl);
    repaired += 1;
    const candidates = (preview.results || [])
      .map((h) => h.imageUrl)
      .filter(Boolean) as string[];

    return {
      ...scene,
      imageUrl: hit.imageUrl,
      thumbnailUrl: hit.thumbnailUrl || hit.imageUrl,
      sourceUrl: hit.sourcePageUrl || hit.imageUrl,
      sourceDomain: hit.sourceDomain || null,
      imageCandidates: candidates.slice(0, 8),
      why: `${scene.why || "Google"} · reviewed: next hit from same search`,
    };
  });

  return { scenes: next, repaired };
}
