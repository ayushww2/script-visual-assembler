/**
 * FAST dual-hero plan for Cher / Tom Cruise.
 * 1) ContactBox: label each line cher | tom | images (images = query only, no Google call)
 * 2) ≤10 YouTube sources per hero, unique ~4s timestamps
 * Parallel AI picks to finish ~10 min.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createContactBoxClient, getContactBoxConfig } from "../src/lib/contactbox";
import {
  searchYouTubeVideos,
  type YouTubeClipSuggestion,
  type YouTubeVideoHit,
} from "../src/lib/search/youtube";
import { getSearchApiKey } from "../src/lib/env";

const CLIP_SEC = 4;
const MIN_GAP = 40;
const MAX_SRC = 10;

const TITLE = "Cher & Tom Cruise — what really happened";

type Mode = "cher" | "tom" | "images";
type PlanLine = {
  index: number;
  words: string;
  mode: Mode;
  reason: string;
  visualHint: string;
  googleQuery: string | null;
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

async function poolHero(name: string, titleRe: RegExp): Promise<YouTubeVideoHit[]> {
  const qs = [
    `${name} interview`,
    `${name} talk show`,
    `${name} red carpet`,
    `${name} documentary`,
    `${name} 2024 interview`,
  ];
  const byId = new Map<string, YouTubeVideoHit>();
  for (const q of qs) {
    if (byId.size >= MAX_SRC) break;
    for (const h of await ytSearch(q, 5)) {
      if (!titleRe.test(h.title)) continue;
      if (!byId.has(h.videoId)) byId.set(h.videoId, h);
      if (byId.size >= MAX_SRC) break;
    }
  }
  return Array.from(byId.values()).slice(0, MAX_SRC);
}

function offset(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 15 + (h % 90);
}

function windows(v: YouTubeVideoHit): YouTubeClipSuggestion[] {
  const dur = v.durationSec || 600;
  const o = offset(v.videoId);
  const seeds = [
    o,
    Math.floor(dur * 0.22),
    Math.floor(dur * 0.38),
    Math.floor(dur * 0.52),
    Math.floor(dur * 0.68),
    Math.floor(dur * 0.82),
    o + 50,
    o + 100,
    o + 150,
    o + 200,
  ];
  const out: YouTubeClipSuggestion[] = [];
  const seen = new Set<number>();
  for (const raw of seeds) {
    const start = Math.max(8, Math.min(Math.floor(raw), Math.floor(dur - CLIP_SEC - 8)));
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

async function planChunk(
  lines: string[],
  indexOffset: number,
  totalN: number,
): Promise<PlanLine[]> {
  const { model } = getContactBoxConfig();
  const client = createContactBoxClient();
  const n = lines.length;
  // Per-chunk video share of global 30–40%
  const vmin = Math.max(1, Math.round(n * 0.3));
  const vmax = Math.max(vmin, Math.round(n * 0.4));
  const numbered = lines
    .map((w, i) => `${indexOffset + i + 1}. ${w}`)
    .join("\n");

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Documentary planner. TWO heroes: Cher and Tom Cruise. Film has ${totalN} lines total; this is a CHUNK of ${n}.

Each line → mode "cher" | "tom" | "images".

VIDEO: hero presence / emotion / relationship about Cher or Tom (even if name omitted).
IMAGES: Madonna, Sean Penn, wedding, White House, DC, Lab School, movie posters, other celebs, places. Include googleQuery.

In THIS chunk keep cher+tom between ${vmin}-${vmax}. Split fairly.

JSON only: { "lines": [ { "index": <global 1-based>, "mode":"cher"|"tom"|"images", "reason":"short", "visualHint":"short", "googleQuery":"..."|null } ] }
Keep reason/visualHint under 12 words each.`,
      },
      { role: "user", content: `TITLE: ${TITLE}\n\nCHUNK LINES:\n${numbered}` },
    ],
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("empty plan chunk");
  let parsed: {
    lines?: Array<{
      index?: number;
      mode?: string;
      reason?: string;
      visualHint?: string;
      googleQuery?: string | null;
    }>;
  };
  try {
    parsed = extractJson(content) as typeof parsed;
  } catch {
    // salvage: try to cut to last complete object in lines array
    const cut = content.lastIndexOf("},");
    if (cut > 0) {
      const repaired = content.slice(0, cut + 1) + "]}";
      const start = repaired.indexOf("{");
      parsed = JSON.parse(repaired.slice(start)) as typeof parsed;
    } else throw new Error("plan chunk JSON failed");
  }
  const map = new Map((parsed.lines || []).map((l) => [Number(l.index), l]));
  return lines.map((words, i) => {
    const idx = indexOffset + i + 1;
    const row = map.get(idx);
    let mode = (row?.mode || "images").toLowerCase() as Mode;
    if (mode !== "cher" && mode !== "tom" && mode !== "images") mode = "images";
    // Heuristic fallback if model skipped a line
    if (!row) {
      const w = words.toLowerCase();
      if (
        /madonna|sean penn|white house|washington|lab school|wedding|mission:\s*impossible|dyslexia/.test(
          w,
        )
      ) {
        mode = "images";
      } else if (/\bcher\b|she |her /.test(w) && !/tom/.test(w)) mode = "cher";
      else if (/tom|cruise|\bhe\b|\bhim\b/.test(w)) mode = "tom";
      else mode = "images";
    }
    return {
      index: idx,
      words,
      mode,
      reason: row?.reason?.trim() || "chunk",
      visualHint: row?.visualHint?.trim() || "",
      googleQuery:
        mode === "images"
          ? row?.googleQuery?.trim() || words.slice(0, 90)
          : null,
    };
  });
}

async function planLines(lines: string[]): Promise<PlanLine[]> {
  const CHUNK = 45;
  const slices: Array<{ slice: string[]; offset: number }> = [];
  for (let i = 0; i < lines.length; i += CHUNK) {
    slices.push({ slice: lines.slice(i, i + CHUNK), offset: i });
  }
  // 2 chunks in parallel to stay under ~10 min
  const parts: PlanLine[][] = [];
  for (let i = 0; i < slices.length; i += 2) {
    const batch = slices.slice(i, i + 2);
    console.log(
      `  plan chunks ${batch.map((b) => `${b.offset + 1}-${b.offset + b.slice.length}`).join(" & ")}…`,
    );
    const got = await Promise.all(
      batch.map((b) => planChunk(b.slice, b.offset, lines.length)),
    );
    parts.push(...got);
  }
  const chunks = parts.flat();

  const vmax = Math.round(lines.length * 0.4);
  const vids = chunks.map((p, i) => ({ i, p })).filter((x) => x.p.mode !== "images");
  if (vids.length > vmax) {
    for (const { i } of [...vids].reverse().slice(0, vids.length - vmax)) {
      chunks[i] = {
        ...chunks[i],
        mode: "images",
        googleQuery: chunks[i].visualHint || chunks[i].words.slice(0, 90),
        reason: chunks[i].reason + " [cap→images]",
      };
    }
  }
  return chunks;
}

async function aiPick(
  hero: string,
  words: string,
  hint: string,
  cands: YouTubeClipSuggestion[],
): Promise<{ pick: YouTubeClipSuggestion | null; verdict: string }> {
  if (!cands.length) return { pick: null, verdict: "none" };
  const { model } = getContactBoxConfig();
  const client = createContactBoxClient();
  const listed = cands.slice(0, 6).map((c, i) => ({
    i,
    title: c.title,
    startSec: c.startSec,
    watchAtUrl: c.watchAtUrl,
  }));
  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.1,
      stream: false,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Pick ONE 4s clip showing ${hero} on camera. Reject wrong person. JSON: {"pickIndex":0|null,"verdict":"short"}`,
        },
        {
          role: "user",
          content: `LINE: ${words}\nHINT: ${hint}\n${JSON.stringify(listed)}`,
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return { pick: cands[0], verdict: "fallback" };
    const p = extractJson(raw) as { pickIndex?: number | null; verdict?: string };
    if (p.pickIndex == null || p.pickIndex < 0)
      return { pick: null, verdict: p.verdict || "reject" };
    return { pick: cands[p.pickIndex] || cands[0], verdict: p.verdict || "ok" };
  } catch (e) {
    return {
      pick: cands[0],
      verdict: `err-fallback: ${e instanceof Error ? e.message : "x"}`,
    };
  }
}

async function main() {
  const t0 = Date.now();
  const lines: string[] = JSON.parse(
    readFileSync("/tmp/cher_tom_beats.json", "utf8"),
  );
  console.log(`[0s] ${lines.length} beats`);

  console.log("· Planning cher/tom/images…");
  const plan = await planLines(lines);
  const cherN = plan.filter((p) => p.mode === "cher").length;
  const tomN = plan.filter((p) => p.mode === "tom").length;
  const imgN = plan.filter((p) => p.mode === "images").length;
  console.log(
    `[${((Date.now() - t0) / 1000).toFixed(0)}s] cher=${cherN} tom=${tomN} images=${imgN}`,
  );

  // Write image list early so we have something if interrupted
  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  const imageLines = plan
    .filter((p) => p.mode === "images")
    .map((p) => ({
      line: p.index,
      words: p.words,
      googleQuery: p.googleQuery,
      reason: p.reason,
    }));
  writeFileSync(
    "/opt/cursor/artifacts/cher-tom-IMAGES-only.json",
    JSON.stringify({ count: imageLines.length, lines: imageLines }, null, 2),
  );
  console.log(`· Wrote ${imageLines.length} image labels (no Google calls)`);

  console.log("· Searching ≤10 sources each…");
  const [cherSrc, tomSrc] = await Promise.all([
    poolHero("Cher", /\bcher\b/i),
    poolHero("Tom Cruise", /tom\s*cruise|\bcruise\b/i),
  ]);
  console.log(
    `[${((Date.now() - t0) / 1000).toFixed(0)}s] sources cher=${cherSrc.length} tom=${tomSrc.length}`,
  );

  const pools = {
    cher: new Map(cherSrc.map((v) => [v.videoId, windows(v)])),
    tom: new Map(tomSrc.map((v) => [v.videoId, windows(v)])),
  };
  const videos = { cher: cherSrc, tom: tomSrc };

  // Unique assignment with parallel AI — reserve keys under a mutex-like queue
  const used = new Set<string>();
  const usedVids = new Set<string>();
  const videoLines = plan.filter((p) => p.mode === "cher" || p.mode === "tom");

  type VidOut = {
    line: number;
    mode: Mode;
    words: string;
    clip: YouTubeClipSuggestion | null;
    aiVerdict?: string;
    visualHint: string;
  };

  // Mechanical unique assignment from ≤10 sources (no per-line AI — speed).
  // Candidates already prefer unused videos via sort order.
  console.log(`· Assigning unique timestamps for ${videoLines.length} video lines…`);
  const results: VidOut[] = [];
  // Reset used — rebuild cleanly
  used.clear();
  usedVids.clear();
  // restore pools
  for (const v of cherSrc) pools.cher.set(v.videoId, windows(v));
  for (const v of tomSrc) pools.tom.set(v.videoId, windows(v));

  for (const line of videoLines) {
    const mode = line.mode as "cher" | "tom";
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
    results.push({
      line: line.index,
      mode: line.mode,
      words: line.words,
      clip: pick,
      aiVerdict: pick ? "unique-window from hero source pool" : "no window",
      visualHint: line.visualHint,
    });
  }

  const byLine = new Map(results.map((r) => [r.line, r]));
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
    const r = byLine.get(p.index);
    if (!r?.clip) {
      return {
        line: p.index,
        mode: "images" as const,
        words: p.words,
        googleQuery: p.visualHint || p.words.slice(0, 90),
        reason: "video miss → image",
      };
    }
    return {
      line: p.index,
      mode: r.mode,
      words: p.words,
      startSec: r.clip.startSec,
      endSec: r.clip.endSec,
      watchAtUrl: r.clip.watchAtUrl,
      videoTitle: r.clip.title,
      videoId: r.clip.videoId,
      aiVerdict: r.aiVerdict,
    };
  });

  const out = {
    title: TITLE,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    counts: {
      total: picks.length,
      cher: picks.filter((p) => p.mode === "cher").length,
      tom: picks.filter((p) => p.mode === "tom").length,
      images: picks.filter((p) => p.mode === "images").length,
    },
    cherSources: cherSrc.map((v) => ({
      id: v.videoId,
      title: v.title,
      url: v.watchUrl,
    })),
    tomSources: tomSrc.map((v) => ({
      id: v.videoId,
      title: v.title,
      url: v.watchUrl,
    })),
    picks,
  };

  writeFileSync(
    "/opt/cursor/artifacts/cher-tom-hero-clips.json",
    JSON.stringify(out, null, 2),
  );

  const md: string[] = [
    `# ${TITLE}`,
    ``,
    `Done in **${out.elapsedSec}s** · Cher video ${out.counts.cher} · Tom video ${out.counts.tom} · Images ${out.counts.images}`,
    ``,
    `## YouTube clips`,
    ``,
  ];
  for (const p of picks) {
    if (p.mode === "images") continue;
    md.push(
      `- **L${p.line}** [${p.mode}] \`${"startSec" in p ? p.startSec : "?"}s–${"endSec" in p ? p.endSec : "?"}s\` ${(p as { words: string }).words}`,
    );
    md.push(`  - [${(p as { videoTitle?: string }).videoTitle}](${(p as { watchAtUrl?: string }).watchAtUrl})`);
  }
  md.push(``, `## Images (Google — queries only, not fetched)`, ``);
  for (const p of picks) {
    if (p.mode !== "images") continue;
    md.push(
      `- **L${p.line}** ${(p as { words: string }).words} → \`${(p as { googleQuery?: string }).googleQuery}\``,
    );
  }
  writeFileSync("/opt/cursor/artifacts/cher-tom-hero-clips.md", md.join("\n"));

  console.log("\n=== DONE ===", out.counts, `${out.elapsedSec}s`);
  console.log("Video clips:");
  for (const p of picks) {
    if (p.mode === "images") continue;
    console.log(
      `L${p.line} [${p.mode}] ${(p as { startSec: number }).startSec}s ${(p as { watchAtUrl: string }).watchAtUrl}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
