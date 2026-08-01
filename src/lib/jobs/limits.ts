import { prisma } from "@/lib/db";

/** Soft capacity target: ~30–40 Google query previews / day. */
export const DAILY_QUERY_SOFT_LIMIT = 40;
export const MAX_CONCURRENT_JOBS = 1;
export const PREVIEW_IMAGES_PER_QUERY = 5;
export const PREVIEW_QUERY_GAP_MS = 350;

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
