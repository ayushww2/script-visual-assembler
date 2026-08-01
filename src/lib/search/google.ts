import { getSearchApiKey, getSearchDefaults } from "@/lib/env";
import { personSearchNegatives } from "@/lib/search/personSubject";

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
  "creativemarket.com",
  "tint.creativemarket.com",
  "watermark.creativemarket",
  "stocksy.com",
  "offset.com",
];

/** Thumbs/social/episode-art often have logos, text, or wrong guests. */
const BLOCKED_MEDIA_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "ytimg.com",
  "ggpht.com",
  "instagram.com",
  "cdninstagram.com",
  "facebook.com",
  "fbcdn.net",
  "tiktok.com",
  "pinterest.com",
  "pinimg.com",
  "twitter.com",
  "x.com",
  "twimg.com",
  "reddit.com",
  "redd.it",
  "imgur.com",
  "tumblr.com",
  "spotifycdn.com",
  "scdn.co",
  "i.scdn.co",
  "mosaic.scdn",
];

const WATERMARK_URL_HINTS = [
  "watermark",
  "wm=1",
  "preset:cm_watermark",
  "cm_watermark",
  "/watermark",
  "mark=1",
  "comp.jpg",
  "preview_watermark",
];

const TEXT_WATERMARK_HINTS = [
  "shutterstock",
  "getty",
  "alamy",
  "dreamstime",
  "creativemarket",
  "creative market",
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
  "side by side",
  "side-by-side",
  "split image",
  "split-screen",
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
  "ai generated",
  "ai-generated",
  "midjourney",
  "generate ai",
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
  "featuring",
  "ft.",
  " vs ",
  " vs. ",
  " and mel ",
  " and joe ",
  "rogan and gibson",
  "gibson and rogan",
  "joe and mel",
  "mel and joe",
  "andrew garfield",
  "garfield",
  "hacksaw ridge",
  "two portraits",
  "dual portrait",
  "split portrait",
];

/** Other celebrities that must not appear when locked to one person. */
const OTHER_FAMOUS = [
  "andrew garfield",
  "garfield",
  "jim caviezel",
  "caviezel",
  "joe rogan",
  "randall wallace",
  "james caviezel",
  "brachio",
  "hacksaw ridge",
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
  return `${hit.title || ""} ${hit.sourceName || ""} ${hit.sourceDomain || ""} ${hit.sourcePageUrl || ""} ${hit.imageUrl || ""}`.toLowerCase();
}

function hasTextOrWatermarkHints(hit: GoogleImageHit): boolean {
  const blob = hitBlob(hit);
  return TEXT_WATERMARK_HINTS.some((h) => blob.includes(h));
}

function hasWatermarkInUrl(url?: string | null): boolean {
  const u = (url || "").toLowerCase();
  return WATERMARK_URL_HINTS.some((h) => u.includes(h));
}

function isGroupShot(hit: GoogleImageHit): boolean {
  const blob = hitBlob(hit);
  return GROUP_SHOT_HINTS.some((h) => blob.includes(h));
}

function isLandscape(hit: GoogleImageHit): boolean {
  if (hit.width && hit.height) return hit.width > hit.height;
  return true;
}

function isBlockedMediaDomain(domainOrUrl?: string): boolean {
  const d = (domainOrUrl || "").toLowerCase();
  if (!d) return false;
  return (
    WATERMARK_DOMAINS.some((x) => d.includes(x)) ||
    BLOCKED_MEDIA_DOMAINS.some((x) => d.includes(x))
  );
}

function isCleanPhoto(hit: GoogleImageHit): boolean {
  const domain = (hit.sourceDomain || "").toLowerCase();
  const url = (hit.imageUrl || "").toLowerCase();
  if (isBlockedMediaDomain(domain) || isBlockedMediaDomain(url)) return false;
  if (hasWatermarkInUrl(url) || hasWatermarkInUrl(hit.sourcePageUrl)) return false;
  if (hasTextOrWatermarkHints(hit)) return false;
  if (hit.width && hit.height && hit.width <= hit.height) return false;
  if (!isLandscape(hit)) return false;
  return true;
}

