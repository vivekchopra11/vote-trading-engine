-- ============================================================
-- VOTE DATABASE SCHEMA v1.0
-- Vivek Options Trading Engine
-- ============================================================

-- ------------------------------------------------------------
-- 1. STOCKS
-- Master table for the 52-stock universe
-- ------------------------------------------------------------

create table public.stocks (
    id bigint generated always as identity primary key,

    symbol text not null unique,
    company_name text not null,

    universe_type text not null
        check (universe_type in ('NIFTY_50', 'ADDITIONAL')),

    sector text,
    industry text,

    nifty_weight numeric(8,4),
    market_cap numeric(20,2),

    lot_size integer,
    tick_size numeric(10,4),

    is_fo_eligible boolean not null default true,
    is_active boolean not null default true,

    zerodha_instrument_token bigint,
    zerodha_exchange text default 'NSE',
    zerodha_tradingsymbol text,

    active_from date,
    active_to date,

    notes text,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- 2. DAILY MARKET DATA
-- One row per stock per trading date
-- ------------------------------------------------------------

create table public.daily_market_data (
    id bigint generated always as identity primary key,

    stock_id bigint not null
        references public.stocks(id)
        on delete cascade,

    trading_date date not null,

    open_price numeric(16,4) not null,
    high_price numeric(16,4) not null,
    low_price numeric(16,4) not null,
    close_price numeric(16,4) not null,
    previous_close numeric(16,4),

    volume bigint,
    traded_value numeric(22,2),
    futures_oi bigint,

    daily_return_pct numeric(14,6),
    overnight_gap_pct numeric(14,6),
    intraday_range_pct numeric(14,6),

    true_range numeric(16,6),
    atr_14 numeric(16,6),
    atr_pct numeric(14,6),

    hv_20 numeric(14,6),
    hv_60 numeric(14,6),
    hv_120 numeric(14,6),

    adx_14 numeric(14,6),
    plus_di_14 numeric(14,6),
    minus_di_14 numeric(14,6),

    rsi_14 numeric(14,6),

    sma_20 numeric(16,4),
    sma_50 numeric(16,4),
    sma_200 numeric(16,4),

    distance_sma20_pct numeric(14,6),
    distance_sma50_pct numeric(14,6),
    distance_sma200_pct numeric(14,6),

    bollinger_width numeric(14,6),

    rolling_high_20 numeric(16,4),
    rolling_low_20 numeric(16,4),
    rolling_high_60 numeric(16,4),
    rolling_low_60 numeric(16,4),

    beta_60_nifty numeric(14,6),
    correlation_60_nifty numeric(14,6),

    relative_strength_20 numeric(14,6),
    relative_strength_60 numeric(14,6),

    data_source text not null default 'ZERODHA',

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint daily_market_data_unique
        unique (stock_id, trading_date),

    constraint valid_daily_price_range
        check (
            high_price >= low_price
            and high_price >= open_price
            and high_price >= close_price
            and low_price <= open_price
            and low_price <= close_price
        )
);


-- ------------------------------------------------------------
-- 3. CURRENT OPTIONS DATA
-- Latest option-chain summary for a stock and expiry
-- Existing rows can be updated each day
-- ------------------------------------------------------------

create table public.current_options_data (
    id bigint generated always as identity primary key,

    stock_id bigint not null
        references public.stocks(id)
        on delete cascade,

    observation_time timestamptz not null default now(),
    expiry_date date not null,

    calendar_dte integer,
    trading_dte integer,

    spot_price numeric(16,4) not null,
    atm_strike numeric(16,4),

    atm_call_ltp numeric(16,4),
    atm_put_ltp numeric(16,4),

    atm_call_iv numeric(14,6),
    atm_put_iv numeric(14,6),
    atm_iv numeric(14,6),

    iv_rank_252 numeric(14,6),
    iv_percentile_252 numeric(14,6),

    iv_hv20_ratio numeric(14,6),
    iv_minus_hv20 numeric(14,6),

    total_call_oi bigint,
    total_put_oi bigint,
    pcr_oi numeric(14,6),

    total_call_volume bigint,
    total_put_volume bigint,
    pcr_volume numeric(14,6),

    max_call_oi_strike numeric(16,4),
    max_put_oi_strike numeric(16,4),
    max_pain numeric(16,4),

    atm_call_bid numeric(16,4),
    atm_call_ask numeric(16,4),
    atm_put_bid numeric(16,4),
    atm_put_ask numeric(16,4),

    atm_bid_ask_pct numeric(14,6),

    option_quality_flag text
        check (
            option_quality_flag is null
            or option_quality_flag in ('PASS', 'REVIEW', 'FAIL')
        ),

    data_source text not null default 'ZERODHA',

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint current_options_unique
        unique (stock_id, expiry_date)
);


-- ------------------------------------------------------------
-- 4. OPTION ANALYTICS HISTORY
-- Permanent daily option snapshot used for IV and theta research
-- One row per stock, expiry and snapshot date/time
-- ------------------------------------------------------------

create table public.option_analytics_history (
    id bigint generated always as identity primary key,

    stock_id bigint not null
        references public.stocks(id)
        on delete cascade,

    snapshot_time timestamptz not null,
    snapshot_date date not null,

    expiry_date date not null,
    calendar_dte integer not null,
    trading_dte integer,

    expiry_month integer
        check (expiry_month between 1 and 12),

    day_of_month integer
        check (day_of_month between 1 and 31),

    week_of_expiry integer,

    spot_price numeric(16,4) not null,
    atm_strike numeric(16,4),

    atr_pct numeric(14,6),
    hv_20 numeric(14,6),
    hv_60 numeric(14,6),

    atm_call_ltp numeric(16,4),
    atm_put_ltp numeric(16,4),
    atm_straddle_premium numeric(16,4),
    atm_straddle_pct numeric(14,6),

    atm_call_iv numeric(14,6),
    atm_put_iv numeric(14,6),
    atm_iv numeric(14,6),

    iv_rank numeric(14,6),
    iv_percentile numeric(14,6),
    iv_hv_spread numeric(14,6),
    iv_hv_ratio numeric(14,6),

    call_delta numeric(14,8),
    put_delta numeric(14,8),

    call_theta numeric(16,8),
    put_theta numeric(16,8),
    combined_theta numeric(16,8),

    call_gamma numeric(16,10),
    put_gamma numeric(16,10),

    call_vega numeric(16,8),
    put_vega numeric(16,8),

    total_call_oi bigint,
    total_put_oi bigint,
    pcr_oi numeric(14,6),

    call_oi_change bigint,
    put_oi_change bigint,

    max_call_oi_strike numeric(16,4),
    max_put_oi_strike numeric(16,4),
    max_pain numeric(16,4),

    india_vix numeric(14,6),
    nifty_return_pct numeric(14,6),
    banknifty_return_pct numeric(14,6),

    theoretical_theta_decay numeric(16,6),
    actual_premium_decay numeric(16,6),
    theta_capture_pct numeric(14,6),
    premium_persistence_pct numeric(14,6),

    data_source text not null default 'ZERODHA',

    created_at timestamptz not null default now(),

    constraint option_history_unique
        unique (stock_id, expiry_date, snapshot_time),

    constraint valid_expiry_dates
        check (expiry_date >= snapshot_date)
);


-- ------------------------------------------------------------
-- 5. BOOK POSITIONS
-- Current and historical option/futures positions
-- Supports multiple expiry months
-- ------------------------------------------------------------

create table public.book_positions (
    id bigint generated always as identity primary key,

    stock_id bigint
        references public.stocks(id)
        on delete set null,

    underlying_symbol text not null,

    strategy_id text,
    position_group text,

    instrument_type text not null
        check (
            instrument_type in (
                'CE',
                'PE',
                'FUTURE',
                'INDEX_CE',
                'INDEX_PE'
            )
        ),

    trade_side text not null
        check (trade_side in ('BUY', 'SELL')),

    expiry_date date not null,
    strike_price numeric(16,4),

    quantity integer not null,
    lot_size integer,

    entry_date date not null,
    entry_price numeric(16,4) not null,

    current_price numeric(16,4),

    margin_used numeric(20,2),
    current_mtm numeric(20,2),
    realised_pnl numeric(20,2) default 0,

    position_delta numeric(18,8),
    position_gamma numeric(18,10),
    position_theta numeric(18,8),
    position_vega numeric(18,8),

    stock_exposure_pct numeric(14,6),
    sector_exposure_pct numeric(14,6),

    hedge_flag boolean not null default false,

    status text not null default 'OPEN'
        check (status in ('OPEN', 'CLOSED', 'ROLLED')),

    exit_date date,
    exit_price numeric(16,4),

    zerodha_tradingsymbol text,
    zerodha_instrument_token bigint,

    notes text,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint valid_book_exit
        check (
            (status = 'OPEN' and exit_date is null)
            or status in ('CLOSED', 'ROLLED')
        )
);


-- ------------------------------------------------------------
-- 6. TRADE JOURNAL
-- One row per trade strategy, not necessarily per option leg
-- Includes Decision Quality Score
-- ------------------------------------------------------------

create table public.trade_journal (
    id bigint generated always as identity primary key,

    stock_id bigint
        references public.stocks(id)
        on delete set null,

    trade_reference text unique,
    underlying_symbol text not null,

    trade_type text not null
        check (
            trade_type in (
                'SHORT_PE',
                'SHORT_CE',
                'SHORT_STRANGLE',
                'SHORT_STRADDLE',
                'SPREAD',
                'INDEX_HEDGE',
                'OTHER'
            )
        ),

    directional_view text
        check (
            directional_view is null
            or directional_view in (
                'BULLISH',
                'BEARISH',
                'NEUTRAL',
                'VOLATILITY'
            )
        ),

    entry_date date not null,
    exit_date date,

    entry_expiry date,
    entry_dte integer,

    entry_spot numeric(16,4),
    entry_atm_iv numeric(14,6),
    entry_iv_rank numeric(14,6),
    entry_iv_percentile numeric(14,6),
    entry_atr_pct numeric(14,6),
    entry_adx numeric(14,6),
    entry_pcr numeric(14,6),
    entry_india_vix numeric(14,6),

    structural_score_at_entry numeric(8,4),
    opportunity_score_at_entry numeric(8,4),
    portfolio_fit_score_at_entry numeric(8,4),

    technical_setup text,
    support_level numeric(16,4),
    resistance_level numeric(16,4),

    event_check_passed boolean,
    earnings_before_expiry boolean,
    corporate_action_before_expiry boolean,

    initial_margin numeric(20,2),
    maximum_margin numeric(20,2),
    net_premium_received numeric(20,2),

    stock_concentration_after_trade numeric(14,6),
    sector_concentration_after_trade numeric(14,6),
    margin_utilisation_after_trade numeric(14,6),

    hedge_review_status text
        check (
            hedge_review_status is null
            or hedge_review_status in (
                'NOT_REQUIRED',
                'REVIEWED_NO_HEDGE',
                'HEDGE_PRESENT',
                'HEDGE_ADDED',
                'NOT_REVIEWED'
            )
        ),

    entry_plan_documented boolean not null default false,
    exit_plan_documented boolean not null default false,

    planned_exit text,
    invalidation_condition text,

    realised_pnl numeric(20,2),
    return_on_margin_pct numeric(14,6),

    mae numeric(20,2),
    mfe numeric(20,2),

    exit_reason text,

    process_grade text
        check (
            process_grade is null
            or process_grade in ('A', 'B', 'C', 'D')
        ),

    decision_quality_score numeric(8,4),
    decision_quality_grade text
        check (
            decision_quality_grade is null
            or decision_quality_grade in (
                'HIGH_QUALITY',
                'ACCEPTABLE',
                'PROCESS_WEAKNESS',
                'POOR_PROCESS'
            )
        ),

    lessons_learned text,
    notes text,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint valid_trade_dates
        check (
            exit_date is null
            or exit_date >= entry_date
        ),

    constraint valid_decision_score
        check (
            decision_quality_score is null
            or decision_quality_score between 0 and 100
        )
);


-- ============================================================
-- INDEXES
-- Improve filtering, sorting and historical analysis
-- ============================================================

create index idx_daily_market_stock_date
    on public.daily_market_data(stock_id, trading_date desc);

create index idx_daily_market_date
    on public.daily_market_data(trading_date desc);

create index idx_current_options_expiry
    on public.current_options_data(expiry_date);

create index idx_option_history_stock_date
    on public.option_analytics_history(stock_id, snapshot_date desc);

create index idx_option_history_expiry_dte
    on public.option_analytics_history(expiry_date, calendar_dte);

create index idx_option_history_stock_dte
    on public.option_analytics_history(stock_id, calendar_dte);

create index idx_book_status_expiry
    on public.book_positions(status, expiry_date);

create index idx_book_underlying
    on public.book_positions(underlying_symbol);

create index idx_trade_journal_stock_entry
    on public.trade_journal(stock_id, entry_date desc);

create index idx_trade_decision_quality
    on public.trade_journal(decision_quality_score desc);


-- ============================================================
-- ROW LEVEL SECURITY
-- Enabled now; access policies will be added when authentication
-- is connected.
-- ============================================================

alter table public.stocks enable row level security;
alter table public.daily_market_data enable row level security;
alter table public.current_options_data enable row level security;
alter table public.option_analytics_history enable row level security;
alter table public.book_positions enable row level security;
alter table public.trade_journal enable row level security;
