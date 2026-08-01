import type { SceneRecord } from "@/lib/jobs/scenes";
import { uploadToR2 } from "@/lib/r2";
import { generateGptImage } from "@/lib/images/openaiImage";
import {
  engineerMysteryRealismPrompt,
  fallbackMysteryImagePrompt,
  packToImagePrompt,
} from "@/lib/mystery/realismPrompt";
import { stillKey } from "@/lib/package/stills";

export type AiStillProgress = (message: string) => Promise<void> | void;

/**
 * For scenes without an imageUrl (typically AI / unassigned), engineer a
 * Mystery realism prompt and generate a gpt-image-2 still onto R2.
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

  const byId = new Map(input.scenes.map((s) => [s.id, s]));

  for (let i = 0; i < needAi.length; i++) {
    const scene = needAi[i];
    await input.onProgress?.(
      `AI still ${i + 1}/${needAi.length}: scene ${scene.sceneId} (${scene.subject || scene.visualSource})`,
    );

    const visualIdea =
      scene.entityContext ||
      scene.subject ||
      scene.words ||
      "documentary evidence still";

    let imagePrompt: string;
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

  return input.scenes.map((s) => byId.get(s.id) || s);
}
