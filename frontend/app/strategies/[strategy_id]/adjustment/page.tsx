"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import PayoffPanel from "@/components/strategy/PayoffPanel";
import {
  calculatePayoffMetrics,
  calculateStrategyPayoff,
  type StrategyLeg,
} from "@/lib/payoff";

type Strategy = {
  strategy_id: string;
  strategy_name: string;
  symbol: string;
  status: string;
  entry_spot_price: number | null;
  expiry_month: string | null;
  current_spot_price: number | null;
  market_data_updated_at: string | null;
};

type CurrentPosition = {
  id: number;
  instrument_type: string | null;
  option_type: string | null;
  strike: number | null;
  expiry_date: string | null;
  position_side: string | null;
  quantity: number | null;
  open_quantity: number | null;
  closed_quantity: number | null;
  entry_price: number | null;
  current_price: number | null;
  contract_multiplier: number | null;
  lot_size: number | null;
  mtm: number | null;
  realised_pnl: number | null;
  status: string | null;
  exchange: string | null;
  tradingsymbol: string | null;
  instrument_token: number | null;
};

type InstrumentType = "OPTION" | "FUTURE" | "EQUITY";
type PositionSide = "BUY" | "SELL";
type OptionType = "CE" | "PE" | "";

type ZerodhaInstrument = {
  instrument_token: number;
  tradingsymbol: string;
  expiry: string | null;
  strike: number;
  lot_size: number;
  instrument_type: string;
  exchange: string;
};

type DraftLeg = {
  id: number;
  instrumentType: InstrumentType;
  positionSide: PositionSide;
  optionType: OptionType;
  strike: string;
  expiryMonth: string;
  expiryDate: string;
  quantity: string;
  lots: string;
  entryPrice: string;
  instrumentToken: number | null;
  tradingsymbol: string | null;
  lotSize: number | null;
};

type ClosePlan = {
  positionId: number;
  quantityToClose: number;
  price: string;
};

const EXPIRY_MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + index);
  const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  const label = new Intl.DateTimeFormat("en-GB", {
    month: "short",
    year: "numeric",
  }).format(date);
  return { value, label };
});

