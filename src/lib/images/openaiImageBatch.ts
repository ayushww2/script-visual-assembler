import { toFile } from "openai";
import { createOpenAiImageClient } from "@/lib/images/openaiImage";
import { getOpenAiImageConfig } from "@/lib/env";

export type BatchImageRequest = {
  customId: string;
  prompt: string;
};

export type BatchImageResult = {
  customId: string;
  bytes?: Buffer;
  contentType?: string;
  error?: string;
};

type BatchLineOut = {
  custom_id?: string;
  error?: { message?: string } | null;
  response?: {
    status_code?: number;
    body?: {
      data?: Array<{
        b64_json?: string | null;
        url?: string | null;
      }>;
      error?: { message?: string };
    };
  };
};

const POLL_MS = 30_000;

/**
 * OpenAI Batch API for /v1/images/generations — ~50% cheaper, up to 24h.
 * Same model/size/quality as realtime gpt-image-2.
 */
export async function generateGptImagesViaBatch(input: {
  requests: BatchImageRequest[];
  existingBatchId?: string | null;
  onBatchCreated?: (batchId: string) => Promise<void> | void;
  onProgress?: (message: string) => Promise<void> | void;
}): Promise<Map<string, BatchImageResult>> {
  if (!input.requests.length) return new Map();

  const openai = createOpenAiImageClient();
  const defaults = getOpenAiImageConfig();
  let batchId = input.existingBatchId?.trim() || "";

  if (!batchId) {
    const lines = input.requests.map((req) =>
      JSON.stringify({
        custom_id: req.customId,
        method: "POST",
        url: "/v1/images/generations",
        body: {
          model: defaults.model,
          prompt: req.prompt,
          size: defaults.size,
          quality: defaults.quality,
        },
      }),
    );
    const jsonl = `${lines.join("\n")}\n`;

    await input.onProgress?.(
      `AI Batch: uploading ${input.requests.length} image requests (50% cheaper)…`,
    );

    const file = await openai.files.create({
      file: await toFile(Buffer.from(jsonl, "utf8"), "ai-stills-batch.jsonl", {
        type: "application/jsonl",
      }),
      purpose: "batch",
    });

    const batch = await openai.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/images/generations",
      completion_window: "24h",
      metadata: {
        purpose: "script-assembler-ai-stills",
        count: String(input.requests.length),
      },
    });

    batchId = batch.id;
    await input.onBatchCreated?.(batchId);
    await input.onProgress?.(
      `AI Batch submitted ${batchId} · waiting (up to 24h, 50% off)…`,
    );
  } else {
    await input.onProgress?.(
      `AI Batch resume ${batchId} · polling for results…`,
    );
  }

  for (;;) {
    const batch = await openai.batches.retrieve(batchId);
    const done = batch.request_counts?.completed ?? 0;
    const failed = batch.request_counts?.failed ?? 0;
    const total = batch.request_counts?.total ?? input.requests.length;

    if (batch.status === "completed") {
      await input.onProgress?.(
        `AI Batch complete · ${done}/${total} ok · ${failed} failed — downloading…`,
      );
      break;
    }

    if (
      batch.status === "failed" ||
      batch.status === "expired" ||
      batch.status === "cancelled"
    ) {
      const err =
        batch.errors?.data?.map((e) => e.message).filter(Boolean).join("; ") ||
        `Batch ${batch.status}`;
      throw new Error(`OpenAI AI Batch ${batchId} ${batch.status}: ${err}`);
    }

    await input.onProgress?.(
      `AI Batch ${batch.status} · ${done}/${total} done · ${failed} failed · ${batchId}`,
    );
    await sleep(POLL_MS);
  }

  const batch = await openai.batches.retrieve(batchId);
  if (!batch.output_file_id) {
    throw new Error(`AI Batch ${batchId} completed with no output_file_id`);
  }

  const raw = await openai.files.content(batch.output_file_id);
  const text = await raw.text();
  const out = new Map<string, BatchImageResult>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: BatchLineOut;
    try {
      parsed = JSON.parse(line) as BatchLineOut;
    } catch {
      continue;
    }
    const customId = parsed.custom_id || "";
    if (!customId) continue;

    if (parsed.error?.message) {
      out.set(customId, { customId, error: parsed.error.message });
      continue;
    }

    const status = parsed.response?.status_code ?? 0;
    const body = parsed.response?.body;
    if (status >= 400 || body?.error?.message) {
      out.set(customId, {
        customId,
        error: body?.error?.message || `HTTP ${status}`,
      });
      continue;
    }

    const first = body?.data?.[0];
    if (!first) {
      out.set(customId, { customId, error: "No image data in batch response" });
      continue;
    }

    try {
      if (first.b64_json) {
        out.set(customId, {
          customId,
          bytes: Buffer.from(first.b64_json, "base64"),
          contentType: "image/png",
        });
      } else if (first.url) {
        const res = await fetch(first.url, {
          headers: { "User-Agent": "ScriptAssembler/1.0" },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          out.set(customId, {
            customId,
            error: `Download failed (${res.status})`,
          });
          continue;
        }
        const contentType = (res.headers.get("content-type") || "image/png")
          .split(";")[0]
          .trim();
        out.set(customId, {
          customId,
          bytes: Buffer.from(await res.arrayBuffer()),
          contentType: contentType.startsWith("image/")
            ? contentType
            : "image/png",
        });
      } else {
        out.set(customId, {
          customId,
          error: "Batch image missing b64_json and url",
        });
      }
    } catch (err) {
      out.set(customId, {
        customId,
        error: err instanceof Error ? err.message : "Batch image parse failed",
      });
    }
  }

  // Ensure every request has an entry
  for (const req of input.requests) {
    if (!out.has(req.customId)) {
      out.set(req.customId, {
        customId: req.customId,
        error: "Missing from batch output",
      });
    }
  }

  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
