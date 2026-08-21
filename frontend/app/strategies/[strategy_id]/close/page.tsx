"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Strategy = {
  strategy_id: string;
  strategy_name: string;
  symbol: string;
  status: string;
  current_spot_price: number | null;
  realised_pnl: number | null;
  unrealised_mtm: number | null;
  total_pnl: number | null;
  closed_date: string | null;
};

type Position = {
  id: number;
  instrument_type: string;
  option_type: string | null;
  strike: number | null;
  expiry_date: string | null;
  position_side: string;
  open_quantity: number;
  closed_quantity: number;
  entry_price: number;
  current_price: number | null;
  contract_multiplier: number | null;
  lot_size: number | null;
  realised_pnl: number | null;
  mtm: number | null;
  status: string;
};

const CLOSE_REASONS = [
  "Portfolio expiry policy",
  "Target achieved",
  "Risk reduction",
  "Profit booking",
  "Thesis invalidated",
  "Manual discretion",
];

function money(value: number | null | undefined) {
  const amount = Number(value ?? 0);
  return `${amount >= 0 ? "+" : "-"}₹${Math.abs(amount).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function describe(position: Position) {
  if (position.instrument_type === "OPTION") {
    return `${position.position_side} ${Number(position.strike ?? 0).toLocaleString("en-IN")} ${position.option_type ?? ""}`;
  }
  if (position.instrument_type === "FUTURE") return `${position.position_side} Future`;
  return `${position.position_side} Equity`;
}

function closurePnl(position: Position, price: number) {
  const quantity = Number(position.open_quantity ?? 0);
  const multiplier = Number(position.contract_multiplier ?? 1);
  const entry = Number(position.entry_price ?? 0);
  return position.position_side === "SELL"
    ? (entry - price) * quantity * multiplier
    : (price - entry) * quantity * multiplier;
}

export default function CloseStrategyPage() {
  const params = useParams<{ strategy_id: string }>();
  const router = useRouter();
  const strategyId = decodeURIComponent(params.strategy_id);

  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [prices, setPrices] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("Portfolio expiry policy");
  const [notes, setNotes] = useState("");
  const [finalReview, setFinalReview] = useState("");
  const [keyLesson, setKeyLesson] = useState("");
  const [wouldTradeAgain, setWouldTradeAgain] = useState("");
  const [decisionRating, setDecisionRating] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function loadData(showLoader = false) {
    if (showLoader) setLoading(true);
    const [strategyResponse, positionsResponse] = await Promise.all([
      supabase
        .from("strategy_master")
        .select("strategy_id,strategy_name,symbol,status,current_spot_price,realised_pnl,unrealised_mtm,total_pnl,closed_date")
        .eq("strategy_id", strategyId)
        .single(),
      supabase
        .from("book_positions")
        .select("id,instrument_type,option_type,strike,expiry_date,position_side,open_quantity,closed_quantity,entry_price,current_price,contract_multiplier,lot_size,realised_pnl,mtm,status")
        .eq("strategy_id", strategyId)
        .gt("open_quantity", 0)
        .order("id", { ascending: true }),
    ]);

    if (strategyResponse.error) throw new Error(strategyResponse.error.message);
    if (positionsResponse.error) throw new Error(positionsResponse.error.message);

    const nextPositions = (positionsResponse.data ?? []) as Position[];
    setStrategy(strategyResponse.data as Strategy);
    setPositions(nextPositions);
    setSelected((current) => {
      const next = { ...current };
      for (const position of nextPositions) {
        if (next[position.id] === undefined) next[position.id] = true;
      }
      return next;
    });
    setPrices((current) => {
      const next = { ...current };
      for (const position of nextPositions) {
        if (position.current_price !== null && position.current_price !== undefined) {
          next[position.id] = String(position.current_price);
        }
      }
      return next;
    });
    if (showLoader) setLoading(false);
  }

  useEffect(() => {
    void loadData(true).catch((error) => {
      setErrorMessage(error instanceof Error ? error.message : "Unable to load strategy.");
      setLoading(false);
    });
  }, [strategyId]);

  const selectedPositions = useMemo(
    () => positions.filter((position) => selected[position.id]),
    [positions, selected],
  );

  const closesEntireStrategy =
    positions.length > 0 && selectedPositions.length === positions.length;

  const estimatedRealised = useMemo(
    () =>
      selectedPositions.reduce((sum, position) => {
        const price = Number(prices[position.id]);
        return Number.isFinite(price) ? sum + closurePnl(position, price) : sum;
      }, 0),
    [selectedPositions, prices],
  );

  async function refreshClosingPrices() {
    setRefreshing(true);
    setErrorMessage("");
    try {
      const response = await fetch("/api/market/refresh-strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy_id: strategyId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload?.detail === "string" ? payload.detail : "Unable to refresh closing prices.");
      }
      await loadData(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to refresh closing prices.");
    } finally {
      setRefreshing(false);
    }
  }

  async function commitClosures() {
    if (!strategy || selectedPositions.length === 0 || saving) return;
    setErrorMessage("");

    if (!reason) {
      setErrorMessage("Select a closure reason.");
      return;
    }
    for (const position of selectedPositions) {
      const price = Number(prices[position.id]);
      if (!Number.isFinite(price) || price < 0) {
        setErrorMessage(`Enter a valid closing price for ${describe(position)}.`);
        return;
      }
    }
    if (closesEntireStrategy) {
      if (!finalReview.trim() || !keyLesson.trim() || !wouldTradeAgain || !decisionRating) {
        setErrorMessage("Complete the final strategy review before closing all remaining legs.");
        return;
      }
    }

    setSaving(true);
    try {
      const now = new Date();
      const closeDate = now.toISOString().slice(0, 10);
      const eventDate = now.toISOString();
      const eventType = closesEntireStrategy ? "CLOSURE" : "PARTIAL_EXIT";

      const actionLines = selectedPositions.map((position) => {
        const price = Number(prices[position.id]);
        return `${describe(position)} | Qty ${Number(position.open_quantity)} | Close ₹${price.toFixed(2)} | Realised ${money(closurePnl(position, price))}`;
      });

      const eventNotes = [
        "MULTI-LEG STRATEGY CLOSURE",
        ...actionLines,
        notes.trim() ? `Notes: ${notes.trim()}` : null,
        closesEntireStrategy ? `Final review: ${finalReview.trim()}` : null,
        closesEntireStrategy ? `Key lesson: ${keyLesson.trim()}` : null,
        closesEntireStrategy ? `Would trade again: ${wouldTradeAgain}` : null,
        closesEntireStrategy ? `Decision quality rating: ${decisionRating}/5` : null,
      ].filter(Boolean).join("\n");

      const { data: event, error: eventError } = await supabase
        .from("strategy_events")
        .insert({
          strategy_id: strategy.strategy_id,
          event_type: eventType,
          event_date: eventDate,
          underlying_spot: strategy.current_spot_price,
          reason,
          notes: eventNotes,
        })
        .select("id")
        .single();
      if (eventError || !event) throw new Error(eventError?.message ?? "Unable to create strategy closure event.");

      const updatedPositionIds = new Set<number>();
      for (const position of selectedPositions) {
        const price = Number(prices[position.id]);
        const realisedThisClose = closurePnl(position, price);
        const quantityClosed = Number(position.open_quantity);
        const newRealised = Number(position.realised_pnl ?? 0) + realisedThisClose;

        const { error: closureError } = await supabase.from("position_closures").insert({
          position_id: position.id,
          strategy_id: strategy.strategy_id,
          close_date: closeDate,
          quantity_closed: quantityClosed,
          close_price: price,
          realised_pnl: realisedThisClose,
          closing_reason: reason,
          notes: notes.trim() || null,
        });
        if (closureError) throw new Error(`Unable to record closure for ${describe(position)}: ${closureError.message}`);

        const { error: positionError } = await supabase
          .from("book_positions")
          .update({
            open_quantity: 0,
            closed_quantity: Number(position.closed_quantity ?? 0) + quantityClosed,
            current_price: price,
            mtm: 0,
            realised_pnl: newRealised,
            status: "CLOSED",
          })
          .eq("id", position.id);
        if (positionError) throw new Error(`Unable to close ${describe(position)}: ${positionError.message}`);
        updatedPositionIds.add(position.id);
      }

      const nextPositions = positions.map((position) => {
        if (!updatedPositionIds.has(position.id)) return position;
        const price = Number(prices[position.id]);
        return {
          ...position,
          open_quantity: 0,
          closed_quantity: Number(position.closed_quantity ?? 0) + Number(position.open_quantity),
          current_price: price,
          mtm: 0,
          realised_pnl: Number(position.realised_pnl ?? 0) + closurePnl(position, price),
          status: "CLOSED",
        };
      });

      const totalRealised = nextPositions.reduce((sum, position) => sum + Number(position.realised_pnl ?? 0), 0);
      const remainingUnrealised = nextPositions.reduce(
        (sum, position) => sum + (Number(position.open_quantity ?? 0) > 0 ? Number(position.mtm ?? 0) : 0),
        0,
      );
      const remainingOpen = nextPositions.some((position) => Number(position.open_quantity ?? 0) > 0);

      const { error: strategyError } = await supabase
        .from("strategy_master")
        .update({
          realised_pnl: totalRealised,
          unrealised_mtm: remainingUnrealised,
          total_pnl: totalRealised + remainingUnrealised,
          status: remainingOpen ? strategy.status : "CLOSED",
          closed_date: remainingOpen ? strategy.closed_date : eventDate,
        })
        .eq("strategy_id", strategy.strategy_id);
      if (strategyError) throw new Error(`Positions were closed, but strategy totals failed: ${strategyError.message}`);

      try {
        await fetch("/api/strategy/recalculate-margin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ strategy_id: strategy.strategy_id }),
        });
      } catch {
        // Closure is already committed; margin can be refreshed later if needed.
      }

      router.push(`/strategies/${encodeURIComponent(strategy.strategy_id)}`);
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to close selected strategy legs.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="min-h-screen bg-gray-50 p-8"><p>Loading closure workspace...</p></main>;
  }

  if (!strategy) {
    return <main className="min-h-screen bg-gray-50 p-8"><p>{errorMessage || "Strategy not found."}</p></main>;
  }

  return (
    <main className="min-h-screen bg-gray-50 p-5 text-gray-950 md:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-4 border-b border-gray-300 pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-gray-500">{strategy.symbol}</p>
            <h1 className="mt-2 text-3xl font-bold">Close Strategy</h1>
            <p className="mt-1 text-sm text-gray-500">{strategy.strategy_name}</p>
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={refreshClosingPrices} disabled={refreshing || saving} className="rounded border border-gray-400 px-4 py-2 text-sm font-semibold disabled:opacity-50">
              {refreshing ? "Refreshing..." : "Refresh closing prices"}
            </button>
            <Link href={`/strategies/${encodeURIComponent(strategyId)}`} className="rounded border border-gray-400 px-4 py-2 text-sm font-semibold">Cancel</Link>
          </div>
        </header>

        <section className="mt-6 rounded-xl border border-gray-300 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Underlying spot</p>
              <p className="mt-1 text-2xl font-semibold">{strategy.current_spot_price ? `₹${Number(strategy.current_spot_price).toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "—"}</p>
            </div>
            <div className="text-right">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Estimated realised P&amp;L from selected legs</p>
              <p className="mt-1 text-2xl font-semibold">{money(estimatedRealised)}</p>
            </div>
          </div>
        </section>

        <section className="mt-6 overflow-hidden rounded-xl border border-gray-300 bg-white">
          <div className="border-b border-gray-200 px-5 py-4">
            <h2 className="text-lg font-semibold">Select legs to close</h2>
            <p className="mt-1 text-sm text-gray-500">All open legs are selected by default. Deselect any leg to keep it open.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr><th className="p-3">Close</th><th className="p-3">Leg</th><th className="p-3 text-right">Qty</th><th className="p-3 text-right">Entry</th><th className="p-3 text-right">Close price</th><th className="p-3 text-right">Est. realised</th></tr>
              </thead>
              <tbody>
                {positions.map((position) => {
                  const price = Number(prices[position.id]);
                  const pnl = Number.isFinite(price) ? closurePnl(position, price) : 0;
                  return (
                    <tr key={position.id} className="border-t border-gray-200">
                      <td className="p-3"><input type="checkbox" checked={Boolean(selected[position.id])} onChange={(event) => setSelected((current) => ({ ...current, [position.id]: event.target.checked }))} /></td>
                      <td className="p-3 font-semibold">{describe(position)}</td>
                      <td className="p-3 text-right">{Number(position.open_quantity).toLocaleString("en-IN")}</td>
                      <td className="p-3 text-right">₹{Number(position.entry_price).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                      <td className="p-3 text-right"><input type="number" min="0" step="0.01" value={prices[position.id] ?? ""} onChange={(event) => setPrices((current) => ({ ...current, [position.id]: event.target.value }))} className="w-28 rounded border border-gray-300 px-2 py-1 text-right" /></td>
                      <td className="p-3 text-right font-semibold">{selected[position.id] ? money(pnl) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-6 grid gap-5 rounded-xl border border-gray-300 bg-white p-5 md:grid-cols-2">
          <div>
            <label className="text-sm font-semibold">Reason</label>
            <select value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 w-full rounded border border-gray-300 px-3 py-2">
              {CLOSE_REASONS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm font-semibold">Notes</label>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} className="mt-2 w-full rounded border border-gray-300 px-3 py-2" placeholder="Why are you closing these legs now?" />
          </div>
        </section>

        {closesEntireStrategy && (
          <section className="mt-6 grid gap-5 rounded-xl border border-gray-300 bg-white p-5 md:grid-cols-2">
            <div className="md:col-span-2"><p className="font-semibold">Final strategy review</p><p className="mt-1 text-sm text-gray-500">Required because every remaining open leg is being closed.</p></div>
            <div className="md:col-span-2"><textarea value={finalReview} onChange={(e) => setFinalReview(e.target.value)} rows={4} className="w-full rounded border border-gray-300 px-3 py-2" placeholder="What happened and how did the strategy perform?" /></div>
            <textarea value={keyLesson} onChange={(e) => setKeyLesson(e.target.value)} rows={3} className="w-full rounded border border-gray-300 px-3 py-2" placeholder="Key lesson" />
            <div className="grid gap-3 sm:grid-cols-2">
              <select value={wouldTradeAgain} onChange={(e) => setWouldTradeAgain(e.target.value)} className="rounded border border-gray-300 px-3 py-2"><option value="">Trade again?</option><option>Yes</option><option>Yes, with changes</option><option>No</option></select>
              <select value={decisionRating} onChange={(e) => setDecisionRating(e.target.value)} className="rounded border border-gray-300 px-3 py-2"><option value="">Decision rating</option>{[1,2,3,4,5].map((n) => <option key={n} value={n}>{n}/5</option>)}</select>
            </div>
          </section>
        )}

        {errorMessage && <div className="mt-6 rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800"><p className="font-semibold">Unable to close strategy</p><p className="mt-1">{errorMessage}</p></div>}

        <div className="mt-6 flex items-center justify-between rounded-xl border border-gray-300 bg-white p-5">
          <p className="text-sm text-gray-500">{selectedPositions.length} of {positions.length} open legs selected · {closesEntireStrategy ? "Strategy will be closed" : "Strategy will remain open"}</p>
          <button type="button" onClick={commitClosures} disabled={saving || selectedPositions.length === 0} className="rounded bg-gray-950 px-6 py-3 font-semibold text-white disabled:opacity-40">{saving ? "Closing..." : closesEntireStrategy ? "Close Strategy" : "Close Selected Legs"}</button>
        </div>
      </div>
    </main>
  );
}