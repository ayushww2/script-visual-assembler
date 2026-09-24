/**
 * Vision-verify Holy Sepulchre B-roll sources (max 10), reassign unique 3s clips.
 * Accepts clear horizontal church / excavation / Jerusalem archaeology footage.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createContactBoxClient, getContactBoxConfig } from "../src/lib/contactbox";
import {
  searchYouTubeVideos,
  type YouTubeClipSuggestion,
  type YouTubeVideoHit,
} from "../src/lib/search/youtube";
import { getSearchApiKey } from "../src/lib/env";
import { mapPool } from "../src/lib/jobs/pool";

const CLIP_SEC = 3;
const MIN_GAP = 35;
const MAX_SRC = 10;
const VISION_CONCURRENCY = 3;

type VisionResult = {
  usable: boolean;
  horizontal: boolean;
  subjectOk: boolean;
  clear: boolean;
  framing: string;
  verdict: string;
};

function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (f?.[1]) return JSON.parse(f[1].trim());
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("bad JSON");
  }
}

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
        durationSec: 500,
      } as YouTubeVideoHit;
    })
    .filter((h): h is YouTubeVideoHit => Boolean(h))
    .slice(0, n);
}

function rejectBad(h: YouTubeVideoHit) {
  const t = h.title.toLowerCase();
  if (/#shorts|\bshorts\b|tiktok|vertical|reaction|asmr/.test(t)) return true;
  if (h.durationSec && h.durationSec > 0 && h.durationSec < 60) return true;
  return false;
}

async function fetchThumb(
  videoId: string,
  which: "maxresdefault" | "sddefault" | "hq2" | "hq1" | "hq3",
) {
  const url = `https://i.ytimg.com/vi/${videoId}/${which}.jpg`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`thumb ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2500) throw new Error("tiny");
  return { url, dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}` };
}

async function visionFrame(input: {
  title: string;
  dataUrl: string;
}): Promise<VisionResult> {
  const { model } = getContactBoxConfig();
  const client = createContactBoxClient();
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `STRICT documentary B-roll QA for a film about archaeology under the Church of the Holy Sepulchre in Jerusalem.

ACCEPT (usable=true) only if ALL:
1) horizontal/landscape frame
2) clear, sharp enough to use as cutaway (not mush/black/logo-only)
3) subject is relevant: church interior/exterior, excavation dig, archaeologists at work, stone walls/tombs/quarry rock, Jerusalem Old City streets, pilgrims at Holy Sepulchre, rotunda/tomb area

REJECT: vertical shorts, gaming, memes, unrelated vlogs, text cards only, wrong city with no church/dig, faces of celebrities unrelated to this story, pure maps/graphics with no real footage.

JSON:
{
  "usable": true/false,
  "horizontal": true/false,
  "subjectOk": true/false,
  "clear": true/false,
  "framing": "close"|"medium"|"wide"|"unknown",
  "verdict": "short"
}`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `VIDEO TITLE: ${input.title}\nIs this usable Holy Sepulchre / Jerusalem archaeology B-roll?`,
          },
          {
            type: "image_url",
            image_url: { url: input.dataUrl, detail: "low" },
          },
        ],
      },
    ],
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return {
      usable: false,
      horizontal: false,
      subjectOk: false,
      clear: false,
      framing: "unknown",
      verdict: "empty",
    };
  }
  const p = extractJson(raw) as Partial<VisionResult>;
  const horizontal = Boolean(p.horizontal);
  const subjectOk = Boolean(p.subjectOk);
  const clear = Boolean(p.clear);
  const usable =
    Boolean(p.usable) && horizontal && subjectOk && clear;
  return {
    usable,
    horizontal,
    subjectOk,
    clear,
    framing: String(p.framing || "unknown"),
    verdict: String(p.verdict || ""),
  };
}

type Verified = YouTubeVideoHit & {
  vision: VisionResult;
  frameUrl: string;
  frameKind: string;
};

async function collectCandidates(): Promise<YouTubeVideoHit[]> {
  const queries = [
    "Church of the Holy Sepulchre Jerusalem interior tour",
    "Holy Sepulchre excavation archaeology dig",
    "Holy Sepulcher archaeological excavations",
    "Church of Holy Sepulchre floor restoration",
    "Jerusalem Old City Holy Sepulchre pilgrims",
    "Secrets of Christ's Tomb National Geographic",
    "Holy Sepulchre rotunda empty tomb",
    "Jerusalem archaeology dig church",
  ];
  const byId = new Map<string, YouTubeVideoHit>();
  // Prefer prior sources first if still in plan file
  try {
    const prev = JSON.parse(
      readFileSync("/tmp/holy_sep_plan.json", "utf8"),
    ) as { sources?: Array<{ id: string; title: string; url: string }> };
    for (const s of prev.sources || []) {
      if (!s.id) continue;
      byId.set(s.id, {
        videoId: s.id,
        title: s.title,
        channelTitle: "",
        description: "",
        watchUrl: s.url || `https://www.youtube.com/watch?v=${s.id}`,
        durationSec: 600,
      });
    }
  } catch {
    /* */
  }
  for (const q of queries) {
    if (byId.size >= 24) break;
    for (const h of await ytSearch(q, 5)) {
      if (rejectBad(h)) continue;
      if (!byId.has(h.videoId)) byId.set(h.videoId, h);
    }
  }
  return Array.from(byId.values()).slice(0, 24);
}

