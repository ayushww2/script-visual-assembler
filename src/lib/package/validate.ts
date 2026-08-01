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

  if (!pkg.scenes.length) {
    issues.push({ code: "empty", message: "scenes is empty" });
    return issues;
  }

  if (Math.abs(pkg.scenes[0].startSec) > GAP_TOLERANCE) {
    issues.push({
      code: "start",
      message: `first startSec must be 0 (got ${pkg.scenes[0].startSec})`,
    });
  }

  for (let i = 0; i < pkg.scenes.length; i++) {
    const s = pkg.scenes[i];
    const label = `scene ${i + 1}`;
    if (!s.words.trim()) {
      issues.push({ code: "words", message: `${label}: empty words` });
    }
    if (!s.imageUrl?.startsWith("https://")) {
      issues.push({
        code: "imageUrl",
        message: `${label}: imageUrl must be public HTTPS`,
      });
    }
    if (s.imageUrl.includes("localhost") || s.imageUrl.includes("127.0.0.1")) {
      issues.push({
        code: "imageUrl",
        message: `${label}: imageUrl must not be localhost`,
      });
    }
    if (s.endSec <= s.startSec) {
      issues.push({
        code: "timing",
        message: `${label}: endSec must be > startSec`,
      });
    }
    const expectedDur = round3(s.endSec - s.startSec);
    if (Math.abs(expectedDur - s.durationSec) > GAP_TOLERANCE) {
      issues.push({
        code: "timing",
        message: `${label}: durationSec mismatch`,
      });
    }
    if (i > 0) {
      const prev = pkg.scenes[i - 1];
      const gap = Math.abs(s.startSec - prev.endSec);
      if (gap > GAP_TOLERANCE) {
        issues.push({
          code: "continuity",
          message: `gap/overlap between scene ${i} and ${i + 1} (${gap.toFixed(3)}s)`,
        });
      }
    }
  }

  if (opts?.checkImageReachability !== false) {
    const sample = pkg.scenes.slice(0, Math.min(pkg.scenes.length, 40));
    await Promise.all(
      sample.map(async (s, i) => {
        const ok = await isPubliclyReachable(s.imageUrl);
        if (!ok) {
          issues.push({
            code: "unreachable",
            message: `scene ${i + 1}: imageUrl not publicly reachable`,
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
      headers: { "User-Agent": "ScriptAssemblerPackager/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
    if (head.ok) return true;
    const get = await fetch(url, {
      method: "GET",
      headers: {
        Range: "bytes=0-0",
        "User-Agent": "ScriptAssemblerPackager/1.0",
      },
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
