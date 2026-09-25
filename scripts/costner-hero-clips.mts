/**
 * Standalone runner: Kevin Costner script → unique ~4s YouTube timestamp suggestions.
 * Uses ContactBox (when configured) for hero planning + clip QA.
 * No video download — watch URLs + start/end only.
 *
 * Usage:
 *   CONTACTBOX_API_KEY=... npx tsx scripts/costner-hero-clips.mts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { buildHeroYouTubeClipSuggestions } from "../src/lib/search/youtubeHeroClips";

const TITLE =
  "At 71, Kevin Costner had already survived one of Hollywood’s most painful divorces.";

const LINES = [
  "At 71, Kevin Costner had already survived one of Hollywood’s most painful divorces.",
  "Afterward, he became unusually private about the life he was quietly rebuilding.",
  "For months, almost nothing escaped about what was happening behind closed doors.",
  "His attention stayed focused on his children, his films, and one enormous gamble.",
  "Away from major premieres, something inside Costner’s private world quietly began changing.",
  "A famous woman appeared first, immediately pulling attention toward his romantic life.",
  "Costner then addressed that connection using unusually direct words of his own.",
  "Soon afterward, another woman entered his world through a completely different circle.",
  "Months later, a third name started appearing around Costner with remarkable consistency.",
  "These appearances happened in places connected closely to Costner’s everyday private life.",
  "One appearance could have been dismissed as nothing more than simple coincidence.",
  "Then another sighting happened, followed quietly by yet another unexpected public appearance.",
  "Different months passed, and different cities suddenly became part of the pattern.",
  "But through every appearance, the same name kept quietly following Costner’s movements.",
  "Then photographs placed Costner beside another woman just days before everything shifted.",
  "Suddenly, the question was no longer whether he had reopened his heart.",
  "Costner had already answered that question himself through words nobody expected publicly.",
  "The real mystery became who had finally managed to reach that heart.",
];

async function main() {
  console.log("Hero clip planner ·", LINES.length, "lines · ~4s each");
  const result = await buildHeroYouTubeClipSuggestions({
    title: TITLE,
    lines: LINES,
    onProgress: (msg) => console.log("·", msg),
  });

  const rows = result.picks.map((p) => {
    if (!p.useVideo) {
      return {
        line: p.index,
        mode: "images-only",
        words: p.words,
        reason: p.reason,
      };
    }
    if (!p.clip) {
      return {
        line: p.index,
        mode: "video-miss",
        words: p.words,
        visualHint: p.visualHint,
        aiVerdict: p.aiVerdict,
        note: p.note,
      };
    }
    const c = p.clip;
    return {
      line: p.index,
      mode: "video",
      words: p.words,
      visualHint: p.visualHint,
      aiVerdict: p.aiVerdict,
      startSec: c.startSec,
      endSec: c.endSec,
      durationSec: c.durationSec,
      videoTitle: c.title,
      channel: c.channelTitle,
      watchAtUrl: c.watchAtUrl,
      watchUrl: c.watchUrl,
      videoId: c.videoId,
    };
  });

  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  const outPath = "/opt/cursor/artifacts/costner-hero-clips.json";
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        title: TITLE,
        heroName: result.plan.heroName,
        aliases: result.plan.aliases,
        videoLineCount: result.videoLineCount,
        imageOnlyCount: result.imageOnlyCount,
        picks: rows,
      },
      null,
      2,
    ),
  );

  console.log("\n=== HERO ===", result.plan.heroName);
  console.log(
    `video lines: ${result.videoLineCount} · images-only: ${result.imageOnlyCount}`,
  );
  console.log("\n=== TIMESTAMPS ===\n");
  for (const row of rows) {
    if (row.mode === "images-only") {
      console.log(
        `L${row.line} [IMAGES] ${row.words.slice(0, 70)}…\n  → ${row.reason}\n`,
      );
      continue;
    }
    if (row.mode === "video-miss") {
      console.log(
        `L${row.line} [NO CLIP] ${row.words.slice(0, 70)}…\n  → ${row.note || row.aiVerdict}\n`,
      );
      continue;
    }
    console.log(
      `L${row.line} [${row.startSec}s–${row.endSec}s] ${row.words.slice(0, 70)}…\n  ${row.watchAtUrl}\n  ${row.videoTitle} · ${row.aiVerdict || ""}\n`,
    );
  }
  console.log("Wrote", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
