import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL =
  process.env.VOTE_BACKEND_URL ??
  process.env.NEXT_PUBLIC_VOTE_BACKEND_URL ??
  "https://vote-trading-engine-1.onrender.com";

export async function GET(request: NextRequest) {
  const incoming = new URL(request.url);
  const target = new URL("/market/instruments", BACKEND_URL);

  incoming.searchParams.forEach((value, key) => {
    target.searchParams.set(key, value);
  });

  try {
    const response = await fetch(target, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });

    const body = await response.text();

    return new NextResponse(body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      },
    });
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
