import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL =
  process.env.VOTE_BACKEND_URL ??
  process.env.NEXT_PUBLIC_VOTE_BACKEND_URL ??
  "https://vote-trading-engine-1.onrender.com";

export async function POST(request: NextRequest) {
  const body = await request.text();
  try {
    const response = await fetch(new URL("/strategy/recalculate-margin", BACKEND_URL), {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
    const responseBody = await response.text();
    return new NextResponse(responseBody, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "Unable to reach the VOTE backend." },
      { status: 502 },
    );
  }
}
