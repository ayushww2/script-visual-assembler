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

      const scenes = buildScenes({
        beats: divided.beats,
        result: divided.result,
        previews,
      });

      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "completed",
          previewDone: true,
          previewsJson: previews as unknown as Prisma.InputJsonValue,
          scenesJson: scenes as unknown as Prisma.InputJsonValue,
          sceneCount: scenes.length,
          progress: "Done",
          completedAt: new Date(),
        },
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
