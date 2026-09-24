/**
 * FAST archaeology B-roll planner for Holy Sepulchre / Jerusalem excavation script.
 * ~30–35% YouTube (excavation, church, Old City, digs) · rest Google-image queries.
 * ≤20 horizontal sources, unique 3s windows. No per-clip vision (speed).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  searchYouTubeVideos,
  type YouTubeClipSuggestion,
  type YouTubeVideoHit,
} from "../src/lib/search/youtube";
import { getSearchApiKey } from "../src/lib/env";

const CLIP_SEC = 3;
const MIN_GAP = 35;
const MAX_SRC = 18;
type Mode = "video" | "images";
type PlanLine = {
  index: number;
  words: string;
  mode: Mode;
  visualHint: string;
  googleQuery: string | null;
  reason: string;
};

const TITLE =
  "Scientists found Christian Jerusalem buried beneath one ancient church";

async function ytSearch(q: string, n = 5): Promise<YouTubeVideoHit[]> {
  try {
    const hits = await searchYouTubeVideos(q, n);
    if (hits.length) return hits;
  } catch {
    /* */
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
        durationSec: 480,
      } as YouTubeVideoHit;
    })
    .filter((h): h is YouTubeVideoHit => Boolean(h))
    .slice(0, n);
}

function rejectVertical(h: YouTubeVideoHit) {
  const t = h.title.toLowerCase();
  return /#shorts|\bshorts\b|tiktok|vertical/.test(t);
}

async function planAll(lines: string[]): Promise<PlanLine[]> {
  // FAST heuristic (no LLM) — images for named details; video for place/dig/church action
  const plan: PlanLine[] = lines.map((words, i) => {
    const w = words.toLowerCase();
    const imageHit =
      /coin|pottery|lamp|pollen|grape|olive|fig|cereal|hadrian|constantine|stasolla|al-hakim|gospel of john|sapienza|mosaic|subscribe|constantius|valens|tenth legion|stamped brick|oil lamp|plant material|mortar|marble base|six-metre|337|378|1009|persian attack|crusader|armenian patriarchate|greek orthodox|custody of the holy land|israel antiquities|licence|agreement of the religious|digital mapping|3d documentation|100,000|pottery pieces|temporary floor|subscribe/.test(
        w,
      );
    const videoHit =
      /church|excavation|archaeolog|jerusalem|quarry|tomb|rotunda|pilgrim|dig|floor|wall|road|basilica|portico|old city|workers lifted|uncovered|buried|foundation|cemetery|garden|christian|roman|bedrock|chamber|apse|cistern|gutter|column|worship|holy sepulchre|holy sepulcher/.test(
        w,
      );
    let mode: Mode = imageHit ? "images" : videoHit ? "video" : "images";
    // Prefer images for abstract/question/subscribe
    if (/^how large|^what exactly|subscribe|that distinction matters|that caution/.test(w))
      mode = "images";
    return {
      index: i + 1,
      words,
      mode,
      reason: mode === "video" ? "place/dig action" : "detail/named B-roll",
      visualHint:
        mode === "video"
          ? "Holy Sepulchre / excavation / Jerusalem"
          : words.slice(0, 60),
      googleQuery: mode === "images" ? googleQ(words) : null,
    };
  });

  // Cap video ~32%
  const vmax = Math.round(lines.length * 0.32);
  const vids = plan
    .map((p, i) => ({ i, p }))
    .filter((x) => x.p.mode === "video");
  if (vids.length > vmax) {
    // Keep hook + evenly spaced; convert extras to images
    const keep = new Set<number>();
    const step = Math.max(1, Math.floor(vids.length / vmax));
    for (let k = 0; k < vids.length && keep.size < vmax; k += step) {
      keep.add(vids[k].i);
    }
    // fill remaining slots from start
    for (const { i } of vids) {
      if (keep.size >= vmax) break;
      keep.add(i);
    }
    for (const { i } of vids) {
      if (keep.has(i)) continue;
      plan[i] = {
        ...plan[i],
        mode: "images",
        googleQuery: googleQ(plan[i].words),
        reason: "cap→images",
      };
    }
  }
  return plan;
}

