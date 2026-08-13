import { NextRequest, NextResponse } from "next/server";

const DATA_ENGINE_URL =
  process.env.VOTE_DATA_ENGINE_URL ??
  process.env.NEXT_PUBLIC_VOTE_DATA_ENGINE_URL ??
  "https://vote-trading-engine-1.onrender.com";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const response = await fetch(
      `${DATA_ENGINE_URL}/market/refresh-strategy`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      },
    );

    const data = await response.json();

    return NextResponse.json(data, {
      status: response.status,
    });
  } catch (error) {
    return NextResponse.json(
      {
        detail:
          error instanceof Error
            ? error.message
            : "Unable to contact VOTE Data Engine.",
      },
      { status: 502 },
    );
  }
}
