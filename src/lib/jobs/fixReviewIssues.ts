import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { SceneRecord } from "@/lib/jobs/scenes";
import type { MajorIssue } from "@/lib/jobs/finalReview";
import { countSources } from "@/lib/jobs/balance";
import { mapPool } from "@/lib/jobs/pool";
import {
  pickBestGoogleHit,
  searchGoogleImages,
  type GoogleImageHit,
  type GoogleSearchPreview,
} from "@/lib/search/google";
import { resolveGoogleSubject } from "@/lib/search/resolveSubject";
import { repackageJob } from "@/lib/package/repackage";

/**
 * Hard ceiling — one "Fix issues" click never spends more than this many
 * fresh Google searches, no matter how many issues the review found.
 * Multiple scenes sharing the same suggested query share one search.
 */
export const MAX_ISSUE_FIXER_GOOGLE_QUERIES = 100;
const GOOGLE_FIX_CONCURRENCY = 6;

export type IssueFixerProgress = (message: string) => Promise<void> | void;

export type IssueFixerResult = {
  attempted: number;
  fixedGoogle: number;
  fixedRepick: number;
  failed: number;
  queriesUsed: number;
  skippedQueryCap: number;
  fixedIndexes: number[];
  skippedIndexes: number[];
  failedIndexes: number[];
  packageReady: boolean;
  packageUrl: string | null;
};

type LastFix = IssueFixerResult & { at: string };

/**
 * Descriptor suffixes stripped off a suggested query to find its broader
 * "core subject" — e.g. "kathu townlands stone tools", "kathu townlands
 * excavation", and "kathu townlands landscape" all collapse to "kathu
 * townlands". Narrow multi-word variants of one real-world subject rarely
 * have enough distinct stock photography to each succeed on their own;
 * searching the shared core once finds a photo far more reliably and lets
 * every scene about that subject reuse it.
 */
const QUERY_QUALIFIER_SUFFIXES = [
  "excavation site",
  "archaeological site",
  "excavation",
  "archaeology",
  "archaeologist",
  "stone tools",
  "spear points",
  "artifacts",
  "stratigraphy",
  "development",
  "landscape",
  "interior",
  "exterior",
  "aerial",
  "portrait",
  "discovery",
  "researcher",
  "professor",
  "scientist",
  "tools",
  "site",
  "photo",
  "photograph",
].sort((a, b) => b.length - a.length);

function coreSubjectKey(query: string): string {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  for (const suffix of QUERY_QUALIFIER_SUFFIXES) {
    if (q.endsWith(` ${suffix}`)) {
      const stripped = q.slice(0, -(suffix.length + 1)).trim();
      if (stripped) return stripped;
    }
  }
  return q;
}

function emptyResult(job: { packageReady: boolean; packageUrl: string | null }): IssueFixerResult {
  return {
    attempted: 0,
    fixedGoogle: 0,
    fixedRepick: 0,
    failed: 0,
    queriesUsed: 0,
    skippedQueryCap: 0,
    fixedIndexes: [],
    skippedIndexes: [],
    failedIndexes: [],
    packageReady: job.packageReady,
    packageUrl: job.packageUrl,
  };
}

/**
 * Auto-fix scan issues flagged with fixType "google_requery" or "google_repick".
 * AI-regenerate fixes are not applied automatically — this fixer is scoped to
 * Google-photo repairs, capped at MAX_ISSUE_FIXER_GOOGLE_QUERIES fresh searches
 * per run (pass `onlyIndexes` to continue fixing a previously skipped batch).
 */
