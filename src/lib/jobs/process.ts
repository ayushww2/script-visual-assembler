import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runScriptDivider } from "@/lib/divider/run";
import { searchGoogleImages } from "@/lib/search/google";
import {
  GOOGLE_SEARCH_CONCURRENCY,
  PREVIEW_IMAGES_PER_QUERY,
} from "@/lib/jobs/limits";
import type { GoogleSearchPreview } from "@/lib/search/google";
import { buildScenes } from "@/lib/jobs/scenes";
import { generateMissingAiStills } from "@/lib/jobs/aiStills";
import { balanceGoogleAiScenes, countSources } from "@/lib/jobs/balance";
import {
  mapPartsParallel,
  PARALLEL_PARTS,
} from "@/lib/jobs/parallelParts";
import { mapPool } from "@/lib/jobs/pool";
import {
  buildAndUploadRenderPackage,
  HandoverPackagerError,
} from "@/lib/package/handover";
import { getNiche } from "@/lib/niches";

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
  console.log("[jobs] processJob enter", jobId);
  await withJobLock(async () => {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      console.warn("[jobs] processJob missing", jobId);
      return;
    }
    if (job.status === "completed" || job.status === "failed") {
      console.log("[jobs] processJob skip terminal", jobId, job.status);
      return;
    }

    console.log("[jobs] processJob running", jobId, "was", job.status);

    try {
      const niche = getNiche(job.niche);
      const onProgress = async (message: string) => {
        await prisma.job.update({
          where: { id: jobId },
          data: { progress: message },
        });
      };

      // Resume when scenes already built (e.g. AI rate-limit mid-job).
      if (
        job.previewDone &&
        Array.isArray(job.scenesJson) &&
        (job.scenesJson as unknown[]).length > 0
      ) {
        let scenes = job.scenesJson as unknown as Awaited<
          ReturnType<typeof buildScenes>
        >;
        const missing = scenes.filter((s) => !s.imageUrl?.trim()).length;

        await prisma.job.update({
          where: { id: jobId },
          data: {
            status: "running",
            startedAt: job.startedAt ?? new Date(),
            error: null,
            packageReady: false,
            packageUrl: null,
            packageError: null,
            progress: job.aiBatch
              ? `Resuming AI Batch${job.aiBatchId ? ` ${job.aiBatchId}` : ""}…`
              : `Resuming AI stills · ${missing} remaining…`,
          },
        });

        scenes = await generateMissingAiStills({
          jobId: job.id,
          title: job.title,
          niche: job.niche,
          scenes,
          onProgress,
          parts: PARALLEL_PARTS,
          useBatch: Boolean(job.aiBatch),
          existingBatchId: job.aiBatchId,
          onBatchCreated: async (batchId) => {
            await prisma.job.update({
              where: { id: jobId },
              data: { aiBatchId: batchId },
            });
          },
        });

        await finishPackage({
          jobId,
          job,
          scenes,
          nicheWpm: niche.wpm,
          onProgress,
        });
        return;
      }

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
          aiBatchId: null,
        },
      });

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

      // Split Google packs into PARALLEL_PARTS and run every part at once.
      const googleParts = PARALLEL_PARTS;
      const googlePerPart = Math.max(
        1,
        Math.ceil(GOOGLE_SEARCH_CONCURRENCY / googleParts),
      );
      let googleDone = 0;
      let googleProgressAt = 0;

      await prisma.job.update({
        where: { id: jobId },
        data: {
          progress: `Google ×${googleParts} parts · ${packs.length} queries…`,
        },
      });

      await mapPartsParallel(packs, googleParts, async (shard, partIndex, partCount) => {
        await mapPool(shard, googlePerPart, async (pack) => {
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
          googleDone += 1;
          const now = Date.now();
          if (
            googleDone === packs.length ||
            googleDone === 1 ||
            now - googleProgressAt >= 2_000
          ) {
            googleProgressAt = now;
            await prisma.job.update({
              where: { id: jobId },
              data: {
                progress: `Google ×${partCount} parts · ${googleDone}/${packs.length} (part ${partIndex + 1})…`,
              },
            });
          }
        });
      });

      let scenes = buildScenes({
        beats: divided.beats,
        result: divided.result,
        previews,
        niche: job.niche,
        voiceoverDurationSec: job.voiceoverDurationSec,
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
          progress: job.aiBatch
            ? `Scenes ${scenes.length} · Google ${mix.google} · AI ${mix.ai} — AI Batch (50% cheaper)…`
            : `Scenes ${scenes.length} · Google ${mix.google} · AI ${mix.ai} — splitting into ${PARALLEL_PARTS} parallel parts…`,
        },
      });

      scenes = await generateMissingAiStills({
        jobId: job.id,
        title: job.title,
        niche: job.niche,
        scenes,
        onProgress,
        parts: PARALLEL_PARTS,
        useBatch: Boolean(job.aiBatch),
        existingBatchId: job.aiBatchId,
        onBatchCreated: async (batchId) => {
          await prisma.job.update({
            where: { id: jobId },
            data: { aiBatchId: batchId },
          });
        },
      });

      await finishPackage({
        jobId,
        job,
        scenes,
        nicheWpm: niche.wpm,
        onProgress,
      });
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

