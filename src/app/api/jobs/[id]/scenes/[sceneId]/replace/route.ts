import { NextResponse } from "next/server";
import { z } from "zod";
import { replaceSceneWithAi } from "@/lib/jobs/replaceSceneAi";
import { prisma } from "@/lib/db";
import { toJobDetail } from "@/lib/jobs/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string; sceneId: string }> };

const BodySchema = z.object({
  visualIdea: z.string().min(3).max(800),
  subject: z.string().min(1).max(200).optional(),
  why: z.string().min(1).max(400).optional(),
  /** Default patch (update one scene URL). "full" re-uploads every still. */
  repackage: z.union([z.boolean(), z.enum(["full", "patch"])]).optional(),
});

/**
 * Force-replace one scene still with a fresh AI documentary image.
 * Body: { visualIdea, subject?, why?, repackage? }
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id, sceneId } = await params;
    const json = await req.json().catch(() => ({}));
    const body = BodySchema.parse(json);

    const result = await replaceSceneWithAi({
      jobId: id,
      sceneRef: sceneId,
      visualIdea: body.visualIdea,
      subject: body.subject,
      why: body.why,
      repackage: body.repackage,
    });

    const job = await prisma.job.findUnique({ where: { id } });
    return NextResponse.json({
      ok: true,
      scene: result.scene,
      packageReady: result.packageReady,
      job: job ? toJobDetail(job) : null,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues.map((i) => i.message).join("; ") },
        { status: 400 },
      );
    }
    const message =
      error instanceof Error ? error.message : "Scene replace failed";
    const status = /not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
