import type { SceneRecord } from "@/lib/jobs/scenes";
import { sanitizeAiVisualIdea } from "@/lib/mystery/realismPrompt";
import {
  pickBestGoogleHit,
  searchGoogleImages,
} from "@/lib/search/google";
import { primaryPersonFromText } from "@/lib/search/personSubject";
import { mapPool } from "@/lib/jobs/pool";

export type RepairProgress = (message: string) => Promise<void> | void;

/** Empty-chair / vacant-interview prop stills — look cheap and off-topic. */
const CHAIR_CLICHE =
  /\b(vacant (interview )?chair|empty chair|interview chair|armchair|zoom recorder|audio recorder beside|interview set between takes|empty seat beside|recorder and (printed )?notes|vacant interview|director'?s?\s*(empty\s*)?chair|director chair|folding chair)\b/i;

/** Abstract “serious” beats → prefer the film’s person over empty props. */
const SERIOUS_PERSON_BEAT =
  /\b(serious|raising eyebrows|so serious|investigative pause)\b/i;

export function isChairClicheAiScene(scene: SceneRecord): boolean {
  if (scene.visualSource !== "ai") return false;
  if (!scene.imageUrl?.trim()) return false;
  const blob = [scene.entityContext, scene.subject, scene.why, scene.query]
    .filter(Boolean)
    .join(" ");
  if (CHAIR_CLICHE.test(blob)) return true;
  // Failed prior regen used a person name as the whole visual idea
  const idea = (scene.entityContext || scene.subject || "").trim();
  if (
    /without empty-chair/i.test(scene.why || "") &&
    /^(mel gibson|joe rogan|jim caviezel)$/i.test(idea)
  ) {
    return true;
  }
  return false;
}

/**
 * Wrong prior repair: empty-chair → Mel Google on non-serious beats (e.g. budget/storyboard).
 * Send those back to AI (chair-free prompt).
 */
export function isWrongChairPersonSwap(scene: SceneRecord): boolean {
  if (scene.visualSource !== "google") return false;
  const why = (scene.why || "").toLowerCase();
  if (!why.includes("empty-chair")) return false;
  const blob = `${scene.subject || ""} ${scene.words || ""}`;
  return !SERIOUS_PERSON_BEAT.test(blob);
}

/**
 * Replace empty-chair AI stills:
 * - “serious / pause” beats → clean Google of the film’s primary person
 * - other chair clichés → re-queue AI with a chair-free environmental idea
 */
export async function repairChairClicheAiScenes(input: {
  scenes: SceneRecord[];
  title?: string | null;
  onProgress?: RepairProgress;
  concurrency?: number;
}): Promise<{ scenes: SceneRecord[]; repaired: number; failed: number }> {
  const indexes: number[] = [];
  input.scenes.forEach((s, i) => {
    if (isChairClicheAiScene(s) || isWrongChairPersonSwap(s)) indexes.push(i);
  });
  if (!indexes.length) {
    return { scenes: input.scenes, repaired: 0, failed: 0 };
  }

  const out = input.scenes.map((s) => ({ ...s }));
  const used = new Set(
    out
      .filter((s, i) => s.imageUrl?.trim() && !indexes.includes(i))
      .map((s) => s.imageUrl!),
  );
  let repaired = 0;
  let failed = 0;
  let done = 0;
  const concurrency = Math.max(1, input.concurrency ?? 4);

  await input.onProgress?.(
    `Fixing ${indexes.length} empty-chair cliché stills…`,
  );

  await mapPool(indexes, concurrency, async (idx) => {
    const scene = out[idx];
    const blob = `${scene.subject || ""} ${scene.words || ""}`;
    const preferPerson = SERIOUS_PERSON_BEAT.test(blob);
    const personName = primaryPersonFromText(
      input.title,
      scene.words,
      scene.scriptText,
      scene.subject,
    );

    if (preferPerson && personName) {
      const query = `${personName} portrait photo`;
      try {
        const preview = await searchGoogleImages(query, 20, { personName });
        const hit = pickBestGoogleHit(preview, {
          usedUrls: used,
          personName,
        });
        if (!hit?.imageUrl) {
          failed += 1;
        } else {
          used.add(hit.imageUrl);
          out[idx] = {
            ...scene,
            visualSource: "google",
            query,
            subject: personName,
            imageUrl: hit.imageUrl,
            thumbnailUrl: hit.thumbnailUrl || hit.imageUrl,
            sourceUrl: hit.sourcePageUrl || null,
            sourceDomain: hit.sourceDomain || null,
            imageCandidates: preview.results
              .map((r) => r.imageUrl)
              .filter(Boolean)
              .slice(0, 8),
            why: `Replaced empty-chair AI · Google single-person: ${personName}`,
            r2Url: null,
            entityContext: undefined,
          };
          repaired += 1;
        }
      } catch {
        failed += 1;
      }
    } else {
      // Re-queue AI without the chair prop (never reuse a person-name as the visual idea)
      const seed =
        scene.entityContext &&
        !/^mel gibson$/i.test(scene.entityContext.trim()) &&
        !/^joe rogan$/i.test(scene.entityContext.trim())
          ? scene.entityContext
          : scene.words || scene.subject || "documentary field still";
      const cleaned = sanitizeAiVisualIdea(seed, scene.words);
      const subject =
        scene.subject &&
        !/^mel gibson$/i.test(scene.subject.trim()) &&
        !SERIOUS_PERSON_BEAT.test(scene.subject)
          ? scene.subject
          : cleaned.split(/\s+/).slice(0, 4).join(" ");
      out[idx] = {
        ...scene,
        visualSource: "ai",
        imageUrl: null,
        thumbnailUrl: null,
        r2Url: null,
        sourceUrl: null,
        sourceDomain: null,
        imageCandidates: [],
        subject,
        entityContext: cleaned,
        why: "Regenerating AI without empty-chair cliché",
      };
      repaired += 1;
    }

    done += 1;
    await input.onProgress?.(
      `Chair-cliché repair ${done}/${indexes.length} · fixed ${repaired} · failed ${failed}`,
    );
  });

  return { scenes: out, repaired, failed };
}
