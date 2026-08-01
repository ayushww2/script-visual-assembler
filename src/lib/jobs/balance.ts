import type { SceneRecord } from "@/lib/jobs/scenes";
import { beatLooksLikeNamedRealWorld } from "@/lib/divider/namedEntity";

function isNamedRealScene(scene: SceneRecord): boolean {
  const blob = [scene.words, scene.scriptText, scene.query, scene.subject, scene.entityContext]
    .filter(Boolean)
    .join(" ");
  return beatLooksLikeNamedRealWorld(blob);
}

/**
 * Soft ~50/50 Google / AI after previews.
 * Named real people/places/events/movies with a Google hit are NEVER converted to AI.
 */
export function balanceGoogleAiScenes(scenes: SceneRecord[]): SceneRecord[] {
  if (!scenes.length) return scenes;
  const targetGoogle = Math.floor(scenes.length / 2);

  const withGoogleImg = scenes.filter(
    (s) => s.visualSource === "google" && s.imageUrl?.trim(),
  );

  // Always keep named-real Google hits; fill remaining slots by priority.
  const namedKeep = withGoogleImg.filter(isNamedRealScene);
  const namedIds = new Set(namedKeep.map((s) => s.id));
  const extraSlots = Math.max(0, targetGoogle - namedKeep.length);
  const extraKeep = withGoogleImg
    .filter((s) => !namedIds.has(s.id))
    .slice()
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .slice(0, extraSlots);

  const keepIds = new Set([
    ...namedKeep.map((s) => s.id),
    ...extraKeep.map((s) => s.id),
  ]);

  return scenes.map((scene) => {
    if (keepIds.has(scene.id)) {
      return { ...scene, visualSource: "google" as const };
    }

    // Named-real with a Google image must stay Google even above 50% share.
    if (
      scene.visualSource === "google" &&
      scene.imageUrl?.trim() &&
      isNamedRealScene(scene)
    ) {
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
        why: scene.why || "Balanced to AI for soft 50/50 mix",
        subject: scene.subject || scene.query || "scene",
        entityContext:
          scene.entityContext ||
          `documentary realism still for: ${scene.words}`,
      };
    }
    if (!scene.imageUrl?.trim()) {
      // Named-real without an image still prefers Google slot semantics,
      // but missing URL means AI fallback only if not named — for named,
      // leave as google with null so packager/AI path can still fill via AI
      // only when search failed. Prefer AI fill for broken google on abstracts.
      if (isNamedRealScene(scene) && scene.visualSource === "google") {
        // Keep google source; generateMissingAiStills only fills !imageUrl —
        // so named failures still get AI as last resort for package completeness.
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
