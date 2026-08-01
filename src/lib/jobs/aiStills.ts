import type { SceneRecord } from "@/lib/jobs/scenes";
import { uploadToR2 } from "@/lib/r2";
import { generateGptImage } from "@/lib/images/openaiImage";
import {
  engineerMysteryRealismPrompt,
  fallbackMysteryImagePrompt,
  packToImagePrompt,
} from "@/lib/mystery/realismPrompt";
import { stillKey } from "@/lib/package/stills";
import {
  AI_PROMPT_ENGINEER,
  AI_STILL_CONCURRENCY,
} from "@/lib/jobs/limits";
import { mapPool } from "@/lib/jobs/pool";

export type AiStillProgress = (message: string) => Promise<void> | void;

/**
 * Generate Mystery realism stills for scenes missing imageUrl.
 * Default: local realism lock → gpt-image-2 → R2 (no per-still ContactBox).
 * Set AI_PROMPT_ENGINEER=1 to restore ContactBox prompt engineering (slower).
 */
export async function generateMissingAiStills(input: {
  jobId: string;
  title?: string | null;
  niche?: string | null;
  scenes: SceneRecord[];
  onProgress?: AiStillProgress;
}): Promise<SceneRecord[]> {
  const needAi = input.scenes.filter((s) => !s.imageUrl?.trim());
  if (!needAi.length) return input.scenes;

  const byId = new Map(input.scenes.map((s) => [s.id, { ...s }]));
  let done = 0;
  let lastProgressAt = 0;

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
        imagePrompt = fallbackMysteryImagePrompt({
          visualIdea,
          subject: scene.subject,
        });
      }
    } else {
      imagePrompt = fallbackMysteryImagePrompt({
        visualIdea,
        subject: scene.subject,
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

    done += 1;
    const now = Date.now();
    // Throttle DB progress writes — every still at the end, else ~every 2s
    if (
      done === needAi.length ||
      now - lastProgressAt >= 2_000 ||
      done === 1
    ) {
      lastProgressAt = now;
      await input.onProgress?.(
        `AI still ${done}/${needAi.length}: scene ${scene.sceneId}`,
      );
    }
  }

  const concurrency = Math.max(1, AI_STILL_CONCURRENCY);
  await mapPool(needAi, concurrency, async (scene) => {
    await runOne(scene);
  });

  return input.scenes.map((s) => byId.get(s.id) || s);
}
