import type { Beat } from "./schema";
import { getNiche, type NicheId } from "@/lib/niches";

type WhisperSegment = {
  id?: string | number;
  text?: string;
  start?: number;
  end?: number;
};

export type ParseBeatsOptions = {
  nicheId?: string | null;
  /** Override WPM for niche-aware pacing (celebrity calm cuts). */
  wpm?: number;
};

/**
 * Accepts:
 * - plain script text
 * - Whisper-style JSON: { segments: [{ id, text, start, end }] }
 * - raw JSON array of segments
 *
 * Mystery plain-script pacing (160 WPM) — UNCHANGED:
 * - First ~100 words: fast cuts (≈2–4s → ~5–11 words), keep short punch lines alone
 * - Rest: target ~11 words (~4.1s), clamp 8–15 when merging
 *
 * Celebrity plain-script pacing (130 WPM experiment):
 * - Calm ~4–7s scenes driven by the script
 * - Never cut mid-sentence; merge short sentences when it still fits ~4–7s
 */
export function parseBeats(
  input: string,
  opts?: ParseBeatsOptions,
): Beat[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const fromJson = tryParseWhisper(trimmed);
  if (fromJson) return fromJson;

  const nicheId = (opts?.nicheId || undefined) as NicheId | undefined;
  const niche = getNiche(nicheId);
  const wpm = opts?.wpm || niche.wpm;

  if (niche.id === "celebrity") {
    return splitScriptTextCelebrity(trimmed, wpm);
  }

  return splitScriptText(trimmed);
}

function tryParseWhisper(raw: string): Beat[] | null {
  if (!(raw.startsWith("{") || raw.startsWith("["))) return null;
  try {
    const data = JSON.parse(raw) as
      | WhisperSegment[]
      | { segments?: WhisperSegment[]; beats?: WhisperSegment[] };

    const segments = Array.isArray(data)
      ? data
      : data.segments || data.beats || null;
    if (!segments?.length) return null;

    const beats: Beat[] = [];
    segments.forEach((seg, i) => {
      const text = String(seg.text || "").trim();
      if (!text) return;
      beats.push({
        id: seg.id != null ? `b${seg.id}` : `b${i + 1}`,
        text,
        start: typeof seg.start === "number" ? seg.start : undefined,
        end: typeof seg.end === "number" ? seg.end : undefined,
      });
    });
    return beats;
  } catch {
    return null;
  }
}

/** Mystery path — keep historical behavior exactly. */
function splitScriptText(script: string): Beat[] {
  const normalized = script.replace(/\r\n/g, "\n").trim();
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter(Boolean);

  const units: string[] = [];
  for (const p of paragraphs) {
    const wc = wordCount(p);
    if (wc <= 15) {
      units.push(p);
    } else {
      units.push(...chunkLongText(p));
    }
  }

  // Second pass: merge ultra-short adjacent body lines only when both are tiny
  // and we're past the fast-open window (keeps punch lines in the open).
  const paced = rebalanceUnits(units);

  return paced.map((text, i) => ({
    id: `b${i + 1}`,
    text,
  }));
}

/**
 * Celebrity experiment: sentence-boundary scenes sized from WPM.
 * Target calm 4–7 seconds; never slice a sentence in the middle.
 */
function splitScriptTextCelebrity(script: string, wpm: number): Beat[] {
  const wps = Math.max(1, wpm) / 60;
  const minWords = Math.max(4, Math.ceil(4 * wps));
  const maxWords = Math.max(minWords + 1, Math.floor(7 * wps));
  const targetWords = Math.round((minWords + maxWords) / 2);

  const normalized = script.replace(/\r\n/g, "\n").trim();
  const paragraphs = normalized
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const sentences: string[] = [];
  for (const p of paragraphs) {
    sentences.push(...splitSentences(p));
  }

  const units: string[] = [];
  let buf: string[] = [];
  let bufWords = 0;

  const flush = () => {
    if (!buf.length) return;
    units.push(buf.join(" "));
    buf = [];
    bufWords = 0;
  };

  // Soft ceiling (~10s) for absorbing a trailing short line so we don't
  // leave punchy fragments as their own scene.
  const hardMaxWords = Math.max(maxWords + 1, Math.floor(10 * wps));

  for (const sentence of sentences) {
    const wc = wordCount(sentence);
    if (!wc) continue;

    // Oversized sentence stays intact as its own scene.
    if (wc > maxWords && bufWords === 0) {
      units.push(sentence);
      continue;
    }

    if (bufWords > 0 && bufWords + wc > maxWords) {
      // Prefer absorbing into the next sentence when the buffer is still short.
      if (!(bufWords < minWords && bufWords + wc <= hardMaxWords)) {
        flush();
      }
    }

    buf.push(sentence);
    bufWords += wc;

    // Flush when we reach a calm target, or a question that already feels complete.
    if (
      bufWords >= targetWords ||
      (bufWords >= minWords && /[?]$/.test(sentence.trim()))
    ) {
      flush();
    }
  }
  flush();

  const paced = rebalanceCelebrityUnits(units, minWords, hardMaxWords);

  return paced.map((text, i) => ({
    id: `b${i + 1}`,
    text,
  }));
}

