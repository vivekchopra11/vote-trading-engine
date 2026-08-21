import os
import math
import time as time_module
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from kiteconnect import KiteConnect
from pydantic import BaseModel, Field
from supabase import Client, create_client
from observation_engine import capture_strategy_observations

IST = ZoneInfo("Asia/Kolkata")

app = FastAPI(
    title="VOTE Data Engine",
    version="0.8.0",
    description="Backend service for the Vivek Options Trading Engine",
)

frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
kite_api_key = os.getenv("KITE_API_KEY")
kite_api_secret = os.getenv("KITE_API_SECRET")
supabase_url = os.getenv("SUPABASE_URL")
supabase_service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
RISK_FREE_RATE = float(os.getenv("GREEKS_RISK_FREE_RATE", "0.06"))
DIVIDEND_YIELD = float(os.getenv("GREEKS_DIVIDEND_YIELD", "0.0"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ResolveInstrumentRequest(BaseModel):
    symbol: str
    instrument_type: str
    expiry: date
    strike: float | None = None
    option_type: str | None = None


class MarketQuotesRequest(BaseModel):
    instruments: list[str] = Field(min_length=1, max_length=500)


class RefreshStrategyRequest(BaseModel):
    strategy_id: str = Field(min_length=1)


class PortfolioSnapshotRequest(BaseModel):
    snapshot_date: date | None = None


class PortfolioSettingsRequest(BaseModel):
    deployable_capital: float = Field(gt=0)
    target_return_pct: float = Field(gt=0, le=100)


def get_supabase() -> Client:
    if not supabase_url or not supabase_service_role_key:
        raise HTTPException(
            status_code=500,
            detail="Supabase backend credentials are not configured",
        )
    return create_client(supabase_url, supabase_service_role_key)


def calculate_token_expiry() -> datetime:
    now = datetime.now(IST)
    tomorrow = now.date() + timedelta(days=1)
    return datetime.combine(tomorrow, time(hour=6), tzinfo=IST)


def parse_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def parse_date_value(value: Any) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def get_active_zerodha_session() -> dict[str, Any]:
    database = get_supabase()
    response = (
        database.table("broker_sessions")
        .select(
            "broker_user_id,broker_user_name,access_token,"
            "login_time,expires_at,is_active"
        )
        .eq("broker", "ZERODHA")
        .eq("is_active", True)
        .order("login_time", desc=True)
        .limit(1)
        .execute()
    )

    if not response.data:
        raise HTTPException(
            status_code=401,
            detail="Zerodha is not connected. Open /auth/zerodha/login to authenticate.",
        )

    session = response.data[0]
    access_token = session.get("access_token")
    expires_at_value = session.get("expires_at")

    if not access_token:
        raise HTTPException(
            status_code=401,
            detail="The active Zerodha session has no access token.",
        )

    if expires_at_value:
        expires_at = parse_datetime(expires_at_value)
        now = datetime.now(expires_at.tzinfo)
        if expires_at <= now:
            raise HTTPException(
                status_code=401,
                detail="The Zerodha session has expired. Open /auth/zerodha/login to authenticate again.",
            )

    return session


def get_kite_client() -> KiteConnect:
    if not kite_api_key:
        raise HTTPException(status_code=500, detail="KITE_API_KEY is not configured")
    session = get_active_zerodha_session()
    kite = KiteConnect(api_key=kite_api_key)
    kite.set_access_token(session["access_token"])
    return kite


def serialize_instrument(instrument: dict[str, Any]) -> dict[str, Any]:
    serialized: dict[str, Any] = {}
    for key, value in instrument.items():
        if isinstance(value, (datetime, date)):
            serialized[key] = value.isoformat()
        else:
            serialized[key] = value
    return serialized


def instrument_matches_underlying(instrument: dict[str, Any], underlying: str) -> bool:
    normalized = underlying.strip().upper()
    name = str(instrument.get("name") or "").strip().upper()
    return name == normalized


def resolve_from_instruments(
    instruments: list[dict[str, Any]],
    *,
    symbol: str,
    instrument_type: str,
    expiry: date,
    strike: float | None = None,
    option_type: str | None = None,
) -> dict[str, Any]:
    normalized_symbol = symbol.strip().upper()
    normalized_instrument_type = instrument_type.strip().upper()

    if normalized_instrument_type == "OPTION":
        if option_type is None:
            raise HTTPException(status_code=422, detail="option_type is required for OPTION.")
        normalized_option_type = option_type.strip().upper()
        if normalized_option_type not in {"CE", "PE"}:
            raise HTTPException(status_code=422, detail="option_type must be CE or PE.")
        if strike is None or strike <= 0:
            raise HTTPException(status_code=422, detail="A positive strike is required for OPTION.")
        target_kite_type = normalized_option_type
    elif normalized_instrument_type == "FUTURE":
        target_kite_type = "FUT"
    else:
        raise HTTPException(
            status_code=422,
            detail="instrument_type must be OPTION or FUTURE for NFO instrument resolution.",
        )

    matches: list[dict[str, Any]] = []
    for instrument in instruments:
        if not instrument_matches_underlying(instrument, normalized_symbol):
            continue
        item_type = str(instrument.get("instrument_type") or "").strip().upper()
        if item_type != target_kite_type:
            continue
        item_expiry = parse_date_value(instrument.get("expiry"))
        if item_expiry != expiry:
            continue
        if normalized_instrument_type == "OPTION":
            item_strike = float(instrument.get("strike") or 0)
            if abs(item_strike - float(strike)) > 0.0001:
                continue
        matches.append(instrument)

    if not matches:
        description = f"{normalized_symbol} {expiry.isoformat()} {target_kite_type}"
        if normalized_instrument_type == "OPTION":
            description += f" {strike}"
        raise HTTPException(status_code=404, detail=f"No Zerodha instrument found for {description}.")

    if len(matches) > 1:
        raise HTTPException(
            status_code=409,
            detail="Multiple Zerodha instruments matched this contract. Review symbol, expiry, strike and option type.",
        )

    return matches[0]




def underlying_quote_key(symbol: str) -> str:
    normalized = symbol.strip().upper()

    index_symbols = {
        "NIFTY": "NSE:NIFTY 50",
        "NIFTY50": "NSE:NIFTY 50",
        "BANKNIFTY": "NSE:NIFTY BANK",
        "FINNIFTY": "NSE:NIFTY FIN SERVICE",
        "MIDCPNIFTY": "NSE:NIFTY MID SELECT",
        "SENSEX": "BSE:SENSEX",
    }

    return index_symbols.get(normalized, f"NSE:{normalized}")

def calculate_position_mtm(
    *,
    side: str,
    entry_price: float,
    current_price: float,
    open_quantity: float,
    contract_multiplier: float,
) -> float:
    normalized_side = side.strip().upper()
    if normalized_side == "BUY":
        mtm = (current_price - entry_price) * open_quantity * contract_multiplier
    elif normalized_side == "SELL":
        mtm = (entry_price - current_price) * open_quantity * contract_multiplier
    else:
        raise ValueError(f"Unsupported position side: {side}")
    return round(mtm, 2)


def _normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def _normal_pdf(value: float) -> float:
    return math.exp(-0.5 * value * value) / math.sqrt(2.0 * math.pi)


def _option_time_to_expiry(expiry_value: Any) -> float | None:
    expiry = parse_date_value(expiry_value)
    if not expiry:
        return None
    expiry_dt = datetime.combine(expiry, time(hour=15, minute=30), tzinfo=IST)
    seconds = (expiry_dt - datetime.now(IST)).total_seconds()
    if seconds <= 0:
        return None
    return seconds / (365.0 * 24.0 * 60.0 * 60.0)


def _black_scholes_price(
    *,
    spot: float,
    strike: float,
    time_years: float,
    volatility: float,
    option_type: str,
    risk_free_rate: float = RISK_FREE_RATE,
    dividend_yield: float = DIVIDEND_YIELD,
) -> float:
    if spot <= 0 or strike <= 0 or time_years <= 0 or volatility <= 0:
        return 0.0
    sqrt_t = math.sqrt(time_years)
    d1 = (
        math.log(spot / strike)
        + (risk_free_rate - dividend_yield + 0.5 * volatility * volatility) * time_years
    ) / (volatility * sqrt_t)
    d2 = d1 - volatility * sqrt_t
    discounted_spot = spot * math.exp(-dividend_yield * time_years)
    discounted_strike = strike * math.exp(-risk_free_rate * time_years)
    if option_type == "CE":
        return discounted_spot * _normal_cdf(d1) - discounted_strike * _normal_cdf(d2)
    return discounted_strike * _normal_cdf(-d2) - discounted_spot * _normal_cdf(-d1)


def solve_implied_volatility(
    *,
    market_price: float,
    spot: float,
    strike: float,
    time_years: float,
    option_type: str,
) -> float | None:
    if market_price <= 0 or spot <= 0 or strike <= 0 or time_years <= 0:
        return None
    discounted_spot = spot * math.exp(-DIVIDEND_YIELD * time_years)
    discounted_strike = strike * math.exp(-RISK_FREE_RATE * time_years)
    intrinsic_floor = (
        max(0.0, discounted_spot - discounted_strike)
        if option_type == "CE"
        else max(0.0, discounted_strike - discounted_spot)
    )
    if market_price + 1e-8 < intrinsic_floor:
        return None
    low, high = 0.0001, 5.0
    high_price = _black_scholes_price(
        spot=spot, strike=strike, time_years=time_years, volatility=high, option_type=option_type
    )
    if market_price > high_price + 1e-6:
        return None
    for _ in range(80):
        mid = (low + high) / 2.0
        model_price = _black_scholes_price(
            spot=spot, strike=strike, time_years=time_years, volatility=mid, option_type=option_type
        )
        if abs(model_price - market_price) < 1e-7:
            return mid
        if model_price < market_price:
            low = mid
        else:
            high = mid
    return (low + high) / 2.0


def calculate_position_greeks(
    *,
    position: dict[str, Any],
    current_price: float,
    spot: float,
) -> dict[str, float | None]:
    instrument_type = str(position.get("instrument_type") or "").strip().upper()
    side = str(position.get("position_side") or "").strip().upper()
    sign = 1.0 if side == "BUY" else -1.0
    quantity = float(position.get("open_quantity") or 0)
    multiplier = float(position.get("contract_multiplier") or 1)
    exposure = quantity * multiplier

    if instrument_type in {"FUTURE", "EQUITY"}:
        return {
            "implied_volatility": None,
            "delta": round(sign * exposure, 4),
            "gamma": 0.0,
            "theta": 0.0,
            "vega": 0.0,
        }

    if instrument_type != "OPTION":
        return {"implied_volatility": None, "delta": None, "gamma": None, "theta": None, "vega": None}

    strike = float(position.get("strike") or 0)
    option_type = str(position.get("option_type") or "").strip().upper()
    time_years = _option_time_to_expiry(position.get("expiry_date"))
    if strike <= 0 or option_type not in {"CE", "PE"} or time_years is None:
        return {"implied_volatility": None, "delta": None, "gamma": None, "theta": None, "vega": None}

    iv = solve_implied_volatility(
        market_price=current_price, spot=spot, strike=strike, time_years=time_years, option_type=option_type
    )
    if iv is None:
        return {"implied_volatility": None, "delta": None, "gamma": None, "theta": None, "vega": None}

    sqrt_t = math.sqrt(time_years)
    d1 = (
        math.log(spot / strike)
        + (RISK_FREE_RATE - DIVIDEND_YIELD + 0.5 * iv * iv) * time_years
    ) / (iv * sqrt_t)
    d2 = d1 - iv * sqrt_t
    exp_q = math.exp(-DIVIDEND_YIELD * time_years)
    exp_r = math.exp(-RISK_FREE_RATE * time_years)
    pdf_d1 = _normal_pdf(d1)

    if option_type == "CE":
        delta_unit = exp_q * _normal_cdf(d1)
        theta_annual_unit = (
            -(spot * exp_q * pdf_d1 * iv) / (2.0 * sqrt_t)
            - RISK_FREE_RATE * strike * exp_r * _normal_cdf(d2)
            + DIVIDEND_YIELD * spot * exp_q * _normal_cdf(d1)
        )
    else:
        delta_unit = exp_q * (_normal_cdf(d1) - 1.0)
        theta_annual_unit = (
            -(spot * exp_q * pdf_d1 * iv) / (2.0 * sqrt_t)
            + RISK_FREE_RATE * strike * exp_r * _normal_cdf(-d2)
            - DIVIDEND_YIELD * spot * exp_q * _normal_cdf(-d1)
        )

    gamma_unit = exp_q * pdf_d1 / (spot * iv * sqrt_t)
    vega_unit_per_vol_point = spot * exp_q * pdf_d1 * sqrt_t / 100.0

    return {
        "implied_volatility": round(iv * 100.0, 4),
        "delta": round(sign * delta_unit * exposure, 4),
        "gamma": round(sign * gamma_unit * exposure, 6),
        "theta": round(sign * (theta_annual_unit / 365.0) * exposure, 2),
        "vega": round(sign * vega_unit_per_vol_point * exposure, 2),
    }




def calculate_position_delta_at_spot(
    *,
    position: dict[str, Any],
    shocked_spot: float,
    implied_volatility_pct: float | None,
) -> float | None:
    """Recalculate position delta at a shocked spot while holding current IV constant."""
    instrument_type = str(position.get("instrument_type") or "").strip().upper()
    side = str(position.get("position_side") or "").strip().upper()
    sign = 1.0 if side == "BUY" else -1.0
    quantity = float(position.get("open_quantity") or 0)
    multiplier = float(position.get("contract_multiplier") or 1)
    exposure = quantity * multiplier

    if instrument_type in {"FUTURE", "EQUITY"}:
        return sign * exposure

    if instrument_type != "OPTION" or implied_volatility_pct is None:
        return None

    strike = float(position.get("strike") or 0)
    option_type = str(position.get("option_type") or "").strip().upper()
    time_years = _option_time_to_expiry(position.get("expiry_date"))
    volatility = float(implied_volatility_pct) / 100.0

    if (
        shocked_spot <= 0
        or strike <= 0
        or option_type not in {"CE", "PE"}
        or time_years is None
        or volatility <= 0
    ):
        return None

    sqrt_t = math.sqrt(time_years)
    d1 = (
        math.log(shocked_spot / strike)
        + (RISK_FREE_RATE - DIVIDEND_YIELD + 0.5 * volatility * volatility) * time_years
    ) / (volatility * sqrt_t)
    exp_q = math.exp(-DIVIDEND_YIELD * time_years)

    if option_type == "CE":
        delta_unit = exp_q * _normal_cdf(d1)
    else:
        delta_unit = exp_q * (_normal_cdf(d1) - 1.0)

    return sign * delta_unit * exposure


def calculate_position_spot_shock_pnl(
    *,
    position: dict[str, Any],
    current_price: float,
    current_spot: float,
    shocked_spot: float,
    implied_volatility_pct: float | None,
) -> float | None:
    """Reprice a leg at shocked spot, holding today's IV and time constant."""
    instrument_type = str(position.get("instrument_type") or "").strip().upper()
    side = str(position.get("position_side") or "").strip().upper()
    sign = 1.0 if side == "BUY" else -1.0
    quantity = float(position.get("open_quantity") or 0)
    multiplier = float(position.get("contract_multiplier") or 1)
    exposure = quantity * multiplier

    if instrument_type in {"FUTURE", "EQUITY"}:
        return sign * (shocked_spot - current_spot) * exposure

    if instrument_type != "OPTION" or implied_volatility_pct is None:
        return None

    strike = float(position.get("strike") or 0)
    option_type = str(position.get("option_type") or "").strip().upper()
    time_years = _option_time_to_expiry(position.get("expiry_date"))
    volatility = float(implied_volatility_pct) / 100.0

    if (
        shocked_spot <= 0
        or strike <= 0
        or option_type not in {"CE", "PE"}
        or time_years is None
        or volatility <= 0
    ):
        return None

    shocked_price = _black_scholes_price(
        spot=shocked_spot,
        strike=strike,
        time_years=time_years,
        volatility=volatility,
        option_type=option_type,
    )

    return sign * (shocked_price - current_price) * exposure


def build_margin_orders(positions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    orders: list[dict[str, Any]] = []

    for position in positions:
        quantity = int(float(position.get("open_quantity") or 0))
        if quantity <= 0:
            continue

        exchange = str(position.get("exchange") or "").strip().upper()
        tradingsymbol = str(position.get("tradingsymbol") or "").strip().upper()
        instrument_type = str(position.get("instrument_type") or "").strip().upper()
        side = str(position.get("position_side") or "").strip().upper()

        if not exchange or not tradingsymbol or side not in {"BUY", "SELL"}:
            continue

        orders.append(
            {
                "exchange": exchange,
                "tradingsymbol": tradingsymbol,
                "transaction_type": side,
                "variety": "regular",
                "product": "CNC" if instrument_type == "EQUITY" else "NRML",
                "order_type": "MARKET",
                "quantity": quantity,
                "price": 0,
                "trigger_price": 0,
            }
        )

    # Protective long legs first. This keeps the basket's initial margin realistic.
    return sorted(orders, key=lambda order: 0 if order["transaction_type"] == "BUY" else 1)


def calculate_strategy_margin(
    kite: KiteConnect,
    positions: list[dict[str, Any]],
) -> dict[str, float | str | None]:
    orders = build_margin_orders(positions)

    if not orders:
        return {
            "margin_used": 0.0,
            "initial_margin": 0.0,
            "margin_status": "CURRENT",
        }

    try:
        # consider_positions=False intentionally isolates this strategy so that
        # strategies can be compared on a like-for-like capital basis.
        response = kite.basket_order_margins(
            orders,
            consider_positions=False,
            mode="compact",
        )

        initial = response.get("initial") or {}
        final = response.get("final") or {}

        return {
            "margin_used": round(float(final.get("total") or 0), 2),
            "initial_margin": round(float(initial.get("total") or 0), 2),
            "margin_status": "CURRENT",
        }
    except Exception as exc:
        return {
            "margin_used": None,
            "initial_margin": None,
            "margin_status": f"UNAVAILABLE: {str(exc)}",
        }


def strategy_month_key(strategy: dict[str, Any]) -> str:
    value = strategy.get("expiry_month") or strategy.get("entry_date")
    if not value:
        return datetime.now(IST).strftime("%Y-%m")
    return str(value)[:7]


def upsert_portfolio_snapshot(
    database: Client,
    snapshot_date: date,
) -> dict[str, Any]:
    month_key = snapshot_date.strftime("%Y-%m")

    settings_response = (
        database.table("portfolio_settings")
        .select("deployable_capital,target_return_pct")
        .eq("id", 1)
        .limit(1)
        .execute()
    )
    settings = settings_response.data[0] if settings_response.data else {}
    deployable_capital = float(settings.get("deployable_capital") or 0)
    target_return_pct = float(settings.get("target_return_pct") or 5.5)

    strategies_response = (
        database.table("strategy_master")
        .select(
            "strategy_id,status,entry_date,expiry_month,realised_pnl,"
            "unrealised_mtm,total_pnl,margin_used,margin_status"
        )
        .execute()
    )
    strategies = strategies_response.data or []
    month_strategies = [s for s in strategies if strategy_month_key(s) == month_key]
    open_month_strategies = [s for s in month_strategies if s.get("status") != "CLOSED"]

    realised_pnl = round(sum(float(s.get("realised_pnl") or 0) for s in month_strategies), 2)
    unrealised_mtm = round(sum(float(s.get("unrealised_mtm") or 0) for s in open_month_strategies), 2)
    net_pnl = round(realised_pnl + unrealised_mtm, 2)
    strategy_margin_sum = round(
        sum(
            float(s.get("margin_used") or 0)
            for s in open_month_strategies
            if str(s.get("margin_status") or "").startswith("CURRENT")
        ),
        2,
    )

    return_on_capital_pct = (
        round((net_pnl / deployable_capital) * 100, 4)
        if deployable_capital > 0
        else None
    )
    target_amount = (
        round(deployable_capital * target_return_pct / 100, 2)
        if deployable_capital > 0
        else None
    )
    target_achievement_pct = (
        round((net_pnl / target_amount) * 100, 2)
        if target_amount and target_amount != 0
        else None
    )

    daily_payload = {
        "snapshot_date": snapshot_date.isoformat(),
        "month_key": month_key,
        "deployable_capital": deployable_capital or None,
        "strategy_margin_sum": strategy_margin_sum,
        "realised_pnl": realised_pnl,
        "unrealised_mtm": unrealised_mtm,
        "net_pnl": net_pnl,
        "return_on_capital_pct": return_on_capital_pct,
        "target_return_pct": target_return_pct,
        "target_amount": target_amount,
        "target_achievement_pct": target_achievement_pct,
        "open_strategy_count": len(open_month_strategies),
        "closed_strategy_count": len([s for s in month_strategies if s.get("status") == "CLOSED"]),
        "captured_at": datetime.now(IST).isoformat(),
    }

    (
        database.table("portfolio_daily_snapshots")
        .upsert(daily_payload, on_conflict="snapshot_date")
        .execute()
    )

    month_daily_response = (
        database.table("portfolio_daily_snapshots")
        .select("strategy_margin_sum")
        .eq("month_key", month_key)
        .execute()
    )
    margin_values = [
        float(row.get("strategy_margin_sum") or 0)
        for row in (month_daily_response.data or [])
    ]
    average_margin_used = round(sum(margin_values) / len(margin_values), 2) if margin_values else 0.0
    peak_margin_used = round(max(margin_values), 2) if margin_values else 0.0
    return_on_avg_margin_pct = (
        round((net_pnl / average_margin_used) * 100, 4)
        if average_margin_used > 0
        else None
    )

    monthly_payload = {
        "month_key": month_key,
        "deployable_capital": deployable_capital or None,
        "closing_margin_used": strategy_margin_sum,
        "average_margin_used": average_margin_used,
        "peak_margin_used": peak_margin_used,
        "realised_pnl": realised_pnl,
        "closing_unrealised_mtm": unrealised_mtm,
        "net_pnl": net_pnl,
        "return_on_capital_pct": return_on_capital_pct,
        "return_on_avg_margin_pct": return_on_avg_margin_pct,
        "target_return_pct": target_return_pct,
        "target_amount": target_amount,
        "target_achievement_pct": target_achievement_pct,
        "updated_at": datetime.now(IST).isoformat(),
    }

    (
        database.table("portfolio_monthly_summary")
        .upsert(monthly_payload, on_conflict="month_key")
        .execute()
    )

    return {
        **daily_payload,
        "average_margin_used": average_margin_used,
        "peak_margin_used": peak_margin_used,
        "return_on_avg_margin_pct": return_on_avg_margin_pct,
    }


@app.get("/")
def root() -> dict[str, str]:
    return {"application": "VOTE Data Engine", "version": "0.8.0", "status": "running"}


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "healthy",
        "service": "vote-data-engine",
        "zerodha_configured": bool(kite_api_key and kite_api_secret),
        "supabase_configured": bool(supabase_url and supabase_service_role_key),
    }


@app.get("/auth/zerodha/login")
def zerodha_login() -> RedirectResponse:
    if not kite_api_key:
        raise HTTPException(status_code=500, detail="KITE_API_KEY is not configured")
    kite = KiteConnect(api_key=kite_api_key)
    return RedirectResponse(url=kite.login_url())


@app.get("/auth/zerodha/callback")
def zerodha_callback(
    request_token: str = Query(...),
    status: str | None = Query(default=None),
) -> dict[str, str]:
    if status and status.lower() != "success":
        raise HTTPException(status_code=400, detail=f"Zerodha login failed with status: {status}")
    if not kite_api_key or not kite_api_secret:
        raise HTTPException(status_code=500, detail="Zerodha credentials are not configured")

    try:
        kite = KiteConnect(api_key=kite_api_key)
        session = kite.generate_session(request_token, api_secret=kite_api_secret)
        access_token = session.get("access_token")
        if not access_token:
            raise ValueError("Zerodha did not return an access token")

        database = get_supabase()
        now = datetime.now(IST)
        expires_at = calculate_token_expiry()

        (
            database.table("broker_sessions")
            .update({"is_active": False})
            .eq("broker", "ZERODHA")
            .eq("is_active", True)
            .execute()
        )

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
            detail=f"Unable to complete or store Zerodha authentication: {str(exc)}",
        ) from exc


@app.get("/auth/zerodha/status")
def zerodha_status() -> dict[str, object]:
    database = get_supabase()
    response = (
        database.table("broker_sessions")
        .select("broker_user_id,broker_user_name,login_time,expires_at,is_active")
        .eq("broker", "ZERODHA")
        .eq("is_active", True)
        .order("login_time", desc=True)
        .limit(1)
        .execute()
    )

    if not response.data:
        return {"broker": "ZERODHA", "status": "DISCONNECTED"}

    session = response.data[0]
    expires_at_value = session.get("expires_at")
    if expires_at_value:
        expires_at = parse_datetime(expires_at_value)
        now = datetime.now(expires_at.tzinfo)
        if expires_at <= now:
            return {"broker": "ZERODHA", "status": "EXPIRED", "expires_at": expires_at_value}

    return {
        "broker": "ZERODHA",
        "status": "CONNECTED",
        "user_id": session.get("broker_user_id"),
        "user_name": session.get("broker_user_name"),
        "login_time": session.get("login_time"),
        "expires_at": expires_at_value,
    }


@app.get("/market/instruments")
def market_instruments(
    exchange: str = Query(default="NFO", min_length=2, max_length=10),
    underlying: str | None = Query(default=None),
    instrument_type: str | None = Query(default=None),
    expiry: date | None = Query(default=None),
    strike: float | None = Query(default=None, ge=0),
    limit: int = Query(default=100, ge=1, le=1000),
) -> dict[str, Any]:
    try:
        kite = get_kite_client()
        normalized_exchange = exchange.strip().upper()
        instruments = kite.instruments(normalized_exchange)
        normalized_underlying = underlying.strip().upper() if underlying else None
        normalized_type = instrument_type.strip().upper() if instrument_type else None

        filtered: list[dict[str, Any]] = []
        for instrument in instruments:
            if normalized_underlying and not instrument_matches_underlying(instrument, normalized_underlying):
                continue
            item_type = str(instrument.get("instrument_type") or "").strip().upper()
            if normalized_type and item_type != normalized_type:
                continue
            item_expiry = parse_date_value(instrument.get("expiry"))
            if expiry and item_expiry != expiry:
                continue
            item_strike = float(instrument.get("strike") or 0)
            if strike is not None and abs(item_strike - strike) > 0.0001:
                continue
            filtered.append(serialize_instrument(instrument))
            if len(filtered) >= limit:
                break

        return {
            "exchange": normalized_exchange,
            "filters": {
                "underlying": normalized_underlying,
                "instrument_type": normalized_type,
                "expiry": expiry.isoformat() if expiry else None,
                "strike": strike,
            },
            "count": len(filtered),
            "limit": limit,
            "instruments": filtered,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Unable to fetch Zerodha instruments: {str(exc)}") from exc

@app.post("/market/refresh-strategy")
def refresh_strategy(request: RefreshStrategyRequest) -> dict[str, Any]:
    """Fast market refresh: quotes + MTM + strategy P&L only.

    Margin and Observation Engine calculations are deliberately kept out of
    this blocking path. Existing stored margin values remain untouched.
    """
    database = get_supabase()

    try:
        strategy_response = (
            database.table("strategy_master")
            .select(
                "strategy_id,strategy_name,symbol,status,realised_pnl,"
                "current_spot_price,market_data_updated_at,margin_used,margin_status"
            )
            .eq("strategy_id", request.strategy_id)
            .limit(1)
            .execute()
        )

        if not strategy_response.data:
            raise HTTPException(status_code=404, detail="Strategy not found.")

        strategy = strategy_response.data[0]
        if strategy.get("status") == "CLOSED":
            raise HTTPException(
                status_code=409,
                detail="Closed strategies do not require market-price refresh.",
            )

        positions_response = (
            database.table("book_positions")
            .select(
                "id,strategy_id,symbol,instrument_type,option_type,strike,expiry_date,"
                "position_side,open_quantity,quantity,entry_price,current_price,"
                "contract_multiplier,exchange,tradingsymbol,instrument_token,lot_size,mtm"
            )
            .eq("strategy_id", request.strategy_id)
            .gt("open_quantity", 0)
            .execute()
        )

        positions = positions_response.data or []
        if not positions:
            return {
                "status": "no_open_positions",
                "strategy_id": request.strategy_id,
                "positions_updated": 0,
                "unrealised_mtm": 0,
                "message": "No open position quantities were found for this strategy.",
                "refreshed_at": datetime.now(IST).isoformat(),
            }

        kite = get_kite_client()
        symbol = str(strategy.get("symbol") or "").strip().upper()
        if not symbol:
            raise HTTPException(status_code=422, detail="Strategy has no underlying symbol.")

        spot_quote_key = underlying_quote_key(symbol)
        needs_resolution = any(
            str(position.get("instrument_type") or "").strip().upper() in {"OPTION", "FUTURE"}
            and (not position.get("tradingsymbol") or not position.get("instrument_token"))
            for position in positions
        )

        nfo_instruments: list[dict[str, Any]] = (
            kite.instruments("NFO") if needs_resolution else []
        )
        quote_keys: list[str] = []
        prepared_positions: list[dict[str, Any]] = []
        resolution_updates: list[tuple[int, dict[str, Any]]] = []

        for position in positions:
            position_id = int(position["id"])
            instrument_type = str(position.get("instrument_type") or "").strip().upper()
            exchange = str(position.get("exchange") or "").strip().upper()
            tradingsymbol = position.get("tradingsymbol")
            instrument_token = position.get("instrument_token")
            lot_size = position.get("lot_size")

            if instrument_type in {"OPTION", "FUTURE"}:
                if not tradingsymbol or not instrument_token:
                    expiry = parse_date_value(position.get("expiry_date"))
                    if not expiry:
                        raise HTTPException(
                            status_code=422,
                            detail=f"Position {position_id} has no expiry_date and cannot be resolved.",
                        )

                    position_symbol = str(
                        position.get("symbol") or strategy.get("symbol") or ""
                    ).strip().upper()
                    if not position_symbol:
                        raise HTTPException(
                            status_code=422,
                            detail=f"Position {position_id} has no underlying symbol.",
                        )

                    resolved = resolve_from_instruments(
                        nfo_instruments,
                        symbol=position_symbol,
                        instrument_type=instrument_type,
                        expiry=expiry,
                        strike=(
                            float(position["strike"])
                            if position.get("strike") is not None
                            else None
                        ),
                        option_type=position.get("option_type"),
                    )
                    tradingsymbol = resolved.get("tradingsymbol")
                    instrument_token = resolved.get("instrument_token")
                    exchange = str(resolved.get("exchange") or "NFO").upper()
                    lot_size = resolved.get("lot_size")
                    resolution_updates.append(
                        (
                            position_id,
                            {
                                "instrument_token": instrument_token,
                                "tradingsymbol": tradingsymbol,
                                "exchange": exchange,
                                "lot_size": lot_size,
                            },
                        )
                    )

                if not exchange:
                    exchange = "NFO"

            elif instrument_type == "EQUITY":
                if not tradingsymbol:
                    tradingsymbol = str(
                        position.get("symbol") or strategy.get("symbol") or ""
                    ).strip().upper()
                if not exchange:
                    exchange = "NSE"
            else:
                raise HTTPException(
                    status_code=422,
                    detail=f"Position {position_id} has unsupported instrument_type {instrument_type!r}.",
                )

            if not tradingsymbol or not exchange:
                raise HTTPException(
                    status_code=422,
                    detail=f"Position {position_id} does not have enough instrument metadata for a quote.",
                )

            quote_key = f"{exchange}:{tradingsymbol}"
            quote_keys.append(quote_key)
            prepared_positions.append(
                {
                    **position,
                    "exchange": exchange,
                    "tradingsymbol": tradingsymbol,
                    "instrument_token": instrument_token,
                    "lot_size": lot_size,
                    "_quote_key": quote_key,
                }
            )

        # Instrument metadata is only written when a position actually needed resolution.
        for position_id, metadata_update in resolution_updates:
            (
                database.table("book_positions")
                .update(metadata_update)
                .eq("id", position_id)
                .execute()
            )

        # One Zerodha quote request contains spot plus every open leg in this strategy.
        market_quote_keys = list(dict.fromkeys([spot_quote_key, *quote_keys]))
        raw_quotes = kite.quote(market_quote_keys)

        if spot_quote_key not in raw_quotes:
            raise HTTPException(
                status_code=502,
                detail=f"Zerodha did not return an underlying quote for {spot_quote_key}.",
            )

        current_spot_price = float(raw_quotes[spot_quote_key].get("last_price") or 0)
        if current_spot_price <= 0:
            raise HTTPException(
                status_code=502,
                detail=f"Zerodha returned an invalid underlying price for {spot_quote_key}.",
            )

        unresolved_quotes = [key for key in quote_keys if key not in raw_quotes]
        if unresolved_quotes:
            raise HTTPException(
                status_code=502,
                detail={
                    "message": "Zerodha did not return quotes for all open positions.",
                    "unresolved": unresolved_quotes,
                },
            )

        position_results: list[dict[str, Any]] = []
        total_unrealised_mtm = 0.0

        for position in prepared_positions:
            quote = raw_quotes[position["_quote_key"]]
            current_price_raw = quote.get("last_price")
            if current_price_raw is None:
                raise HTTPException(
                    status_code=502,
                    detail=f"Zerodha returned no last price for {position['_quote_key']}.",
                )

            current_price = float(current_price_raw)
            entry_price = float(position.get("entry_price") or 0)
            open_quantity = float(position.get("open_quantity") or 0)
            contract_multiplier = float(position.get("contract_multiplier") or 1)

            mtm = calculate_position_mtm(
                side=str(position.get("position_side") or ""),
                entry_price=entry_price,
                current_price=current_price,
                open_quantity=open_quantity,
                contract_multiplier=contract_multiplier,
            )

            greeks = calculate_position_greeks(
                position=position,
                current_price=current_price,
                spot=current_spot_price,
            )

            greeks_updated_at = datetime.now(IST).isoformat()
            update_payload = {
                "current_price": current_price,
                "mtm": mtm,
                "implied_volatility": greeks["implied_volatility"],
                "delta": greeks["delta"],
                "gamma": greeks["gamma"],
                "theta": greeks["theta"],
                "vega": greeks["vega"],
                "greeks_updated_at": greeks_updated_at,
            }
            database.table("book_positions").update(update_payload).eq("id", position["id"]).execute()

            total_unrealised_mtm += mtm
            position_results.append(
                {
                    "position_id": position["id"],
                    "instrument_type": position.get("instrument_type"),
                    "tradingsymbol": position.get("tradingsymbol"),
                    "instrument_token": position.get("instrument_token"),
                    "entry_price": entry_price,
                    "current_price": current_price,
                    "open_quantity": open_quantity,
                    "contract_multiplier": contract_multiplier,
                    "lot_size": position.get("lot_size"),
                    "mtm": mtm,
                    **greeks,
                }
            )

        total_unrealised_mtm = round(total_unrealised_mtm, 2)
        realised_pnl = float(strategy.get("realised_pnl") or 0)
        total_pnl = round(realised_pnl + total_unrealised_mtm, 2)
        refreshed_at = datetime.now(IST).isoformat()

        strategy_delta = round(sum(float(item.get("delta") or 0) for item in position_results), 4)
        strategy_gamma = round(sum(float(item.get("gamma") or 0) for item in position_results), 6)
        strategy_theta = round(sum(float(item.get("theta") or 0) for item in position_results), 2)
        strategy_vega = round(sum(float(item.get("vega") or 0) for item in position_results), 2)
        iv_rows = [
            (float(item["implied_volatility"]), float(item.get("open_quantity") or 0))
            for item in position_results
            if item.get("implied_volatility") is not None and float(item.get("open_quantity") or 0) > 0
        ]
        iv_weight = sum(weight for _, weight in iv_rows)
        weighted_iv = (
            round(sum(iv * weight for iv, weight in iv_rows) / iv_weight, 4)
            if iv_weight > 0
            else None
        )

        # Normalize directional exposure into futures-lot equivalents.
        # Prefer an actual futures contract lot size; otherwise use the derivative
        # lot size from an option on the same underlying. This keeps +1.00 lots
        # comparable across stocks regardless of the underlying price.
        futures_lot_size = next(
            (
                float(item.get("lot_size") or 0)
                for item in position_results
                if str(item.get("instrument_type") or "").strip().upper() == "FUTURE"
                and float(item.get("lot_size") or 0) > 0
            ),
            0.0,
        )
        if futures_lot_size <= 0:
            futures_lot_size = next(
                (
                    float(item.get("lot_size") or 0)
                    for item in position_results
                    if str(item.get("instrument_type") or "").strip().upper() == "OPTION"
                    and float(item.get("lot_size") or 0) > 0
                ),
                0.0,
            )

        futures_delta = round(
            sum(
                float(item.get("delta") or 0)
                for item in position_results
                if str(item.get("instrument_type") or "").strip().upper() == "FUTURE"
            ),
            4,
        )
        options_delta = round(
            sum(
                float(item.get("delta") or 0)
                for item in position_results
                if str(item.get("instrument_type") or "").strip().upper() == "OPTION"
            ),
            4,
        )
        equity_delta = round(
            sum(
                float(item.get("delta") or 0)
                for item in position_results
                if str(item.get("instrument_type") or "").strip().upper() == "EQUITY"
            ),
            4,
        )

        delta_lot_equivalent = (
            round(strategy_delta / futures_lot_size, 4)
            if futures_lot_size > 0
            else None
        )
        futures_delta_lots = (
            round(futures_delta / futures_lot_size, 4)
            if futures_lot_size > 0
            else None
        )
        options_delta_lots = (
            round(options_delta / futures_lot_size, 4)
            if futures_lot_size > 0
            else None
        )

        net_future_contract_lots = 0.0
        has_futures = False
        for position in prepared_positions:
            if str(position.get("instrument_type") or "").strip().upper() != "FUTURE":
                continue
            has_futures = True
            side = str(position.get("position_side") or "").strip().upper()
            sign = 1.0 if side == "BUY" else -1.0
            quantity = float(position.get("open_quantity") or 0)
            lot_size = float(position.get("lot_size") or futures_lot_size or 0)
            if lot_size > 0:
                net_future_contract_lots += sign * (quantity / lot_size)
        net_future_contract_lots = round(net_future_contract_lots, 4)

        spot_up_1pct = current_spot_price * 1.01
        spot_down_1pct = current_spot_price * 0.99
        shocked_delta_up = 0.0
        shocked_delta_down = 0.0
        shocked_pnl_up = 0.0
        shocked_pnl_down = 0.0
        shock_complete = True

        for position, result in zip(prepared_positions, position_results):
            iv_pct = result.get("implied_volatility")
            current_price = float(result.get("current_price") or 0)

            delta_up = calculate_position_delta_at_spot(
                position=position,
                shocked_spot=spot_up_1pct,
                implied_volatility_pct=iv_pct,
            )
            delta_down = calculate_position_delta_at_spot(
                position=position,
                shocked_spot=spot_down_1pct,
                implied_volatility_pct=iv_pct,
            )
            pnl_up = calculate_position_spot_shock_pnl(
                position=position,
                current_price=current_price,
                current_spot=current_spot_price,
                shocked_spot=spot_up_1pct,
                implied_volatility_pct=iv_pct,
            )
            pnl_down = calculate_position_spot_shock_pnl(
                position=position,
                current_price=current_price,
                current_spot=current_spot_price,
                shocked_spot=spot_down_1pct,
                implied_volatility_pct=iv_pct,
            )

            if None in {delta_up, delta_down, pnl_up, pnl_down}:
                shock_complete = False
                break

            shocked_delta_up += float(delta_up)
            shocked_delta_down += float(delta_down)
            shocked_pnl_up += float(pnl_up)
            shocked_pnl_down += float(pnl_down)

        delta_up_1pct_lots = (
            round(shocked_delta_up / futures_lot_size, 4)
            if shock_complete and futures_lot_size > 0
            else None
        )
        delta_down_1pct_lots = (
            round(shocked_delta_down / futures_lot_size, 4)
            if shock_complete and futures_lot_size > 0
            else None
        )
        pnl_up_1pct = round(shocked_pnl_up, 2) if shock_complete else None
        pnl_down_1pct = round(shocked_pnl_down, 2) if shock_complete else None

        # Price refresh deliberately does NOT recalculate Zerodha basket margin.
        # Existing margin_used/margin_status remain stored in strategy_master.
        (
            database.table("strategy_master")
            .update(
                {
                    "unrealised_mtm": total_unrealised_mtm,
                    "total_pnl": total_pnl,
                    "current_spot_price": current_spot_price,
                    "market_data_updated_at": refreshed_at,
                    "strategy_delta": strategy_delta,
                    "strategy_gamma": strategy_gamma,
                    "strategy_theta": strategy_theta,
                    "strategy_vega": strategy_vega,
                    "weighted_iv": weighted_iv,
                    "futures_lot_size": futures_lot_size or None,
                    "delta_lot_equivalent": delta_lot_equivalent,
                    "futures_delta": futures_delta,
                    "options_delta": options_delta,
                    "equity_delta": equity_delta,
                    "futures_delta_lots": futures_delta_lots,
                    "options_delta_lots": options_delta_lots,
                    "net_future_contract_lots": net_future_contract_lots,
                    "has_futures": has_futures,
                    "delta_up_1pct_lots": delta_up_1pct_lots,
                    "delta_down_1pct_lots": delta_down_1pct_lots,
                    "pnl_up_1pct": pnl_up_1pct,
                    "pnl_down_1pct": pnl_down_1pct,
                    "greeks_updated_at": refreshed_at,
                }
            )
            .eq("strategy_id", request.strategy_id)
            .execute()
        )

        # Persist one strategy-level market/risk snapshot per calendar day.
        # Repeated portfolio or individual refreshes on the same day update the
        # same row. This makes the portfolio-level Refresh Market Data button the
        # canonical way to build the day-wise history.
        daily_snapshot_status = "SAVED"
        try:
            snapshot_date = datetime.now(IST).date().isoformat()

            nearest_dte = None
            today_date = datetime.now(IST).date()
            dte_values: list[int] = []
            for open_position in open_positions:
                expiry_value = open_position.get("expiry_date")
                if not expiry_value:
                    continue
                try:
                    expiry_date_value = datetime.fromisoformat(str(expiry_value)[:10]).date()
                    dte_values.append(max(0, (expiry_date_value - today_date).days))
                except (TypeError, ValueError):
                    continue
            if dte_values:
                nearest_dte = min(dte_values)

            realistic_max_profit = None
            profit_snapshot_response = (
                database.table("strategy_profit_snapshots")
                .select("realistic_max_profit_after,captured_at")
                .eq("strategy_id", request.strategy_id)
                .order("captured_at", desc=True)
                .limit(1)
                .execute()
            )
            if profit_snapshot_response.data:
                candidate = profit_snapshot_response.data[0].get("realistic_max_profit_after")
                if candidate is not None:
                    realistic_max_profit = float(candidate)

            if realistic_max_profit is None:
                prior_daily_response = (
                    database.table("strategy_daily_snapshots")
                    .select("realistic_max_profit")
                    .eq("strategy_id", request.strategy_id)
                    .order("snapshot_date", desc=True)
                    .limit(10)
                    .execute()
                )
                for prior_row in prior_daily_response.data or []:
                    candidate = prior_row.get("realistic_max_profit")
                    if candidate is not None:
                        realistic_max_profit = float(candidate)
                        break

            capture_pct = None
            if realistic_max_profit is not None and realistic_max_profit > 0:
                capture_pct = max(0.0, (float(total_unrealised_mtm) / realistic_max_profit) * 100.0)

            margin_used_value = float(strategy.get("margin_used") or 0)
            theta_efficiency = (
                round(float(strategy_theta) / (margin_used_value / 100000.0), 4)
                if margin_used_value > 0
                else None
            )

            daily_payload = {
                "strategy_id": request.strategy_id,
                "snapshot_date": snapshot_date,
                "captured_at": refreshed_at,
                "current_spot_price": current_spot_price,
                "unrealised_mtm": total_unrealised_mtm,
                "realised_pnl": round(realised_pnl, 2),
                "total_pnl": total_pnl,
                "realistic_max_profit": realistic_max_profit,
                "unrealised_capture_pct": capture_pct,
                "margin_used": strategy.get("margin_used"),
                "nearest_dte": nearest_dte,
                "strategy_delta": strategy_delta,
                "strategy_gamma": strategy_gamma,
                "strategy_theta": strategy_theta,
                "strategy_vega": strategy_vega,
                "weighted_iv": weighted_iv,
                "futures_lot_size": futures_lot_size or None,
                "delta_lot_equivalent": delta_lot_equivalent,
                "futures_delta_lots": futures_delta_lots,
                "options_delta_lots": options_delta_lots,
                "net_future_contract_lots": net_future_contract_lots,
                "has_futures": has_futures,
                "delta_up_1pct_lots": delta_up_1pct_lots,
                "delta_down_1pct_lots": delta_down_1pct_lots,
                "pnl_up_1pct": pnl_up_1pct,
                "pnl_down_1pct": pnl_down_1pct,
                "theta_efficiency_per_lakh": theta_efficiency,
            }

            (
                database.table("strategy_daily_snapshots")
                .upsert(daily_payload, on_conflict="strategy_id,snapshot_date")
                .execute()
            )
        except Exception as snapshot_exc:
            daily_snapshot_status = f"WARNING: {snapshot_exc}"

        # Observation capture is also deliberately excluded from the blocking
        # market-price path. It can be run separately after prices are visible.
        return {
            "status": "success",
            "refresh_mode": "FAST_MARKET",
            "strategy_id": request.strategy_id,
            "strategy_name": strategy.get("strategy_name"),
            "positions_updated": len(position_results),
            "positions_resolved": len(resolution_updates),
            "realised_pnl": round(realised_pnl, 2),
            "unrealised_mtm": total_unrealised_mtm,
            "total_pnl": total_pnl,
            "current_spot_price": current_spot_price,
            "underlying_quote_key": spot_quote_key,
            "margin_used": strategy.get("margin_used"),
            "margin_status": strategy.get("margin_status"),
            "strategy_delta": strategy_delta,
            "strategy_gamma": strategy_gamma,
            "strategy_theta": strategy_theta,
            "strategy_vega": strategy_vega,
            "weighted_iv": weighted_iv,
            "futures_lot_size": futures_lot_size or None,
            "delta_lot_equivalent": delta_lot_equivalent,
            "futures_delta": futures_delta,
            "options_delta": options_delta,
            "equity_delta": equity_delta,
            "futures_delta_lots": futures_delta_lots,
            "options_delta_lots": options_delta_lots,
            "net_future_contract_lots": net_future_contract_lots,
            "has_futures": has_futures,
            "delta_up_1pct_lots": delta_up_1pct_lots,
            "delta_down_1pct_lots": delta_down_1pct_lots,
            "pnl_up_1pct": pnl_up_1pct,
            "pnl_down_1pct": pnl_down_1pct,
            "greeks_updated_at": refreshed_at,
            "refreshed_at": refreshed_at,
            "daily_snapshot_status": daily_snapshot_status,
            "positions": position_results,
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to refresh strategy market data: {str(exc)}",
        ) from exc


@app.post("/market/refresh-portfolio")
def refresh_portfolio_market_data() -> dict[str, Any]:
    """Refresh all open strategies through one browser/backend request.

    The strategy refresh calculation remains canonical in refresh_strategy().
    Work is parallelised inside the backend so the browser does not have to
    issue many simultaneous requests through the Next.js proxy. Margin and
    observation calculations remain excluded from this market-data path.
    """
    database = get_supabase()
    started_at = time_module.perf_counter()

    try:
        response = (
            database.table("strategy_master")
            .select("strategy_id,strategy_name,status")
            .eq("status", "OPEN")
            .execute()
        )
        strategies = response.data or []

        if not strategies:
            return {
                "status": "success",
                "refresh_mode": "PORTFOLIO_PARALLEL",
                "strategies_total": 0,
                "strategies_updated": 0,
                "strategies_failed": 0,
                "results": [],
                "refreshed_at": datetime.now(IST).isoformat(),
                "duration_seconds": 0.0,
            }

        # Three workers is intentionally conservative: it removes the long
        # sequential wait while avoiding an unbounded burst of broker calls.
        max_workers = min(3, len(strategies))
        results: list[dict[str, Any]] = []

        def run_one(row: dict[str, Any]) -> dict[str, Any]:
            strategy_id = str(row["strategy_id"])
            try:
                result = refresh_strategy(
                    RefreshStrategyRequest(strategy_id=strategy_id)
                )
                return {
                    "strategy_id": strategy_id,
                    "strategy_name": row.get("strategy_name"),
                    "status": "SUCCESS",
                    "result": result,
                }
            except HTTPException as exc:
                return {
                    "strategy_id": strategy_id,
                    "strategy_name": row.get("strategy_name"),
                    "status": "ERROR",
                    "message": str(exc.detail),
                }
            except Exception as exc:
                return {
                    "strategy_id": strategy_id,
                    "strategy_name": row.get("strategy_name"),
                    "status": "ERROR",
                    "message": str(exc),
                }

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(run_one, row) for row in strategies]
            for future in as_completed(futures):
                results.append(future.result())

        order = {
            str(row["strategy_id"]): index
            for index, row in enumerate(strategies)
        }
        results.sort(key=lambda item: order.get(item["strategy_id"], 10**9))

        updated = sum(1 for item in results if item["status"] == "SUCCESS")
        failed = len(results) - updated
        duration = round(time_module.perf_counter() - started_at, 3)

        return {
            "status": "success" if failed == 0 else "partial_success",
            "refresh_mode": "PORTFOLIO_PARALLEL",
            "strategies_total": len(strategies),
            "strategies_updated": updated,
            "strategies_failed": failed,
            "workers": max_workers,
            "results": results,
            "refreshed_at": datetime.now(IST).isoformat(),
            "duration_seconds": duration,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to refresh portfolio market data: {str(exc)}",
        ) from exc


@app.post("/strategy/recalculate-margin")
def recalculate_strategy_margin(request: RefreshStrategyRequest) -> dict[str, Any]:
    """Recalculate margin only when a strategy position event changes open legs."""
    database = get_supabase()

    strategy_response = (
        database.table("strategy_master")
        .select("strategy_id,status")
        .eq("strategy_id", request.strategy_id)
        .limit(1)
        .execute()
    )
    if not strategy_response.data:
        raise HTTPException(status_code=404, detail="Strategy not found.")

    positions_response = (
        database.table("book_positions")
        .select(
            "id,symbol,instrument_type,option_type,strike,expiry_date,position_side,"
            "open_quantity,exchange,tradingsymbol,instrument_token,lot_size"
        )
        .eq("strategy_id", request.strategy_id)
        .gt("open_quantity", 0)
        .execute()
    )
    positions = positions_response.data or []
    captured_at = datetime.now(IST).isoformat()

    if not positions:
        database.table("strategy_master").update(
            {
                "margin_used": 0,
                "margin_initial": 0,
                "margin_status": "CURRENT",
                "margin_updated_at": captured_at,
            }
        ).eq("strategy_id", request.strategy_id).execute()
        return {
            "status": "success",
            "strategy_id": request.strategy_id,
            "margin_used": 0,
            "initial_margin": 0,
            "margin_status": "CURRENT",
            "captured_at": captured_at,
        }

    kite = get_kite_client()
    needs_resolution = any(
        str(p.get("instrument_type") or "").upper() in {"OPTION", "FUTURE"}
        and (not p.get("tradingsymbol") or not p.get("instrument_token"))
        for p in positions
    )
    nfo_instruments = kite.instruments("NFO") if needs_resolution else []
    prepared_positions: list[dict[str, Any]] = []

    for position in positions:
        instrument_type = str(position.get("instrument_type") or "").upper()
        exchange = str(position.get("exchange") or "").upper()
        tradingsymbol = position.get("tradingsymbol")
        instrument_token = position.get("instrument_token")
        lot_size = position.get("lot_size")

        if instrument_type in {"OPTION", "FUTURE"} and (not tradingsymbol or not instrument_token):
            expiry = parse_date_value(position.get("expiry_date"))
            if not expiry:
                raise HTTPException(status_code=422, detail=f"Position {position['id']} has no expiry date.")
            resolved = resolve_from_instruments(
                nfo_instruments,
                symbol=str(position.get("symbol") or "").upper(),
                instrument_type=instrument_type,
                expiry=expiry,
                strike=float(position["strike"]) if position.get("strike") is not None else None,
                option_type=position.get("option_type"),
            )
            tradingsymbol = resolved.get("tradingsymbol")
            instrument_token = resolved.get("instrument_token")
            exchange = str(resolved.get("exchange") or "NFO").upper()
            lot_size = resolved.get("lot_size")
            database.table("book_positions").update(
                {
                    "tradingsymbol": tradingsymbol,
                    "instrument_token": instrument_token,
                    "exchange": exchange,
                    "lot_size": lot_size,
                }
            ).eq("id", position["id"]).execute()

        if instrument_type == "EQUITY":
            exchange = exchange or "NSE"
            tradingsymbol = tradingsymbol or str(position.get("symbol") or "").upper()

        prepared_positions.append(
            {
                **position,
                "exchange": exchange,
                "tradingsymbol": tradingsymbol,
                "instrument_token": instrument_token,
                "lot_size": lot_size,
            }
        )

    margin_result = calculate_strategy_margin(kite, prepared_positions)
    margin_used = margin_result.get("margin_used")
    initial_margin = margin_result.get("initial_margin")
    margin_status = str(margin_result.get("margin_status") or "UNAVAILABLE")

    database.table("strategy_master").update(
        {
            "margin_used": margin_used,
            "margin_initial": initial_margin,
            "margin_status": margin_status,
            "margin_updated_at": captured_at,
        }
    ).eq("strategy_id", request.strategy_id).execute()

    if margin_used is not None:
        database.table("strategy_margin_history").insert(
            {
                "strategy_id": request.strategy_id,
                "captured_at": captured_at,
                "margin_used": margin_used,
                "initial_margin": initial_margin,
                "source": "POSITION_EVENT",
            }
        ).execute()

    return {
        "status": "success",
        "strategy_id": request.strategy_id,
        "margin_used": margin_used,
        "initial_margin": initial_margin,
        "margin_status": margin_status,
        "captured_at": captured_at,
    }


@app.post("/portfolio/settings")
def update_portfolio_settings(request: PortfolioSettingsRequest) -> dict[str, Any]:
    database = get_supabase()
    payload = {
        "id": 1,
        "deployable_capital": round(request.deployable_capital, 2),
        "target_return_pct": round(request.target_return_pct, 4),
        "updated_at": datetime.now(IST).isoformat(),
    }
    database.table("portfolio_settings").upsert(payload, on_conflict="id").execute()
    return {"status": "success", **payload}


@app.post("/portfolio/snapshot")
def portfolio_snapshot(request: PortfolioSnapshotRequest) -> dict[str, Any]:
    database = get_supabase()
    snapshot_date = request.snapshot_date or datetime.now(IST).date()
    try:
        result = upsert_portfolio_snapshot(database, snapshot_date)
        return {"status": "success", "snapshot": result}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to save portfolio snapshot: {str(exc)}",
        ) from exc


