"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Stock = {
  id: number;
  symbol: string;
  company_name: string;
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

type Leg = {
  id: number;
  instrumentType: InstrumentType;
  positionSide: PositionSide;
  optionType: OptionType;
  strike: string;
  expiryDate: string;
  quantity: string;
  lots: string;
  entryPrice: string;
  instrumentToken: number | null;
  tradingsymbol: string | null;
  lotSize: number | null;
};

const strategyTemplates = [
  "SHORT_PUT",
  "SHORT_CALL",
  "SHORT_STRANGLE",
  "BULL_PUT_SPREAD",
  "BEAR_CALL_SPREAD",
  "COVERED_CALL",
  "COLLAR",
  "CALENDAR",
  "CUSTOM",
] as const;

type StrategyTemplate = (typeof strategyTemplates)[number];

const strategyLabels: Record<StrategyTemplate, string> = {
  SHORT_PUT: "Short Put",
  SHORT_CALL: "Short Call",
  SHORT_STRANGLE: "Short Strangle",
  BULL_PUT_SPREAD: "Bull Put Spread",
  BEAR_CALL_SPREAD: "Bear Call Spread",
  COVERED_CALL: "Covered Call",
  COLLAR: "Collar",
  CALENDAR: "Calendar",
  CUSTOM: "Custom",
};

function createLeg(
  id: number,
  instrumentType: InstrumentType,
  positionSide: PositionSide,
  optionType: OptionType = "",
): Leg {
  return {
    id,
    instrumentType,
    positionSide,
    optionType,
    strike: "",
    expiryDate: "",
    quantity: "",
    lots: "1",
    entryPrice: "",
    instrumentToken: null,
    tradingsymbol: null,
    lotSize: null,
  };
}

function legsForTemplate(template: StrategyTemplate): Leg[] {
  switch (template) {
    case "SHORT_PUT":
      return [createLeg(1, "OPTION", "SELL", "PE")];

    case "SHORT_CALL":
      return [createLeg(1, "OPTION", "SELL", "CE")];

    case "SHORT_STRANGLE":
      return [
        createLeg(1, "OPTION", "SELL", "PE"),
        createLeg(2, "OPTION", "SELL", "CE"),
      ];

    case "BULL_PUT_SPREAD":
      return [
        createLeg(1, "OPTION", "SELL", "PE"),
        createLeg(2, "OPTION", "BUY", "PE"),
      ];

    case "BEAR_CALL_SPREAD":
      return [
        createLeg(1, "OPTION", "SELL", "CE"),
        createLeg(2, "OPTION", "BUY", "CE"),
      ];

case "COVERED_CALL":
      return [
        createLeg(1, "EQUITY", "BUY"),
        createLeg(2, "OPTION", "SELL", "CE"),
      ];

    case "COLLAR":
      return [
        createLeg(1, "EQUITY", "BUY"),
        createLeg(2, "OPTION", "BUY", "PE"),
        createLeg(3, "OPTION", "SELL", "CE"),
      ];

    case "CALENDAR":
      return [
        createLeg(1, "OPTION", "SELL", "CE"),
        createLeg(2, "OPTION", "BUY", "CE"),
      ];

    case "CUSTOM":
    default:
      return [createLeg(1, "OPTION", "SELL", "PE")];
  }
}

