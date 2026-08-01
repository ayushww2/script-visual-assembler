import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toJobListItem } from "@/lib/jobs/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const existing = await prisma.job.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // Mark queued; instrumentation worker loop claims and awaits processJob.
    const job = await prisma.job.update({
      where: { id },
      data: {
        status: "queued",
        error: null,
        progress: "Re-queued — worker will claim shortly…",
        previewDone: false,
        packageReady: false,
        packageUrl: null,
        packageError: null,
        completedAt: null,
        startedAt: null,
      },
    });

    return NextResponse.json({ job: toJobListItem(job) }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retry failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
