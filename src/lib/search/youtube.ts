import { getYouTubeApiKey } from "@/lib/env";

/**
 * YouTube clip *suggestions* for manual editors.
 *
 * What this does:
 * - Searches YouTube via the official Data API v3
 * - Fetches publicly available caption/transcript text (timed text metadata)
 * - Matches narration words to a 3–5s caption window
 * - Returns watch URLs with start timestamps for editors to review
 *
 * What this does NOT do:
 * - Download or rehost video/audio files
 * - Cut or attach YouTube media into the Remotion package
 */

const YT_API = "https://www.googleapis.com/youtube/v3";
const DEFAULT_CLIP_SEC = 4;
const MIN_CLIP_SEC = 3;
const MAX_CLIP_SEC = 5;

export type YouTubeVideoHit = {
  videoId: string;
  title: string;
  channelTitle: string;
  description: string;
  publishedAt?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  watchUrl: string;
};

export type CaptionCue = {
  startSec: number;
  durationSec: number;
  text: string;
};

export type YouTubeClipSuggestion = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl?: string;
  watchUrl: string;
  /** Deep-link that jumps the editor to the suggested start. */
  watchAtUrl: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  matchedText: string;
  score: number;
  hasCaptions: boolean;
};

export type SceneYouTubeSuggestions = {
  sceneId: string;
  index: number;
  words: string;
  query: string;
  targetClipSec: number;
  suggestions: YouTubeClipSuggestion[];
  note?: string;
};

/**
 * Keyless YouTube search via public results HTML (ytInitialData).
 * Used when YOUTUBE_API_KEY is missing — metadata only, no download.
 */
export async function searchYouTubeVideosKeyless(
  query: string,
  maxResults = 5,
): Promise<YouTubeVideoHit[]> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (compatible; ScriptVisualAssembler/1.0; +https://github.com/ayushww2/script-visual-assembler)",
    },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const m =
    /var ytInitialData\s*=\s*(\{[\s\S]+?\});\s*<\/script>/.exec(html) ||
    /ytInitialData\s*=\s*(\{[\s\S]+?\});\s*ytInitialPlayerResponse/.exec(html);
  if (!m?.[1]) {
    // Fallback: scrape watch?v= ids from the page.
    const ids = Array.from(
      new Set(
        [...html.matchAll(/\/watch\?v=([a-zA-Z0-9_-]{11})/g)].map((x) => x[1]),
      ),
    ).slice(0, maxResults);
    return ids.map((videoId) => ({
      videoId,
      title: query,
      channelTitle: "",
      description: "",
      watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
    }));
  }

  try {
    const data = JSON.parse(m[1]) as unknown;
    const hits: YouTubeVideoHit[] = [];
    const walk = (node: unknown) => {
      if (!node || hits.length >= maxResults) return;
      if (Array.isArray(node)) {
        for (const n of node) walk(n);
        return;
      }
      if (typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      const vr = obj.videoRenderer as
        | {
            videoId?: string;
            title?: { runs?: Array<{ text?: string }> };
            ownerText?: { runs?: Array<{ text?: string }> };
            lengthText?: { simpleText?: string };
            thumbnail?: { thumbnails?: Array<{ url?: string }> };
          }
        | undefined;
      if (vr?.videoId) {
        hits.push({
          videoId: vr.videoId,
          title: vr.title?.runs?.map((r) => r.text || "").join("") || "",
          channelTitle: vr.ownerText?.runs?.[0]?.text || "",
          description: "",
          thumbnailUrl: vr.thumbnail?.thumbnails?.slice(-1)[0]?.url,
          durationSec: parseLengthText(vr.lengthText?.simpleText),
          watchUrl: `https://www.youtube.com/watch?v=${vr.videoId}`,
        });
        return;
      }
      for (const v of Object.values(obj)) walk(v);
    };
    walk(data);
    return hits.slice(0, maxResults);
  } catch {
    return [];
  }
}

function parseLengthText(text?: string): number | undefined {
  if (!text) return undefined;
  const parts = text.split(":").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function parseIso8601Duration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (
    Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)
  );
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function overlapScore(a: string[], b: Set<string>): number {
  if (!a.length) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits += 1;
  return hits / a.length;
}

/** Build a short Google/YouTube-style search query from narration. */
export function queryFromNarration(words: string, topic?: string): string {
  const tokens = tokenize(words).slice(0, 8);
  const base = tokens.join(" ").trim();
  if (base) return base;
  return (topic || "documentary").trim().slice(0, 60);
}

