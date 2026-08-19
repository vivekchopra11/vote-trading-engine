"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

const ZERODHA_LOGIN_URL =
  "https://vote-trading-engine-1.onrender.com/auth/zerodha/login";

const CONCENTRATION_LIMIT_PCT = 30;

type Strategy = {
  strategy_id: string;
  strategy_name: string;
  symbol: string;
  strategy_type: string | null;
  direction: string | null;
  status: string;
  entry_date: string;
  expiry_month: string | null;
  closed_date: string | null;
  realised_pnl: number | null;
  unrealised_mtm: number | null;
  total_pnl: number | null;
  margin_used: number | null;
  margin_status: string | null;
  margin_updated_at: string | null;
  market_data_updated_at: string | null;
  strategy_theta: number | null;
  delta_lot_equivalent: number | null;
};

type DailySnapshot = {
  strategy_id: string;
  snapshot_date: string;
  captured_at: string;
  unrealised_mtm: number | null;
  realised_pnl: number | null;
  total_pnl: number | null;
  unrealised_capture_pct: number | null;
  nearest_dte: number | null;
};

type Closure = {
  close_date: string;
  realised_pnl: number | null;
};

type RefreshState = {
  status: "PENDING" | "REFRESHING" | "SUCCESS" | "ERROR";
  message?: string;
};

function formatCurrency(
  value: number | null | undefined,
  showPlus = true,
) {
  const amount = Number(value ?? 0);
  const sign = amount < 0 ? "-" : showPlus && amount > 0 ? "+" : "";

  return `${sign}₹${Math.abs(amount).toLocaleString("en-IN", {
    maximumFractionDigits: 0,
  })}`;
}

function formatCompactCurrency(value: number | null | undefined) {
  const amount = Number(value ?? 0);
  const absolute = Math.abs(amount);
  const sign = amount < 0 ? "-" : amount > 0 ? "+" : "";

  if (absolute >= 10_000_000) {
    return `${sign}₹${(absolute / 10_000_000).toFixed(2)}Cr`;
  }

  if (absolute >= 100_000) {
    return `${sign}₹${(absolute / 100_000).toFixed(2)}L`;
  }

  if (absolute >= 1_000) {
    return `${sign}₹${(absolute / 1_000).toFixed(1)}K`;
  }

  return `${sign}₹${absolute.toLocaleString("en-IN", {
    maximumFractionDigits: 0,
  })}`;
}

function pnlClass(value: number | null | undefined) {
  const amount = Number(value ?? 0);
  if (amount > 0) return "text-emerald-700";
  if (amount < 0) return "text-red-700";
  return "text-gray-700";
}

function requiresReconnect(message: string) {
  const text = message.toLowerCase();
  return (
    text.includes("expired") ||
    text.includes("authenticate") ||
    text.includes("not connected") ||
    text.includes("zerodha session") ||
    text.includes("access token")
  );
}

function formatExpiryMonth(value: string | null) {
  if (!value) return "—";
  const month = value.slice(0, 7);
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return value;

  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    year: "numeric",
  }).format(new Date(year, monthNumber - 1, 1));
}

function concentrationTone(concentrationPct: number) {
  if (concentrationPct >= CONCENTRATION_LIMIT_PCT) {
    return {
      bar: "bg-red-500",
      text: "text-red-700",
      label: "Concentration limit exceeded",
      border: "border-red-200",
      background: "bg-red-50/40",
    };
  }

  if (concentrationPct >= 25) {
    return {
      bar: "bg-amber-500",
      text: "text-amber-700",
      label: "Approaching 30% limit",
      border: "border-amber-200",
      background: "bg-amber-50/30",
    };
  }

  return {
    bar: "bg-gray-900",
    text: "text-gray-500",
    label: "Within concentration limit",
    border: "border-gray-200",
    background: "bg-white",
  };
}

function PortfolioMetric({
  label,
  value,
  subtext,
  valueClassName = "text-gray-950",
}: {
  label: string;
  value: string;
  subtext?: string;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-500">
        {label}
      </p>
      <p className={`mt-1 text-xl font-semibold ${valueClassName}`}>
        {value}
      </p>
      {subtext && <p className="mt-1 text-xs text-gray-500">{subtext}</p>}
    </div>
  );
}

