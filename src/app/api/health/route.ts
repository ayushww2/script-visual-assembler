import { NextResponse } from "next/server";
import { getContactBoxConfig } from "@/lib/contactbox";
import { getSearchApiKey } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  const contactbox = getContactBoxConfig();
  return NextResponse.json({
    ok: true,
    service: "script-divider",
    time: new Date().toISOString(),
    contactbox: {
      configured: contactbox.configured,
      baseURL: contactbox.baseURL,
      model: contactbox.model,
    },
    searchapi: {
      configured: Boolean(getSearchApiKey()),
    },
  });
}
