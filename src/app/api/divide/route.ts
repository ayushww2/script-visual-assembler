import { NextResponse } from "next/server";
import { runScriptDivider } from "@/lib/divider/run";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      script?: string;
      phase?: "google-first" | "full";
    };
    const script = body.script?.trim();
    if (!script) {
      return NextResponse.json({ error: "script is required" }, { status: 400 });
    }

    const data = await runScriptDivider({
      script,
      phase: body.phase ?? "google-first",
    });

    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Divide failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