function googleQ(words: string): string {
  const w = words.toLowerCase();
  if (/coin|constantius|valens/.test(w))
    return "Roman 4th century coins Constantius Valens";
  if (/pottery|lamp/.test(w)) return "ancient Jerusalem pottery oil lamp archaeology";
  if (/olive|grape|fig|pollen|cereal|plant/.test(w))
    return "ancient olive vineyard grape archaeology Palestine";
  if (/hadrian|aelia/.test(w)) return "Emperor Hadrian Aelia Capitolina Jerusalem";
  if (/constantine/.test(w)) return "Emperor Constantine church Holy Sepulchre";
  if (/stasolla/.test(w)) return "Francesca Romana Stasolla archaeologist Holy Sepulchre";
  if (/al-hakim|1009/.test(w)) return "al-Hakim destruction Church of Holy Sepulchre 1009";
  if (/gospel/.test(w)) return "Gospel of John garden tomb manuscript";
  if (/tenth legion|stamped/.test(w)) return "Roman Tenth Legion stamped brick Jerusalem";
  if (/mosaic/.test(w)) return "Holy Sepulchre medieval mosaic fragments";
  if (/marble/.test(w)) return "Holy Sepulchre circular marble tomb foundation";
  if (/persian/.test(w)) return "Persian conquest Jerusalem 614 church";
  if (/crusader/.test(w)) return "Crusader Church of the Holy Sepulchre pillars";
  if (/map|plan|database|digital|3d/.test(w))
    return "archaeology 3D mapping Jerusalem excavation";
  return words.replace(/[^a-zA-Z0-9\s]/g, " ").split(/\s+/).slice(0, 10).join(" ");
}

function windows(v: YouTubeVideoHit): YouTubeClipSuggestion[] {
  const dur = Math.max(120, Math.min(v.durationSec || 500, 2000));
  const seeds = [
    Math.floor(dur * 0.2),
    Math.floor(dur * 0.32),
    Math.floor(dur * 0.44),
    Math.floor(dur * 0.56),
    Math.floor(dur * 0.68),
    Math.floor(dur * 0.8),
    45,
    90,
    140,
    200,
    280,
    360,
  ];
  const out: YouTubeClipSuggestion[] = [];
  const seen = new Set<number>();
  for (const raw of seeds) {
    const start = Math.max(
      15,
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
      score: 0.4,
      hasCaptions: false,
    });
  }
  return out;
}

function key(c: { videoId: string; startSec: number }) {
  return `${c.videoId}@${Math.floor(c.startSec / 5) * 5}`;
}

