/**
 * Vision-verified 50 YouTube clip lines per script.
 * - Heroes searched separately (never dual query)
 * - Vision on start-region frame (hq1/2/3 by timestamp; exact t=0s blocked by YT)
 * - Intended show per line + ContactBox cost tracking
 *
 * SEARCHAPI_API_KEY=... npx tsx scripts/vision-50-batch.mts
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createContactBoxClient, getContactBoxConfig } from "../src/lib/contactbox";
import { getSearchApiKey } from "../src/lib/env";
import {
  searchYouTubeVideos,
  type YouTubeClipSuggestion,
  type YouTubeVideoHit,
} from "../src/lib/search/youtube";
import { mapPool } from "../src/lib/jobs/pool";

const CLIP_SEC = 4;
const MIN_GAP = 45;
const MAX_SRC_PER_HERO = 8;
const VIDEO_LINES = 50;
const VISION_CONCURRENCY = 3;
const TERRA_IN = 2;
const TERRA_OUT = 12;
const DISCOUNT = 0.1; // user ContactBox ~90% off → pay 10%

type ScriptCfg = {
  id: string;
  file: string;
  kind: "hero" | "dual-hero" | "place";
  heroes: string[];
  searchByHero: Record<string, string[]>;
};

const SCRIPTS: ScriptCfg[] = [
  {
    id: "neverland",
    file: "/tmp/vision50/neverland-lines.json",
    kind: "place",
    heroes: ["Michael Jackson", "Neverland"],
    searchByHero: {
      "Michael Jackson": [
        "Michael Jackson Neverland Ranch documentary",
        "Michael Jackson 2005 trial courtroom",
        "Michael Jackson interview Neverland",
        "Michael Jackson Neverland search warrant news",
      ],
      Neverland: [
        "Neverland Ranch California aerial tour",
        "Neverland Ranch Ferris wheel train zoo",
        "Inside Neverland Ranch documentary",
        "Sycamore Valley Ranch former Neverland",
      ],
    },
  },
  {
    id: "cliff",
    file: "/tmp/vision50/cliff-lines.json",
    kind: "hero",
    heroes: ["Cliff Richard"],
    searchByHero: {
      "Cliff Richard": [
        "Cliff Richard interview documentary",
        "Cliff Richard Move It Live",
        "Cliff Richard concert performance",
        "Cliff Richard Living Doll",
        "Cliff Richard Royal Albert Hall",
        "Cliff Richard BBC interview",
      ],
    },
  },
  {
    id: "osteen",
    file: "/tmp/vision50/osteen-lines.json",
    kind: "place",
    heroes: ["Joel Osteen", "Lakewood"],
    searchByHero: {
      "Joel Osteen": [
        "Joel Osteen sermon Lakewood Church",
        "Joel Osteen interview wealth books",
        "Joel Osteen Lakewood Church Houston interior",
      ],
      Lakewood: [
        "Lakewood Church Houston arena tour",
        "Houston River Oaks mansions aerial",
        "Joel Osteen Lakewood Church worship service",
      ],
    },
  },
  {
    id: "elvis",
    file: "/tmp/vision50/elvis-lines.json",
    kind: "place",
    heroes: ["Elvis Presley", "Graceland"],
    searchByHero: {
      "Elvis Presley": [
        "Elvis Presley interview documentary",
        "Elvis Presley concert performance 1970s",
        "Elvis Presley Jungle Room Graceland",
      ],
      Graceland: [
        "Graceland mansion tour Memphis documentary",
        "Inside Graceland Elvis home tour",
        "Graceland Jungle Room den tour",
        "Graceland upstairs private rooms documentary",
      ],
    },
  },
  {
    id: "dolly-miley",
    file: "/tmp/vision50/dolly-miley-lines.json",
    kind: "dual-hero",
    heroes: ["Dolly Parton", "Miley Cyrus"],
    searchByHero: {
      "Dolly Parton": [
        "Dolly Parton interview documentary",
        "Dolly Parton live performance concert",
        "Dolly Parton I Will Always Love You live",
        "Dolly Parton Grammy performance",
      ],
      "Miley Cyrus": [
        "Miley Cyrus interview documentary",
        "Miley Cyrus live concert performance",
        "Miley Cyrus Wrecking Ball live",
        "Miley Cyrus Grammy performance",
        "Miley Cyrus Dolly Parton New Years Eve duet",
      ],
    },
  },
];

type Usage = { input: number; output: number; calls: number };

const usage: Usage = { input: 0, output: 0, calls: 0 };
const usageByScript: Record<string, Usage> = {};

function addUsage(scriptId: string, u?: { prompt_tokens?: number; completion_tokens?: number }) {
  const inn = u?.prompt_tokens || 0;
  const out = u?.completion_tokens || 0;
  usage.input += inn;
  usage.output += out;
  usage.calls += 1;
  if (!usageByScript[scriptId]) usageByScript[scriptId] = { input: 0, output: 0, calls: 0 };
  usageByScript[scriptId].input += inn;
  usageByScript[scriptId].output += out;
  usageByScript[scriptId].calls += 1;
}

function costUsd(u: Usage, discounted: boolean) {
  const mul = discounted ? DISCOUNT : 1;
  return (
    (u.input / 1_000_000) * TERRA_IN * mul +
    (u.output / 1_000_000) * TERRA_OUT * mul
  );
}

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

function parseLen(s?: string): number | undefined {
  if (!s) return undefined;
  const p = s.split(":").map(Number);
  if (p.some((n) => Number.isNaN(n))) return undefined;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0];
}

function rejectBad(h: YouTubeVideoHit) {
  const t = h.title.toLowerCase();
  if (/#shorts|\bshorts\b|tiktok|vertical|reaction|asmr|ai generated/.test(t))
    return true;
  if (h.durationSec && h.durationSec > 0 && h.durationSec < 75) return true;
  return false;
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
  if (!res.ok) {
    console.log(`  searchapi ${res.status}: ${q.slice(0, 50)}`);
    return [];
  }
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
        durationSec: parseLen(v.length) || 500,
      } as YouTubeVideoHit;
    })
    .filter((h): h is YouTubeVideoHit => Boolean(h))
    .slice(0, n);
}

async function fetchThumb(
  videoId: string,
  which: "hq1" | "hq2" | "hq3" | "maxresdefault" | "sddefault",
) {
  const url = `https://i.ytimg.com/vi/${videoId}/${which}.jpg`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`thumb ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2500) throw new Error("tiny");
  return { url, dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}` };
}

/** Pick frame nearest the clip start region (exact second frames bot-blocked). */
function startRegionKind(
  startSec: number,
  durationSec: number,
): "hq1" | "hq2" | "hq3" {
  const dur = Math.max(durationSec || 500, 1);
  const r = startSec / dur;
  if (r < 0.34) return "hq1";
  if (r < 0.67) return "hq2";
  return "hq3";
}

