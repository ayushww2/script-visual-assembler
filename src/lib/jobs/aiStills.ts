import type { SceneRecord } from "@/lib/jobs/scenes";
import { objectExists, publicUrlForKey, uploadToR2 } from "@/lib/r2";
import { generateGptImage } from "@/lib/images/openaiImage";
import { generateGptImagesViaBatch } from "@/lib/images/openaiImageBatch";
import {
  composeMysteryImagePrompt,
  engineerMysteryRealismPrompt,
  packToImagePrompt,
} from "@/lib/mystery/realismPrompt";
import { stillKey } from "@/lib/package/stills";
import {
  AI_PROMPT_ENGINEER,
  AI_STILL_CONCURRENCY,
} from "@/lib/jobs/limits";
import { mapPool } from "@/lib/jobs/pool";
import { mapPartsParallel, PARALLEL_PARTS } from "@/lib/jobs/parallelParts";

export type AiStillProgress = (message: string) => Promise<void> | void;
export type AiScenesPersist = (scenes: SceneRecord[]) => Promise<void> | void;

async function existingStillUrl(jobId: string, index: number): Promise<string | null> {
  const nnn = String(index).padStart(3, "0");
  // Legacy unhashed keys only (hashed keys are unique per upload).
  for (const ext of ["png", "jpg", "jpeg", "webp"] as const) {
    const e = ext === "jpeg" ? "jpg" : ext;
    const legacy = `packages/${jobId}/stills/scene-${nnn}.${e}`;
    if (await objectExists(legacy)) return publicUrlForKey(legacy);
  }
  return null;
}

function finalizeAiWhy(scene: SceneRecord, fallback: string): string {
  if (/without empty-chair/i.test(scene.why || "")) {
    return "AI still · chair-free documentary";
  }
  return scene.why || fallback;
}

function promptForScene(
  scene: SceneRecord,
  title?: string | null,
): string {
  const visualIdea =
    scene.entityContext ||
    scene.subject ||
    scene.words ||
    "documentary evidence still";

  if (!AI_PROMPT_ENGINEER) {
    return composeMysteryImagePrompt({
      visualIdea,
      subject: scene.subject,
      title: title || undefined,
      words: scene.words,
    });
  }

  // Sync path only — batch mode always uses local compose (engineer would defeat savings).
  return composeMysteryImagePrompt({
    visualIdea,
    subject: scene.subject,
    title: title || undefined,
    words: scene.words,
  });
}

async function promptForSceneRealtime(
  scene: SceneRecord,
  title?: string | null,
): Promise<string> {
  const visualIdea =
    scene.entityContext ||
    scene.subject ||
    scene.words ||
    "documentary evidence still";

  if (!AI_PROMPT_ENGINEER) {
    return composeMysteryImagePrompt({
      visualIdea,
      subject: scene.subject,
      title: title || undefined,
      words: scene.words,
    });
  }

  try {
    const pack = await engineerMysteryRealismPrompt({
      title: title || undefined,
      visualIdea,
      subject: scene.subject,
      words: scene.words,
      intendedUse: "evidence still",
      preferredStyle: "color documentary",
    });
    return packToImagePrompt(pack);
  } catch {
    return composeMysteryImagePrompt({
      visualIdea,
      subject: scene.subject,
      title: title || undefined,
      words: scene.words,
    });
  }
}

/**
 * Generate Mystery realism stills for scenes missing imageUrl.
 *
 * - Default realtime: 10 parallel parts → gpt-image-2
 * - aiBatch: OpenAI Batch API (~50% cheaper, up to 24h)
 */
