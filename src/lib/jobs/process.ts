import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runScriptDivider } from "@/lib/divider/run";
import { pickBestGoogleHit, searchGoogleImages } from "@/lib/search/google";
import {
  GOOGLE_SEARCH_CONCURRENCY,
  MAX_CONCURRENT_JOBS,
  PREVIEW_IMAGES_PER_QUERY,
} from "@/lib/jobs/limits";
import type { GoogleSearchPreview } from "@/lib/search/google";
import { resolveGoogleSubject } from "@/lib/search/resolveSubject";
import { buildScenes, type SceneRecord } from "@/lib/jobs/scenes";
import { generateMissingAiStills } from "@/lib/jobs/aiStills";
import { balanceGoogleAiScenes, countSources } from "@/lib/jobs/balance";
import { repairBadGoogleScenes } from "@/lib/jobs/repairGoogle";
import {
  isMisplacedAiScene,
  repairMisplacedAiToGoogle,
} from "@/lib/jobs/repairGoogleFirst";
import {
  isChairClicheAiScene,
  isWrongChairPersonSwap,
  repairChairClicheAiScenes,
} from "@/lib/jobs/repairAiCliche";
import { reviewAndRepickFromSameSearch } from "@/lib/jobs/reviewGoogle";
import {
  mapPartsParallel,
  PARALLEL_PARTS,
} from "@/lib/jobs/parallelParts";
import { mapPool } from "@/lib/jobs/pool";
import { isBadGoogleScenePick } from "@/lib/search/google";
import {
  buildAndUploadRenderPackage,
  HandoverPackagerError,
} from "@/lib/package/handover";
import { getNiche } from "@/lib/niches";

/** In-flight job ids — allow MAX_CONCURRENT_JOBS parallel scripts. */
const activeJobs = new Set<string>();

