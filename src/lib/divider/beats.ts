import type { Beat } from "./schema";

type WhisperSegment = {
  id?: string | number;
  text?: string;
  start?: number;
  end?: number;
};

/**
 * Accepts:
 * - plain script text
 * - Whisper-style JSON: { segments: [{ id, text, start, end }] }
 * - raw JSON array of segments
 *
 * Plain script pacing (160 WPM):
 * - First ~100 words: fast cuts (≈2–4s → ~5–11 words), keep short punch lines alone
 * - Rest: target ~11 words (~4.1s), clamp 8–15 when merging
 */
export function parseBeats(input: string): Beat[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const fromJson = tryParseWhisper(trimmed);
  if (fromJson) return fromJson;

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
