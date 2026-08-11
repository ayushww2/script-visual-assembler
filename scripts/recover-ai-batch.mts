/**
 * Recover a failed ai-only job from a completed OpenAI Batch output.
 * Streams JSONL (never one giant string), uploads each PNG to R2, packages.
 *
 *   DATABASE_URL=... OPENAI_IMAGE_API_KEY=... R2_*=... \
 *   npx tsx scripts/recover-ai-batch.mts --job <id>
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import type { SceneRecord } from "../src/lib/jobs/scenes";
import { generateMissingAiStills } from "../src/lib/jobs/aiStills";
import { repackageJob } from "../src/lib/package/repackage";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

async function main() {
  const jobId = arg("job");
  if (!jobId) throw new Error("Missing --job");

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");
  if (!job.scenesJson) throw new Error("Job has no scenesJson");
  if (!job.aiBatchId) throw new Error("Job has no aiBatchId to recover");

  const scenes = job.scenesJson as unknown as SceneRecord[];
  const missing = scenes.filter((s) => !s.imageUrl?.trim()).length;
  console.log(
    JSON.stringify(
      {
        id: job.id,
        title: job.title,
        status: job.status,
        phase: job.phase,
        aiBatch: job.aiBatch,
        aiBatchId: job.aiBatchId,
        scenes: scenes.length,
        missing,
      },
      null,
      2,
    ),
  );

  if (missing === 0) {
    console.log("Nothing missing — repackaging only");
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "running",
        error: null,
        progress: "All stills present — packaging…",
      },
    });
    await repackageJob(jobId);
    return;
  }

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "running",
      error: null,
      packageReady: false,
      packageUrl: null,
      packageError: null,
      completedAt: null,
      progress: `Recovering AI Batch ${job.aiBatchId} · ${missing} missing…`,
      aiBatch: true,
      aiBatchId: job.aiBatchId,
    },
  });

  const next = await generateMissingAiStills({
    jobId: job.id,
    title: job.title,
    niche: job.niche,
    scenes,
    useBatch: true,
    existingBatchId: job.aiBatchId,
    onProgress: async (message) => {
      console.log(message);
      await prisma.job.update({
        where: { id: jobId },
        data: { progress: message },
      });
    },
    onScenesPersist: async (snap) => {
      const have = snap.filter((s) => s.imageUrl?.trim()).length;
      await prisma.job.update({
        where: { id: jobId },
        data: {
          scenesJson: snap as unknown as Prisma.InputJsonValue,
          sceneCount: snap.length,
          aiCount: have,
          progress: `Recovered ${have}/${snap.length} AI stills to R2…`,
        },
      });
    },
    onBatchCreated: async (batchId) => {
      await prisma.job.update({
        where: { id: jobId },
        data: { aiBatchId: batchId },
      });
    },
  });

  const have = next.filter((s) => s.imageUrl?.trim()).length;
  console.log(`Attached ${have}/${next.length} stills`);

  await prisma.job.update({
    where: { id: jobId },
    data: {
      scenesJson: next as unknown as Prisma.InputJsonValue,
      sceneCount: next.length,
      aiCount: have,
      googleCount: 0,
      progress: `Recovered ${have}/${next.length} — packaging…`,
    },
  });

  if (have === 0) {
    throw new Error("Recovery produced 0 stills — not packaging");
  }

  await repackageJob(jobId);

  const fresh = await prisma.job.findUnique({ where: { id: jobId } });
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: fresh?.packageReady ? "completed" : "failed",
      error: fresh?.packageReady
        ? null
        : fresh?.packageError || "Package not ready after recovery",
      completedAt: new Date(),
      progress: fresh?.progress || "Recovery finished",
    },
  });

  console.log(
    JSON.stringify(
      {
        status: fresh?.packageReady ? "completed" : "failed",
        packageUrl: fresh?.packageUrl,
        progress: fresh?.progress,
        have,
      },
      null,
      2,
    ),
  );
}

main()
  .catch(async (err) => {
    console.error(err);
    const jobId = arg("job");
    if (jobId) {
      await prisma.job
        .update({
          where: { id: jobId },
          data: {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            progress: "Recovery failed",
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
    }
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