export async function processJob(jobId: string): Promise<void> {
  console.log("[jobs] processJob enter", jobId);
  if (activeJobs.has(jobId)) {
    console.log("[jobs] processJob already active", jobId);
    return;
  }
  activeJobs.add(jobId);
  try {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      console.warn("[jobs] processJob missing", jobId);
      return;
    }
    if (job.status === "completed" || job.status === "failed") {
      console.log("[jobs] processJob skip terminal", jobId, job.status);
      return;
    }

    console.log("[jobs] processJob running", jobId, "was", job.status);

    try {
      const niche = getNiche(job.niche);
      const onProgress = async (message: string) => {
        await prisma.job.update({
          where: { id: jobId },
          data: { progress: message },
        });
      };

      // Resume when scenes already built (e.g. AI rate-limit mid-job).
      if (
        job.previewDone &&
        Array.isArray(job.scenesJson) &&
        (job.scenesJson as unknown[]).length > 0
      ) {
        let scenes = job.scenesJson as unknown as SceneRecord[];
        const allAi = job.phase === "ai-only";
        const dirtyGoogle = allAi
          ? 0
          : scenes.filter((s) => isBadGoogleScenePick(s)).length;
        const misplacedAi = allAi
          ? 0
          : scenes.filter((s) => isMisplacedAiScene(s)).length;
        const chairCliche = allAi
          ? 0
          : scenes.filter(
              (s) => isChairClicheAiScene(s) || isWrongChairPersonSwap(s),
            ).length;
        const missing = scenes.filter((s) => !s.imageUrl?.trim()).length;

        await prisma.job.update({
          where: { id: jobId },
          data: {
            status: "running",
            startedAt: job.startedAt ?? new Date(),
            error: null,
            packageReady: false,
            packageUrl: null,
            packageError: null,
            // Keep batch id so a completed OpenAI batch can be re-downloaded
            aiBatchId: job.aiBatchId,
            progress:
              dirtyGoogle > 0 || misplacedAi > 0 || chairCliche > 0
                ? `Repair sources · ${dirtyGoogle} dirty Google · ${misplacedAi} AI→Google · ${chairCliche} chair cliché · then ${missing} AI…`
                : job.aiBatch
                  ? `Resuming AI Batch${job.aiBatchId ? ` ${job.aiBatchId}` : ""}…`
                  : `Resuming AI stills · ${missing} remaining…`,
          },
        });

        // ONLY replace dirty Google picks (wrong person / logo / watermark).
        // Skipped for ai-only jobs.
        if (dirtyGoogle > 0) {
          const repaired = await repairBadGoogleScenes({
            scenes,
            onProgress,
          });
          scenes = repaired.scenes;
          await prisma.job.update({
            where: { id: jobId },
            data: {
              scenesJson: scenes as unknown as Prisma.InputJsonValue,
              progress: `Google repair · fixed ${repaired.repaired}/${dirtyGoogle}`,
            },
          });
        }

        // Photographable AI (tombs/sites/etc.) → real Google photos
        if (misplacedAi > 0) {
          const converted = await repairMisplacedAiToGoogle({
            scenes,
            title: job.title,
            onProgress,
          });
          scenes = converted.scenes;
          const counts = countSources(scenes);
          await prisma.job.update({
            where: { id: jobId },
            data: {
              scenesJson: scenes as unknown as Prisma.InputJsonValue,
              googleCount: counts.google,
              aiCount: counts.ai,
              progress: `Google-first · converted ${converted.repaired}/${misplacedAi} AI→Google`,
            },
          });
        }

        // Kill empty-chair / vacant-interview AI clichés
        if (chairCliche > 0) {
          const chairs = await repairChairClicheAiScenes({
            scenes,
            title: job.title,
            onProgress,
          });
          scenes = chairs.scenes;
          const counts = countSources(scenes);
          await prisma.job.update({
            where: { id: jobId },
            data: {
              scenesJson: scenes as unknown as Prisma.InputJsonValue,
              googleCount: counts.google,
              aiCount: counts.ai,
              progress: `Chair-cliché · replaced ${chairs.repaired}/${chairCliche}`,
            },
          });
        }

        scenes = await generateMissingAiStills({
          jobId: job.id,
          title: job.title,
          niche: job.niche,
          scenes,
          onProgress,
          onScenesPersist: async (next) => {
            await prisma.job.update({
              where: { id: jobId },
              data: {
                scenesJson: next as unknown as Prisma.InputJsonValue,
                sceneCount: next.length,
              },
            });
          },
          parts: PARALLEL_PARTS,
          useBatch: Boolean(job.aiBatch) || allAi,
          existingBatchId: job.aiBatchId,
          onBatchCreated: async (batchId) => {
            await prisma.job.update({
              where: { id: jobId },
              data: { aiBatchId: batchId },
            });
          },
        });

        await finishPackage({
          jobId,
          job,
          scenes,
          nicheWpm: niche.wpm,
          onProgress,
        });
        return;
      }

      const allAi = job.phase === "ai-only";
      const googleOnly =
        job.phase === "google-only" || niche.id === "celebrity";

      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "running",
          startedAt: job.startedAt ?? new Date(),
          progress: allAi
            ? "All-AI mode — building scene list…"
            : googleOnly
              ? "Celebrity Google-only — building entity packs…"
              : "Reading script and building Google packs…",
          error: null,
          packageReady: false,
          packageUrl: null,
          packageError: null,
          aiBatchId: null,
          ...(googleOnly && !allAi ? { phase: "google-only" } : {}),
        },
      });

      const divided = await runScriptDivider({
        script: job.script,
        phase: allAi
          ? "ai-only"
          : googleOnly
            ? "google-only"
            : (job.phase as "google-first" | "full" | "ai-only" | "google-only") ||
              "google-first",
        niche: job.niche,
      });

      await prisma.job.update({
        where: { id: jobId },
        data: {
          beatCount: divided.beats.length,
          googleCount: divided.result.googleSearches.length,
          aiCount: divided.result.aiGenerate.length,
          model: divided.model,
          beatsJson: divided.beats as unknown as Prisma.InputJsonValue,
          resultJson: divided.result as unknown as Prisma.InputJsonValue,
          usageJson: (divided.usage ??
            undefined) as unknown as Prisma.InputJsonValue | undefined,
          progress: allAi
            ? `All-AI · ${divided.beats.length} scenes → gpt-image-2…`
            : `Previewing ${divided.result.googleSearches.length} Google queries…`,
        },
      });

      const previews: Record<string, GoogleSearchPreview> = {};
      const packs = divided.result.googleSearches
        .slice()
        .sort((a, b) => b.priority - a.priority);

      if (packs.length > 0) {
        // Split Google packs into PARALLEL_PARTS and run every part at once.
        const googleParts = PARALLEL_PARTS;
        const googlePerPart = Math.max(
          1,
          Math.ceil(GOOGLE_SEARCH_CONCURRENCY / googleParts),
        );
        let googleDone = 0;
        let googleProgressAt = 0;

        await prisma.job.update({
          where: { id: jobId },
          data: {
            progress: `Google ×${googleParts} parts · ${packs.length} queries…`,
          },
        });

        await mapPartsParallel(
          packs,
          googleParts,
          async (shard, partIndex, partCount) => {
            await mapPool(shard, googlePerPart, async (pack) => {
              try {
                const subj = resolveGoogleSubject(
                  pack.query,
                  pack.entityContext,
                );
                previews[pack.query] = await searchGoogleImages(
                  pack.query,
                  PREVIEW_IMAGES_PER_QUERY,
                  {
                    personName: subj.personName,
                    placeName: subj.placeName,
                  },
                );
              } catch (err) {
                previews[pack.query] = {
                  query: pack.query,
                  provider: "searchapi_google_images",
                  results: [],
                  filteredOut: 0,
                  error: err instanceof Error ? err.message : "Search failed",
                };
              }
              googleDone += 1;
              const now = Date.now();
              if (
                googleDone === packs.length ||
                googleDone === 1 ||
                now - googleProgressAt >= 2_000
              ) {
                googleProgressAt = now;
                await prisma.job.update({
                  where: { id: jobId },
                  data: {
                    progress: `Google ×${partCount} parts · ${googleDone}/${packs.length} (part ${partIndex + 1})…`,
                  },
                });
              }
            });
          },
        );
      }

      let scenes = buildScenes({
        beats: divided.beats,
        result: divided.result,
        previews,
        niche: job.niche,
        voiceoverDurationSec: job.voiceoverDurationSec,
      });

      // Keep all successful Google stills — no forced mix %. AI fills misses only
      // (except google-only / celebrity, which reuses nearby Google stills).
      scenes = balanceGoogleAiScenes(scenes, { googleOnly });

      // Bad Google still → next image from SAME search (no new query)
      const reviewed = reviewAndRepickFromSameSearch({ scenes, previews });
      scenes = reviewed.scenes;
      if (reviewed.repaired > 0) {
        await onProgress(
          `Reviewed Google picks · swapped ${reviewed.repaired} from same search…`,
        );
      }

      if (googleOnly) {
        scenes = balanceGoogleAiScenes(scenes, { googleOnly: true });
      }

      const mix = countSources(scenes);
      const googleQueries = divided.result.googleSearches.length;

      await prisma.job.update({
        where: { id: jobId },
        data: {
          previewsJson: previews as unknown as Prisma.InputJsonValue,
          scenesJson: scenes as unknown as Prisma.InputJsonValue,
          sceneCount: scenes.length,
          googleCount: googleQueries,
          aiCount: googleOnly ? 0 : mix.ai,
          previewDone: true,
          progress: googleOnly
            ? `Scenes ${scenes.length} · ${googleQueries} Google queries · 0 AI (google-only)…`
            : job.aiBatch
              ? `Scenes ${scenes.length} · ${googleQueries} Google queries · ${mix.ai} AI — Batch…`
              : `Scenes ${scenes.length} · ${googleQueries} Google queries · ${mix.ai} AI…`,
        },
      });

      if (!googleOnly) {
        scenes = await generateMissingAiStills({
          jobId: job.id,
          title: job.title,
          niche: job.niche,
          scenes,
          onProgress,
          onScenesPersist: async (next) => {
            await prisma.job.update({
              where: { id: jobId },
              data: {
                scenesJson: next as unknown as Prisma.InputJsonValue,
                sceneCount: next.length,
              },
            });
          },
          parts: PARALLEL_PARTS,
          useBatch: Boolean(job.aiBatch),
          existingBatchId: job.aiBatchId,
          onBatchCreated: async (batchId) => {
            await prisma.job.update({
              where: { id: jobId },
              data: { aiBatchId: batchId },
            });
          },
        });
      }

      const finalMix = googleOnly
        ? { google: scenes.filter((s) => s.imageUrl).length, ai: 0 }
        : countSources(scenes);
      await prisma.job.update({
        where: { id: jobId },
        data: {
          googleCount: googleQueries,
          aiCount: finalMix.ai,
          scenesJson: scenes as unknown as Prisma.InputJsonValue,
          sceneCount: scenes.length,
        },
      });

      await finishPackage({
        jobId,
        job,
        scenes,
        nicheWpm: niche.wpm,
        onProgress,
        googleQueries,
        aiStills: finalMix.ai,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Job failed";
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "failed",
          error: message,
          progress: "Failed",
          completedAt: new Date(),
        },
      });
    }
  } finally {
    activeJobs.delete(jobId);
  }
}

