import { createContactBoxClient, getContactBoxConfig } from "@/lib/contactbox";

/** gpt-5.6-terra · Aug 2026 list rates (USD per 1M tokens). */
export const TERRA_INPUT_USD_PER_M = 2;
export const TERRA_OUTPUT_USD_PER_M = 12;

export type SceneScanInput = {
  sceneId: string;
  index: number;
  words: string;
  imageUrl: string;
  visualSource?: string;
  subject?: string;
  query?: string;
};

export type SceneScanIssue = {
  sceneId: string;
  index: number;
  severity: "critical" | "minor" | "ok";
  issue: string;
  words: string;
  imageUrl: string;
};

export type SceneScanResult = {
  scanned: number;
  issues: SceneScanIssue[];
  ok: number;
  critical: number;
  minor: number;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  model: string;
  batches: number;
};

const SCAN_SYSTEM = `You are a documentary visual QA reviewer for YouTube Mystery films.

For each scene you receive sceneId, spoken narration (words), and a still image.

Judge whether the still honestly supports what is being said RIGHT NOW.

Flag problems such as:
- wrong person (e.g. Andrew Garfield instead of Mel Gibson)
- movie poster / thumbnail / meme / quote card / logo graphic
- watermark or stock-photo junk
- CGI / 3D sculpt / digital art instead of documentary photo
- empty chair / vacant interview prop when narration is about a person or event
- place/artifact mismatch (wrong location, wrong film still, unrelated B-roll)
- readable text overlays that dominate the frame
- dual-person collage when beat is about one person

Return JSON only:
{
  "reviews": [
    { "sceneId": "1", "severity": "ok"|"minor"|"critical", "issue": "short reason or empty if ok" }
  ]
}`;

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Model did not return valid JSON");
  }
}

function costFromUsage(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * TERRA_INPUT_USD_PER_M +
    (outputTokens / 1_000_000) * TERRA_OUTPUT_USD_PER_M
  );
}

async function imageToDataUrl(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Image fetch ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type") || "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export async function scanSceneBatch(
  scenes: SceneScanInput[],
  batchIndex: number,
  batchCount: number,
): Promise<{
  reviews: SceneScanIssue[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}> {
  const { model } = getContactBoxConfig();
  const client = createContactBoxClient();

  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail: "low" } }
  > = [
    {
      type: "text",
      text: `Batch ${batchIndex + 1}/${batchCount}. Review ${scenes.length} scene(s). Read words then inspect each image.\n`,
    },
  ];

  for (const scene of scenes) {
    userContent.push({
      type: "text",
      text: `\n--- sceneId=${scene.sceneId} index=${scene.index} ---\nwords: ${scene.words}\n`,
    });
    const dataUrl = await imageToDataUrl(scene.imageUrl);
    userContent.push({
      type: "image_url",
      image_url: { url: dataUrl, detail: "low" },
    });
  }

  userContent.push({
    type: "text",
    text: `\nReturn reviews for: ${scenes.map((s) => s.sceneId).join(", ")}`,
  });

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SCAN_SYSTEM },
      { role: "user", content: userContent },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Empty scan response");

  const parsed = extractJson(content) as {
    reviews?: Array<{
      sceneId?: string;
      severity?: string;
      issue?: string;
    }>;
  };

  const byId = new Map(scenes.map((s) => [s.sceneId, s]));
  const reviews: SceneScanIssue[] = [];

  for (const row of parsed.reviews || []) {
    const scene = byId.get(String(row.sceneId || ""));
    if (!scene) continue;
    const sev =
      row.severity === "critical" || row.severity === "minor" ? row.severity : "ok";
    reviews.push({
      sceneId: scene.sceneId,
      index: scene.index,
      severity: sev,
      issue: (row.issue || "").trim() || (sev === "ok" ? "" : "unspecified mismatch"),
      words: scene.words,
      imageUrl: scene.imageUrl,
    });
  }

  for (const scene of scenes) {
    if (reviews.some((r) => r.sceneId === scene.sceneId)) continue;
    reviews.push({
      sceneId: scene.sceneId,
      index: scene.index,
      severity: "minor",
      issue: "scan batch did not return a verdict for this scene",
      words: scene.words,
      imageUrl: scene.imageUrl,
    });
  }

  return {
    reviews,
    model,
    usage: {
      inputTokens: completion.usage?.prompt_tokens || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
    },
  };
}

