import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { queueJobReview } from "@/lib/jobs/runReview";
import { getContactBoxConfig } from "@/lib/contactbox";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/** GET — final review status + results. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = await prisma.job.findUnique({
    where: { id },
    select: { id: true, title: true, reviewStatus: true, reviewJson: true, sceneCount: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  return NextResponse.json({
    jobId: job.id,
    title: job.title,
    sceneCount: job.sceneCount,
    reviewStatus: job.reviewStatus,
    review: job.reviewJson,
  });
}

/** POST — queue a background final review (all scenes vs words + topic). */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  if (!getContactBoxConfig().configured) {
    return NextResponse.json(
      { error: "CONTACTBOX_API_KEY is not configured" },
      { status: 503 },
    );
  }

  try {
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if (job.reviewStatus === "queued" || job.reviewStatus === "running") {
      return NextResponse.json(
        {
          jobId: id,
          reviewStatus: job.reviewStatus,
          message: "Review already in progress",
          review: job.reviewJson,
        },
        { status: 202 },
      );
    }

    await queueJobReview(id);

    return NextResponse.json(
      {
        jobId: id,
        reviewStatus: "queued",
        message: "Final review queued — worker will scan all scenes",
      },
      { status: 202 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Review queue failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
