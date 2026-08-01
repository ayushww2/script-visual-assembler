import type { SceneRecord } from "@/lib/jobs/scenes";
import { uploadToR2 } from "@/lib/r2";
import { generateGptImage } from "@/lib/images/openaiImage";
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

/**
 * Generate Mystery realism stills for scenes missing imageUrl.
 * Default: local realism lock → gpt-image-2 → R2 (no per-still ContactBox).
 * Set AI_PROMPT_ENGINEER=1 to restore ContactBox prompt engineering (slower).
 *
 * Scenes are split into PARALLEL_PARTS (default 10) and all parts run at once.
 */
export async function generateMissingAiStills(input: {
  jobId: string;
  title?: string | null;
  niche?: string | null;
  scenes: SceneRecord[];
  onProgress?: AiStillProgress;
  /** Override total in-flight gens across all parts. */
  concurrency?: number;
  parts?: number;
}): Promise<SceneRecord[]> {
  const needAi = input.scenes.filter((s) => !s.imageUrl?.trim());
  if (!needAi.length) return input.scenes;

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
  // Spread concurrency across parts so 10×N doesn't explode rate limits.
  const perPart = Math.max(1, Math.ceil(totalConcurrency / parts));

  async function runOne(scene: SceneRecord) {
    const visualIdea =
      scene.entityContext ||
      scene.subject ||
      scene.words ||
      "documentary evidence still";

    let imagePrompt: string;
    if (AI_PROMPT_ENGINEER) {
      try {
        const pack = await engineerMysteryRealismPrompt({
          title: input.title || undefined,
          visualIdea,
          subject: scene.subject,
          words: scene.words,
          intendedUse: "evidence still",
          preferredStyle: "color documentary",
        });
        imagePrompt = packToImagePrompt(pack);
      } catch {
        imagePrompt = composeMysteryImagePrompt({
          visualIdea,
          subject: scene.subject,
          title: input.title || undefined,
          words: scene.words,
        });
      }
    } else {
      imagePrompt = composeMysteryImagePrompt({
        visualIdea,
        subject: scene.subject,
        title: input.title || undefined,
        words: scene.words,
      });
    }

    const image = await generateGptImage({ prompt: imagePrompt });
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
