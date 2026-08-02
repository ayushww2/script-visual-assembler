export function getContactBoxApiKey(): string {
  return process.env.CONTACTBOX_API_KEY || process.env.OPENAI_API_KEY || "";
}

export function getContactBoxBaseUrl(): string {
  return (
    process.env.CONTACTBOX_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://api.contactboxtools.me/v1"
  ).replace(/\/$/, "");
}

export function getContactBoxModel(): string {
  return (
    process.env.CONTACTBOX_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-5.6-terra"
  );
}

export function getSearchApiKey(): string {
  return process.env.SEARCHAPI_API_KEY || process.env.GOOGLE_SEARCH_API_KEY || "";
}

export function getSearchDefaults() {
  return {
    aspectRatio: process.env.SEARCH_ASPECT_RATIO || "wide",
    size: process.env.SEARCH_IMAGE_SIZE || "large",
    safe: (process.env.SEARCH_SAFE || "active") as "active" | "blur" | "off",
    minWidth: Number(process.env.SEARCH_MIN_WIDTH || "800"),
    minHeight: Number(process.env.SEARCH_MIN_HEIGHT || "450"),
    concurrency: Number(process.env.SEARCH_CONCURRENCY || "4"),
  };
}

export function getOpenAiImageConfig() {
  return {
    apiKey: process.env.OPENAI_IMAGE_API_KEY || "",
    baseURL: (
      process.env.OPENAI_IMAGE_BASE_URL || "https://api.openai.com/v1"
    ).replace(/\/$/, ""),
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
    size: process.env.OPENAI_IMAGE_SIZE || "1536x1024",
    quality: (process.env.OPENAI_IMAGE_QUALITY || "low") as
      | "low"
      | "medium"
      | "high"
      | "auto",
  };
}

/** Free stock B-roll — https://www.pexels.com/api/ */
export function getPexelsConfig() {
  const apiKey = (process.env.PEXELS_API_KEY || "").trim();
  const enabled =
    Boolean(apiKey) &&
    process.env.PEXELS_ENABLED !== "0" &&
    process.env.PEXELS_ENABLED !== "false";
  return {
    apiKey,
    enabled,
    /** Seconds of each clip Remotion should play (loop for longer narration). */
    useSec: Math.max(
      3,
      Math.min(12, Number(process.env.PEXELS_USE_SEC || "5") || 5),
    ),
    concurrency: Math.max(
      1,
      Number(process.env.PEXELS_CONCURRENCY || "2") || 2,
    ),
    /** Soft cap per job so we stay under the free hourly quota. */
    maxPerJob: Math.max(
      0,
      Number(process.env.PEXELS_MAX_PER_JOB || "40") || 40,
    ),
  };
}