/** Merge leftover short celebrity units into neighbors (never split). */
function rebalanceCelebrityUnits(
  units: string[],
  minWords: number,
  hardMaxWords: number,
): string[] {
  if (units.length < 2) return units;
  const out = [...units];
  let i = 0;
  while (i < out.length) {
    const wc = wordCount(out[i]);
    if (wc >= minWords) {
      i += 1;
      continue;
    }
    const prev = i > 0 ? out[i - 1] : null;
    const next = i + 1 < out.length ? out[i + 1] : null;
    const prevWc = prev ? wordCount(prev) : Infinity;
    const nextWc = next ? wordCount(next) : Infinity;

    const canPrev = prev && prevWc + wc <= hardMaxWords;
    const canNext = next && nextWc + wc <= hardMaxWords;

    if (canPrev && (!canNext || prevWc <= nextWc)) {
      out[i - 1] = `${prev} ${out[i]}`;
      out.splice(i, 1);
      continue;
    }
    if (canNext) {
      out[i] = `${out[i]} ${next}`;
      out.splice(i + 1, 1);
      continue;
    }
    i += 1;
  }
  return out;
}

function chunkLongText(text: string): string[] {
  const sentences = splitSentences(text);
  const out: string[] = [];
  let buf: string[] = [];
  let bufWords = 0;
  let wordsEmitted = 0;

  const flush = () => {
    if (!buf.length) return;
    out.push(buf.join(" "));
    wordsEmitted += bufWords;
    buf = [];
    bufWords = 0;
  };

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    if (!words.length) continue;

    // Short punch sentence in the fast-open window → own beat
    if (wordsEmitted < 100 && words.length <= 11 && bufWords === 0) {
      out.push(words.join(" "));
      wordsEmitted += words.length;
      continue;
    }

    let i = 0;
    while (i < words.length) {
      const inOpen = wordsEmitted + bufWords < 100;
      // Open: 2–4s cuts (~5–11 words). Body: ~13 words (~4.9s) → ~300 scenes / 24min.
      const target = inOpen ? 8 : 13;
      const max = inOpen ? 11 : 16;

      if (bufWords >= target) {
        flush();
        continue;
      }

      const room = max - bufWords;
      const take = Math.min(room, words.length - i);
      buf.push(...words.slice(i, i + take));
      bufWords += take;
      i += take;

      if (bufWords >= target) flush();
    }
  }
  flush();
  return out;
}

/**
 * After the fast-open window, merge short body lines toward ~12–14 words
 * so a ~24 min / 160 WPM script lands near ~300 scenes.
 * Never merge inside the first ~100 words.
 */
function rebalanceUnits(units: string[]): string[] {
  const out: string[] = [];
  let wordsSoFar = 0;

  for (const unit of units) {
    const wc = wordCount(unit);
    const prev = out[out.length - 1];
    const prevWc = prev ? wordCount(prev) : 0;
    const inOpen = wordsSoFar < 100;
    const canMergeBody =
      !inOpen &&
      prev &&
      prevWc + wc <= 15 &&
      prevWc < 13 &&
      !/[?]$/.test(prev.trim()); // keep questions punchy

    if (canMergeBody) {
      out[out.length - 1] = `${prev} ${unit}`;
      wordsSoFar += wc;
      continue;
    }

    out.push(unit);
    wordsSoFar += wc;
  }
  return out;
}

function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+(?=[A-Z“"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function estimateDurationMinutes(
  beats: Beat[],
  wpm = 160,
): number {
  const withTiming = beats.filter(
    (b) => typeof b.start === "number" && typeof b.end === "number",
  );
  if (withTiming.length) {
    const start = Math.min(...withTiming.map((b) => b.start!));
    const end = Math.max(...withTiming.map((b) => b.end!));
    return Math.max(0.5, (end - start) / 60);
  }
  const words = beats.reduce(
    (n, b) => n + b.text.split(/\s+/).filter(Boolean).length,
    0,
  );
  return Math.max(0.5, words / Math.max(1, wpm));
}
