import { NextResponse } from "next/server";
import { createContactBoxClient, getContactBoxConfig } from "@/lib/contactbox";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = getContactBoxConfig();
  if (!config.configured) {
    return NextResponse.json(
      {
        ok: false,
        error: "CONTACTBOX_API_KEY is not configured",
        baseURL: config.baseURL,
        model: config.model,
      },
      { status: 503 },
    );
  }

  try {
    const client = createContactBoxClient();
    const models = await client.models.list();
    const ids = models.data.map((m) => m.id).sort();

    return NextResponse.json({
      ok: true,
      baseURL: config.baseURL,
      model: config.model,
      modelCount: ids.length,
      models: ids,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      {
        ok: false,
        error: message,
        baseURL: config.baseURL,
        model: config.model,
      },
      { status: 502 },
    );
  }
}
