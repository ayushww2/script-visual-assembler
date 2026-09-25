/**
 * Dual-hero YouTube + Google-image plan for Cher / Tom Cruise script.
 *
 * Rules (per editor brief):
 * - Heroes: Cher, Tom Cruise (max 10 YouTube sources EACH; reuse for unique ~4s windows)
 * - ~30–40% of lines → hero VIDEO clips (generalized presence / emotional / relationship beats)
 * - ~60–70% → Google IMAGES (Madonna/Sean Penn wedding, White House, DC, movies,
 *   other people, places, specific named B-roll)
 *
 * Usage: set -a; source .env; set +a; npx tsx scripts/cher-tom-hero-clips.mts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createContactBoxClient, getContactBoxConfig } from "../src/lib/contactbox";
import {
  fetchYouTubeCaptions,
  searchYouTubeVideos,
  type YouTubeClipSuggestion,
  type YouTubeVideoHit,
} from "../src/lib/search/youtube";
import { getSearchApiKey } from "../src/lib/env";

const CLIP_SEC = 4;
const MIN_GAP_SAME_VIDEO_SEC = 40;
const MAX_SOURCES_PER_HERO = 10;
const TARGET_VIDEO_PCT_MIN = 0.3;
const TARGET_VIDEO_PCT_MAX = 0.4;

const TITLE =
  "At 80, Cher’s words changed this story completely — Cher & Tom Cruise";

type Mode = "cher" | "tom" | "images";

type PlanLine = {
  index: number;
  words: string;
  mode: Mode;
  reason: string;
  visualHint: string;
  googleQuery: string | null;
};

type PickRow = PlanLine & {
  clip: YouTubeClipSuggestion | null;
  aiVerdict?: string;
  note?: string;
};

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Model did not return valid JSON");
  }
}

async function searchYouTubeViaSearchApi(
  query: string,
  maxResults = 6,
): Promise<YouTubeVideoHit[]> {
  const apiKey = getSearchApiKey();
  if (!apiKey) return [];
  const params = new URLSearchParams({
    engine: "youtube",
    q: query,
    api_key: apiKey,
  });
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
      } as YouTubeVideoHit;
    })
    .filter((h): h is YouTubeVideoHit => Boolean(h))
    .slice(0, maxResults);
}

async function searchHeroPool(
  heroName: string,
  maxVideos: number,
): Promise<YouTubeVideoHit[]> {
  const queries = [
    `${heroName} interview`,
    `${heroName} red carpet`,
    `${heroName} documentary`,
    `${heroName} talk show`,
    `${heroName} premiere`,
  ];
  const byId = new Map<string, YouTubeVideoHit>();
  for (const q of queries) {
    if (byId.size >= maxVideos) break;
    let hits: YouTubeVideoHit[] = [];
    try {
      hits = await searchYouTubeVideos(q, 4);
    } catch {
      hits = await searchYouTubeViaSearchApi(q, 4);
    }
    if (!hits.length) hits = await searchYouTubeViaSearchApi(q, 4);
    for (const h of hits) {
      // Prefer titles that actually contain the hero name.
      const ok = new RegExp(heroName.replace(/\s+/g, "\\s+"), "i").test(h.title);
      if (!ok && heroName === "Tom Cruise" && !/tom\s*cruise|cruise/i.test(h.title)) {
        continue;
      }
      if (!ok && heroName === "Cher" && !/\bcher\b/i.test(h.title)) continue;
      if (!byId.has(h.videoId)) byId.set(h.videoId, h);
      if (byId.size >= maxVideos) break;
    }
  }
  return Array.from(byId.values()).slice(0, maxVideos);
}

function clipKey(c: { videoId: string; startSec: number }) {
  return `${c.videoId}@${Math.floor(c.startSec / 5) * 5}`;
}

function videoOffsetSec(videoId: string): number {
  let h = 0;
  for (let i = 0; i < videoId.length; i++) h = (h * 31 + videoId.charCodeAt(i)) >>> 0;
  return 15 + (h % 90);
}

type Timed = YouTubeClipSuggestion & { preferred?: boolean };

function windowsFromVideo(video: YouTubeVideoHit, used: Set<string>): Timed[] {
  const duration = video.durationSec || 600;
  const offset = videoOffsetSec(video.videoId);
  const step = Math.max(MIN_GAP_SAME_VIDEO_SEC, 45);
  const seeds = [
    offset,
    Math.floor(duration * 0.2),
    Math.floor(duration * 0.35),
    Math.floor(duration * 0.5),
    Math.floor(duration * 0.65),
    Math.floor(duration * 0.8),
    offset + step,
    offset + step * 2,
    offset + step * 3,
  ];
  const out: Timed[] = [];
  const seen = new Set<number>();
  for (const raw of seeds) {
    const start = Math.max(
      8,
      Math.min(Math.floor(raw), Math.floor(duration - CLIP_SEC - 8)),
    );
    if (seen.has(start)) continue;
    seen.add(start);
    const key = clipKey({ videoId: video.videoId, startSec: start });
    if (used.has(key)) continue;
    out.push({
      videoId: video.videoId,
      title: video.title,
      channelTitle: video.channelTitle,
      thumbnailUrl: video.thumbnailUrl,
      watchUrl: video.watchUrl,
      watchAtUrl: `${video.watchUrl}&t=${start}s`,
      startSec: start,
      endSec: start + CLIP_SEC,
      durationSec: CLIP_SEC,
      matchedText: "",
      score: 0.42,
      hasCaptions: false,
    });
    if (out.length >= 8) break;
  }
  return out;
}

async function poolForVideo(
  video: YouTubeVideoHit,
  used: Set<string>,
): Promise<Timed[]> {
  const cues = await fetchYouTubeCaptions(video.videoId);
  const fromCap: Timed[] = [];
  if (cues.length) {
    let last = -MIN_GAP_SAME_VIDEO_SEC;
    for (const cue of cues) {
      if (cue.startSec - last < MIN_GAP_SAME_VIDEO_SEC) continue;
      const start = Math.max(0, Math.floor(cue.startSec));
      if (used.has(clipKey({ videoId: video.videoId, startSec: start }))) continue;
      fromCap.push({
        videoId: video.videoId,
        title: video.title,
        channelTitle: video.channelTitle,
        thumbnailUrl: video.thumbnailUrl,
        watchUrl: video.watchUrl,
        watchAtUrl: `${video.watchUrl}&t=${start}s`,
        startSec: start,
        endSec: start + CLIP_SEC,
        durationSec: CLIP_SEC,
        matchedText: cue.text.slice(0, 160),
        score: 0.5,
        hasCaptions: true,
      });
      last = cue.startSec;
      if (fromCap.length >= 6) break;
    }
  }
  return [...fromCap, ...windowsFromVideo(video, used)];
}

async function planDualHero(lines: string[]): Promise<PlanLine[]> {
  const { model, configured } = getContactBoxConfig();
  if (!configured) throw new Error("CONTACTBOX_API_KEY required");

  const client = createContactBoxClient();
  const n = lines.length;
  const targetMin = Math.round(n * TARGET_VIDEO_PCT_MIN);
  const targetMax = Math.round(n * TARGET_VIDEO_PCT_MAX);

  // Chunk planning if needed — 229 lines fits one call with compact JSON.
  const numbered = lines.map((w, i) => `${i + 1}. ${w}`).join("\n");

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a documentary editor planner for a TWO-HERO YouTube film about Cher and Tom Cruise.

For EACH numbered narration line, choose exactly one mode:
- "cher"  → ~4s YouTube VIDEO of CHER (her presence, interviews, red carpet, singing, emotional beats ABOUT her even if her name is omitted — she/her referring to Cher)
- "tom"   → ~4s YouTube VIDEO of TOM CRUISE (same rule for him/he when context is Tom)
- "images" → Google IMAGES / still B-roll ONLY

VIDEO (cher/tom) — use for generalized, repeated hero presence: emotional reactions, relationship warmth, private-life context about that hero, them speaking, walking red carpets, being the face of the beat.

IMAGES — use for SPECIFIC named B-roll and non-hero subjects:
- Other people (Madonna, Sean Penn, musicians, actors as a group when not Cher/Tom on camera)
- Weddings, White House, Washington D.C., Lab School, places, documents
- Movie titles as the visual subject (Mission: Impossible posters/stills — NOT Tom himself unless the beat is about him)
- Abstract concepts, years/dates graphics, age-gap explainers without a person
- When a NEW third party is the focus of the sentence

HARD BUDGET: total (cher+tom) video lines must be between ${targetMin} and ${targetMax} (~30–40%). Prefer images for the rest (~60–70%).
Split video roughly evenly between Cher and Tom when both appear in the story; bias slightly toward whoever the line centers.

Return JSON only:
{
  "lines": [
    {
      "index": 1,
      "mode": "cher"|"tom"|"images",
      "reason": "short",
      "visualHint": "what to show",
      "googleQuery": "search query if images else null"
    }
  ]
}`,
      },
      {
        role: "user",
        content: `TITLE: ${TITLE}\n\nLINES (${n}):\n${numbered}`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Empty dual-hero plan");
  const parsed = extractJson(content) as {
    lines?: Array<{
      index?: number;
      mode?: string;
      reason?: string;
      visualHint?: string;
      googleQuery?: string | null;
    }>;
  };
  const byIndex = new Map((parsed.lines || []).map((l) => [Number(l.index), l]));

  return lines.map((words, i) => {
    const row = byIndex.get(i + 1);
    let mode = (row?.mode || "images").toLowerCase() as Mode;
    if (mode !== "cher" && mode !== "tom" && mode !== "images") mode = "images";
    return {
      index: i + 1,
      words,
      mode,
      reason: row?.reason?.trim() || "",
      visualHint:
        row?.visualHint?.trim() ||
        (mode === "images" ? "documentary still" : `${mode} presence`),
      googleQuery:
        mode === "images"
          ? (row?.googleQuery?.trim() || words.slice(0, 80))
          : null,
    };
  });
}

async function aiPick(input: {
  heroName: string;
  words: string;
  visualHint: string;
  candidates: Timed[];
}): Promise<{ pick: Timed | null; verdict: string }> {
  if (!input.candidates.length) return { pick: null, verdict: "No candidates" };
  const { model, configured } = getContactBoxConfig();
  if (!configured) {
    return { pick: input.candidates[0], verdict: "offline fallback" };
  }
  const client = createContactBoxClient();
  const listed = input.candidates.slice(0, 8).map((c, i) => ({
    i,
    videoId: c.videoId,
    title: c.title,
    startSec: c.startSec,
    endSec: c.endSec,
    preferred: Boolean(c.preferred),
    watchAtUrl: c.watchAtUrl,
  }));
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Pick ONE ~4s YouTube window that best shows HERO (${input.heroName}) on camera.
Prefer preferred:true. Reject wrong person, pure movie trailers without the hero, memes.
Return JSON: { "pickIndex": 0|null, "verdict": "short" }`,
      },
      {
        role: "user",
        content: `HERO: ${input.heroName}\nLINE: ${input.words}\nHINT: ${input.visualHint}\nCANDIDATES:\n${JSON.stringify(listed, null, 2)}`,
      },
    ],
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) return { pick: input.candidates[0], verdict: "empty" };
  const parsed = extractJson(content) as {
    pickIndex?: number | null;
    verdict?: string;
  };
  if (parsed.pickIndex == null || parsed.pickIndex < 0) {
    return { pick: null, verdict: parsed.verdict || "rejected" };
  }
  return {
    pick: input.candidates[parsed.pickIndex] || null,
    verdict: parsed.verdict || "ok",
  };
}

async function main() {
  const lines: string[] = JSON.parse(
    readFileSync("/tmp/cher_tom_beats.json", "utf8"),
  );
  console.log("Beats:", lines.length);

  console.log("· Planning dual-hero modes (Cher / Tom / images)…");
  let plan = await planDualHero(lines);

  // Enforce ~30–40% video budget if model overshoots.
  const videoIdx = plan
    .map((p, i) => ({ i, p }))
    .filter((x) => x.p.mode === "cher" || x.p.mode === "tom");
  const maxV = Math.round(plan.length * TARGET_VIDEO_PCT_MAX);
  const minV = Math.round(plan.length * TARGET_VIDEO_PCT_MIN);
  if (videoIdx.length > maxV) {
    // Convert lowest-priority extras to images (keep early hook + emotional).
    const drop = videoIdx.length - maxV;
    const convertible = [...videoIdx].reverse().slice(0, drop);
    for (const { i } of convertible) {
      plan[i] = {
        ...plan[i],
        mode: "images",
        googleQuery: plan[i].googleQuery || plan[i].visualHint,
        reason: (plan[i].reason || "") + " [budget→images]",
      };
    }
  }
  console.log(
    `· Plan: cher=${plan.filter((p) => p.mode === "cher").length} tom=${plan.filter((p) => p.mode === "tom").length} images=${plan.filter((p) => p.mode === "images").length} (target video ${minV}-${maxV})`,
  );

  console.log("· Searching ≤10 YouTube sources per hero…");
  const cherVideos = await searchHeroPool("Cher", MAX_SOURCES_PER_HERO);
  const tomVideos = await searchHeroPool("Tom Cruise", MAX_SOURCES_PER_HERO);
  console.log(`· Cher sources=${cherVideos.length} · Tom sources=${tomVideos.length}`);

  const used = new Set<string>();
  const usedVideoIds = new Set<string>();
  const poolCher = new Map<string, Timed[]>();
  const poolTom = new Map<string, Timed[]>();
  for (const v of cherVideos) poolCher.set(v.videoId, await poolForVideo(v, used));
  for (const v of tomVideos) poolTom.set(v.videoId, await poolForVideo(v, used));

  const picks: PickRow[] = [];
  for (const line of plan) {
    if (line.mode === "images") {
      picks.push({
        ...line,
        clip: null,
        note: `Google image: ${line.googleQuery}`,
      });
      continue;
    }

    const heroName = line.mode === "cher" ? "Cher" : "Tom Cruise";
    const videos = line.mode === "cher" ? cherVideos : tomVideos;
    const poolBy = line.mode === "cher" ? poolCher : poolTom;

    const usedBuckets = new Set(
      [...used].map((k) => Number(k.split("@")[1] || 0)),
    );
    const ranked = [...videos].sort((a, b) => {
      const au = usedVideoIds.has(a.videoId) ? 1 : 0;
      const bu = usedVideoIds.has(b.videoId) ? 1 : 0;
      return au - bu;
    });

    const candidates: Timed[] = [];
    for (const v of ranked) {
      const pool = (poolBy.get(v.videoId) || [])
        .filter((c) => !used.has(clipKey(c)))
        .sort((a, b) => {
          const ab = Math.floor(a.startSec / 5) * 5;
          const bb = Math.floor(b.startSec / 5) * 5;
          return (
            (usedBuckets.has(ab) ? 1 : 0) - (usedBuckets.has(bb) ? 1 : 0) ||
            a.startSec - b.startSec
          );
        });
      for (const c of pool.slice(0, 2)) {
        candidates.push({ ...c, preferred: !usedVideoIds.has(v.videoId) });
      }
      if (candidates.length >= 8) break;
    }

    if (line.index % 10 === 1 || line.index <= 3) {
      console.log(`· AI pick L${line.index}/${plan.length} (${heroName})…`);
    }
    const { pick, verdict } = await aiPick({
      heroName,
      words: line.words,
      visualHint: line.visualHint,
      candidates,
    });
    if (pick) {
      used.add(clipKey(pick));
      usedVideoIds.add(pick.videoId);
      const pool = poolBy.get(pick.videoId) || [];
      poolBy.set(
        pick.videoId,
        pool.filter(
          (c) => Math.abs(c.startSec - pick.startSec) >= MIN_GAP_SAME_VIDEO_SEC,
        ),
      );
    }
    picks.push({
      ...line,
      clip: pick,
      aiVerdict: verdict,
      note: pick
        ? undefined
        : "No unique clip — fall back to Google image of hero",
    });
  }

  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  const out = {
    title: TITLE,
    heroes: ["Cher", "Tom Cruise"],
    maxSourcesPerHero: MAX_SOURCES_PER_HERO,
    cherSources: cherVideos.map((v) => ({
      videoId: v.videoId,
      title: v.title,
      watchUrl: v.watchUrl,
    })),
    tomSources: tomVideos.map((v) => ({
      videoId: v.videoId,
      title: v.title,
      watchUrl: v.watchUrl,
    })),
    counts: {
      total: picks.length,
      cherVideo: picks.filter((p) => p.mode === "cher" && p.clip).length,
      tomVideo: picks.filter((p) => p.mode === "tom" && p.clip).length,
      images: picks.filter((p) => p.mode === "images" || !p.clip).length,
    },
    picks: picks.map((p) => {
      if (p.mode === "images" || !p.clip) {
        return {
          line: p.index,
          mode: p.clip ? p.mode : p.mode === "images" ? "images" : `${p.mode}-miss→images`,
          words: p.words,
          googleQuery: p.googleQuery || p.visualHint,
          reason: p.reason,
          note: p.note,
        };
      }
      return {
        line: p.index,
        mode: p.mode,
        words: p.words,
        startSec: p.clip.startSec,
        endSec: p.clip.endSec,
        watchAtUrl: p.clip.watchAtUrl,
        videoTitle: p.clip.title,
        videoId: p.clip.videoId,
        aiVerdict: p.aiVerdict,
        visualHint: p.visualHint,
      };
    }),
  };

  writeFileSync(
    "/opt/cursor/artifacts/cher-tom-hero-clips.json",
    JSON.stringify(out, null, 2),
  );

  // Markdown summary
  const md: string[] = [
    `# Cher & Tom Cruise — visual plan`,
    ``,
    `Video ~${Math.round(((out.counts.cherVideo + out.counts.tomVideo) / out.counts.total) * 100)}% · Images ~${Math.round((out.counts.images / out.counts.total) * 100)}%`,
    `Cher clips: ${out.counts.cherVideo} · Tom clips: ${out.counts.tomVideo} · Images: ${out.counts.images}`,
    `Sources: Cher ${cherVideos.length}/10 · Tom ${tomVideos.length}/10`,
    ``,
  ];
  for (const p of out.picks) {
    if ("watchAtUrl" in p && p.watchAtUrl) {
      md.push(
        `### L${p.line} [${String(p.mode).toUpperCase()} ${p.startSec}s–${p.endSec}s]`,
      );
      md.push(p.words);
      md.push(`[${p.videoTitle}](${p.watchAtUrl})`);
      md.push("");
    } else {
      md.push(`### L${p.line} [IMAGES]`);
      md.push(p.words);
      md.push(`Google: \`${(p as { googleQuery?: string }).googleQuery || ""}\``);
      md.push("");
    }
  }
  writeFileSync("/opt/cursor/artifacts/cher-tom-hero-clips.md", md.join("\n"));

  console.log("\n=== COUNTS ===", out.counts);
  console.log("Wrote /opt/cursor/artifacts/cher-tom-hero-clips.json");
  // Print video lines compact
  console.log("\n=== VIDEO CLIPS ===");
  for (const p of out.picks) {
    if ("watchAtUrl" in p && p.watchAtUrl) {
      console.log(
        `L${p.line} [${p.mode}] ${p.startSec}s–${p.endSec}s ${p.watchAtUrl}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