type SrcVision = {
  usable: boolean;
  watermark: boolean;
  horizontal: boolean;
  clear: boolean;
  subjectOk: boolean;
  shows: string;
  verdict: string;
};

async function visionSource(
  scriptId: string,
  title: string,
  frames: Array<{ kind: string; dataUrl: string }>,
): Promise<SrcVision> {
  const { model } = getContactBoxConfig();
  const client = createContactBoxClient();
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail: "low" } }
  > = [
    {
      type: "text",
      text: `VIDEO TITLE: ${title}

QA documentary B-roll frames (early/mid/late samples).
REJECT if ANY frame has watermark/logo/channel bug/lower-third/stock overlay, vertical shorts, or unrelated junk.
ACCEPT only clean horizontal relevant footage.

JSON:
{"usable":bool,"watermark":bool,"horizontal":bool,"clear":bool,"subjectOk":bool,"shows":"what clean frames show","verdict":"short"}`,
    },
  ];
  for (const f of frames) {
    content.push({ type: "text", text: `Frame ${f.kind}:` });
    content.push({
      type: "image_url",
      image_url: { url: f.dataUrl, detail: "low" },
    });
  }
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Documentary B-roll QA. Reject watermarks. JSON only.",
      },
      { role: "user", content },
    ],
  });
  addUsage(scriptId, completion.usage || undefined);
  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return {
      usable: false,
      watermark: true,
      horizontal: false,
      clear: false,
      subjectOk: false,
      shows: "",
      verdict: "empty",
    };
  }
  const p = extractJson(raw) as Partial<SrcVision>;
  const watermark = Boolean(p.watermark);
  const usable =
    Boolean(p.usable) &&
    !watermark &&
    Boolean(p.horizontal) &&
    Boolean(p.clear) &&
    Boolean(p.subjectOk);
  return {
    usable,
    watermark,
    horizontal: Boolean(p.horizontal),
    clear: Boolean(p.clear),
    subjectOk: Boolean(p.subjectOk),
    shows: String(p.shows || ""),
    verdict: String(p.verdict || ""),
  };
}

