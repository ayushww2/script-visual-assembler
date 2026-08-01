import OpenAI from "openai";
import { getOpenAiImageConfig } from "@/lib/env";

export type GeneratedImage = {
  model: string;
  size: string;
  quality: string;
  bytes: Buffer;
  contentType: string;
  revisedPrompt?: string;
};

export function createOpenAiImageClient() {
  const { apiKey, baseURL } = getOpenAiImageConfig();
  if (!apiKey) {
    throw new Error(
      "OPENAI_IMAGE_API_KEY is not set (real OpenAI key for gpt-image-2)",
    );
  }
  return new OpenAI({
    apiKey,
    baseURL,
    maxRetries: 2,
    timeout: 300_000,
  });
}

/** Generate one landscape still via OpenAI Images (gpt-image-2). */
export async function generateGptImage(params: {
  prompt: string;
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
  model?: string;
}): Promise<GeneratedImage> {
  const defaults = getOpenAiImageConfig();
  const model = params.model || defaults.model;
  const size = params.size || defaults.size;
  const quality = params.quality || defaults.quality;

  const openai = createOpenAiImageClient();
  const result = (await openai.images.generate({
    model,
    prompt: params.prompt,
    size: size as "1536x1024" | "1024x1024" | "1024x1536" | "auto",
    quality,
  })) as {
    data?: Array<{
      b64_json?: string | null;
      url?: string | null;
      revised_prompt?: string | null;
    }>;
  };

  const first = result.data?.[0];
  if (!first) throw new Error("GPT Image returned no data");

  if (first.b64_json) {
    return {
      model,
      size,
      quality,
      bytes: Buffer.from(first.b64_json, "base64"),
      contentType: "image/png",
      revisedPrompt: first.revised_prompt || undefined,
    };
  }

  if (first.url) {
    const res = await fetch(first.url, {
      headers: { "User-Agent": "ScriptAssembler/1.0" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to download image URL (${res.status})`);
    }
    const contentType = (res.headers.get("content-type") || "image/png")
      .split(";")[0]
      .trim();
    return {
      model,
      size,
      quality,
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: contentType.startsWith("image/") ? contentType : "image/png",
      revisedPrompt: first.revised_prompt || undefined,
    };
  }

  throw new Error("GPT Image response missing b64_json and url");
}
