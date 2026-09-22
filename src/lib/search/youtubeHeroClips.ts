import { createContactBoxClient, getContactBoxConfig } from "@/lib/contactbox";
import { getSearchApiKey } from "@/lib/env";
import {
  fetchYouTubeCaptions,
  searchYouTubeVideos,
  type YouTubeClipSuggestion,
  type YouTubeVideoHit,
} from "@/lib/search/youtube";

const CLIP_SEC = 4;
const MIN_GAP_SAME_VIDEO_SEC = 45;

export type HeroPlanLine = {
  index: number;
  words: string;
  /** True = attach a hero video clip suggestion; false = images-only for this beat. */
  useVideo: boolean;
  reason: string;
  visualHint: string;
};

export type HeroClipPlan = {
  title: string;
  heroName: string;
  aliases: string[];
  lines: HeroPlanLine[];
};

export type HeroClipPick = {
  index: number;
  words: string;
  useVideo: boolean;
  reason: string;
  visualHint: string;
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

/** ContactBox: who is the film's hero, and which lines need hero video vs images-only. */
export async function planHeroVideoLines(input: {
  title: string;
  lines: string[];
}): Promise<HeroClipPlan> {
  const { model, configured } = getContactBoxConfig();
  if (!configured) {
    // Heuristic fallback when ContactBox isn't configured.
    const heroGuess =
      input.title.match(
        /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/,
      )?.[1] || "Subject";
    return {
      title: input.title,
      heroName: heroGuess,
      aliases: [heroGuess.split(/\s+/).pop() || heroGuess],
      lines: input.lines.map((words, i) => ({
        index: i + 1,
        words,
        useVideo: true,
        reason: "Fallback: ContactBox not configured — treat all lines as hero video",
        visualHint: `${heroGuess} documentary footage`,
      })),
    };
  }

  const client = createContactBoxClient();
  const numbered = input.lines
    .map((w, i) => `${i + 1}. ${w}`)
    .join("\n");

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a documentary editor planner for celebrity YouTube films.

Given a TITLE and numbered narration LINES (~4 seconds each):

1) Identify the single HERO (main famous person the film is about).
2) For EACH line decide:
   - useVideo=true when the beat is still ABOUT the HERO — their life, privacy, heart, divorce, children, films, appearances, sightings, movements, words, photos of them — even if the line never says their name.
   - useVideo=false ONLY when the beat's visual subject is clearly someone/something else: a newly named third party as the focus, a movie title as the focus, a city/map graphic, documents, abstract secrecy B-roll with no person.

Default bias: if unsure, useVideo=true for the hero. Appearance / sighting / red-carpet / photograph-with / following-his-movements lines MUST be useVideo=true (show the hero).

Be selective on images-only: roughly 1/3 or fewer of lines. Prefer hero video for emotional / presence / private-life / public-appearance beats.

