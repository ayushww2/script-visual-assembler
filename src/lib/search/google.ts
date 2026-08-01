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

export type PickGoogleOptions = {
  usedUrls?: Set<string>;
  /** When set, prefer a clean photo of THIS one person only. */
  personName?: string | null;
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
  "pond5.com",
  "envato.com",
  "elements.envato.com",
  "canstockphoto.com",
  "fotolia.com",
  "superstock.com",
];

/** Title/source hints that usually mean logos, text, captions, watermarks. */
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
  "logos",
  "wordmark",
  "brand mark",
  "caption",
  "subtitle",
  "subtitles",
  "closed caption",
  "meme",
  "quote",
  "typography",
  "text overlay",
  "with text",
  "on screen text",
  "lower third",
  "infographic",
  "powerpoint",
  "slide",
  "thumbnail",
  "youtube thumbnail",
  "clickbait",
  "poster",
  "movie poster",
  "dvd cover",
  "blu-ray",
  "magazine cover",
  "book cover",
  "collage",
  "composite",
  "screenshot",
  "screen grab",
  "screengrab",
  "title card",
  "end card",
  "banner",
  "billboard text",
  "newsletter",
  "tweet",
  "instagram",
  "facebook post",
];

const GROUP_SHOT_HINTS = [
  "cast",
  "ensemble",
  "group photo",
  "group shot",
  "family photo",
  "crowd",
  "panel",
  "with friends",
  "and wife",
  "and husband",
  "and daughter",
  "and son",
  "red carpet with",
  "pose with",
  "poses with",
  "alongside",
  "together with",
];

function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function hitBlob(hit: GoogleImageHit): string {
  return `${hit.title || ""} ${hit.sourceName || ""} ${hit.sourceDomain || ""} ${hit.sourcePageUrl || ""}`.toLowerCase();
}

function hasTextOrWatermarkHints(hit: GoogleImageHit): boolean {
  const blob = hitBlob(hit);
  return TEXT_WATERMARK_HINTS.some((h) => blob.includes(h));
}

function isGroupShot(hit: GoogleImageHit): boolean {
  const blob = hitBlob(hit);
  return GROUP_SHOT_HINTS.some((h) => blob.includes(h));
}

function isLandscape(hit: GoogleImageHit): boolean {
  if (hit.width && hit.height) return hit.width > hit.height;
  return true;
}

function isCleanPhoto(hit: GoogleImageHit): boolean {
  const domain = (hit.sourceDomain || "").toLowerCase();
  if (WATERMARK_DOMAINS.some((d) => domain.includes(d))) return false;
  if (hasTextOrWatermarkHints(hit)) return false;
  if (hit.width && hit.height && hit.width <= hit.height) return false;
  if (!isLandscape(hit)) return false;
  return true;
}

/** Append negative keywords so Google Images returns cleaner photos. */
export function withCleanPhotoQuery(query: string, personName?: string | null): string {
  const base = (query || "").trim();
  const person = (personName || "").trim();
  const core = person
    ? `${person} portrait photo`
    : base;
  // SearchAPI/Google support minus operators reasonably well for images.
  return `${core} -logo -watermark -text -subtitle -meme -quote -poster -thumbnail -collage -screenshot`;
}

function personMatchScore(hit: GoogleImageHit, personName?: string | null): number {
  if (!personName?.trim()) return 0;
  const blob = hitBlob(hit);
  const parts = personName.toLowerCase().split(/\s+/).filter((p) => p.length > 2);
  if (!parts.length) return 0;
  let hits = 0;
  for (const p of parts) {
    if (blob.includes(p)) hits += 1;
  }
  if (hits === parts.length) return 40;
  if (hits > 0) return 15;
  return -25; // title doesn't mention the person
}

