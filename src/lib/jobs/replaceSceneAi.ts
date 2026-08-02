import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { SceneRecord } from "@/lib/jobs/scenes";
import { generateGptImage } from "@/lib/images/openaiImage";
import { composeMysteryImagePrompt } from "@/lib/mystery/realismPrompt";
import { maybeCompressStillForRemotion } from "@/lib/package/compressStill";
import { packageJsonKey, stillKey } from "@/lib/package/stills";
import type { RenderPackage } from "@/lib/package/schema";
import { uploadToR2 } from "@/lib/r2";
import { repackageJob } from "@/lib/package/repackage";

export type ReplaceSceneAiInput = {
  jobId: string;
  /** Matches sceneId, id, or 1-based index string ("6"). */
  sceneRef: string;
  /** Short visual idea for the AI still. */
  visualIdea: string;
  subject?: string;
  why?: string;
  /**
   * Rebuild Remotion package after swap.
   * Default: lightweight patch of existing package.json (one scene URL).
   * Pass "full" to re-upload every still.
   */
  repackage?: boolean | "full" | "patch";
};

function matchScene(scenes: SceneRecord[], sceneRef: string): number {
  const ref = sceneRef.trim();
  // sceneId / index are 1-based ("1"…"N"); id is "sN".
  const byId = scenes.findIndex(
    (s) =>
      s.sceneId === ref ||
      s.id === ref ||
      s.id === `s${ref}` ||
      String(s.index) === ref,
  );
  if (byId >= 0) return byId;
  throw new Error(`Scene not found: ${sceneRef}`);
}

async function patchPackageSceneImage(input: {
  jobId: string;
  sceneIndex0: number;
  imageUrl: string;
  existing: RenderPackage | null;
}): Promise<{ packageUrl: string; packageJson: RenderPackage } | null> {
  if (!input.existing?.scenes?.length) return null;
  if (
    input.sceneIndex0 < 0 ||
    input.sceneIndex0 >= input.existing.scenes.length
  ) {
    return null;
  }

  const packageJson: RenderPackage = {
    scenes: input.existing.scenes.map((s, i) =>
      i === input.sceneIndex0 ? { ...s, imageUrl: input.imageUrl } : s,
    ),
  };

  const uploaded = await uploadToR2({
    key: packageJsonKey(input.jobId),
    body: JSON.stringify(packageJson, null, 2),
    contentType: "application/json; charset=utf-8",
    cacheControl: "public, max-age=60",
  });

  return { packageUrl: uploaded.url, packageJson };
}

/**
 * Force-replace one scene still with a fresh gpt-image-2 generation,
 * upload hashed R2 key, persist scenesJson, update package.
 */
export async function replaceSceneWithAi(
  input: ReplaceSceneAiInput,
): Promise<{ scene: SceneRecord; packageReady: boolean }> {
  const job = await prisma.job.findUnique({ where: { id: input.jobId } });
  if (!job) throw new Error("Job not found");
  if (!job.scenesJson) throw new Error("Job has no scenes");

  const scenes = job.scenesJson as unknown as SceneRecord[];
  const idx = matchScene(scenes, input.sceneRef);
  const scene = scenes[idx];

  await prisma.job.update({
    where: { id: input.jobId },
    data: {
      progress: `Replacing scene ${scene.sceneId || scene.index} with AI still…`,
    },
  });

  const prompt = composeMysteryImagePrompt({
    visualIdea: input.visualIdea,
    subject: input.subject || input.visualIdea,
    title: job.title || undefined,
    words: scene.words,
  });

  const image = await generateGptImage({ prompt });
  const optimized = await maybeCompressStillForRemotion(
    image.bytes,
    image.contentType || "image/png",
  );
  const key = stillKey(
    input.jobId,
    scene.index,
    optimized.ext,
    optimized.body,
  );
  const put = await uploadToR2({
    key,
    body: optimized.body,
    contentType: optimized.contentType,
  });

  const updated: SceneRecord = {
    ...scene,
    visualSource: "ai",
    subject: input.subject || input.visualIdea,
    entityContext: input.visualIdea,
    query: undefined,
    imageUrl: put.url,
    thumbnailUrl: put.url,
    r2Url: put.url,
    sourceUrl: put.url,
    sourceDomain: null,
    imageCandidates: [],
    why: input.why || `AI still · ${input.visualIdea}`,
  };

  const next = scenes.map((s, i) => (i === idx ? updated : s));
  await prisma.job.update({
    where: { id: input.jobId },
    data: {
      scenesJson: next as unknown as Prisma.InputJsonValue,
      progress: `Scene ${updated.sceneId || updated.index} replaced · updating package…`,
    },
  });

  const mode =
    input.repackage === false
      ? "none"
      : input.repackage === "full" || input.repackage === true
        ? "full"
        : "patch";

  if (mode === "full") {
    await repackageJob(input.jobId);
  } else if (mode === "patch") {
    const existing =
      (job.packageJson as unknown as RenderPackage | null) || null;
    const patched = await patchPackageSceneImage({
      jobId: input.jobId,
      sceneIndex0: idx,
      imageUrl: put.url,
      existing,
    });
    if (patched) {
      await prisma.job.update({
        where: { id: input.jobId },
        data: {
          packageReady: true,
          packageUrl: patched.packageUrl,
          packageJson: patched.packageJson as unknown as Prisma.InputJsonValue,
          packageError: null,
          progress: `Scene ${updated.sceneId || updated.index} replaced with AI · package patched`,
        },
      });
    } else {
      // No existing package — do a full rebuild so Remotion stays consistent.
      await repackageJob(input.jobId);
    }
  }

  const fresh = await prisma.job.findUnique({ where: { id: input.jobId } });
  const freshScenes = (fresh?.scenesJson as unknown as SceneRecord[]) || next;
  return {
    scene: freshScenes[idx] || updated,
    packageReady: Boolean(fresh?.packageReady),
  };
}
