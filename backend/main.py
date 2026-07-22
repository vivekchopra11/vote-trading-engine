import os

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from kiteconnect import KiteConnect

app = FastAPI(
    title="VOTE Data Engine",
    version="0.2.0",
    description="Backend service for the Vivek Options Trading Engine",
)

frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
kite_api_key = os.getenv("KITE_API_KEY")
kite_api_secret = os.getenv("KITE_API_SECRET")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root() -> dict[str, str]:
    return {
        "application": "VOTE Data Engine",
        "version": "0.2.0",
        "status": "running",
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "healthy",
        "service": "vote-data-engine",
    }


@app.get("/auth/zerodha/login")
def zerodha_login() -> RedirectResponse:
    if not kite_api_key:
        raise HTTPException(
            status_code=500,
            detail="KITE_API_KEY is not configured",
        )

    kite = KiteConnect(api_key=kite_api_key)
    return RedirectResponse(url=kite.login_url())


@app.get("/auth/zerodha/callback")
def zerodha_callback(
    request_token: str = Query(...),
    status: str | None = Query(default=None),
) -> dict[str, str]:
    if status and status.lower() != "success":
        raise HTTPException(
            status_code=400,
            detail=f"Zerodha login failed with status: {status}",
        )

    if not kite_api_key or not kite_api_secret:
        raise HTTPException(
            status_code=500,
            detail="Zerodha credentials are not configured",
        )

    try:
        kite = KiteConnect(api_key=kite_api_key)
        session = kite.generate_session(
            request_token,
            api_secret=kite_api_secret,
        )

        # Temporary test only:
        # Do not return or log the access token.
        return {
            "status": "success",
            "message": "Zerodha authentication completed",
            "user_id": session.get("user_id", ""),
            "user_name": session.get("user_name", ""),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="Unable to complete Zerodha authentication",
        ) from exc