type MatchVision = {
  matches: boolean;
  watermark: boolean;
  showsNow: string;
  verdict: string;
};

async function visionStartFrame(
  scriptId: string,
  input: {
    words: string;
    intended: string;
    title: string;
    startSec: number;
    dataUrl: string;
  },
): Promise<MatchVision> {
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
        content:
          "Match documentary B-roll start-frame to intended visual. Reject watermarks. JSON only.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `SCRIPT LINE: ${input.words}
INTENDED TO SHOW: ${input.intended}
VIDEO TITLE: ${input.title}
CLIP START SEC: ${input.startSec}

This image is the best available START-REGION frame for that timestamp (YouTube blocks exact-second grabs; hq1/hq2/hq3 = early/mid/late samples).

ACCEPT if: no watermark/logo overlay, horizontal/clear enough, and frame is relevant to INTENDED TO SHOW (category match OK).
REJECT if watermark, wrong subject, talking-head-only when place/action intended, or unusable.

JSON:
{"matches":bool,"watermark":bool,"showsNow":"what frame shows","verdict":"short"}`,
          },
          {
            type: "image_url",
            image_url: { url: input.dataUrl, detail: "low" },
          },
        ],
      },
    ],
  });
  addUsage(scriptId, completion.usage || undefined);
  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return { matches: false, watermark: true, showsNow: "", verdict: "empty" };
  }
  const p = extractJson(raw) as Partial<MatchVision>;
  const watermark = Boolean(p.watermark);
  return {
    matches: Boolean(p.matches) && !watermark,
    watermark,
    showsNow: String(p.showsNow || ""),
    verdict: String(p.verdict || ""),
  };
}

function intendedShow(
  words: string,
  kind: ScriptCfg["kind"],
  heroes: string[],
): string {
  const w = words.toLowerCase();
  if (kind === "dual-hero") {
    const d = /dolly/.test(w);
    const m = /miley/.test(w);
    if (d && m) return "Dolly Parton and Miley Cyrus together (duet / shared stage)";
    if (d) return "Dolly Parton on camera (performance or interview)";
    if (m) return "Miley Cyrus on camera (performance or interview)";
    if (/grammy|stage|concert|perform|sing|album|music/.test(w))
      return "Live music / stage performance B-roll";
    if (/funeral|grief|tribute/.test(w))
      return "Emotional tribute / quiet memorial context (no exploitation)";
  }
  if (heroes.includes("Cliff Richard") || /cliff/.test(w)) {
    if (/concert|stage|perform|sing|tour|albert hall/.test(w))
      return "Cliff Richard performing live on stage";
    if (/interview|court|bbc|television|raid|search|police/.test(w))
      return "Cliff Richard interview / news / public appearance";
    return "Cliff Richard clearly visible (interview or performance)";
  }
  if (/elvis|graceland/.test(w)) {
    if (/jungle room|den|recording/.test(w)) return "Graceland Jungle Room / den interior";
    if (/ upstairs|bedroom|bathroom|private/.test(w))
      return "Graceland private upstairs / archival objects context";
    if (/tour|graceland|mansion|gates/.test(w)) return "Graceland mansion tour / exterior or public rooms";
    if (/elvis|presley/.test(w)) return "Elvis Presley on camera (performance or interview)";
    return "Graceland / Elvis documentary B-roll";
  }
  if (/osteen|lakewood|river oaks|mansion/.test(w)) {
    if (/lakewood|church|sermon|stage/.test(w))
      return "Lakewood Church / Joel Osteen preaching on stage";
    if (/mansion|river oaks|elevator|estate|house/.test(w))
      return "Luxury Houston estate / mansion exterior establishing";
    if (/joel|osteen/.test(w)) return "Joel Osteen speaking / interview";
    return "Joel Osteen / Lakewood documentary B-roll";
  }
  if (/neverland|jackson|briefcase|cabinet|bedroom|trial|jury/.test(w)) {
    if (/neverland|ferris|train|zoo|ranch|rides|gates/.test(w))
      return "Neverland Ranch grounds / rides / gates establishing";
    if (/court|jury|trial|prosecutor|verdict/.test(w))
      return "Courtroom / 2005 trial news B-roll";
    if (/bedroom|cabinet|briefcase|magazine|search|police|deput/.test(w))
      return "Investigation / search / private-suite news B-roll (tasteful)";
    if (/michael|jackson/.test(w)) return "Michael Jackson interview or public appearance";
    return "Neverland / Jackson documentary B-roll";
  }
  return `${heroes[0] || "Subject"} documentary B-roll matching the line`;
}

function pickHeroForLine(words: string, heroes: string[]): string {
  const w = words.toLowerCase();
  // Prefer explicit name matches; never combine two heroes in one search.
  const scored = heroes.map((h) => {
    const tokens = h.toLowerCase().split(/\s+/);
    let s = 0;
    for (const t of tokens) if (t.length > 2 && w.includes(t)) s += 1;
    return { h, s };
  });
  scored.sort((a, b) => b.s - a.s);
  if (scored[0].s > 0) return scored[0].h;
  // place defaults
  if (heroes.includes("Neverland") && /ranch|gates|ferris|train|zoo|ride/.test(w))
    return "Neverland";
  if (heroes.includes("Graceland") && /graceland|mansion|jungle|tour|archive/.test(w))
    return "Graceland";
  if (heroes.includes("Lakewood") && /lakewood|church|sermon/.test(w)) return "Lakewood";
  return heroes[0];
}

async function planFifty(
  scriptId: string,
  title: string,
  lines: string[],
  kind: ScriptCfg["kind"],
  heroes: string[],
): Promise<
  Array<{ index: number; words: string; intended: string; hero: string }>
> {
  const { model, configured } = getContactBoxConfig();
  const fallback = () => {
    const step = Math.max(1, Math.floor(lines.length / VIDEO_LINES));
    const idxs: number[] = [];
    for (let i = 0; i < lines.length && idxs.length < VIDEO_LINES; i += step) {
      idxs.push(i);
    }
    for (let i = 0; idxs.length < VIDEO_LINES && i < lines.length; i++) {
      if (!idxs.includes(i)) idxs.push(i);
    }
    return idxs.slice(0, VIDEO_LINES).map((i) => ({
      index: i + 1,
      words: lines[i],
      intended: intendedShow(lines[i], kind, heroes),
      hero: pickHeroForLine(lines[i], heroes),
    }));
  };

  if (!configured) return fallback();

  try {
    const client = createContactBoxClient();
    const numbered = lines
      .map((w, i) => `${i + 1}. ${w}`)
      .join("\n")
      .slice(0, 120_000);
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      stream: false,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Select exactly ${VIDEO_LINES} line indexes for YouTube VIDEO B-roll in a documentary.
Heroes available (search SEPARATELY, never combine): ${heroes.join(" | ")}
Prefer presence, place establishing, performance, investigation/news B-roll.
Avoid pure abstract claims, lists, legal minutiae better as stills.

JSON:
{
  "picks": [
    {"index": 1, "hero": "${heroes[0]}", "intendedShow": "short visual intent"}
  ]
}
Exactly ${VIDEO_LINES} picks. Indexes unique, 1..${lines.length}.`,
        },
        {
          role: "user",
          content: `TITLE: ${title}\n\nLINES:\n${numbered}`,
        },
      ],
    });
    addUsage(scriptId, completion.usage || undefined);
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return fallback();
    const parsed = extractJson(raw) as {
      picks?: Array<{ index?: number; hero?: string; intendedShow?: string }>;
    };
    const seen = new Set<number>();
    const out: Array<{
      index: number;
      words: string;
      intended: string;
      hero: string;
    }> = [];
    for (const p of parsed.picks || []) {
      const idx = Number(p.index);
      if (!Number.isFinite(idx) || idx < 1 || idx > lines.length) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      const words = lines[idx - 1];
      let hero = String(p.hero || "").trim();
      if (!heroes.includes(hero)) hero = pickHeroForLine(words, heroes);
      out.push({
        index: idx,
        words,
        intended: p.intendedShow || intendedShow(words, kind, heroes),
        hero,
      });
      if (out.length >= VIDEO_LINES) break;
    }
    if (out.length < VIDEO_LINES) {
      for (const f of fallback()) {
        if (out.length >= VIDEO_LINES) break;
        if (seen.has(f.index)) continue;
        out.push(f);
        seen.add(f.index);
      }
    }
    return out.slice(0, VIDEO_LINES);
  } catch (e) {
    console.log(`  plan fail: ${e instanceof Error ? e.message : e}`);
    return fallback();
  }
}

