import type { SceneRecord } from "@/lib/jobs/scenes";
import {
  beatLooksGoogleable,
  queryForGoogleableBeat,
} from "@/lib/divider/googleFirst";
import {
  pickBestGoogleHit,
  searchGoogleImages,
} from "@/lib/search/google";
import { primaryPersonFromText } from "@/lib/search/personSubject";
import { mapPool } from "@/lib/jobs/pool";

export type RepairProgress = (message: string) => Promise<void> | void;

/** Fake paperwork / clipboard AI props — prefer real wildlife photos. */
const DOC_CLICHE =
  /\b(clipboard|incident form|wildlife report|case file|board agenda|population chart|typed report|printed form|stamped (wildlife|case)|government wildlife report|manila folder|filing)\b/i;

/**
 * AI scenes that should have been Google (tombs, wolves, sites, etc.).
 * Scans subject + spoken words; also catches raw-document AI props.
 */
export function isMisplacedAiScene(scene: SceneRecord): boolean {
  if (scene.visualSource !== "ai") return false;
  if (!scene.imageUrl?.trim()) return false;
  const scan = [scene.subject, scene.words, scene.query].filter(Boolean).join(" ");
  if (beatLooksGoogleable(scan)) return true;
  const idea = [scene.entityContext, scene.subject].filter(Boolean).join(" ");
  return DOC_CLICHE.test(idea);
}

/**
 * Re-search Google for AI scenes that are clearly photographable.
 * Good AI abstracts and already-good Google scenes stay untouched.
 */
export async function repairMisplacedAiToGoogle(input: {
  scenes: SceneRecord[];
  title?: string | null;
  onProgress?: RepairProgress;
  concurrency?: number;
}): Promise<{ scenes: SceneRecord[]; repaired: number; failed: number }> {
  const indexes: number[] = [];
  input.scenes.forEach((s, i) => {
    if (isMisplacedAiScene(s)) indexes.push(i);
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
  const concurrency = Math.max(1, input.concurrency ?? 6);

  await input.onProgress?.(
    `Google-first repair · converting ${indexes.length} misplaced AI stills…`,
  );

  await mapPool(indexes, concurrency, async (idx) => {
    const scene = out[idx];
    const scan = [scene.subject, scene.words, scene.query, input.title]
      .filter(Boolean)
      .join(" ");
    const personName = primaryPersonFromText(
      scene.words,
      scene.scriptText,
      scene.subject,
      scene.query,
    );
    const idea = [scene.entityContext, scene.subject].filter(Boolean).join(" ");
    const query = (
      personName
        ? personName
        : queryForGoogleableBeat(scan) ||
          (DOC_CLICHE.test(idea) ? "yellowstone gray wolf" : "") ||
          scene.subject ||
          scene.words.split(/\s+/).slice(0, 4).join(" ")
    ).trim();

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
          why: "Google-first: photographable subject — real photo preferred over AI",
          r2Url: null,
        };
        repaired += 1;
      }
    } catch {
      failed += 1;
    }

    done += 1;
    if (done === 1 || done === indexes.length || done % 5 === 0) {
      await input.onProgress?.(
        `Google-first AI→Google ${done}/${indexes.length} · fixed ${repaired} · failed ${failed}`,
      );
    }
  });

  return { scenes: out, repaired, failed };
}
