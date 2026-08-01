import type { SceneRecord } from "@/lib/jobs/scenes";
import { uploadToR2 } from "@/lib/r2";
import {
  DEFAULT_PACKAGE_WPM,
  PACKAGE_VERSION,
  type RenderPackage,
  type SceneSource,
} from "./schema";
import { timeChunksAtWpm } from "./timing";
import {
  downloadAndUploadStill,
  packageJsonKey,
} from "./stills";
import { validateRenderPackage } from "./validate";

export type HandoverInput = {
  jobId: string;
  title?: string | null;
  nicheWpm?: number | null;
  scenes: SceneRecord[];
  voiceoverUrl?: string | null;
  voiceoverDurationSec?: number | null;
  /** Default true until VO generation is wired. */
  imagesOnly?: boolean;
  createdAt?: Date | string;
  onProgress?: (message: string) => Promise<void> | void;
};

export type HandoverResult = {
  packageUrl: string;
  packageJson: RenderPackage;
  scenes: SceneRecord[];
  imagesOnly: boolean;
};

export class HandoverPackagerError extends Error {
  issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "HandoverPackagerError";
    this.issues = issues;
  }
}

export async function buildAndUploadRenderPackage(
  input: HandoverInput,
): Promise<HandoverResult> {
  const imagesOnly =
    input.imagesOnly ??
    !(input.voiceoverUrl && input.voiceoverUrl.startsWith("https://"));
  const wpm = input.nicheWpm || DEFAULT_PACKAGE_WPM;
  const scenes = [...input.scenes].sort((a, b) => a.index - b.index);

  if (!scenes.length) {
    throw new HandoverPackagerError("sceneCount == 0", ["No scenes to package"]);
  }

  const missing = scenes.filter((s) => !s.imageUrl?.trim());
  if (missing.length) {
    throw new HandoverPackagerError(
      `${missing.length} scene(s) missing imageUrl`,
      missing.map((s) => `scene ${s.sceneId}: missing imageUrl`),
    );
  }

  await input.onProgress?.(
    `Packaging: uploading ${scenes.length} stills to R2…`,
  );

  const r2BySceneId = new Map<string, string>();
  const updatedScenes: SceneRecord[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    await input.onProgress?.(
      `Packaging still ${i + 1}/${scenes.length}: scene ${scene.sceneId}`,
    );
    const uploaded = await downloadAndUploadStill({
      jobId: input.jobId,
      sceneId: scene.sceneId,
      index: scene.index,
      sourceUrl: scene.imageUrl!,
      fallbackUrls: [
        scene.thumbnailUrl || "",
        ...(scene.imageCandidates || []),
      ].filter(Boolean),
      referer: scene.sourceUrl,
    });
    r2BySceneId.set(scene.sceneId, uploaded.url);
    updatedScenes.push({
      ...scene,
      r2Url: uploaded.url,
      imageUrl: uploaded.url,
      thumbnailUrl: uploaded.url,
    });
  }

  const timed = timeChunksAtWpm(
    updatedScenes.map((s) => s.words),
    wpm,
    input.voiceoverDurationSec,
  );

  const packageScenes = updatedScenes.map((scene, i) => {
    const t = timed[i];
    return {
      sceneId: scene.sceneId,
      index: scene.index,
      startSec: t.startSec,
      endSec: t.endSec,
      durationSec: t.durationSec,
      words: t.words,
      wordCount: t.wordCount,
      imageUrl: r2BySceneId.get(scene.sceneId)!,
      source: toPackageSource(scene.visualSource),
      subject: scene.subject || scene.query || undefined,
    };
  });

  // Keep SceneRecord timing in sync with package
  for (let i = 0; i < updatedScenes.length; i++) {
    const t = timed[i];
    updatedScenes[i] = {
      ...updatedScenes[i],
      startSec: t.startSec,
      endSec: t.endSec,
      durationSec: t.durationSec,
      wordCount: t.wordCount,
      timingSource: "wpm",
    };
  }

  const computedTotal = packageScenes.length
    ? packageScenes[packageScenes.length - 1].endSec
    : 0;

  const pkg: RenderPackage = {
    version: PACKAGE_VERSION,
    jobId: input.jobId,
    title: input.title?.trim() || "Untitled",
    createdAt: new Date(input.createdAt || Date.now()).toISOString(),
    wpm,
    mode: imagesOnly ? "images-only" : "full",
    voiceoverUrl: imagesOnly ? "" : input.voiceoverUrl || "",
    voiceoverDurationSec: imagesOnly
      ? computedTotal
      : input.voiceoverDurationSec || computedTotal,
    sceneCount: packageScenes.length,
    scenes: packageScenes,
  };

  await input.onProgress?.("Packaging: validating render package…");
  const issues = await validateRenderPackage(pkg, {
    checkImageReachability: true,
  });
  if (issues.length) {
    throw new HandoverPackagerError(
      `Package validation failed (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
      issues.map((i) => i.message),
    );
  }

  await input.onProgress?.("Packaging: uploading package.json…");
  const key = packageJsonKey(input.jobId);
  const uploadedPkg = await uploadToR2({
    key,
    body: JSON.stringify(pkg, null, 2),
    contentType: "application/json; charset=utf-8",
    cacheControl: "public, max-age=60",
  });

  return {
    packageUrl: uploadedPkg.url,
    packageJson: pkg,
    scenes: updatedScenes,
    imagesOnly,
  };
}

function toPackageSource(
  visualSource: SceneRecord["visualSource"],
): SceneSource {
  if (visualSource === "google") return "google";
  if (visualSource === "ai") return "ai";
  return "other";
}