function createLeg(id: number): DraftLeg {
  return {
    id,
    instrumentType: "OPTION",
    positionSide: "SELL",
    optionType: "PE",
    strike: "",
    expiryMonth: "",
    expiryDate: "",
    quantity: "",
    lots: "1",
    entryPrice: "",
    instrumentToken: null,
    tradingsymbol: null,
    lotSize: null,
  };
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function describePosition(position: CurrentPosition) {
  if (position.instrument_type === "OPTION") {
    return `${position.position_side ?? ""} ${formatNumber(position.strike)} ${position.option_type ?? ""}`.trim();
  }
  return `${position.position_side ?? ""} ${position.instrument_type ?? ""}`.trim();
}

function calculateClosurePnl(position: CurrentPosition, closingQuantity: number, closingPrice: number) {
  const multiplier = Number(position.contract_multiplier ?? 1);
  const entryPrice = Number(position.entry_price ?? 0);
  if (position.position_side === "SELL") {
    return (entryPrice - closingPrice) * closingQuantity * multiplier;
  }
  return (closingPrice - entryPrice) * closingQuantity * multiplier;
}

function positionToPayoffLeg(position: CurrentPosition, quantity: number): StrategyLeg[] {
  const side = position.position_side;
  if ((side !== "BUY" && side !== "SELL") || quantity <= 0) return [];

  const multiplier = Number(position.contract_multiplier ?? 1);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return [];

  if (
    position.instrument_type === "OPTION" &&
    (position.option_type === "CE" || position.option_type === "PE") &&
    Number.isFinite(Number(position.strike)) &&
    Number(position.strike) > 0
  ) {
    return [{
      instrumentType: "OPTION",
      side,
      optionType: position.option_type,
      strike: Number(position.strike),
      premium: Number(position.entry_price ?? 0),
      quantity,
      lotSize: multiplier,
    }];
  }

  if (position.instrument_type === "FUTURE" && Number(position.entry_price) > 0) {
    return [{
      instrumentType: "FUTURE",
      side,
      entryPrice: Number(position.entry_price),
      quantity,
      lotSize: multiplier,
    }];
  }

  return [];
}

export default function AddAdjustmentPage() {
  const params = useParams<{ strategy_id: string }>();
  const router = useRouter();
  const strategyId = decodeURIComponent(params.strategy_id);

  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [currentPositions, setCurrentPositions] = useState<CurrentPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [priceMessage, setPriceMessage] = useState("");
  const [liveSpot, setLiveSpot] = useState<number | null>(null);
  const [liveSpotUpdatedAt, setLiveSpotUpdatedAt] = useState<string | null>(null);

  const [adjustmentDate, setAdjustmentDate] = useState(new Date().toISOString().slice(0, 10));
  const [underlyingSpot, setUnderlyingSpot] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  const [legs, setLegs] = useState<DraftLeg[]>([createLeg(1)]);
  const [closePlans, setClosePlans] = useState<Record<number, ClosePlan>>({});
  const [draftConfirmed, setDraftConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [draftErrorMessage, setDraftErrorMessage] = useState("");

  const [contracts, setContracts] = useState<ZerodhaInstrument[]>([]);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [contractError, setContractError] = useState("");

  async function loadOpenPositions() {
    const { data, error } = await supabase
      .from("book_positions")
      .select(
        "id,instrument_type,option_type,strike,expiry_date,position_side,quantity,open_quantity,closed_quantity,entry_price,current_price,contract_multiplier,lot_size,mtm,realised_pnl,status,exchange,tradingsymbol,instrument_token",
      )
      .eq("strategy_id", strategyId)
      .gt("open_quantity", 0);

    if (error) throw new Error(error.message);
    setCurrentPositions((data ?? []) as CurrentPosition[]);
  }

  useEffect(() => {
    async function loadStrategy() {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("strategy_master")
          .select("strategy_id,strategy_name,symbol,status,entry_spot_price,expiry_month,current_spot_price,market_data_updated_at")
          .eq("strategy_id", strategyId)
          .single();

        if (error || !data) throw new Error(error?.message ?? "Strategy not found.");
        setStrategy(data);
        if (Number(data.current_spot_price) > 0) {
          setLiveSpot(Number(data.current_spot_price));
          setLiveSpotUpdatedAt(data.market_data_updated_at ?? null);
        }
        await loadOpenPositions();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Unable to load strategy.");
      } finally {
        setLoading(false);
      }
    }
    void loadStrategy();
  }, [strategyId]);

  useEffect(() => {
    async function loadContracts() {
      if (!strategy?.symbol) return;
      setLoadingContracts(true);
      setContractError("");
      try {
        const response = await fetch(
          `/api/market/instruments?exchange=NFO&underlying=${encodeURIComponent(strategy.symbol)}&limit=1000`,
          { cache: "no-store" },
        );
        const text = await response.text();
        let payload: any = {};
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = { detail: text }; }
        if (!response.ok) throw new Error(typeof payload?.detail === "string" ? payload.detail : "Unable to load Zerodha contracts.");
        setContracts(payload.instruments ?? []);
      } catch (error) {
        setContractError(error instanceof Error ? error.message : "Unable to load contracts.");
        setContracts([]);
      } finally {
        setLoadingContracts(false);
      }
    }
    void loadContracts();
  }, [strategy?.symbol]);

  async function refreshExistingPrices() {
    if (!strategy || refreshingPrices) return;
    setRefreshingPrices(true);
    setPriceMessage("");
    setErrorMessage("");
    try {
      const response = await fetch("/api/market/refresh-strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy_id: strategy.strategy_id }),
      });
      const text = await response.text();
      let payload: any = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { detail: text }; }
      if (!response.ok) {
        const detail = typeof payload?.detail === "string" ? payload.detail : JSON.stringify(payload?.detail ?? payload);
        throw new Error(detail || "Unable to refresh market prices.");
      }
      if (Number(payload.current_spot_price) > 0) {
        setLiveSpot(Number(payload.current_spot_price));
        setLiveSpotUpdatedAt(payload.refreshed_at ?? new Date().toISOString());
      } else {
        const { data: refreshedStrategy } = await supabase
          .from("strategy_master")
          .select("current_spot_price,market_data_updated_at")
          .eq("strategy_id", strategy.strategy_id)
          .single();

        if (Number(refreshedStrategy?.current_spot_price) > 0) {
          setLiveSpot(Number(refreshedStrategy.current_spot_price));
          setLiveSpotUpdatedAt(refreshedStrategy.market_data_updated_at ?? new Date().toISOString());
        }
      }
      await loadOpenPositions();
      setClosePlans((plans) => {
        const next = { ...plans };
        for (const position of currentPositions) {
          if (next[position.id] && position.current_price !== null) {
            next[position.id] = { ...next[position.id], price: String(position.current_price) };
          }
        }
        return next;
      });
      setPriceMessage("Live Zerodha prices refreshed.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to refresh prices.");
    } finally {
      setRefreshingPrices(false);
    }
  }

  useEffect(() => {
    if (strategy?.status === "OPEN" && currentPositions.length > 0) {
      void refreshExistingPrices();
    }
    // Run once after the strategy/open positions are initially available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy?.strategy_id]);

  function resetDraftConfirmation() {
    setDraftConfirmed(false);
    setDraftErrorMessage("");
  }

  function resolveDerivativeLeg(leg: DraftLeg): DraftLeg {
    if (leg.instrumentType === "EQUITY") return leg;
    if (!leg.expiryMonth || contracts.length === 0) {
      return { ...leg, expiryDate: "", quantity: "", instrumentToken: null, tradingsymbol: null, lotSize: null };
    }

    let candidates = contracts.filter((item) =>
      item.expiry?.slice(0, 7) === leg.expiryMonth &&
      (leg.instrumentType === "FUTURE"
        ? item.instrument_type === "FUT"
        : item.instrument_type === leg.optionType &&
          Number(leg.strike) > 0 &&
          Math.abs(Number(item.strike) - Number(leg.strike)) < 0.0001),
    );

    candidates = candidates
      .filter((item) => item.expiry)
      .sort((a, b) => String(b.expiry).localeCompare(String(a.expiry)));

    const instrument = candidates[0];
    if (!instrument) {
      return { ...leg, expiryDate: "", quantity: "", instrumentToken: null, tradingsymbol: null, lotSize: null };
    }

    const lots = Math.max(1, Number(leg.lots || 1));
    const lotSize = Number(instrument.lot_size || 1);
    return {
      ...leg,
      expiryDate: instrument.expiry ?? "",
      quantity: String(lots * lotSize),
      instrumentToken: instrument.instrument_token,
      tradingsymbol: instrument.tradingsymbol,
      lotSize,
    };
  }

  function updateLeg(legId: number, field: keyof DraftLeg, value: string) {
    resetDraftConfirmation();
    setLegs((current) => current.map((leg) => {
      if (leg.id !== legId) return leg;
      let next = { ...leg, [field]: value } as DraftLeg;
      if (field === "instrumentType" && value === "EQUITY") {
        return { ...next, expiryMonth: "", expiryDate: "", lots: "1", instrumentToken: null, tradingsymbol: null, lotSize: null };
      }
      if (["instrumentType", "optionType", "strike", "expiryMonth"].includes(field)) {
        next = resolveDerivativeLeg({ ...next, instrumentToken: null, tradingsymbol: null, lotSize: null });
      }
      return next;
    }));
  }

  function updateLots(legId: number, value: string) {
    resetDraftConfirmation();
    setLegs((current) => current.map((leg) => {
      if (leg.id !== legId) return leg;
      const lots = Math.max(1, Number(value || 1));
      const lotSize = Number(leg.lotSize || 0);
      return { ...leg, lots: value, quantity: lotSize > 0 ? String(lots * lotSize) : "" };
    }));
  }

  function addLeg() {
    resetDraftConfirmation();
    const nextId = legs.length === 0 ? 1 : Math.max(...legs.map((leg) => leg.id)) + 1;
    setLegs((current) => [...current, createLeg(nextId)]);
  }

  function removeLeg(legId: number) {
    resetDraftConfirmation();
    setLegs((current) => current.filter((leg) => leg.id !== legId));
  }

  function setCloseQuantity(position: CurrentPosition, quantityToClose: number) {
    resetDraftConfirmation();
    const openQuantity = Number(position.open_quantity ?? 0);
    const safeQuantity = Math.max(0, Math.min(openQuantity, Math.floor(quantityToClose)));
    if (safeQuantity === 0) {
      setClosePlans((current) => {
        const next = { ...current };
        delete next[position.id];
        return next;
      });
      return;
    }
    setClosePlans((current) => ({
      ...current,
      [position.id]: {
        positionId: position.id,
        quantityToClose: safeQuantity,
        price: current[position.id]?.price ?? String(position.current_price ?? ""),
      },
    }));
  }

  function setCloseLots(position: CurrentPosition, lots: number) {
    const lotSize = Number(position.lot_size ?? 0);
    if (lotSize <= 0) return;
    setCloseQuantity(position, lots * lotSize);
  }

  function updateClosePrice(positionId: number, price: string) {
    resetDraftConfirmation();
    setClosePlans((current) => current[positionId]
      ? { ...current, [positionId]: { ...current[positionId], price } }
      : current,
    );
  }

  const currentStrategyLegs = useMemo<StrategyLeg[]>(() =>
    currentPositions.flatMap((position) => positionToPayoffLeg(position, Number(position.open_quantity ?? 0))),
  [currentPositions]);

  const remainingExistingLegs = useMemo<StrategyLeg[]>(() =>
    currentPositions.flatMap((position) => {
      const open = Number(position.open_quantity ?? 0);
      const close = closePlans[position.id]?.quantityToClose ?? 0;
      return positionToPayoffLeg(position, Math.max(0, open - close));
    }),
  [currentPositions, closePlans]);

  const draftStrategyLegs = useMemo<StrategyLeg[]>(() => legs.flatMap((leg) => {
    const quantity = Number(leg.quantity);
    const entryPrice = Number(leg.entryPrice);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(entryPrice) || entryPrice < 0) return [];

    if (leg.instrumentType === "OPTION") {
      const strike = Number(leg.strike);
      if ((leg.optionType !== "CE" && leg.optionType !== "PE") || !Number.isFinite(strike) || strike <= 0) return [];
      return [{
        instrumentType: "OPTION" as const,
        side: leg.positionSide,
        optionType: leg.optionType,
        strike,
        premium: entryPrice,
        quantity,
        lotSize: 1,
      }];
    }

    if (leg.instrumentType === "FUTURE" && entryPrice > 0) {
      return [{
        instrumentType: "FUTURE" as const,
        side: leg.positionSide,
        entryPrice,
        quantity,
        lotSize: 1,
      }];
    }
    return [];
  }), [legs]);

  const previewStrategyLegs = useMemo(
    () => [...remainingExistingLegs, ...draftStrategyLegs],
    [remainingExistingLegs, draftStrategyLegs],
  );

  const chartSpot = useMemo(() => {
    const entered = Number(underlyingSpot);
    if (underlyingSpot !== "" && Number.isFinite(entered) && entered > 0) return entered;
    if (liveSpot !== null && Number.isFinite(liveSpot) && liveSpot > 0) return liveSpot;
    if (strategy?.current_spot_price !== null && Number(strategy?.current_spot_price) > 0) {
      return Number(strategy.current_spot_price);
    }
    return strategy?.entry_spot_price ?? null;
  }, [underlyingSpot, liveSpot, strategy?.current_spot_price, strategy?.entry_spot_price]);

  const plannedClosures = useMemo(
    () => Object.values(closePlans).filter((plan) => plan.quantityToClose > 0),
    [closePlans],
  );

  const hasNewLegs = draftStrategyLegs.length > 0;
  const hasChanges = plannedClosures.length > 0 || hasNewLegs;

  const currentExecutionReserve = useMemo(() => {
    return currentPositions.reduce((total, position) => {
      if (position.instrument_type !== "OPTION" || position.position_side !== "SELL") return total;
      const openQuantity = Number(position.open_quantity ?? 0);
      const lotSize = Number(position.lot_size ?? 0);
      if (openQuantity <= 0 || lotSize <= 0) return total;
      return total + (openQuantity / lotSize) * 2000;
    }, 0);
  }, [currentPositions]);

  const previewExecutionReserve = useMemo(() => {
    const remainingReserve = currentPositions.reduce((total, position) => {
      if (position.instrument_type !== "OPTION" || position.position_side !== "SELL") return total;
      const openQuantity = Number(position.open_quantity ?? 0);
      const closingQuantity = closePlans[position.id]?.quantityToClose ?? 0;
      const remainingQuantity = Math.max(0, openQuantity - closingQuantity);
      const lotSize = Number(position.lot_size ?? 0);
      if (remainingQuantity <= 0 || lotSize <= 0) return total;
      return total + (remainingQuantity / lotSize) * 2000;
    }, 0);
    const newReserve = legs.reduce((total, leg) => {
      if (leg.instrumentType !== "OPTION" || leg.positionSide !== "SELL") return total;
      const lots = Number(leg.lots ?? 0);
      return lots > 0 ? total + lots * 2000 : total;
    }, 0);
    return remainingReserve + newReserve;
  }, [currentPositions, closePlans, legs]);

  const currentRealisticMaxProfit = useMemo(() => {
    const metrics = calculatePayoffMetrics(
      calculateStrategyPayoff(currentStrategyLegs, chartSpot, 20, 401),
      chartSpot,
    );
    const theoretical = metrics.maxProfit;
    return theoretical !== null && Number.isFinite(theoretical) && theoretical > 0
      ? Math.max(0, theoretical - currentExecutionReserve)
      : null;
  }, [currentStrategyLegs, chartSpot, currentExecutionReserve]);

  const previewRealisticMaxProfit = useMemo(() => {
    const metrics = calculatePayoffMetrics(
      calculateStrategyPayoff(previewStrategyLegs, chartSpot, 20, 401),
      chartSpot,
    );
    const theoretical = metrics.maxProfit;
    return theoretical !== null && Number.isFinite(theoretical) && theoretical > 0
      ? Math.max(0, theoretical - previewExecutionReserve)
      : null;
  }, [previewStrategyLegs, chartSpot, previewExecutionReserve]);

  function validateNewLegs() {
    for (let index = 0; index < legs.length; index += 1) {
      const leg = legs[index];
      const isBlank = !leg.strike && !leg.expiryMonth && !leg.entryPrice && !leg.tradingsymbol;
      if (isBlank) continue;
      const number = index + 1;
      const quantity = Number(leg.quantity);
      const entryPrice = Number(leg.entryPrice);
      if (!Number.isInteger(quantity) || quantity <= 0) return `Draft leg ${number}: select a valid Zerodha contract and lots.`;
      if (leg.entryPrice === "" || !Number.isFinite(entryPrice) || entryPrice < 0) return `Draft leg ${number}: enter a valid entry price.`;
      if (leg.instrumentType !== "EQUITY" && !leg.expiryDate) return `Draft leg ${number}: select an expiry month and valid Zerodha contract.`;
      if (leg.instrumentType === "OPTION" && (!leg.optionType || Number(leg.strike) <= 0)) return `Draft leg ${number}: select CE/PE and a valid strike.`;
    }
    return null;
  }

  function validateClosures() {
    for (const plan of plannedClosures) {
      const position = currentPositions.find((item) => item.id === plan.positionId);
      if (!position) return "A selected position is no longer available.";
      const open = Number(position.open_quantity ?? 0);
      const price = Number(plan.price);
      if (!Number.isInteger(plan.quantityToClose) || plan.quantityToClose <= 0 || plan.quantityToClose > open) {
        return `Invalid close quantity for ${describePosition(position)}.`;
      }
      if (plan.price === "" || !Number.isFinite(price) || price < 0) {
        return `Enter a valid closing price for ${describePosition(position)}.`;
      }
    }
    return null;
  }

  function completeDraft() {
    setDraftErrorMessage("");
    if (!hasChanges) {
      setDraftErrorMessage("Simulate at least one closure or add at least one valid new leg.");
      return;
    }
    const newLegError = validateNewLegs();
    if (newLegError) { setDraftErrorMessage(newLegError); return; }
    const closeError = validateClosures();
    if (closeError) { setDraftErrorMessage(closeError); return; }
    if (previewStrategyLegs.length === 0) {
      setDraftErrorMessage("This adjustment would leave no open strategy. Use the strategy closure workflow instead.");
      return;
    }
    setDraftConfirmed(true);
  }

  function validateForm() {
    if (!strategy) return "Strategy could not be loaded.";
    if (strategy.status === "CLOSED") return "A closed strategy cannot be adjusted.";
    if (!adjustmentDate) return "Select the adjustment date.";
    const spot = Number(chartSpot);
    if (!Number.isFinite(spot) || spot <= 0) return "Refresh prices or enter a valid underlying spot override.";
    if (!reason.trim()) return "Enter the reason for the adjustment.";
    if (!hasChanges) return "There are no simulated changes to commit.";
    return validateNewLegs() ?? validateClosures();
  }

  async function saveAdjustment() {
    setErrorMessage("");
    if (!draftConfirmed) {
      setErrorMessage("Complete the draft and review the preview before committing.");
      return;
    }
    const validationError = validateForm();
    if (validationError) { setErrorMessage(validationError); return; }
    if (!strategy) return;

    setSaving(true);
    let eventId: number | null = null;
    try {
      const spot = Number(chartSpot);
      const closureSummary = plannedClosures.map((plan) => {
        const position = currentPositions.find((item) => item.id === plan.positionId)!;
        const closePrice = Number(plan.price);
        const lotSize = Number(position.lot_size ?? 0);
        const lotsClosed = lotSize > 0 ? plan.quantityToClose / lotSize : null;
        const realisedPnl = calculateClosurePnl(position, plan.quantityToClose, closePrice);
        const remainingQuantity = Math.max(0, Number(position.open_quantity ?? 0) - plan.quantityToClose);
        return [
          `• ${describePosition(position)}`,
          `  Action: ${remainingQuantity === 0 ? "FULL CLOSE" : "PARTIAL CLOSE"}`,
          `  Closed: ${lotsClosed !== null ? `${formatNumber(lotsClosed)} lot${lotsClosed === 1 ? "" : "s"} · ` : ""}Qty ${formatNumber(plan.quantityToClose)}`,
          `  Close price: ${formatCurrency(closePrice)}`,
          `  Realised P&L: ${formatCurrency(realisedPnl)}`,
          `  Remaining quantity: ${formatNumber(remainingQuantity)}`,
        ].join("\n");
      });

      const newLegSummary = legs
        .filter((leg) => Number(leg.quantity) > 0 && leg.entryPrice !== "")
        .map((leg) => {
          const lotSize = Number(leg.lotSize ?? 0);
          const quantity = Number(leg.quantity);
          const lots = leg.instrumentType !== "EQUITY" && lotSize > 0 ? quantity / lotSize : null;
          const contract = leg.instrumentType === "OPTION"
            ? `${leg.positionSide} ${leg.strike} ${leg.optionType}`
            : `${leg.positionSide} ${leg.instrumentType}`;
          return [
            `• ${contract}`,
            leg.tradingsymbol ? `  Contract: ${leg.tradingsymbol}` : null,
            leg.expiryDate ? `  Expiry: ${leg.expiryDate}` : null,
            `  Size: ${lots !== null ? `${formatNumber(lots)} lot${lots === 1 ? "" : "s"} · ` : ""}Qty ${formatNumber(quantity)}`,
            `  Entry price: ${formatCurrency(Number(leg.entryPrice))}`,
          ].filter(Boolean).join("\n");
        });

      const eventNotes = [
        "ADJUSTMENT ACTIONS",
        closureSummary.length ? `CLOSED / REDUCED LEGS\n${closureSummary.join("\n\n")}` : null,
        newLegSummary.length ? `ADDED LEGS\n${newLegSummary.join("\n\n")}` : null,
        `PROFIT POTENTIAL
Before: ${currentRealisticMaxProfit === null ? "—" : formatCurrency(currentRealisticMaxProfit)}
After: ${previewRealisticMaxProfit === null ? "—" : formatCurrency(previewRealisticMaxProfit)}
Change: ${currentRealisticMaxProfit !== null && previewRealisticMaxProfit !== null ? formatCurrency(previewRealisticMaxProfit - currentRealisticMaxProfit) : "—"}`,
        notes.trim() ? `TRADER NOTE\n${notes.trim()}` : null,
      ].filter(Boolean).join("\n\n");

      const { data: eventData, error: eventError } = await supabase
        .from("strategy_events")
        .insert({
          strategy_id: strategy.strategy_id,
          event_type: "ADJUSTMENT",
          event_date: `${adjustmentDate}T${new Date().toTimeString().slice(0, 8)}`,
          underlying_spot: spot,
          reason: reason.trim(),
          notes: eventNotes || null,
        })
        .select("id")
        .single();

      if (eventError || !eventData) throw new Error(`Unable to save adjustment event: ${eventError?.message ?? "No event ID returned"}`);
      eventId = eventData.id;

      for (const plan of plannedClosures) {
        const position = currentPositions.find((item) => item.id === plan.positionId);
        if (!position) throw new Error(`Position ${plan.positionId} is no longer available.`);

        const price = Number(plan.price);
        const open = Number(position.open_quantity ?? 0);
        const newOpen = open - plan.quantityToClose;
        const newClosed = Number(position.closed_quantity ?? 0) + plan.quantityToClose;
        const realisedThisClose = calculateClosurePnl(position, plan.quantityToClose, price);
        const newRealised = Number(position.realised_pnl ?? 0) + realisedThisClose;

        const { data: closureRecord, error: closureError } = await supabase
          .from("position_closures")
          .insert({
            position_id: position.id,
            strategy_id: strategy.strategy_id,
            close_date: adjustmentDate,
            close_price: price,
            quantity_closed: plan.quantityToClose,
            realised_pnl: realisedThisClose,
            closing_reason: reason.trim(),
            notes: `Adjustment event ${eventId}`,
          })
          .select("id")
          .single();

        if (closureError || !closureRecord) throw new Error(`Unable to record closure for ${describePosition(position)}: ${closureError?.message ?? "No closure record"}`);

        const { error: positionError } = await supabase
          .from("book_positions")
          .update({
            open_quantity: newOpen,
            closed_quantity: newClosed,
            current_price: price,
            realised_pnl: newRealised,
            mtm: newOpen === 0 ? 0 : calculateClosurePnl(position, newOpen, price),
            status: newOpen === 0 ? "CLOSED" : "PARTIALLY_CLOSED",
          })
          .eq("id", position.id);

        if (positionError) throw new Error(`Unable to update ${describePosition(position)}: ${positionError.message}`);
      }

      const newLegRows = legs
        .filter((leg) => Number(leg.quantity) > 0 && leg.entryPrice !== "")
        .map((leg) => ({
          strategy_id: strategy.strategy_id,
          strategy_event_id: eventId,
          strategy_name: strategy.strategy_name,
          symbol: strategy.symbol,
          instrument_type: leg.instrumentType,
          option_type: leg.instrumentType === "OPTION" ? leg.optionType : null,
          strike: leg.instrumentType === "OPTION" ? Number(leg.strike) : null,
          expiry_date: leg.instrumentType === "OPTION" || leg.instrumentType === "FUTURE" ? leg.expiryDate : null,
          position_side: leg.positionSide,
          quantity: Number(leg.quantity),
          open_quantity: Number(leg.quantity),
          closed_quantity: 0,
          entry_date: adjustmentDate,
          entry_price: Number(leg.entryPrice),
          current_price: Number(leg.entryPrice),
          contract_multiplier: 1,
          mtm: 0,
          realised_pnl: 0,
          status: "OPEN",
          trade_rationale: reason.trim(),
          notes: notes.trim() || null,
          exchange: leg.instrumentType === "EQUITY" ? "NSE" : "NFO",
          tradingsymbol: leg.instrumentType === "EQUITY" ? strategy.symbol : leg.tradingsymbol,
          instrument_token: leg.instrumentType === "EQUITY" ? null : leg.instrumentToken,
          lot_size: leg.instrumentType === "EQUITY" ? null : leg.lotSize,
        }));

      if (newLegRows.length > 0) {
        const { error: legsError } = await supabase.from("book_positions").insert(newLegRows);
        if (legsError) throw new Error(`Unable to save new legs: ${legsError.message}`);
      }

      const { data: allPositions, error: totalsError } = await supabase
        .from("book_positions")
        .select("open_quantity,realised_pnl,mtm")
        .eq("strategy_id", strategy.strategy_id);
      if (totalsError) throw new Error(`Adjustment saved, but strategy totals could not be read: ${totalsError.message}`);

      const realisedPnl = (allPositions ?? []).reduce((sum, position) => sum + Number(position.realised_pnl ?? 0), 0);
      const unrealisedMtm = (allPositions ?? []).reduce((sum, position) => sum + (Number(position.open_quantity ?? 0) > 0 ? Number(position.mtm ?? 0) : 0), 0);

      const { error: strategyUpdateError } = await supabase
        .from("strategy_master")
        .update({
          realised_pnl: realisedPnl,
          unrealised_mtm: unrealisedMtm,
          total_pnl: realisedPnl + unrealisedMtm,
        })
        .eq("strategy_id", strategy.strategy_id);
      if (strategyUpdateError) throw new Error(`Adjustment saved, but strategy totals could not be updated: ${strategyUpdateError.message}`);

      const maxProfitChange =
        currentRealisticMaxProfit !== null && previewRealisticMaxProfit !== null
          ? previewRealisticMaxProfit - currentRealisticMaxProfit
          : null;
      const maxProfitChangePct =
        currentRealisticMaxProfit !== null && currentRealisticMaxProfit > 0 && previewRealisticMaxProfit !== null
          ? ((previewRealisticMaxProfit - currentRealisticMaxProfit) / currentRealisticMaxProfit) * 100
          : null;
      const currentCapturePct =
        previewRealisticMaxProfit !== null && previewRealisticMaxProfit > 0
          ? Math.max(0, (unrealisedMtm / previewRealisticMaxProfit) * 100)
          : null;

      const { error: profitSnapshotError } = await supabase
        .from("strategy_profit_snapshots")
        .insert({
          strategy_id: strategy.strategy_id,
          strategy_event_id: eventId,
          event_type: "ADJUSTMENT",
          captured_at: new Date().toISOString(),
          current_spot_price: spot,
          realistic_max_profit_before: currentRealisticMaxProfit,
          realistic_max_profit_after: previewRealisticMaxProfit,
          max_profit_change: maxProfitChange,
          max_profit_change_pct: maxProfitChangePct,
          realised_pnl_at_event: realisedPnl,
          unrealised_mtm_at_event: unrealisedMtm,
          total_pnl_at_event: realisedPnl + unrealisedMtm,
          current_capture_pct: currentCapturePct,
        });

      if (profitSnapshotError) {
        throw new Error(`Adjustment was saved, but profit-potential snapshot failed: ${profitSnapshotError.message}`);
      }

      const marginResponse = await fetch("/api/strategy/recalculate-margin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy_id: strategy.strategy_id }),
      });
      const marginText = await marginResponse.text();
      let marginPayload: any = {};
      try { marginPayload = marginText ? JSON.parse(marginText) : {}; } catch { marginPayload = { detail: marginText }; }
      if (!marginResponse.ok) throw new Error(`Adjustment saved, but margin recalculation failed: ${marginPayload?.detail ?? "Unknown margin error"}`);

      router.push(`/strategies/${encodeURIComponent(strategy.strategy_id)}`);
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to commit adjustment.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="min-h-screen bg-gray-50 p-10"><p className="text-gray-600">Loading strategy...</p></main>;
  }

  if (!strategy) {
    return (
      <main className="min-h-screen bg-gray-50 p-10">
        <div className="mx-auto max-w-3xl rounded border border-gray-300 bg-white p-6">
          <h1 className="text-2xl font-semibold">Unable to load strategy</h1>
          <p className="mt-2 text-gray-600">{errorMessage || "Strategy not found."}</p>
          <Link href="/strategies" className="mt-5 inline-block font-semibold underline underline-offset-4">Return to Strategies</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 p-4 text-gray-950 md:p-8">
      <div className="mx-auto max-w-[1500px]">
        <header className="rounded-xl border border-gray-300 bg-white px-6 py-5 shadow-sm">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">{strategy.symbol}</p>
              <h1 className="mt-2 text-3xl font-bold">Adjustment Studio</h1>
              <p className="mt-2 text-sm text-gray-600">{strategy.strategy_name}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={refreshExistingPrices} disabled={refreshingPrices} className="rounded border border-blue-500 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700 disabled:opacity-50">
                {refreshingPrices ? "Refreshing..." : "Refresh Live Prices"}
              </button>
              <Link href={`/strategies/${encodeURIComponent(strategy.strategy_id)}`} className="rounded border border-gray-400 px-4 py-3 text-sm font-semibold">Return to Strategy</Link>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-green-700">Live Zerodha spot</p>
              <p className="mt-1 text-xl font-bold text-green-900">{liveSpot !== null ? formatCurrency(liveSpot) : "Waiting for refresh…"}</p>
              <p className="mt-1 text-[11px] text-green-700">
                {liveSpotUpdatedAt ? `Updated ${new Date(liveSpotUpdatedAt).toLocaleString("en-IN")}` : "The chart will switch to live spot after refresh."}
              </p>
            </div>
            {underlyingSpot !== "" && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700">Scenario override active</p>
                <p className="mt-1 text-sm font-semibold text-amber-900">Chart spot {formatCurrency(Number(underlyingSpot))}</p>
              </div>
            )}
          </div>
          {priceMessage && <p className="mt-3 text-sm text-green-700">{priceMessage}</p>}
        </header>

        <section className="mt-6 rounded-xl border border-gray-300 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-2 border-b border-gray-200 pb-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Existing legs</p>
              <h2 className="mt-1 text-xl font-semibold">Keep, partially close, or close</h2>
              <p className="mt-2 text-sm text-gray-500">Closing prices start from Zerodha LTP. You can override the simulated execution price before commit.</p>
            </div>
            <p className="text-xs text-gray-500">Nothing below is saved until Commit Adjustment.</p>
          </div>

          <div className="mt-5 space-y-3">
            {currentPositions.map((position) => {
              const openQty = Number(position.open_quantity ?? 0);
              const lotSize = Number(position.lot_size ?? 0);
              const plan = closePlans[position.id];
              const closeQty = plan?.quantityToClose ?? 0;
              const remainingQty = Math.max(0, openQty - closeQty);
              const openLots = lotSize > 0 ? openQty / lotSize : null;
              const closeLots = lotSize > 0 ? closeQty / lotSize : null;
              const maxWholeLots = lotSize > 0 ? Math.floor(openQty / lotSize) : 0;

              return (
                <div key={position.id} className={`rounded-lg border p-4 ${closeQty > 0 ? "border-orange-300 bg-orange-50" : "border-gray-200 bg-gray-50"}`}>
                  <div className="grid gap-4 lg:grid-cols-[1.5fr_repeat(4,1fr)] lg:items-center">
                    <div>
                      <p className="text-sm font-bold">{describePosition(position)}</p>
                      <p className="mt-1 text-xs text-gray-500">{position.tradingsymbol ?? position.expiry_date ?? "Open position"}</p>
                    </div>
                    <Metric label="Open" value={openLots !== null ? `${formatNumber(openLots)} lots · ${openQty}` : String(openQty)} />
                    <Metric label="Entry" value={formatCurrency(position.entry_price)} />
                    <Metric label="Live LTP" value={formatCurrency(position.current_price)} />
                    <Metric label="MTM" value={formatCurrency(position.mtm)} />
                  </div>

                  <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-gray-200 pt-4">
                    <button type="button" disabled={draftConfirmed} onClick={() => setCloseQuantity(position, 0)} className={`rounded px-3 py-2 text-xs font-semibold ${closeQty === 0 ? "bg-gray-950 text-white" : "border border-gray-300 bg-white"}`}>Keep</button>
                    {lotSize > 0 ? (
                      <label className="text-xs font-semibold text-gray-600">
                        Close lots
                        <select disabled={draftConfirmed} value={closeLots ?? 0} onChange={(event) => setCloseLots(position, Number(event.target.value))} className="ml-2 rounded border border-gray-300 bg-white px-3 py-2">
                          <option value="0">0</option>
                          {Array.from({ length: maxWholeLots }, (_, index) => index + 1).map((lots) => <option key={lots} value={lots}>{lots}</option>)}
                        </select>
                      </label>
                    ) : (
                      <label className="text-xs font-semibold text-gray-600">
                        Close quantity
                        <input disabled={draftConfirmed} type="number" min="0" max={openQty} step="1" value={closeQty} onChange={(event) => setCloseQuantity(position, Number(event.target.value))} className="ml-2 w-24 rounded border border-gray-300 bg-white px-3 py-2" />
                      </label>
                    )}
                    <button type="button" disabled={draftConfirmed} onClick={() => setCloseQuantity(position, openQty)} className="rounded border border-orange-400 bg-white px-3 py-2 text-xs font-semibold text-orange-700">Close All</button>
                    {closeQty > 0 && (
                      <label className="text-xs font-semibold text-gray-600">
                        Simulated close price
                        <input disabled={draftConfirmed} type="number" step="0.01" min="0" value={plan?.price ?? ""} onChange={(event) => updateClosePrice(position.id, event.target.value)} className="ml-2 w-32 rounded border border-gray-300 bg-white px-3 py-2" />
                      </label>
                    )}
                    <span className="ml-auto text-xs font-semibold text-gray-600">Remaining: {remainingQty}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mt-6 rounded-xl border border-gray-300 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-200 pb-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">New legs</p>
              <h2 className="mt-1 text-xl font-semibold">Build the resulting strategy</h2>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={addLeg} disabled={draftConfirmed} className="rounded border border-gray-400 px-4 py-2 text-sm font-semibold disabled:opacity-40">+ Add Leg</button>
              {draftConfirmed ? (
                <button type="button" onClick={() => setDraftConfirmed(false)} className="rounded border border-blue-500 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700">Edit Draft</button>
              ) : (
                <button type="button" onClick={completeDraft} className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Complete Draft</button>
              )}
            </div>
          </div>

          {contractError && <p className="mt-4 text-sm text-red-700">{contractError}</p>}
          {draftErrorMessage && <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{draftErrorMessage}</div>}
          {draftConfirmed && <div className="mt-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">Draft locked. The preview below is the strategy that will be committed.</div>}

          <fieldset disabled={draftConfirmed}>
            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <Field label="Adjustment date"><input type="date" value={adjustmentDate} onChange={(event) => { resetDraftConfirmation(); setAdjustmentDate(event.target.value); }} className="w-full rounded border border-gray-300 px-4 py-3" /></Field>
              <Field label="Scenario spot override (optional)">
                <input type="number" step="0.01" min="0" value={underlyingSpot} onChange={(event) => { resetDraftConfirmation(); setUnderlyingSpot(event.target.value); }} placeholder={liveSpot !== null ? `Live spot ${liveSpot}` : "Leave blank to use live Zerodha spot"} className="w-full rounded border border-gray-300 px-4 py-3" />
                <p className="mt-1 text-xs text-gray-500">Leave blank for the live Zerodha spot. Enter a value only to simulate a different underlying level.</p>
              </Field>
            </div>
            <div className="mt-5"><Field label="Reason for adjustment"><textarea value={reason} onChange={(event) => { resetDraftConfirmation(); setReason(event.target.value); }} rows={3} placeholder="What problem are you trying to solve?" className="w-full rounded border border-gray-300 px-4 py-3" /></Field></div>
            <div className="mt-5"><Field label="Additional notes"><textarea value={notes} onChange={(event) => { resetDraftConfirmation(); setNotes(event.target.value); }} rows={3} placeholder="What should this adjustment achieve?" className="w-full rounded border border-gray-300 px-4 py-3" /></Field></div>

            <div className="mt-6 space-y-4">
              {legs.map((leg, index) => {
                const isOption = leg.instrumentType === "OPTION";
                const isFuture = leg.instrumentType === "FUTURE";
                return (
                  <div key={leg.id} className="rounded-lg border border-gray-300 bg-gray-50 p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">New leg {index + 1}</p>
                      <button type="button" onClick={() => removeLeg(leg.id)} className="text-xs font-semibold underline underline-offset-4">Remove</button>
                    </div>
                    <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      <Field label="Instrument"><select value={leg.instrumentType} onChange={(event) => updateLeg(leg.id, "instrumentType", event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3"><option value="OPTION">Option</option><option value="FUTURE">Future</option><option value="EQUITY">Cash Equity</option></select></Field>
                      <Field label="Buy / Sell"><select value={leg.positionSide} onChange={(event) => updateLeg(leg.id, "positionSide", event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3"><option value="BUY">Buy</option><option value="SELL">Sell</option></select></Field>
                      {isOption && <Field label="Option type"><select value={leg.optionType} onChange={(event) => updateLeg(leg.id, "optionType", event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3"><option value="PE">PE</option><option value="CE">CE</option></select></Field>}
                      {isOption && <Field label="Strike"><input type="number" value={leg.strike} onChange={(event) => updateLeg(leg.id, "strike", event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3" /></Field>}
                      {(isOption || isFuture) && <>
                        <Field label="Expiry month"><select value={leg.expiryMonth} onChange={(event) => updateLeg(leg.id, "expiryMonth", event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3"><option value="">Select month</option>{EXPIRY_MONTH_OPTIONS.map((month) => <option key={month.value} value={month.value}>{month.label}</option>)}</select></Field>
                        <Field label="Lots"><select value={leg.lots} onChange={(event) => updateLots(leg.id, event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3">{Array.from({ length: 20 }, (_, item) => item + 1).map((lots) => <option key={lots} value={lots}>{lots} lot{lots === 1 ? "" : "s"}</option>)}</select></Field>
                        <Field label="Resolved contract"><input readOnly value={leg.tradingsymbol ? `${leg.tradingsymbol} · ${leg.expiryDate}` : loadingContracts ? "Loading Zerodha contracts..." : "Select month / strike"} className="w-full rounded border border-gray-300 bg-gray-100 px-3 py-3 text-gray-600" /><p className="mt-1 text-xs text-gray-500">{leg.lotSize ? `Lot size ${leg.lotSize} · Quantity ${leg.quantity}` : "Exact expiry and quantity are automatic"}</p></Field>
                      </>}
                      {leg.instrumentType === "EQUITY" && <Field label="Quantity"><input type="number" value={leg.quantity} onChange={(event) => updateLeg(leg.id, "quantity", event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3" /></Field>}
                      <Field label="Entry price"><input type="number" step="0.01" min="0" value={leg.entryPrice} onChange={(event) => updateLeg(leg.id, "entryPrice", event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3" /></Field>
                    </div>
                  </div>
                );
              })}
            </div>
          </fieldset>
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-gray-300 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Current realistic max profit</p>
            <p className="mt-2 text-2xl font-bold">{currentRealisticMaxProfit === null ? "—" : formatCurrency(currentRealisticMaxProfit)}</p>
          </div>
          <div className="rounded-xl border border-gray-300 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Resulting realistic max profit</p>
            <p className="mt-2 text-2xl font-bold">{previewRealisticMaxProfit === null ? "—" : formatCurrency(previewRealisticMaxProfit)}</p>
          </div>
          <div className="rounded-xl border border-gray-300 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Adjustment impact</p>
            <p className="mt-2 text-2xl font-bold">{currentRealisticMaxProfit !== null && previewRealisticMaxProfit !== null ? formatCurrency(previewRealisticMaxProfit - currentRealisticMaxProfit) : "—"}</p>
            <p className="mt-1 text-xs text-gray-500">Maximum profit can increase or decrease after an adjustment.</p>
          </div>
        </section>

        <section className="mt-6">
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Simulation</p>
            <h2 className="mt-1 text-xl font-semibold">Current vs resulting payoff</h2>
            <p className="mt-2 text-sm text-gray-500">The preview removes simulated closure quantities and adds valid new legs immediately.</p>
            <p className="mt-1 text-sm font-semibold text-green-700">Chart spot: {chartSpot !== null ? formatCurrency(chartSpot) : "—"}{underlyingSpot !== "" ? " · scenario override" : " · live Zerodha spot"}</p>
          </div>
          <div className="min-h-[680px]">
            <PayoffPanel
              legs={currentStrategyLegs}
              comparisonLegs={hasChanges ? previewStrategyLegs : undefined}
              currentSpot={chartSpot}
              expiryMonth={strategy.expiry_month}
              primaryLabel="Current"
              comparisonLabel="Resulting strategy"
              chartHeight={620}
            />
          </div>
        </section>

        {errorMessage && <div className="mt-6 rounded border border-red-300 bg-red-50 p-4"><p className="font-semibold text-red-900">Unable to save adjustment</p><p className="mt-1 text-sm text-red-800">{errorMessage}</p></div>}

        <section className="mt-6 rounded-xl border border-gray-300 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Decision summary</p>
              <h2 className="mt-1 text-xl font-semibold">Review before committing</h2>
              <p className="mt-2 text-sm text-gray-500">{plannedClosures.length} closure action{plannedClosures.length === 1 ? "" : "s"} · {draftStrategyLegs.length} new payoff leg{draftStrategyLegs.length === 1 ? "" : "s"}</p>
            </div>
            <div className="flex gap-3">
              <Link href={`/strategies/${encodeURIComponent(strategy.strategy_id)}`} className="rounded border border-gray-400 px-5 py-3 font-semibold">Cancel</Link>
              <button type="button" onClick={saveAdjustment} disabled={saving || !draftConfirmed} className="rounded bg-gray-950 px-6 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{saving ? "Committing..." : "Commit Adjustment"}</button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="mb-2 block text-sm font-semibold">{label}</label>{children}</div>;
}