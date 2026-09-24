/**
 * Stricter vision: reject wide/dark stage blobs. Require clear face,
 * medium/close framing (like a usable documentary cutaway).
 * Prefer music videos / TV performances over full-concert wide masters.
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
  personVisible: boolean;
  faceClear: boolean;
  framing: "close" | "medium" | "wide" | "unknown";
  horizontal: boolean;
  performing: boolean;
  interviewOk: boolean;
  usable: boolean;
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

async function ytSearch(q: string, n = 6): Promise<YouTubeVideoHit[]> {
  try {
    const hits = await searchYouTubeVideos(q, n);
    if (hits.length) return hits;
  } catch {
    /* fallthrough */
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
      length?: string;
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
        durationSec: parseLen(v.length) || 400,
      } as YouTubeVideoHit;
    })
    .filter((h): h is YouTubeVideoHit => Boolean(h))
    .slice(0, n);
}

function parseLen(s?: string): number | undefined {
  if (!s) return undefined;
  const p = s.split(":").map(Number);
  if (p.some((n) => Number.isNaN(n))) return undefined;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0];
}

function rejectBad(h: YouTubeVideoHit): boolean {
  const t = h.title.toLowerCase();
  if (/#shorts|\bshorts\b|tiktok|reel\b|vertical/.test(t)) return true;
  if (h.durationSec && h.durationSec > 0 && h.durationSec <= 45) return true;
  // Prefer not ultra-long full concerts as primary (too many wide shots)
  if (h.durationSec && h.durationSec > 2400) return true;
  return false;
}

function preferScore(title: string, hero: "cher" | "tom"): number {
  const t = title.toLowerCase();
  let s = 0;
  if (/music video|official video|video hd|4k|remaster/.test(t)) s += 5;
  if (/billboard|awards|wetten|divas|tonight show|snl|performance/.test(t))
    s += 4;
  if (/believe|if i could turn back time|strong enough|heart of stone/.test(t))
    s += 2;
  if (/live|concert|farewell|vegas|mirage/.test(t)) s += 1;
  if (/full concert|entire show|full show|full tour/.test(t)) s -= 3;
  if (hero === "tom") {
    if (/clip|scene|stunt|maverick|top gun|mission/.test(t)) s += 4;
    if (/best acting|moments/.test(t)) s += 2;
    if (/premiere|red carpet/.test(t)) s += 1;
  }
  if (/interview/.test(t)) s += 0; // allowed but not preferred
  return s;
}

async function collect(
  hero: "cher" | "tom",
  queries: string[],
  titleRe: RegExp,
): Promise<YouTubeVideoHit[]> {
  const byId = new Map<string, YouTubeVideoHit>();
  for (const q of queries) {
    for (const h of await ytSearch(q, 7)) {
      if (!titleRe.test(h.title)) continue;
      if (rejectBad(h)) continue;
      if (!byId.has(h.videoId)) byId.set(h.videoId, h);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => preferScore(b.title, hero) - preferScore(a.title, hero))
    .slice(0, 22);
}

async function fetchThumb(videoId: string, which: "hq1" | "hq2" | "hq3" | "maxresdefault" | "sddefault") {
  const url = `https://i.ytimg.com/vi/${videoId}/${which}.jpg`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`thumb ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 3000) throw new Error("tiny");
  return { url, dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}` };
}

async function visionStrict(input: {
  heroName: string;
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
        content: `You are a STRICT documentary B-roll QA reviewer.

ACCEPT only if ALL are true:
1) TARGET's FACE is clearly recognizable (eyes/nose/mouth readable — not a distant silhouette)
2) Framing is close or medium (head+shoulders or waist-up). REJECT wide stage shots where the person is a small figure under a spotlight.
3) Frame is horizontal/landscape
4) They are singing/performing/acting OR in a clear interview close-up

REJECT:
- dark wide concert shots with tiny performer
- back-to-camera only
- heavy blur / pixel mush where face can't be ID'd
- wrong person
- posters, text cards, logos

JSON:
{
  "personVisible": true/false,
  "faceClear": true/false,
  "framing": "close"|"medium"|"wide"|"unknown",
  "horizontal": true/false,
  "performing": true/false,
  "interviewOk": true/false,
  "usable": true/false,
  "verdict": "short"
}
usable=true ONLY if faceClear AND framing is close|medium AND horizontal AND (performing OR interviewOk).`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `TARGET: ${input.heroName}\nTITLE: ${input.title}\nWould an editor use this as a CLEAR cutaway of the target?`,
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
      personVisible: false,
      faceClear: false,
      framing: "unknown",
      horizontal: false,
      performing: false,
      interviewOk: false,
      usable: false,
      verdict: "empty",
    };
  }
  const p = extractJson(raw) as Partial<VisionResult>;
  const framing = (["close", "medium", "wide", "unknown"].includes(
    String(p.framing),
  )
    ? p.framing
    : "unknown") as VisionResult["framing"];
  const faceClear = Boolean(p.faceClear);
  const horizontal = Boolean(p.horizontal);
  const performing = Boolean(p.performing);
  const interviewOk = Boolean(p.interviewOk);
  const usable =
    Boolean(p.usable) &&
    faceClear &&
    horizontal &&
    (framing === "close" || framing === "medium") &&
    (performing || interviewOk);
  return {
    personVisible: Boolean(p.personVisible),
    faceClear,
    framing,
    horizontal,
    performing,
    interviewOk,
    usable,
    verdict: String(p.verdict || ""),
  };
}

