import type { SceneRecord } from "@/lib/jobs/scenes";
import { buildCelebrityPhotoQuery } from "@/lib/divider/celebrityQuery";
import {
  isBadGoogleScenePick,
  pickBestGoogleHit,
  searchGoogleImages,
} from "@/lib/search/google";
import { mapPool } from "@/lib/jobs/pool";

export type RepairProgress = (message: string) => Promise<void> | void;

/**
 * Celebrity experiment repair:
 * - ONE unique Google query per scene
 * - entity-locked photo queries (no memoir/book/report wording)
 * - unique image URLs across the whole film
 */
export async function repairCelebrityUniqueScenes(input: {
  scenes: SceneRecord[];
  onProgress?: RepairProgress;
  concurrency?: number;
  /** Re-search every scene (default true). */
  allScenes?: boolean;
}): Promise<{
  scenes: SceneRecord[];
  repaired: number;
  failed: number;
  queries: number;
}> {
  const out = input.scenes.map((s) => ({ ...s }));
  const indexes =
    input.allScenes === false
      ? out
          .map((s, i) => (isBadGoogleScenePick(s) ? i : -1))
          .filter((i) => i >= 0)
      : out.map((_, i) => i);

  const used = new Set<string>();
  let repaired = 0;
  let failed = 0;
  let done = 0;
  const concurrency = Math.max(1, input.concurrency ?? 6);

  await input.onProgress?.(
    `Celebrity unique repair · ${indexes.length} scenes · 1 query each…`,
  );

  await mapPool(indexes, concurrency, async (idx) => {
    const scene = out[idx];
    const built = buildCelebrityPhotoQuery(
      scene.words || scene.scriptText || "",
      scene.index || idx + 1,
    );
    const alternates = [
      built.query,
      built.personName ? `${built.personName} photo` : "",
      built.personName ? `${built.personName} 1960s` : "",
      built.placeName ? `${built.placeName} photo` : "",
      "marilyn monroe portrait",
      "frank sinatra portrait",
    ].filter(Boolean);

    let hit = null as ReturnType<typeof pickBestGoogleHit>;
    let query = built.query;
    let candidates: string[] = [];

    for (const q of alternates) {
      try {
        const preview = await searchGoogleImages(q, 20, {
          personName: built.personName,
          placeName: built.placeName,
        });
        candidates = preview.results.map((r) => r.imageUrl).filter(Boolean);
        hit = pickBestGoogleHit(preview, {
          usedUrls: used,
          personName: built.personName,
          placeName: built.placeName,
        });
        if (hit?.imageUrl) {
          query = q;
          break;
        }
      } catch {
        // try next alternate
      }
    }

    if (!hit?.imageUrl) {
      failed += 1;
    } else {
      used.add(hit.imageUrl);
      out[idx] = {
        ...scene,
        visualSource: "google",
        query,
        subject: built.placeName || built.personName || scene.subject,
        entityContext: scene.entityContext || scene.words,
        imageUrl: hit.imageUrl,
        thumbnailUrl: hit.thumbnailUrl || hit.imageUrl,
        sourceUrl: hit.sourcePageUrl || null,
        sourceDomain: hit.sourceDomain || null,
        imageCandidates: candidates.slice(0, 10),
        why: built.placeName
          ? `Celebrity unique Google · place: ${built.placeName}`
          : built.personName
            ? `Celebrity unique Google · person: ${built.personName}`
            : "Celebrity unique Google · photo still",
        r2Url: null,
      };
      repaired += 1;
    }

    done += 1;
    if (done === 1 || done === indexes.length || done % 10 === 0) {
      await input.onProgress?.(
        `Celebrity unique ${done}/${indexes.length} · ok ${repaired} · fail ${failed}`,
      );
    }
  });

  // Second pass: fill any misses by reusing nearest successful still only if search failed
  // (should be rare). Prefer leaving unique coverage high.
  const withUrl = out
    .map((s, i) => ({ i, url: s.imageUrl?.trim() || "" }))
    .filter((x) => x.url);
  for (let i = 0; i < out.length; i++) {
    if (out[i].imageUrl?.trim()) continue;
    if (!withUrl.length) break;
    let best = withUrl[0];
    let bestDist = Math.abs(best.i - i);
    for (const cand of withUrl) {
      const d = Math.abs(cand.i - i);
      if (d < bestDist) {
        best = cand;
        bestDist = d;
      }
    }
    const donor = out[best.i];
    out[i] = {
      ...out[i],
      visualSource: "google",
      imageUrl: donor.imageUrl,
      thumbnailUrl: donor.thumbnailUrl || donor.imageUrl,
      sourceUrl: donor.sourceUrl,
      sourceDomain: donor.sourceDomain,
      why: `${out[i].why || "celebrity"} · emergency reuse after search miss`,
    };
  }

  return {
    scenes: out,
    repaired,
    failed,
    queries: indexes.length,
  };
}
