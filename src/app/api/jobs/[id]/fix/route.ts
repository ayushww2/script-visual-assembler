import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { toJobDetail } from "@/lib/jobs/serialize";
import {
  runIssueFixer,
  MAX_ISSUE_FIXER_GOOGLE_QUERIES,
} from "@/lib/jobs/fixReviewIssues";
import { getSearchApiKey } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

type Params = { params: Promise<{ id: string }> };

const IssueSchema = z.object({
  sceneId: z.string(),
  index: z.number(),
  severity: z.enum(["major", "minor"]),
  category: z.string(),
  issue: z.string(),
  words: z.string(),
  startSec: z.number().optional(),
  endSec: z.number().optional(),
  visualSource: z.string().optional(),
  fixType: z.enum(["google_requery", "google_repick", "ai_regenerate", "none"]),
  suggestedQuery: z.string().optional(),
  imageUrl: z.string().optional(),
});

const BodySchema = z.object({
  maxGoogleQueries: z
    .number()
    .int()
    .min(1)
    .max(MAX_ISSUE_FIXER_GOOGLE_QUERIES)
    .optional(),
  /** Pass the client-side scan result when server /review has no persisted issues. */
  majorIssues: z.array(IssueSchema).optional(),
  /** Continue fixing a previously query-capped batch. */
  onlyIndexes: z.array(z.number()).optional(),
});

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  return NextResponse.json({
    jobId: id,
    maxGoogleQueries: MAX_ISSUE_FIXER_GOOGLE_QUERIES,
    usage: "POST { maxGoogleQueries?, majorIssues?, onlyIndexes? }",
  });
}

/** Auto-fix Google-photo issues found by the scan/review, capped at 100 fresh searches per run. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!getSearchApiKey()) {
      return NextResponse.json(
        { error: "SEARCHAPI_API_KEY is not configured" },
        { status: 503 },
      );
    }

    const json = await req.json().catch(() => ({}));
    const body = BodySchema.parse(json);

    const result = await runIssueFixer({
      jobId: id,
      maxGoogleQueries: body.maxGoogleQueries,
      majorIssues: body.majorIssues as never,
      onlyIndexes: body.onlyIndexes,
    });

    const job = await prisma.job.findUnique({ where: { id } });
    return NextResponse.json({
      ok: true,
      result,
      job: job ? toJobDetail(job) : null,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues.map((i) => i.message).join("; ") },
        { status: 400 },
      );
    }
    const message = error instanceof Error ? error.message : "Issue fixer failed";
    const status = /not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
