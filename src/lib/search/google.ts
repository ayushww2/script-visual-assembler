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
];

function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
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
    aspect_ratio: defaults.aspectRatio,
    size: defaults.size,
    image_type: "photo",
    nfpr: "1",
    filter: "1",
    num: String(Math.min(40, Math.max(8, num))),
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

  const preferred = mapped.filter((r) => {
    if (r.width && r.height && r.width <= r.height) return false;
    if (r.width && r.width < defaults.minWidth) return false;
    if (r.height && r.height < defaults.minHeight) return false;
    const domain = (r.sourceDomain || "").toLowerCase();
    if (WATERMARK_DOMAINS.some((d) => domain.includes(d))) return false;
    return true;
  });

  let results = preferred;
  if (results.length < 4) {
    const backfill = mapped.filter(
      (r) =>
        !preferred.includes(r) &&
        !(r.width && r.height && r.width < r.height),
    );
    results = [...preferred, ...backfill];
  }

  return {
    query,
    provider: "searchapi_google_images",
    results: results.slice(0, num),
    filteredOut: Math.max(0, mapped.length - results.length),
  };
}
