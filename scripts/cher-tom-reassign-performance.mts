/**
 * Re-pick Cher/Tom video sources: acting / singing / performing / stunts
 * (not talk-show talking heads). Reuses prior cher|tom|images plan.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  searchYouTubeVideos,
  type YouTubeClipSuggestion,
  type YouTubeVideoHit,
} from "../src/lib/search/youtube";
import { getSearchApiKey } from "../src/lib/env";

const CLIP_SEC = 4;
const MIN_GAP = 35;
const MAX_SRC = 10;

async function ytSearch(q: string, n = 5): Promise<YouTubeVideoHit[]> {
  try {
    const hits = await searchYouTubeVideos(q, n);
    if (hits.length) return hits;
  } catch {
    /* fall through */
  }
  const key = getSearchApiKey();
  if (!key) return [];
  const params = new URLSearchParams({ engine: "youtube", q, api_key: key });
  const res = await fetch(`https://www.searchapi.io/api/v1/search?${params}`, {
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    videos?: Array<{
      id?: string;
      title?: string;
      link?: string;
      channel?: { title?: string };
      thumbnail?: string;
    }>;
  };
  return (data.videos || [])
    .map((v) => {
      const videoId = v.id || /[?&]v=([^&]+)/.exec(v.link || "")?.[1];
      if (!videoId) return null;
      return {
        videoId,
        title: v.title || "",
        channelTitle: v.channel?.title || "",
        description: "",
        thumbnailUrl: v.thumbnail,
        watchUrl: v.link || `https://www.youtube.com/watch?v=${videoId}`,
        durationSec: 600,
      } as YouTubeVideoHit;
    })
    .filter((h): h is YouTubeVideoHit => Boolean(h))
    .slice(0, n);
}

/** Prefer performance; reject pure interview/talk-show titles when possible. */
function isPerformanceTitle(title: string, hero: "cher" | "tom"): boolean {
  const t = title.toLowerCase();
  const bad =
    /interview|letterman|oprah|ellen|howard stern|talks? |q&a|press conference|podcast|explains|being an absolute mood|calls dave/;
  const goodCher =
    /live|concert|perform|sing|farewell|vegas|believe|half-breed|gypsies|music video|met gala|oscars|red carpet|tour|stage/;
  const goodTom =
    /top gun|mission:?\s*impossible|stunt|clip|scene|acting|movie|premiere|digger|maverick|cockpit|jump|bike|perform|red carpet/;
  if (bad.test(t) && !(hero === "cher" ? goodCher : goodTom).test(t)) return false;
  if (hero === "cher") return goodCher.test(t) || /\bcher\b/.test(t);
  return goodTom.test(t) || /tom\s*cruise/.test(t);
}

async function poolHero(
  hero: "cher" | "tom",
  queries: string[],
  titleRe: RegExp,
): Promise<YouTubeVideoHit[]> {
  const byId = new Map<string, YouTubeVideoHit>();
  for (const q of queries) {
    if (byId.size >= MAX_SRC) break;
    for (const h of await ytSearch(q, 6)) {
      if (!titleRe.test(h.title)) continue;
      if (!isPerformanceTitle(h.title, hero)) continue;
      // Prefer mid-length clips (not 2hr dumps) when we have duration
      const dur = h.durationSec || 0;
      if (dur > 0 && (dur < 30 || dur > 7200)) continue;
      if (!byId.has(h.videoId)) byId.set(h.videoId, h);
      if (byId.size >= MAX_SRC) break;
    }
  }
  // If thin, loosen filter (still require name)
  if (byId.size < 6) {
    for (const q of queries) {
      for (const h of await ytSearch(q, 6)) {
        if (!titleRe.test(h.title)) continue;
        if (!byId.has(h.videoId)) byId.set(h.videoId, h);
        if (byId.size >= MAX_SRC) break;
      }
      if (byId.size >= MAX_SRC) break;
    }
  }
  return Array.from(byId.values()).slice(0, MAX_SRC);
}

function offset(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 12 + (h % 70);
}

function windows(v: YouTubeVideoHit): YouTubeClipSuggestion[] {
  // Prefer action-y middle sections of performances (skip cold open/credits)
  const dur = Math.max(90, v.durationSec || 400);
  const o = offset(v.videoId);
  const seeds = [
    Math.floor(dur * 0.15),
    Math.floor(dur * 0.28),
    Math.floor(dur * 0.4),
    Math.floor(dur * 0.52),
    Math.floor(dur * 0.65),
    Math.floor(dur * 0.78),
    o + 20,
    o + 55,
    o + 95,
    o + 140,
  ];
  const out: YouTubeClipSuggestion[] = [];
  const seen = new Set<number>();
  for (const raw of seeds) {
    const start = Math.max(
      10,
      Math.min(Math.floor(raw), Math.floor(dur - CLIP_SEC - 10)),
    );
    if (seen.has(start)) continue;
    seen.add(start);
    out.push({
      videoId: v.videoId,
      title: v.title,
      channelTitle: v.channelTitle,
      thumbnailUrl: v.thumbnailUrl,
      watchUrl: v.watchUrl,
      watchAtUrl: `${v.watchUrl}&t=${start}s`,
      startSec: start,
      endSec: start + CLIP_SEC,
      durationSec: CLIP_SEC,
      matchedText: "",
      score: 0.45,
      hasCaptions: false,
    });
  }
  return out;
}