type VerifiedSrc = YouTubeVideoHit & {
  hero: string;
  vision: SrcVision;
  frameUrls: string[];
};

async function collectSources(
  scriptId: string,
  cfg: ScriptCfg,
): Promise<VerifiedSrc[]> {
  const out: VerifiedSrc[] = [];
  for (const hero of cfg.heroes) {
    const queries = cfg.searchByHero[hero] || [`${hero} documentary`];
    console.log(`  · search hero separately: ${hero}`);
    const byId = new Map<string, YouTubeVideoHit>();
    for (const q of queries) {
      // NEVER combine two heroes in one query string
      if (
        cfg.heroes.some(
          (h) => h !== hero && new RegExp(h.split(/\s+/)[0], "i").test(q) && h.split(/\s+/)[0].length > 3,
        )
      ) {
        // allow intentional crossover titles only if single-hero bucket; skip dual names
      }
      for (const h of await ytSearch(q, 5)) {
        if (rejectBad(h)) continue;
        if (!byId.has(h.videoId)) byId.set(h.videoId, h);
      }
    }
    const cands = Array.from(byId.values()).slice(0, MAX_SRC_PER_HERO + 4);
    let kept = 0;
    await mapPool(cands, VISION_CONCURRENCY, async (h) => {
      if (kept >= MAX_SRC_PER_HERO) return;
      const frames: Array<{ kind: string; dataUrl: string; url: string }> = [];
      for (const kind of ["hq1", "hq2", "hq3"] as const) {
        try {
          const t = await fetchThumb(h.videoId, kind);
          frames.push({ kind, dataUrl: t.dataUrl, url: t.url });
        } catch {
          /* */
        }
      }
      if (frames.length < 2) return;
      try {
        const vision = await visionSource(
          scriptId,
          h.title,
          frames.map((f) => ({ kind: f.kind, dataUrl: f.dataUrl })),
        );
        console.log(
          `    ${hero} ${h.videoId}: usable=${vision.usable} wm=${vision.watermark} · ${vision.verdict}`,
        );
        if (vision.usable && !vision.watermark && kept < MAX_SRC_PER_HERO) {
          kept++;
          out.push({
            ...h,
            hero,
            vision,
            frameUrls: frames.map((f) => f.url),
          });
        }
      } catch (e) {
        console.log(
          `    vision fail ${h.videoId}: ${e instanceof Error ? e.message : e}`,
        );
      }
    });
  }
  return out;
}