export default function NewStrategyPage() {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loadingStocks, setLoadingStocks] = useState(true);

  const [symbol, setSymbol] = useState("");
  const [template, setTemplate] =
    useState<StrategyTemplate>("SHORT_PUT");

  const [direction, setDirection] = useState("BULLISH");

  const [entryDate, setEntryDate] = useState(
    new Date().toISOString().slice(0, 10),
  );

  const [expiryMonth, setExpiryMonth] = useState("");
  const [entrySpotPrice, setEntrySpotPrice] = useState("");
  const [strategyName, setStrategyName] = useState("");

  const [tradeThesis, setTradeThesis] = useState("");
  const [adjustmentPlan, setAdjustmentPlan] = useState("");
  const [exitPlan, setExitPlan] = useState("");

  const [legs, setLegs] = useState<Leg[]>(
    legsForTemplate("SHORT_PUT"),
  );

  const [contracts, setContracts] = useState<ZerodhaInstrument[]>([]);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [contractError, setContractError] = useState("");

  const [checklist, setChecklist] = useState({
    volatilityReviewed: false,
   levelsIdentified: false,
    corporateEventsChecked: false,
    positionSizeChecked: false,
    concentrationChecked: false,
    exitPlanDefined: false,
  });

  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  useEffect(() => {
    async function loadStocks() {
      const { data, error } = await supabase
        .from("stocks")
  .select("id, symbol, company_name")
        .order("symbol");

      if (!error) {
        setStocks(data ?? []);
      }

      setLoadingStocks(false);
    }

    loadStocks();
  }, []);

  useEffect(() => {
    async function loadContracts() {
      if (!symbol || !expiryMonth) {
        setContracts([]);
        return;
      }

      setLoadingContracts(true);
      setContractError("");

      try {
        const response = await fetch(
          `/api/market/instruments?exchange=NFO&underlying=${encodeURIComponent(symbol)}&limit=1000`,
          { cache: "no-store" },
        );
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(
            typeof payload?.detail === "string"
              ? payload.detail
              : "Unable to load Zerodha contracts.",
          );
        }

        const monthContracts = (payload.instruments ?? []).filter(
          (item: ZerodhaInstrument) =>
            item.expiry && item.expiry.slice(0, 7) === expiryMonth,
        );
        setContracts(monthContracts);
      } catch (error) {
        setContractError(
          error instanceof Error ? error.message : "Unable to load contracts.",
        );
        setContracts([]);
      } finally {
        setLoadingContracts(false);
      }
    }

    void loadContracts();
  }, [symbol, expiryMonth]);

  useEffect(() => {
    if (loadingContracts || contracts.length === 0) return;

    setLegs((current) =>
      current.map((leg) => {
        if (leg.instrumentType === "EQUITY") return leg;

        let candidates = contracts.filter((item) =>
          leg.instrumentType === "FUTURE"
            ? item.instrument_type === "FUT"
            : item.instrument_type === leg.optionType &&
              Number(leg.strike) > 0 &&
              Math.abs(Number(item.strike) - Number(leg.strike)) < 0.0001,
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
      }),
    );
  }, [contracts, loadingContracts]);

  function contractsForLeg(leg: Leg) {
    if (leg.instrumentType === "FUTURE") {
      return contracts
        .filter((item) => item.instrument_type === "FUT")
        .sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)));
    }

    if (leg.instrumentType === "OPTION") {
      return contracts
        .filter((item) => item.instrument_type === leg.optionType)
        .sort((a, b) => a.strike - b.strike);
    }

    return [];
  }

  function applyDerivativeContract(legId: number, instrument: ZerodhaInstrument) {
    setLegs((current) =>
      current.map((leg) => {
        if (leg.id !== legId) return leg;
        const lots = Math.max(1, Number(leg.lots || 1));
        return {
          ...leg,
          strike:
            leg.instrumentType === "OPTION"
              ? String(instrument.strike)
              : "",
          expiryDate: instrument.expiry ?? "",
          quantity: String(lots * Number(instrument.lot_size || 1)),
          instrumentToken: instrument.instrument_token,
          tradingsymbol: instrument.tradingsymbol,
          lotSize: Number(instrument.lot_size || 1),
        };
      }),
    );
  }

  function updateLots(legId: number, value: string) {
    setLegs((current) =>
      current.map((leg) => {
        if (leg.id !== legId) return leg;
        const lotSize = Number(leg.lotSize ?? 0);
        const lots = Number(value);
        return {
          ...leg,
          lots: value,
          quantity:
            lotSize > 0 && Number.isFinite(lots)
              ? String(lotSize * lots)
              : leg.quantity,
        };
      }),
    );
  }

  function selectSymbol(selectedSymbol: string) {
    setSymbol(selectedSymbol);

    if (selectedSymbol){
      setStrategyName(
        `${selectedSymbol} ${strategyLabels[template]}`,
      );
    }
  }

  function selectTemplate(selectedTemplate: StrategyTemplate) {
    setTemplate(selectedTemplate);
    setLegs(legsForTemplate(selectedTemplate));

    const selectedStock = symbol || "Stock";

    setStrategyName(
      `${selectedStock} ${strategyLabels[selectedTemplate]}`,
    );

    if (
      selectedTemplate === "SHORT_PUT" ||
      selectedTemplate === "BULL_PUT_SPREAD"
    ) {
      setDirection("BULLISH");
    } else if (
      selectedTemplate === "SHORT_CALL" ||
      selectedTemplate === "BEAR_CALL_SPREAD"
    ) {
      setDirection("BEARISH");
    } else if (selectedTemplate === "SHORT_STRANGLE") {
      setDirection("NEUTRAL");
    } else if (selectedTemplate === "CALENDAR") {
      setDirection("VOLATILITY");
    } else {
      setDirection("HEDGED");
    }
  }

  function updateLeg(
    legId: number,
    field: keyof Leg,
    value: string,
  ) {
    setLegs((currentLegs) =>
      currentLegs.map((leg) => {
        if (leg.id !== legId) return leg;

        const next = { ...leg, [field]: value } as Leg;
        if (field === "instrumentType" || field === "optionType") {
          if (field === "instrumentType" && value !== "OPTION") next.strike = "";
          next.expiryDate = "";
          next.instrumentToken = null;
          next.tradingsymbol = null;
          next.lotSize = null;
          next.quantity = "";
        }
        if (field === "strike") {
          next.expiryDate = "";
          next.instrumentToken = null;
          next.tradingsymbol = null;
          next.lotSize = null;
          next.quantity = "";
          const candidates = contracts
            .filter((item) =>
              item.instrument_type === next.optionType &&
              Number(next.strike) > 0 &&
              Math.abs(Number(item.strike) - Number(next.strike)) < 0.0001 &&
              item.expiry?.slice(0, 7) === expiryMonth,
            )
            .sort((a, b) => String(b.expiry).localeCompare(String(a.expiry)));
          const instrument = candidates[0];
          if (instrument) {
            const lots = Math.max(1, Number(next.lots || 1));
            next.expiryDate = instrument.expiry ?? "";
            next.instrumentToken = instrument.instrument_token;
            next.tradingsymbol = instrument.tradingsymbol;
            next.lotSize = Number(instrument.lot_size || 1);
            next.quantity = String(lots * next.lotSize);
          }
        }
        return next;
      }),
    );
  }

  function addLeg() {
    const nextId =
      legs.length === 0
        ? 1
        : Math.max(...legs.map((leg) => leg.id)) + 1;

    setLegs((currentLegs) => [
    ...currentLegs,
      createLeg(nextId, "OPTION", "SELL", "PE"),
    ]);
  }

  function removeLeg(legId: number) {
    setLegs((currentLegs) =>
      currentLegs.filter((leg) => leg.id !== legId),
    );
  }

  function validateForm(): string | null {
    if (!symbol) {
      return "Please select an underlying stock.";
    }

    if (!strategyName.trim()) {
      return "Please enter a strategy name.";
    }

    if (!entryDate) {
 return "Please enter the strategy entry date.";
    }

    if (!expiryMonth) {
      return "Please select the strategy expiry month.";
    }

const spotPrice = Number(entrySpotPrice);

    if (
      entrySpotPrice === "" ||
      !Number.isFinite(spotPrice) ||
      spotPrice <= 0
    ) {
     return "Please enter a valid underlying spot price.";
    }

    if (!tradeThesis.trim()) {
      return "Please enter the trade thesis.";
    }

    if (!exitPlan.trim()) {
      return "Please enter the exit plan.";
    }

    if (legs.length === 0) {
      return "At least one trade leg isrequired.";
    }

    for (let index = 0; index < legs.length; index += 1) {
      const leg = legs[index];
      const legNumber = index + 1;

const quantity = Number(leg.quantity);
      const entryPrice = Number(leg.entryPrice);
      const strike = Number(leg.strike);

      if (!Number.isInteger(quantity) || quantity <= 0) {
        return `Leg ${legNumber}: quantity must be a positive whole number.`;
      }

      if (
        leg.entryPrice=== "" ||
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
          return `Leg ${legNumber}: enter a valid strike price.`;
        }

        if (!leg.expiryDate || !leg.instrumentToken || !leg.lotSize) {
          return `Leg ${legNumber}: select a valid Zerodha option contract.`;
        }
      }

      if (
        leg.instrumentType === "FUTURE" &&
        (!leg.expiryDate || !leg.instrumentToken || !leg.lotSize)
      ) {
        return `Leg ${legNumber}: select the Zerodha futures contract.`;
      }
    }

    return null;
  }

  async function saveStrategy() {
    setErrorMessage("");
    setSuccessMessage("");

    const validationError = validateForm();

    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setSaving(true);

    const strategyId = [
      symbol,
      entryDate.replaceAll("-", ""),
      Date.now().toString().slice(-6),
    ].join("_");

    const spotPrice = Number(entrySpotPrice);

    try {
      const strategyPayload = {
        strategy_id: strategyId,
        strategy_name: strategyName.trim(),
        symbol,
        strategy_type: template,
  direction,
        status: "OPEN",
        entry_date: entryDate,
        expiry_month: `${expiryMonth}-01`,
        closed_date: null,

        entry_spot_price: spotPrice,

        trade_thesis: tradeThesis.trim(),
        adjustment_plan: adjustmentPlan.trim() || null,
        exit_plan: exitPlan.trim(),
        notes: null,

        realised_pnl: 0,
        unrealised_mtm: 0,
        total_pnl: 0,

        pre_trade_checklist: checklist,
      };

      const { error: strategyError } = await supabase
        .from("strategy_master")
        .insert(strategyPayload);

      if (strategyError) {
        throw new Error(
          `Unable to create strategy: ${strategyError.message}`,
        );
      }

      const { data: eventData, error: eventError } =
        await supabase
          .from("strategy_events")
          .insert({
            strategy_id: strategyId,
            event_type: "ENTRY",
            event_date: `${entryDate}T00:00:00`,
            underlying_spot: spotPrice,
            reason: "Original strategy entry",
  notes: tradeThesis.trim(),
          })
          .select("id")
          .single();

      if (eventError || !eventData) {
        await supabase
         .from("strategy_master")
          .delete()
          .eq("strategy_id", strategyId);

        throw new Error(
          `Unable to createentry event: ${
            eventError?.message ?? "No event ID returned"
          }`,
        );
      }

      const strategyEventId = eventData.id;

      const positionRows = legs.map((leg) => {
        const quantity = Number(leg.quantity);
        const entryPrice = Number(leg.entryPrice);

   return {
          strategy_id: strategyId,
          strategy_event_id: strategyEventId,
          strategy_name: strategyName.trim(),
          symbol,

          instrument_type: leg.instrumentType,

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

          entry_date: entryDate,
          entry_price: entryPrice,
          current_price: entryPrice,

          contract_multiplier: 1,

          mtm: 0,
     realised_pnl: 0,
          status: "OPEN",

          trade_rationale: tradeThesis.trim(),
          notes: null,

          exchange:
  leg.instrumentType === "EQUITY"
              ? "NSE"
              : "NFO",

          tradingsymbol:
            leg.instrumentType === "EQUITY"
              ? symbol
              : leg.tradingsymbol,

          instrument_token:
            leg.instrumentType === "EQUITY" ? null : leg.instrumentToken,
          lot_size:
            leg.instrumentType === "EQUITY" ? null : leg.lotSize,
        };
      });

      const { error: positionsError } = await supabase
        .from("book_positions")
        .insert(positionRows);

      if (positionsError) {
        await supabase
          .from("strategy_master")
          .delete()
          .eq("strategy_id", strategyId);

        throw new Error(
          `Unable to save strategy legs: ${positionsError.message}`,
        );
      }

      const marginResponse = await fetch("/api/strategy/recalculate-margin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy_id: strategyId }),
      });
      const marginPayload = await marginResponse.json().catch(() => ({}));
      if (!marginResponse.ok) {
        throw new Error(
          `Strategy saved, but margin calculation failed: ${marginPayload?.detail ?? "Unknown margin error"}`,
        );
      }

      setSuccessMessage(
        `Strategy saved successfully. Margin: ₹${Number(marginPayload.margin_used ?? 0).toLocaleString("en-IN")}. Strategy ID: ${strategyId}`,
      );
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

  const completedChecklist = Object.values(checklist).filter(
    Boolean,
  ).length;

  return (
    <main className="min-h-screen bg-gray-50 p-5 text-gray-950 md:p-10">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-5 border-b border-gray-300 pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em]">
              VOTE
            </p>

            <h1 className="mt-2 text-3xl font-bold">
              New Strategy
            </h1>

            <p className="mt-2 text-gray-600">
              Record the strategy and all its trade legs.
            </p>
        </div>

          <Link
            href="/"
            className="text-sm font-semibold underline underline-offset-4"
          >
   Return to Dashboard
          </Link>
        </header>

        <section className="mt-8 rounded-lg border border-gray-300 bg-white p-6">
<h2 className="text-xl font-semibold">
            1. Select the underlying
          </h2>

          <div className="mt-5 grid gap-5 md:grid-cols-2 lg:grid-cols-5">
            <Field label="Underlying">
              <select
                value={symbol}
                onChange={(event) =>
           selectSymbol(event.target.value)
                }
                disabled={loadingStocks}
                className="w-full rounded border border-gray-300 px-4 py-3"
              >
                <option value="">
                  {loadingStocks
                    ? "Loading stocks..."
                    : "Select stock"}
                </option>

                {stocks.map((stock) => (
                  <option
key={stock.id}
                    value={stock.symbol}
                  >
                    {stock.symbol} — {stock.company_name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Entry spot price">
              <input
     type="number"
                step="0.01"
                min="0"
                value={entrySpotPrice}
                onChange={(event) =>
                 setEntrySpotPrice(event.target.value)
                }
                placeholder="Current spot"
                className="w-full rounded border border-gray-300 px-4 py-3"
              />
            </Field>

            <Field label="Entry date">
              <input
    type="date"
                value={entryDate}
                onChange={(event) =>
                  setEntryDate(event.target.value)
 }
                className="w-full rounded border border-gray-300 px-4 py-3"
              />
            </Field>

            <Field label="Strategy month">
              <input
                type="month"
                value={expiryMonth}
                onChange={(event) => {
                  setExpiryMonth(event.target.value);
                  setLegs((current) =>
                    current.map((leg) =>
                      leg.instrumentType === "EQUITY"
                        ? leg
                        : {
                            ...leg,
                            strike: "",
                            expiryDate: "",
                            quantity: "",
                            instrumentToken: null,
                            tradingsymbol: null,
                            lotSize: null,
                          },
                    ),
                  );
                }}
                className="w-full rounded border border-gray-300 px-4 py-3"
              />
     </Field>

            <Field label="Direction">
              <select
                value={direction}
                onChange={(event) =>
             setDirection(event.target.value)
                }
                className="w-full rounded border border-gray-300 px-4 py-3"
>
                <option value="BULLISH">Bullish</option>
                <option value="BEARISH">Bearish</option>
                <option value="NEUTRAL">Neutral</option>
                <option value="VOLATILITY">Volatility</option>
                <option value="HEDGED">Hedged</option>
   </select>
            </Field>
          </div>
        </section>

        <section className="mt-6 rounded-lg border border-gray-300 bg-white p-6">
          <h2 className="text-xl font-semibold">
            2. Choose the strategy
          </h2>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {strategyTemplates.map((strategyTemplate) => {
              const selected =
                strategyTemplate === template;

              return (
                <button
                  key={strategyTemplate}
                  type="button"
                  onClick={() =>
                    selectTemplate(strategyTemplate)
                  }
                  className={`rounded border px-4 py-4 text-left font-semibold ${
                    selected
                      ? "border-black bg-gray-950 text-white"
                      : "border-gray-300 bg-white"
                  }`}
                >
                  {strategyLabels[strategyTemplate]}
                </button>
              );
            })}
         </div>

          <div className="mt-5">
            <Field label="Strategy name">
              <input
                value={strategyName}
                onChange={(event) =>
                  setStrategyName(event.target.value)
                }
                placeholder="BPCL Aug Short Strangle"
                className="w-full rounded border border-gray-300 px-4 py-3"
              />
            </Field>
          </div>
        </section>

        <section className="mt-6 rounded-lg border border-gray-300 bg-white p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold">
                3. Enter the legs
              </h2>

              <p className="mt-1 text-sm text-gray-500">
                Choose the strategy month once. VOTE loads valid Zerodha contracts,
                exact expiry and lot size automatically.
              </p>
            </div>

            <button
              type="button"
              onClick={addLeg}
              className="rounded border border-gray-400 px-4 py-2 text-sm font-semibold"
            >
              + Add Leg
            </button>
          </div>

          {contractError && (
            <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {contractError}
            </div>
          )}

          <div className="mt-5 space-y-5">
            {legs.map((leg, index) => {
              const isOption =
                leg.instrumentType === "OPTION";

              const isFuture =
                leg.instrumentType === "FUTURE";

              return (
                <div
                  key={leg.id}
                  className="rounded border border-gray-300 p-5"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">
                      Leg {index + 1}
                    </h3>

                    {legs.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeLeg(leg.id)}
          className="text-sm font-semibold underline underline-offset-4"
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
     <Field label="Instrument">
                      <select
                        value={leg.instrumentType}
                        onChange={(event) =>
                          updateLeg(
                            leg.id,
                            "instrumentType",
                            event.target.value,
                          )
                        }
                        className="w-full rounded border border-gray-300 px-3 py-3"
                      >
                        <option value="OPTION">Option</option>
                        <option value="FUTURE">Future</option>
                        <option value="EQUITY">
                          Cash Equity
                        </option>
                      </select>
                    </Field>

                    <Field label="Buy / Sell">
                      <select
                        value={leg.positionSide}
                        onChange={(event) =>
                          updateLeg(
                            leg.id,
                            "positionSide",
                            event.target.value,
                          )
                        }
                        className="w-full rounded border border-gray-300 px-3 py-3"
                      >
                        <option value="BUY">Buy</option>
                        <option value="SELL">Sell</option>
                      </select>
                    </Field>

                    {isOption && (
                      <>
                        <Field label="Option type">
                          <select
                            value={leg.optionType}
                            onChange={(event) =>
                              updateLeg(leg.id, "optionType", event.target.value)
                            }
                            className="w-full rounded border border-gray-300 px-3 py-3"
                          >
                            <option value="PE">PE</option>
                            <option value="CE">CE</option>
                          </select>
                        </Field>

                        <Field label="Strike">
                          <input
                            type="number"
                            value={leg.strike}
                            onChange={(event) => updateLeg(leg.id, "strike", event.target.value)}
                            placeholder="Strike"
                            className="w-full rounded border border-gray-300 px-3 py-3"
                          />
                        </Field>
                      </>
                    )}

                    {isFuture && (
                      <Field label="Contract">
                        <input
                          value={leg.tradingsymbol ?? (loadingContracts ? "Resolving from Zerodha..." : "Auto from Zerodha")}
                          readOnly
                          className="w-full rounded border border-gray-300 bg-gray-50 px-3 py-3 text-gray-600"
                        />
                      </Field>
                    )}

                    {(isOption || isFuture) && (
                      <>
                        <Field label="Expiry">
                          <input
                            value={leg.expiryDate || "Auto from Zerodha"}
                            readOnly
                            className="w-full rounded border border-gray-300 bg-gray-50 px-3 py-3 text-gray-600"
                          />
                        </Field>

                        <Field label="Lots">
                          <select
                            value={leg.lots}
                            onChange={(event) => updateLots(leg.id, event.target.value)}
                            className="w-full rounded border border-gray-300 px-3 py-3"
                          >
                            {Array.from({ length: 20 }, (_, item) => item + 1).map(
                              (lots) => (
                                <option key={lots} value={lots}>
                                  {lots} lot{lots === 1 ? "" : "s"}
                                </option>
                              ),
                            )}
                          </select>
                          <p className="mt-1 text-xs text-gray-500">
                            {leg.lotSize
                              ? `Lot size ${leg.lotSize} · Quantity ${leg.quantity || "—"}`
                              : "Lot size will come from Zerodha"}
                          </p>
                        </Field>
                      </>
                    )}

                    {leg.instrumentType === "EQUITY" && (
                      <Field label="Quantity">
                        <input
                          type="number"
                          value={leg.quantity}
                          onChange={(event) =>
                            updateLeg(leg.id, "quantity", event.target.value)
                          }
                          className="w-full rounded border border-gray-300 px-3 py-3"
                        />
                      </Field>
                    )}

                    <Field label="Entry price">
                      <input
                        type="number"
                        step="0.01"
                        value={leg.entryPrice}
                        onChange={(event) =>
                          updateLeg(
               leg.id,
                            "entryPrice",
                            event.target.value,
                          )
            }
                        className="w-full rounded border border-gray-300 px-3 py-3"
                      />
                    </Field>
                 </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mt-6 rounded-lg border border-gray-300 bg-white p-6">
          <h2 className="text-xl font-semibold">
            4. Record the decision
          </h2>

        <div className="mt-5 space-y-5">
            <Field label="Trade thesis">
              <textarea
                value={tradeThesis}
       onChange={(event) =>
                  setTradeThesis(event.target.value)
                }
                rows={4}
                placeholder="Why are you entering this strategy?"
                className="w-full rounded border border-gray-300 px-4 py-3"
              />
            </Field>

            <Field label="Adjustment plan">
              <textarea
                value={adjustmentPlan}
                onChange={(event) =>
         setAdjustmentPlan(event.target.value)
                }
                rows={3}
                placeholder="When and how will you adjust?"
             className="w-full rounded border border-gray-300 px-4 py-3"
              />
            </Field>

            <Field label="Exit plan">
              <textarea
                value={exitPlan}
                onChange={(event) =>
                  setExitPlan(event.target.value)
     }
                rows={3}
                placeholder="Profit target, stop level or exit date"
                className="w-full rounded border border-gray-300 px-4 py-3"
              />
            </Field>
          </div>
        </section>

        <section className="mt-6 rounded-lg border border-gray-300 bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">
      5. Pre-trade checklist
            </h2>

            <p className="text-sm font-semibold">
              {completedChecklist}/6 complete
    </p>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <ChecklistItem
              label="Volatility reviewed"
              checked={checklist.volatilityReviewed}
              onChange={(checked) =>
                setChecklist({
                  ...checklist,
                  volatilityReviewed: checked,
                })
              }
            />

            <ChecklistItem
              label="Support and resistance identified"
              checked={checklist.levelsIdentified}
              onChange={(checked) =>
                setChecklist({
                ...checklist,
                  levelsIdentified: checked,
                })
              }
            />

            <ChecklistItem
              label="Earnings and corporate events checked"
              checked={checklist.corporateEventsChecked}
              onChange={(checked) =>
                setChecklist({
                  ...checklist,
                  corporateEventsChecked: checked,
                })
              }
        />

            <ChecklistItem
              label="Position size reviewed"
              checked={checklist.positionSizeChecked}
onChange={(checked) =>
                setChecklist({
                  ...checklist,
                  positionSizeChecked: checked,
                })
             }
            />

            <ChecklistItem
              label="Portfolio concentration reviewed"
              checked={checklist.concentrationChecked}
              onChange={(checked) =>
                setChecklist({
                  ...checklist,
                  concentrationChecked: checked,
                })
              }
            />

            <ChecklistItem
              label="Exit plan defined"
              checked={checklist.exitPlanDefined}
              onChange={(checked) =>
                setChecklist({
                  ...checklist,
                  exitPlanDefined: checked,
                })
              }
            />
          </div>
        </section>

        {errorMessage && (
          <div className="mt-6 rounded border border-gray-500 bg-white p-4">
            <p className="font-semibold">Unable to save</p>
            <p className="mt-1 text-sm">{errorMessage}</p>
          </div>
        )}

        {successMessage && (
          <div className="mt-6 rounded border border-gray-500 bg-white p-4">
            <p className="font-semibold">Strategy saved</p>
            <p className="mt-1 text-sm">{successMessage}</p>
          </div>
   )}

        <div className="mt-6 flex flex-col gap-3 pb-10 md:flex-row md:justify-end">
          <Link
            href="/"
            className="rounded border border-gray-400 px-5 py-3 text-center font-semibold"
          >
            Cancel
          </Link>

          <button
            type="button"
            onClick={saveStrategy}
            disabled={saving}
            className="rounded bg-gray-950 px-6 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Strategy"}
          </button>
        </div>
      </div>
    </main>
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

type ChecklistItemProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

function ChecklistItem({
  label,
  checked,
  onChange,
}: ChecklistItemProps) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded border border-gray-300 p-4">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) =>
          onChange(event.target.checked)
        }
      className="h-5 w-5"
      />

      <span className="font-medium">{label}</span>
    </label>
  );
}