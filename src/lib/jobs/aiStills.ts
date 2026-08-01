import type { SceneRecord } from "@/lib/jobs/scenes";
import { uploadToR2 } from "@/lib/r2";
import { generateGptImage } from "@/lib/images/openaiImage";
import { fallbackMysteryImagePrompt } from "@/lib/mystery/realismPrompt";
import { stillKey } from "@/lib/package/stills";

export type AiStillProgress = (message: string) => Promise<void> | void;

const AI_CONCURRENCY = 2;

/**
 * Generate Mystery realism stills for scenes missing imageUrl.
 * Uses the locked realism recipe locally (no extra ContactBox engineer call).
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

  async function runOne(scene: SceneRecord) {
    const visualIdea =
      scene.entityContext ||
      scene.subject ||
      scene.words ||
      "documentary evidence still";

    const imagePrompt = fallbackMysteryImagePrompt({
      visualIdea,
      subject: scene.subject,
    });

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
    await input.onProgress?.(
      `AI still ${done}/${needAi.length}: scene ${scene.sceneId}`,
    );
  }

  for (let i = 0; i < needAi.length; i += AI_CONCURRENCY) {
    const slice = needAi.slice(i, i + AI_CONCURRENCY);
    await Promise.all(slice.map((s) => runOne(s)));
  }

  return input.scenes.map((s) => byId.get(s.id) || s);
}
