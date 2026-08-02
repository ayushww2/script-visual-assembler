import { createHash } from "crypto";
import { uploadToR2 } from "@/lib/r2";
import { maybeCompressStillForRemotion } from "@/lib/package/compressStill";

export type StillUploadResult = {
  sceneId: string;
  index: number;
  key: string;
  url: string;
  contentType: string;
  bytes: number;
  sourceUrlUsed: string;
  compressed?: boolean;
};

const FETCH_TIMEOUT_MS = 25_000;
const MAX_STILL_BYTES = 12 * 1024 * 1024;

/**
 * Content-hashed still key so CDN/immutable cache cannot serve a replaced image
 * (e.g. old wedding still at scene-002.jpg after a place-only repair).
 */
export function stillKey(
  jobId: string,
  index: number,
  ext = "jpg",
  body?: Buffer | Uint8Array | null,
): string {
  const nnn = String(index).padStart(3, "0");
  const hash = body?.byteLength
    ? createHash("sha1").update(body).digest("hex").slice(0, 10)
    : "tmp";
  return `packages/${jobId}/stills/scene-${nnn}-${hash}.${ext}`;
}

export function packageJsonKey(jobId: string): string {
  return `packages/${jobId}/package.json`;
}

export async function downloadAndUploadStill(input: {
  jobId: string;
  sceneId: string;
  index: number;
  sourceUrl: string;
  /** Extra candidates (thumbnails / alternate Google hits). Tried in order after sourceUrl. */
  fallbackUrls?: string[];
  referer?: string | null;
}): Promise<StillUploadResult> {
  const candidates = uniqueUrls([
    input.sourceUrl,
    ...(input.fallbackUrls || []),
  ]);
  if (!candidates.length) {
    throw new Error(`Scene ${input.sceneId}: no image candidates`);
  }

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const fetched = await fetchImageBytes(candidate, input.referer);
      const optimized = await maybeCompressStillForRemotion(
        fetched.body,
        fetched.contentType,
      );
      const key = stillKey(
        input.jobId,
        input.index,
        optimized.ext,
        optimized.body,
      );
      const uploaded = await uploadToR2({
        key,
        body: optimized.body,
        contentType: optimized.contentType,
      });
      return {
        sceneId: input.sceneId,
        index: input.index,
        key: uploaded.key,
        url: uploaded.url,
        contentType: optimized.contentType,
        bytes: optimized.body.byteLength,
        sourceUrlUsed: candidate,
        compressed: optimized.compressed,
      };
    } catch (err) {
      errors.push(
        `${shortUrl(candidate)}: ${err instanceof Error ? err.message : "failed"}`,
      );
    }
  }

  throw new Error(
    `Failed to download still for scene ${input.sceneId}: ${errors.slice(0, 4).join(" | ")}`,
  );
}

async function fetchImageBytes(
  url: string,
  referer?: string | null,
): Promise<{ body: Buffer; contentType: string }> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (referer) headers.Referer = referer;
  else if (url.includes("gstatic.com") || url.includes("google")) {
    headers.Referer = "https://www.google.com/";
  } else {
    try {
      headers.Referer = new URL(url).origin + "/";
    } catch {
      headers.Referer = "https://www.google.com/";
    }
  }

  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const contentType = (res.headers.get("content-type") || "image/jpeg")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error(`not an image (${contentType})`);
  }

  const body = Buffer.from(await res.arrayBuffer());
  if (!body.byteLength) throw new Error("empty image body");
  if (body.byteLength > MAX_STILL_BYTES) throw new Error("image too large");
  return { body, contentType };
}

function uniqueUrls(urls: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    const v = (u || "").trim();
    if (!v.startsWith("http")) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.slice(0, 48);
  } catch {
    return url.slice(0, 64);
  }
}
