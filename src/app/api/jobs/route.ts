import { NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { deriveJobTitle } from "@/lib/jobs/title";
import { processJob } from "@/lib/jobs/process";
import { toJobListItem } from "@/lib/jobs/serialize";
import {
  countTodaysPreviewQueries,
  DAILY_QUERY_SOFT_LIMIT,
} from "@/lib/jobs/limits";
import { DEFAULT_NICHE, isValidNiche } from "@/lib/niches";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  try {
    const [jobs, usedToday] = await Promise.all([
      prisma.job.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      countTodaysPreviewQueries(),
    ]);

    return NextResponse.json({
      jobs: jobs.map(toJobListItem),
      capacity: {
        usedToday,
        softLimit: DAILY_QUERY_SOFT_LIMIT,
        remaining: Math.max(0, DAILY_QUERY_SOFT_LIMIT - usedToday),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "List failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      script?: string;
      title?: string;
      niche?: string;
      phase?: "google-first" | "full";
    };

    const script = body.script?.trim();
    if (!script) {
      return NextResponse.json({ error: "script is required" }, { status: 400 });
    }

    const niche = isValidNiche(body.niche) ? body.niche : DEFAULT_NICHE;

    if (script.length > 400_000) {
      return NextResponse.json(
        { error: "script is too large (max ~400k chars)" },
        { status: 400 },
      );
    }

    const usedToday = await countTodaysPreviewQueries();
    if (usedToday >= DAILY_QUERY_SOFT_LIMIT) {
      return NextResponse.json(
        {
          error: `Daily Google query soft limit reached (${DAILY_QUERY_SOFT_LIMIT}). Try again tomorrow.`,
          capacity: {
            usedToday,
            softLimit: DAILY_QUERY_SOFT_LIMIT,
            remaining: 0,
          },
        },
        { status: 429 },
      );
    }

    const job = await prisma.job.create({
      data: {
        title: body.title?.trim() || deriveJobTitle(script),
        niche,
        script,
        phase: body.phase || "google-first",
        status: "queued",
        progress: "Queued — waiting for cloud worker…",
      },
    });

    after(async () => {
      await processJob(job.id);
    });

    return NextResponse.json(
      {
        job: toJobListItem(job),
        capacity: {
          usedToday,
          softLimit: DAILY_QUERY_SOFT_LIMIT,
          remaining: Math.max(0, DAILY_QUERY_SOFT_LIMIT - usedToday),
        },
      },
      { status: 202 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Create failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
