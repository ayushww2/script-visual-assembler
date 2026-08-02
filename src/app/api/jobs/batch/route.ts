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

/** Max scripts queued in one multi-DOCX submit. */
export const MAX_BATCH_JOBS = 10;

function parseVoiceoverDuration(
  sec?: number,
  shorthand?: string,
): number | null {
  if (typeof sec === "number" && Number.isFinite(sec) && sec > 0) return sec;
  const raw = (shorthand || "").trim();
  if (!raw) return null;
  const parts = raw.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Queue up to 10 jobs at once (multi-DOCX / multi-script submit).
 * Body: { jobs: [{ script, title?, niche?, aiBatch?, ... }], niche?, aiBatch? }
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      jobs?: Array<{
        script?: string;
        title?: string;
        niche?: string;
        phase?: "google-first" | "full";
        voiceoverDurationSec?: number;
        voiceoverDuration?: string;
        aiBatch?: boolean;
      }>;
      niche?: string;
      aiBatch?: boolean;
      phase?: "google-first" | "full";
    };

    const items = Array.isArray(body.jobs) ? body.jobs : [];
    if (!items.length) {
      return NextResponse.json(
        { error: "jobs array is required (1–10 scripts)" },
        { status: 400 },
      );
    }
    if (items.length > MAX_BATCH_JOBS) {
      return NextResponse.json(
        { error: `Max ${MAX_BATCH_JOBS} scripts per batch` },
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

    const defaultNiche = isValidNiche(body.niche) ? body.niche : DEFAULT_NICHE;
    const defaultAiBatch = Boolean(body.aiBatch);
    const defaultPhase = body.phase || "google-first";

    const created = [];
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const script = item.script?.trim();
      if (!script) {
        errors.push({ index: i, error: "script is required" });
        continue;
      }
      if (script.length > 400_000) {
        errors.push({ index: i, error: "script is too large (max ~400k chars)" });
        continue;
      }

      const niche = isValidNiche(item.niche) ? item.niche : defaultNiche;
      const aiBatch =
        item.aiBatch !== undefined ? Boolean(item.aiBatch) : defaultAiBatch;
      const voiceoverDurationSec = parseVoiceoverDuration(
        item.voiceoverDurationSec,
        item.voiceoverDuration,
      );

      try {
        const job = await prisma.job.create({
          data: {
            title: item.title?.trim() || deriveJobTitle(script),
            niche,
            script,
            phase: item.phase || defaultPhase,
            status: "queued",
            progress: aiBatch
              ? "Queued — AI Batch mode (50% cheaper, up to 24h)…"
              : "Queued — cloud worker will claim shortly…",
            voiceoverDurationSec,
            aiBatch,
          },
        });
        created.push(toJobListItem(job));
      } catch (err) {
        errors.push({
          index: i,
          error: err instanceof Error ? err.message : "Create failed",
        });
      }
    }

    if (!created.length) {
      return NextResponse.json(
        {
          error: errors[0]?.error || "No jobs created",
          errors,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        jobs: created,
        created: created.length,
        errors: errors.length ? errors : undefined,
        capacity: {
          usedToday,
          softLimit: DAILY_QUERY_SOFT_LIMIT,
          remaining: Math.max(0, DAILY_QUERY_SOFT_LIMIT - usedToday),
        },
      },
      { status: 202 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Batch submit failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
