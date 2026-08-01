import { countWords } from "@/lib/niches";
import { DEFAULT_PACKAGE_WPM } from "./schema";

export type TimedChunk = {
  words: string;
  wordCount: number;
  startSec: number;
  endSec: number;
  durationSec: number;
};

/** Fixed VO timing: sequential, no gaps/overlaps. Mystery default 160 WPM. */
export function timeChunksAtWpm(
  chunks: string[],
  wpm = DEFAULT_PACKAGE_WPM,
  voDurationSec?: number | null,
): TimedChunk[] {
  const wps = wpm / 60;
  let cursor = 0;
  const timed = chunks.map((words) => {
    const wordCount = countWords(words);
    const durationSec = wordCount > 0 ? wordCount / wps : 0.1;
    const startSec = cursor;
    const endSec = startSec + durationSec;
    cursor = endSec;
    return {
      words: words.trim(),
      wordCount: Math.max(1, wordCount),
      startSec,
      endSec,
      durationSec,
    };
  });

  if (!voDurationSec || voDurationSec <= 0 || cursor <= 0) {
    return timed.map(roundTimed);
  }

  const scale = voDurationSec / cursor;
  return timed
    .map((t) => ({
      ...t,
      startSec: t.startSec * scale,
      endSec: t.endSec * scale,
      durationSec: t.durationSec * scale,
    }))
    .map(roundTimed);
}

function roundTimed(t: TimedChunk): TimedChunk {
  return {
    ...t,
    startSec: round3(t.startSec),
    endSec: round3(t.endSec),
    durationSec: round3(t.durationSec),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
