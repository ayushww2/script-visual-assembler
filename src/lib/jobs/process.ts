import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runScriptDivider } from "@/lib/divider/run";
import { searchGoogleImages } from "@/lib/search/google";
import {
  PREVIEW_IMAGES_PER_QUERY,
  PREVIEW_QUERY_GAP_MS,
} from "@/lib/jobs/limits";
import type { GoogleSearchPreview } from "@/lib/search/google";
import { buildScenes } from "@/lib/jobs/scenes";
import { generateMissingAiStills } from "@/lib/jobs/aiStills";
import { balanceGoogleAiScenes, countSources } from "@/lib/jobs/balance";
import {
  buildAndUploadRenderPackage,
  HandoverPackagerError,
} from "@/lib/package/handover";
import { getNiche } from "@/lib/niches";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-process lock so one Node instance only runs one heavy job at a time. */
let processing = false;
const waiters: Array<() => void> = [];

async function withJobLock<T>(fn: () => Promise<T>): Promise<T> {
  if (processing) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  processing = true;
  try {
    return await fn();
  } finally {
    processing = false;
    const next = waiters.shift();
    if (next) next();
  }
}

export async function processJob(jobId: string): Promise<void> {
  await withJobLock(async () => {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;
    if (job.status === "completed" || job.status === "failed") return;

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "running",
        startedAt: job.startedAt ?? new Date(),
        progress: "Reading script and building Google packs…",
        error: null,
        packageReady: false,
        packageUrl: null,
        packageError: null,
      },
    });

    try {
      const divided = await runScriptDivider({
        script: job.script,
        phase: (job.phase as "google-first" | "full") || "google-first",
        niche: job.niche,
      });

      await prisma.job.update({
        where: { id: jobId },
        data: {
          beatCount: divided.beats.length,
          googleCount: divided.result.googleSearches.length,
          aiCount: divided.result.aiGenerate.length,
          model: divided.model,
          beatsJson: divided.beats as unknown as Prisma.InputJsonValue,
          resultJson: divided.result as unknown as Prisma.InputJsonValue,
          usageJson: (divided.usage ??
            undefined) as unknown as Prisma.InputJsonValue | undefined,
          progress: `Previewing ${divided.result.googleSearches.length} Google queries…`,
        },
      });

      const previews: Record<string, GoogleSearchPreview> = {};
      const packs = divided.result.googleSearches
        .slice()
        .sort((a, b) => b.priority - a.priority);

      for (let i = 0; i < packs.length; i++) {
        const pack = packs[i];
        await prisma.job.update({
          where: { id: jobId },
          data: {
            progress: `Google preview ${i + 1}/${packs.length}: ${pack.query}`,
          },
        });

        try {
          previews[pack.query] = await searchGoogleImages(
            pack.query,
            PREVIEW_IMAGES_PER_QUERY,
          );
        } catch (err) {
          previews[pack.query] = {
            query: pack.query,
            provider: "searchapi_google_images",
            results: [],
            filteredOut: 0,
            error: err instanceof Error ? err.message : "Search failed",
          };
        }

        if (i < packs.length - 1) {
          await sleep(PREVIEW_QUERY_GAP_MS);
        }
      }

      let scenes = buildScenes({
        beats: divided.beats,
        result: divided.result,
        previews,
        niche: job.niche,
      });

      // Lock ~50/50 Google/AI before AI generation (excess Google → AI slots)
      scenes = balanceGoogleAiScenes(scenes);
      const mix = countSources(scenes);

      await prisma.job.update({
        where: { id: jobId },
        data: {
          previewsJson: previews as unknown as Prisma.InputJsonValue,
          scenesJson: scenes as unknown as Prisma.InputJsonValue,
          sceneCount: scenes.length,
          googleCount: mix.google,
          aiCount: mix.ai,
          previewDone: true,
          progress: `Scenes ${scenes.length} · Google ${mix.google} · AI ${mix.ai} — generating AI stills…`,
        },
      });

      const niche = getNiche(job.niche);
      const onProgress = async (message: string) => {
        await prisma.job.update({
          where: { id: jobId },
          data: { progress: message },
        });
      };

      scenes = await generateMissingAiStills({
        jobId: job.id,
        title: job.title,
        niche: job.niche,
        scenes,
        onProgress,
      });

      await prisma.job.update({
        where: { id: jobId },
        data: {
          scenesJson: scenes as unknown as Prisma.InputJsonValue,
          sceneCount: scenes.length,
          progress: "Building Remotion render package…",
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
          imagesOnly: true, // VO generation not wired yet
          createdAt: job.createdAt,
          onProgress,
        });

        scenes = handover.scenes;

        await prisma.job.update({
          where: { id: jobId },
          data: {
            status: "completed",
            scenesJson: scenes as unknown as Prisma.InputJsonValue,
            sceneCount: scenes.length,
            packageReady: true,
            packageUrl: handover.packageUrl,
            packageJson: handover.packageJson as unknown as Prisma.InputJsonValue,
            packageError: null,
            imagesOnly: handover.imagesOnly,
            voiceoverDurationSec: handover.voiceoverDurationSec,
            progress: `Package ready · scenes=${handover.packageJson.scenes.length} · vo=${handover.voiceoverDurationSec.toFixed(1)}s · wpm=${niche.wpm}`,
            completedAt: new Date(),
          },
        });
      } catch (packErr) {
        const issues =
          packErr instanceof HandoverPackagerError
            ? packErr.issues
            : [];
        const message =
          packErr instanceof Error
            ? packErr.message
            : "Render package failed";
        const detail = issues.length
          ? `${message}: ${issues.slice(0, 6).join("; ")}`
          : message;

        // Keep scene preview usable, but do not claim package ready.
        await prisma.job.update({
          where: { id: jobId },
          data: {
            status: "completed",
            scenesJson: scenes as unknown as Prisma.InputJsonValue,
            sceneCount: scenes.length,
            packageReady: false,
            packageUrl: null,
            packageError: detail,
            progress: "Done (package not ready)",
            completedAt: new Date(),
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Job failed";
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "failed",
          error: message,
          progress: "Failed",
          completedAt: new Date(),
        },
      });
    }
  });
}

/** Recover jobs stuck queued/running after a deploy restart. */
export async function resumePendingJobs(): Promise<void> {
  const pending = await prisma.job.findMany({
    where: { status: { in: ["queued", "running"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
    take: 10,
  });

  for (const job of pending) {
    // Fire and forget; lock serializes work
    void processJob(job.id);
  }
}
