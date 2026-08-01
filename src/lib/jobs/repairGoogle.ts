import type { SceneRecord } from "@/lib/jobs/scenes";
import {
  isBadGoogleScenePick,
  pickBestGoogleHit,
  searchGoogleImages,
} from "@/lib/search/google";
import { primaryPersonFromText } from "@/lib/search/personSubject";
import { mapPool } from "@/lib/jobs/pool";

export type RepairProgress = (message: string) => Promise<void> | void;

/**
 * Re-search ONLY Google scenes that look like logos/text/watermarks/social thumbs.
 * Good scenes are left untouched.
 */
export async function repairBadGoogleScenes(input: {
  scenes: SceneRecord[];
  onProgress?: RepairProgress;
  concurrency?: number;
}): Promise<{ scenes: SceneRecord[]; repaired: number; failed: number }> {
  const badIndexes: number[] = [];
  input.scenes.forEach((s, i) => {
    if (isBadGoogleScenePick(s)) badIndexes.push(i);
  });

  if (!badIndexes.length) {
    return { scenes: input.scenes, repaired: 0, failed: 0 };
  }

  const out = input.scenes.map((s) => ({ ...s }));
  const used = new Set(
    out
      .filter((s) => s.imageUrl && !isBadGoogleScenePick(s))
      .map((s) => s.imageUrl!) ,
  );

  let repaired = 0;
  let failed = 0;
  let done = 0;
  const concurrency = Math.max(1, input.concurrency ?? 8);

  await input.onProgress?.(
    `Repairing ${badIndexes.length} dirty Google stills (logos/text/thumbs)…`,
  );

  await mapPool(badIndexes, concurrency, async (idx) => {
    const scene = out[idx];
    const personName = primaryPersonFromText(
      scene.words,
      scene.scriptText,
      scene.query,
      scene.subject,
      scene.entityContext,
    );
    // Always search the full locked person name — never bare "Gibson".
    const query = (
      personName
        ? personName
        : scene.query ||
          scene.subject ||
          scene.words.split(/\s+/).slice(0, 4).join(" ")
    )
      .replace(/\bgibson\b/gi, "Mel Gibson")
      .trim() || "documentary photo";

    try {
      const preview = await searchGoogleImages(query, 16, { personName });
      const hit = pickBestGoogleHit(preview, {
        usedUrls: used,
        personName,
      });
      if (!hit?.imageUrl) {
        failed += 1;
      } else {
        used.add(hit.imageUrl);
        out[idx] = {
          ...scene,
          visualSource: "google",
          query,
          subject: personName || scene.subject,
          imageUrl: hit.imageUrl,
          thumbnailUrl: hit.thumbnailUrl || hit.imageUrl,
          sourceUrl: hit.sourcePageUrl || null,
          sourceDomain: hit.sourceDomain || null,
          imageCandidates: preview.results
            .map((r) => r.imageUrl)
            .filter(Boolean)
            .slice(0, 8),
          why: personName
            ? `Repaired clean Google · single-person: ${personName}`
            : "Repaired clean Google (no logo/text/watermark)",
        };
        repaired += 1;
      }
    } catch {
      failed += 1;
    }

    done += 1;
    if (done === 1 || done === badIndexes.length || done % 5 === 0) {
      await input.onProgress?.(
        `Google repair ${done}/${badIndexes.length} · fixed ${repaired} · failed ${failed}`,
      );
    }
  });

  return { scenes: out, repaired, failed };
}
