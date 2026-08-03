import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  runFinalReview,
  scenesToReviewInput,
  type FinalReviewResult,
} from "@/lib/jobs/finalReview";
import type { SceneRecord } from "@/lib/jobs/scenes";

const activeReviews = new Set<string>();

export async function queueJobReview(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");
  if (!Array.isArray(job.scenesJson) || !(job.scenesJson as unknown[]).length) {
    throw new Error("Job has no scenes to review");
  }

  await prisma.job.update({
    where: { id: jobId },
    data: {
      reviewStatus: "queued",
      reviewJson: {
        queuedAt: new Date().toISOString(),
        progress: "Queued for final review…",
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function processJobReview(jobId: string): Promise<void> {
  if (activeReviews.has(jobId)) return;
  activeReviews.add(jobId);

  try {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;
    if (job.reviewStatus !== "queued" && job.reviewStatus !== "running") return;

    const scenes = job.scenesJson as unknown as SceneRecord[];
    if (!scenes?.length) {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          reviewStatus: "failed",
          reviewJson: { error: "No scenes" } as unknown as Prisma.InputJsonValue,
        },
      });
      return;
    }

    await prisma.job.update({
      where: { id: jobId },
      data: {
        reviewStatus: "running",
        reviewJson: {
          progress: "Starting final review…",
          startedAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const onProgress = async (message: string) => {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          reviewJson: {
            progress: message,
            startedAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
        },
      });
    };

    const result: FinalReviewResult = await runFinalReview({
      topic: job.title || "Untitled documentary",
      scenes: scenesToReviewInput(scenes),
      onProgress,
      llmBatchSize: 6,
    });

    await prisma.job.update({
      where: { id: jobId },
      data: {
        reviewStatus: "completed",
        reviewJson: result as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Review failed";
    console.error("[review] failed", jobId, error);
    await prisma.job.update({
      where: { id: jobId },
      data: {
        reviewStatus: "failed",
        reviewJson: {
          error: message,
          failedAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
      },
    });
  } finally {
    activeReviews.delete(jobId);
  }
}

/** Claim queued reviews alongside the main job worker. */
export async function runReviewWorkerLoop(): Promise<void> {
  console.log("[review] worker loop started");
  for (;;) {
    try {
      const next = await prisma.job.findFirst({
        where: { reviewStatus: "queued" },
        orderBy: { updatedAt: "asc" },
        select: { id: true },
      });
      if (next) {
        await processJobReview(next.id);
        continue;
      }
    } catch (error) {
      console.error("[review] worker tick error", error);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