function scoreHit(
  hit: GoogleImageHit,
  defaults: ReturnType<typeof getSearchDefaults>,
  personName?: string | null,
): number {
  let score = 100;
  if (hit.width && hit.height) {
    const ratio = hit.width / hit.height;
    if (ratio < 1.2) score -= 80;
    else if (ratio >= 1.5 && ratio <= 2.1) score += 30;
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
  // YouTube thumbs often have baked-in text/logos — demote hard
  if (domain.includes("youtube.com") || domain.includes("ytimg.com")) score -= 35;
  if (personName) {
    score += personMatchScore(hit, personName);
    if (isGroupShot(hit)) score -= 50;
  }
  return score;
}

export async function searchGoogleImages(
  query: string,
  num = 8,
  opts?: { personName?: string | null },
): Promise<GoogleSearchPreview> {
  const apiKey = getSearchApiKey();
  if (!apiKey) {
    throw new Error("SEARCHAPI_API_KEY is not configured");
  }

  const defaults = getSearchDefaults();
  const personName = opts?.personName || null;
  const q = withCleanPhotoQuery(query, personName);

  const params = new URLSearchParams({
    engine: "google_images",
    q,
    api_key: apiKey,
    safe: defaults.safe,
    aspect_ratio: "wide",
    size: defaults.size || "large",
    image_type: "photo",
    nfpr: "1",
    filter: "1",
    num: String(Math.min(40, Math.max(12, num * 3))),
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
    .map((r) => ({ ...r, score: scoreHit(r, defaults, personName) }))
    .filter((r) => {
      if (!isCleanPhoto(r)) return false;
      if (personName && isGroupShot(r)) return false;
      return (r.score || 0) >= 40;
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  let results = scored;
  // Soft backfill: landscape + non-stock only (still no watermark domains)
  if (results.length < 1) {
    results = mapped
      .filter((r) => isLandscape(r))
      .filter((r) => {
        const domain = (r.sourceDomain || "").toLowerCase();
        return !WATERMARK_DOMAINS.some((d) => domain.includes(d));
      })
      .filter((r) => !hasTextOrWatermarkHints(r))
      .map((r) => ({ ...r, score: scoreHit(r, defaults, personName) }))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  return {
    query: q,
    provider: "searchapi_google_images",
    results: results.slice(0, num),
    filteredOut: Math.max(0, mapped.length - results.length),
  };
}

/** Pick one clean landscape hit, optionally locked to one person. */
export function pickBestGoogleHit(
  preview: GoogleSearchPreview | undefined,
  usedUrlsOrOpts?: Set<string> | PickGoogleOptions,
  maybeOpts?: PickGoogleOptions,
): GoogleImageHit | null {
  // Back-compat: pickBestGoogleHit(preview, usedUrls)
  let usedUrls: Set<string> | undefined;
  let personName: string | null | undefined;
  if (usedUrlsOrOpts instanceof Set) {
    usedUrls = usedUrlsOrOpts;
    personName = maybeOpts?.personName;
  } else if (usedUrlsOrOpts) {
    usedUrls = usedUrlsOrOpts.usedUrls;
    personName = usedUrlsOrOpts.personName;
  }

  if (!preview?.results?.length) return null;

  const ranked = preview.results
    .slice()
    .map((hit) => ({
      hit,
      score:
        (hit.score || 0) +
        personMatchScore(hit, personName) +
        (personName && isGroupShot(hit) ? -50 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  for (const { hit } of ranked) {
    if (usedUrls?.has(hit.imageUrl)) continue;
    if (!isCleanPhoto(hit)) continue;
    if (personName && isGroupShot(hit)) continue;
    if (personName && personMatchScore(hit, personName) < 0) continue;
    return hit;
  }

  // Relax person title match, still clean + not group
  for (const { hit } of ranked) {
    if (usedUrls?.has(hit.imageUrl)) continue;
    if (!isCleanPhoto(hit)) continue;
    if (personName && isGroupShot(hit)) continue;
    return hit;
  }

  // Last resort: unused only (should be rare)
  for (const hit of preview.results) {
    if (usedUrls?.has(hit.imageUrl)) continue;
    if (hasTextOrWatermarkHints(hit)) continue;
    return hit;
  }
  return null;
}
