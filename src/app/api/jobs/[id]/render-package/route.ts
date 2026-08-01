import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Machine handoff for Remotion:
 * - Accept: application/json → { packageUrl, packageReady, ... }
 * - Otherwise 302 redirect to the public package.json URL when ready
 */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const job = await prisma.job.findUnique({
      where: { id },
      select: {
        id: true,
        packageReady: true,
        packageUrl: true,
        packageError: true,
        sceneCount: true,
        voiceoverDurationSec: true,
        imagesOnly: true,
        niche: true,
      },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const accept = req.headers.get("accept") || "";
    const wantsJson =
      accept.includes("application/json") ||
      new URL(req.url).searchParams.get("format") === "json";

    if (!job.packageReady || !job.packageUrl) {
      return NextResponse.json(
        {
          packageReady: false,
          packageUrl: null,
          error: job.packageError || "Render package not ready",
          jobId: job.id,
        },
        { status: 409 },
      );
    }

    if (wantsJson) {
      return NextResponse.json({
        packageReady: true,
        packageUrl: job.packageUrl,
        jobId: job.id,
        sceneCount: job.sceneCount,
        voiceoverDurationSec: job.voiceoverDurationSec,
      });
    }

    return NextResponse.redirect(job.packageUrl, 302);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load package";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
