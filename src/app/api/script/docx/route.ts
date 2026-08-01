import { NextResponse } from "next/server";
import {
  extractTextFromDocx,
  isDocxFile,
  MAX_DOCX_BYTES,
  titleFromDocxName,
} from "@/lib/script/docx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "file is required (multipart field: file)" },
        { status: 400 },
      );
    }

    if (!isDocxFile(file)) {
      return NextResponse.json(
        { error: "Only .docx Word documents are supported" },
        { status: 400 },
      );
    }

    if (file.size > MAX_DOCX_BYTES) {
      return NextResponse.json(
        { error: "DOCX is too large (max 8 MB)" },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const extracted = await extractTextFromDocx(buffer);

    return NextResponse.json({
      text: extracted.text,
      titleSuggestion: titleFromDocxName(file.name),
      filename: file.name,
      charCount: extracted.text.length,
      messages: extracted.messages,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to read DOCX";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
