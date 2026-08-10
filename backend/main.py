import os
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from kiteconnect import KiteConnect
from pydantic import BaseModel, Field
from supabase import Client, create_client

IST = ZoneInfo("Asia/Kolkata")

app = FastAPI(
    title="VOTE Data Engine",
    version="0.7.0",
    description="Backend service for the Vivek Options Trading Engine",
)

frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")
kite_api_key = os.getenv("KITE_API_KEY")
kite_api_secret = os.getenv("KITE_API_SECRET")
supabase_url = os.getenv("SUPABASE_URL")
supabase_service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

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
    return {"application": "VOTE Data Engine", "version": "0.7.0", "status": "running"}


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


@app.post("/market/resolve-instrument")
def market_resolve_instrument(request: ResolveInstrumentRequest) -> dict[str, Any]:
    try:
        kite = get_kite_client()
        instruments = kite.instruments("NFO")
        instrument = resolve_from_instruments(
            instruments,
            symbol=request.symbol,
            instrument_type=request.instrument_type,
            expiry=request.expiry,
            strike=request.strike,
            option_type=request.option_type,
        )
        return {
            "status": "resolved",
            "instrument": serialize_instrument(instrument),
            "position_fields": {
                "instrument_token": instrument.get("instrument_token"),
                "tradingsymbol": instrument.get("tradingsymbol"),
                "exchange": instrument.get("exchange"),
                "lot_size": instrument.get("lot_size"),
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Unable to resolve Zerodha instrument: {str(exc)}") from exc


@app.post("/market/quotes")
def market_quotes(request: MarketQuotesRequest) -> dict[str, Any]:
    try:
        kite = get_kite_client()
        requested = [item.strip().upper() for item in request.instruments if item.strip()]
        if not requested:
            raise HTTPException(status_code=422, detail="At least one instrument is required.")

        raw_quotes = kite.quote(requested)
        quotes: dict[str, Any] = {}
        for key, quote in raw_quotes.items():
            quotes[key] = {
                "instrument_token": quote.get("instrument_token"),
                "last_price": quote.get("last_price"),
                "last_quantity": quote.get("last_quantity"),
                "average_price": quote.get("average_price"),
                "volume": quote.get("volume"),
                "buy_quantity": quote.get("buy_quantity"),
                "sell_quantity": quote.get("sell_quantity"),
                "ohlc": quote.get("ohlc"),
                "net_change": quote.get("net_change"),
                "oi": quote.get("oi"),
                "oi_day_high": quote.get("oi_day_high"),
                "oi_day_low": quote.get("oi_day_low"),
                "lower_circuit_limit": quote.get("lower_circuit_limit"),
                "upper_circuit_limit": quote.get("upper_circuit_limit"),
                "last_trade_time": quote.get("last_trade_time").isoformat()
                if isinstance(quote.get("last_trade_time"), datetime)
                else quote.get("last_trade_time"),
                "exchange_timestamp": quote.get("timestamp").isoformat()
                if isinstance(quote.get("timestamp"), datetime)
                else quote.get("timestamp"),
            }

        unresolved = [item for item in requested if item not in raw_quotes]
        return {
            "status": "success",
            "requested_count": len(requested),
            "resolved_count": len(quotes),
            "unresolved_count": len(unresolved),
            "fetched_at": datetime.now(IST).isoformat(),
            "quotes": quotes,
            "unresolved": unresolved,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Unable to fetch Zerodha quotes: {str(exc)}") from exc


@app.post("/market/refresh-strategy")
def refresh_strategy(request: RefreshStrategyRequest) -> dict[str, Any]:
    database = get_supabase()

    try:
        strategy_response = (
            database.table("strategy_master")
            .select("strategy_id,strategy_name,symbol,status,realised_pnl,current_spot_price,market_data_updated_at,margin_used,margin_status")
            .eq("strategy_id", request.strategy_id)
            .limit(1)
            .execute()
        )

        if not strategy_response.data:
            raise HTTPException(status_code=404, detail="Strategy not found.")

        strategy = strategy_response.data[0]
        if strategy.get("status") == "CLOSED":
            raise HTTPException(status_code=409, detail="Closed strategies do not require market-price refresh.")

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
            position.get("instrument_type") in {"OPTION", "FUTURE"}
            and (not position.get("tradingsymbol") or not position.get("instrument_token"))
            for position in positions
        )

        nfo_instruments: list[dict[str, Any]] = kite.instruments("NFO") if needs_resolution else []
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

                    symbol = str(position.get("symbol") or strategy.get("symbol") or "").strip().upper()
                    if not symbol:
                        raise HTTPException(status_code=422, detail=f"Position {position_id} has no underlying symbol.")

                    resolved = resolve_from_instruments(
                        nfo_instruments,
                        symbol=symbol,
                        instrument_type=instrument_type,
                        expiry=expiry,
                        strike=float(position["strike"]) if position.get("strike") is not None else None,
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
                    tradingsymbol = str(position.get("symbol") or strategy.get("symbol") or "").strip().upper()
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

        for position_id, metadata_update in resolution_updates:
            database.table("book_positions").update(metadata_update).eq("id", position_id).execute()

        market_quote_keys = list(dict.fromkeys([spot_quote_key, *quote_keys]))
        raw_quotes = kite.quote(market_quote_keys)

        if spot_quote_key not in raw_quotes:
            raise HTTPException(
                status_code=502,
                detail=f"Zerodha did not return an underlying quote for {spot_quote_key}.",
            )

        current_spot_price = float(raw_quotes[spot_quote_key].get("last_price") or 0)
        if not current_spot_price or current_spot_price <= 0:
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
            current_price = float(quote.get("last_price"))
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

            update_payload = {
                "current_price": current_price,
                "mtm": mtm,
                "instrument_token": position.get("instrument_token"),
                "tradingsymbol": position.get("tradingsymbol"),
                "exchange": position.get("exchange"),
                "lot_size": position.get("lot_size"),
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
                }
            )

        total_unrealised_mtm = round(total_unrealised_mtm, 2)
        realised_pnl = float(strategy.get("realised_pnl") or 0)
        total_pnl = round(realised_pnl + total_unrealised_mtm, 2)

        margin_result = calculate_strategy_margin(kite, prepared_positions)
        margin_used = margin_result.get("margin_used")
        initial_margin = margin_result.get("initial_margin")
        margin_status = str(margin_result.get("margin_status") or "UNAVAILABLE")

        refreshed_at = datetime.now(IST).isoformat()

        database.table("strategy_master").update(
            {
                "unrealised_mtm": total_unrealised_mtm,
                "total_pnl": total_pnl,
                "current_spot_price": current_spot_price,
                "market_data_updated_at": refreshed_at,
                "margin_used": margin_used,
                "margin_initial": initial_margin,
                "margin_status": margin_status,
                "margin_updated_at": refreshed_at,
            }
        ).eq("strategy_id", request.strategy_id).execute()

        if margin_used is not None:
            database.table("strategy_margin_history").insert(
                {
                    "strategy_id": request.strategy_id,
                    "captured_at": refreshed_at,
                    "margin_used": margin_used,
                    "initial_margin": initial_margin,
                    "source": "MARKET_REFRESH",
                }
            ).execute()

        return {
            "status": "success",
            "strategy_id": request.strategy_id,
            "strategy_name": strategy.get("strategy_name"),
            "positions_updated": len(position_results),
            "positions_resolved": len(resolution_updates),
            "realised_pnl": round(realised_pnl, 2),
            "unrealised_mtm": total_unrealised_mtm,
            "total_pnl": total_pnl,
            "current_spot_price": current_spot_price,
            "underlying_quote_key": spot_quote_key,
            "margin_used": margin_used,
            "initial_margin": initial_margin,
            "margin_status": margin_status,
            "refreshed_at": refreshed_at,
            "positions": position_results,
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to refresh strategy market data: {str(exc)}",
        ) from exc


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
