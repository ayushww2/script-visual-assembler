import type { Beat, DividerResult } from "@/lib/divider/schema";
import type { GoogleSearchPreview } from "@/lib/search/google";

export type JobUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type JobResultPayload = {
  beats: Beat[];
  result: DividerResult;
  model: string;
  usage?: JobUsage;
  previews?: Record<string, GoogleSearchPreview>;
};

export type JobListItem = {
  id: string;
  title: string | null;
  niche: string;
  status: string;
  phase: string;
  beatCount: number;
  sceneCount: number;
  googleCount: number;
  aiCount: number;
  model: string | null;
  error: string | null;
  progress: string | null;
  previewDone: boolean;
  packageReady: boolean;
  packageUrl: string | null;
  packageError: string | null;
  imagesOnly: boolean;
  voiceoverDurationSec: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};
