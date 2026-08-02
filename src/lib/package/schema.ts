import { z } from "zod";

export const PACKAGE_VERSION = 2 as const;
export const DEFAULT_PACKAGE_WPM = 160;

/**
 * Remotion handoff scene — still required; optional short video clip.
 * When videoUrl is set, Remotion should play videoUseSec (default 5) and
 * loop for the rest of durationSec. imageUrl is the poster / fallback.
 */
export const RenderPackageSceneSchema = z.object({
  words: z.string().min(1),
  imageUrl: z.string().url().startsWith("https://"),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  durationSec: z.number().positive(),
  videoUrl: z.string().url().startsWith("https://").optional(),
  videoUseSec: z.number().positive().optional(),
  videoDurationSec: z.number().positive().optional(),
  videoLoop: z.boolean().optional(),
  videoSource: z.enum(["pexels"]).optional(),
});

export const RenderPackageSchema = z.object({
  version: z.literal(PACKAGE_VERSION).optional(),
  scenes: z.array(RenderPackageSceneSchema).min(1),
});

export type RenderPackageScene = z.infer<typeof RenderPackageSceneSchema>;
export type RenderPackage = z.infer<typeof RenderPackageSchema>;
