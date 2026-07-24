import os
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from kiteconnect import KiteConnect
from supabase import Client, create_client

IST = ZoneInfo("Asia/Kolkata")

app = FastAPI(
    title="VOTE Data Engine",
    version="0.3.0",
    description="Backend service for the Vivek Options Trading Engine",
)

frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
kite_api_key = os.getenv("KITE_API_KEY")
kite_api_secret = os.getenv("KITE_API_SECRET")

supabase_url = os.getenv("SUPABASE_URL")
supabase_service_role_key = os.getenv(
    "SUPABASE_SERVICE_ROLE_KEY"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_supabase() -> Client:
    if not supabase_url or not supabase_service_role_key:
        raise HTTPException(
            status_code=500,
            detail="Supabase backend credentials are not configured",
        )

    return create_client(
        supabase_url,
        supabase_service_role_key,
    )


def calculate_token_expiry() -> datetime:
    now = datetime.now(IST)

    tomorrow = now.date() + timedelta(days=1)

    return datetime.combine(
        tomorrow,
        time(hour=6),
        tzinfo=IST,
    )


@app.get("/")
def root() -> dict[str, str]:
    return {
        "application": "VOTE Data Engine",
        "version": "0.3.0",
        "status": "running",
    }


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "healthy",
        "service": "vote-data-engine",
        "zerodha_configured": bool(
            kite_api_key and kite_api_secret
        ),
        "supabase_configured": bool(
            supabase_url and supabase_service_role_key
        ),
    }


@app.get("/auth/zerodha/login")
def zerodha_login() -> RedirectResponse:
    if not kite_api_key:
        raise HTTPException(
            status_code=500,
            detail="KITE_API_KEY is not configured",
        )

    kite = KiteConnect(api_key=kite_api_key)

    return RedirectResponse(
        url=kite.login_url(),
    )


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

        access_token = session.get("access_token")

        if not access_token:
            raise ValueError(
                "Zerodha did not return an access token"
            )

        database = get_supabase()
        now = datetime.now(IST)
        expires_at = calculate_token_expiry()

        # Disable any previous active Zerodha session.
        (
            database.table("broker_sessions")
            .update({"is_active": False})
            .eq("broker", "ZERODHA")
            .eq("is_active", True)
            .execute()
        )

        # Store the new daily access token.
        (
            database.table("broker_sessions")
            .insert(
                {
                    "broker": "ZERODHA",
                    "broker_user_id": session.get("user_id"),
                    "broker_user_name": session.get("user_name"),
                    "access_token": access_token,
                    "login_time": now.isoformat(),
                    "expires_at": expires_at.isoformat(),
                    "is_active": True,
                }
            )
            .execute()
        )

        return {
            "status": "success",
            "message": "Zerodha authentication completed and session stored",
            "user_id": session.get("user_id", ""),
            "user_name": session.get("user_name", ""),
            "expires_at": expires_at.isoformat(),
        }

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=(
                "Unable to complete or store Zerodha authentication: "
                f"{str(exc)}"
            ),
        ) from exc


@app.get("/auth/zerodha/status")
def zerodha_status() -> dict[str, object]:
    database = get_supabase()

    response = (
        database.table("broker_sessions")
        .select(
            "broker_user_id,"
            "broker_user_name,"
            "login_time,"
            "expires_at,"
            "is_active"
        )
        .eq("broker", "ZERODHA")
        .eq("is_active", True)
        .order("login_time", desc=True)
        .limit(1)
        .execute()
    )

    if not response.data:
        return {
            "broker": "ZERODHA",
            "status": "DISCONNECTED",
        }

    session = response.data[0]

    expires_at_value = session.get("expires_at")

    if expires_at_value:
        expires_at = datetime.fromisoformat(
            expires_at_value.replace("Z", "+00:00")
        )

        now = datetime.now(expires_at.tzinfo)

        if expires_at <= now:
            return {
                "broker": "ZERODHA",
                "status": "EXPIRED",
                "expires_at": expires_at_value,
            }

    return {
        "broker": "ZERODHA",
        "status": "CONNECTED",
        "user_id": session.get("broker_user_id"),
        "user_name": session.get("broker_user_name"),
        "login_time": session.get("login_time"),
        "expires_at": expires_at_value,
    }