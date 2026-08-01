import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { SceneRecord } from "@/lib/jobs/scenes";
import type { GoogleSearchPreview } from "@/lib/search/google";
import { getNiche } from "@/lib/niches";
import {
  buildAndUploadRenderPackage,
  HandoverPackagerError,
} from "./handover";

/** Re-run handover packaging for an already-completed job (no re-divide). */
export async function repackageJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");
  if (!job.scenesJson) throw new Error("Job has no scenes to package");

  const scenes = enrichCandidates(
    job.scenesJson as unknown as SceneRecord[],
    (job.previewsJson as unknown as Record<string, GoogleSearchPreview>) ||
      undefined,
  );
  const niche = getNiche(job.niche);

  await prisma.job.update({
    where: { id: jobId },
    data: {
      packageReady: false,
      packageUrl: null,
      packageError: null,
      progress: "Rebuilding Remotion render package…",
    },
  });

  try {
    const handover = await buildAndUploadRenderPackage({
      jobId: job.id,
      title: job.title,
      nicheWpm: niche.wpm,
      scenes,
      voiceoverUrl: job.voiceoverUrl,
      voiceoverDurationSec: job.voiceoverDurationSec,
      imagesOnly: true,
      createdAt: job.createdAt,
      onProgress: async (message) => {
        await prisma.job.update({
          where: { id: jobId },
          data: { progress: message },
        });
      },
    });

    await prisma.job.update({
      where: { id: jobId },
      data: {
        scenesJson: handover.scenes as unknown as Prisma.InputJsonValue,
        sceneCount: handover.scenes.length,
        packageReady: true,
        packageUrl: handover.packageUrl,
        packageJson: handover.packageJson as unknown as Prisma.InputJsonValue,
        packageError: null,
        imagesOnly: handover.imagesOnly,
        voiceoverDurationSec: handover.packageJson.voiceoverDurationSec ?? null,
        progress: `Package ready · scenes=${handover.packageJson.sceneCount} · vo=${handover.packageJson.voiceoverDurationSec.toFixed(1)}s · wpm=${handover.packageJson.wpm}`,
      },
    });
  } catch (packErr) {
    const issues =
      packErr instanceof HandoverPackagerError ? packErr.issues : [];
    const message =
      packErr instanceof Error ? packErr.message : "Render package failed";
    const detail = issues.length
      ? `${message}: ${issues.slice(0, 6).join("; ")}`
      : message;
    await prisma.job.update({
      where: { id: jobId },
      data: {
        packageReady: false,
        packageUrl: null,
        packageError: detail,
        progress: "Package rebuild failed",
      },
    });
    throw packErr;
  }
}

function enrichCandidates(
  scenes: SceneRecord[],
  previews?: Record<string, GoogleSearchPreview>,
): SceneRecord[] {
  if (!previews) return scenes;
  return scenes.map((scene) => {
    if (!scene.query || scene.imageCandidates?.length) return scene;
    const hits = previews[scene.query]?.results || [];
    const imageCandidates = hits
      .flatMap((h) => [h.imageUrl, h.thumbnailUrl])
      .filter((u): u is string => Boolean(u && u.startsWith("http")));
    return {
      ...scene,
      imageCandidates: Array.from(new Set(imageCandidates)),
    };
  });
}
