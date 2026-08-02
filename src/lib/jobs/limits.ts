import { prisma } from "@/lib/db";

/** Soft capacity for Google previews / day. */
export const DAILY_QUERY_SOFT_LIMIT = 2500;
/** How many scripts can process in parallel on one worker. */
export const MAX_CONCURRENT_JOBS = Math.max(
  1,
  Math.min(5, Number(process.env.MAX_CONCURRENT_JOBS || 3) || 3),
);

/** Fetch candidates; keep ONE best landscape hit; extras allow same-search repick. */
export const PREVIEW_IMAGES_PER_QUERY = Math.max(
  8,
  Number(process.env.PREVIEW_IMAGES_PER_QUERY || 12) || 12,
);
/** Parallel Google searches — target whole Google phase under ~1–2 min. */
export const GOOGLE_SEARCH_CONCURRENCY = Math.max(
  1,
  Number(process.env.GOOGLE_SEARCH_CONCURRENCY || 20) || 20,
);

/**
 * gpt-image-2 in-flight cap.
 * Org limit is ~20 images/min — keep concurrency low so we don't trip 429s.
 * Override with AI_STILL_CONCURRENCY env.
 */
export const AI_STILL_CONCURRENCY = Math.max(
  1,
  Number(process.env.AI_STILL_CONCURRENCY || 4) || 4,
);
/**
 * When true, each AI still calls ContactBox to engineer the prompt (~15–18s each).
 * Default off — local Mystery realism lock is fast enough and required for <10 min jobs.
 */
export const AI_PROMPT_ENGINEER =
  process.env.AI_PROMPT_ENGINEER === "1" ||
  process.env.AI_PROMPT_ENGINEER === "true";
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