async function main() {
  const t0 = Date.now();
  const lines: string[] = JSON.parse(
    readFileSync("/tmp/holy_sepulchre_beats.json", "utf8"),
  );
  console.log(`[0s] beats=${lines.length}`);

  const plan = await planAll(lines);
  const vN = plan.filter((p) => p.mode === "video").length;
  const iN = plan.filter((p) => p.mode === "images").length;
  console.log(
    `[${((Date.now() - t0) / 1000).toFixed(0)}s] video=${vN} images=${iN}`,
  );

  console.log("· YouTube sources…");
  const queries = [
    "Church of the Holy Sepulchre Jerusalem interior",
    "Holy Sepulchre excavation archaeology",
    "Church of Holy Sepulchre floor restoration dig",
    "Jerusalem Old City archaeology excavation",
    "Holy Sepulchre rotunda tomb church",
    "Jerusalem limestone quarry archaeology",
    "Roman road Jerusalem archaeology",
    "Constantine church Holy Sepulchre documentary",
    "pilgrims Church of the Holy Sepulchre",
    "Israel archaeology dig Jerusalem church",
  ];
  const byId = new Map<string, YouTubeVideoHit>();
  for (const q of queries) {
    if (byId.size >= MAX_SRC) break;
    for (const h of await ytSearch(q, 5)) {
      if (rejectVertical(h)) continue;
      if (!byId.has(h.videoId)) byId.set(h.videoId, h);
      if (byId.size >= MAX_SRC) break;
    }
  }
  const sources = Array.from(byId.values()).slice(0, MAX_SRC);
  console.log(
    `[${((Date.now() - t0) / 1000).toFixed(0)}s] sources=${sources.length}`,
  );
  for (const s of sources) console.log(" ", s.videoId, s.title.slice(0, 70));

  const pools = new Map(sources.map((v) => [v.videoId, windows(v)]));
  const used = new Set<string>();
  const usedVids = new Set<string>();

  const picks = plan.map((p) => {
    if (p.mode === "images") {
      return {
        line: p.index,
        mode: "images" as const,
        words: p.words,
        googleQuery: p.googleQuery,
        reason: p.reason,
      };
    }
    const ranked = [...sources].sort(
      (a, b) =>
        (usedVids.has(a.videoId) ? 1 : 0) - (usedVids.has(b.videoId) ? 1 : 0),
    );
    let pick: YouTubeClipSuggestion | null = null;
    for (const v of ranked) {
      const pool = (pools.get(v.videoId) || []).filter((c) => !used.has(key(c)));
      if (!pool.length) continue;
      pick = pool[0];
      used.add(key(pick));
      usedVids.add(pick.videoId);
      pools.set(
        v.videoId,
        pool.filter((c) => Math.abs(c.startSec - pick!.startSec) >= MIN_GAP),
      );
      break;
    }
    if (!pick) {
      return {
        line: p.index,
        mode: "images" as const,
        words: p.words,
        googleQuery: p.visualHint || p.words.slice(0, 90),
        reason: "no clip slot → image",
      };
    }
    return {
      line: p.index,
      mode: "video" as const,
      words: p.words,
      startSec: pick.startSec,
      endSec: pick.endSec,
      watchAtUrl: pick.watchAtUrl,
      videoTitle: pick.title,
      videoId: pick.videoId,
    };
  });

  const out = {
    title: TITLE,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    counts: {
      total: picks.length,
      video: picks.filter((p) => p.mode === "video").length,
      images: picks.filter((p) => p.mode === "images").length,
    },
    sources: sources.map((s) => ({
      id: s.videoId,
      title: s.title,
      url: s.watchUrl,
    })),
    picks,
  };

  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  writeFileSync(
    "/opt/cursor/artifacts/holy-sepulchre-clips.json",
    JSON.stringify(out, null, 2),
  );

  const txt: string[] = [
    `HOLY SEPULCHRE CLIPS · ${out.counts.video} video · ${out.counts.images} images · ${out.elapsedSec}s`,
    "",
    "VIDEO",
    "=====",
  ];
  for (const p of picks) {
    if (p.mode !== "video") continue;
    txt.push(
      `L${p.line} | ${p.startSec}-${p.endSec}s | ${p.watchAtUrl}`,
    );
    txt.push(`  ${p.words}`);
    txt.push(`  ${p.videoTitle}`);
    txt.push("");
  }
  txt.push("IMAGES");
  txt.push("======");
  for (const p of picks) {
    if (p.mode !== "images") continue;
    txt.push(`L${p.line} | IMAGE | ${p.googleQuery}`);
    txt.push(`  ${p.words}`);
    txt.push("");
  }
  writeFileSync(
    "/opt/cursor/artifacts/holy-sepulchre-ALL-LINKS.txt",
    txt.join("\n"),
  );

  console.log("\n=== DONE ===", out.counts, `${out.elapsedSec}s`);
  console.log("\nVIDEO LINKS:");
  for (const p of picks) {
    if (p.mode !== "video") continue;
    console.log(`L${p.line}\t${p.startSec}s\t${p.watchAtUrl}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
