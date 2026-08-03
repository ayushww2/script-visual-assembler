/**
 * Re-search every celebrity scene with 1 unique Google query + best photo.
 *
 *   railway run --service script-assembler npx tsx scripts/repair-celebrity-unique.mts --job <id>
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import type { SceneRecord } from "../src/lib/jobs/scenes";
import { repairCelebrityUniqueScenes } from "../src/lib/jobs/repairCelebrityUnique";
import { repackageJob } from "../src/lib/package/repackage";
import { isBadGoogleScenePick } from "../src/lib/search/google";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

async function main() {
  const jobId = arg("job");
  if (!jobId) throw new Error("Missing --job");

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job?.scenesJson) throw new Error("Job not found or has no scenes");

  const scenes = job.scenesJson as unknown as SceneRecord[];
  console.log(`Job ${jobId} · ${scenes.length} scenes · niche=${job.niche}`);

  await prisma.job.update({
    where: { id: jobId },
    data: {
      progress: "Celebrity unique repair — 1 Google query per scene…",
      packageReady: false,
      packageError: null,
    },
  });

  const result = await repairCelebrityUniqueScenes({
    scenes,
    concurrency: 6,
    allScenes: true,
    onProgress: async (message) => {
      console.log(message);
      await prisma.job.update({
        where: { id: jobId },
        data: { progress: message },
      });
    },
  });

  const urls = result.scenes.map((s) => s.imageUrl).filter(Boolean) as string[];
  const unique = new Set(urls).size;
  const bad = result.scenes.filter((s) => isBadGoogleScenePick(s)).length;
  const queries = new Set(
    result.scenes.map((s) => (s.query || "").trim().toLowerCase()).filter(Boolean),
  ).size;

  console.log(
    JSON.stringify(
      {
        repaired: result.repaired,
        failed: result.failed,
        scenes: result.scenes.length,
        uniqueImages: unique,
        uniqueQueries: queries,
        stillBad: bad,
      },
      null,
      2,
    ),
  );

  await prisma.job.update({
    where: { id: jobId },
    data: {
      scenesJson: result.scenes as unknown as Prisma.InputJsonValue,
      sceneCount: result.scenes.length,
      googleCount: queries,
      aiCount: 0,
      progress: `Celebrity unique repair done · ${unique} unique images · repackaging…`,
    },
  });

  await repackageJob(jobId);
  const fresh = await prisma.job.findUnique({ where: { id: jobId } });
  console.log("packageUrl", fresh?.packageUrl);
  console.log("progress", fresh?.progress);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
