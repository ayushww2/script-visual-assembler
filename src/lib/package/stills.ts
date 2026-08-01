import { uploadToR2 } from "@/lib/r2";

export type StillUploadResult = {
  sceneId: string;
  index: number;
  key: string;
  url: string;
  contentType: string;
  bytes: number;
};

const FETCH_TIMEOUT_MS = 25_000;
const MAX_STILL_BYTES = 12 * 1024 * 1024;

export function stillKey(jobId: string, index: number, ext = "jpg"): string {
  const nnn = String(index).padStart(3, "0");
  return `packages/${jobId}/stills/scene-${nnn}.${ext}`;
}

export function packageJsonKey(jobId: string): string {
  return `packages/${jobId}/package.json`;
}

export async function downloadAndUploadStill(input: {
  jobId: string;
  sceneId: string;
  index: number;
  sourceUrl: string;
}): Promise<StillUploadResult> {
  const res = await fetch(input.sourceUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": "ScriptAssemblerPackager/1.0",
      Accept: "image/*,*/*",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to download still for scene ${input.sceneId}: HTTP ${res.status}`,
    );
  }

  const contentType = (res.headers.get("content-type") || "image/jpeg")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error(
      `Scene ${input.sceneId}: source URL did not return an image (${contentType})`,
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.byteLength) {
    throw new Error(`Scene ${input.sceneId}: empty image body`);
  }
  if (buf.byteLength > MAX_STILL_BYTES) {
    throw new Error(`Scene ${input.sceneId}: image too large`);
  }

  const ext = extFromContentType(contentType);
  const key = stillKey(input.jobId, input.index, ext);
  const uploaded = await uploadToR2({
    key,
    body: buf,
    contentType,
  });

  return {
    sceneId: input.sceneId,
    index: input.index,
    key: uploaded.key,
    url: uploaded.url,
    contentType,
    bytes: buf.byteLength,
  };
}

function extFromContentType(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  return "jpg";
}
