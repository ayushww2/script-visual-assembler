import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { toJobDetail } from "@/lib/jobs/serialize";
import { buildScenes } from "@/lib/jobs/scenes";
import type { Beat, DividerResult } from "@/lib/divider/schema";
import type { GoogleSearchPreview } from "@/lib/search/google";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    let job = await prisma.job.findUnique({ where: { id } });
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // Backfill scenes for older completed jobs
    if (
      job.status === "completed" &&
      !job.scenesJson &&
      job.beatsJson &&
      job.resultJson
    ) {
      const scenes = buildScenes({
        beats: job.beatsJson as unknown as Beat[],
        result: job.resultJson as unknown as DividerResult,
        previews: (job.previewsJson as unknown as Record<
          string,
          GoogleSearchPreview
        >) || undefined,
      });
      job = await prisma.job.update({
        where: { id },
        data: {
          scenesJson: scenes as unknown as Prisma.InputJsonValue,
          sceneCount: scenes.length,
        },
      });
    }

    return NextResponse.json({ job: toJobDetail(job) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fetch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
