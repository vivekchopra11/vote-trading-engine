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
  type StrategyMetrics,
} from "@/lib/payoff";

type Strategy = {
  strategy_id: string;
  strategy_name: string;
  symbol: string;
  status: string;
  entry_spot_price: number | null;
  expiry_month: string | null;
};

type CurrentPosition = {
  id: number;
  instrument_type: string | null;
  option_type: string | null;
  strike: number | null;
  position_side: string | null;
  open_quantity: number | null;
  quantity: number | null;
  entry_price: number| null;
  contract_multiplier: number | null;
  lot_size: number | null;
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

const EXPIRY_MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + index);
  const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  const label = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(date);
  return { value, label };
});

type Leg = {
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

function createLeg(id: number): Leg {
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


function calculateNetCredit(legs: StrategyLeg[]) {
  return legs.reduce((total, leg) => {
    if (leg.instrumentType === "FUTURE") {
      return total;
    }

    const value = leg.premium * leg.quantity * leg.lotSize;
    return total + (leg.side === "SELL" ? value : -value);
  }, 0);
}

function formatComparisonCurrency(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }

  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}₹${Math.abs(value).toLocaleString("en-IN", {
    maximumFractionDigits: 0,
  })}`;
}

function formatComparisonNumber(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }

  return value.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  });
}

function metricDifference(
  current: number | null,
  preview: number | null,
) {
  if (current === null || preview === null) {
    return null;
  }

  return preview - current;
}

type ComparisonRow = {
  label: string;
  current: number | null;
  preview: number | null;
  difference: number | null;
  format: "currency" | "number";
  impact: string;
  impactTone: "positive" | "negative" | "neutral";
};

function buildImpact(
  label: string,
  current: number | null,
  preview: number | null,
): Pick<ComparisonRow, "impact" | "impactTone"> {
  if (current === null || preview === null) {
    return { impact: "Not available", impactTone: "neutral" };
  }

  const change = preview - current;
  const tolerance = 0.0001;

  if (Math.abs(change) < tolerance) {
    return { impact: "No material change", impactTone: "neutral" };
  }

  if (label === "Max Loss") {
    return change > 0
      ? { impact: "Downside improved", impactTone: "positive" }
      : { impact: "Downside increased", impactTone: "negative" };
  }

  if (label === "Lower Breakeven") {
    return change < 0
      ? { impact: "Lower side widened", impactTone: "positive" }
      : { impact: "Lower side narrowed", impactTone: "negative" };
  }

  if (label === "Upper Breakeven") {
    return change > 0
      ? { impact: "Upper side widened", impactTone: "positive" }
      : { impact: "Upper side narrowed", impactTone: "negative" };
  }

  return change > 0
    ? { impact: "Improved", impactTone: "positive" }
    : { impact: "Reduced", impactTone: "negative" };
}

export default function AddAdjustmentPage() {
  const params = useParams<{ strategy_id: string }>();
  const router = useRouter();

  const strategyId = decodeURIComponent(params.strategy_id);

  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [currentPositions, setCurrentPositions] = useState<
    CurrentPosition[]
  >([]);
  const [loading, setLoading] = useState(true);

  const [adjustmentDate, setAdjustmentDate] = useState(
    new Date().toISOString().slice(0, 10),
  );

  const [underlyingSpot, setUnderlyingSpot] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  const [legs, setLegs] = useState<Leg[]>([
    createLeg(1),
    createLeg(2),
  ]);

  const [draftConfirmed, setDraftConfirmed] = useState(false);
  const [confirmedDraftLegs, setConfirmedDraftLegs] =
    useState<StrategyLeg[]>([]);

  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [draftErrorMessage, setDraftErrorMessage] = useState("");
  const [contracts, setContracts] = useState<ZerodhaInstrument[]>([]);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [contractError, setContractError] = useState("");

  useEffect(() => {
    async function loadStrategy() {
      setLoading(true);

      const { data, error } = await supabase
        .from("strategy_master")
        .select(
          "strategy_id, strategy_name, symbol, status, entry_spot_price, expiry_month",
        )
        .eq("strategy_id", strategyId)
        .single();

      if (error) {
        setErrorMessage(error.message);
        setLoading(false);
        return;
      }

  setStrategy(data);

      const { data: positions, error: positionsError } =
        await supabase
          .from("book_positions")
          .select(
            "id, instrument_type, option_type, strike, position_side, open_quantity, quantity, entry_price, contract_multiplier, lot_size",
          )
          .eq("strategy_id", strategyId)
          .eq("status", "OPEN")
          .gt("open_quantity", 0);

      if (positionsError) {
setErrorMessage(positionsError.message);
        setLoading(false);
        return;
      }

      setCurrentPositions(positions ?? []);
      setLoading(false);
    }

    loadStrategy();
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
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(typeof payload?.detail === "string" ? payload.detail : "Unable to load Zerodha contracts.");
        }
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

  const currentStrategyLegs = useMemo<StrategyLeg[]>(() => {
    return currentPositions.flatMap((position) => {
      const side = position.position_side;
      const quantity = Number(
        position.open_quantity ?? position.quantity ?? 0,
 );
      const lotSize = Number(
        position.contract_multiplier ?? position.lot_size ?? 1,
      );

      if (
        (side !== "BUY" && side!== "SELL") ||
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        !Number.isFinite(lotSize) ||
        lotSize <= 0
      ) {
   return [];
      }

      if (
        position.instrument_type === "OPTION" &&
        (position.option_type === "CE" ||
          position.option_type === "PE") &&
        Number.isFinite(position.strike) &&
        Number(position.strike) > 0
      ) {
        return [
          {
instrumentType: "OPTION" as const,
            side,
            optionType: position.option_type,
            strike: Number(position.strike),
   premium: Number(position.entry_price ?? 0),
            quantity,
            lotSize,
          },
        ];
      }

      if (
        position.instrument_type === "FUTURE" &&
        Number.isFinite(position.entry_price) &&
        Number(position.entry_price) > 0
      ) {
        return [
       {
            instrumentType: "FUTURE" as const,
            side,
            entryPrice: Number(position.entry_price),
            quantity,
          lotSize,
          },
        ];
      }

      return [];
    });
  }, [currentPositions]);

  const draftStrategyLegs = useMemo<StrategyLeg[]>(() => {
    return legs.flatMap((leg) => {
      const quantity = Number(leg.quantity);
      const entryPrice = Number(leg.entryPrice);

      if (
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        !Number.isFinite(entryPrice) ||
        entryPrice < 0
      ) {
        return [];
      }

      if (leg.instrumentType === "OPTION") {
        const strike = Number(leg.strike);

        if (
          (leg.optionType !== "CE"&& leg.optionType !== "PE") ||
          !Number.isFinite(strike) ||
          strike <= 0
        ) {
          return [];
        }

        return[
          {
            instrumentType: "OPTION" as const,
            side: leg.positionSide,
            optionType: leg.optionType,
            strike,
            premium: entryPrice,
            quantity,
            lotSize: 1,
          },
        ];
      }

      if (
        leg.instrumentType === "FUTURE" &&
        entryPrice > 0
      ) {
        return [
          {
            instrumentType: "FUTURE" as const,
            side: leg.positionSide,
            entryPrice,
            quantity,
            lotSize: 1,
          },
        ];
      }

      return [];
    });
  }, [legs]);

  const previewStrategyLegs = useMemo<StrategyLeg[]>(() => {
    const activeDraftLegs = draftConfirmed
      ? confirmedDraftLegs
      : draftStrategyLegs;

    return [...currentStrategyLegs, ...activeDraftLegs];
  }, [
    currentStrategyLegs,
    draftConfirmed,
    confirmedDraftLegs,
    draftStrategyLegs,
  ]);

  const chartSpot = useMemo(() => {
    const enteredSpot = Number(underlyingSpot);

    if (
      underlyingSpot !== "" &&
    Number.isFinite(enteredSpot) &&
      enteredSpot > 0
    ) {
      return enteredSpot;
    }

    return strategy?.entry_spot_price ?? null;
  }, [underlyingSpot, strategy?.entry_spot_price]);


  const currentPayoffPoints = useMemo(
    () =>
      calculateStrategyPayoff(
        currentStrategyLegs,
        chartSpot,
        20,
        401,
      ),
    [currentStrategyLegs, chartSpot],
  );

  const previewPayoffPoints = useMemo(
    () =>
      previewStrategyLegs.length > 0
        ? calculateStrategyPayoff(
            previewStrategyLegs,
            chartSpot,
            20,
            401,
          )
        : [],
    [previewStrategyLegs, chartSpot],
  );

  const currentMetrics = useMemo<StrategyMetrics>(
    () => calculatePayoffMetrics(currentPayoffPoints, chartSpot),
    [currentPayoffPoints, chartSpot],
  );

  const previewMetrics = useMemo<StrategyMetrics | null>(
    () =>
      previewPayoffPoints.length > 0
        ? calculatePayoffMetrics(previewPayoffPoints, chartSpot)
        : null,
    [previewPayoffPoints, chartSpot],
  );

  const currentNetCredit = useMemo(
    () => calculateNetCredit(currentStrategyLegs),
    [currentStrategyLegs],
  );

  const previewNetCredit = useMemo(
    () =>
      previewStrategyLegs.length > 0
        ? calculateNetCredit(previewStrategyLegs)
        : null,
    [previewStrategyLegs],
  );

  const comparisonRows = useMemo<ComparisonRow[]>(() => {
    const definitions = [
      {
        label: "Net Credit",
        current: currentNetCredit,
        preview: previewNetCredit,
        format: "currency" as const,
      },
      {
        label: "Max Profit",
        current: currentMetrics.maxProfit,
        preview: previewMetrics?.maxProfit ?? null,
        format: "currency" as const,
      },
      {
        label: "Max Loss",
        current: currentMetrics.maxLoss,
        preview: previewMetrics?.maxLoss ?? null,
        format: "currency" as const,
      },
      {
        label: "Payoff at Spot",
        current: currentMetrics.payoffAtCurrentSpot,
        preview: previewMetrics?.payoffAtCurrentSpot ?? null,
  format: "currency" as const,
      },
      {
        label: "Lower Breakeven",
        current: currentMetrics.lowerBreakeven,
        preview: previewMetrics?.lowerBreakeven ?? null,
        format: "number" as const,
      },
      {
        label: "Upper Breakeven",
        current: currentMetrics.upperBreakeven,
        preview: previewMetrics?.upperBreakeven ?? null,
        format: "number" as const,
      },
    ];

    return definitions.map((definition) => {
      const impact = buildImpact(
        definition.label,
        definition.current,
        definition.preview,
      );

    return {
        ...definition,
        difference: metricDifference(
          definition.current,
          definition.preview,
        ),
...impact,
      };
    });
  }, [
    currentMetrics,
    previewMetrics,
    currentNetCredit,
    previewNetCredit,
  ]);

  function resetDraftConfirmation() {
    setDraftConfirmed(false);
    setConfirmedDraftLegs([]);
    setDraftErrorMessage("");
  }

  function resolveDerivativeLeg(leg: Leg): Leg {
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

  function updateLeg(
    legId: number,
    field: keyof Leg,
    value: string,
  ) {
    resetDraftConfirmation();
    setLegs((currentLegs) =>
      currentLegs.map((leg) => {
        if (leg.id !== legId) return leg;
        let next = { ...leg, [field]: value };
        if (field === "instrumentType" && value === "EQUITY") {
          return { ...next, expiryMonth: "", expiryDate: "", lots: "1", instrumentToken: null, tradingsymbol: null, lotSize: null };
        }
        if (["instrumentType", "optionType", "strike", "expiryMonth"].includes(field)) {
          next = resolveDerivativeLeg({ ...next, instrumentToken: null, tradingsymbol: null, lotSize: null });
        }
        return next;
      }),
    );
  }

  function updateLots(legId: number, value: string) {
    resetDraftConfirmation();
    setLegs((currentLegs) =>
      currentLegs.map((leg) => {
        if (leg.id !== legId) return leg;
        const lots = Math.max(1, Number(value || 1));
        const lotSize = Number(leg.lotSize || 0);
        return { ...leg, lots: value, quantity: lotSize > 0 ? String(lots * lotSize) : "" };
      }),
    );
  }

  function addLeg() {
    resetDraftConfirmation();

    const nextId =
      legs.length === 0
        ? 1
        : Math.max(...legs.map((leg) => leg.id)) + 1;

    setLegs((currentLegs) => [
      ...currentLegs,
      createLeg(nextId),
    ]);
  }

  function removeLeg(legId: number) {
    resetDraftConfirmation();

    setLegs((currentLegs) =>
      currentLegs.filter((leg) => leg.id !== legId),
    );
  }

  function validateDraftForPreview(): string | null {
    if (legs.length === 0) {
      return "Add at least one draft leg before generating the preview.";
    }

    for (let index = 0; index < legs.length; index += 1) {
      const leg = legs[index];
      const legNumber = index + 1;
      const quantity = Number(leg.quantity);
      const entryPrice = Number(leg.entryPrice);

      if (leg.instrumentType === "EQUITY") {
        return `Draft leg ${legNumber}: equity payoff preview is not supported yet.`;
      }

      if (!Number.isInteger(quantity) || quantity <= 0) {
        return `Draft leg ${legNumber}: quantity must be a positive whole number.`;
  }

      if (
        leg.entryPrice === "" ||
        !Number.isFinite(entryPrice) ||
        entryPrice < 0
      ) {
        return `Draft leg ${legNumber}: enter a valid entry price.`;
      }

      if (!leg.expiryDate) {
        return `Draft leg ${legNumber}: select an expiry month and valid Zerodha contract.`;
      }

      if (leg.instrumentType === "OPTION") {
        const strike = Number(leg.strike);

        if (leg.optionType !== "CE" && leg.optionType !== "PE") {
          return `Draft leg ${legNumber}: select CE or PE.`;
        }

        if (!Number.isFinite(strike) || strike <= 0) {
          return `Draft leg ${legNumber}: enter a valid strike.`;
        }
      }

      if (
        leg.instrumentType === "FUTURE" &&
        entryPrice <= 0
      ) {
        return `Draft leg ${legNumber}: futures entry price must be greater than zero.`;
      }
    }

    return null;
  }

  function completeDraft() {
    setErrorMessage("");
    setDraftErrorMessage("");

    const validationError = validateDraftForPreview();

    if (validationError) {
      setDraftErrorMessage(validationError);
      return;
    }

    setConfirmedDraftLegs(draftStrategyLegs);
    setDraftConfirmed(true);
  }

  function editDraft() {
    setDraftConfirmed(false);
    setConfirmedDraftLegs([]);
  }

  function validateForm(): string | null {
    if (!strategy) {
      return "Strategy could not be loaded.";
    }

    if (strategy.status === "CLOSED") {
      return "A closed strategy cannot be adjusted.";
    }

    if (!adjustmentDate) {
      return "Please enter the adjustment date.";
    }

    const spot = Number(underlyingSpot);

    if (
    underlyingSpot === "" ||
      !Number.isFinite(spot) ||
      spot <= 0
    ) {
      return "Please enter a valid underlying spot price.";
    }

    if (!reason.trim()) {
      return "Please enter the reason for the adjustment.";
    }

    if (legs.length === 0) {
      return "At least one adjustment leg is required.";
    }

    for (let index = 0; index < legs.length; index += 1) {
      const leg = legs[index];
      const legNumber =index + 1;

      const quantity = Number(leg.quantity);
      const entryPrice = Number(leg.entryPrice);
      const strike = Number(leg.strike);

 if (!Number.isInteger(quantity) || quantity <= 0) {
        return `Leg ${legNumber}: quantity must be a positive whole number.`;
      }

      if (
     leg.entryPrice === "" ||
        !Number.isFinite(entryPrice) ||
        entryPrice < 0
      ) {
        return `Leg ${legNumber}: entry price must be zero or higher.`;
      }

      if (leg.instrumentType === "OPTION") {
        if (!leg.optionType) {
          return `Leg ${legNumber}: select CE or PE.`;
        }

        if (!Number.isFinite(strike) || strike <= 0) {
          return `Leg ${legNumber}: enter a valid strike.`;
        }

   if (!leg.expiryDate) {
          return `Leg ${legNumber}: select an expiry month and valid Zerodha option contract.`;
        }
      }

      if (
        leg.instrumentType === "FUTURE" &&
        (!leg.expiryMonth || !leg.expiryDate || !leg.instrumentToken || !leg.lotSize)
      ) {
        return `Leg ${legNumber}: select an expiry month and valid Zerodha futures contract.`;
      }
    }

    return null;
  }

  async function saveAdjustment() {
    setErrorMessage("");

    if (!draftConfirmed) {
      setErrorMessage(
        "Complete the draft and review the preview before committing the adjustment.",
      );
      return;
    }

    const validationError = validateForm();

    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    if (!strategy) {
      return;
    }

    setSaving(true);

    try {
      const spot = Number(underlyingSpot);

      const { data: eventData, error: eventError } =
        await supabase
          .from("strategy_events")
 .insert({
            strategy_id: strategy.strategy_id,
            event_type: "ADJUSTMENT",
            event_date: `${adjustmentDate}T00:00:00`,
         underlying_spot: spot,
            reason: reason.trim(),
            notes: notes.trim() || null,
          })
          .select("id")
   .single();

      if (eventError || !eventData) {
        throw new Error(
          `Unable to save adjustment event: ${
            eventError?.message ?? "No event ID returned"
          }`,
        );
      }

      const eventId = eventData.id;

      const positionRows = legs.map((leg) => {
      const quantity = Number(leg.quantity);
        const entryPrice = Number(leg.entryPrice);

        return {
          strategy_id: strategy.strategy_id,
          strategy_event_id: eventId,
          strategy_name: strategy.strategy_name,
          symbol: strategy.symbol,

          instrument_type:leg.instrumentType,

          option_type:
            leg.instrumentType === "OPTION"
              ? leg.optionType
              : null,

  strike:
            leg.instrumentType === "OPTION"
              ? Number(leg.strike)
              : null,

          expiry_date:
            leg.instrumentType === "OPTION" ||
            leg.instrumentType === "FUTURE"
              ? leg.expiryDate
              : null,

          position_side: leg.positionSide,

          quantity,
          open_quantity: quantity,
          closed_quantity: 0,

          entry_date: adjustmentDate,
     entry_price: entryPrice,
          current_price: entryPrice,

          contract_multiplier: 1,

          mtm: 0,
          realised_pnl: 0,
      status: "OPEN",

          trade_rationale: reason.trim(),
          notes: notes.trim() || null,

          exchange:
            leg.instrumentType === "EQUITY"
              ? "NSE"
              : "NFO",

          tradingsymbol:
            leg.instrumentType === "EQUITY"
              ? strategy.symbol
              : leg.tradingsymbol,

          instrument_token:
            leg.instrumentType === "EQUITY" ? null : leg.instrumentToken,
          lot_size:
            leg.instrumentType === "EQUITY" ? null : leg.lotSize,
        };
      });

      const { error: legsError } = await supabase
        .from("book_positions")
        .insert(positionRows);

      if (legsError) {
        await supabase
          .from("strategy_events")
          .delete()
          .eq("id", eventId);

        throw new Error(
          `Adjustment event was created, but the new legs could not be saved: ${legsError.message}`,
        );
      }

      const marginResponse = await fetch("/api/strategy/recalculate-margin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy_id: strategy.strategy_id }),
      });
      const marginPayload = await marginResponse.json().catch(() => ({}));
      if (!marginResponse.ok) {
        throw new Error(
          `Adjustment saved, but margin recalculation failed: ${marginPayload?.detail ?? "Unknown margin error"}`,
        );
      }

      router.push(
        `/strategies/${encodeURIComponent(
          strategy.strategy_id,
        )}`,
      );

      router.refresh();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "An unexpected error occurred.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 p-10">
        <p className="text-gray-600">
          Loading strategy...
        </p>
      </main>
    );
 }

  if (!strategy) {
    return (
      <main className="min-h-screen bg-gray-50 p-10">
        <div className="mx-auto max-w-3xl rounded border border-gray-300 bg-white p-6">
          <h1 className="text-2xl font-semibold">
            Unable to load strategy
          </h1>

          <p className="mt-2 text-gray-600">
            {errorMessage || "Strategy not found."}
          </p>

          <Link
            href="/strategies"
    className="mt-5 inline-block font-semibold underline underline-offset-4"
          >
            Return to Strategies
          </Link>
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
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
                {strategy.symbol}
              </p>
              <h1 className="mt-2 text-3xl font-bold">Adjustment Studio</h1>
              <p className="mt-2 text-sm text-gray-600">{strategy.strategy_name}</p>
            </div>
            <div className="flex flex-col items-start gap-3 sm:flex-rowsm:items-center">
              <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-700">
                  Simulation mode
                </p>
                <p className="mt-1 text-xs text-blue-700">
                  Nothing is saved until you commit the adjustment.
                </p>
              </div>
              <Link
 href={`/strategies/${encodeURIComponent(strategy.strategy_id)}`}
                className="rounded border border-gray-400 px-4 py-3 text-sm font-semibold"
              >
                Return to Strategy
              </Link>
            </div>
          </div>
        </header>

        <section className="mt-6 grid items-start gap-6 xl:grid-cols-[45fr_55fr]">
          <div className="rounded-xl border border-gray-300 bg-white p-6 shadow-sm">
     <div className="flex items-center justify-between border-b border-gray-200 pb-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Strategy context</p>
                <h2 className="mt-1 text-xl font-semibold">Current position</h2>
          </div>
              <span className="rounded border border-gray-300 px-3 py-1 text-xs font-semibold">
                {strategy.status}
       </span>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <ContextMetric label="Symbol" value={strategy.symbol} />
              <ContextMetric label="Strategy" value={strategy.strategy_name} />
              <ContextMetric label="Status" value={strategy.status} />
              <ContextMetric
                label="Entry spot"
                value={
                  strategy.entry_spot_price === null
                    ? "—"
                    : `₹${strategy.entry_spot_price.toLocaleString(
                        "en-IN",
  { maximumFractionDigits: 2 },
                      )}`
                }
              />
              <ContextMetric
                label="Open legs"
                value={String(currentPositions.length)}
              />
              <ContextMetric label="Strategy ID" value={strategy.strategy_id} />
            </div>

            <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-5">
              <p className="text-sm font-semibold">Current strategy details</p>
              <p className="mt-2 text-sm leading-6 text-gray-500">
                Open legs, MTM, thesis, adjustment plan and current payoff will appear here in the next sprint.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-gray-300 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-3 border-b border-gray-200 pb-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Adjustment builder</p>
                <h2 className="mt-1 text-xl font-semibold">Draft adjustment</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={addLeg}
                  disabled={draftConfirmed}
                  className="rounded border border-gray-400 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
     >
                  + Add Leg
                </button>

                {draftConfirmed ? (
                  <button
                    type="button"
                    onClick={editDraft}
                    className="rounded border border-blue-500 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700"
                  >
                    Edit Draft
                  </button>
                ) : (
                  <button
      type="button"
                    onClick={completeDraft}
                    className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
                  >
                    Complete Draft
                  </button>
                )}
              </div>
            </div>

          {draftErrorMessage && (
              <div className="mt-4 rounded border border-red-300 bg-red-50 px-4 py-3">
                <p className="text-sm font-semibold text-red-900">
                  Draft is not complete
                </p>

                <p className="mt-1 text-sm text-red-800">
                  {draftErrorMessage}
                </p>
              </div>
            )}

            {draftConfirmed && (
              <div className="mt-5 rounded border border-green-200 bg-green-50 px-4 py-3">
                <p className="text-sm font-semibold text-green-800">
    Draft completed
                </p>

                <p className="mt-1 text-xs text-green-700">
                  The preview is based on this locked draft. Select Edit Draft to make changes.
                </p>
              </div>
            )}

            <fieldset disabled={draftConfirmed}>
             <div className="mt-5 grid gap-5 md:grid-cols-2">
              <Field label="Adjustment date">
                <input type="date" value={adjustmentDate} onChange={(event) => setAdjustmentDate(event.target.value)} className="w-full rounded border border-gray-300 px-4 py-3" />
              </Field>
              <Field label="Underlying spot">
                <input type="number" step="0.01" min="0" value={underlyingSpot} onChange={(event)=> setUnderlyingSpot(event.target.value)} placeholder="Spot at adjustment" className="w-full rounded border border-gray-300 px-4 py-3" />
              </Field>
            </div>

            <div className="mt-5">
              <Field label="Reason for adjustment">
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} placeholder="What problem are you trying to solve?" className="w-full rounded border border-gray-300 px-4 py-3" />
              </Field>
            </div>

            <div className="mt-5">
              <Field label="Additional notes">
                <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} placeholder="What should this adjustment achieve?" className="w-full rounded border border-gray-300 px-4 py-3" />
              </Field>
            </div>

            <div className="mt-6 space-y-4">
           {legs.map((leg, index) => {
                const isOption = leg.instrumentType === "OPTION";
                const isFuture = leg.instrumentType === "FUTURE";

                return (
                  <div key={leg.id} className="rounded-lg border border-gray-300 bg-gray-50 p-4">
         <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">Draft leg {index + 1}</p>
                        <p className="mt-1 text-sm font-semibold">
         {leg.positionSide} {isOption ? `${leg.strike || "—"} ${leg.optionType || ""}` : leg.instrumentType}
                        </p>
       </div>
                      {legs.length > 1 && (
                        <button type="button" onClick={() => removeLeg(leg.id)} className="text-sm font-semibold underline underline-offset-4">Remove</button>
                      )}
                    </div>

                    <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      <Field label="Instrument">
                        <select value={leg.instrumentType} onChange={(event) => updateLeg(leg.id, "instrumentType", event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3">
                     <option value="OPTION">Option</option>
                          <option value="FUTURE">Future</option>
                          <option value="EQUITY">Cash Equity</option>
                        </select>
                      </Field>

                      <Field label="Buy / Sell">
                        <select value={leg.positionSide} onChange={(event) => updateLeg(leg.id, "positionSide", event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3">
                          <option value="BUY">Buy</option>
                          <option value="SELL">Sell</option>
                        </select>
                      </Field>

                      {isOption && (
                        <Field label="Option type">
                          <select value={leg.optionType} onChange={(event) => updateLeg(leg.id, "optionType", event.target.value)}className="w-full rounded border border-gray-300 bg-white px-3 py-3">
                            <option value="PE">PE</option>
    <option value="CE">CE</option>
                          </select>
                        </Field>
                      )}

{isOption && (
                        <Field label="Strike">
                          <input type="number" value={leg.strike} onChange={(event) => updateLeg(leg.id, "strike", event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3" />
                        </Field>
                   )}

                      {(isOption || isFuture) && (
                        <>
                          <Field label="Expiry month">
                            <select
                              value={leg.expiryMonth}
                              onChange={(event) => updateLeg(leg.id, "expiryMonth", event.target.value)}
                              className="w-full rounded border border-gray-300 bg-white px-3 py-3"
                            >
                              <option value="">Select month</option>
                              {EXPIRY_MONTH_OPTIONS.map((month) => (
                                <option key={month.value} value={month.value}>{month.label}</option>
                              ))}
                            </select>
                          </Field>
                          <Field label="Lots">
                            <select
                              value={leg.lots}
                              onChange={(event) => updateLots(leg.id, event.target.value)}
                              className="w-full rounded border border-gray-300 bg-white px-3 py-3"
                            >
                              {Array.from({ length: 20 }, (_, item) => item + 1).map((lots) => (
                                <option key={lots} value={lots}>{lots} lot{lots === 1 ? "" : "s"}</option>
                              ))}
                            </select>
                          </Field>
                          <Field label="Resolved contract">
                            <input
                              value={leg.tradingsymbol ? `${leg.tradingsymbol} · ${leg.expiryDate}` : (loadingContracts ? "Loading Zerodha contracts..." : "Select month / strike")}
                              readOnly
                              className="w-full rounded border border-gray-300 bg-gray-100 px-3 py-3 text-gray-600"
                            />
                            <p className="mt-1 text-xs text-gray-500">
                              {leg.lotSize ? `Lot size ${leg.lotSize} · Quantity ${leg.quantity}` : "Exact expiry and quantity are populated automatically"}
                            </p>
                          </Field>
                        </>
                      )}

                      {leg.instrumentType === "EQUITY" && (
                        <Field label="Quantity">
                          <input type="number" value={leg.quantity} onChange={(event) => updateLeg(leg.id, "quantity", event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3" />
                        </Field>
                      )}

                      <Field label="Entry price">
        <input type="number" step="0.01" min="0" value={leg.entryPrice} onChange={(event) => updateLeg(leg.id, "entryPrice", event.target.value)} className="w-full rounded border border-gray-300 bg-white px-3 py-3" />
                      </Field>
                    </div>
                  </div>
             );
              })}
            </div>
            </fieldset>
          </div>
        </section>

        <section className="mt-6">
          <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">
                Simulation
              </p>

              <h2 className="mt-1 text-xl font-semibold">
                Current vs preview payoff
              </h2>
            </div>

            <p className="text-xs text-gray-500">
   Complete the draft to overlay the proposed strategy on the current payoff.
            </p>
          </div>

          <div className="min-h-[680px]">
            <PayoffPanel
              legs={currentStrategyLegs}
              comparisonLegs={
                draftStrategyLegs.length > 0
                  ? previewStrategyLegs
                  : undefined
              }
              currentSpot={chartSpot}
              expiryMonth={strategy.expiry_month}
              primaryLabel="Current"
            comparisonLabel="Preview"
              chartHeight={620}
            />
          </div>

          {!draftConfirmed && (
            <div className="mt-4 rounded-lg border border-dashed border-blue-300 bg-blue-50 px-5 py-4 text-sm text-blue-800">
              The preview curve updates automatically while you build the adjustment. Complete Draft only locks the proposal before commit.
            </div>
          )}
        </section>

        <section className="mt-6 rounded-xl border border-gray-300 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Before vs after</p>
  <h2 className="mt-1 text-xl font-semibold">Adjustment comparison</h2>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-3">Metric</th>
                  <th className="p-3 text-right">Current</th>
                  <th className="p-3 text-right">Preview</th>
                  <th className="p-3 text-right">Difference</th>
                  <th className="p-3">Impact</th>
                </tr>
              </thead>
   <tbody>
                {comparisonRows.map((row) => {
                  const formatter =
                    row.format === "currency"
         ? formatComparisonCurrency
                      : formatComparisonNumber;

                  const toneClass =
                    row.impactTone === "positive"
                      ? "text-green-700"
                      : row.impactTone === "negative"
                        ? "text-red-700"
                        : "text-gray-500";

                  return (
                    <tr
                      key={row.label}
        className="border-t border-gray-200"
                    >
                      <td className="p-3 font-semibold">
                        {row.label}
                      </td>

                      <td className="p-3 text-right">
                        {formatter(row.current)}
          </td>

                      <td className="p-3 text-right font-semibold">
                        {previewMetrics
                          ? formatter(row.preview)
                          : "—"}
                      </td>

                      <td className={`p-3 text-right font-semibold ${toneClass}`}>
                        {previewMetrics
                          ? formatter(row.difference)
                          : "—"}
           </td>

                      <td className={`p-3 font-semibold ${toneClass}`}>
                        {previewMetrics
                          ? row.impact
                          : "Waiting for valid draft leg"}
                      </td>
                    </tr>
                  );
    })}
              </tbody>
            </table>
          </div>
        </section>

        {errorMessage && (
          <div className="mt-6 rounded border border-red-300 bg-red-50 p-4">
            <p className="font-semibold text-red-900">Unable to save adjustment</p>
            <p className="mt-1 text-sm text-red-800">{errorMessage}</p>
          </div>
        )}

        <section className="mt-6 rounded-xl border border-gray-300 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Decision summary</p>
              <h2 className="mt-1 text-xl font-semibold">Review before committing</h2>
              <p className="mt-2 text-sm text-gray-500">{draftConfirmed
                ? "Review the quantified payoff changes abovebefore committing the adjustment."
                : "Complete at least one valid draft leg to generate the preview."}</p>
            </div>
 <div className="flex flex-col gap-3 sm:flex-row">
              <Link href={`/strategies/${encodeURIComponent(strategy.strategy_id)}`} className="roundedborder border-gray-400 px-5 py-3 text-center font-semibold">Cancel</Link>
              <button type="button" onClick={saveAdjustment} disabled={saving ||!draftConfirmed} className="rounded bg-gray-950 px-6 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
                {saving ? "Committing..." : "Commit Adjustment"}
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
);
}


type ContextMetricProps = {
  label: string;
  value: string;
};

function ContextMetric({ label, value }: ContextMetricProps) {
  return (
   <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">{label}</p>
      <p className="mt-2 break-words text-sm font-semibold">{value}</p>
    </div>
  );
}

type FieldProps = {
  label: string;
  children: React.ReactNode;
};

function Field({ label, children }: FieldProps) {
  return (
    <div>
      <label className="mb-2 block text-sm font-semibold">
        {label}
      </label>

      {children}
    </div>
  );
}