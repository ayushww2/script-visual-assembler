import type { SceneRecord } from "@/lib/jobs/scenes";
import { PACKAGE_STILL_CONCURRENCY } from "@/lib/jobs/limits";
import { getR2Config, uploadToR2 } from "@/lib/r2";
import {
  DEFAULT_PACKAGE_WPM,
  type RenderPackage,
} from "./schema";
import { timeChunksAtWpm } from "./timing";
import {
  downloadAndUploadStill,
  packageJsonKey,
  stillKey,
} from "./stills";
import { maybeCompressStillForRemotion } from "./compressStill";
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
  voiceoverDurationSec: number;
};

export class HandoverPackagerError extends Error {
  issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "HandoverPackagerError";
    this.issues = issues;
  }
}

function alreadyOnOurR2(url: string): boolean {
  try {
    const base = getR2Config().publicBaseUrl;
    return Boolean(base && url.startsWith(base));
  } catch {
    return false;
  }
}

/** Download an R2 still, JPEG-recompress if smaller, reupload as .jpg when it wins. */
async function recompressExistingR2Still(input: {
  jobId: string;
  index: number;
  sourceUrl: string;
}): Promise<{ url: string; compressed: boolean }> {
  const res = await fetch(input.sourceUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
    headers: { Accept: "image/*,*/*;q=0.8" },
  });
  if (!res.ok) throw new Error(`R2 still HTTP ${res.status}`);
  const contentType = (res.headers.get("content-type") || "image/jpeg")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.byteLength) throw new Error("empty R2 still");

  const optimized = await maybeCompressStillForRemotion(body, contentType);
  if (!optimized.compressed) {
    return { url: input.sourceUrl, compressed: false };
  }

  const key = stillKey(input.jobId, input.index, "jpg");
  const uploaded = await uploadToR2({
    key,
    body: optimized.body,
    contentType: "image/jpeg",
  });
  return { url: uploaded.url, compressed: true };
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
    throw new HandoverPackagerError("scenes is empty", ["No scenes to package"]);
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
  const updatedById = new Map<string, SceneRecord>();
  const concurrency = Math.max(1, PACKAGE_STILL_CONCURRENCY);
  let done = 0;

  async function packageOne(scene: SceneRecord) {
    // Already on our R2 (often large AI PNGs): recompress for Remotion only
    // when JPEG shrinks bytes. Timing / WPM untouched.
    if (scene.imageUrl && alreadyOnOurR2(scene.imageUrl)) {
      try {
        const optimized = await recompressExistingR2Still({
          jobId: input.jobId,
          index: scene.index,
          sourceUrl: scene.imageUrl,
        });
        const url = optimized.url;
        r2BySceneId.set(scene.sceneId, url);
        updatedById.set(scene.id, {
          ...scene,
          r2Url: url,
          imageUrl: url,
          thumbnailUrl: url,
        });
      } catch {
        // Keep the existing R2 URL if optimize/reupload fails
        r2BySceneId.set(scene.sceneId, scene.imageUrl);
        updatedById.set(scene.id, {
          ...scene,
          r2Url: scene.imageUrl,
          imageUrl: scene.imageUrl,
          thumbnailUrl: scene.imageUrl,
        });
      }
      done += 1;
      return;
    }

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
    updatedById.set(scene.id, {
      ...scene,
      r2Url: uploaded.url,
      imageUrl: uploaded.url,
      thumbnailUrl: uploaded.url,
    });
    done += 1;
  }

  for (let i = 0; i < scenes.length; i += concurrency) {
    const slice = scenes.slice(i, i + concurrency);
    await Promise.all(slice.map((s) => packageOne(s)));
    await input.onProgress?.(
      `Packaging stills ${Math.min(done, scenes.length)}/${scenes.length}…`,
    );
  }

  const updatedScenes = scenes.map((s) => updatedById.get(s.id) || s);

  // Exact duration from words @ niche WPM (Mystery = 160)
  const timed = timeChunksAtWpm(
    updatedScenes.map((s) => s.words),
    wpm,
    input.voiceoverDurationSec,
  );

  const packageScenes = updatedScenes.map((scene, i) => {
    const t = timed[i];
    return {
      words: t.words,
      imageUrl: r2BySceneId.get(scene.sceneId)!,
      startSec: t.startSec,
      endSec: t.endSec,
      durationSec: t.durationSec,
    };
  });

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

  // Prefer known probed VO length; else last scene end (word-timed total)
  const voiceoverDurationSec =
    input.voiceoverDurationSec && input.voiceoverDurationSec > 0
      ? input.voiceoverDurationSec
      : packageScenes.length
        ? packageScenes[packageScenes.length - 1].endSec
        : 0;

  const pkg: RenderPackage = {
    scenes: packageScenes,
  };

  await input.onProgress?.("Packaging: validating render package…");
  // Skip expensive public HEAD checks for our own R2 URLs (trust upload)
  const issues = await validateRenderPackage(pkg, {
    checkImageReachability: false,
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
    voiceoverDurationSec,
  };
}
