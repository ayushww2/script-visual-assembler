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

    // If scenes already built, resume AI/package only (skip director + Google).
    const resumeScenes =
      existing.previewDone &&
      Array.isArray(existing.scenesJson) &&
      (existing.scenesJson as unknown[]).length > 0;

    const job = await prisma.job.update({
      where: { id },
      data: {
        status: "queued",
        error: null,
        progress: resumeScenes
          ? "Re-queued — resuming AI stills from saved scenes…"
          : "Re-queued — worker will claim shortly…",
        previewDone: resumeScenes ? true : false,
        packageReady: false,
        packageUrl: null,
        packageError: null,
        completedAt: null,
        // Keep startedAt on resume so wall-time stays honest-ish
        startedAt: resumeScenes ? existing.startedAt : null,
      },
    });

    return NextResponse.json({ job: toJobListItem(job) }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retry failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
