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
 *
 * IMPORTANT: never load the full output JSONL as one JS string — 300+ b64
 * PNGs exceed Node's max string length (~512MB) and crash the job.
 */
export async function generateGptImagesViaBatch(input: {
  requests: BatchImageRequest[];
  existingBatchId?: string | null;
  onBatchCreated?: (batchId: string) => Promise<void> | void;
  onProgress?: (message: string) => Promise<void> | void;
  /**
   * Optional streaming sink — called once per output line with image bytes.
   * When provided, bytes are NOT retained in the returned Map (saves RAM).
   */
  onImage?: (result: BatchImageResult) => Promise<void> | void;
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
        `AI Batch complete · ${done}/${total} ok · ${failed} failed — streaming download…`,
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

  const out = new Map<string, BatchImageResult>();
  let parsed = 0;
  let images = 0;

  await streamBatchOutputLines(batch.output_file_id, async (line) => {
    let result = parseBatchOutputLine(line);
    if (!result) return;
    parsed += 1;

    if (result.error?.startsWith("URL_PENDING:")) {
      result = await resolvePendingBatchUrl(result);
    }

    if (result.bytes) {
      images += 1;
      if (input.onImage) {
        await input.onImage(result);
        // Keep status only — drop bytes so we don't hold hundreds of PNGs in RAM
        out.set(result.customId, {
          customId: result.customId,
          contentType: result.contentType,
        });
      } else {
        out.set(result.customId, result);
      }
    } else {
      out.set(result.customId, result);
    }

    if (parsed === 1 || parsed % 25 === 0) {
      await input.onProgress?.(
        `AI Batch stream · ${parsed} lines · ${images} images…`,
      );
    }
  });

  // Ensure every request has an entry
  for (const req of input.requests) {
    if (!out.has(req.customId)) {
      out.set(req.customId, {
        customId: req.customId,
        error: "Missing from batch output",
      });
    }
  }

  await input.onProgress?.(
    `AI Batch parsed · ${images} images · ${parsed} lines`,
  );

  return out;
}

/** Download batch output and invoke onLine per JSONL row — never one giant string. */
export async function streamBatchOutputLines(
  outputFileId: string,
  onLine: (line: string) => Promise<void> | void,
): Promise<void> {
  const openai = createOpenAiImageClient();
  const raw = await openai.files.content(outputFileId);
  const body = (raw as unknown as { body?: ReadableStream<Uint8Array> | null })
    .body;

  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let carry = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line.trim()) await onLine(line);
      }
      // Hard safety: a single JSONL row should never approach Node string limits.
      if (carry.length > 80_000_000) {
        throw new Error(
          "AI Batch output line exceeded 80MB — refusing to buffer (corrupt/huge row)",
        );
      }
    }
    carry += decoder.decode();
    if (carry.trim()) await onLine(carry);
    return;
  }

  // Fallback: arrayBuffer + walk bytes for newlines (still avoids one .text())
  const buf = Buffer.from(await raw.arrayBuffer());
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    const line = buf.toString("utf8", start, i);
    start = i + 1;
    if (line.trim()) await onLine(line);
  }
  if (start < buf.length) {
    const line = buf.toString("utf8", start);
    if (line.trim()) await onLine(line);
  }
}

export function parseBatchOutputLine(line: string): BatchImageResult | null {
  let parsed: BatchLineOut;
  try {
    parsed = JSON.parse(line) as BatchLineOut;
  } catch {
    return null;
  }
  const customId = parsed.custom_id || "";
  if (!customId) return null;

  if (parsed.error?.message) {
    return { customId, error: parsed.error.message };
  }

  const status = parsed.response?.status_code ?? 0;
  const body = parsed.response?.body;
  if (status >= 400 || body?.error?.message) {
    return {
      customId,
      error: body?.error?.message || `HTTP ${status}`,
    };
  }

  const first = body?.data?.[0];
  if (!first) {
    return { customId, error: "No image data in batch response" };
  }

  if (first.b64_json) {
    return {
      customId,
      bytes: Buffer.from(first.b64_json, "base64"),
      contentType: "image/png",
    };
  }

  if (first.url) {
    // URL fetch is async — mark for caller; sync parse can't await here.
    // Store URL as error-ish marker? Better: return custom shape.
    // For streaming path we handle URL below in async helper.
    return {
      customId,
      error: `URL_PENDING:${first.url}`,
    };
  }

  return { customId, error: "Batch image missing b64_json and url" };
}

/** Resolve URL_PENDING errors into downloaded bytes. */
export async function resolvePendingBatchUrl(
  result: BatchImageResult,
): Promise<BatchImageResult> {
  const pending = result.error?.startsWith("URL_PENDING:")
    ? result.error.slice("URL_PENDING:".length)
    : null;
  if (!pending) return result;
  try {
    const res = await fetch(pending, {
      headers: { "User-Agent": "ScriptAssembler/1.0" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return { customId: result.customId, error: `Download failed (${res.status})` };
    }
    const contentType = (res.headers.get("content-type") || "image/png")
      .split(";")[0]
      .trim();
    return {
      customId: result.customId,
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: contentType.startsWith("image/") ? contentType : "image/png",
    };
  } catch (err) {
    return {
      customId: result.customId,
      error: err instanceof Error ? err.message : "Batch image URL download failed",
    };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
