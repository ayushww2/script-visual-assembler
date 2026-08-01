import type { Job } from "@prisma/client";
import type { JobListItem } from "./types";
import {
  toJobExportPayload,
  type SceneRecord,
} from "@/lib/jobs/scenes";
import { getNiche } from "@/lib/niches";
import type { RenderPackage } from "@/lib/package/schema";

export function toJobListItem(job: Job): JobListItem {
  return {
    id: job.id,
    title: job.title,
    niche: job.niche,
    status: job.status,
    phase: job.phase,
    beatCount: job.beatCount,
    sceneCount: job.sceneCount,
    googleCount: job.googleCount,
    aiCount: job.aiCount,
    model: job.model,
    error: job.error,
    progress: job.progress,
    previewDone: job.previewDone,
    packageReady: job.packageReady,
    packageUrl: job.packageUrl,
    packageError: job.packageError,
    imagesOnly: job.imagesOnly,
    voiceoverDurationSec: job.voiceoverDurationSec,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

export function toJobDetail(job: Job) {
  const scenes = (job.scenesJson as unknown as SceneRecord[] | null) || null;
  const niche = getNiche(job.niche);
  const packageJson =
    (job.packageJson as unknown as RenderPackage | null) || null;
  return {
    ...toJobListItem(job),
    script: job.script,
    scriptFull: job.script,
    wpm: niche.wpm,
    voiceoverUrl: job.voiceoverUrl,
    beats: job.beatsJson,
    result: job.resultJson,
    previews: job.previewsJson,
    scenes,
    packageJson,
    export:
      scenes && scenes.length
        ? toJobExportPayload({
            title: job.title,
            script: job.script,
            niche: job.niche,
            scenes,
          })
        : null,
    usage: job.usageJson,
  };
}
