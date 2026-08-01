import { createContactBoxClient, getContactBoxConfig } from "@/lib/contactbox";
import {
  MYSTERY_DEFAULT_NEGATIVE,
  MYSTERY_REALISM_LOCK,
} from "./realismRecipe";

export type MysteryRealismInput = {
  title?: string;
  visualIdea: string;
  subject?: string;
  words?: string;
  intendedUse?: string;
  preferredStyle?: string;
};

export type MysteryRealismPromptPack = {
  detailedImagePrompt: string;
  negativePrompt: string;
  lookTextureNotes: string;
  quickVersion: string;
};

const SYSTEM = `You are a documentary-style AI image prompt engineer for a Mystery YouTube channel.

Your ONLY job: turn one visual idea into prompts that make GPT Image generate a REALISTIC, BELIEVABLE, EVIDENCE-STYLE documentary photograph.

This is NOT for deciding story beats or what clip to pick. It is ONLY for realism of AI stills.

${MYSTERY_REALISM_LOCK}

Reference look (obey): Dead Sea sinkholes & salt crusts, archaeological digs with stakes/string/cases,
underwater divers with flashlight + marine snow, field shoreline footprints, night industrial deck candid,
old B&W archive ruins, lab/manuscript scan when asked — all landscape-capable, human-captured, slightly imperfect.

Rules:
- Write prompts for LANDSCAPE photography (wide). Prefer 16:9.
- Make images bright/clear enough to read, yet real and slightly imperfect — not crystal-perfect CGI.
- Never invent logos, seals, readable fake documents, timestamps, or HUD text.
- Never write generic cinematic trailer language.
- Output JSON only with keys:
  detailedImagePrompt (one paste-ready paragraph),
  negativePrompt (comma list, specific to this idea),
  lookTextureNotes (short practical notes),
  quickVersion (1–2 sentence prompt).`;

export async function engineerMysteryRealismPrompt(
  input: MysteryRealismInput,
): Promise<MysteryRealismPromptPack> {
  const visualIdea = (input.visualIdea || input.subject || "").trim();
  if (!visualIdea) throw new Error("visualIdea is required");

  const { model } = getContactBoxConfig();
  const client = createContactBoxClient();

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.35,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          title: input.title || "",
          visualIdea,
          subject: input.subject || "",
          narrationChunk: input.words || "",
          intendedUse: input.intendedUse || "evidence still",
          preferredStyle: input.preferredStyle || "color documentary",
          aspectRatio: "16:9",
          realismLevel: "very realistic",
          note: "Landscape still only. Maximize photographic realism with slight human imperfection.",
        }),
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw) as {
    detailedImagePrompt?: string;
    negativePrompt?: string;
    lookTextureNotes?: string;
    quickVersion?: string;
  };

  const detailed = (parsed.detailedImagePrompt || "").trim();
  if (!detailed) {
    throw new Error("ContactBox returned empty detailedImagePrompt");
  }

  return {
    detailedImagePrompt: detailed,
    negativePrompt: (parsed.negativePrompt || MYSTERY_DEFAULT_NEGATIVE).trim(),
    lookTextureNotes: (parsed.lookTextureNotes || "").trim(),
    quickVersion: (parsed.quickVersion || detailed.slice(0, 280)).trim(),
  };
}

/** Merge pack into a single generation string for GPT Image. */
export function packToImagePrompt(pack: MysteryRealismPromptPack): string {
  return [
    pack.detailedImagePrompt,
    "Aspect 16:9 landscape documentary photograph.",
    `Avoid: ${pack.negativePrompt}`,
  ].join(" ");
}

/** Offline fallback if ContactBox engineer fails. */
export function fallbackMysteryImagePrompt(input: {
  visualIdea: string;
  subject?: string;
}): string {
  const idea = input.visualIdea || input.subject || "documentary field still";
  return [
    `Documentary photograph, landscape 16:9, showing ${idea}.`,
    "Real human-captured field / archive / lab evidence still, slightly imperfect: natural grain, soft optics, mild haze, uneven exposure.",
    "Natural daylight or overcast documentary light. Realistic materials and scale. Functional framing, not poster composition.",
    MYSTERY_REALISM_LOCK,
    `Avoid: ${MYSTERY_DEFAULT_NEGATIVE}`,
  ].join(" ");
}
