import { prisma } from "@/lib/db";

/** Soft capacity for Google previews / day. */
export const DAILY_QUERY_SOFT_LIMIT = 2500;
export const MAX_CONCURRENT_JOBS = 1;

/** Fetch candidates; keep ONE best landscape / no-watermark hit per scene. */
export const PREVIEW_IMAGES_PER_QUERY = 8;
/** Parallel Google searches — target whole Google phase under ~1–2 min. */
export const GOOGLE_SEARCH_CONCURRENCY = 12;

/** ContactBox engineer + gpt-image-2 in parallel — target AI phase under ~8–10 min. */
export const AI_STILL_CONCURRENCY = 8;
/** Parallel director batches. */
export const DIRECTOR_BATCH_CONCURRENCY = 4;
/** Parallel R2 still packaging. */
export const PACKAGE_STILL_CONCURRENCY = 12;

export async function countTodaysPreviewQueries(): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);

  const jobs = await prisma.job.findMany({
    where: {
      createdAt: { gte: start },
      status: { in: ["completed", "running", "queued"] },
    },
    select: { googleCount: true },
  });

  return jobs.reduce((n, j) => n + (j.googleCount || 0), 0);
}
