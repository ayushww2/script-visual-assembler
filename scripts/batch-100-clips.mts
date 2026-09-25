/**
 * Batch: first 100 lines × 4 scripts → ~30–40% YouTube clips, rest images.
 * No video download — watch URLs + timestamps only.
 *
 * Usage:
 *   SEARCHAPI_API_KEY=... npx tsx scripts/batch-100-clips.mts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { getSearchApiKey } from "../src/lib/env";
import {
  searchYouTubeVideos,
  type YouTubeClipSuggestion,
  type YouTubeVideoHit,
} from "../src/lib/search/youtube";
import { createContactBoxClient, getContactBoxConfig } from "../src/lib/contactbox";

const CLIP_SEC = 4;
const MIN_GAP = 40;
const MAX_SRC = 10;
const VIDEO_RATIO = 0.35; // mid of 30–40%
const LIMIT_LINES = 100;

type ScriptSpec = {
  id: string;
  docx: string;
  title: string;
  kind: "hero" | "dual-hero" | "place";
  heroes?: string[];
  searchQueries: string[];
};

const SCRIPTS: ScriptSpec[] = [
  {
    id: "sphinx",
    docx: "/home/ubuntu/.cursor/projects/workspace/uploads/Sphinx_Secret_Tunnel_Visual_Line_Script_48a5.docx",
    title: "Sphinx Secret Tunnel",
    kind: "place",
    searchQueries: [
      "Great Sphinx of Giza tunnel documentary",
      "Sphinx passage excavation Egypt",
      "Sphinx restoration Giza archaeology",
      "inside Great Sphinx Egypt documentary",
      "Giza Sphinx secret chamber exploration",
    ],
  },
  {
    id: "dead-sea",
    docx: "/home/ubuntu/.cursor/projects/workspace/uploads/Dead_Sea_Scrolls_DNA_Visual_Line_Script_8553.docx",
    title: "Dead Sea Scrolls DNA",
    kind: "place",
    searchQueries: [
      "Dead Sea Scrolls documentary fragments",
      "Dead Sea Scrolls DNA parchment science",
      "Qumran caves Dead Sea Scrolls",
      "scientists sequence Dead Sea Scrolls DNA",
      "Israel Antiquities Dead Sea Scrolls lab",
    ],
  },
  {
    id: "clint",
    docx: "/home/ubuntu/.cursor/projects/workspace/uploads/Clint_Eastwood_Visual_Line_Script_c233.docx",
    title: "Clint Eastwood",
    kind: "hero",
    heroes: ["Clint Eastwood"],
    searchQueries: [
      "Clint Eastwood interview documentary",
      "Clint Eastwood Dirty Harry clip",
      "Clint Eastwood directing movie set",
      "Clint Eastwood Oscars Unforgiven",
      "Clint Eastwood western spaghetti",
      "Clint Eastwood red carpet premiere",
    ],
  },
  {
    id: "paul-mj",
    docx: "/home/ubuntu/.cursor/projects/workspace/uploads/Paul_McCartney_Michael_Jackson_Visual_Line_Script_9c94.docx",
    title: "Paul McCartney & Michael Jackson",
    kind: "dual-hero",
    heroes: ["Paul McCartney", "Michael Jackson"],
    searchQueries: [
      "Paul McCartney Michael Jackson Say Say Say",
      "Paul McCartney interview Beatles",
      "Michael Jackson interview Thriller",
      "Paul McCartney Michael Jackson friendship",
      "Michael Jackson music publishing ATV",
      "Paul McCartney live concert",
      "Michael Jackson performance live",
    ],
  },
];

function linesFromDocx(path: string): string[] {
  const tmp = "/tmp/docx-" + Math.random().toString(36).slice(2);
  execSync(`mkdir -p ${tmp} && unzip -qq -o ${JSON.stringify(path)} -d ${tmp}`);
  const xml = readFileSync(`${tmp}/word/document.xml`, "utf8");
  const paras = xml
    .split(/<\/w:p>/)
    .map((p) => {
      const ts = [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
      return ts.join("").replace(/\s+/g, " ").trim();
    })
    .filter(Boolean);
  execSync(`rm -rf ${tmp}`);
  return paras;
}

function first100Narrative(all: string[]): string[] {
  const skip = /^(HOOK|BODY|ACT\s*\d+|COLD OPEN|OUTRO|TEASER)$/i;
  return all.filter((l) => l.length > 3 && !skip.test(l)).slice(0, LIMIT_LINES);
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
    console.log(`  searchapi ${res.status} for ${q.slice(0, 40)}`);
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

function rejectBad(h: YouTubeVideoHit) {
  const t = h.title.toLowerCase();
  if (/#shorts|\bshorts\b|tiktok|vertical|reaction|asmr/.test(t)) return true;
  if (h.durationSec && h.durationSec > 0 && h.durationSec < 60) return true;
  return false;
}

type PlanLine = {
  line: number;
  words: string;
  mode: "video" | "images";
  visualHint: string;
  googleQuery: string | null;
  reason: string;
};

async function planLines(
  spec: ScriptSpec,
  lines: string[],
): Promise<PlanLine[]> {
  const vmax = Math.round(lines.length * VIDEO_RATIO);
  const { model, configured } = getContactBoxConfig();

  if (configured) {
    try {
      const client = createContactBoxClient();
      const numbered = lines.map((w, i) => `${i + 1}. ${w}`).join("\n");
      const heroNote =
        spec.kind === "dual-hero"
          ? `Dual heroes: ${(spec.heroes || []).join(" & ")}. Prefer performance/interview footage of either.`
          : spec.kind === "hero"
            ? `Hero: ${(spec.heroes || [])[0]}. Prefer clear footage of this person.`
            : `Place/archaeology documentary. Prefer site digs, labs, caves, monuments — not talking-head only.`;
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.2,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You plan visuals for a documentary YouTube film.
${heroNote}
Select about ${vmax} of ${lines.length} lines for YouTube VIDEO (~35%). Rest = Google images.
VIDEO: presence, action, place establishing, performance, excavation, lab work.
IMAGES: named details, documents, abstract claims, lists, tiny props.

JSON:
{
  "lines": [
    { "index": 1, "useVideo": true/false, "visualHint": "short", "googleQuery": "or null", "reason": "short" }
  ]
}
Every index 1..${lines.length} must appear exactly once.`,
          },
          {
            role: "user",
            content: `TITLE: ${spec.title}\n\nLINES:\n${numbered}`,
          },
        ],
      });
      const raw = completion.choices[0]?.message?.content;
      if (raw) {
        const parsed = extractJson(raw) as {
          lines?: Array<{
            index?: number;
            useVideo?: boolean;
            visualHint?: string;
            googleQuery?: string | null;
            reason?: string;
          }>;
        };
        const byIdx = new Map(
          (parsed.lines || []).map((r) => [Number(r.index), r]),
        );
        let plan = lines.map((words, i) => {
          const row = byIdx.get(i + 1);
          const useVideo = Boolean(row?.useVideo);
          return {
            line: i + 1,
            words,
            mode: (useVideo ? "video" : "images") as "video" | "images",
            visualHint: row?.visualHint || words.slice(0, 60),
            googleQuery: useVideo
              ? null
              : row?.googleQuery ||
                words.replace(/[^a-zA-Z0-9\s]/g, " ").split(/\s+/).slice(0, 8).join(" "),
            reason: row?.reason || "",
          };
        });
        // Cap/enforce ~35%
        const vids = plan.filter((p) => p.mode === "video");
        if (vids.length > vmax) {
          const keep = new Set(
            vids.filter((_, i) => i % Math.ceil(vids.length / vmax) === 0)
              .slice(0, vmax)
              .map((p) => p.line),
          );
          // fill
          for (const p of vids) {
            if (keep.size >= vmax) break;
            keep.add(p.line);
          }
          plan = plan.map((p) =>
            p.mode === "video" && !keep.has(p.line)
              ? {
                  ...p,
                  mode: "images" as const,
                  googleQuery:
                    p.googleQuery ||
                    p.words
                      .replace(/[^a-zA-Z0-9\s]/g, " ")
                      .split(/\s+/)
                      .slice(0, 8)
                      .join(" "),
                  reason: "cap→images",
                }
              : p,
          );
        } else if (vids.length < Math.round(lines.length * 0.3)) {
          // bump to at least 30%
          const need = Math.round(lines.length * 0.3) - vids.length;
          let added = 0;
          plan = plan.map((p, i) => {
            if (p.mode === "images" && added < need && i % 3 === 0) {
              added++;
              return {
                ...p,
                mode: "video" as const,
                googleQuery: null,
                reason: "floor→video",
              };
            }
            return p;
          });
        }
        return plan;
      }
    } catch (e) {
      console.log(
        `  plan LLM fail: ${e instanceof Error ? e.message : e} → heuristic`,
      );
    }
  }

  return heuristicPlan(spec, lines);
}

function heuristicPlan(spec: ScriptSpec, lines: string[]): PlanLine[] {
  const vmax = Math.round(lines.length * VIDEO_RATIO);
  const scored = lines.map((words, i) => {
    const w = words.toLowerCase();
    let score = 0;
    if (spec.kind === "place") {
      if (
        /sphinx|tunnel|passage|excavat|cave|qumran|scroll|lab|giza|monument|restoration|chamber|fragment|dna|scientist|parchment/.test(
          w,
        )
      )
        score += 3;
      if (/stood|metres|ordinary|nobody knew|mystery|clue/.test(w)) score += 1;
    } else if (spec.kind === "dual-hero") {
      if (/paul|mccartney/.test(w)) score += 2;
      if (/michael|jackson/.test(w)) score += 2;
      if (/sing|song|concert|interview|perform|beatles|thriller|catalogue|wrote|friend/.test(w))
        score += 2;
    } else {
      if (/eastwood|clint/.test(w)) score += 3;
      if (/screen|camera|film|movie|direct|oscar|fame|actor/.test(w)) score += 2;
      if (/women|family|children|marriage|partner/.test(w)) score += 1;
    }
    // prefer evenly spaced hooks
    if (i < 15) score += 1;
    if (i % 3 === 0) score += 0.5;
    return { i, words, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const videoIdx = new Set(scored.slice(0, vmax).map((s) => s.i));
  return lines.map((words, i) => {
    const useVideo = videoIdx.has(i);
    return {
      line: i + 1,
      words,
      mode: useVideo ? ("video" as const) : ("images" as const),
      visualHint: words.slice(0, 60),
      googleQuery: useVideo
        ? null
        : words
            .replace(/[^a-zA-Z0-9\s]/g, " ")
            .split(/\s+/)
            .slice(0, 8)
            .join(" "),
      reason: useVideo ? "heuristic-video" : "heuristic-image",
    };
  });
}

function windows(v: YouTubeVideoHit): YouTubeClipSuggestion[] {
  const dur = Math.max(120, Math.min(v.durationSec || 500, 1800));
  const seeds = [
    Math.floor(dur * 0.2),
    Math.floor(dur * 0.32),
    Math.floor(dur * 0.44),
    Math.floor(dur * 0.56),
    Math.floor(dur * 0.68),
    Math.floor(dur * 0.8),
    40,
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

function clipKey(c: { videoId: string; startSec: number }) {
  return `${c.videoId}@${Math.floor(c.startSec / 5) * 5}`;
}

async function processOne(spec: ScriptSpec) {
  const t0 = Date.now();
  console.log(`\n======== ${spec.id} · ${spec.title} ========`);
  const lines = first100Narrative(linesFromDocx(spec.docx));
  console.log(`lines=${lines.length}`);

  const plan = await planLines(spec, lines);
  const vN = plan.filter((p) => p.mode === "video").length;
  console.log(`plan video=${vN} images=${plan.length - vN} (~${Math.round((100 * vN) / plan.length)}%)`);

  const byId = new Map<string, YouTubeVideoHit>();
  for (const q of spec.searchQueries) {
    if (byId.size >= MAX_SRC) break;
    for (const h of await ytSearch(q, 5)) {
      if (rejectBad(h)) continue;
      if (!byId.has(h.videoId)) byId.set(h.videoId, h);
      if (byId.size >= MAX_SRC) break;
    }
  }
  const sources = Array.from(byId.values()).slice(0, MAX_SRC);
  console.log(`sources=${sources.length}`);
  for (const s of sources) console.log(" ", s.videoId, s.title.slice(0, 65));

  const pools = new Map(sources.map((v) => [v.videoId, windows(v)]));
  const used = new Set<string>();
  const usedVids = new Set<string>();

  const picks = plan.map((p) => {
    if (p.mode === "images") {
      return {
        line: p.line,
        mode: "images" as const,
        words: p.words,
        googleQuery: p.googleQuery,
        reason: p.reason,
        visualHint: p.visualHint,
      };
    }
    const ranked = [...sources].sort(
      (a, b) =>
        (usedVids.has(a.videoId) ? 1 : 0) - (usedVids.has(b.videoId) ? 1 : 0),
    );
    let pick: YouTubeClipSuggestion | null = null;
    for (const v of ranked) {
      const pool = (pools.get(v.videoId) || []).filter((c) => !used.has(clipKey(c)));
      if (!pool.length) continue;
      pick = pool[0];
      used.add(clipKey(pick));
      usedVids.add(pick.videoId);
      pools.set(
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
        googleQuery: p.visualHint || p.words.slice(0, 90),
        reason: "no clip slot → image",
        visualHint: p.visualHint,
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
      visualHint: p.visualHint,
      reason: p.reason,
    };
  });

  const out = {
    id: spec.id,
    title: spec.title,
    lineLimit: LIMIT_LINES,
    clipSec: CLIP_SEC,
    videoRatioTarget: VIDEO_RATIO,
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
  const jsonPath = `/opt/cursor/artifacts/${spec.id}-100-clips.json`;
  writeFileSync(jsonPath, JSON.stringify(out, null, 2));

  const txt: string[] = [
    `${spec.title.toUpperCase()} · FIRST ${LIMIT_LINES} · ${out.counts.video} video · ${out.counts.images} images · ${out.elapsedSec}s`,
    "",
    "SOURCES",
    "=======",
  ];
  for (const s of out.sources) {
    txt.push(`${s.id} | ${s.title}`);
    txt.push(`  ${s.url}`);
    txt.push("");
  }
  txt.push("VIDEO");
  txt.push("=====");
  for (const p of picks) {
    if (p.mode !== "video") continue;
    txt.push(`L${p.line} | ${p.startSec}-${p.endSec}s | ${p.watchAtUrl}`);
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
  const txtPath = `/opt/cursor/artifacts/${spec.id}-100-ALL-LINKS.txt`;
  writeFileSync(txtPath, txt.join("\n"));
  console.log("=== DONE ===", out.counts, `${out.elapsedSec}s`);
  console.log("wrote", jsonPath);
  return out;
}

async function main() {
  // Prefer explicit env key; do not write key into repo files.
  if (!process.env.SEARCHAPI_API_KEY) {
    console.error("SEARCHAPI_API_KEY required");
    process.exit(1);
  }
  const results = [];
  for (const spec of SCRIPTS) {
    results.push(await processOne(spec));
  }
  const summary = results.map((r) => ({
    id: r.id,
    title: r.title,
    ...r.counts,
    sources: r.sources.length,
    elapsedSec: r.elapsedSec,
  }));
  writeFileSync(
    "/opt/cursor/artifacts/batch-100-summary.json",
    JSON.stringify(summary, null, 2),
  );
  console.log("\n===== BATCH SUMMARY =====");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
