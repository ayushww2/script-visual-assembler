import {
  RenderPackageSchema,
  type RenderPackage,
} from "./schema";

export type PackageValidationIssue = {
  code: string;
  message: string;
};

const GAP_TOLERANCE = 0.02; // seconds

export async function validateRenderPackage(
  pkg: RenderPackage,
  opts?: { checkImageReachability?: boolean },
): Promise<PackageValidationIssue[]> {
  const issues: PackageValidationIssue[] = [];

  const parsed = RenderPackageSchema.safeParse(pkg);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: "schema",
        message: `${issue.path.join(".") || "package"}: ${issue.message}`,
      });
    }
    return issues;
  }

  if (pkg.sceneCount !== pkg.scenes.length) {
    issues.push({
      code: "sceneCount",
      message: `sceneCount ${pkg.sceneCount} != scenes.length ${pkg.scenes.length}`,
    });
  }

  if (pkg.sceneCount === 0 || pkg.scenes.length === 0) {
    issues.push({ code: "empty", message: "sceneCount == 0" });
  }

  if (pkg.mode === "full") {
    if (!pkg.voiceoverUrl.startsWith("https://")) {
      issues.push({
        code: "voiceover",
        message: "voiceoverUrl missing or not HTTPS (full mode)",
      });
    }
  }

  const sorted = [...pkg.scenes].sort((a, b) => a.index - b.index);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== pkg.scenes[i]) {
      issues.push({
        code: "order",
        message: "scenes must be sorted by index ascending",
      });
      break;
    }
  }

  if (sorted[0] && Math.abs(sorted[0].startSec) > GAP_TOLERANCE) {
    issues.push({
      code: "start",
      message: `first startSec must be 0 (got ${sorted[0].startSec})`,
    });
  }

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (!s.words.trim()) {
      issues.push({
        code: "words",
        message: `scene ${s.sceneId}: empty words`,
      });
    }
    if (!s.imageUrl?.startsWith("https://")) {
      issues.push({
        code: "imageUrl",
        message: `scene ${s.sceneId}: imageUrl must be public HTTPS`,
      });
    }
    if (s.imageUrl.includes("localhost") || s.imageUrl.includes("127.0.0.1")) {
      issues.push({
        code: "imageUrl",
        message: `scene ${s.sceneId}: imageUrl must not be localhost`,
      });
    }
    if (s.endSec <= s.startSec) {
      issues.push({
        code: "timing",
        message: `scene ${s.sceneId}: endSec must be > startSec`,
      });
    }
    const expectedDur = round3(s.endSec - s.startSec);
    if (Math.abs(expectedDur - s.durationSec) > GAP_TOLERANCE) {
      issues.push({
        code: "timing",
        message: `scene ${s.sceneId}: durationSec mismatch`,
      });
    }
    if (i > 0) {
      const prev = sorted[i - 1];
      const gap = Math.abs(s.startSec - prev.endSec);
      if (gap > GAP_TOLERANCE) {
        issues.push({
          code: "continuity",
          message: `gap/overlap between scene ${prev.sceneId} and ${s.sceneId} (${gap.toFixed(3)}s)`,
        });
      }
    }
  }

  if (opts?.checkImageReachability !== false) {
    const sample = sorted.slice(0, Math.min(sorted.length, 40));
    await Promise.all(
      sample.map(async (s) => {
        const ok = await isPubliclyReachable(s.imageUrl);
        if (!ok) {
          issues.push({
            code: "unreachable",
            message: `scene ${s.sceneId}: imageUrl not publicly reachable`,
          });
        }
      }),
    );
  }

  return issues;
}

async function isPubliclyReachable(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (head.ok) return true;
    // Some CDNs reject HEAD — try a tiny GET
    const get = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    return get.ok || get.status === 206;
  } catch {
    return false;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
