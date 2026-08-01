import { NextResponse } from "next/server";
import { searchGoogleImages } from "@/lib/search/google";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      query?: string;
      queries?: string[];
      num?: number;
    };

    const queries = [
      ...(body.query ? [body.query] : []),
      ...(body.queries || []),
    ]
      .map((q) => q.trim())
      .filter(Boolean);

    if (!queries.length) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    const num = body.num ?? 6;
    const results = [];
    for (const query of queries.slice(0, 12)) {
      results.push(await searchGoogleImages(query, num));
    }

    return NextResponse.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
