import { NextResponse } from "next/server";
import { getContactBoxConfig } from "@/lib/contactbox";

export const dynamic = "force-dynamic";

export async function GET() {
  const { configured, baseURL, model } = getContactBoxConfig();

  return NextResponse.json({
    ok: true,
    service: "script-visual-assembler",
    time: new Date().toISOString(),
    contactbox: {
      configured,
      baseURL,
      model,
    },
  });
}
