import { prisma } from "@/lib/db";

/** Soft capacity for Google previews / day (one image per google scene). */
export const DAILY_QUERY_SOFT_LIMIT = 2500;
export const MAX_CONCURRENT_JOBS = 1;
/** One hit is enough for the Remotion package — saves SearchAPI quota. */
export const PREVIEW_IMAGES_PER_QUERY = 1;
export const PREVIEW_QUERY_GAP_MS = 200;

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