/** Re-select Google hits from saved previews with stricter clean/person rules. */
function repickGoogleScenes(
  scenes: SceneRecord[],
  previews: Record<string, GoogleSearchPreview>,
): SceneRecord[] {
  const used = new Set<string>();
  return scenes.map((scene) => {
    if (scene.visualSource !== "google" || !scene.query) return scene;
    const preview = previews[scene.query];
    if (!preview) return scene;
    const { personName, placeName } = resolveGoogleSubject(
      scene.words,
      scene.query,
      scene.subject,
      scene.entityContext,
    );
    const hit = pickBestGoogleHit(preview, {
      usedUrls: used,
      personName,
      placeName,
    });
    if (!hit?.imageUrl) {
      // Drop dirty Google miss → AI will fill
      return {
        ...scene,
        imageUrl: null,
        thumbnailUrl: null,
        sourceUrl: null,
        sourceDomain: null,
        visualSource: "ai" as const,
        why: scene.why || "Google pick rejected (logo/text/watermark)",
      };
    }
    used.add(hit.imageUrl);
    return {
      ...scene,
      imageUrl: hit.imageUrl,
      thumbnailUrl: hit.thumbnailUrl || hit.imageUrl,
      sourceUrl: hit.sourcePageUrl || null,
      sourceDomain: hit.sourceDomain || null,
      subject: placeName || personName || scene.subject,
      why: placeName
        ? `${scene.why || "Google"} · place only (no people): ${placeName}`
        : personName
          ? `${scene.why || "Google"} · single-person: ${personName}`
          : scene.why,
    };
  });
}

