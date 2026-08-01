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

  const units =
    paragraphs.length > 1
      ? paragraphs
      : splitSentences(normalized);

  return units.map((text, i) => ({
    id: `b${i + 1}`,
    text,
  }));
}

function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+(?=[A-Z“"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
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
  // Niche VO rate (Mystery = 160 WPM) when Whisper timestamps are absent
  return Math.max(0.5, words / Math.max(1, wpm));
}