function StrategyCard({
  strategy,
  concentrationPct,
  latestSnapshot,
  previousSnapshot,
}: {
  strategy: Strategy;
  concentrationPct: number;
  latestSnapshot: DailySnapshot | null;
  previousSnapshot: DailySnapshot | null;
}) {
  const currentMtm = Number(strategy.unrealised_mtm ?? 0);
  const previousMtm = previousSnapshot
    ? Number(previousSnapshot.unrealised_mtm ?? 0)
    : null;
  const mtmChange = previousMtm === null ? null : currentMtm - previousMtm;

  const capturePct = latestSnapshot?.unrealised_capture_pct ?? null;
  const dte = latestSnapshot?.nearest_dte ?? null;
  const deltaLots = strategy.delta_lot_equivalent;
  const theta = strategy.strategy_theta;
  const tone = concentrationTone(concentrationPct);

  return (
    <Link
      href={`/strategies/${encodeURIComponent(strategy.strategy_id)}`}
      className={`group block rounded-2xl border ${tone.border} ${tone.background} p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-gray-500">
              {strategy.symbol}
            </p>
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
              OPEN
            </span>
          </div>
          <h2 className="mt-2 truncate text-lg font-semibold text-gray-950">
            {strategy.strategy_name}
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            Expiry {formatExpiryMonth(strategy.expiry_month)}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            DTE
          </p>
          <p className="mt-1 text-xl font-semibold text-gray-900">
            {dte === null ? "—" : dte}
          </p>
        </div>
      </div>

      <div className="mt-5 border-t border-gray-200 pt-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              MTM today
            </p>
            <p className={`mt-1 text-2xl font-semibold ${pnlClass(currentMtm)}`}>
              {formatCurrency(currentMtm)}
            </p>
          </div>

          <div className="text-right">
            <p className="text-[11px] text-gray-500">vs previous snapshot</p>
            <p
              className={`mt-1 text-sm font-semibold ${
                mtmChange === null ? "text-gray-400" : pnlClass(mtmChange)
              }`}
            >
              {mtmChange === null ? "—" : formatCurrency(mtmChange)}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Profit capture
          </p>
          <p
            className={`mt-1 text-lg font-semibold ${
              capturePct !== null && capturePct >= 70
                ? "text-amber-700"
                : "text-gray-950"
            }`}
          >
            {capturePct === null ? "—" : `${capturePct.toFixed(1)}%`}
          </p>
          {capturePct !== null && capturePct >= 70 && (
            <p className="mt-1 text-[11px] font-semibold text-amber-700">
              Profit booking zone
            </p>
          )}
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Capital concentration
          </p>
          <p className={`mt-1 text-lg font-semibold ${tone.text}`}>
            {concentrationPct.toFixed(1)}%
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100">
            <div
              className={`h-full rounded-full ${tone.bar}`}
              style={{
                width: `${Math.min(100, (concentrationPct / CONCENTRATION_LIMIT_PCT) * 100)}%`,
              }}
            />
          </div>
          <p className={`mt-1 text-[11px] ${tone.text}`}>{tone.label}</p>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Delta
          </p>
          <p className="mt-1 text-lg font-semibold text-gray-950">
            {deltaLots === null || deltaLots === undefined
              ? "—"
              : `${deltaLots >= 0 ? "+" : ""}${Number(deltaLots).toFixed(2)} lots`}
          </p>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Theta
          </p>
          <p className="mt-1 text-lg font-semibold text-gray-950">
            {theta === null || theta === undefined
              ? "—"
              : `${formatCurrency(theta)} / day`}
          </p>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-gray-200 pt-4">
        <div>
          <p className="text-[11px] text-gray-500">Margin used</p>
          <p className="mt-0.5 text-sm font-semibold text-gray-800">
            {Number(strategy.margin_used ?? 0) > 0
              ? formatCompactCurrency(strategy.margin_used)
              : "—"}
          </p>
        </div>
        <span className="text-sm font-semibold text-gray-600 transition group-hover:text-gray-950">
          Open strategy →
        </span>
      </div>
    </Link>
  );
}

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [dailySnapshots, setDailySnapshots] = useState<DailySnapshot[]>([]);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [refreshStates, setRefreshStates] = useState<Record<string, RefreshState>>({});
  const [refreshCompleted, setRefreshCompleted] = useState(0);
  const [refreshTotal, setRefreshTotal] = useState(0);
  const [lastRefreshDurationMs, setLastRefreshDurationMs] = useState<number | null>(null);
  const [lastPortfolioRefresh, setLastPortfolioRefresh] = useState<string | null>(null);

  async function loadData(showLoader = false) {
    if (showLoader) setLoading(true);
    setErrorMessage("");

    const currentMonthStart = `${new Date().toISOString().slice(0, 7)}-01`;

    const [strategiesResponse, snapshotsResponse, closuresResponse] =
      await Promise.all([
        supabase
          .from("strategy_master")
          .select(
            `strategy_id,strategy_name,symbol,strategy_type,direction,status,entry_date,expiry_month,closed_date,realised_pnl,unrealised_mtm,total_pnl,margin_used,margin_status,margin_updated_at,market_data_updated_at,strategy_theta,delta_lot_equivalent`,
          )
          .order("entry_date", { ascending: false }),

        supabase
          .from("strategy_daily_snapshots")
          .select(
            "strategy_id,snapshot_date,captured_at,unrealised_mtm,realised_pnl,total_pnl,unrealised_capture_pct,nearest_dte",
          )
          .order("snapshot_date", { ascending: false })
          .order("captured_at", { ascending: false })
          .limit(500),

        supabase
          .from("position_closures")
          .select("close_date,realised_pnl")
          .gte("close_date", currentMonthStart),
      ]);

    try {
      if (strategiesResponse.error) {
        throw new Error(strategiesResponse.error.message);
      }

      if (snapshotsResponse.error) {
        throw new Error(snapshotsResponse.error.message);
      }

      if (closuresResponse.error) {
        throw new Error(closuresResponse.error.message);
      }

      const loadedStrategies = (strategiesResponse.data ?? []) as Strategy[];
      setStrategies(loadedStrategies);
      setDailySnapshots((snapshotsResponse.data ?? []) as DailySnapshot[]);
      setClosures((closuresResponse.data ?? []) as Closure[]);

      const timestamps = loadedStrategies
        .map((item) => item.market_data_updated_at)
        .filter(Boolean)
        .map((value) => new Date(value as string).getTime())
        .filter(Number.isFinite);

      if (timestamps.length > 0) {
        setLastPortfolioRefresh(new Date(Math.max(...timestamps)).toISOString());
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to load portfolio.",
      );
    } finally {
      if (showLoader) setLoading(false);
    }
  }

  useEffect(() => {
    void loadData(true);
  }, []);

  const openStrategies = useMemo(
    () => strategies.filter((strategy) => strategy.status !== "CLOSED"),
    [strategies],
  );

  const closedStrategies = useMemo(
    () => strategies.filter((strategy) => strategy.status === "CLOSED"),
    [strategies],
  );

  const snapshotsByStrategy = useMemo(() => {
    const grouped = new Map<string, DailySnapshot[]>();

    dailySnapshots.forEach((snapshot) => {
      const current = grouped.get(snapshot.strategy_id) ?? [];
      current.push(snapshot);
      grouped.set(snapshot.strategy_id, current);
    });

    grouped.forEach((items, strategyId) => {
      grouped.set(
        strategyId,
        [...items].sort((a, b) => {
          const dateCompare = b.snapshot_date.localeCompare(a.snapshot_date);
          if (dateCompare !== 0) return dateCompare;
          return (
            new Date(b.captured_at).getTime() -
            new Date(a.captured_at).getTime()
          );
        }),
      );
    });

    return grouped;
  }, [dailySnapshots]);

  const totalCapitalDeployed = useMemo(
    () =>
      openStrategies.reduce(
        (sum, strategy) => sum + Number(strategy.margin_used ?? 0),
        0,
      ),
    [openStrategies],
  );

  const currentPortfolioMtm = useMemo(
    () =>
      openStrategies.reduce(
        (sum, strategy) => sum + Number(strategy.unrealised_mtm ?? 0),
        0,
      ),
    [openStrategies],
  );

  const portfolioTheta = useMemo(
    () =>
      openStrategies.reduce(
        (sum, strategy) => sum + Number(strategy.strategy_theta ?? 0),
        0,
      ),
    [openStrategies],
  );

  const realisedThisMonth = useMemo(
    () =>
      closures.reduce(
        (sum, closure) => sum + Number(closure.realised_pnl ?? 0),
        0,
      ),
    [closures],
  );

  const sortedOpenStrategies = useMemo(() => {
    return [...openStrategies].sort((a, b) => {
      const bMargin = Number(b.margin_used ?? 0);
      const aMargin = Number(a.margin_used ?? 0);
      return bMargin - aMargin;
    });
  }, [openStrategies]);

  async function refreshAllMarketData() {
    if (openStrategies.length === 0 || refreshingAll) return;

    const startedAt = performance.now();

    setRefreshingAll(true);
    setRefreshError("");
    setRefreshCompleted(0);
    setRefreshTotal(openStrategies.length);
    setLastRefreshDurationMs(null);
    setRefreshStates(
      Object.fromEntries(
        openStrategies.map((strategy) => [
          strategy.strategy_id,
          { status: "REFRESHING" },
        ]),
      ),
    );

    try {
      const response = await fetch("/api/market/refresh-portfolio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message =
          typeof payload?.detail === "string"
            ? payload.detail
            : "Unable to refresh portfolio market data.";
        throw new Error(message);
      }

      const results = Array.isArray(payload?.results)
        ? payload.results
        : [];

      const nextStates: Record<string, RefreshState> = {};
      let firstError = "";

      for (const strategy of openStrategies) {
        const item = results.find(
          (result: { strategy_id?: string }) =>
            result.strategy_id === strategy.strategy_id,
        );

        if (item?.status === "SUCCESS") {
          nextStates[strategy.strategy_id] = {
            status: "SUCCESS",
            message: "Updated",
          };
        } else {
          const message =
            item?.message ?? "Strategy was not refreshed.";
          nextStates[strategy.strategy_id] = {
            status: "ERROR",
            message,
          };
          if (!firstError) firstError = message;
        }
      }

      setRefreshStates(nextStates);
      setRefreshCompleted(
        Number(payload?.strategies_updated ?? 0) +
          Number(payload?.strategies_failed ?? 0),
      );

      try {
        await fetch("/api/portfolio/snapshot", { method: "POST" });
      } catch {
        // Portfolio snapshot should never block market refresh.
      }

      await loadData(false);
      setLastPortfolioRefresh(
        payload?.refreshed_at ?? new Date().toISOString(),
      );

      if (firstError) setRefreshError(firstError);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Portfolio refresh failed.";
      setRefreshError(message);
      setRefreshStates((current) => {
        const next = { ...current };
        for (const strategy of openStrategies) {
          if (next[strategy.strategy_id]?.status === "REFRESHING") {
            next[strategy.strategy_id] = {
              status: "ERROR",
              message,
            };
          }
        }
        return next;
      });
    } finally {
      setLastRefreshDurationMs(performance.now() - startedAt);
      setRefreshingAll(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-[#f7f7f5] p-10">
        <p className="text-gray-600">Loading portfolio...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f7f7f5] px-5 py-8 text-gray-950 md:px-8 lg:px-10">
      <div className="mx-auto max-w-[1450px]">
        <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-gray-400">
              VOTE Portfolio
            </p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight">
              Strategies
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
              See portfolio P&amp;L, concentration and the few strategy metrics that matter before deciding where to focus.
            </p>
            {lastPortfolioRefresh && (
              <p className="mt-2 text-xs text-gray-400">
                Last market refresh: {new Date(lastPortfolioRefresh).toLocaleString("en-IN")}
                {lastRefreshDurationMs !== null
                  ? ` · ${(lastRefreshDurationMs / 1000).toFixed(1)}s`
                  : ""}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <a
              href={ZERODHA_LOGIN_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold text-blue-800 transition hover:bg-blue-100"
            >
              Connect Zerodha
            </a>

            <button
              type="button"
              onClick={refreshAllMarketData}
              disabled={refreshingAll || openStrategies.length === 0}
              className="rounded-xl bg-gray-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refreshingAll
                ? `Refreshing ${refreshCompleted}/${refreshTotal}`
                : "Refresh Market Data"}
            </button>

            <Link
              href="/strategies/new"
              className="rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 transition hover:border-gray-400"
            >
              + New Strategy
            </Link>
          </div>
        </header>

        {refreshError && (
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-semibold">Portfolio refresh needs attention</p>
            <p className="mt-1">{refreshError}</p>
            {requiresReconnect(refreshError) && (
              <a
                href={ZERODHA_LOGIN_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block rounded-lg bg-gray-950 px-3 py-2 text-xs font-semibold text-white"
              >
                Reconnect Zerodha
              </a>
            )}
          </div>
        )}

        {errorMessage && (
          <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {errorMessage}
          </div>
        )}

        <section className="mt-7 rounded-2xl border border-gray-200 bg-white px-5 py-5 shadow-sm md:px-6">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
            <PortfolioMetric
              label="Current MTM"
              value={formatCompactCurrency(currentPortfolioMtm)}
              valueClassName={pnlClass(currentPortfolioMtm)}
            />
            <PortfolioMetric
              label="Realised this month"
              value={formatCompactCurrency(realisedThisMonth)}
              valueClassName={pnlClass(realisedThisMonth)}
              subtext="By actual closure date"
            />
            <PortfolioMetric
              label="Capital deployed"
              value={formatCompactCurrency(totalCapitalDeployed)}
              subtext="All open strategies"
            />
            <PortfolioMetric
              label="Portfolio Theta"
              value={`${formatCompactCurrency(portfolioTheta)} / day`}
              subtext="Model estimate"
            />
            <PortfolioMetric
              label="Open strategies"
              value={String(openStrategies.length)}
              subtext="Across all expiry months"
            />
          </div>
        </section>

        {refreshingAll && (
          <section className="mt-4 rounded-xl border border-gray-200 bg-white px-4 py-3">
            <div className="flex items-center justify-between gap-4 text-xs text-gray-500">
              <span>
                Updating portfolio · {refreshCompleted} of {refreshTotal}
              </span>
              <span>Up to 3 strategies in parallel</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-gray-950 transition-all duration-300"
                style={{
                  width: `${
                    refreshTotal > 0
                      ? Math.min(100, (refreshCompleted / refreshTotal) * 100)
                      : 0
                  }%`,
                }}
              />
            </div>
          </section>
        )}

        <section className="mt-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-gray-400">
                Current portfolio
              </p>
              <h2 className="mt-1 text-2xl font-semibold">Open strategies</h2>
            </div>
            <p className="text-xs text-gray-500">
              Concentration = strategy margin ÷ total margin deployed · policy cap {CONCENTRATION_LIMIT_PCT}%
            </p>
          </div>

          {sortedOpenStrategies.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-10 text-center text-sm text-gray-500">
              No open strategies.
            </div>
          ) : (
            <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {sortedOpenStrategies.map((strategy) => {
                const history = snapshotsByStrategy.get(strategy.strategy_id) ?? [];
                const latestSnapshot = history[0] ?? null;
                const previousSnapshot = history[1] ?? null;
                const concentrationPct =
                  totalCapitalDeployed > 0
                    ? (Number(strategy.margin_used ?? 0) / totalCapitalDeployed) * 100
                    : 0;

                return (
                  <StrategyCard
                    key={strategy.strategy_id}
                    strategy={strategy}
                    concentrationPct={concentrationPct}
                    latestSnapshot={latestSnapshot}
                    previousSnapshot={previousSnapshot}
                  />
                );
              })}
            </div>
          )}
        </section>

        {closedStrategies.length > 0 && (
          <details className="mt-8 rounded-2xl border border-gray-200 bg-white shadow-sm">
            <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-gray-700">
              Closed strategies ({closedStrategies.length})
            </summary>
            <div className="border-t border-gray-200">
              {closedStrategies.map((strategy) => (
                <Link
                  key={strategy.strategy_id}
                  href={`/strategies/${encodeURIComponent(strategy.strategy_id)}`}
                  className="flex flex-col gap-2 border-t border-gray-100 px-5 py-4 first:border-t-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-semibold text-gray-900">
                      {strategy.symbol} · {strategy.strategy_name}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      Expiry {formatExpiryMonth(strategy.expiry_month)}
                    </p>
                  </div>
                  <div className="text-sm">
                    <span className="text-gray-500">Final P&amp;L </span>
                    <span className={`font-semibold ${pnlClass(strategy.total_pnl)}`}>
                      {formatCurrency(strategy.total_pnl)}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </details>
        )}

        {Object.keys(refreshStates).length > 0 && !refreshingAll && (
          <div className="mt-5 text-xs text-gray-400">
            {Object.values(refreshStates).filter((state) => state.status === "SUCCESS").length} updated · {Object.values(refreshStates).filter((state) => state.status === "ERROR").length} failed
          </div>
        )}
      </div>
    </main>
  );
}