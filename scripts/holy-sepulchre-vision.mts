/**
 * Holy Sepulchre B-roll — clean vision pass.
 * - Max 10 YouTube sources
 * - Reject watermarks / channel bugs / stock overlays (hq1+hq2+hq3 must all pass)
 * - Clip length 4–5s (some 3s OK)
 * - Match each video line to an intended visual, then vision-check the match
 * Exact per-second grabs are bot-blocked; we sample hq1/hq2/hq3 (early/mid/late).
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

const MIN_GAP = 48;
const MAX_SRC = 10;
const VISION_CONCURRENCY = 3;
const MATCH_CONCURRENCY = 3;

type Tag =
  | "church_exterior"
  | "church_interior"
  | "excavation_dig"
  | "archaeologists"
  | "tomb_rock"
  | "pilgrims"
  | "old_city"
  | "quarry_bedrock"
  | "stone_walls"
  | "roman_layer"
  | "garden_soil"
  | "cemetery"
  | "restoration_floor"
  | "rotunda";

type FrameVision = {
  usable: boolean;
  horizontal: boolean;
  clear: boolean;
  watermark: boolean;
  subjectOk: boolean;
  tags: Tag[];
  shows: string;
  verdict: string;
};

type MatchVision = {
  matches: boolean;
  watermark: boolean;
  showsNow: string;
  verdict: string;
};

type Intent = {
  tags: Tag[];
  show: string;
  clipSec: 3 | 4 | 5;
};

const ALL_TAGS: Tag[] = [
  "church_exterior",
  "church_interior",
  "excavation_dig",
  "archaeologists",
  "tomb_rock",
  "pilgrims",
  "old_city",
  "quarry_bedrock",
  "stone_walls",
  "roman_layer",
  "garden_soil",
  "cemetery",
  "restoration_floor",
  "rotunda",
];

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

function rejectBad(h: YouTubeVideoHit) {
  const t = h.title.toLowerCase();
  if (/#shorts|\bshorts\b|tiktok|vertical|reaction|asmr|ai generated|stock footage/.test(t))
    return true;
  if (h.durationSec && h.durationSec > 0 && h.durationSec < 90) return true;
  return false;
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

function normalizeTags(raw: unknown): Tag[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set(ALL_TAGS);
  return raw
    .map((t) => String(t))
    .filter((t): t is Tag => set.has(t as Tag));
}

async function visionSourceFrames(input: {
  title: string;
  frames: Array<{ kind: string; dataUrl: string }>;
}): Promise<FrameVision> {
  const { model } = getContactBoxConfig();
  const client = createContactBoxClient();
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail: "low" } }
  > = [
    {
      type: "text",
      text: `VIDEO TITLE: ${input.title}

You are given ${input.frames.length} frames sampled from early/mid/late in this YouTube video.
STRICT documentary B-roll QA for archaeology under the Church of the Holy Sepulchre, Jerusalem.

REJECT (usable=false) if ANY frame has:
- watermark, stock bug, channel logo corner, subscribe/like overlay, large text lower-third, timecode burn-in, Getty/Shutterstock style mark
- vertical / shorts framing
- mushy/black/logo-only / unrelated gaming/meme content

ACCEPT only if ALL frames are clean horizontal documentary footage of church / dig / Jerusalem archaeology / pilgrims / Old City / tomb rock / quarry stone.

tags (pick all that apply): ${ALL_TAGS.join(", ")}

JSON:
{
  "usable": true/false,
  "horizontal": true/false,
  "clear": true/false,
  "watermark": true/false,
  "subjectOk": true/false,
  "tags": ["church_interior"],
  "shows": "what the clean frames actually show",
  "verdict": "short"
}`,
    },
  ];
  for (const f of input.frames) {
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
        content:
          "You QA documentary B-roll frames. Reject any watermark/logo overlay. Reply JSON only.",
      },
      { role: "user", content },
    ],
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return {
      usable: false,
      horizontal: false,
      clear: false,
      watermark: true,
      subjectOk: false,
      tags: [],
      shows: "",
      verdict: "empty",
    };
  }
  const p = extractJson(raw) as Partial<FrameVision>;
  const watermark = Boolean(p.watermark);
  const horizontal = Boolean(p.horizontal);
  const clear = Boolean(p.clear);
  const subjectOk = Boolean(p.subjectOk);
  const usable =
    Boolean(p.usable) &&
    !watermark &&
    horizontal &&
    clear &&
    subjectOk;
  return {
    usable,
    horizontal,
    clear,
    watermark,
    subjectOk,
    tags: normalizeTags(p.tags),
    shows: String(p.shows || ""),
    verdict: String(p.verdict || ""),
  };
}

async function visionMatchLine(input: {
  words: string;
  intended: string;
  title: string;
  dataUrl: string;
}): Promise<MatchVision> {
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
          "Match documentary B-roll to a script line. Reject watermarks. JSON only.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `SCRIPT LINE: ${input.words}
INTENDED TO SHOW: ${input.intended}
VIDEO TITLE: ${input.title}

Does this frame match the intended visual well enough for that line?
Reject if watermark/logo overlay, wrong subject, or unusable.

JSON:
{
  "matches": true/false,
  "watermark": true/false,
  "showsNow": "what frame shows",
  "verdict": "short"
}`,
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
      matches: false,
      watermark: true,
      showsNow: "",
      verdict: "empty",
    };
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

/** Map script line → intended visual + preferred clip length */
export function lineIntent(words: string, line: number): Intent {
  const w = words.toLowerCase();
  const shortBeat = words.trim().split(/\s+/).length <= 6;

  if (/pilgrim|worshipper|services continued|still entered|daily service/.test(w))
    return {
      tags: ["pilgrims", "church_interior"],
      show: "Pilgrims / worshippers inside Holy Sepulchre",
      clipSec: shortBeat ? 3 : 4,
    };
  if (/old city/.test(w))
    return {
      tags: ["old_city", "church_exterior"],
      show: "Jerusalem Old City streets / approaches to the church",
      clipSec: 4,
    };
  if (/rotunda|edicule|tomb of jesus|traditional tomb|chamber later became/.test(w))
    return {
      tags: ["rotunda", "tomb_rock", "church_interior"],
      show: "Rotunda / Edicule / rock-cut tomb chamber interior",
      clipSec: 5,
    };
  if (/quarry|bedrock|limestone|carved bedrock|cut into rock|stone cut/.test(w))
    return {
      tags: ["quarry_bedrock", "excavation_dig"],
      show: "Limestone quarry / bedrock cuts under or near the church",
      clipSec: 5,
    };
  if (/garden|cultivat|planted soil|soil packed|plots|farmland|earth into/.test(w))
    return {
      tags: ["garden_soil", "quarry_bedrock"],
      show: "Cultivated soil / garden layers in abandoned quarry",
      clipSec: 4,
    };
  if (/cemeter|burial|funerary|graves|tomb entrances|chambers cut/.test(w))
    return {
      tags: ["cemetery", "tomb_rock"],
      show: "Rock-cut burial chambers / cemetery landscape",
      clipSec: 5,
    };
  if (/roman road|roman city|roman wall|roman building|tenth legion/.test(w))
    return {
      tags: ["roman_layer", "stone_walls"],
      show: "Roman-period layers / masonry / road under the site",
      clipSec: 4,
    };
  if (/floor|paving|repair|restoration|lifted floor|removed paving/.test(w))
    return {
      tags: ["restoration_floor", "excavation_dig", "church_interior"],
      show: "Floor opened / paving removed / restoration dig inside church",
      clipSec: 5,
    };
  if (/archaeolog|excavation|workers|dig|uncovered|samples/.test(w))
    return {
      tags: ["excavation_dig", "archaeologists"],
      show: "Archaeologists / excavation work at Holy Sepulchre",
      clipSec: shortBeat ? 3 : 5,
    };
  if (/foundation|wall|walls|block from|crossing walls|deeper/.test(w))
    return {
      tags: ["stone_walls", "excavation_dig"],
      show: "Exposed stone foundations / stacked walls under the floor",
      clipSec: 4,
    };
  if (/tomb|rock-cut|rock cut/.test(w))
    return {
      tags: ["tomb_rock", "church_interior"],
      show: "Rock-cut tomb / burial rock inside or under the church",
      clipSec: 5,
    };
  if (/exterior|outside jerusalem|crowded streets surrounding/.test(w))
    return {
      tags: ["church_exterior", "old_city"],
      show: "Church exterior / surrounding Old City fabric",
      clipSec: 4,
    };
  if (/church|holy sepulchre|sacred building|christian center|christian building/.test(w))
    return {
      tags: ["church_interior", "church_exterior"],
      show: "Holy Sepulchre church interior or establishing exterior",
      clipSec: line <= 10 ? 5 : 4,
    };
  if (/jerusalem|beneath|buried|layer|history stacked/.test(w))
    return {
      tags: ["church_interior", "excavation_dig"],
      show: "Church + buried layers / archaeology context establishing shot",
      clipSec: 4,
    };
  return {
    tags: ["church_interior", "excavation_dig"],
    show: "Holy Sepulchre / Jerusalem archaeology B-roll matching the line",
    clipSec: shortBeat ? 3 : 4,
  };
}

