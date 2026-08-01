import { getSearchApiKey, getSearchDefaults } from "@/lib/env";

export type GoogleImageHit = {
  title: string;
  imageUrl: string;
  thumbnailUrl?: string;
  sourcePageUrl?: string;
  sourceDomain?: string;
  sourceName?: string;
  width?: number;
  height?: number;
  position?: number;
  score?: number;
};

export type GoogleSearchPreview = {
  query: string;
  provider: string;
  results: GoogleImageHit[];
  filteredOut: number;
  error?: string;
};

type SearchApiImage = {
  position?: number;
  title?: string;
  source?: { name?: string; link?: string };
  original?: { link?: string; width?: number; height?: number };
  thumbnail?: string;
};

const WATERMARK_DOMAINS = [
  "shutterstock.com",
  "alamy.com",
  "dreamstime.com",
  "123rf.com",
  "depositphotos.com",
  "istockphoto.com",
  "stock.adobe.com",
  "adobe.stock",
  "vectorstock.com",
  "gettyimages.com",
  "gettyimages.",
  "premiumbeat.com",
  "motionelements.com",
];

const TEXT_WATERMARK_HINTS = [
  "shutterstock",
  "getty",
  "alamy",
  "dreamstime",
  "watermark",
  "royalty free",
  "stock photo",
  "stock image",
  "logo",
  "caption",
  "subtitle",
  "meme",
  "quote",
  "typography",
  "text overlay",
  "infographic",
  "powerpoint",
  "slide",
];

function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function hasTextOrWatermarkHints(hit: GoogleImageHit): boolean {
  const blob = `${hit.title || ""} ${hit.sourceName || ""} ${hit.sourceDomain || ""}`.toLowerCase();
  return TEXT_WATERMARK_HINTS.some((h) => blob.includes(h));
}

function isLandscape(hit: GoogleImageHit): boolean {
  if (hit.width && hit.height) return hit.width > hit.height;
  // Unknown dims: allow but score lower; SearchAPI aspect_ratio=wide already biases
  return true;
}

function scoreHit(hit: GoogleImageHit, defaults: ReturnType<typeof getSearchDefaults>): number {
  let score = 100;
  if (hit.width && hit.height) {
    const ratio = hit.width / hit.height;
    if (ratio < 1.2) score -= 80; // reject-ish portrait/square
    else if (ratio >= 1.5 && ratio <= 2.1) score += 30; // ~16:9
    else if (ratio > 1.2) score += 10;
    if (hit.width >= defaults.minWidth) score += 10;
    if (hit.height >= defaults.minHeight) score += 5;
    if (hit.width >= 1280) score += 8;
  } else {
    score -= 15;
  }
  if (hasTextOrWatermarkHints(hit)) score -= 100;
  const domain = (hit.sourceDomain || "").toLowerCase();
  if (WATERMARK_DOMAINS.some((d) => domain.includes(d))) score -= 120;
  return score;
}

export async function searchGoogleImages(
  query: string,
  num = 8,
): Promise<GoogleSearchPreview> {
  const apiKey = getSearchApiKey();
  if (!apiKey) {
    throw new Error("SEARCHAPI_API_KEY is not configured");
  }

  const defaults = getSearchDefaults();
  const params = new URLSearchParams({
    engine: "google_images",
    q: query,
    api_key: apiKey,
    safe: defaults.safe,
    aspect_ratio: "wide", // force landscape bias
    size: defaults.size || "large",
    image_type: "photo",
    nfpr: "1",
    filter: "1",
    num: String(Math.min(40, Math.max(10, num * 2))),
  });

  const res = await fetch(`https://www.searchapi.io/api/v1/search?${params}`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SearchAPI ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { images?: SearchApiImage[] };
  const mapped: GoogleImageHit[] = (data.images || [])
    .map((img) => {
      const imageUrl = img.original?.link || "";
      const sourcePageUrl = img.source?.link;
      return {
        title: img.title || "",
        imageUrl,
        thumbnailUrl: img.thumbnail,
        sourcePageUrl,
        sourceDomain: domainFromUrl(sourcePageUrl) || domainFromUrl(imageUrl),
        sourceName: img.source?.name,
        width: img.original?.width,
        height: img.original?.height,
        position: img.position,
      };
    })
    .filter((r) => Boolean(r.imageUrl));

  const scored = mapped
    .map((r) => ({ ...r, score: scoreHit(r, defaults) }))
    .filter((r) => {
      if (!isLandscape(r)) return false;
      const domain = (r.sourceDomain || "").toLowerCase();
      if (WATERMARK_DOMAINS.some((d) => domain.includes(d))) return false;
      if (hasTextOrWatermarkHints(r)) return false;
      if (r.width && r.height && r.width <= r.height) return false;
      return (r.score || 0) >= 40;
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  let results = scored;
  // Soft backfill only landscape non-stock if filter too aggressive
  if (results.length < 1) {
    results = mapped
      .filter((r) => isLandscape(r))
      .filter((r) => {
        const domain = (r.sourceDomain || "").toLowerCase();
        return !WATERMARK_DOMAINS.some((d) => domain.includes(d));
      })
      .map((r) => ({ ...r, score: scoreHit(r, defaults) }))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  return {
    query,
    provider: "searchapi_google_images",
    results: results.slice(0, num),
    filteredOut: Math.max(0, mapped.length - results.length),
  };
}

/** Pick one landscape / clean hit, skipping already-used image URLs. */
export function pickBestGoogleHit(
  preview: GoogleSearchPreview | undefined,
  usedUrls?: Set<string>,
): GoogleImageHit | null {
  if (!preview?.results?.length) return null;
  for (const hit of preview.results) {
    if (usedUrls?.has(hit.imageUrl)) continue;
    if (!isLandscape(hit)) continue;
    if (hasTextOrWatermarkHints(hit)) continue;
    const domain = (hit.sourceDomain || "").toLowerCase();
    if (WATERMARK_DOMAINS.some((d) => domain.includes(d))) continue;
    return hit;
  }
  // last resort: first unused
  for (const hit of preview.results) {
    if (usedUrls?.has(hit.imageUrl)) continue;
    return hit;
  }
  return preview.results[0] || null;
}