function windows(v: YouTubeVideoHit): YouTubeClipSuggestion[] {
  const dur = Math.max(120, Math.min(v.durationSec || 500, 2000));
  const seeds = [
    Math.floor(dur * 0.15),
    Math.floor(dur * 0.25),
    Math.floor(dur * 0.35),
    Math.floor(dur * 0.45),
    Math.floor(dur * 0.55),
    Math.floor(dur * 0.65),
    Math.floor(dur * 0.75),
    30,
    80,
    130,
    180,
    240,
    320,
    400,
  ];
  const out: YouTubeClipSuggestion[] = [];
  const seen = new Set<number>();
  for (const raw of seeds) {
    if (raw >= dur - CLIP_SEC - 8) continue;
    const start = Math.max(
      12,
      Math.min(Math.floor(raw), Math.floor(dur - CLIP_SEC - 8)),
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

async function processScript(cfg: ScriptCfg) {
  const t0 = Date.now();
  console.log(`\n======== ${cfg.id} ========`);
  const data = JSON.parse(readFileSync(cfg.file, "utf8")) as {
    title: string;
    lines: string[];
  };
  const lines = data.lines;
  console.log(`lines=${lines.length} title=${data.title}`);

  const planned = await planFifty(
    cfg.id,
    data.title,
    lines,
    cfg.kind,
    cfg.heroes,
  );
  console.log(`planned video lines=${planned.length}`);

  const sources = await collectSources(cfg.id, cfg);
  console.log(`clean sources=${sources.length}`);
  for (const s of sources) {
    console.log(`  ✓ [${s.hero}] ${s.videoId} ${s.title.slice(0, 55)}`);
  }

  const pools = new Map(sources.map((v) => [v.videoId, windows(v)]));
  const used = new Set<string>();
  const usedVids = new Set<string>();

  type Tent = {
    index: number;
    words: string;
    intended: string;
    hero: string;
    pick: YouTubeClipSuggestion;
    src: VerifiedSrc;
  };
  const tents: Tent[] = [];
  const missed: Array<{
    index: number;
    words: string;
    intended: string;
    reason: string;
  }> = [];

  for (const p of planned) {
    const poolSrc = sources
      .filter((s) => s.hero === p.hero)
      .concat(sources.filter((s) => s.hero !== p.hero));
    const ranked = poolSrc.sort(
      (a, b) =>
        (a.hero === p.hero ? 0 : 1) - (b.hero === p.hero ? 0 : 1) ||
        (usedVids.has(a.videoId) ? 1 : 0) - (usedVids.has(b.videoId) ? 1 : 0),
    );
    let chosen: Tent | null = null;
    for (const v of ranked) {
      const pool = (pools.get(v.videoId) || []).filter((c) => !used.has(clipKey(c)));
      if (!pool.length) continue;
      const pick = pool[0];
      chosen = { ...p, pick, src: v };
      used.add(clipKey(pick));
      usedVids.add(pick.videoId);
      pools.set(
        v.videoId,
        pool.filter((c) => Math.abs(c.startSec - pick.startSec) >= MIN_GAP),
      );
      break;
    }
    if (!chosen) {
      missed.push({
        index: p.index,
        words: p.words,
        intended: p.intended,
        reason: "no clean source slot",
      });
    } else {
      tents.push(chosen);
    }
  }

  console.log(`· start-frame vision on ${tents.length} clips…`);
  const videoPicks: Array<{
    line: number;
    mode: "video";
    words: string;
    intendedShow: string;
    hero: string;
    startSec: number;
    endSec: number;
    clipSec: number;
    watchAtUrl: string;
    videoTitle: string;
    videoId: string;
    frameChecked: string;
    frameKind: string;
    showsNow: string;
    visionVerdict: string;
    note: string;
  }> = [];

  await mapPool(tents, VISION_CONCURRENCY, async (t) => {
    const kind = startRegionKind(t.pick.startSec, t.src.durationSec || 500);
    try {
      const thumb = await fetchThumb(t.src.videoId, kind);
      const m = await visionStartFrame(cfg.id, {
        words: t.words,
        intended: t.intended,
        title: t.src.title,
        startSec: t.pick.startSec,
        dataUrl: thumb.dataUrl,
      });
      console.log(
        `  L${t.index} ${t.pick.videoId}@${t.pick.startSec}/${kind}: match=${m.matches} wm=${m.watermark} · ${m.verdict}`,
      );
      if (!m.matches || m.watermark) {
        missed.push({
          index: t.index,
          words: t.words,
          intended: t.intended,
          reason: `vision reject: ${m.verdict}`,
        });
        return;
      }
      videoPicks.push({
        line: t.index,
        mode: "video",
        words: t.words,
        intendedShow: t.intended,
        hero: t.hero,
        startSec: t.pick.startSec,
        endSec: t.pick.endSec,
        clipSec: CLIP_SEC,
        watchAtUrl: t.pick.watchAtUrl!,
        videoTitle: t.pick.title,
        videoId: t.pick.videoId,
        frameChecked: thumb.url,
        frameKind: kind,
        showsNow: m.showsNow,
        visionVerdict: m.verdict,
        note: `${CLIP_SEC}s · start-region frame ${kind} · no-watermark · intent-matched`,
      });
    } catch (e) {
      missed.push({
        index: t.index,
        words: t.words,
        intended: t.intended,
        reason: `match fail: ${e instanceof Error ? e.message : e}`,
      });
    }
  });

  videoPicks.sort((a, b) => a.line - b.line);
  const u = usageByScript[cfg.id] || { input: 0, output: 0, calls: 0 };
  const out = {
    id: cfg.id,
    title: data.title,
    videoTarget: VIDEO_LINES,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    visionNote:
      "ContactBox vision on YouTube start-region frames (hq1/hq2/hq3 mapped by clip start). Exact first-second pixels blocked by YouTube bot checks.",
    contactBoxUsage: {
      calls: u.calls,
      inputTokens: u.input,
      outputTokens: u.output,
      listPriceUsd: Number(costUsd(u, false).toFixed(4)),
      discounted90Usd: Number(costUsd(u, true).toFixed(4)),
    },
    counts: {
      planned: planned.length,
      videoVisionOk: videoPicks.length,
      missed: missed.length,
      sources: sources.length,
    },
    sources: sources.map((s) => ({
      id: s.videoId,
      hero: s.hero,
      title: s.title,
      url: s.watchUrl,
      shows: s.vision.shows,
      vision: s.vision.verdict,
      frames: s.frameUrls,
    })),
    picks: videoPicks,
    missed,
  };

  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  writeFileSync(
    `/opt/cursor/artifacts/${cfg.id}-50-vision.json`,
    JSON.stringify(out, null, 2),
  );

  const txt: string[] = [
    `${data.title.toUpperCase()} · ${videoPicks.length}/${VIDEO_LINES} vision-ok clips · ${out.elapsedSec}s`,
    `ContactBox: ${u.calls} calls · in=${u.input} out=${u.output} · list $${out.contactBoxUsage.listPriceUsd} · 90%off $${out.contactBoxUsage.discounted90Usd}`,
    "",
    "SOURCES",
    "=======",
  ];
  for (const s of out.sources) {
    txt.push(`[${s.hero}] ${s.id} | ${s.vision}`);
    txt.push(`  ${s.title}`);
    txt.push(`  ${s.url}`);
    txt.push(`  shows: ${s.shows}`);
    txt.push("");
  }
  txt.push("VIDEO (intended show + start-frame vision)");
  txt.push("==========================================");
  for (const p of videoPicks) {
    txt.push(
      `L${p.line} | ${p.startSec}-${p.endSec}s (${p.clipSec}s) | ${p.watchAtUrl}`,
    );
    txt.push(`  LINE: ${p.words}`);
    txt.push(`  INTENDED: ${p.intendedShow}`);
    txt.push(`  SHOWS NOW: ${p.showsNow}`);
    txt.push(`  HERO: ${p.hero} · frame: ${p.frameKind} ${p.frameChecked}`);
    txt.push(`  ${p.videoTitle}`);
    txt.push(`  vision: ${p.visionVerdict}`);
    txt.push("");
  }
  writeFileSync(
    `/opt/cursor/artifacts/${cfg.id}-50-ALL-LINKS.txt`,
    txt.join("\n"),
  );
  console.log("=== DONE ===", out.counts, out.contactBoxUsage);
  return out;
}

async function main() {
  if (!process.env.SEARCHAPI_API_KEY) {
    console.error("SEARCHAPI_API_KEY required");
    process.exit(1);
  }
  if (!getContactBoxConfig().configured) {
    console.error("CONTACTBOX_API_KEY required");
    process.exit(1);
  }
  const results = [];
  for (const cfg of SCRIPTS) {
    results.push(await processScript(cfg));
  }
  const summary = {
    scripts: results.map((r) => ({
      id: r.id,
      title: r.title,
      videoVisionOk: r.counts.videoVisionOk,
      missed: r.counts.missed,
      sources: r.counts.sources,
      elapsedSec: r.elapsedSec,
      contactBox: r.contactBoxUsage,
    })),
    totals: {
      calls: usage.calls,
      inputTokens: usage.input,
      outputTokens: usage.output,
      listPriceUsd: Number(costUsd(usage, false).toFixed(4)),
      discounted90Usd: Number(costUsd(usage, true).toFixed(4)),
    },
  };
  writeFileSync(
    "/opt/cursor/artifacts/vision-50-summary.json",
    JSON.stringify(summary, null, 2),
  );
  console.log("\n===== SUMMARY =====");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
