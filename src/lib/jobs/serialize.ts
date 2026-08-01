import type { Job } from "@prisma/client";
import type { JobListItem } from "./types";

export function toJobListItem(job: Job): JobListItem {
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    phase: job.phase,
    beatCount: job.beatCount,
    googleCount: job.googleCount,
    aiCount: job.aiCount,
    model: job.model,
    error: job.error,
    progress: job.progress,
    previewDone: job.previewDone,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

export function toJobDetail(job: Job) {
  return {
    ...toJobListItem(job),
    script: job.script,
    beats: job.beatsJson,
    result: job.resultJson,
    previews: job.previewsJson,
    usage: job.usageJson,
  };
}
