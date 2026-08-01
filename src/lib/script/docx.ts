import mammoth from "mammoth";

const MAX_DOCX_BYTES = 8 * 1024 * 1024; // 8 MB

export function isDocxFile(file: {
  name?: string | null;
  type?: string | null;
}): boolean {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  return (
    name.endsWith(".docx") ||
    type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

export async function extractTextFromDocx(
  buffer: Buffer,
): Promise<{ text: string; messages: string[] }> {
  if (buffer.byteLength > MAX_DOCX_BYTES) {
    throw new Error("DOCX is too large (max 8 MB)");
  }
  if (buffer.byteLength < 4) {
    throw new Error("DOCX file is empty");
  }

  // DOCX is a ZIP; reject obvious non-docx early
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error("File does not look like a .docx (expected ZIP/OOXML)");
  }

  const result = await mammoth.extractRawText({ buffer });
  const text = normalizeScriptText(result.value);
  if (!text) {
    throw new Error("No readable text found in this DOCX");
  }

  return {
    text,
    messages: (result.messages || [])
      .map((m) => m.message)
      .filter(Boolean)
      .slice(0, 8),
  };
}

/** Collapse Word oddities into clean pasteable script text. */
export function normalizeScriptText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function titleFromDocxName(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() || filename;
  return base
    .replace(/\.docx$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export { MAX_DOCX_BYTES };