export async function runIssueFixer(input: {
  jobId: string;
  maxGoogleQueries?: number;
  /** Provide when the review only exists client-side (server /review 404 fallback). */
  majorIssues?: MajorIssue[];
  /** Restrict this run to specific scene indexes (e.g. resume after a query-cap skip). */
  onlyIndexes?: number[];
  onProgress?: IssueFixerProgress;
}): Promise<IssueFixerResult> {
  const maxQueries = Math.max(
    1,
    Math.min(
      MAX_ISSUE_FIXER_GOOGLE_QUERIES,
      input.maxGoogleQueries ?? MAX_ISSUE_FIXER_GOOGLE_QUERIES,
    ),
  );

  const job = await prisma.job.findUnique({ where: { id: input.jobId } });
  if (!job) throw new Error("Job not found");
  if (!job.scenesJson) throw new Error("Job has no scenes");

  const existingReview = (job.reviewJson as Record<string, unknown> | null) || {};
  const previousFix = existingReview.lastFix as LastFix | undefined;
  const previouslyFixed = new Set<number>(previousFix?.fixedIndexes || []);

  const issues: MajorIssue[] =
    input.majorIssues ?? ((existingReview.majorIssues as MajorIssue[] | undefined) || []);

  if (!issues.length) return emptyResult(job);

  const scenes = (job.scenesJson as unknown as SceneRecord[]).map((s) => ({ ...s }));
  const byIndex = new Map(scenes.map((s, i) => [s.index, i]));
  const onlySet = input.onlyIndexes?.length ? new Set(input.onlyIndexes) : null;

  const toFix = new Map<number, MajorIssue>();
  for (const issue of issues) {
    if (issue.fixType !== "google_requery" && issue.fixType !== "google_repick") continue;
    if (!byIndex.has(issue.index)) continue;
    if (previouslyFixed.has(issue.index)) continue;
    if (onlySet && !onlySet.has(issue.index)) continue;
    const existing = toFix.get(issue.index);
    if (!existing || (issue.severity === "major" && existing.severity !== "major")) {
      toFix.set(issue.index, issue);
    }
  }

  if (!toFix.size) return emptyResult(job);

  const previews =
    (job.previewsJson as unknown as Record<string, GoogleSearchPreview>) || {};
  const used = new Set(scenes.filter((s) => s.imageUrl).map((s) => s.imageUrl!));

  const repickIndexes: number[] = [];
  const requeryGroups = new Map<string, { query: string; sceneIndexes: number[] }>();

  for (const [sceneIndex, issue] of toFix) {
    if (issue.fixType === "google_repick") {
      repickIndexes.push(sceneIndex);
      continue;
    }
    const raw = (issue.suggestedQuery || "documentary photo").trim() || "documentary photo";
    const core = coreSubjectKey(raw) || raw.toLowerCase();
    const group =
      requeryGroups.get(core) || { query: core, sceneIndexes: [] as number[] };
    group.sceneIndexes.push(sceneIndex);
    requeryGroups.set(core, group);
  }

  const attempted = toFix.size;
  const fixedIndexes: number[] = [];
  const failedIndexes: number[] = [];

  await input.onProgress?.(
    `Repicking ${repickIndexes.length} scenes from prior search results…`,
  );
  let fixedRepick = 0;
  for (const sceneIndex of repickIndexes) {
    const i = byIndex.get(sceneIndex)!;
    const scene = scenes[i];
    const preview = previews[scene.query || ""];
    const hit = pickBestGoogleHit(preview, { usedUrls: used });
    if (hit?.imageUrl) {
      used.add(hit.imageUrl);
      scenes[i] = {
        ...scene,
        visualSource: "google",
        imageUrl: hit.imageUrl,
        thumbnailUrl: hit.thumbnailUrl || hit.imageUrl,
        sourceUrl: hit.sourcePageUrl || null,
        sourceDomain: hit.sourceDomain || null,
        why: "Issue fixer · repicked from existing search",
      };
      fixedRepick += 1;
      fixedIndexes.push(sceneIndex);
    } else {
      failedIndexes.push(sceneIndex);
    }
  }

  const allGroups = Array.from(requeryGroups.values());
  const groupsToRun = allGroups.slice(0, maxQueries);
  const groupsSkipped = allGroups.slice(maxQueries);
  const skippedIndexes = groupsSkipped.flatMap((g) => g.sceneIndexes);

  let fixedGoogle = 0;
  let queriesUsed = 0;
  let groupsDone = 0;
  const totalGroupScenes = groupsToRun.reduce((n, g) => n + g.sceneIndexes.length, 0);

  await input.onProgress?.(
    `Google requery · ${groupsToRun.length} searches for ${totalGroupScenes} scenes (cap ${maxQueries})…`,
  );

  await mapPool(groupsToRun, GOOGLE_FIX_CONCURRENCY, async (group) => {
    const firstScene = scenes[byIndex.get(group.sceneIndexes[0])!];
    const { personName, placeName } = resolveGoogleSubject(
      firstScene.words,
      group.query,
      firstScene.subject,
    );

    try {
      const preview = await searchGoogleImages(
        group.query,
        Math.max(8, group.sceneIndexes.length * 2),
        { personName, placeName },
      );
      queriesUsed += 1;
      groupsDone += 1;
      if (
        groupsDone === 1 ||
        groupsDone === groupsToRun.length ||
        groupsDone % 10 === 0
      ) {
        await input.onProgress?.(
          `Google requery ${groupsDone}/${groupsToRun.length} · fixed ${fixedGoogle} so far…`,
        );
      }

      // Groups with many scenes on one narrow subject (e.g. 15 beats about the
      // same dig site) quickly exhaust the pool of distinct clean hits from a
      // single search. Once no fresh candidate remains, reuse the group's
      // best hit instead of failing the scene — matches this app's existing
      // "reuse adjacent still" policy (see reuseStills.ts) and is standard
      // documentary editing practice for repeated B-roll of one subject.
      let groupBestHit: GoogleImageHit | null = null;
      for (const sceneIndex of group.sceneIndexes) {
        const i = byIndex.get(sceneIndex)!;
        const scene = scenes[i];
        const freshHit = pickBestGoogleHit(preview, { usedUrls: used, personName, placeName });
        const hit: GoogleImageHit | null = freshHit || groupBestHit;
        if (hit?.imageUrl) {
          used.add(hit.imageUrl);
          if (!groupBestHit) groupBestHit = hit;
          scenes[i] = {
            ...scene,
            visualSource: "google",
            query: group.query,
            subject: placeName || personName || scene.subject,
            imageUrl: hit.imageUrl,
            thumbnailUrl: hit.thumbnailUrl || hit.imageUrl,
            sourceUrl: hit.sourcePageUrl || null,
            sourceDomain: hit.sourceDomain || null,
            imageCandidates: preview.results
              .map((r) => r.imageUrl)
              .filter(Boolean)
              .slice(0, 8),
            why: freshHit
              ? `Issue fixer · Google requery: ${group.query}`
              : `Issue fixer · Google requery (reused still): ${group.query}`,
            r2Url: null,
          };
          fixedGoogle += 1;
          fixedIndexes.push(sceneIndex);
        } else {
          failedIndexes.push(sceneIndex);
        }
      }
    } catch (err) {
      groupsDone += 1;
      for (const sceneIndex of group.sceneIndexes) failedIndexes.push(sceneIndex);
      await input.onProgress?.(
        `Google search failed for "${group.query}": ${err instanceof Error ? err.message : "error"}`,
      );
    }
  });

  const counts = countSources(scenes);

  const result: IssueFixerResult = {
    attempted,
    fixedGoogle,
    fixedRepick,
    failed: failedIndexes.length,
    queriesUsed,
    skippedQueryCap: skippedIndexes.length,
    fixedIndexes,
    skippedIndexes,
    failedIndexes,
    packageReady: Boolean(job.packageReady),
    packageUrl: job.packageUrl,
  };

  const cumulativeFixedIndexes = Array.from(
    new Set([...(previousFix?.fixedIndexes || []), ...fixedIndexes]),
  );

  await prisma.job.update({
    where: { id: input.jobId },
    data: {
      scenesJson: scenes as unknown as Prisma.InputJsonValue,
      googleCount: counts.google,
      aiCount: counts.ai,
      progress: `Issue fixer · fixed ${fixedGoogle + fixedRepick}/${attempted} · ${queriesUsed} Google queries used`,
      reviewJson: {
        ...existingReview,
        majorIssues: issues,
        lastFix: {
          ...result,
          fixedIndexes: cumulativeFixedIndexes,
          at: new Date().toISOString(),
        },
      } as unknown as Prisma.InputJsonValue,
    },
  });

  await input.onProgress?.("Rebuilding render package…");
  try {
    await repackageJob(input.jobId);
    const fresh = await prisma.job.findUnique({ where: { id: input.jobId } });
    result.packageReady = Boolean(fresh?.packageReady);
    result.packageUrl = fresh?.packageUrl || null;
  } catch (err) {
    await input.onProgress?.(
      `Package rebuild failed: ${err instanceof Error ? err.message : "error"}`,
    );
  }

  return result;
}