function key(c: { videoId: string; startSec: number }) {
  return `${c.videoId}@${Math.floor(c.startSec / 5) * 5}`;
}

async function main() {
  const prev = JSON.parse(
    readFileSync("/tmp/cher_tom_plan.json", "utf8"),
  ) as {
    plan: Array<{
      line: number;
      mode: string;
      words: string;
      googleQuery?: string | null;
      reason?: string;
    }>;
  };

  console.log("· Searching PERFORMANCE sources (singing / acting / stunts)…");
  const [cherSrc, tomSrc] = await Promise.all([
    poolHero(
      "cher",
      [
        "Cher live concert singing",
        "Cher Believe live performance",
        "Cher Farewell Tour performance",
        "Cher music video",
        "Cher Oscars red carpet performance",
        "Cher Las Vegas residency live",
      ],
      /\bcher\b/i,
    ),
    poolHero(
      "tom",
      [
        "Tom Cruise Top Gun movie clip",
        "Tom Cruise Mission Impossible stunt",
        "Tom Cruise acting scene movie",
        "Tom Cruise Maverick flying scene",
        "Tom Cruise movie premiere red carpet",
        "Tom Cruise Digger premiere",
      ],
      /tom\s*cruise|\bcruise\b/i,
    ),
  ]);
  console.log(`Cher sources=${cherSrc.length} Tom sources=${tomSrc.length}`);
  for (const s of cherSrc) console.log("  C", s.videoId, s.title.slice(0, 70));
  for (const s of tomSrc) console.log("  T", s.videoId, s.title.slice(0, 70));

  const pools = {
    cher: new Map(cherSrc.map((v) => [v.videoId, windows(v)])),
    tom: new Map(tomSrc.map((v) => [v.videoId, windows(v)])),
  };
  const videos = { cher: cherSrc, tom: tomSrc };
  const used = new Set<string>();
  const usedVids = new Set<string>();

  const picks = prev.plan.map((p) => {
    if (p.mode === "images") {
      return {
        line: p.line,
        mode: "images" as const,
        words: p.words,
        googleQuery: p.googleQuery,
        reason: p.reason,
      };
    }
    const mode = p.mode as "cher" | "tom";
    const ranked = [...videos[mode]].sort(
      (a, b) =>
        (usedVids.has(a.videoId) ? 1 : 0) - (usedVids.has(b.videoId) ? 1 : 0),
    );
    let pick: YouTubeClipSuggestion | null = null;
    for (const v of ranked) {
      const pool = (pools[mode].get(v.videoId) || []).filter(
        (c) => !used.has(key(c)),
      );
      if (!pool.length) continue;
      pick = pool[0];
      used.add(key(pick));
      usedVids.add(pick.videoId);
      pools[mode].set(
        v.videoId,
        pool.filter((c) => Math.abs(c.startSec - pick!.startSec) >= MIN_GAP),
      );
      break;
    }
    if (!pick) {
      return {
        line: p.line,
        mode: "images" as const,
        words: p.words,
        googleQuery: p.words.slice(0, 90),
        reason: "no performance window → image",
      };
    }
    return {
      line: p.line,
      mode,
      words: p.words,
      startSec: pick.startSec,
      endSec: pick.endSec,
      watchAtUrl: pick.watchAtUrl,
      videoTitle: pick.title,
      videoId: pick.videoId,
      note: "performance/acting pool",
    };
  });

  const out = {
    title: "Cher & Tom Cruise — performance clips (acting/singing/stunts)",
    counts: {
      total: picks.length,
      cher: picks.filter((x) => x.mode === "cher").length,
      tom: picks.filter((x) => x.mode === "tom").length,
      images: picks.filter((x) => x.mode === "images").length,
    },
    cherSources: cherSrc.map((v) => ({
      id: v.videoId,
      title: v.title,
      url: v.watchUrl,
      dur: v.durationSec,
    })),
    tomSources: tomSrc.map((v) => ({
      id: v.videoId,
      title: v.title,
      url: v.watchUrl,
      dur: v.durationSec,
    })),
    picks,
  };

  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  writeFileSync(
    "/opt/cursor/artifacts/cher-tom-hero-clips.json",
    JSON.stringify(out, null, 2),
  );

  console.log("\n=== COUNTS ===", out.counts);
  console.log("\n=== CHER PERFORMANCE CLIPS ===");
  for (const p of picks) {
    if (p.mode !== "cher") continue;
    console.log(
      `L${p.line} ${p.startSec}s–${p.endSec}s ${p.watchAtUrl}\n  ${p.videoTitle}`,
    );
  }
  console.log("\n=== TOM PERFORMANCE CLIPS ===");
  for (const p of picks) {
    if (p.mode !== "tom") continue;
    console.log(
      `L${p.line} ${p.startSec}s–${p.endSec}s ${p.watchAtUrl}\n  ${p.videoTitle}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
