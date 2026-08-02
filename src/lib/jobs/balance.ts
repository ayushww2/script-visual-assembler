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
 */
export function balanceGoogleAiScenes(scenes: SceneRecord[]): SceneRecord[] {
  if (!scenes.length) return scenes;

  return scenes.map((scene) => {
    // Keep any Google hit that already has a still
    if (scene.visualSource === "google" && scene.imageUrl?.trim()) {
      return { ...scene, visualSource: "google" as const };
    }

    // Google assigned but no image → AI fallback
    if (scene.visualSource === "google" && !scene.imageUrl?.trim()) {
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
      return {
        ...scene,
        subject: scene.subject || "scene",
        entityContext:
          scene.entityContext ||
          `documentary realism still for: ${scene.words}`,
      };
    }

    // Unassigned / no image → AI
    if (!scene.imageUrl?.trim()) {
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