/** True if an already-picked Google scene should be replaced. */
export function isBadGoogleScenePick(scene: {
  visualSource?: string;
  imageUrl?: string | null;
  sourceDomain?: string | null;
  sourceUrl?: string | null;
  query?: string | null;
  subject?: string | null;
  words?: string | null;
  why?: string | null;
}): boolean {
  if (scene.visualSource !== "google" || !scene.imageUrl?.trim()) return false;
  if (isBlockedMediaDomain(scene.sourceDomain || undefined)) return true;
  if (isBlockedMediaDomain(scene.imageUrl)) return true;
  if (hasWatermarkInUrl(scene.imageUrl) || hasWatermarkInUrl(scene.sourceUrl)) {
    return true;
  }
  const domain = (scene.sourceDomain || "").toLowerCase();
  const url = (scene.imageUrl || "").toLowerCase();
  const meta = `${scene.query || ""} ${scene.subject || ""} ${scene.why || ""}`.toLowerCase();
  const words = (scene.words || "").toLowerCase();

  if (meta.includes("creativemarket") || url.includes("creativemarket")) return true;
  if (meta.includes("watermark") || url.includes("watermark")) return true;

  // Bare "Gibson" query (not Mel Gibson) → wrong people
  if (/\bgibson\b/.test(meta) && !/\bmel gibson\b/.test(meta)) return true;

  // Dual-person beats on news/thumb hosts are usually Rogan|Gibson collages with logos
  const dual =
    (/\brogan\b/.test(words) || /\brogan\b/.test(meta)) &&
    (/\bgibson\b/.test(words) || /\bgibson\b/.test(meta));
  if (
    dual &&
    (domain.includes("imdb.com") ||
      domain.includes("media-amazon.com") ||
      domain.includes("spotify") ||
      (meta.includes("podcast") && meta.includes("rogan") && meta.includes("gibson")))
  ) {
    return true;
  }

  // Wrong second person in the result (e.g. Andrew Garfield + Mel Gibson collage)
  const sourceBlob = `${scene.sourceUrl || ""} ${scene.imageUrl || ""} ${scene.why || ""} ${scene.query || ""} ${scene.subject || ""}`;
  if (sceneMentionsWrongExtraPerson(sourceBlob, words)) return true;

  // people.com dual-celebrity features are almost always split portraits + logos
  if (
    domain.includes("people.com") &&
    (/\bgibson\b/.test(words) || /\bmel gibson\b/.test(meta))
  ) {
    return true;
  }

  return false;
}

/** Append negative keywords so Google Images returns cleaner photos. */
export function withCleanPhotoQuery(
  query: string,
  personName?: string | null,
): string {
  const person = (personName || "").trim();
  const base = (query || "").trim();
  // Always search the full person name when locked — never bare surname.
  const core = person ? `"${person}" portrait photo` : base;
  const personNeg = personSearchNegatives(person);
  return `${core} -logo -watermark -text -subtitle -meme -quote -poster -thumbnail -collage -screenshot -composite -creativemarket ${personNeg}`.replace(
    /\s+/g,
    " ",
  ).trim();
}

/**
 * Require ALL name tokens (Mel + Gibson). Partial "gibson" alone scores as reject.
 */
function personMatchScore(hit: GoogleImageHit, personName?: string | null): number {
  if (!personName?.trim()) return 0;
  const blob = hitBlob(hit);
  const parts = personName
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length > 2);
  if (!parts.length) return 0;

  let hits = 0;
  for (const p of parts) {
    if (blob.includes(p)) hits += 1;
  }

  // Multi-word names: require every token (Mel AND Gibson)
  if (parts.length >= 2) {
    if (hits === parts.length) return 50;
    // "gibson" without "mel" is a hard reject for Mel Gibson
    return -80;
  }

  if (hits === parts.length) return 40;
  return -25;
}

