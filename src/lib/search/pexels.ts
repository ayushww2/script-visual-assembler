import { getPexelsConfig } from "@/lib/env";

/** Prefer short B-roll that Remotion can trim/loop to ~4–5s. */
export const PEXELS_TARGET_USE_SEC = 5;
export const PEXELS_MIN_DURATION_SEC = 4;
export const PEXELS_MAX_DURATION_SEC = 20;

export type PexelsVideoFile = {
  id: number;
  quality: string;
  file_type: string;
  width: number | null;
  height: number | null;
  fps?: number | null;
  link: string;
};

export type PexelsVideoHit = {
  id: number;
  url: string;
  image: string;
  duration: number;
  width: number;
  height: number;
  userName: string;
  userUrl: string;
  /** Best landscape MP4 for download. */
  videoUrl: string;
  videoWidth: number;
  videoHeight: number;
  quality: string;
};

type PexelsSearchResponse = {
  videos?: Array<{
    id: number;
    url: string;
    image: string;
    duration: number;
    width: number;
    height: number;
    user?: { name?: string; url?: string };
    video_files?: PexelsVideoFile[];
  }>;
  error?: string;
};

function cleanPexelsQuery(raw: string): string {
  return raw
    .replace(/[-\u2013]\w+/g, " ")
    .replace(/["'`]/g, " ")
    .replace(/\b(named|real|person|place|event|film|google only)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Score HD landscape files; prefer ~720–1080p MP4. */
function pickVideoFile(
  files: PexelsVideoFile[] | undefined,
): PexelsVideoFile | null {
  if (!files?.length) return null;
  const mp4 = files.filter(
    (f) =>
      f.link &&
      (f.file_type || "").includes("mp4") &&
      (f.width || 0) >= 640 &&
      (f.height || 0) > 0 &&
      (f.width || 0) >= (f.height || 0),
  );
  if (!mp4.length) return null;

  const rank = (f: PexelsVideoFile) => {
    const w = f.width || 0;
    const q = (f.quality || "").toLowerCase();
    let score = w;
    if (q === "hd") score += 500;
    if (q === "sd") score += 100;
    // Prefer ~1280–1920 wide — skip huge 4K when possible for package size.
    if (w >= 1280 && w <= 1920) score += 2000;
    else if (w > 1920) score += 800;
    return score;
  };

  return mp4.slice().sort((a, b) => rank(b) - rank(a))[0] || null;
}

export async function searchPexelsVideos(
  query: string,
  opts?: {
    perPage?: number;
    minDuration?: number;
    maxDuration?: number;
  },
): Promise<{ query: string; results: PexelsVideoHit[]; error?: string }> {
  const cfg = getPexelsConfig();
  const q = cleanPexelsQuery(query);
  if (!cfg.apiKey) {
    return { query: q, results: [], error: "PEXELS_API_KEY not set" };
  }
  if (!q) return { query: q, results: [], error: "empty query" };

  const minDuration = opts?.minDuration ?? PEXELS_MIN_DURATION_SEC;
  const maxDuration = opts?.maxDuration ?? PEXELS_MAX_DURATION_SEC;
  const perPage = Math.min(80, Math.max(1, opts?.perPage ?? 15));

  const url = new URL("https://api.pexels.com/v1/videos/search");
  url.searchParams.set("query", q);
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("size", "medium");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("min_duration", String(minDuration));
  url.searchParams.set("max_duration", String(maxDuration));

  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: cfg.apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        query: q,
        results: [],
        error: `Pexels HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`,
      };
    }
    const data = (await res.json()) as PexelsSearchResponse;
    const results: PexelsVideoHit[] = [];
    for (const v of data.videos || []) {
      if (v.duration < minDuration || v.duration > maxDuration) continue;
      // Must be landscape container
      if (!v.width || !v.height || v.width < v.height) continue;
      const file = pickVideoFile(v.video_files);
      if (!file?.link || !file.width || !file.height) continue;
      results.push({
        id: v.id,
        url: v.url,
        image: v.image,
        duration: v.duration,
        width: v.width,
        height: v.height,
        userName: v.user?.name || "Pexels",
        userUrl: v.user?.url || "https://www.pexels.com",
        videoUrl: file.link,
        videoWidth: file.width,
        videoHeight: file.height,
        quality: file.quality || "hd",
      });
    }
    return { query: q, results };
  } catch (err) {
    return {
      query: q,
      results: [],
      error: err instanceof Error ? err.message : "Pexels search failed",
    };
  }
}

export function pickBestPexelsVideo(
  hits: PexelsVideoHit[],
  usedIds: Set<number>,
): PexelsVideoHit | null {
  const fresh = hits.filter((h) => !usedIds.has(h.id));
  if (!fresh.length) return null;

  // Prefer clips close to the 5s use window, then resolution.
  const scored = fresh
    .map((h) => {
      const durPenalty = Math.abs(h.duration - PEXELS_TARGET_USE_SEC);
      const resBonus = Math.min(h.videoWidth, 1920) / 100;
      return { h, score: resBonus - durPenalty * 3 };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.h || null;
}
