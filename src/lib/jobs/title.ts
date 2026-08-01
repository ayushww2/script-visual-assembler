export function deriveJobTitle(script: string): string {
  const trimmed = script.trim();
  if (!trimmed) return "Untitled job";

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed) as {
        segments?: Array<{ text?: string }>;
        beats?: Array<{ text?: string }>;
      };
      const segs = data.segments || data.beats || [];
      const first = segs.find((s) => s.text?.trim())?.text?.trim();
      if (first) return clip(first);
    } catch {
      // fall through
    }
  }

  const line =
    trimmed
      .split(/\n/)
      .map((l) => l.trim())
      .find(Boolean) || trimmed;
  return clip(line);
}

function clip(text: string, max = 72): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}
