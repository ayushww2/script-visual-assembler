import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { scanAllScenes, type SceneScanInput } from "@/lib/jobs/sceneScan";
import { getContactBoxConfig } from "@/lib/contactbox";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/** POST — ContactBox vision QA over scene stills vs narration words. ?start=0&limit=50 for chunks. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const start = Math.max(0, Number(url.searchParams.get("start") || 0) || 0);
  const limitParam = url.searchParams.get("limit");
  const limit =
    limitParam === null || limitParam === ""
      ? undefined
      : Math.max(1, Number(limitParam) || 50);
  const contactbox = getContactBoxConfig();
  if (!contactbox.configured) {
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

    const raw = (job.scenesJson as unknown as Array<Record<string, unknown>>) || [];
    if (!raw.length) {
      return NextResponse.json({ error: "Job has no scenes" }, { status: 400 });
    }

    const scenes: SceneScanInput[] = raw.map((s, i) => ({
      sceneId: String(s.sceneId || s.index || i + 1),
      index: Number(s.index ?? i + 1),
      words: String(s.words || s.scriptText || "").trim(),
      imageUrl: String(s.imageUrl || ""),
      visualSource: s.visualSource ? String(s.visualSource) : undefined,
      subject: s.subject ? String(s.subject) : undefined,
      query: s.query ? String(s.query) : undefined,
    }));

    const withImages = scenes.filter((s) => s.imageUrl && s.words);
    const slice =
      limit !== undefined
        ? withImages.slice(start, start + limit)
        : withImages.slice(start);
    const result = await scanAllScenes(slice, {
      batchSize: Math.min(3, slice.length || 1),
      concurrency: 1,
    });

    return NextResponse.json({
      jobId: id,
      title: job.title,
      start,
      limit: limit ?? slice.length,
      totalScenes: withImages.length,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scan failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