export async function generateMissingAiStills(input: {
  jobId: string;
  title?: string | null;
  niche?: string | null;
  scenes: SceneRecord[];
  onProgress?: AiStillProgress;
  /** Persist scenes as AI attaches so a 429 crash doesn't lose work. */
  onScenesPersist?: AiScenesPersist;
  concurrency?: number;
  parts?: number;
  /** OpenAI Batch API — 50% cheaper, async up to 24h */
  useBatch?: boolean;
  existingBatchId?: string | null;
  onBatchCreated?: (batchId: string) => Promise<void> | void;
}): Promise<SceneRecord[]> {
  // Re-attach any AI stills already on R2 from a prior interrupted run.
  let scenes = input.scenes;
  let reattached = 0;
  const hydrated: SceneRecord[] = await Promise.all(
    scenes.map(async (s) => {
      if (s.imageUrl?.trim()) return s;
      // Intentionally cleared for a fresh AI still — do NOT revive the old R2 file.
      if (/regenerating ai without empty-chair/i.test(s.why || "")) {
        return s;
      }
      const url = await existingStillUrl(input.jobId, s.index);
      if (!url) return s;
      reattached += 1;
      const visualSource: SceneRecord["visualSource"] =
        s.visualSource === "google" ? "google" : "ai";
      return {
        ...s,
        visualSource,
        imageUrl: url,
        thumbnailUrl: url,
        r2Url: url,
        why: s.why || "AI still recovered from R2",
      };
    }),
  );
  scenes = hydrated;
  if (reattached > 0) {
    await input.onProgress?.(
      `Re-attached ${reattached} AI still(s) already on R2…`,
    );
    await input.onScenesPersist?.(scenes);
  }

  const needAi = scenes.filter((s) => !s.imageUrl?.trim());
  if (!needAi.length) return scenes;

  if (input.useBatch) {
    return generateMissingAiStillsBatch(
      { ...input, scenes },
      needAi,
    );
  }
  return generateMissingAiStillsRealtime({ ...input, scenes }, needAi);
}

async function generateMissingAiStillsBatch(
  input: {
    jobId: string;
    title?: string | null;
    scenes: SceneRecord[];
    onProgress?: AiStillProgress;
    existingBatchId?: string | null;
    onBatchCreated?: (batchId: string) => Promise<void> | void;
  },
  needAi: SceneRecord[],
): Promise<SceneRecord[]> {
  const byId = new Map(input.scenes.map((s) => [s.id, { ...s }]));

  const requests = needAi.map((scene) => ({
    customId: `scene-${scene.index}`,
    prompt: promptForScene(scene, input.title),
  }));

  const results = await generateGptImagesViaBatch({
    requests,
    existingBatchId: input.existingBatchId,
    onBatchCreated: input.onBatchCreated,
    onProgress: input.onProgress,
  });

  let uploaded = 0;
  let failed = 0;
  for (const scene of needAi) {
    const hit = results.get(`scene-${scene.index}`);
    if (!hit?.bytes) {
      failed += 1;
      continue;
    }
    const ext = (hit.contentType || "image/png").includes("jpeg") ? "jpg" : "png";
    const key = stillKey(input.jobId, scene.index, ext, hit.bytes);
    const put = await uploadToR2({
      key,
      body: hit.bytes,
      contentType: hit.contentType || "image/png",
    });
    byId.set(scene.id, {
      ...scene,
      visualSource:
        scene.visualSource === "unassigned" ? "ai" : scene.visualSource,
      imageUrl: put.url,
      thumbnailUrl: put.url,
      r2Url: put.url,
      why: finalizeAiWhy(scene, "AI documentary realism still (Batch API)"),
    });
    uploaded += 1;
    if (uploaded === 1 || uploaded % 10 === 0 || uploaded === needAi.length) {
      await input.onProgress?.(
        `AI Batch upload R2 ${uploaded}/${needAi.length}` +
          (failed ? ` · ${failed} failed` : ""),
      );
    }
  }

  if (uploaded === 0 && needAi.length > 0) {
    throw new Error(
      `AI Batch produced 0 usable images (${failed} failed of ${needAi.length})`,
    );
  }

  return input.scenes.map((s) => byId.get(s.id) || s);
}