async function verifySources(cands: YouTubeVideoHit[]): Promise<Verified[]> {
  const out: Verified[] = [];
  await mapPool(cands, VISION_CONCURRENCY, async (h) => {
    if (out.length >= MAX_SRC) return;
    for (const kind of ["hq2", "maxresdefault", "sddefault", "hq1"] as const) {
      try {
        const thumb = await fetchThumb(h.videoId, kind);
        const vision = await visionFrame({
          title: h.title,
          dataUrl: thumb.dataUrl,
        });
        console.log(
          `  ${h.videoId}@${kind}: usable=${vision.usable} clear=${vision.clear} subject=${vision.subjectOk} · ${vision.verdict}`,
        );
        if (vision.usable && out.length < MAX_SRC) {
          out.push({
            ...h,
            vision,
            frameUrl: thumb.url,
            frameKind: kind,
          });
          return;
        }
      } catch (e) {
        console.log(
          `  fail ${h.videoId}@${kind}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  });
  return out.slice(0, MAX_SRC);
}

function windows(v: YouTubeVideoHit): YouTubeClipSuggestion[] {
  const dur = Math.max(120, Math.min(v.durationSec || 500, 1800));
  const seeds = [
    Math.floor(dur * 0.22),
    Math.floor(dur * 0.35),
    Math.floor(dur * 0.48),
    Math.floor(dur * 0.6),
    Math.floor(dur * 0.72),
    40,
    85,
    130,
    180,
    240,
    320,
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
      score: 0.5,
      hasCaptions: false,
    });
  }
  return out;
}

function clipKey(c: { videoId: string; startSec: number }) {
  return `${c.videoId}@${Math.floor(c.startSec / 5) * 5}`;
}

async function main() {
  const t0 = Date.now();
  const prev = JSON.parse(
    readFileSync("/tmp/holy_sep_plan.json", "utf8"),
  ) as {
    plan: Array<{
      line: number;
      mode: string;
      words: string;
      googleQuery?: string | null;
      reason?: string;
    }>;
  };

  console.log("· Collect candidates…");
  const cands = await collectCandidates();
  console.log(`candidates=${cands.length}`);

  console.log("· Vision (max 10 usable sources)…");
  const sources = await verifySources(cands);
  console.log(
    `[${((Date.now() - t0) / 1000).toFixed(0)}s] verified=${sources.length}`,
  );
  for (const s of sources) {
    console.log(
      `  ✓ ${s.videoId} [${s.vision.framing}] ${s.title.slice(0, 60)} · ${s.vision.verdict}`,
    );
  }

  const pools = new Map(sources.map((v) => [v.videoId, windows(v)]));
  const used = new Set<string>();
  const usedVids = new Set<string>();

  const picks = prev.plan.map((p) => {
    if (p.mode !== "video") {
      return {
        line: p.line,
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
    let src: Verified | null = null;
    for (const v of ranked) {
      const pool = (pools.get(v.videoId) || []).filter((c) => !used.has(clipKey(c)));
      if (!pool.length) continue;
      pick = pool[0];
      src = v;
      used.add(clipKey(pick));
      usedVids.add(pick.videoId);
      pools.set(
        v.videoId,
        pool.filter((c) => Math.abs(c.startSec - pick!.startSec) >= MIN_GAP),
      );
      break;
    }
    if (!pick || !src) {
      return {
        line: p.line,
        mode: "images" as const,
        words: p.words,
        googleQuery: p.googleQuery || p.words.slice(0, 90),
        reason: "no vision-verified slot → image",
      };
    }
    return {
      line: p.line,
      mode: "video" as const,
      words: p.words,
      startSec: pick.startSec,
      endSec: pick.endSec,
      watchAtUrl: pick.watchAtUrl,
      videoTitle: pick.title,
      videoId: pick.videoId,
      visionVerdict: src.vision.verdict,
      frameChecked: src.frameUrl,
      note: `3s · vision-ok (${src.frameKind})`,
    };
  });

  const out = {
    title:
      "Holy Sepulchre — vision-verified 3s clips (max 10 sources)",
    clipSec: CLIP_SEC,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    visionNote:
      "ContactBox vision on YouTube landscape mid-frames (hq/maxres). Max 10 sources. Exact-second screenshots blocked by YouTube bot checks.",
    counts: {
      total: picks.length,
      video: picks.filter((p) => p.mode === "video").length,
      images: picks.filter((p) => p.mode === "images").length,
    },
    sources: sources.map((s) => ({
      id: s.videoId,
      title: s.title,
      url: s.watchUrl,
      framing: s.vision.framing,
      vision: s.vision.verdict,
      frame: s.frameUrl,
    })),
    picks,
  };

  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  writeFileSync(
    "/opt/cursor/artifacts/holy-sepulchre-clips.json",
    JSON.stringify(out, null, 2),
  );

  const txt: string[] = [
    `HOLY SEPULCHRE · VISION · ${out.counts.video} video · ${out.counts.images} images · ${out.elapsedSec}s · sources ${sources.length}/10`,
    "",
    "SOURCES",
    "=======",
  ];
  for (const s of out.sources) {
    txt.push(`${s.id} | ${s.framing} | ${s.vision}`);
    txt.push(`  ${s.title}`);
    txt.push(`  ${s.url}`);
    txt.push(`  frame: ${s.frame}`);
    txt.push("");
  }
  txt.push("VIDEO");
  txt.push("=====");
  for (const p of picks) {
    if (p.mode !== "video") continue;
    txt.push(`L${p.line} | ${p.startSec}-${p.endSec}s | ${p.watchAtUrl}`);
    txt.push(`  ${p.words}`);
    txt.push(`  ${p.videoTitle}`);
    txt.push(`  vision: ${p.visionVerdict}`);
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
  console.log("\nVIDEO:");
  for (const p of picks) {
    if (p.mode !== "video") continue;
    console.log(`L${p.line}\t${p.startSec}s\t${p.watchAtUrl}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
