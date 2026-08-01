import type { SceneRecord } from "@/lib/jobs/scenes";
import {
  pickBestGoogleHit,
  searchGoogleImages,
} from "@/lib/search/google";
import { primaryPersonFromText } from "@/lib/search/personSubject";
import { mapPool } from "@/lib/jobs/pool";

export type RepairProgress = (message: string) => Promise<void> | void;

/** Empty-chair / vacant-interview prop stills — look cheap and off-topic. */
const CHAIR_CLICHE =
  /\b(vacant (interview )?chair|empty chair|interview chair|armchair|audio recorder|zoom recorder|printed notes|interview set between takes|empty seat beside|recorder and (printed )?notes)\b/i;

export function isChairClicheAiScene(scene: SceneRecord): boolean {
  if (scene.visualSource !== "ai") return false;
  if (!scene.imageUrl?.trim()) return false;
  const blob = [scene.entityContext, scene.subject, scene.why, scene.query]
    .filter(Boolean)
    .join(" ");
  return CHAIR_CLICHE.test(blob);
}

/**
 * Replace empty-chair AI stills with a real Google photo of the film’s person
 * (or a serious documentary stand-in query). Other scenes untouched.
 */
export async function repairChairClicheAiScenes(input: {
  scenes: SceneRecord[];
  title?: string | null;
  onProgress?: RepairProgress;
  concurrency?: number;
}): Promise<{ scenes: SceneRecord[]; repaired: number; failed: number }> {
  const indexes: number[] = [];
  input.scenes.forEach((s, i) => {
    if (isChairClicheAiScene(s)) indexes.push(i);
  });
  if (!indexes.length) {
    return { scenes: input.scenes, repaired: 0, failed: 0 };
  }

  const out = input.scenes.map((s) => ({ ...s }));
  const used = new Set(
    out.filter((s) => s.imageUrl?.trim()).map((s) => s.imageUrl!),
  );
  let repaired = 0;
  let failed = 0;
  let done = 0;
  const concurrency = Math.max(1, input.concurrency ?? 4);

  await input.onProgress?.(
    `Replacing ${indexes.length} empty-chair AI cliché stills…`,
  );

  await mapPool(indexes, concurrency, async (idx) => {
    const scene = out[idx];
    const personName = primaryPersonFromText(
      input.title,
      scene.words,
      scene.scriptText,
      scene.subject,
    );
    const query = personName
      ? `${personName} interview`
      : "documentary interview serious close up";

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
            ? `Replaced empty-chair AI · Google single-person: ${personName}`
            : "Replaced empty-chair AI cliché with real documentary photo",
          r2Url: null,
          entityContext: undefined,
        };
        repaired += 1;
      }
    } catch {
      failed += 1;
    }

    done += 1;
    await input.onProgress?.(
      `Chair-cliché repair ${done}/${indexes.length} · fixed ${repaired} · failed ${failed}`,
    );
  });

  return { scenes: out, repaired, failed };
}
