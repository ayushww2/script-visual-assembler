import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/db";
import { toJobDetail } from "@/lib/jobs/serialize";
import { repackageJob } from "@/lib/package/repackage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/** Rebuild + upload render package for a job that already has scenes. */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if (!job.scenesJson) {
      return NextResponse.json(
        { error: "Job has no scenes yet" },
        { status: 409 },
      );
    }

    after(async () => {
      try {
        await repackageJob(id);
      } catch {
        // error persisted on job
      }
    });

    const updated = await prisma.job.findUnique({ where: { id } });
    return NextResponse.json(
      { job: updated ? toJobDetail(updated) : null },
      { status: 202 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Package rebuild failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