async function generateMissingAiStillsRealtime(
  input: {
    jobId: string;
    title?: string | null;
    scenes: SceneRecord[];
    onProgress?: AiStillProgress;
    onScenesPersist?: AiScenesPersist;
    concurrency?: number;
    parts?: number;
  },
  needAi: SceneRecord[],
): Promise<SceneRecord[]> {
  const byId = new Map(input.scenes.map((s) => [s.id, { ...s }]));
  let done = 0;
  let lastProgressAt = 0;
  let lastPersistAt = 0;
  const partDone = new Map<number, number>();
  const partTotal = new Map<number, number>();

  const totalConcurrency = Math.max(
    1,
    input.concurrency ?? AI_STILL_CONCURRENCY,
  );
  const parts = Math.max(1, input.parts ?? PARALLEL_PARTS);
  const perPart = Math.max(1, Math.ceil(totalConcurrency / parts));

  async function persistNow(force = false) {
    const now = Date.now();
    if (!force && now - lastPersistAt < 5_000) return;
    lastPersistAt = now;
    const snap = input.scenes.map((s) => byId.get(s.id) || s);
    await input.onScenesPersist?.(snap);
  }

  async function runOne(scene: SceneRecord) {
    // Prefer already-uploaded R2 still from a prior run
    const existing = await existingStillUrl(input.jobId, scene.index);
    if (existing) {
      byId.set(scene.id, {
        ...scene,
        visualSource:
          scene.visualSource === "unassigned" ? "ai" : scene.visualSource,
        imageUrl: existing,
        thumbnailUrl: existing,
        r2Url: existing,
        why: scene.why || "AI still recovered from R2",
      });
      return;
    }

    let imagePrompt = await promptForSceneRealtime(scene, input.title);
    let image;
    try {
      image = await generateGptImage({ prompt: imagePrompt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/safety|rejected|sexual|violence/i.test(msg)) {
        imagePrompt = composeMysteryImagePrompt({
          visualIdea:
            "overcast documentary landscape still, empty ancient stone path, no people, no nudity, no gore",
          subject: "documentary landscape",
          title: input.title || undefined,
          words: (scene.words || "").slice(0, 80),
        });
        try {
          image = await generateGptImage({ prompt: imagePrompt });
        } catch {
          console.warn(
            "[aiStills] skip scene after safety reject",
            scene.sceneId,
            msg,
          );
          return;
        }
      } else {
        // Rate limits are retried inside generateGptImage; other errors skip scene.
        console.warn("[aiStills] scene failed", scene.sceneId, msg);
        return;
      }
    }
    const ext = image.contentType.includes("jpeg") ? "jpg" : "png";
    const key = stillKey(input.jobId, scene.index, ext, image.bytes);
    const uploaded = await uploadToR2({
      key,
      body: image.bytes,
      contentType: image.contentType,
    });

    byId.set(scene.id, {
      ...scene,
      visualSource:
        scene.visualSource === "unassigned" ? "ai" : scene.visualSource,
      imageUrl: uploaded.url,
      thumbnailUrl: uploaded.url,
      r2Url: uploaded.url,
      why: finalizeAiWhy(scene, "AI documentary realism still"),
    });
  }

  await mapPartsParallel(needAi, parts, async (shard, partIndex, partCount) => {
    partTotal.set(partIndex, shard.length);
    partDone.set(partIndex, 0);

    await mapPool(shard, perPart, async (scene) => {
      await runOne(scene);
      done += 1;
      partDone.set(partIndex, (partDone.get(partIndex) || 0) + 1);

      const now = Date.now();
      if (
        done === needAi.length ||
        done === 1 ||
        now - lastProgressAt >= 2_000
      ) {
        lastProgressAt = now;
        const attached = needAi.filter((s) =>
          byId.get(s.id)?.imageUrl?.trim(),
        ).length;
        const partBits = Array.from({ length: partCount }, (_, i) => {
          const d = partDone.get(i) || 0;
          const t = partTotal.get(i) || 0;
          return `${i + 1}:${d}/${t}`;
        }).join(" ");
        await input.onProgress?.(
          `AI ×${partCount} parts (×${perPart} each) · ${attached}/${needAi.length} attached · ${partBits}`,
        );
        await persistNow();
      }
    });
  });
  await persistNow(true);

  // Final pass: any still missing after safety skips → ultra-safe landscape
  const stillMissing = needAi.filter((s) => !byId.get(s.id)?.imageUrl?.trim());
  if (stillMissing.length) {
    await input.onProgress?.(
      `AI safe-fill ${stillMissing.length} scene(s) after safety skips…`,
    );
    await mapPool(stillMissing, Math.min(4, perPart), async (scene) => {
      try {
        const image = await generateGptImage({
          prompt: composeMysteryImagePrompt({
            visualIdea:
              "wide documentary photograph of empty ancient stone courtyard at dusk, no people, no text, no logos",
            subject: "empty courtyard",
            title: input.title || undefined,
          }),
        });
        const ext = image.contentType.includes("jpeg") ? "jpg" : "png";
        const key = stillKey(input.jobId, scene.index, ext, image.bytes);
        const uploaded = await uploadToR2({
          key,
          body: image.bytes,
          contentType: image.contentType,
        });
        byId.set(scene.id, {
          ...scene,
          visualSource: "ai",
          imageUrl: uploaded.url,
          thumbnailUrl: uploaded.url,
          r2Url: uploaded.url,
          why: "AI safe-fill after safety reject",
        });
      } catch (err) {
        console.warn(
          "[aiStills] safe-fill failed",
          scene.sceneId,
          err instanceof Error ? err.message : err,
        );
      }
    });
  }

  return input.scenes.map((s) => byId.get(s.id) || s);
}