function mentionsOtherFamousPerson(
  hit: GoogleImageHit,
  personName?: string | null,
): boolean {
  if (!personName) return false;
  const blob = hitBlob(hit);
  const p = personName.toLowerCase();
  const others = [
    "mel gibson",
    "joe rogan",
    "jim caviezel",
    "randall wallace",
    ...OTHER_FAMOUS,
  ];
  for (const o of others) {
    if (p.includes(o)) continue;
    // Don't treat "gibson" fragment of Mel Gibson as other
    if (o === "garfield" && p.includes("garfield")) continue;
    if (blob.includes(o)) return true;
  }
  // Rogan+Gibson collage when we want only Mel
  if (p.includes("mel gibson") && blob.includes("rogan") && blob.includes("gibson")) {
    return true;
  }
  // Title/URL names a second Proper Name person (e.g. Andrew Garfield + Mel Gibson)
  if (p.includes("mel gibson")) {
    const title = `${hit.title || ""} ${hit.sourcePageUrl || ""}`.toLowerCase();
    if (
      /\bandrew[-_ ]?garfield\b/.test(title) ||
      /\bgarfield\b/.test(title) ||
      /\bhacksaw[-_ ]?ridge\b/.test(title)
    ) {
      return true;
    }
  }
  return false;
}

/** Scene-level: source/meta names a second person when we wanted one. */
function sceneMentionsWrongExtraPerson(meta: string, words: string): boolean {
  const blob = `${meta} ${words}`.toLowerCase();
  const wantsMel =
    /\bmel gibson\b/.test(blob) ||
    (/\bgibson\b/.test(words) && !/\bdavid gibson\b/.test(blob));
  if (!wantsMel) return false;
  return (
    /\bandrew[-_ /]?garfield\b/.test(blob) ||
    /\bgarfield\b/.test(blob) ||
    /\bhacksaw[-_ /]?ridge\b/.test(blob)
  );
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
  if (hasWatermarkInUrl(hit.imageUrl)) score -= 200;
  const domain = (hit.sourceDomain || "").toLowerCase();
  if (isBlockedMediaDomain(domain) || isBlockedMediaDomain(hit.imageUrl)) {
    score -= 200;
  }
  if (personName) {
    score += personMatchScore(hit, personName);
    if (isGroupShot(hit)) score -= 60;
    if (mentionsOtherFamousPerson(hit, personName)) score -= 70;
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
      if (personName && personMatchScore(r, personName) < 0) return false;
      if (personName && mentionsOtherFamousPerson(r, personName)) return false;
      return (r.score || 0) >= 40;
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  let results = scored;
  if (results.length < 1) {
    results = mapped
      .filter((r) => isLandscape(r))
      .filter((r) => isCleanPhoto(r))
      .filter((r) => !personName || personMatchScore(r, personName) >= 40)
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
        (personName && isGroupShot(hit) ? -60 : 0) +
        (personName && mentionsOtherFamousPerson(hit, personName) ? -70 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  // Strict: clean + full name match + not group/composite
  for (const { hit } of ranked) {
    if (usedUrls?.has(hit.imageUrl)) continue;
    if (!isCleanPhoto(hit)) continue;
    if (personName && isGroupShot(hit)) continue;
    if (personName && mentionsOtherFamousPerson(hit, personName)) continue;
    if (personName && personMatchScore(hit, personName) < 40) continue;
    return hit;
  }

  // Slightly relax: still require full name if person locked
  for (const { hit } of ranked) {
    if (usedUrls?.has(hit.imageUrl)) continue;
    if (!isCleanPhoto(hit)) continue;
    if (personName && isGroupShot(hit)) continue;
    if (personName && personMatchScore(hit, personName) < 40) continue;
    return hit;
  }

  return null;
}