export function targetClipDurationSec(sceneDurationSec?: number | null): number {
  if (!sceneDurationSec || sceneDurationSec <= 0) return DEFAULT_CLIP_SEC;
  // Prefer a clip slightly shorter than the line (3–5s for a ~6s beat).
  return Math.min(MAX_CLIP_SEC, Math.max(MIN_CLIP_SEC, sceneDurationSec * 0.7));
}

export async function searchYouTubeVideos(
  query: string,
  maxResults = 5,
): Promise<YouTubeVideoHit[]> {
  const key = getYouTubeApiKey();
  if (!key) {
    return searchYouTubeVideosKeyless(query, maxResults);
  }
  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    q: query,
    maxResults: String(Math.min(10, Math.max(1, maxResults))),
    videoEmbeddable: "true",
    safeSearch: "moderate",
    relevanceLanguage: "en",
    key,
  });

  const res = await fetch(`${YT_API}/search?${params}`, { cache: "no-store" });
  if (!res.ok) {
    // Fall back to keyless scrape rather than failing the whole film plan.
    const keyless = await searchYouTubeVideosKeyless(query, maxResults);
    if (keyless.length) return keyless;
    const body = await res.text();
    throw new Error(`YouTube search ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    items?: Array<{
      id?: { videoId?: string };
      snippet?: {
        title?: string;
        channelTitle?: string;
        description?: string;
        publishedAt?: string;
        thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
      };
    }>;
  };

  const hits: YouTubeVideoHit[] = (data.items || [])
    .map((item): YouTubeVideoHit | null => {
      const videoId = item.id?.videoId;
      if (!videoId) return null;
      return {
        videoId,
        title: item.snippet?.title || "",
        channelTitle: item.snippet?.channelTitle || "",
        description: item.snippet?.description || "",
        publishedAt: item.snippet?.publishedAt,
        thumbnailUrl:
          item.snippet?.thumbnails?.medium?.url ||
          item.snippet?.thumbnails?.default?.url,
        watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
      };
    })
    .filter((h): h is YouTubeVideoHit => h != null);

  if (!hits.length) return hits;

  // Enrich with durations (one videos.list call).
  const ids = hits.map((h) => h.videoId).join(",");
  const durRes = await fetch(
    `${YT_API}/videos?${new URLSearchParams({
      part: "contentDetails",
      id: ids,
      key,
    })}`,
    { cache: "no-store" },
  );
  if (durRes.ok) {
    const durData = (await durRes.json()) as {
      items?: Array<{ id?: string; contentDetails?: { duration?: string } }>;
    };
    const byId = new Map(
      (durData.items || []).map((i) => [
        i.id || "",
        parseIso8601Duration(i.contentDetails?.duration || ""),
      ]),
    );
    for (const h of hits) {
      h.durationSec = byId.get(h.videoId) || undefined;
    }
  }

  return hits;
}

/**
 * Fetch publicly available caption cues (transcript metadata only).
 * Tries English first, then any available timedtext track listed by YouTube.
 */
export async function fetchYouTubeCaptions(
  videoId: string,
): Promise<CaptionCue[]> {
  // 1) Discover available tracks (no video download).
  const listUrl = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
  const listRes = await fetch(listUrl, {
    cache: "no-store",
    headers: { "Accept-Language": "en" },
  });
  if (!listRes.ok) return [];

  const listXml = await listRes.text();
  const tracks = [...listXml.matchAll(/<track\b([^>]*)\/?>/gi)].map((m) => {
    const attrs = m[1] || "";
    const lang = /lang_code="([^"]+)"/i.exec(attrs)?.[1] || "";
    const name = /name="([^"]*)"/i.exec(attrs)?.[1] || "";
    return { lang, name };
  });

  const preferred =
    tracks.find((t) => t.lang.toLowerCase().startsWith("en")) || tracks[0];
  if (!preferred) return [];

  const params = new URLSearchParams({
    v: videoId,
    lang: preferred.lang,
    fmt: "json3",
  });
  if (preferred.name) params.set("name", preferred.name);

  const cueRes = await fetch(
    `https://www.youtube.com/api/timedtext?${params}`,
    { cache: "no-store" },
  );
  if (!cueRes.ok) return [];

  const raw = await cueRes.text();
  if (!raw.trim()) return [];

  try {
    const json = JSON.parse(raw) as {
      events?: Array<{
        tStartMs?: number;
        dDurationMs?: number;
        segs?: Array<{ utf8?: string }>;
      }>;
    };
    return (json.events || [])
      .map((ev) => {
        const text = (ev.segs || [])
          .map((s) => s.utf8 || "")
          .join("")
          .replace(/\n/g, " ")
          .trim();
        if (!text) return null;
        return {
          startSec: (ev.tStartMs || 0) / 1000,
          durationSec: (ev.dDurationMs || 2000) / 1000,
          text,
        };
      })
      .filter((c): c is CaptionCue => Boolean(c));
  } catch {
    // Fall back to simple XML <text start="" dur=""> parsing
    return [...raw.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)].map(
      (m) => {
        const attrs = m[1] || "";
        const start = Number(/start="([^"]+)"/i.exec(attrs)?.[1] || 0);
        const dur = Number(/dur="([^"]+)"/i.exec(attrs)?.[1] || 2);
        const text = m[2]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/<[^>]+>/g, "")
          .replace(/\n/g, " ")
          .trim();
        return { startSec: start, durationSec: dur, text };
      },
    ).filter((c) => c.text);
  }
}

