/**
 * ContactBox vision QA — scan every scene still against narration words.
 *
 * Local (needs CONTACTBOX_API_KEY):
 *   npx tsx scripts/scan-scenes.mts --job cmsauu2n90000o52u22p6djng
 *
 * Production fetch (no DB):
 *   npx tsx scripts/scan-scenes.mts --job <id> --base https://script-assembler.up.railway.app
 *
 * Railway (uses prod secrets):
 *   railway run --service script-assembler npx tsx scripts/scan-scenes.mts --job <id>
 */
import { writeFileSync } from "fs";
import { scanAllScenes, type SceneScanInput } from "../src/lib/jobs/sceneScan";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

async function fetchScenes(
  jobId: string,
  base: string,
): Promise<{ title: string; scenes: SceneScanInput[] }> {
  const res = await fetch(`${base.replace(/\/$/, "")}/api/jobs/${jobId}`);
  if (!res.ok) throw new Error(`Job fetch ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    job?: {
      title?: string;
      scenes?: Array<{
        sceneId?: string;
        index?: number;
        words?: string;
        scriptText?: string;
        imageUrl?: string;
        visualSource?: string;
        subject?: string;
        query?: string;
      }>;
    };
  };
  const job = data.job;
  if (!job?.scenes?.length) throw new Error("Job has no scenes");

  const scenes: SceneScanInput[] = job.scenes.map((s, i) => ({
    sceneId: s.sceneId || String(s.index ?? i + 1),
    index: s.index ?? i + 1,
    words: (s.words || s.scriptText || "").trim(),
    imageUrl: s.imageUrl || "",
    visualSource: s.visualSource,
    subject: s.subject,
    query: s.query,
  }));

  return { title: job.title || jobId, scenes };
}

async function main() {
  const jobId = arg("job");
  if (!jobId) throw new Error("Missing --job");

  const base =
    arg("base", process.env.SCAN_BASE_URL || "https://script-assembler.up.railway.app")!;
  const batchSize = Number(arg("batch", "15")) || 15;
  const out = arg("out", `/tmp/scan-${jobId}.json`)!;

  console.log(`Fetching job ${jobId} from ${base}…`);
  const { title, scenes } = await fetchScenes(jobId, base);
  const withImages = scenes.filter((s) => s.imageUrl && s.words);
  console.log(`Title: ${title}`);
  console.log(`Scenes: ${scenes.length} (${withImages.length} with image+words)`);

  console.log(`Scanning with ContactBox vision (batch=${batchSize})…`);
  const result = await scanAllScenes(withImages, { batchSize, concurrency: 2 });

  const payload = {
    jobId,
    title,
    scannedAt: new Date().toISOString(),
    ...result,
  };

  writeFileSync(out, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${out}`);
  console.log(
    JSON.stringify(
      {
        scanned: result.scanned,
        ok: result.ok,
        critical: result.critical,
        minor: result.minor,
        issues: result.issues.length,
        usage: result.usage,
        costUsd: result.costUsd.toFixed(4),
        model: result.model,
        batches: result.batches,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
