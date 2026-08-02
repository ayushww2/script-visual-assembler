import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deriveJobTitle } from "@/lib/jobs/title";
import { toJobListItem } from "@/lib/jobs/serialize";
import {
  countTodaysPreviewQueries,
  DAILY_QUERY_SOFT_LIMIT,
} from "@/lib/jobs/limits";
import { DEFAULT_NICHE, isValidNiche } from "@/lib/niches";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

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
      phase?: "google-first" | "full" | "ai-only" | "google-only";
      /** Total VO length in seconds (e.g. 1575 for 26:15). Scene times rescale to fit. */
      voiceoverDurationSec?: number;
      /** Optional "MM:SS" or "H:MM:SS" shorthand. */
      voiceoverDuration?: string;
      /** OpenAI Batch API for AI stills — ~50% cheaper, up to 24h. */
      aiBatch?: boolean;
      /** Skip Google — every scene is gpt-image-2. */
      forceAllAi?: boolean;
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

    // Celebrity experiment is Google-only unless explicitly all-AI.
    const phase: "google-first" | "full" | "ai-only" | "google-only" =
      body.forceAllAi
        ? "ai-only"
        : body.phase === "google-only" || niche === "celebrity"
          ? "google-only"
          : body.phase === "ai-only" || body.phase === "full"
            ? body.phase
            : "google-first";

    const usedToday = await countTodaysPreviewQueries();
    if (!body.forceAllAi && phase !== "ai-only" && usedToday >= DAILY_QUERY_SOFT_LIMIT) {
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

    const voiceoverDurationSec = parseVoiceoverDuration(
      body.voiceoverDurationSec,
      body.voiceoverDuration,
    );

    const aiBatch = phase === "google-only" ? false : Boolean(body.aiBatch);
    const job = await prisma.job.create({
      data: {
        title: body.title?.trim() || deriveJobTitle(script),
        niche,
        script,
        phase,
        status: "queued",
        progress:
          phase === "ai-only"
            ? aiBatch
              ? "Queued — all AI · Batch mode (50% off, up to 24h)…"
              : "Queued — all AI · realtime gpt-image-2…"
            : phase === "google-only"
              ? "Queued — Google-only celebrity experiment…"
              : aiBatch
                ? "Queued — AI Batch mode (50% cheaper, up to 24h)…"
                : "Queued — cloud worker will claim shortly…",
        voiceoverDurationSec,
        aiBatch,
      },
    });

    // Instrumentation worker loop claims queued jobs; no after()/fire-and-forget.

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

/** Accept seconds number or "MM:SS" / "H:MM:SS". */
export function parseVoiceoverDuration(
  seconds?: number,
  clock?: string,
): number | null {
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return seconds;
  }
  const raw = (clock || "").trim();
  if (!raw) return null;
  const parts = raw.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}
