import type { SceneRecord } from "@/lib/jobs/scenes";
import { uploadToR2 } from "@/lib/r2";
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
  concurrency?: number;
  parts?: number;
  /** OpenAI Batch API — 50% cheaper, async up to 24h */
  useBatch?: boolean;
  existingBatchId?: string | null;
  onBatchCreated?: (batchId: string) => Promise<void> | void;
}): Promise<SceneRecord[]> {
  const needAi = input.scenes.filter((s) => !s.imageUrl?.trim());
  if (!needAi.length) return input.scenes;

  if (input.useBatch) {
    return generateMissingAiStillsBatch(input, needAi);
  }
  return generateMissingAiStillsRealtime(input, needAi);
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
    const key = stillKey(input.jobId, scene.index, ext);
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
      why: scene.why || "AI documentary realism still (Batch API)",
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
    concurrency?: number;
    parts?: number;
  },
  needAi: SceneRecord[],
): Promise<SceneRecord[]> {
  const byId = new Map(input.scenes.map((s) => [s.id, { ...s }]));
  let done = 0;
  let lastProgressAt = 0;
  const partDone = new Map<number, number>();
  const partTotal = new Map<number, number>();

  const totalConcurrency = Math.max(
    1,
    input.concurrency ?? AI_STILL_CONCURRENCY,
  );
  const parts = Math.max(1, input.parts ?? PARALLEL_PARTS);
  const perPart = Math.max(1, Math.ceil(totalConcurrency / parts));

  async function runOne(scene: SceneRecord) {
    let imagePrompt = await promptForSceneRealtime(scene, input.title);
    let image;
    try {
      image = await generateGptImage({ prompt: imagePrompt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Safety rejects (e.g. religious/sexual classifiers) → safer documentary rewrite once
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
          console.warn("[aiStills] skip scene after safety reject", scene.sceneId, msg);
          return; // leave missing; package may still proceed with partial if others ok
        }
      } else if (/rate limit|429/i.test(msg)) {
        throw err; // let outer retry/backoff in generateGptImage; rethrow if exhausted
      } else {
        console.warn("[aiStills] scene failed", scene.sceneId, msg);
        return;
      }
    }
    const ext = image.contentType.includes("jpeg") ? "jpg" : "png";
    const key = stillKey(input.jobId, scene.index, ext);
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
      why: scene.why || "AI documentary realism still",
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
        const partBits = Array.from({ length: partCount }, (_, i) => {
          const d = partDone.get(i) || 0;
          const t = partTotal.get(i) || 0;
          return `${i + 1}:${d}/${t}`;
        }).join(" ");
        await input.onProgress?.(
          `AI ×${partCount} parts (×${perPart} each) · ${done}/${needAi.length} · ${partBits}`,
        );
      }
    });
  });

  return input.scenes.map((s) => byId.get(s.id) || s);
}
