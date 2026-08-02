import type { SceneRecord } from "@/lib/jobs/scenes";
import { beatLooksLikeNamedRealWorld } from "@/lib/divider/namedEntity";

function sceneScan(scene: SceneRecord): string {
  return [scene.words, scene.scriptText, scene.query, scene.subject, scene.entityContext]
    .filter(Boolean)
    .join(" ");
}

function isNamedRealScene(scene: SceneRecord): boolean {
  return beatLooksLikeNamedRealWorld(sceneScan(scene));
}

/**
 * Finalize Google vs AI — NO forced mix %.
 * Keep every successful Google still. AI only fills misses / unassigned.
 * More Google is always better.
 *
 * googleOnly: never route misses to AI — reuse a nearby Google still instead.
 */
export function balanceGoogleAiScenes(
  scenes: SceneRecord[],
  opts?: { googleOnly?: boolean },
): SceneRecord[] {
  if (!scenes.length) return scenes;
  const googleOnly = Boolean(opts?.googleOnly);

  const balanced = scenes.map((scene) => {
    // Keep any Google hit that already has a still
    if (scene.visualSource === "google" && scene.imageUrl?.trim()) {
      return { ...scene, visualSource: "google" as const };
    }

    // Google assigned but no image
    if (scene.visualSource === "google" && !scene.imageUrl?.trim()) {
      if (googleOnly) {
        return {
          ...scene,
          visualSource: "google" as const,
          why: scene.why || "Google miss — will reuse nearby still",
        };
      }
      return {
        ...scene,
        visualSource: "ai" as const,
        imageUrl: null,
        thumbnailUrl: null,
        imageCandidates: [],
        r2Url: null,
        subject: scene.subject || scene.query || "scene",
        entityContext:
          scene.entityContext ||
          `documentary realism still for: ${scene.words}`,
        why: isNamedRealScene(scene)
          ? scene.why || "Named entity Google miss — AI fallback"
          : scene.why || "Google miss — AI fallback",
      };
    }

    // Already AI
    if (scene.visualSource === "ai") {
      if (googleOnly) {
        return {
          ...scene,
          visualSource: "google" as const,
          why: scene.why || "google-only — AI blocked, reuse nearby still",
        };
      }
      return {
        ...scene,
        subject: scene.subject || "scene",
        entityContext:
          scene.entityContext ||
          `documentary realism still for: ${scene.words}`,
      };
    }

    // Unassigned / no image → AI (or Google placeholder in google-only)
    if (!scene.imageUrl?.trim()) {
      if (googleOnly) {
        return {
          ...scene,
          visualSource: "google" as const,
          why: scene.why || "google-only — unassigned, reuse nearby still",
        };
      }
      return {
        ...scene,
        visualSource: "ai" as const,
        subject: scene.subject || "scene",
        entityContext:
          scene.entityContext ||
          `documentary realism still for: ${scene.words}`,
        why: scene.why || "Unassigned beat — AI fallback",
      };
    }

    return scene;
  });

  if (!googleOnly) return balanced;
  return reuseNearbyGoogleStills(balanced);
}

/** Fill empty Google scenes by copying the nearest successful Google still. */
export function reuseNearbyGoogleStills(scenes: SceneRecord[]): SceneRecord[] {
  const withUrl = scenes
    .map((s, i) => ({ i, url: s.imageUrl?.trim() || "" }))
    .filter((x) => x.url);

  if (!withUrl.length) return scenes;

  return scenes.map((scene, index) => {
    if (scene.imageUrl?.trim()) return scene;
    let best = withUrl[0];
    let bestDist = Math.abs(best.i - index);
    for (const cand of withUrl) {
      const d = Math.abs(cand.i - index);
      if (d < bestDist) {
        best = cand;
        bestDist = d;
      }
    }
    const donor = scenes[best.i];
    return {
      ...scene,
      visualSource: "google" as const,
      imageUrl: donor.imageUrl,
      thumbnailUrl: donor.thumbnailUrl || donor.imageUrl,
      sourceUrl: donor.sourceUrl,
      sourceDomain: donor.sourceDomain,
      query: scene.query || donor.query,
      why: `${scene.why || "google-only"} · reused nearby Google still`,
    };
  });
}

export function countSources(scenes: SceneRecord[]) {
  let google = 0;
  let ai = 0;
  let other = 0;
  for (const s of scenes) {
    if (s.visualSource === "google" && s.imageUrl) google += 1;
    else if (s.visualSource === "ai" || !s.imageUrl) ai += 1;
    else other += 1;
  }
  return { google, ai, other, total: scenes.length };
}