async function finishPackage(input: {
  jobId: string;
  job: {
    id: string;
    title: string | null;
    voiceoverUrl: string | null;
    voiceoverDurationSec: number | null;
    createdAt: Date;
  };
  scenes: Awaited<ReturnType<typeof buildScenes>>;
  nicheWpm: number;
  onProgress: (message: string) => Promise<void>;
  googleQueries?: number;
  aiStills?: number;
}): Promise<void> {
  let scenes = input.scenes;
  const mix = countSources(scenes);
  const googleQueries = input.googleQueries ?? mix.google;
  const aiStills = input.aiStills ?? mix.ai;

  await prisma.job.update({
    where: { id: input.jobId },
    data: {
      scenesJson: scenes as unknown as Prisma.InputJsonValue,
      sceneCount: scenes.length,
      googleCount: googleQueries,
      aiCount: aiStills,
      progress: "Building Remotion render package…",
    },
  });

  try {
    const handover = await buildAndUploadRenderPackage({
      jobId: input.job.id,
      title: input.job.title,
      nicheWpm: input.nicheWpm,
      scenes,
      voiceoverUrl: input.job.voiceoverUrl,
      voiceoverDurationSec: input.job.voiceoverDurationSec,
      imagesOnly: true,
      createdAt: input.job.createdAt,
      onProgress: input.onProgress,
    });

    scenes = handover.scenes;

    await prisma.job.update({
      where: { id: input.jobId },
      data: {
        status: "completed",
        scenesJson: scenes as unknown as Prisma.InputJsonValue,
        sceneCount: scenes.length,
        googleCount: googleQueries,
        aiCount: aiStills,
        packageReady: true,
        packageUrl: handover.packageUrl,
        packageJson: handover.packageJson as unknown as Prisma.InputJsonValue,
        packageError: null,
        imagesOnly: handover.imagesOnly,
        voiceoverDurationSec: handover.voiceoverDurationSec,
        progress: `Package ready · ${handover.packageJson.scenes.length} scenes · ${googleQueries} Google queries · ${aiStills} AI · vo=${handover.voiceoverDurationSec.toFixed(1)}s`,
        completedAt: new Date(),
      },
    });
  } catch (packErr) {
    const issues =
      packErr instanceof HandoverPackagerError ? packErr.issues : [];
    const message =
      packErr instanceof Error ? packErr.message : "Render package failed";
    const detail = issues.length
      ? `${message}: ${issues.slice(0, 6).join("; ")}`
      : message;

    await prisma.job.update({
      where: { id: input.jobId },
      data: {
        status: "completed",
        scenesJson: scenes as unknown as Prisma.InputJsonValue,
        sceneCount: scenes.length,
        packageReady: false,
        packageUrl: null,
        packageError: detail,
        progress: "Done (package not ready)",
        completedAt: new Date(),
      },
    });
  }
}

