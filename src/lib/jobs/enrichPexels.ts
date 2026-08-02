import { createHash } from "crypto";
import type { SceneRecord } from "@/lib/jobs/scenes";
import { getPexelsConfig } from "@/lib/env";
import { mapPool } from "@/lib/jobs/pool";
import { PEXELS_CONCURRENCY } from "@/lib/jobs/limits";
import { uploadToR2 } from "@/lib/r2";
import {
  pickBestPexelsVideo,
  searchPexelsVideos,
  PEXELS_TARGET_USE_SEC,
} from "@/lib/search/pexels";
import {
  isPlaceOrObjectName,
  primaryPlaceFromText,
} from "@/lib/search/placeSubject";
import { resolveGoogleSubject } from "@/lib/search/resolveSubject";

export type PexelsEnrichProgress = (message: string) => Promise<void> | void;

const MAX_CLIP_BYTES = 80 * 1024 * 1024;

function clipKey(jobId: string, index: number, body: Buffer): string {
  const nnn = String(index).padStart(3, "0");
  const hash = createHash("sha1").update(body).digest("hex").slice(0, 10);
  return `packages/${jobId}/clips/scene-${nnn}-${hash}.mp4`;
}

/** Place / landscape / gear B-roll — never named-person portrait beats. */
export function isPexelsEligibleScene(scene: SceneRecord): boolean {
  if (scene.videoUrl?.trim()) return false;
  if (scene.visualSource === "unassigned") return false;

  const place =
    primaryPlaceFromText(
      scene.subject,
      scene.entityContext,
      scene.query,
      scene.words,
    ) || (isPlaceOrObjectName(scene.subject) ? scene.subject : null);

  const { personName, placeName } = resolveGoogleSubject(
    scene.words,
    scene.query,
    scene.subject,
    scene.entityContext,
  );

  // Named people stay on Google/AI stills.
  if (personName && !placeName && !place) return false;

  if (place || placeName) return true;

  // Atmosphere / nature / underwater B-roll language
  const blob = `${scene.subject || ""} ${scene.entityContext || ""} ${scene.words || ""}`;
  return /\b(lake|ocean|sea|underwater|forest|mountain|desert|drone|aerial|rov|wildlife|wolf|wolves|ruins|tomb|shore|night sky|storm|fog|mist)\b/i.test(
    blob,
  );
}

function pexelsQueryFor(scene: SceneRecord): string {
  const place =
    primaryPlaceFromText(
      scene.subject,
      scene.entityContext,
      scene.query,
      scene.words,
    ) ||
    (isPlaceOrObjectName(scene.subject) ? scene.subject : null);
  if (place) return place;
  if (scene.subject?.trim()) return scene.subject.trim();
  if (scene.query?.trim()) {
    return scene.query
      .replace(/-\S+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }
  return (scene.words || "").split(/\s+/).slice(0, 8).join(" ");
}

async function downloadMp4(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(90_000),
    headers: {
      Accept: "video/mp4,video/*,*/*;q=0.8",
      "User-Agent": "ScriptAssemblerPexels/1.0",
    },
  });
  if (!res.ok) throw new Error(`clip HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.byteLength) throw new Error("empty clip");
  if (buf.byteLength > MAX_CLIP_BYTES) {
    throw new Error(`clip too large (${buf.byteLength} bytes)`);
  }
  return buf;
}

/**
 * Attach short Pexels landscape clips to eligible place/B-roll scenes.
 * Keeps existing still as poster; Remotion should play videoUseSec (~5s) and loop.
 */
export async function enrichScenesWithPexels(input: {
  jobId: string;
  scenes: SceneRecord[];
  onProgress?: PexelsEnrichProgress;
}): Promise<{ scenes: SceneRecord[]; attached: number; skipped: string }> {
  const cfg = getPexelsConfig();
  if (!cfg.enabled || cfg.maxPerJob <= 0) {
    return {
      scenes: input.scenes,
      attached: 0,
      skipped: "Pexels disabled (set PEXELS_API_KEY)",
    };
  }

  const eligible = input.scenes.filter(isPexelsEligibleScene);
  if (!eligible.length) {
    return { scenes: input.scenes, attached: 0, skipped: "no eligible scenes" };
  }

  const targets = eligible.slice(0, cfg.maxPerJob);
  await input.onProgress?.(
    `Pexels B-roll · searching ${targets.length} landscape scenes…`,
  );

  const byId = new Map(input.scenes.map((s) => [s.id, { ...s }]));
  const usedVideoIds = new Set<number>();
  let attached = 0;
  let failed = 0;
  const useSec = cfg.useSec || PEXELS_TARGET_USE_SEC;
  const concurrency = Math.min(cfg.concurrency, PEXELS_CONCURRENCY);

  await mapPool(targets, concurrency, async (scene) => {
    const query = pexelsQueryFor(scene);
    try {
      const search = await searchPexelsVideos(query);
      if (search.error || !search.results.length) {
        failed += 1;
        return;
      }
      const hit = pickBestPexelsVideo(search.results, usedVideoIds);
      if (!hit) {
        failed += 1;
        return;
      }
      usedVideoIds.add(hit.id);

      const body = await downloadMp4(hit.videoUrl);
      const key = clipKey(input.jobId, scene.index, body);
      const put = await uploadToR2({
        key,
        body,
        contentType: "video/mp4",
      });

      const poster = scene.imageUrl?.trim() || hit.image;
      byId.set(scene.id, {
        ...scene,
        visualSource: "pexels",
        imageUrl: poster,
        thumbnailUrl: scene.thumbnailUrl || hit.image,
        videoUrl: put.url,
        videoSource: "pexels",
        videoDurationSec: hit.duration,
        videoUseSec: useSec,
        videoLoop: true,
        sourceUrl: hit.url,
        sourceDomain: "pexels.com",
        why: `Pexels video · ${useSec}s use · ${hit.userName}`,
        email: null,
        pexels: {
          id: hit.id,
          photographer: hit.userName,
          photographerUrl: hit.userUrl,
          pageUrl: hit.url,
        },
      });
      attached += 1;
      if (attached === 1 || attached % 5 === 0 || attached === targets.length) {
        await input.onProgress?.(
          `Pexels B-roll · ${attached}/${targets.length} clips` +
            (failed ? ` · ${failed} miss` : ""),
        );
      }
    } catch {
      failed += 1;
    }
  });

  return {
    scenes: input.scenes.map((s) => byId.get(s.id) || s),
    attached,
    skipped: attached ? "" : `no clips attached (${failed} miss)`,
  };
}
