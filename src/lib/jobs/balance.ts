import type { SceneRecord } from "@/lib/jobs/scenes";

/**
 * Force ~50/50 Google / AI scene sources after Google previews.
 * Prefer keeping successful Google hits up to half the scenes; rest → AI.
 */
export function balanceGoogleAiScenes(scenes: SceneRecord[]): SceneRecord[] {
  if (!scenes.length) return scenes;
  const targetGoogle = Math.floor(scenes.length / 2);

  const withGoogleImg = scenes.filter(
    (s) => s.visualSource === "google" && s.imageUrl?.trim(),
  );
  const keepIds = new Set(
    withGoogleImg
      .slice()
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .slice(0, targetGoogle)
      .map((s) => s.id),
  );

  return scenes.map((scene) => {
    if (keepIds.has(scene.id)) {
      return { ...scene, visualSource: "google" as const };
    }
    // Convert excess google / unassigned into AI slots (image cleared for regen)
    if (scene.visualSource === "google" && scene.imageUrl) {
      return {
        ...scene,
        visualSource: "ai" as const,
        imageUrl: null,
        thumbnailUrl: null,
        imageCandidates: [],
        r2Url: null,
        why: scene.why || "Balanced to AI for 50/50 mix",
        subject: scene.subject || scene.query || "scene",
        entityContext:
          scene.entityContext ||
          `documentary realism still for: ${scene.words}`,
      };
    }
    if (!scene.imageUrl?.trim()) {
      return {
        ...scene,
        visualSource: "ai" as const,
        subject: scene.subject || "scene",
        entityContext:
          scene.entityContext ||
          `documentary realism still for: ${scene.words}`,
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
