"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

const ZERODHA_LOGIN_URL =
  "https://vote-trading-engine-1.onrender.com/auth/zerodha/login";

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
};

type MonthGroup = {
  monthKey: string;
  monthLabel: string;
  active: Strategy[];
  closed: Strategy[];
  realised: number;
  unrealised: number;
  net: number;
  margin: number;
};

type RefreshState = {
  status: "PENDING" | "REFRESHING" | "SUCCESS" | "ERROR";
  message?: string;
};

function monthKeyForStrategy(strategy: Strategy) {
  return (strategy.expiry_month || strategy.entry_date).slice(0, 7);
}

function formatMonth(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
  }).format(new Date(year, month - 1, 1));
}

function formatCurrency(value: number | null | undefined, showPlus = true) {
  const amount = Number(value ?? 0);
  const sign = amount < 0 ? "-" : showPlus && amount > 0 ? "+" : "";
  return `${sign}₹${Math.abs(amount).toLocaleString("en-IN", {
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
    text.includes("zerodha session")
  );
}

function StrategyRow({ strategy }: { strategy: Strategy }) {
  return (
    <Link
      href={`/strategies/${encodeURIComponent(strategy.strategy_id)}`}
      className="block border-t border-gray-200 px-5 py-4 transition hover:bg-gray-50"
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(240px,1.7fr)_repeat(4,minmax(120px,1fr))] xl:items-center">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-500">
              {strategy.symbol}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                strategy.status === "CLOSED"
                  ? "border-gray-300 bg-gray-100 text-gray-700"
                  : "border-emerald-300 bg-emerald-50 text-emerald-800"
              }`}
            >
              {strategy.status}
            </span>
          </div>
          <p className="mt-1 font-semibold text-gray-950">
            {strategy.strategy_name}
          </p>
        </div>

        <div>
          <p className="text-xs text-gray-500">Realised P&amp;L</p>
          <p className={`font-semibold ${pnlClass(strategy.realised_pnl)}`}>
            {formatCurrency(strategy.realised_pnl)}
          </p>
        </div>

        <div>
          <p className="text-xs text-gray-500">Unrealised MTM</p>
          <p className={`font-semibold ${pnlClass(strategy.unrealised_mtm)}`}>
            {formatCurrency(strategy.unrealised_mtm)}
          </p>
        </div>

        <div>
          <p className="text-xs text-gray-500">Net P&amp;L</p>
          <p className={`font-semibold ${pnlClass(strategy.total_pnl)}`}>
            {formatCurrency(strategy.total_pnl)}
          </p>
        </div>

        <div>
          <p className="text-xs text-gray-500">Capital Deployed</p>
          <p className="font-semibold text-gray-950">
            {Number(strategy.margin_used ?? 0) > 0
              ? formatCurrency(strategy.margin_used, false)
              : "—"}
          </p>
          {strategy.status !== "CLOSED" &&
            strategy.margin_status !== "CURRENT" && (
              <p className="text-xs text-amber-700">Refresh required</p>
            )}
        </div>
      </div>
    </Link>
  );
}

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [refreshStates, setRefreshStates] = useState<Record<string, RefreshState>>({});
  const [refreshCompleted, setRefreshCompleted] = useState(0);
  const [refreshTotal, setRefreshTotal] = useState(0);
  const [lastRefreshDurationMs, setLastRefreshDurationMs] = useState<number | null>(null);
  const [lastPortfolioRefresh, setLastPortfolioRefresh] = useState<string | null>(null);
  const [monthOpenState, setMonthOpenState] = useState<Record<string, boolean>>({});
  const [closedOpenState, setClosedOpenState] = useState<Record<string, boolean>>({});

  const currentMonthKey = new Date().toISOString().slice(0, 7);

  async function loadData(showLoader = false) {
    if (showLoader) setLoading(true);
    setErrorMessage("");

    const { data, error } = await supabase
      .from("strategy_master")
      .select(
        `strategy_id,strategy_name,symbol,strategy_type,direction,status,entry_date,expiry_month,closed_date,realised_pnl,unrealised_mtm,total_pnl,margin_used,margin_status,margin_updated_at,market_data_updated_at`,
      )
      .order("entry_date", { ascending: false });

    if (error) {
      setErrorMessage(error.message);
    } else {
      setStrategies(data ?? []);
      const timestamps = (data ?? [])
        .map((item) => item.market_data_updated_at)
        .filter(Boolean)
        .map((value) => new Date(value as string).getTime())
        .filter(Number.isFinite);
      if (timestamps.length > 0) {
        setLastPortfolioRefresh(new Date(Math.max(...timestamps)).toISOString());
      }
    }

    if (showLoader) setLoading(false);
  }

  useEffect(() => {
    void loadData(true);
  }, []);

  const monthGroups = useMemo<MonthGroup[]>(() => {
    const grouped = new Map<string, Strategy[]>();
    strategies.forEach((strategy) => {
      const key = monthKeyForStrategy(strategy);
      grouped.set(key, [...(grouped.get(key) ?? []), strategy]);
    });

    return Array.from(grouped.entries())
      .map(([monthKey, items]) => {
        const active = items.filter((item) => item.status !== "CLOSED");
        const closed = items.filter((item) => item.status === "CLOSED");
        const realised = items.reduce(
          (sum, item) => sum + Number(item.realised_pnl ?? 0),
          0,
        );
        const unrealised = active.reduce(
          (sum, item) => sum + Number(item.unrealised_mtm ?? 0),
          0,
        );
        const margin = active.reduce(
          (sum, item) => sum + Number(item.margin_used ?? 0),
          0,
        );

        return {
          monthKey,
          monthLabel: formatMonth(monthKey),
          active,
          closed,
          realised,
          unrealised,
          net: realised + unrealised,
          margin,
        };
      })
      .sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  }, [strategies]);

  async function refreshAllMarketData() {
    const openStrategies = strategies.filter(
      (strategy) => strategy.status !== "CLOSED",
    );

    if (openStrategies.length === 0 || refreshingAll) return;

    const startedAt = performance.now();
    const concurrency = Math.min(3, openStrategies.length);

    setRefreshingAll(true);
    setRefreshError("");
    setRefreshCompleted(0);
    setRefreshTotal(openStrategies.length);
    setLastRefreshDurationMs(null);
    setRefreshStates(
      Object.fromEntries(
        openStrategies.map((strategy) => [
          strategy.strategy_id,
          { status: "PENDING" },
        ]),
      ),
    );

    let nextIndex = 0;
    let firstError = "";

    async function refreshOne(strategy: Strategy) {
      setRefreshStates((current) => ({
        ...current,
        [strategy.strategy_id]: { status: "REFRESHING" },
      }));

      try {
        const response = await fetch("/api/market/refresh-strategy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ strategy_id: strategy.strategy_id }),
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          const message =
            typeof payload?.detail === "string"
              ? payload.detail
              : "Unable to refresh this strategy.";
          throw new Error(message);
        }

        setRefreshStates((current) => ({
          ...current,
          [strategy.strategy_id]: {
            status: "SUCCESS",
            message: "Updated",
          },
        }));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Refresh failed.";

        if (!firstError) firstError = message;

        setRefreshStates((current) => ({
          ...current,
          [strategy.strategy_id]: { status: "ERROR", message },
        }));
      } finally {
        setRefreshCompleted((current) => current + 1);
      }
    }

    async function worker() {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= openStrategies.length) return;

        await refreshOne(openStrategies[currentIndex]);
      }
    }

    try {
      await Promise.all(
        Array.from({ length: concurrency }, () => worker()),
      );

      // Snapshot only after all strategy refreshes complete so it captures
      // one coherent post-refresh portfolio state.
      try {
        await fetch("/api/portfolio/snapshot", { method: "POST" });
      } catch {
        // Portfolio snapshot is helpful but should never block market refresh.
      }

      await loadData(false);
      setLastPortfolioRefresh(new Date().toISOString());

      if (firstError) setRefreshError(firstError);
    } finally {
      setLastRefreshDurationMs(performance.now() - startedAt);
      setRefreshingAll(false);
    }
  }

  function isMonthOpen(monthKey: string) {
    return monthOpenState[monthKey] ?? monthKey === currentMonthKey;
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 p-10">
        <p className="text-gray-600">Loading strategies...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 p-5 text-gray-950 md:p-10">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-col gap-5 border-b border-gray-300 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-gray-500">
              Portfolio
            </p>
            <h1 className="mt-2 text-3xl font-bold">Strategies</h1>
            <p className="mt-2 text-sm text-gray-600">
              Refresh the whole portfolio here. Individual strategy pages are for analysis and decisions.
            </p>
            {lastPortfolioRefresh && (
              <p className="mt-2 text-xs text-gray-500">
                Last market refresh: {new Date(lastPortfolioRefresh).toLocaleString("en-IN")}
                {lastRefreshDurationMs !== null
                  ? ` · completed in ${(lastRefreshDurationMs / 1000).toFixed(1)}s`
                  : ""}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={refreshAllMarketData}
              disabled={refreshingAll}
              className="min-w-[210px] rounded bg-gray-950 px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-70"
            >
              {refreshingAll
                ? `Refreshing ${refreshCompleted}/${refreshTotal}...`
                : "Refresh All Market Data"}
            </button>
            <Link
              href="/strategies/new"
              className="rounded border border-gray-400 bg-white px-5 py-3 text-sm font-semibold"
            >
              + New Strategy
            </Link>
          </div>
        </header>

        {refreshError && (
          <div className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4">
            <p className="font-semibold text-amber-950">Portfolio refresh needs attention</p>
            <p className="mt-1 text-sm text-amber-800">{refreshError}</p>
            {requiresReconnect(refreshError) && (
              <a
                href={ZERODHA_LOGIN_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block rounded bg-gray-950 px-4 py-2 text-sm font-semibold text-white"
              >
                Reconnect Zerodha
              </a>
            )}
          </div>
        )}

        {refreshingAll || Object.keys(refreshStates).length > 0 ? (
          <section className="mt-5 rounded-xl border border-gray-300 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">
                Portfolio Refresh
              </p>
              <p className="text-xs font-medium text-gray-500">
                {refreshingAll
                  ? `${refreshCompleted} of ${refreshTotal} completed · up to 3 refreshing in parallel`
                  : `${Object.values(refreshStates).filter((state) => state.status === "SUCCESS").length} updated · ${Object.values(refreshStates).filter((state) => state.status === "ERROR").length} failed`}
              </p>
            </div>
            {refreshingAll && refreshTotal > 0 && (
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full bg-gray-950 transition-all duration-300"
                  style={{
                    width: `${Math.min(100, (refreshCompleted / refreshTotal) * 100)}%`,
                  }}
                />
              </div>
            )}
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {strategies
                .filter((strategy) => refreshStates[strategy.strategy_id])
                .map((strategy) => {
                  const state = refreshStates[strategy.strategy_id];
                  return (
                    <div
                      key={strategy.strategy_id}
                      className="flex items-center justify-between rounded border border-gray-200 px-3 py-2 text-sm"
                    >
                      <span className="font-medium">{strategy.symbol}</span>
                      <span
                        className={
                          state.status === "SUCCESS"
                            ? "text-emerald-700"
                            : state.status === "ERROR"
                              ? "text-red-700"
                              : "text-gray-500"
                        }
                      >
                        {state.status === "SUCCESS"
                          ? "✓ Updated"
                          : state.status === "ERROR"
                            ? "⚠ Failed"
                            : state.status === "REFRESHING"
                              ? "Refreshing..."
                              : "Waiting"}
                      </span>
                    </div>
                  );
                })}
            </div>
          </section>
        ) : null}

        {errorMessage && (
          <div className="mt-5 rounded border border-red-300 bg-red-50 p-4 text-red-800">
            {errorMessage}
          </div>
        )}

        <section className="mt-7 space-y-5 pb-12">
          {monthGroups.map((group) => {
            const monthOpen = isMonthOpen(group.monthKey);
            const closedOpen = closedOpenState[group.monthKey] ?? false;

            return (
              <article
                key={group.monthKey}
                className="overflow-hidden rounded-xl border border-gray-300 bg-white shadow-sm"
              >
                <button
                  type="button"
                  onClick={() =>
                    setMonthOpenState((current) => ({
                      ...current,
                      [group.monthKey]: !monthOpen,
                    }))
                  }
                  className="w-full px-5 py-5 text-left"
                >
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xl text-gray-500">{monthOpen ? "▾" : "▸"}</span>
                      <div>
                        <h2 className="text-xl font-bold">{group.monthLabel}</h2>
                        <p className="mt-1 text-sm text-gray-500">
                          {group.active.length} active · {group.closed.length} closed
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-5 sm:grid-cols-4 lg:min-w-[680px]">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Total Realised</p>
                        <p className={`mt-1 font-semibold ${pnlClass(group.realised)}`}>
                          {formatCurrency(group.realised)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Total Unrealised</p>
                        <p className={`mt-1 font-semibold ${pnlClass(group.unrealised)}`}>
                          {formatCurrency(group.unrealised)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Net P&amp;L</p>
                        <p className={`mt-1 font-semibold ${pnlClass(group.net)}`}>
                          {formatCurrency(group.net)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Capital Deployed</p>
                        <p className="mt-1 font-semibold">
                          {formatCurrency(group.margin, false)}
                        </p>
                      </div>
                    </div>
                  </div>
                </button>

                {monthOpen && (
                  <div className="border-t border-gray-300">
                    <div className="bg-gray-50 px-5 py-3">
                      <h3 className="font-semibold">Active Strategies</h3>
                    </div>
                    {group.active.length === 0 ? (
                      <p className="border-t border-gray-200 px-5 py-5 text-sm text-gray-500">
                        No active strategies.
                      </p>
                    ) : (
                      group.active.map((strategy) => (
                        <StrategyRow key={strategy.strategy_id} strategy={strategy} />
                      ))
                    )}

                    <button
                      type="button"
                      onClick={() =>
                        setClosedOpenState((current) => ({
                          ...current,
                          [group.monthKey]: !closedOpen,
                        }))
                      }
                      className="flex w-full items-center justify-between border-t border-gray-300 bg-gray-50 px-5 py-3 text-left"
                    >
                      <span className="font-semibold">
                        {closedOpen ? "▾" : "▸"} Closed Strategies
                      </span>
                      <span className="text-sm text-gray-500">{group.closed.length}</span>
                    </button>

                    {closedOpen &&
                      group.closed.map((strategy) => (
                        <StrategyRow key={strategy.strategy_id} strategy={strategy} />
                      ))}
                  </div>
                )}
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}