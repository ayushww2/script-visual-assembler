import { createContactBoxClient, getContactBoxConfig } from "@/lib/contactbox";
import { parseBeats } from "./beats";
import { buildDirectorUserPrompt, DIRECTOR_SYSTEM_PROMPT } from "./prompt";
import { dividerResultSchema, type Beat, type DividerResult } from "./schema";

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON");
  }
}

export async function runScriptDivider(input: {
  script: string;
  phase?: "google-first" | "full";
  niche?: string | null;
}): Promise<{
  beats: Beat[];
  result: DividerResult;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}> {
  const beats = parseBeats(input.script);
  if (beats.length < 1) {
    throw new Error("No beats found. Paste a script or Whisper JSON.");
  }

  const { model } = getContactBoxConfig();
  const client = createContactBoxClient();
  const userPrompt = buildDirectorUserPrompt(
    beats,
    input.phase ?? "google-first",
    input.niche,
  );

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: DIRECTOR_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Empty model response");

  const parsed = dividerResultSchema.parse(extractJson(content));

  // Soft-dedupe exact Google queries
  const seen = new Set<string>();
  parsed.googleSearches = parsed.googleSearches.filter((pack) => {
    const key = pack.query.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    beats,
    result: parsed,
    model,
    usage: {
      inputTokens: completion.usage?.prompt_tokens,
      outputTokens: completion.usage?.completion_tokens,
    },
  };
}
