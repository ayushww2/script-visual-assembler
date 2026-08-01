import type { SceneRecord } from "@/lib/jobs/scenes";
import { beatLooksLikeNamedRealWorld } from "@/lib/divider/namedEntity";
import { beatLooksGoogleable } from "@/lib/divider/googleFirst";

function sceneScan(scene: SceneRecord): string {
  return [scene.words, scene.scriptText, scene.query, scene.subject, scene.entityContext]
    .filter(Boolean)
    .join(" ");
}

function isNamedRealScene(scene: SceneRecord): boolean {
  return beatLooksLikeNamedRealWorld(sceneScan(scene));
}

function mustStayGoogle(scene: SceneRecord): boolean {
  if (!scene.imageUrl?.trim()) return false;
  if (scene.visualSource !== "google") return false;
  const scan = sceneScan(scene);
  // Named people/places/films and photographable subjects never get stripped for mix ratio
  return beatLooksLikeNamedRealWorld(scan) || beatLooksGoogleable(scan);
}

/**
 * Soft ~60/40 Google / AI after previews (Google-first).
 * Named + photographable Google hits are NEVER converted to AI for mix balance.
 */
export function balanceGoogleAiScenes(scenes: SceneRecord[]): SceneRecord[] {
  if (!scenes.length) return scenes;
  const targetGoogle = Math.max(
    Math.floor(scenes.length / 2),
    Math.ceil(scenes.length * 0.6),
  );

  const withGoogleImg = scenes.filter(
    (s) => s.visualSource === "google" && s.imageUrl?.trim(),
  );

  const locked = withGoogleImg.filter(mustStayGoogle);
  const lockedIds = new Set(locked.map((s) => s.id));
  const extraSlots = Math.max(0, targetGoogle - locked.length);
  const extraKeep = withGoogleImg
    .filter((s) => !lockedIds.has(s.id))
    .slice()
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .slice(0, extraSlots);

  const keepIds = new Set([
    ...locked.map((s) => s.id),
    ...extraKeep.map((s) => s.id),
  ]);

  return scenes.map((scene) => {
    if (keepIds.has(scene.id) || mustStayGoogle(scene)) {
      return { ...scene, visualSource: "google" as const };
    }

    // Convert excess google / unassigned into AI slots
    if (scene.visualSource === "google" && scene.imageUrl) {
      return {
        ...scene,
        visualSource: "ai" as const,
        imageUrl: null,
        thumbnailUrl: null,
        imageCandidates: [],
        r2Url: null,
        why: scene.why || "Balanced to AI for soft Google-first mix",
        subject: scene.subject || scene.query || "scene",
        entityContext:
          scene.entityContext ||
          `documentary realism still for: ${scene.words}`,
      };
    }
    if (!scene.imageUrl?.trim()) {
      if (isNamedRealScene(scene) && scene.visualSource === "google") {
        return {
          ...scene,
          visualSource: "ai" as const,
          subject: scene.subject || scene.query || "scene",
          entityContext:
            scene.entityContext ||
            `documentary realism still for: ${scene.words}`,
          why: scene.why || "Named entity Google miss — AI fallback",
        };
      }
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