@app.get("/portfolio/intelligence")
def portfolio_intelligence() -> dict[str, Any]:
    database = get_supabase()
    settings_response = (
        database.table("portfolio_settings")
        .select("deployable_capital,target_return_pct,updated_at")
        .eq("id", 1)
        .limit(1)
        .execute()
    )
    monthly_response = (
        database.table("portfolio_monthly_summary")
        .select("*")
        .order("month_key", desc=True)
        .execute()
    )
    strategies_response = (
        database.table("strategy_master")
        .select(
            "strategy_id,strategy_name,symbol,status,entry_date,expiry_month,"
            "realised_pnl,unrealised_mtm,total_pnl,margin_used,margin_status,margin_updated_at"
        )
        .eq("status", "OPEN")
        .execute()
    )

    strategies = []
    for strategy in strategies_response.data or []:
        margin = float(strategy.get("margin_used") or 0)
        net = float(strategy.get("total_pnl") or 0)
        strategy["return_on_margin_pct"] = round((net / margin) * 100, 4) if margin > 0 else None
        strategies.append(strategy)

    strategies.sort(
        key=lambda item: item.get("return_on_margin_pct") if item.get("return_on_margin_pct") is not None else -10**9,
        reverse=True,
    )

    return {
        "status": "success",
        "settings": settings_response.data[0] if settings_response.data else None,
        "monthly": monthly_response.data or [],
        "strategies": strategies,
    }