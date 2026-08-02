import { z } from "zod";

export const PACKAGE_VERSION = 1 as const;
export const DEFAULT_PACKAGE_WPM = 160;

/** Minimal Remotion handoff scene — timing + words + image (+ optional B-roll). */
export const RenderPackageSceneSchema = z.object({
  words: z.string().min(1),
  imageUrl: z.string().url().startsWith("https://"),
  /** Optional Pexels (or other) B-roll clip, already trimmed ~5–6s. */
  videoUrl: z.string().url().startsWith("https://").optional(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  durationSec: z.number().positive(),
});

export const RenderPackageSchema = z.object({
  scenes: z.array(RenderPackageSceneSchema).min(1),
});

export type RenderPackageScene = z.infer<typeof RenderPackageSceneSchema>;
export type RenderPackage = z.infer<typeof RenderPackageSchema>;