/**
 * Slide a target-duration window over caption cues; pick the best word overlap.
 */
export function findBestCaptionWindow(
  cues: CaptionCue[],
  narration: string,
  targetSec: number,
): { startSec: number; endSec: number; matchedText: string; score: number } | null {
  if (!cues.length) return null;
  const want = Math.min(MAX_CLIP_SEC, Math.max(MIN_CLIP_SEC, targetSec));
  const narrTokens = tokenize(narration);
  if (!narrTokens.length) return null;

  let best: {
    startSec: number;
    endSec: number;
    matchedText: string;
    score: number;
  } | null = null;

  for (let i = 0; i < cues.length; i++) {
    let end = cues[i].startSec;
    const parts: string[] = [];
    for (let j = i; j < cues.length; j++) {
      parts.push(cues[j].text);
      end = cues[j].startSec + cues[j].durationSec;
      const span = end - cues[i].startSec;
      if (span < want * 0.75 && j < cues.length - 1) continue;

      const windowText = parts.join(" ");
      const score = overlapScore(narrTokens, new Set(tokenize(windowText)));
      // Prefer windows close to target length.
      const lengthPenalty = Math.abs(span - want) / want;
      const adjusted = score - lengthPenalty * 0.15;

      if (!best || adjusted > best.score) {
        best = {
          startSec: cues[i].startSec,
          endSec: Math.min(end, cues[i].startSec + want),
          matchedText: windowText.slice(0, 180),
          score: adjusted,
        };
      }
      break;
    }
  }

  if (!best || best.score < 0.15) return null;
  return best;
}

export async function suggestYouTubeClipsForScene(input: {
  sceneId: string;
  index: number;
  words: string;
  durationSec?: number | null;
  topic?: string;
  maxVideos?: number;
}): Promise<SceneYouTubeSuggestions> {
  const query = queryFromNarration(input.words, input.topic);
  const targetClipSec = targetClipDurationSec(input.durationSec);
  const videos = await searchYouTubeVideos(query, input.maxVideos ?? 4);

  if (!videos.length) {
    return {
      sceneId: input.sceneId,
      index: input.index,
      words: input.words,
      query,
      targetClipSec,
      suggestions: [],
      note: "No YouTube results for this query.",
    };
  }

  const suggestions: YouTubeClipSuggestion[] = [];

  for (const video of videos) {
    const cues = await fetchYouTubeCaptions(video.videoId);
    const window = findBestCaptionWindow(cues, input.words, targetClipSec);

    if (window) {
      const start = Math.max(0, Math.floor(window.startSec));
      suggestions.push({
        videoId: video.videoId,
        title: video.title,
        channelTitle: video.channelTitle,
        thumbnailUrl: video.thumbnailUrl,
        watchUrl: video.watchUrl,
        watchAtUrl: `${video.watchUrl}&t=${start}s`,
        startSec: Number(window.startSec.toFixed(2)),
        endSec: Number(window.endSec.toFixed(2)),
        durationSec: Number((window.endSec - window.startSec).toFixed(2)),
        matchedText: window.matchedText,
        score: Number(window.score.toFixed(3)),
        hasCaptions: true,
      });
    } else {
      // Still useful for editors: open the video even without a timed match.
      suggestions.push({
        videoId: video.videoId,
        title: video.title,
        channelTitle: video.channelTitle,
        thumbnailUrl: video.thumbnailUrl,
        watchUrl: video.watchUrl,
        watchAtUrl: video.watchUrl,
        startSec: 0,
        endSec: targetClipSec,
        durationSec: targetClipSec,
        matchedText: "",
        score: 0,
        hasCaptions: false,
      });
    }
  }

  suggestions.sort((a, b) => b.score - a.score);

  return {
    sceneId: input.sceneId,
    index: input.index,
    words: input.words,
    query,
    targetClipSec,
    suggestions,
    note: suggestions.every((s) => !s.hasCaptions)
      ? "Videos found, but no public captions — open links and scrub manually."
      : undefined,
  };
}