type Verified = YouTubeVideoHit & {
  vision: FrameVision;
  frameUrls: string[];
  bestFrameUrl: string;
  bestKind: string;
};

async function collectCandidates(): Promise<YouTubeVideoHit[]> {
  const queries = [
    "Church of the Holy Sepulchre Jerusalem interior tour documentary",
    "Holy Sepulchre excavation archaeology dig floor",
    "Holy Sepulcher archaeological excavations Jerusalem",
    "Church of Holy Sepulchre restoration floor paving",
    "Jerusalem Old City Holy Sepulchre pilgrims documentary",
    "Secrets of Christ's Tomb National Geographic",
    "Holy Sepulchre rotunda empty tomb interior",
    "Jerusalem limestone quarry Holy Sepulchre archaeology",
    "Holy Sepulchre rock cut tomb chamber",
    "Church of the Holy Sepulchre exterior Jerusalem",
  ];
  const byId = new Map<string, YouTubeVideoHit>();
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
  // Prefer prior vision-clean sources if present
  try {
    const prevArt = JSON.parse(
      readFileSync("/opt/cursor/artifacts/holy-sepulchre-clips.json", "utf8"),
    ) as { sources?: Array<{ id: string; title: string; url: string }> };
    for (const s of prevArt.sources || []) {
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
    if (byId.size >= 28) break;
    for (const h of await ytSearch(q, 5)) {
      if (rejectBad(h)) continue;
      if (!byId.has(h.videoId)) byId.set(h.videoId, h);
    }
  }
  return Array.from(byId.values()).slice(0, 28);
}

async function verifySources(cands: YouTubeVideoHit[]): Promise<Verified[]> {
  const out: Verified[] = [];
  await mapPool(cands, VISION_CONCURRENCY, async (h) => {
    if (out.length >= MAX_SRC) return;
    const frames: Array<{ kind: string; dataUrl: string; url: string }> = [];
    for (const kind of ["hq1", "hq2", "hq3"] as const) {
      try {
        const thumb = await fetchThumb(h.videoId, kind);
        frames.push({ kind, dataUrl: thumb.dataUrl, url: thumb.url });
      } catch (e) {
        console.log(
          `  fail ${h.videoId}@${kind}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    if (frames.length < 2) return;
    try {
      const vision = await visionSourceFrames({
        title: h.title,
        frames: frames.map((f) => ({ kind: f.kind, dataUrl: f.dataUrl })),
      });
      console.log(
        `  ${h.videoId}: usable=${vision.usable} wm=${vision.watermark} tags=${vision.tags.join("+") || "-"} · ${vision.verdict}`,
      );
      if (vision.usable && !vision.watermark && out.length < MAX_SRC) {
        out.push({
          ...h,
          vision,
          frameUrls: frames.map((f) => f.url),
          bestFrameUrl: frames.find((f) => f.kind === "hq2")?.url || frames[0].url,
          bestKind: frames.find((f) => f.kind === "hq2")?.kind || frames[0].kind,
        });
      }
    } catch (e) {
      console.log(
        `  vision fail ${h.videoId}: ${e instanceof Error ? e.message : e}`,
      );
    }
  });
  return out.slice(0, MAX_SRC);
}

function windows(v: YouTubeVideoHit, clipSec: number): YouTubeClipSuggestion[] {
  const dur = Math.max(120, Math.min(v.durationSec || 500, 1800));
  const seeds = [
    Math.floor(dur * 0.18),
    Math.floor(dur * 0.28),
    Math.floor(dur * 0.38),
    Math.floor(dur * 0.48),
    Math.floor(dur * 0.58),
    Math.floor(dur * 0.68),
    Math.floor(dur * 0.78),
    35,
    80,
    125,
    175,
    230,
    290,
    350,
    420,
  ];
  const out: YouTubeClipSuggestion[] = [];
  const seen = new Set<number>();
  for (const raw of seeds) {
    const start = Math.max(
      12,
      Math.min(Math.floor(raw), Math.floor(dur - clipSec - 8)),
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
      endSec: start + clipSec,
      durationSec: clipSec,
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

function tagScore(need: Tag[], have: Tag[]) {
  if (!need.length) return 0;
  let n = 0;
  for (const t of need) if (have.includes(t)) n++;
  return n / need.length;
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

  console.log("· Vision sources (no watermark, hq1+hq2+hq3, max 10)…");
  const sources = await verifySources(cands);
  console.log(
    `[${((Date.now() - t0) / 1000).toFixed(0)}s] verified=${sources.length}`,
  );
  for (const s of sources) {
    console.log(
      `  ✓ ${s.videoId} [${s.vision.tags.join(",")}] ${s.title.slice(0, 55)}`,
    );
    console.log(`    shows: ${s.vision.shows}`);
  }

  // Build pools per clip length
  const pools = new Map<string, YouTubeClipSuggestion[]>();
  for (const v of sources) {
    // Prefer 5s windows as base; length adjusted per line when picking
    pools.set(v.videoId, windows(v, 5));
  }
  const used = new Set<string>();
  const usedVids = new Set<string>();

  type Tentative = {
    line: number;
    words: string;
    intent: Intent;
    pick: YouTubeClipSuggestion;
    src: Verified;
  };

  const tentatives: Tentative[] = [];
  const imageFallback: Array<{
    line: number;
    words: string;
    intent: Intent;
    googleQuery: string;
    reason: string;
  }> = [];

  for (const p of prev.plan) {
    const intent = lineIntent(p.words, p.line);
    if (p.mode !== "video") {
      imageFallback.push({
        line: p.line,
        words: p.words,
        intent,
        googleQuery: p.googleQuery || p.words.slice(0, 90),
        reason: p.reason || "planned image",
      });
      continue;
    }
    const ranked = [...sources].sort((a, b) => {
      const sa = tagScore(intent.tags, a.vision.tags);
      const sb = tagScore(intent.tags, b.vision.tags);
      if (sb !== sa) return sb - sa;
      return (
        (usedVids.has(a.videoId) ? 1 : 0) - (usedVids.has(b.videoId) ? 1 : 0)
      );
    });
    let chosen: Tentative | null = null;
    for (const v of ranked) {
      const pool = (pools.get(v.videoId) || []).filter((c) => !used.has(clipKey(c)));
      if (!pool.length) continue;
      const base = pool[0];
      const clipSec = intent.clipSec;
      const start = base.startSec;
      const pick: YouTubeClipSuggestion = {
        ...base,
        startSec: start,
        endSec: start + clipSec,
        durationSec: clipSec,
        watchAtUrl: `${v.watchUrl}&t=${start}s`,
      };
      chosen = { line: p.line, words: p.words, intent, pick, src: v };
      used.add(clipKey(pick));
      usedVids.add(pick.videoId);
      pools.set(
        v.videoId,
        pool.filter((c) => Math.abs(c.startSec - start) >= MIN_GAP),
      );
      break;
    }
    if (!chosen) {
      imageFallback.push({
        line: p.line,
        words: p.words,
        intent,
        googleQuery: p.googleQuery || intent.show,
        reason: "no clean clip slot → image",
      });
    } else {
      tentatives.push(chosen);
    }
  }

  console.log(
    `· Match vision on ${tentatives.length} tentative clips (intended subject)…`,
  );
  type VideoPick = {
    line: number;
    mode: "video";
    words: string;
    intendedShow: string;
    tags: Tag[];
    startSec: number;
    endSec: number;
    clipSec: number;
    watchAtUrl: string;
    videoTitle: string;
    videoId: string;
    visionVerdict: string;
    showsNow: string;
    frameChecked: string;
    note: string;
  };
  const videoPicks: VideoPick[] = [];
  const matchRejects: typeof imageFallback = [];

  await mapPool(tentatives, MATCH_CONCURRENCY, async (t) => {
    try {
      const thumb = await fetchThumb(
        t.src.videoId,
        (t.src.bestKind as "hq1" | "hq2" | "hq3") || "hq2",
      );
      const m = await visionMatchLine({
        words: t.words,
        intended: t.intent.show,
        title: t.src.title,
        dataUrl: thumb.dataUrl,
      });
      console.log(
        `  L${t.line} ${t.pick.videoId}@${t.pick.startSec}: match=${m.matches} wm=${m.watermark} · ${m.verdict}`,
      );
      if (!m.matches || m.watermark) {
        matchRejects.push({
          line: t.line,
          words: t.words,
          intent: t.intent,
          googleQuery: t.intent.show,
          reason: `vision mismatch/watermark → image (${m.verdict})`,
        });
        return;
      }
      videoPicks.push({
        line: t.line,
        mode: "video",
        words: t.words,
        intendedShow: t.intent.show,
        tags: t.intent.tags,
        startSec: t.pick.startSec,
        endSec: t.pick.endSec,
        clipSec: t.intent.clipSec,
        watchAtUrl: t.pick.watchAtUrl!,
        videoTitle: t.pick.title,
        videoId: t.pick.videoId,
        visionVerdict: m.verdict,
        showsNow: m.showsNow,
        frameChecked: thumb.url,
        note: `${t.intent.clipSec}s · no-watermark · intent-matched (${t.src.bestKind})`,
      });
    } catch (e) {
      matchRejects.push({
        line: t.line,
        words: t.words,
        intent: t.intent,
        googleQuery: t.intent.show,
        reason: `match fail → image (${e instanceof Error ? e.message : e})`,
      });
    }
  });

  videoPicks.sort((a, b) => a.line - b.line);
  const allImages = [...imageFallback, ...matchRejects].sort(
    (a, b) => a.line - b.line,
  );

  // Rebuild full picks in script order
  const byLine = new Map<number, VideoPick | {
    line: number;
    mode: "images";
    words: string;
    intendedShow: string;
    googleQuery: string;
    reason: string;
  }>();
  for (const v of videoPicks) byLine.set(v.line, v);
  for (const im of allImages) {
    if (byLine.has(im.line)) continue;
    byLine.set(im.line, {
      line: im.line,
      mode: "images",
      words: im.words,
      intendedShow: im.intent.show,
      googleQuery: im.googleQuery,
      reason: im.reason,
    });
  }
  // Ensure every plan line is present
  const picks = prev.plan.map((p) => {
    const existing = byLine.get(p.line);
    if (existing) return existing;
    const intent = lineIntent(p.words, p.line);
    return {
      line: p.line,
      mode: "images" as const,
      words: p.words,
      intendedShow: intent.show,
      googleQuery: p.googleQuery || intent.show,
      reason: "missing → image",
    };
  });

  const out = {
    title:
      "Holy Sepulchre — clean vision 3–5s clips (no watermark, max 10 sources)",
    clipSecNote: "Prefer 4–5s; short beats may be 3s",
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    visionNote:
      "ContactBox vision on hq1+hq2+hq3 (early/mid/late). Reject any watermark/logo overlay. Each video line intent-matched. Exact-second screenshots blocked by YouTube; frames are real mid-video samples.",
    counts: {
      total: picks.length,
      video: picks.filter((p) => p.mode === "video").length,
      images: picks.filter((p) => p.mode === "images").length,
    },
    sources: sources.map((s) => ({
      id: s.videoId,
      title: s.title,
      url: s.watchUrl,
      tags: s.vision.tags,
      shows: s.vision.shows,
      vision: s.vision.verdict,
      watermark: s.vision.watermark,
      frames: s.frameUrls,
    })),
    picks,
  };

  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  writeFileSync(
    "/opt/cursor/artifacts/holy-sepulchre-clips.json",
    JSON.stringify(out, null, 2),
  );

  const txt: string[] = [
    `HOLY SEPULCHRE · CLEAN VISION · ${out.counts.video} video · ${out.counts.images} images · ${out.elapsedSec}s · sources ${sources.length}/10 · no watermark`,
    "",
    "SOURCES (vision-clean, no watermark)",
    "====================================",
  ];
  for (const s of out.sources) {
    txt.push(`${s.id} | tags=${s.tags.join(",")}`);
    txt.push(`  ${s.title}`);
    txt.push(`  ${s.url}`);
    txt.push(`  shows: ${s.shows}`);
    txt.push(`  frames: ${s.frames.join(" | ")}`);
    txt.push("");
  }
  txt.push("VIDEO (with intended show)");
  txt.push("==========================");
  for (const p of picks) {
    if (p.mode !== "video") continue;
    txt.push(
      `L${p.line} | ${p.startSec}-${p.endSec}s (${p.clipSec}s) | ${p.watchAtUrl}`,
    );
    txt.push(`  LINE: ${p.words}`);
    txt.push(`  INTENDED: ${p.intendedShow}`);
    txt.push(`  SHOWS NOW: ${p.showsNow}`);
    txt.push(`  ${p.videoTitle}`);
    txt.push(`  vision: ${p.visionVerdict}`);
    txt.push("");
  }
  txt.push("IMAGES (with intended show)");
  txt.push("===========================");
  for (const p of picks) {
    if (p.mode !== "images") continue;
    txt.push(`L${p.line} | IMAGE | ${p.googleQuery}`);
    txt.push(`  LINE: ${p.words}`);
    txt.push(`  INTENDED: ${p.intendedShow}`);
    txt.push("");
  }
  writeFileSync(
    "/opt/cursor/artifacts/holy-sepulchre-ALL-LINKS.txt",
    txt.join("\n"),
  );

  // Compact intent sheet for chat
  const intentSheet: string[] = [
    "LINE → INTENDED TO SHOW (video lines only)",
    "==========================================",
  ];
  for (const p of picks) {
    if (p.mode !== "video") continue;
    intentSheet.push(
      `L${p.line} [${p.clipSec}s] ${p.watchAtUrl}`,
    );
    intentSheet.push(`  intended: ${p.intendedShow}`);
    intentSheet.push(`  line: ${p.words}`);
    intentSheet.push("");
  }
  writeFileSync(
    "/opt/cursor/artifacts/holy-sepulchre-INTENTS.txt",
    intentSheet.join("\n"),
  );

  console.log("\n=== DONE ===", out.counts, `${out.elapsedSec}s`);
  console.log("\nVIDEO:");
  for (const p of picks) {
    if (p.mode !== "video") continue;
    console.log(
      `L${p.line}\t${p.startSec}-${p.endSec}s\t${p.intendedShow}\t${p.watchAtUrl}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