/** Recover jobs stuck queued/running after a deploy restart. */
export async function resumePendingJobs(): Promise<void> {
  const pending = await prisma.job.findMany({
    where: { status: { in: ["queued", "running"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
    take: 10,
  });

  if (pending.length === 0) return;
  console.log(
    "[jobs] resumePendingJobs",
    pending.map((j) => j.id).join(","),
  );

  // Resume up to concurrency limit in parallel
  const chunk = pending.slice(0, MAX_CONCURRENT_JOBS);
  await Promise.all(chunk.map((j) => processJob(j.id)));
}

const WORKER_IDLE_MS = 2_500;

/** Long-lived loop — runs up to MAX_CONCURRENT_JOBS scripts at once. */
export async function runJobWorkerLoop(): Promise<void> {
  console.log(
    "[jobs] worker loop online · concurrency=",
    MAX_CONCURRENT_JOBS,
  );
  for (;;) {
    try {
      const slots = MAX_CONCURRENT_JOBS - activeJobs.size;
      if (slots <= 0) {
        await new Promise((r) => setTimeout(r, WORKER_IDLE_MS));
        continue;
      }

      const candidates = await prisma.job.findMany({
        where: { status: { in: ["queued", "running"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, progress: true },
        take: MAX_CONCURRENT_JOBS + activeJobs.size,
      });
      const toStart = candidates
        .filter((j) => !activeJobs.has(j.id))
        .slice(0, slots);

      if (!toStart.length) {
        await new Promise((r) => setTimeout(r, WORKER_IDLE_MS));
        continue;
      }

      for (const job of toStart) {
        console.log(
          "[jobs] worker claim",
          job.id,
          job.status,
          `active=${activeJobs.size + 1}/${MAX_CONCURRENT_JOBS}`,
          job.progress,
        );
        // Fire-and-track; loop keeps claiming until concurrency full
        void processJob(job.id).catch((error) => {
          console.error("[jobs] processJob crashed", job.id, error);
        });
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (error) {
      console.error("[jobs] worker iteration failed", error);
      await new Promise((r) => setTimeout(r, WORKER_IDLE_MS));
    }
  }
}
