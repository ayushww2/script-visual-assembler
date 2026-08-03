import { NextResponse } from "next/server";
import { getContactBoxConfig } from "@/lib/contactbox";
import { getOpenAiImageConfig, getSearchApiKey } from "@/lib/env";
import { prisma } from "@/lib/db";
import {
  countTodaysPreviewQueries,
  DAILY_QUERY_SOFT_LIMIT,
} from "@/lib/jobs/limits";

export const dynamic = "force-dynamic";

export async function GET() {
  const contactbox = getContactBoxConfig();
  let dbOk = false;
  let usedToday = 0;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    usedToday = await countTodaysPreviewQueries();
  } catch {
    dbOk = false;
  }

  return NextResponse.json({
    ok: dbOk && contactbox.configured,
    service: "script-divider",
    time: new Date().toISOString(),
    database: { configured: Boolean(process.env.DATABASE_URL), ok: dbOk },
    contactbox: {
      configured: contactbox.configured,
      baseURL: contactbox.baseURL,
      model: contactbox.model,
    },
    searchapi: {
      configured: Boolean(getSearchApiKey()),
    },
    openaiImage: {
      configured: Boolean(getOpenAiImageConfig().apiKey),
      model: getOpenAiImageConfig().model,
      size: getOpenAiImageConfig().size,
      quality: getOpenAiImageConfig().quality,
    },
    capacity: {
      usedToday,
      softLimit: DAILY_QUERY_SOFT_LIMIT,
      remaining: Math.max(0, DAILY_QUERY_SOFT_LIMIT - usedToday),
    },
    features: {
      reviewScan: 3,
    },
  });
}