async function finishPackage(input: {
  jobId: string;
  job: {
    id: string;
    title: string | null;
    voiceoverUrl: string | null;
    voiceoverDurationSec: number | null;
    createdAt: Date;
  };
  scenes: Awaited<ReturnType<typeof buildScenes>>;
  nicheWpm: number;
  onProgress: (message: string) => Promise<void>;
}): Promise<void> {
  let scenes = input.scenes;

  await prisma.job.update({
    where: { id: input.jobId },
    data: {
      scenesJson: scenes as unknown as Prisma.InputJsonValue,
      sceneCount: scenes.length,
      progress: "Building Remotion render package…",
    },
  });

  try {
    const handover = await buildAndUploadRenderPackage({
      jobId: input.job.id,
      title: input.job.title,
      nicheWpm: input.nicheWpm,
      scenes,
      voiceoverUrl: input.job.voiceoverUrl,
      voiceoverDurationSec: input.job.voiceoverDurationSec,
      imagesOnly: true,
      createdAt: input.job.createdAt,
      onProgress: input.onProgress,
    });

    scenes = handover.scenes;

    await prisma.job.update({
      where: { id: input.jobId },
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
        progress: `Package ready · scenes=${handover.packageJson.scenes.length} · vo=${handover.voiceoverDurationSec.toFixed(1)}s · wpm=${input.nicheWpm}`,
        completedAt: new Date(),
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
      where: { id: input.jobId },
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
}

/** Recover jobs stuck queued/running after a deploy restart. */
export async function resumePendingJobs(): Promise<void> {
  const pending = await prisma.job.findMany({
    where: { status: { in: ["queued", "running"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
    take: 10,
  });

  if (pending.length === 0) return;
  console.log(
    "[jobs] resumePendingJobs",
    pending.map((j) => j.id).join(","),
  );

  // Await serially so Next request teardown cannot drop the work.
  for (const job of pending) {
    await processJob(job.id);
  }
}

const WORKER_IDLE_MS = 5_000;

/** Long-lived loop used by instrumentation — awaits each job to completion. */
export async function runJobWorkerLoop(): Promise<void> {
  console.log("[jobs] worker loop online");
  for (;;) {
    try {
      const job = await prisma.job.findFirst({
        where: { status: { in: ["queued", "running"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, progress: true },
      });

      if (!job) {
        await new Promise((r) => setTimeout(r, WORKER_IDLE_MS));
        continue;
      }

      console.log("[jobs] worker claim", job.id, job.status, job.progress);
      await processJob(job.id);
    } catch (error) {
      console.error("[jobs] worker iteration failed", error);
      await new Promise((r) => setTimeout(r, WORKER_IDLE_MS));
    }
  }
}
