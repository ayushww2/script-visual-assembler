import sharp from "sharp";

/** Remotion-friendly still target: wide enough, light enough. */
export const REMOTION_STILL_MAX_WIDTH = 1920;
export const REMOTION_STILL_JPEG_QUALITY = 82;
/** Already in the ~200–400KB band (or smaller) as JPEG — skip work. */
const SKIP_SMALL_JPEG_BYTES = 400 * 1024;

export type CompressedStill = {
  body: Buffer;
  contentType: string;
  ext: string;
  /** True when we replaced the original with a smaller JPEG. */
  compressed: boolean;
  originalBytes: number;
  outputBytes: number;
};

function extFromContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  return "jpg";
}

/**
 * Recompress a still to JPEG ≤1920px @ ~q82 for Remotion load.
 * Only returns the JPEG when it is strictly smaller than the input.
 * Timing / WPM are untouched — this is bytes-only.
 */
export async function maybeCompressStillForRemotion(
  body: Buffer,
  contentType: string,
): Promise<CompressedStill> {
  const originalBytes = body.byteLength;
  const ct = (contentType || "image/jpeg").split(";")[0].trim().toLowerCase();
  const originalExt = extFromContentType(ct);

  const passThrough = (): CompressedStill => ({
    body,
    contentType: ct.startsWith("image/") ? ct : "image/jpeg",
    ext: originalExt,
    compressed: false,
    originalBytes,
    outputBytes: originalBytes,
  });

  if (!originalBytes) return passThrough();

  // Small JPEGs are already Remotion-friendly — don't spend CPU.
  if (
    (ct.includes("jpeg") || ct.includes("jpg")) &&
    originalBytes <= SKIP_SMALL_JPEG_BYTES
  ) {
    return passThrough();
  }

  try {
    const meta = await sharp(body, { failOn: "none" }).rotate().metadata();
    let pipeline = sharp(body, { failOn: "none" }).rotate();

    if (meta.width && meta.width > REMOTION_STILL_MAX_WIDTH) {
      pipeline = pipeline.resize({
        width: REMOTION_STILL_MAX_WIDTH,
        withoutEnlargement: true,
      });
    }

    const out = await pipeline
      .jpeg({
        quality: REMOTION_STILL_JPEG_QUALITY,
        mozjpeg: true,
      })
      .toBuffer();

    if (out.byteLength > 0 && out.byteLength < originalBytes) {
      return {
        body: out,
        contentType: "image/jpeg",
        ext: "jpg",
        compressed: true,
        originalBytes,
        outputBytes: out.byteLength,
      };
    }
  } catch {
    // Keep original on any decode/encode failure.
  }

  return passThrough();
}