type Verified = YouTubeVideoHit & {
  vision: VisionResult;
  frameUrl: string;
  frameKind: string;
};

async function verify(
  heroName: string,
  cands: YouTubeVideoHit[],
): Promise<Verified[]> {
  const out: Verified[] = [];
  await mapPool(cands, VISION_CONCURRENCY, async (h) => {
    if (out.length >= MAX_SRC) return;
    // Prefer maxres/sd then hq — closer poster frames often clearer than hq2 wide
    for (const kind of ["maxresdefault", "sddefault", "hq2", "hq1", "hq3"] as const) {
      try {
        const thumb = await fetchThumb(h.videoId, kind);
        const vision = await visionStrict({
          heroName,
          title: h.title,
          dataUrl: thumb.dataUrl,
        });
        console.log(
          `  ${heroName} ${h.videoId}@${kind}: usable=${vision.usable} face=${vision.faceClear} frame=${vision.framing} · ${vision.verdict}`,
        );
        if (vision.usable) {
          if (out.length < MAX_SRC) {
            out.push({
              ...h,
              vision,
              frameUrl: thumb.url,
              frameKind: kind,
            });
          }
          return;
        }
        // If maxres was wide reject, still try hq variants
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
  const dur = Math.max(90, Math.min(v.durationSec || 360, 1800));
  // Bias toward middle of video where close-ups usually live — skip cold open
  const seeds = [
    Math.floor(dur * 0.35),
    Math.floor(dur * 0.45),
    Math.floor(dur * 0.55),
    Math.floor(dur * 0.65),
    Math.floor(dur * 0.25),
    Math.floor(dur * 0.75),
    Math.floor(dur * 0.4) + 40,
    Math.floor(dur * 0.5) + 55,
  ];
  const out: YouTubeClipSuggestion[] = [];
  const seen = new Set<number>();
  for (const raw of seeds) {
    const start = Math.max(
      20,
      Math.min(Math.floor(raw), Math.floor(dur - CLIP_SEC - 15)),
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
      score: 0.55,
      hasCaptions: false,
    });
  }
  return out;
}

function clipKey(c: { videoId: string; startSec: number }) {
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

  console.log("· Searching clearer performance sources…");
  const [cherCands, tomCands] = await Promise.all([
    collect(
      "cher",
      [
        "Cher Believe live close up performance",
        "Cher If I Could Turn Back Time live HD",
        "Cher music video official HD",
        "Cher Divas Live Believe performance",
        "Cher Billboard Music Awards Believe",
        "Cher Strong Enough live closeup",
        "Cher interview close up 1990s",
      ],
      /\bcher\b/i,
    ),
    collect(
      "tom",
      [
        "Tom Cruise Top Gun close up scene clip",
        "Tom Cruise Mission Impossible stunt closeup",
        "Tom Cruise Maverick cockpit scene",
        "Tom Cruise best acting moments HD",
        "Tom Cruise interview close up",
        "Tom Cruise movie scene clip horizontal",
      ],
      /tom\s*cruise/i,
    ),
  ]);
  console.log(`cands cher=${cherCands.length} tom=${tomCands.length}`);

  console.log("· STRICT vision (clear face + medium/close only)…");
  const [cherSrc, tomSrc] = await Promise.all([
    verify("Cher", cherCands),
    verify("Tom Cruise", tomCands),
  ]);
  console.log(`usable sources cher=${cherSrc.length} tom=${tomSrc.length}`);
  for (const s of cherSrc)
    console.log("  C", s.videoId, s.vision.framing, s.title.slice(0, 55));
  for (const s of tomSrc)
    console.log("  T", s.videoId, s.vision.framing, s.title.slice(0, 55));

  if (cherSrc.length < 3 || tomSrc.length < 3) {
    console.warn("WARNING: few usable sources — still assigning what we have");
  }

  const pools = {
    cher: new Map(cherSrc.map((v) => [v.videoId, windows(v)])),
    tom: new Map(tomSrc.map((v) => [v.videoId, windows(v)])),
  };
  const videos = { cher: cherSrc, tom: tomSrc };
  const used = new Set<string>();
  const usedVids = new Set<string>();

  type OutPick =
    | {
        line: number;
        mode: "images";
        words: string;
        googleQuery?: string | null;
        reason?: string;
      }
    | {
        line: number;
        mode: "cher" | "tom";
        words: string;
        startSec: number;
        endSec: number;
        watchAtUrl: string;
        videoTitle: string;
        videoId: string;
        visionVerdict: string;
        framing: string;
        frameChecked: string;
        note: string;
      };

  const picks: OutPick[] = [];
  for (const p of prev.plan) {
    if (p.mode === "images") {
      picks.push({
        line: p.line,
        mode: "images",
        words: p.words,
        googleQuery: p.googleQuery,
        reason: p.reason,
      });
      continue;
    }
    const mode = p.mode as "cher" | "tom";
    const ranked = [...videos[mode]].sort(
      (a, b) =>
        (usedVids.has(a.videoId) ? 1 : 0) - (usedVids.has(b.videoId) ? 1 : 0),
    );
    let chosen: OutPick | null = null;
    for (const v of ranked) {
      const pool = (pools[mode].get(v.videoId) || []).filter(
        (c) => !used.has(clipKey(c)),
      );
      if (!pool.length) continue;
      const ok = pool[0];
      used.add(clipKey(ok));
      usedVids.add(ok.videoId);
      pools[mode].set(
        v.videoId,
        pool.filter((c) => Math.abs(c.startSec - ok.startSec) >= MIN_GAP),
      );
      chosen = {
        line: p.line,
        mode,
        words: p.words,
        startSec: ok.startSec,
        endSec: ok.endSec,
        watchAtUrl: ok.watchAtUrl,
        videoTitle: ok.title,
        videoId: ok.videoId,
        visionVerdict: v.vision.verdict,
        framing: v.vision.framing,
        frameChecked: v.frameUrl,
        note: `3s · clear ${v.vision.framing} face (${v.frameKind})`,
      };
      break;
    }
    if (!chosen) {
      picks.push({
        line: p.line,
        mode: "images",
        words: p.words,
        googleQuery: p.words.slice(0, 90),
        reason: "no clear-face horizontal clip → image",
      });
    } else picks.push(chosen);
  }

  const out = {
    title:
      "Cher & Tom Cruise — CLEAR face medium/close 3s clips (strict vision)",
    clipSec: CLIP_SEC,
    visionNote:
      "Strict ContactBox vision: faceClear + close/medium framing required. Wide dark stage shots rejected. Timestamps biased to mid-video.",
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
      framing: v.vision.framing,
      vision: v.vision.verdict,
      frame: v.frameUrl,
    })),
    tomSources: tomSrc.map((v) => ({
      id: v.videoId,
      title: v.title,
      url: v.watchUrl,
      framing: v.vision.framing,
      vision: v.vision.verdict,
      frame: v.frameUrl,
    })),
    picks,
  };

  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  writeFileSync(
    "/opt/cursor/artifacts/cher-tom-hero-clips.json",
    JSON.stringify(out, null, 2),
  );
  writeFileSync(
    "/opt/cursor/artifacts/cher-tom-CLEAR-sources.json",
    JSON.stringify(
      { cher: out.cherSources, tom: out.tomSources },
      null,
      2,
    ),
  );

  console.log("\n=== DONE ===", out.counts);
  console.log("\nCHER clear clips:");
  for (const p of picks) {
    if (p.mode !== "cher") continue;
    console.log(
      `L${p.line} [${p.framing}] ${p.startSec}s ${p.watchAtUrl}\n  ${p.videoTitle}\n  ${p.visionVerdict}`,
    );
  }
  console.log("\nTOM clear clips:");
  for (const p of picks) {
    if (p.mode !== "tom") continue;
    console.log(
      `L${p.line} [${p.framing}] ${p.startSec}s ${p.watchAtUrl}\n  ${p.videoTitle}\n  ${p.visionVerdict}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
