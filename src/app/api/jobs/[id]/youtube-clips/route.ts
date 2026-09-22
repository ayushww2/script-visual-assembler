import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getYouTubeApiKey, getSearchApiKey } from "@/lib/env";
import { getContactBoxConfig } from "@/lib/contactbox";
import {
  suggestYouTubeClipsForScene,
  type SceneYouTubeSuggestions,
} from "@/lib/search/youtube";
import { buildHeroYouTubeClipSuggestions } from "@/lib/search/youtubeHeroClips";
import { mapPool } from "@/lib/jobs/pool";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

const BodySchema = z.object({
  /** hero = whole-script unique Costner-style plan; scene = per-scene search */
  mode: z.enum(["hero", "scene"]).optional().default("hero"),
  /** 1-based scene indexes. Omit to use start/limit. Only for mode=scene. */
  indexes: z.array(z.number().int().positive()).optional(),
  start: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(20).optional(),
  maxVideos: z.number().int().min(1).max(8).optional(),
});

function youtubeSearchConfigured() {
  return Boolean(getYouTubeApiKey() || getSearchApiKey());
}

/**
 * Suggest YouTube watch links + caption-aligned timestamps for editors.
 * Does NOT download or attach video files — metadata / deep-links only.
 */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const contact = getContactBoxConfig();
  return NextResponse.json({
    jobId: id,
    configured: true,
    youtubeApi: youtubeSearchConfigured(),
    contactBox: contact.configured,
    usage:
      "POST { mode?: 'hero'|'scene', indexes?: number[], start?: number, limit?: number, maxVideos?: number }",
    note: "Returns YouTube watch URLs with suggested start/end timestamps for manual editors. No video download. mode=hero plans one film hero and unique ~4s clips across the script.",
  });
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const json = await req.json().catch(() => ({}));
    const body = BodySchema.parse(json);

    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if (!job.scenesJson) {
      return NextResponse.json({ error: "Job has no scenes" }, { status: 400 });
    }

    const scenes = job.scenesJson as unknown as Array<{
      sceneId?: string;
      index?: number;
      words?: string;
      scriptText?: string;
      durationSec?: number;
    }>;

    const allLines = scenes.map((s, i) => ({
      sceneId: String(s.sceneId || s.index || i + 1),
      index: Number(s.index ?? i + 1),
      words: String(s.words || s.scriptText || "").trim(),
      durationSec: typeof s.durationSec === "number" ? s.durationSec : null,
    }));

    if (body.mode === "hero") {
      const lines = allLines.map((s) => s.words).filter(Boolean);
      if (!lines.length) {
        return NextResponse.json(
          { error: "No matching scenes with narration" },
          { status: 400 },
        );
      }

      const result = await buildHeroYouTubeClipSuggestions({
        title: job.title || "Untitled",
        lines,
      });

      return NextResponse.json({
        ok: true,
        jobId: id,
        title: job.title,
        mode: "hero",
        note: "Editors: open watchAtUrl and review the suggested ~4s window. Unique clips across the script. Nothing is downloaded.",
        heroName: result.plan.heroName,
        aliases: result.plan.aliases,
        videoLineCount: result.videoLineCount,
        imageOnlyCount: result.imageOnlyCount,
        picks: result.picks,
      });
    }

    // mode=scene — legacy per-scene suggestions
    let selected = allLines;

    if (body.indexes?.length) {
      const want = new Set(body.indexes);
      selected = selected.filter((s) => want.has(s.index));
    } else {
      const start = body.start ?? 0;
      const limit = body.limit ?? 5;
      selected = selected.slice(start, start + limit);
    }

    selected = selected.filter((s) => s.words);
    if (!selected.length) {
      return NextResponse.json(
        { error: "No matching scenes with narration" },
        { status: 400 },
      );
    }

    const topic = job.title || undefined;
    const results: SceneYouTubeSuggestions[] = await mapPool(
      selected,
      2,
      async (scene) =>
        suggestYouTubeClipsForScene({
          sceneId: scene.sceneId,
          index: scene.index,
          words: scene.words,
          durationSec: scene.durationSec,
          topic,
          maxVideos: body.maxVideos ?? 4,
        }),
    );

    return NextResponse.json({
      ok: true,
      jobId: id,
      title: job.title,
      mode: "scene",
      note: "Editors: open watchAtUrl and review the suggested window. Nothing is downloaded or packaged.",
      count: results.length,
      results,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues.map((i) => i.message).join("; ") },
        { status: 400 },
      );
    }
    const message =
      error instanceof Error ? error.message : "YouTube suggestions failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