Return JSON only:
{
  "heroName": "Kevin Costner",
  "aliases": ["Costner", "Kevin"],
  "lines": [
    { "index": 1, "useVideo": true, "reason": "...", "visualHint": "Costner interview / red carpet presence" }
  ]
}`,
      },
      {
        role: "user",
        content: `TITLE: ${input.title}\n\nLINES:\n${numbered}`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Empty hero plan response");
  const parsed = extractJson(content) as {
    heroName?: string;
    aliases?: string[];
    lines?: Array<{
      index?: number;
      useVideo?: boolean;
      reason?: string;
      visualHint?: string;
    }>;
  };

  const heroName = (parsed.heroName || "").trim() || "Subject";
  const aliases = Array.from(
    new Set(
      [heroName, ...(parsed.aliases || [])]
        .map((a) => a.trim())
        .filter(Boolean),
    ),
  );

  const byIndex = new Map(
    (parsed.lines || []).map((l) => [Number(l.index), l]),
  );

  return {
    title: input.title,
    heroName,
    aliases,
    lines: input.lines.map((words, i) => {
      const row = byIndex.get(i + 1);
      return {
        index: i + 1,
        words,
        useVideo: Boolean(row?.useVideo),
        reason: row?.reason?.trim() || (row?.useVideo ? "Hero presence" : "Images only"),
        visualHint:
          row?.visualHint?.trim() ||
          (row?.useVideo ? `${heroName} documentary footage` : "still images"),
      };
    }),
  };
}

function heroSearchQueries(heroName: string, visualHint: string): string[] {
  const hint = visualHint.replace(new RegExp(heroName, "ig"), "").trim();
  return [
    `${heroName} interview`,
    `${heroName} red carpet`,
    `${heroName} documentary`,
    `${heroName} ${hint}`.trim(),
    `${heroName} premiere`,
    `${heroName} speech`,
  ].filter((q, i, arr) => q.length > heroName.length + 2 && arr.indexOf(q) === i);
}

/** SearchAPI YouTube fallback when YOUTUBE_API_KEY is missing. */
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
      } as YouTubeVideoHit;
    })
    .filter((h): h is YouTubeVideoHit => Boolean(h))
    .slice(0, maxResults);
}

async function searchHeroVideos(
  queries: string[],
  maxPerQuery = 4,
): Promise<YouTubeVideoHit[]> {
  const byId = new Map<string, YouTubeVideoHit>();
  for (const q of queries) {
    let hits: YouTubeVideoHit[] = [];
    try {
      hits = await searchYouTubeVideos(q, maxPerQuery);
    } catch {
      hits = await searchYouTubeViaSearchApi(q, maxPerQuery);
    }
    if (!hits.length) {
      hits = await searchYouTubeViaSearchApi(q, maxPerQuery);
    }
    for (const h of hits) {
      if (!byId.has(h.videoId)) byId.set(h.videoId, h);
    }
  }
  return Array.from(byId.values());
}

type TimedCandidate = YouTubeClipSuggestion & {
  queryUsed: string;
};

function clipKey(c: { videoId: string; startSec: number }): string {
  return `${c.videoId}@${Math.floor(c.startSec / 5) * 5}`;
}

/** Stable per-video offset so different videos don't all start at :20. */
function videoOffsetSec(videoId: string): number {
  let h = 0;
  for (let i = 0; i < videoId.length; i++) h = (h * 31 + videoId.charCodeAt(i)) >>> 0;
  return 15 + (h % 90); // 15–104s
}

function windowsFromVideo(
  video: YouTubeVideoHit,
  clipSec: number,
  used: Set<string>,
): TimedCandidate[] {
  const duration = video.durationSec || 600;
  const out: TimedCandidate[] = [];
  const offset = videoOffsetSec(video.videoId);
  const step = Math.max(MIN_GAP_SAME_VIDEO_SEC, 55);
  // Distinct entry points: offset, mid, late — never all the same :20.
  const seeds = [
    offset,
    Math.floor(duration * 0.22),
    Math.floor(duration * 0.38),
    Math.floor(duration * 0.55),
    Math.floor(duration * 0.72),
    offset + step,
    offset + step * 2,
  ];
  const seenStarts = new Set<number>();
  for (const raw of seeds) {
    const start = Math.max(8, Math.min(Math.floor(raw), Math.floor(duration - clipSec - 8)));
    if (seenStarts.has(start)) continue;
    seenStarts.add(start);
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
      endSec: start + clipSec,
      durationSec: clipSec,
      matchedText: "",
      score: 0.42,
      hasCaptions: false,
      queryUsed: "spread",
    });
    if (out.length >= 6) break;
  }
  return out;
}

async function candidatesForHeroVideo(
  video: YouTubeVideoHit,
  clipSec: number,
  used: Set<string>,
): Promise<TimedCandidate[]> {
  const cues = await fetchYouTubeCaptions(video.videoId);
  const fromCaptions: TimedCandidate[] = [];
  if (cues.length) {
    // Sample caption starts spaced apart for unique hero presence beats.
    let last = -MIN_GAP_SAME_VIDEO_SEC;
    for (const cue of cues) {
      if (cue.startSec - last < MIN_GAP_SAME_VIDEO_SEC) continue;
      const start = Math.max(0, Math.floor(cue.startSec));
      const key = clipKey({ videoId: video.videoId, startSec: start });
      if (used.has(key)) continue;
      fromCaptions.push({
        videoId: video.videoId,
        title: video.title,
        channelTitle: video.channelTitle,
        thumbnailUrl: video.thumbnailUrl,
        watchUrl: video.watchUrl,
        watchAtUrl: `${video.watchUrl}&t=${start}s`,
        startSec: start,
        endSec: start + clipSec,
        durationSec: clipSec,
        matchedText: cue.text.slice(0, 160),
        score: 0.5,
        hasCaptions: true,
        queryUsed: "caption",
      });
      last = cue.startSec;
      if (fromCaptions.length >= 5) break;
    }
  }
  return [...fromCaptions, ...windowsFromVideo(video, clipSec, used)];
}

/** ContactBox picks the best unique candidate for a hero video line. */
async function aiPickBestClip(input: {
  title: string;
  heroName: string;
  words: string;
  visualHint: string;
  candidates: TimedCandidate[];
}): Promise<{ pick: TimedCandidate | null; verdict: string }> {
  if (!input.candidates.length) {
    return { pick: null, verdict: "No candidates" };
  }
  const { model, configured } = getContactBoxConfig();
  if (!configured) {
    return {
      pick: input.candidates[0],
      verdict: "ContactBox offline — took first unique candidate",
    };
  }

  const client = createContactBoxClient();
  const listed = input.candidates.slice(0, 8).map((c, i) => ({
    i,
    videoId: c.videoId,
    title: c.title,
    channel: c.channelTitle,
    startSec: c.startSec,
    endSec: c.endSec,
    caption: c.matchedText || null,
    watchAtUrl: c.watchAtUrl,
    preferred: Boolean((c as TimedCandidate & { preferred?: boolean }).preferred),
  }));

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a celebrity documentary B-roll editor.

Pick ONE YouTube clip window (~4s) that best shows the HERO for this narration line.
Rules:
- Prefer real footage of the hero (interview, red carpet, premiere, candid).
- Reject movie trailers that are only other actors, meme compilations, reaction videos, or wrong person.
- Prefer visually distinct moments (different outfits/settings) when choosing among options.
- Strongly prefer candidates with preferred:true — unused videos and unique timestamps.
- Never pick the same videoId@timestamp family as another line if alternatives exist.
- If none are acceptable, return pickIndex: null.

Prefer candidates marked preferred:true (unused video + distinct timestamp).
Avoid picking the same startSec bucket as other lines when options exist.
Return JSON: { "pickIndex": 0|null, "verdict": "short reason" }`,
      },
      {
        role: "user",
        content: `FILM TITLE: ${input.title}
HERO: ${input.heroName}
LINE: ${input.words}
VISUAL HINT: ${input.visualHint}

CANDIDATES (pick ONE unique clip — different video and/or timestamp from prior lines):
${JSON.stringify(listed, null, 2)}`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) return { pick: input.candidates[0], verdict: "Empty AI response" };
  const parsed = extractJson(content) as {
    pickIndex?: number | null;
    verdict?: string;
  };
  if (parsed.pickIndex == null || parsed.pickIndex < 0) {
    return { pick: null, verdict: parsed.verdict || "AI rejected all candidates" };
  }
  const pick = input.candidates[parsed.pickIndex] || null;
  return { pick, verdict: parsed.verdict || "Selected by AI" };
}