export async function scanSceneBatchText(
  scenes: SceneScanInput[],
  batchIndex: number,
  batchCount: number,
): Promise<{
  reviews: SceneScanIssue[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}> {
  const { model } = getContactBoxConfig();
  const client = createContactBoxClient();

  const lines = scenes.map(
    (s) =>
      `sceneId=${s.sceneId} index=${s.index}\nwords: ${s.words}\nsource: ${s.visualSource || "?"} · subject: ${s.subject || "—"} · query: ${s.query || "—"}\nimageUrl: ${s.imageUrl}`,
  );

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `${SCAN_SYSTEM}\n\nYou cannot see images — infer likely mismatches from words vs subject/query/source metadata and common failure patterns (posters, wrong person queries, AI on photographable subjects, imdb/youtube/etsy domains, etc.).`,
      },
      {
        role: "user",
        content: `Batch ${batchIndex + 1}/${batchCount}. Review ${scenes.length} scenes (metadata only):\n\n${lines.join("\n\n---\n\n")}`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Empty scan response");

  const parsed = extractJson(content) as {
    reviews?: Array<{ sceneId?: string; severity?: string; issue?: string }>;
  };
  const byId = new Map(scenes.map((s) => [s.sceneId, s]));
  const reviews: SceneScanIssue[] = [];

  for (const row of parsed.reviews || []) {
    const scene = byId.get(String(row.sceneId || ""));
    if (!scene) continue;
    const sev =
      row.severity === "critical" || row.severity === "minor" ? row.severity : "ok";
    reviews.push({
      sceneId: scene.sceneId,
      index: scene.index,
      severity: sev,
      issue: (row.issue || "").trim() || (sev === "ok" ? "" : "unspecified mismatch"),
      words: scene.words,
      imageUrl: scene.imageUrl,
    });
  }

  for (const scene of scenes) {
    if (reviews.some((r) => r.sceneId === scene.sceneId)) continue;
    reviews.push({
      sceneId: scene.sceneId,
      index: scene.index,
      severity: "minor",
      issue: "scan batch did not return a verdict for this scene",
      words: scene.words,
      imageUrl: scene.imageUrl,
    });
  }

  return {
    reviews,
    model,
    usage: {
      inputTokens: completion.usage?.prompt_tokens || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
    },
  };
}

export async function scanAllScenesText(
  scenes: SceneScanInput[],
  opts?: { batchSize?: number; concurrency?: number },
): Promise<SceneScanResult> {
  const batchSize = Math.max(1, opts?.batchSize ?? 30);
  const concurrency = Math.max(1, opts?.concurrency ?? 2);
  const batches: SceneScanInput[][] = [];
  for (let i = 0; i < scenes.length; i += batchSize) {
    batches.push(scenes.slice(i, i + batchSize));
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let model = getContactBoxConfig().model;
  const allReviews: SceneScanIssue[] = [];

  for (let i = 0; i < batches.length; i += concurrency) {
    const slice = batches.slice(i, i + concurrency);
    const results = await Promise.all(
      slice.map((batch, offset) =>
        scanSceneBatchText(batch, i + offset, batches.length),
      ),
    );
    for (const r of results) {
      allReviews.push(...r.reviews);
      inputTokens += r.usage.inputTokens;
      outputTokens += r.usage.outputTokens;
      model = r.model;
    }
  }

  const issues = allReviews.filter((r) => r.severity !== "ok");
  return {
    scanned: scenes.length,
    issues,
    ok: scenes.length - issues.length,
    critical: issues.filter((r) => r.severity === "critical").length,
    minor: issues.filter((r) => r.severity === "minor").length,
    usage: { inputTokens, outputTokens },
    costUsd: costFromUsage(inputTokens, outputTokens),
    model,
    batches: batches.length,
  };
}

/** Vision-scan scenes in batches (default 1 scene / call for reliability). */
export async function scanAllScenes(
  scenes: SceneScanInput[],
  opts?: { batchSize?: number; concurrency?: number },
): Promise<SceneScanResult> {
  const batchSize = Math.max(1, opts?.batchSize ?? 1);
  const concurrency = Math.max(1, opts?.concurrency ?? 1);

  const batches: SceneScanInput[][] = [];
  for (let i = 0; i < scenes.length; i += batchSize) {
    batches.push(scenes.slice(i, i + batchSize));
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let model = getContactBoxConfig().model;
  const allReviews: SceneScanIssue[] = [];

  for (let i = 0; i < batches.length; i += concurrency) {
    const slice = batches.slice(i, i + concurrency);
    const results = await Promise.all(
      slice.map((batch, offset) =>
        scanSceneBatch(batch, i + offset, batches.length),
      ),
    );
    for (const r of results) {
      allReviews.push(...r.reviews);
      inputTokens += r.usage.inputTokens;
      outputTokens += r.usage.outputTokens;
      model = r.model;
    }
  }

  const issues = allReviews.filter((r) => r.severity !== "ok");
  const critical = issues.filter((r) => r.severity === "critical").length;
  const minor = issues.filter((r) => r.severity === "minor").length;

  return {
    scanned: scenes.length,
    issues,
    ok: scenes.length - issues.length,
    critical,
    minor,
    usage: { inputTokens, outputTokens },
    costUsd: costFromUsage(inputTokens, outputTokens),
    model,
    batches: batches.length,
  };
}
