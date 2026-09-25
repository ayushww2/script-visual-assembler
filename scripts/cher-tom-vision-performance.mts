/**
 * Cher/Tom clips: performance-first (singing/acting/stunts; some interviews OK),
 * horizontal only, ~3s windows, ContactBox vision on YouTube mid-frames (hq1/2/3)
 * to confirm the hero is actually in the video before assigning timestamps.
 *
 * Exact per-second screenshots are blocked by YouTube bot checks in this env;
 * hq1/hq2/hq3 are real frames sampled from early/mid/late in each source (landscape).
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
const MIN_GAP = 40;
const MAX_SRC = 10;
const VISION_CONCURRENCY = 4;

type VisionResult = {
  personVisible: boolean;
  person: string;
  horizontal: boolean;
  performing: boolean;
  interviewOk: boolean;
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
        durationSec: parseLen(v.length) || 500,
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

function rejectVerticalOrShort(h: YouTubeVideoHit): boolean {
  const t = h.title.toLowerCase();
  if (/#shorts|\bshorts\b|vertical|tiktok|reel\b/.test(t)) return true;
  // typical Shorts length
  if (h.durationSec && h.durationSec > 0 && h.durationSec <= 60) return true;
  return false;
}

function looksPerformance(title: string, hero: "cher" | "tom"): boolean {
  const t = title.toLowerCase();
  if (hero === "cher") {
    return /live|concert|perform|sing|farewell|vegas|believe|music video|tour|stage|oscars|met gala|half-breed|gypsies|strong enough/.test(
      t,
    );
  }
  return /top gun|mission:?\s*impossible|stunt|clip|scene|maverick|movie|premiere|acting|jump|bike|cockpit|digger/.test(
    t,
  );
}

function looksInterview(title: string): boolean {
  return /interview|letterman|oprah|ellen|stern|talks |press|podcast|q&a/.test(
    title.toLowerCase(),
  );
}

async function collectCandidates(
  hero: "cher" | "tom",
  queries: string[],
  titleRe: RegExp,
): Promise<YouTubeVideoHit[]> {
  const byId = new Map<string, YouTubeVideoHit>();
  for (const q of queries) {
    for (const h of await ytSearch(q, 6)) {
      if (!titleRe.test(h.title)) continue;
      if (rejectVerticalOrShort(h)) continue;
      if (!byId.has(h.videoId)) byId.set(h.videoId, h);
    }
  }
  // Prefer performance titles first, then interviews
  const all = Array.from(byId.values());
  const perf = all.filter((h) => looksPerformance(h.title, hero));
  const inter = all.filter(
    (h) => looksInterview(h.title) && !looksPerformance(h.title, hero),
  );
  const rest = all.filter((h) => !perf.includes(h) && !inter.includes(h));
  return [...perf, ...inter.slice(0, 3), ...rest].slice(0, 18); // vision will cut to 10
}

async function fetchThumb(videoId: string, which: "hq1" | "hq2" | "hq3" | "hqdefault") {
  const url = `https://i.ytimg.com/vi/${videoId}/${which}.jpg`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`thumb ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // crude JPEG size check — reject tiny placeholders
  if (buf.length < 2000) throw new Error("tiny thumb");
  return {
    url,
    dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
    bytes: buf.length,
  };
}

async function visionHeroFrame(input: {
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
        content: `You verify YouTube B-roll frames for a documentary.
Return JSON only:
{
  "personVisible": true/false,
  "person": "Cher" | "Tom Cruise" | "other" | "none",
  "horizontal": true/false,
  "performing": true/false,
  "interviewOk": true/false,
  "verdict": "short reason"
}
Rules:
- personVisible=true only if TARGET is clearly recognizable on camera (face/body), not a tiny background figure, not a poster/text card alone.
- horizontal=true if the frame is landscape (wider than tall). Vertical phone/shorts = false.
- performing=true if singing, dancing, acting in a scene, stunt, stage, red carpet walking — active.
- interviewOk=true if sitting/talking interview but TARGET clearly visible (allowed as secondary).
- Reject memes, compilations of wrong people, black frames, logos-only.`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `TARGET: ${input.heroName}\nVIDEO TITLE: ${input.title}\nIs the target clearly in this frame? Landscape? Performing or acceptable interview?`,
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
      person: "none",
      horizontal: false,
      performing: false,
      interviewOk: false,
      verdict: "empty vision",
    };
  }
  const p = extractJson(raw) as Partial<VisionResult>;
  return {
    personVisible: Boolean(p.personVisible),
    person: String(p.person || "none"),
    horizontal: Boolean(p.horizontal),
    performing: Boolean(p.performing),
    interviewOk: Boolean(p.interviewOk),
    verdict: String(p.verdict || ""),
  };
}

function passesVision(v: VisionResult, heroName: string): boolean {
  if (!v.personVisible || !v.horizontal) return false;
  const p = v.person.toLowerCase();
  const want = heroName.toLowerCase();
  if (!p.includes(want.split(" ")[0])) return false; // cher / tom
  return v.performing || v.interviewOk;
}

type VerifiedSource = YouTubeVideoHit & {
  vision: VisionResult;
  frameUrl: string;
  frameKind: string;
};

async function verifySources(
  heroName: string,
  cands: YouTubeVideoHit[],
): Promise<VerifiedSource[]> {
  const out: VerifiedSource[] = [];
  await mapPool(cands, VISION_CONCURRENCY, async (h) => {
    if (out.length >= MAX_SRC) return;
    // Prefer mid frame hq2; fall back hq1/hq3
    for (const kind of ["hq2", "hq1", "hq3"] as const) {
      try {
        const thumb = await fetchThumb(h.videoId, kind);
        const vision = await visionHeroFrame({
          heroName,
          title: h.title,
          dataUrl: thumb.dataUrl,
        });
        console.log(
          `  vision ${heroName} ${h.videoId}@${kind}: visible=${vision.personVisible} horiz=${vision.horizontal} perf=${vision.performing} int=${vision.interviewOk} · ${vision.verdict}`,
        );
        if (passesVision(vision, heroName)) {
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
      } catch (e) {
        console.log(
          `  vision fail ${h.videoId}@${kind}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  });
  return out.slice(0, MAX_SRC);
}

function offset(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 15 + (h % 60);
}

function windows(v: YouTubeVideoHit): YouTubeClipSuggestion[] {
  const dur = Math.max(120, v.durationSec || 400);
  const o = offset(v.videoId);
  // Stay in performance body — avoid open/credits
  const seeds = [
    Math.floor(dur * 0.18),
    Math.floor(dur * 0.3),
    Math.floor(dur * 0.42),
    Math.floor(dur * 0.55),
    Math.floor(dur * 0.68),
    Math.floor(dur * 0.8),
    o + 25,
    o + 70,
    o + 120,
  ];
  const out: YouTubeClipSuggestion[] = [];
  const seen = new Set<number>();
  for (const raw of seeds) {
    const start = Math.max(
      12,
      Math.min(Math.floor(raw), Math.floor(dur - CLIP_SEC - 12)),
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

  console.log("· Collecting performance (+ sparse interview) candidates…");
  const [cherCands, tomCands] = await Promise.all([
    collectCandidates(
      "cher",
      [
        "Cher live concert singing horizontal",
        "Cher Believe live performance",
        "Cher Farewell Tour stage",
        "Cher music video official",
        "Cher Oscars red carpet walking",
        "Cher interview 1990s",
      ],
      /\bcher\b/i,
    ),
    collectCandidates(
      "tom",
      [
        "Tom Cruise Top Gun movie clip scene",
        "Tom Cruise Mission Impossible stunt",
        "Tom Cruise Maverick flying scene",
        "Tom Cruise acting movie scene",
        "Tom Cruise premiere red carpet walking",
        "Tom Cruise interview",
      ],
      /tom\s*cruise/i,
    ),
  ]);
  console.log(`candidates cher=${cherCands.length} tom=${tomCands.length}`);

  console.log("· Vision-verifying sources (hq frames, horizontal + person)…");
  const [cherSrc, tomSrc] = await Promise.all([
    verifySources("Cher", cherCands),
    verifySources("Tom Cruise", tomCands),
  ]);
  console.log(`verified sources cher=${cherSrc.length} tom=${tomSrc.length}`);

  const pools = {
    cher: new Map(cherSrc.map((v) => [v.videoId, windows(v)])),
    tom: new Map(tomSrc.map((v) => [v.videoId, windows(v)])),
  };
  const videos = { cher: cherSrc, tom: tomSrc };
  const used = new Set<string>();
  const usedVids = new Set<string>();

  // Assign unique 3s windows only from vision-verified horizontal sources
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
      const okClip = pool[0];
      used.add(clipKey(okClip));
      usedVids.add(okClip.videoId);
      pools[mode].set(
        v.videoId,
        pool.filter((c) => Math.abs(c.startSec - okClip.startSec) >= MIN_GAP),
      );
      chosen = {
        line: p.line,
        mode,
        words: p.words,
        startSec: okClip.startSec,
        endSec: okClip.endSec,
        watchAtUrl: okClip.watchAtUrl,
        videoTitle: okClip.title,
        videoId: okClip.videoId,
        visionVerdict: v.vision.verdict,
        frameChecked: v.frameUrl,
        note: `3s · source vision-confirmed (${v.frameKind}, ${v.vision.performing ? "performing" : "interview"})`,
      };
      break;
    }

    if (!chosen) {
      picks.push({
        line: p.line,
        mode: "images",
        words: p.words,
        googleQuery: p.words.slice(0, 90),
        reason: "no vision-confirmed horizontal hero clip → image",
      });
    } else {
      picks.push(chosen);
    }
  }

  const out = {
    title: "Cher & Tom Cruise — vision-verified 3s horizontal performance clips",
    clipSec: CLIP_SEC,
    visionNote:
      "YouTube blocks exact-second downloads here. Each accepted clip was vision-checked on that video's hq1/hq2/hq3 landscape frame (early/mid/late sample). Sources prefer singing/acting/stunts; some interviews allowed if person clearly visible.",
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
      vision: v.vision.verdict,
      frame: v.frameUrl,
    })),
    tomSources: tomSrc.map((v) => ({
      id: v.videoId,
      title: v.title,
      url: v.watchUrl,
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
    "/opt/cursor/artifacts/cher-tom-VISION-sources.json",
    JSON.stringify(
      { cher: out.cherSources, tom: out.tomSources },
      null,
      2,
    ),
  );

  console.log("\n=== DONE ===", out.counts);
  console.log("\nCHER:");
  for (const p of picks) {
    if (p.mode !== "cher") continue;
    console.log(
      `L${p.line} ${p.startSec}s–${p.endSec}s ${p.watchAtUrl}\n  ${p.videoTitle}\n  vision: ${p.visionVerdict}`,
    );
  }
  console.log("\nTOM:");
  for (const p of picks) {
    if (p.mode !== "tom") continue;
    console.log(
      `L${p.line} ${p.startSec}s–${p.endSec}s ${p.watchAtUrl}\n  ${p.videoTitle}\n  vision: ${p.visionVerdict}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