/**
 * Full-script hero clip planner:
 * - ContactBox decides hero + which lines need video
 * - YouTube search for hero footage (no download)
 * - Unique 4s timestamp windows
 * - ContactBox QA pick per video line
 */
export async function buildHeroYouTubeClipSuggestions(input: {
  title: string;
  lines: string[];
  onProgress?: (msg: string) => void;
}): Promise<{
  plan: HeroClipPlan;
  picks: HeroClipPick[];
  videoLineCount: number;
  imageOnlyCount: number;
}> {
  await input.onProgress?.("Planning hero + which lines need video…");
  const plan = await planHeroVideoLines({
    title: input.title,
    lines: input.lines,
  });

  const videoLines = plan.lines.filter((l) => l.useVideo);
  await input.onProgress?.(
    `Hero=${plan.heroName} · video lines ${videoLines.length}/${plan.lines.length} · searching YouTube…`,
  );

  const querySet = new Set<string>();
  for (const line of videoLines) {
    for (const q of heroSearchQueries(plan.heroName, line.visualHint)) {
      querySet.add(q);
    }
  }
  // Always seed core hero searches.
  for (const q of heroSearchQueries(plan.heroName, "interview")) {
    querySet.add(q);
  }

  const videos = await searchHeroVideos(Array.from(querySet).slice(0, 10), 5);
  await input.onProgress?.(
    `Found ${videos.length} unique YouTube videos · scoring windows…`,
  );

  const used = new Set<string>();
  const usedVideoIds = new Set<string>();
  const picks: HeroClipPick[] = [];

  // Precompute candidate pools per video (captions + spreads).
  const poolByVideo = new Map<string, TimedCandidate[]>();
  for (const v of videos) {
    poolByVideo.set(v.videoId, await candidatesForHeroVideo(v, CLIP_SEC, used));
  }

  for (const line of plan.lines) {
    if (!line.useVideo) {
      picks.push({
        index: line.index,
        words: line.words,
        useVideo: false,
        reason: line.reason,
        visualHint: line.visualHint,
        clip: null,
        note: "Images only — not a hero video beat",
      });
      continue;
    }

    // Prefer unused videos first; stagger start times globally.
    const usedStartBuckets = new Set(
      [...used].map((k) => Number(k.split("@")[1] || 0)),
    );
    const rankedVideos = [...videos].sort((a, b) => {
      const au = usedVideoIds.has(a.videoId) ? 1 : 0;
      const bu = usedVideoIds.has(b.videoId) ? 1 : 0;
      return au - bu;
    });

    const candidates: TimedCandidate[] = [];
    for (const v of rankedVideos) {
      const pool = (poolByVideo.get(v.videoId) || [])
        .filter((c) => !used.has(clipKey(c)))
        .sort((a, b) => {
          const aBucket = Math.floor(a.startSec / 5) * 5;
          const bBucket = Math.floor(b.startSec / 5) * 5;
          const aUsed = usedStartBuckets.has(aBucket) ? 1 : 0;
          const bUsed = usedStartBuckets.has(bBucket) ? 1 : 0;
          if (aUsed !== bUsed) return aUsed - bUsed;
          return a.startSec - b.startSec;
        });
      for (const c of pool.slice(0, 2)) {
        candidates.push({
          ...c,
          preferred: !usedVideoIds.has(v.videoId),
        } as TimedCandidate & { preferred?: boolean });
      }
      if (candidates.length >= 8) break;
    }

    await input.onProgress?.(
      `AI picking clip for line ${line.index}/${plan.lines.length}…`,
    );
    const { pick, verdict } = await aiPickBestClip({
      title: input.title,
      heroName: plan.heroName,
      words: line.words,
      visualHint: line.visualHint,
      candidates,
    });

    if (pick) {
      used.add(clipKey(pick));
      usedVideoIds.add(pick.videoId);
      // Remove nearby windows from that video's pool.
      const pool = poolByVideo.get(pick.videoId) || [];
      poolByVideo.set(
        pick.videoId,
        pool.filter(
          (c) => Math.abs(c.startSec - pick.startSec) >= MIN_GAP_SAME_VIDEO_SEC,
        ),
      );
    }

    picks.push({
      index: line.index,
      words: line.words,
      useVideo: true,
      reason: line.reason,
      visualHint: line.visualHint,
      clip: pick,
      aiVerdict: verdict,
      note: pick
        ? undefined
        : "No unique hero clip passed AI QA — use images for this line",
    });
  }

  return {
    plan,
    picks,
    videoLineCount: videoLines.length,
    imageOnlyCount: plan.lines.length - videoLines.length,
  };
}
