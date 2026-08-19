Library
/
refresh_portfolio_route.ts


import { NextResponse } from "next/server";

const BACKEND_URL =
  process.env.VOTE_BACKEND_URL ??
  "https://vote-trading-engine-1.onrender.com";

export async function POST() {
  try {
    const response = await fetch(`${BACKEND_URL}/market/refresh-portfolio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    const payload = await response.json().catch(() => ({}));
    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        detail:
          error instanceof Error
            ? error.message
            : "Unable to reach the VOTE backend.",
      },
      { status: 502 },
    );
  }
}