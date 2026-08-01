import { z } from "zod";

export const PACKAGE_VERSION = 1 as const;
export const DEFAULT_PACKAGE_WPM = 160;

export const SceneSourceSchema = z.enum([
  "google",
  "ai",
  "library",
  "other",
]);

export const RenderPackageSceneSchema = z.object({
  sceneId: z.string().min(1),
  index: z.number().int().positive(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  durationSec: z.number().positive(),
  words: z.string().min(1),
  wordCount: z.number().int().positive(),
  imageUrl: z.string().url().startsWith("https://"),
  source: SceneSourceSchema,
  subject: z.string().optional(),
  altText: z.string().optional(),
});

export const RenderPackageSchema = z.object({
  version: z.literal(PACKAGE_VERSION),
  jobId: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().min(1),
  wpm: z.number().positive(),
  mode: z.enum(["full", "images-only"]),
  voiceoverUrl: z.string(),
  voiceoverDurationSec: z.number().nonnegative(),
  sceneCount: z.number().int().positive(),
  scenes: z.array(RenderPackageSceneSchema).min(1),
});

export type SceneSource = z.infer<typeof SceneSourceSchema>;
export type RenderPackageScene = z.infer<typeof RenderPackageSceneSchema>;
export type RenderPackage = z.infer<typeof RenderPackageSchema>;
