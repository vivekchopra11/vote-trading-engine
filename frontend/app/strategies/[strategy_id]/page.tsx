"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import PayoffPanel from "@/components/strategy/PayoffPanel";
import ObservationPanel, { type StrategyObservation } from "@/components/strategy/ObservationPanel";
import { mapPositionsToStrategyLegs, type StrategyLeg } from "@/lib/payoff";

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
  entry_spot_price: number | null;
  current_spot_price: number | null;
  market_data_updated_at: string | null;
  margin_used: number | null;
  margin_initial: number | null;
  margin_status: string | null;
  margin_updated_at: string | null;
  trade_thesis: string | null;
  adjustment_plan: string | null;
  exit_plan: string | null;
  realised_pnl: number | null;
  unrealised_mtm: number | null;
  total_pnl: number | null;
  pre_trade_checklist: Record<string, boolean> | null;
};

type Position = {
  id: number;
  strategy_event_id: number | null;
  instrument_type: string;
  option_type: string | null;
  strike: number | null;
  expiry_date: string | null;
  position_side: string;
  quantity: number;
  open_quantity: number;
  closed_quantity: number;
  entry_date: string;
  entry_price: number;
  current_price: number | null;
  contract_multiplier: number | null;
  mtm: number | null;
  realised_pnl: number | null;
  status: string;
};

type StrategyEvent = {
  id: number;
  event_type: string;
  event_date: string;
  underlying_spot: number | null;
  reason: string | null;
  notes: string | null;
};

type RefreshStrategyResponse = {
  status: string;
  strategy_id: string;
  strategy_name?: string | null;
  positions_updated?: number;
  positions_resolved?: number;
  realised_pnl?: number;
  unrealised_mtm?: number;
  total_pnl?: number;
  current_spot_price?: number;
  underlying_quote_key?: string;
  refreshed_at?: string;
  positions?: Array<{
    position_id: number;
    instrument_token?: number | null;
    tradingsymbol?: string | null;
    current_price?: number | null;
    mtm?: number | null;
    lot_size?: number | null;
  }>;
  message?: string;
};

const CHECKLIST_ITEMS = [
  {
    key: "volatilityReviewed",
    label: "Volatility reviewed",
  },
  {
    key: "levelsIdentified",
    label: "Support and resistance identified",
  },
  {
    key: "corporateEventsChecked",
    label: "Corporate events checked",
  },
  {
    key: "positionSizeChecked",
    label: "Position size reviewed",
  },
  {
    key: "concentrationChecked",
    label: "Portfolio concentration reviewed",
  },
  {
    key: "exitPlanDefined",
    label: "Exit plan defined",
  },
] as const;

const CLOSE_REASONS = [
  "Target achieved",
  "Stop loss",
  "Rolled",
  "Risk reduction",
  "Hedge removed",
  "Margin reduction",
  "Expiry",
  "Thesis invalidated",
  "Manual discretion",
];

function formatCurrency(value: number | null | undefined) {
  const amount = Number(value ?? 0);

  return `${amount >= 0 ? "+" : "-"}₹${Math.abs(
    amount,
  ).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "—";
  }

  return Number(value).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  });
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function formatMonth(value: string | null | undefined) {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

function normalizeMonth(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  return value.slice(0, 7);
}

function formatStrategyType(value: string | null) {
  if (!value) {
    return "Custom";
  }

  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function calculateDays(
  entryDate: string,
  closedDate?: string | null,
) {
  const start = new Date(entryDate);
  const end = closedDate ? new Date(closedDate) : new Date();

  return Math.max(
    0,
    Math.floor(
      (end.getTime() - start.getTime()) /
        (1000 * 60 * 60 * 24),
    ),
  );
}

function describePosition(position: Position) {
  if (position.instrument_type === "OPTION") {
    return `${position.position_side} ${formatNumber(
      position.strike,
    )} ${position.option_type ?? ""}`;
  }

  if (position.instrument_type === "FUTURE") {
    return `${position.position_side} Future`;
  }

  return `${position.position_side} Cash Equity`;
}

function checklistLabel(key: string) {
  const item = CHECKLIST_ITEMS.find(
    (checklistItem) => checklistItem.key === key,
  );

  return item?.label ?? key;
}

function calculateClosurePnl(
  position: Position,
  closingQuantity: number,
  closingPrice: number,
) {
  const multiplier = Number(position.contract_multiplier ?? 1);

  if (position.position_side === "SELL") {
    return (
      (Number(position.entry_price) - closingPrice) *
      closingQuantity *
      multiplier
    );
  }

  return (
    (closingPrice - Number(position.entry_price)) *
    closingQuantity *
    multiplier
  );
}

type PayoffMode = "CURRENT" | "LIFECYCLE";

const ZERODHA_LOGIN_URL =
  "https://vote-trading-engine-1.onrender.com/auth/zerodha/login";

function isZerodhaAuthError(message: string) {
  const normalized = message.toLowerCase();

  return (
    normalized.includes("expired") ||
    normalized.includes("not connected") ||
    normalized.includes("authenticate") ||
    normalized.includes("authentication") ||
    normalized.includes("access token") ||
    normalized.includes("zerodha session")
  );
}

function calculateDte(expiryDate: string | null | undefined) {
  if (!expiryDate) return null;

  const expiry = new Date(`${expiryDate.slice(0, 10)}T00:00:00`);
  const today = new Date();
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );

  if (!Number.isFinite(expiry.getTime())) return null;

  return Math.max(
    0,
    Math.ceil(
      (expiry.getTime() - todayStart.getTime()) /
        (1000 * 60 * 60 * 24),
    ),
  );
}

function timeRiskLabel(position: Position) {
  if (position.instrument_type === "EQUITY") return "—";

  const dte = calculateDte(position.expiry_date);
  if (dte === null) return "—";

  if (position.instrument_type === "FUTURE") {
    return dte <= 7 ? "Expiry near" : "Contract expiry";
  }

  if (dte <= 7) return "High gamma / expiry";
  if (dte <= 14) return "Gamma rising";
  if (dte <= 30) return "Theta active";
  if (dte <= 45) return "Theta building";
  return "Long-dated";
}

function positionSortRank(position: Position) {
  if (position.instrument_type === "FUTURE") return 0;
  if (position.instrument_type === "OPTION" && position.option_type === "CE") return 1;
  if (position.instrument_type === "OPTION" && position.option_type === "PE") return 2;
  if (position.instrument_type === "EQUITY") return 3;
  return 4;
}

function sortStrategyPositions(items: Position[]) {
  return [...items].sort((first, second) => {
    const firstOpen = Number(first.open_quantity ?? 0) > 0;
    const secondOpen = Number(second.open_quantity ?? 0) > 0;

    if (firstOpen !== secondOpen) return firstOpen ? -1 : 1;

    const rankDifference =
      positionSortRank(first) - positionSortRank(second);
    if (rankDifference !== 0) return rankDifference;

    if (
      first.instrument_type === "OPTION" &&
      second.instrument_type === "OPTION"
    ) {
      return Number(second.strike ?? 0) - Number(first.strike ?? 0);
    }

    return first.id - second.id;
  });
}

export default function StrategyDetailsPage() {
  const params = useParams<{ strategy_id: string }>();
  const strategyId = decodeURIComponent(params.strategy_id);

  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [observations, setObservations] = useState<StrategyObservation[]>([]);
  const [events, setEvents] = useState<StrategyEvent[]>([]);

  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [refreshMessage, setRefreshMessage] = useState("");
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [payoffMode, setPayoffMode] = useState<PayoffMode>("CURRENT");

  // Edit Original Plan
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");
  const [editWarning, setEditWarning] = useState("");

  const [editStrategyName, setEditStrategyName] = useState("");
  const [editEntrySpot, setEditEntrySpot] = useState("");
  const [editExpiryMonth, setEditExpiryMonth] = useState("");
  const [editTradeThesis, setEditTradeThesis] = useState("");
  const [editAdjustmentPlan, setEditAdjustmentPlan] =
    useState("");
  const [editExitPlan, setEditExitPlan] = useState("");

  const [editChecklist, setEditChecklist] = useState<
    Record<string, boolean>
  >({});

  // Close Leg
  const [closeLegDrawerOpen, setCloseLegDrawerOpen] =
    useState(false);
  const [selectedPosition, setSelectedPosition] =
    useState<Position | null>(null);
  const [savingClosure, setSavingClosure] = useState(false);
  const [closeLegError, setCloseLegError] = useState("");

  const [closingQuantity, setClosingQuantity] = useState("");
  const [closingPrice, setClosingPrice] = useState("");
  const [closingDate, setClosingDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [closingSpot, setClosingSpot] = useState("");
  const [closingReason, setClosingReason] = useState("");
  const [closingNotes, setClosingNotes] = useState("");

  // Final strategy review
  const [finalReview, setFinalReview] = useState("");
  const [keyLesson, setKeyLesson] = useState("");
  const [wouldTradeAgain, setWouldTradeAgain] = useState("");
  const [decisionRating, setDecisionRating] = useState("");

  const loadStrategyData = useCallback(
    async (showPageLoader = false) => {
      if (showPageLoader) {
        setLoading(true);
      }

      setErrorMessage("");

      const [
        strategyResponse,
        positionsResponse,
        eventsResponse,
        observationsResponse,
      ] = await Promise.all([
        supabase
          .from("strategy_master")
          .select(
            `
            strategy_id,
            strategy_name,
            symbol,
            strategy_type,
            direction,
            status,
            entry_date,
            expiry_month,
            closed_date,
            entry_spot_price,
            current_spot_price,
            market_data_updated_at,
            margin_used,
            margin_initial,
            margin_status,
            margin_updated_at,
            trade_thesis,
            adjustment_plan,
            exit_plan,
            realised_pnl,
            unrealised_mtm,
            total_pnl,
            pre_trade_checklist
            `,
          )
          .eq("strategy_id", strategyId)
          .single(),

        supabase
          .from("book_positions")
          .select(
            `
            id,
            strategy_event_id,
            instrument_type,
            option_type,
            strike,
            expiry_date,
            position_side,
            quantity,
            open_quantity,
            closed_quantity,
            entry_date,
            entry_price,
            current_price,
            contract_multiplier,
            mtm,
            realised_pnl,
            status
            `,
          )
          .eq("strategy_id", strategyId)
          .order("created_at", {
            ascending: true,
          }),

        supabase
          .from("strategy_events")
          .select(
            `
            id,
            event_type,
            event_date,
            underlying_spot,
            reason,
            notes
            `,
          )
          .eq("strategy_id", strategyId)
          .order("event_date", {
            ascending: true,
          }),

        supabase
          .from("strategy_observations")
          .select(
            `
            id,
            category,
            code,
            severity,
            confidence,
            title,
            summary,
            why_it_matters,
            suggested_review,
            evidence,
            status,
            first_seen_at,
            last_seen_at,
            occurrence_count
            `,
          )
          .eq("strategy_id", strategyId)
          .eq("status", "ACTIVE")
          .order("last_seen_at", { ascending: false }),
      ]);

      try {
        if (strategyResponse.error) {
          throw new Error(strategyResponse.error.message);
        }

        if (positionsResponse.error) {
          throw new Error(positionsResponse.error.message);
        }

        if (eventsResponse.error) {
          throw new Error(eventsResponse.error.message);
        }

        if (observationsResponse.error) {
          throw new Error(observationsResponse.error.message);
        }

        setStrategy(strategyResponse.data);
        setPositions(positionsResponse.data ?? []);
        setEvents(eventsResponse.data ?? []);
        setObservations((observationsResponse.data ?? []) as StrategyObservation[]);
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Unable to reload strategy data.",
        );
        throw error;
      } finally {
        if (showPageLoader) {
          setLoading(false);
        }
      }
    },
    [strategyId],
  );

  useEffect(() => {
    void loadStrategyData(true).catch(() => {
      // loadStrategyData already records the visible error.
    });
  }, [loadStrategyData]);

  const openPositions = useMemo(
    () =>
      positions.filter(
        (position) =>
          Number(position.open_quantity ?? 0) > 0,
      ),
    [positions],
  );

  const closedPositions = useMemo(
    () =>
      positions.filter(
        (position) =>
          Number(position.open_quantity ?? 0) === 0,
      ),
    [positions],
  );

  const payoffLegs = useMemo<StrategyLeg[]>(
    () => mapPositionsToStrategyLegs(openPositions),
    [openPositions],
  );

  const sortedOpenPositions = useMemo(
    () => sortStrategyPositions(openPositions),
    [openPositions],
  );

  const sortedClosedPositions = useMemo(
    () => sortStrategyPositions(closedPositions),
    [closedPositions],
  );

  const nearestDte = useMemo(() => {
    const values = openPositions
      .filter((position) => position.instrument_type !== "EQUITY")
      .map((position) => calculateDte(position.expiry_date))
      .filter((value): value is number => value !== null);

    return values.length > 0 ? Math.min(...values) : null;
  }, [openPositions]);

  const payoffReferenceSpot =
    strategy?.current_spot_price ??
    strategy?.entry_spot_price ??
    null;

  const enteredClosingQuantity = Number(closingQuantity);

  const closesSelectedLeg =
    selectedPosition !== null &&
    Number.isFinite(enteredClosingQuantity) &&
    enteredClosingQuantity ===
      Number(selectedPosition.open_quantity);

  const closesEntireStrategy =
    selectedPosition !== null &&
    closesSelectedLeg &&
    openPositions.every(
      (position) =>
        position.id === selectedPosition.id ||
        Number(position.open_quantity ?? 0) === 0,
    );

  const estimatedClosurePnl = useMemo(() => {
    if (!selectedPosition) {
      return 0;
    }

    const quantity = Number(closingQuantity);
    const price = Number(closingPrice);

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !Number.isFinite(price) ||
      price < 0
    ) {
      return 0;
    }

    return calculateClosurePnl(
      selectedPosition,
      quantity,
      price,
    );
  }, [selectedPosition, closingQuantity, closingPrice]);

  async function refreshPrices() {
    if (!strategy || strategy.status === "CLOSED") {
      return;
    }

    setRefreshingPrices(true);
    setRefreshError("");
    setRefreshMessage("");

    try {
      const response = await fetch(
        "/api/market/refresh-strategy",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            strategy_id: strategy.strategy_id,
          }),
        },
      );

      const payload = (await response.json()) as
        | RefreshStrategyResponse
        | { detail?: unknown };

      if (!response.ok) {
        const detail =
          "detail" in payload ? payload.detail : null;

        throw new Error(
          typeof detail === "string"
            ? detail
            : detail
              ? JSON.stringify(detail)
              : "Unable to refresh market prices.",
        );
      }

      const result = payload as RefreshStrategyResponse;

      if (result.status === "no_open_positions") {
        setRefreshMessage(
          result.message ?? "No open positions to refresh.",
        );
        setLastRefreshedAt(result.refreshed_at ?? null);
        return;
      }

      // The backend has already persisted the refreshed prices and MTM
      // into Supabase. Reload the canonical strategy and position rows
      // immediately so the UI, payoff panel and MTM cards all update
      // without requiring a browser refresh.
      await loadStrategyData(false);

      setLastRefreshedAt(result.refreshed_at ?? null);
      setRefreshMessage(
        `Prices refreshed for ${result.positions_updated ?? 0} open leg${
          result.positions_updated === 1 ? "" : "s"
        }.`,
      );
    } catch (error) {
      setRefreshError(
        error instanceof Error
          ? error.message
          : "Unable to refresh market prices.",
      );
    } finally {
      setRefreshingPrices(false);
    }
  }

  function openEditDrawer() {
    if (!strategy || strategy.status === "CLOSED") {
      return;
    }

    setEditStrategyName(strategy.strategy_name ?? "");
    setEditEntrySpot(
      strategy.entry_spot_price === null
        ? ""
        : String(strategy.entry_spot_price),
    );
    setEditExpiryMonth(
      normalizeMonth(strategy.expiry_month),
    );
    setEditTradeThesis(strategy.trade_thesis ?? "");
    setEditAdjustmentPlan(strategy.adjustment_plan ?? "");
    setEditExitPlan(strategy.exit_plan ?? "");
    setEditChecklist(strategy.pre_trade_checklist ?? {});

    setEditError("");
    setEditWarning("");
    setEditDrawerOpen(true);
  }

  function closeEditDrawer() {
    if (savingEdit) {
      return;
    }

    setEditDrawerOpen(false);
    setEditError("");
    setEditWarning("");
  }

  function updateChecklistItem(
    key: string,
    checked: boolean,
  ) {
    setEditChecklist((current) => ({
      ...current,
      [key]: checked,
    }));
  }

  function identifyChanges() {
    if (!strategy) {
      return [];
    }

    const changes: string[] = [];
    const newSpot = Number(editEntrySpot);

    if (editStrategyName.trim() !== strategy.strategy_name) {
      changes.push("Strategy name");
    }

    if (
      newSpot !==
      Number(strategy.entry_spot_price ?? 0)
    ) {
      changes.push("Entry spot");
    }

    if (
      normalizeMonth(editExpiryMonth) !==
      normalizeMonth(strategy.expiry_month)
    ) {
      changes.push("Strategy month");
    }

    if (
      editTradeThesis.trim() !==
      (strategy.trade_thesis ?? "")
    ) {
      changes.push("Trade thesis");
    }

    if (
      editAdjustmentPlan.trim() !==
      (strategy.adjustment_plan ?? "")
    ) {
      changes.push("Adjustment plan");
    }

    if (
      editExitPlan.trim() !==
      (strategy.exit_plan ?? "")
    ) {
      changes.push("Exit plan");
    }

    if (
      JSON.stringify(editChecklist) !==
      JSON.stringify(
        strategy.pre_trade_checklist ?? {},
      )
    ) {
      changes.push("Pre-trade checklist");
    }

    return changes;
  }

  async function saveDecisionEdit() {
    if (!strategy) {
      return;
    }

    setEditError("");
    setEditWarning("");

    if (strategy.status === "CLOSED") {
      setEditError(
        "A closed strategy cannot be edited.",
      );
      return;
    }

    const strategyName = editStrategyName.trim();
    const entrySpot = Number(editEntrySpot);

    if (!strategyName) {
      setEditError("Strategy name is required.");
      return;
    }

    if (
      editEntrySpot === "" ||
      !Number.isFinite(entrySpot) ||
      entrySpot <= 0
    ) {
      setEditError("Enter a valid entry spot.");
      return;
    }

    if (!editExpiryMonth) {
      setEditError("Select the strategy month.");
      return;
    }

    const changedFields = identifyChanges();

    if (changedFields.length === 0) {
      setEditDrawerOpen(false);
      return;
    }

    setSavingEdit(true);

    try {
      const { data: updatedStrategy, error } =
        await supabase
          .from("strategy_master")
          .update({
            strategy_name: strategyName,
            entry_spot_price: entrySpot,
            expiry_month: `${editExpiryMonth}-01`,
            trade_thesis:
              editTradeThesis.trim() || null,
            adjustment_plan:
              editAdjustmentPlan.trim() || null,
            exit_plan: editExitPlan.trim() || null,
            pre_trade_checklist: editChecklist,
          })
          .eq("strategy_id", strategy.strategy_id)
          .select(
            `
            strategy_id,
            strategy_name,
            symbol,
            strategy_type,
            direction,
            status,
            entry_date,
            expiry_month,
            closed_date,
            entry_spot_price,
            current_spot_price,
            market_data_updated_at,
            margin_used,
            margin_initial,
            margin_status,
            margin_updated_at,
            trade_thesis,
            adjustment_plan,
            exit_plan,
            realised_pnl,
            unrealised_mtm,
            total_pnl,
            pre_trade_checklist
            `,
          )
          .single();

      if (error || !updatedStrategy) {
        throw new Error(
          error?.message ?? "Strategy update failed.",
        );
      }

      setStrategy(updatedStrategy);

      const {
        data: editEvent,
        error: eventError,
      } = await supabase
        .from("strategy_events")
        .insert({
          strategy_id: strategy.strategy_id,
          event_type: "EDIT",
          event_date: new Date().toISOString(),
          underlying_spot: entrySpot,
          reason: "Original plan updated",
          notes: `Updated: ${changedFields.join(", ")}`,
        })
        .select(
          `
          id,
          event_type,
          event_date,
          underlying_spot,
          reason,
          notes
          `,
        )
        .single();

      if (eventError) {
        setEditWarning(
          `The strategy was updated, but the timeline event could not be created: ${eventError.message}`,
        );
        return;
      }

      if (editEvent) {
        setEvents((current) =>
          [...current, editEvent].sort(
            (first, second) =>
              new Date(first.event_date).getTime() -
              new Date(second.event_date).getTime(),
          ),
        );
      }

      setEditDrawerOpen(false);
    } catch (error) {
      setEditError(
        error instanceof Error
          ? error.message
          : "Unable to update the original plan.",
      );
    } finally {
      setSavingEdit(false);
    }
  }

  function openCloseLegDrawer(position?: Position) {
    if (!strategy || strategy.status === "CLOSED") {
      return;
    }

    const positionToClose =
      position ??
      openPositions.find(
        (openPosition) =>
          Number(openPosition.open_quantity) > 0,
      ) ??
      null;

    if (!positionToClose) {
      return;
    }

    setSelectedPosition(positionToClose);
    setClosingQuantity(
      String(positionToClose.open_quantity),
    );
    setClosingPrice(
      positionToClose.current_price === null
        ? ""
        : String(positionToClose.current_price),
    );
    setClosingDate(
      new Date().toISOString().slice(0, 10),
    );
    setClosingSpot("");
    setClosingReason("");
    setClosingNotes("");

    setFinalReview("");
    setKeyLesson("");
    setWouldTradeAgain("");
    setDecisionRating("");

    setCloseLegError("");
    setCloseLegDrawerOpen(true);
  }

  function closeCloseLegDrawer() {
    if (savingClosure) {
      return;
    }

    setCloseLegDrawerOpen(false);
    setSelectedPosition(null);
    setCloseLegError("");
  }

  async function saveLegClosure() {
    if (!strategy || !selectedPosition) {
      return;
    }

    setCloseLegError("");

    if (strategy.status === "CLOSED") {
      setCloseLegError(
        "This strategy is already closed.",
      );
      return;
    }

    const quantityToClose = Number(closingQuantity);
    const priceAtClose = Number(closingPrice);
    const spotAtClose = Number(closingSpot);
    const currentOpenQuantity = Number(
      selectedPosition.open_quantity,
    );

    if (
      !Number.isInteger(quantityToClose) ||
      quantityToClose <= 0
    ) {
      setCloseLegError(
        "Closing quantity must be a positive whole number.",
      );
      return;
    }

    if (quantityToClose > currentOpenQuantity) {
      setCloseLegError(
        `Closing quantity cannot exceed the open quantity of ${currentOpenQuantity}.`,
      );
      return;
    }

    if (
      closingPrice === "" ||
      !Number.isFinite(priceAtClose) ||
      priceAtClose < 0
    ) {
      setCloseLegError(
        "Enter a valid closing price.",
      );
      return;
    }

    if (!closingDate) {
      setCloseLegError("Select the closing date.");
      return;
    }

    if (
      closingSpot === "" ||
      !Number.isFinite(spotAtClose) ||
      spotAtClose <= 0
    ) {
      setCloseLegError(
        "Enter the underlying spot at closure.",
      );
      return;
    }

    if (!closingReason) {
      setCloseLegError(
        "Select the reason for closing the leg.",
      );
      return;
    }

    if (closesEntireStrategy) {
      if (!finalReview.trim()) {
        setCloseLegError(
          "Enter a final review before completing the strategy.",
        );
        return;
      }

      if (!keyLesson.trim()) {
        setCloseLegError(
          "Enter the key lesson from this trade.",
        );
        return;
      }

      if (!wouldTradeAgain) {
        setCloseLegError(
          "Indicate whether you would take this trade again.",
        );
        return;
      }

      const rating = Number(decisionRating);

      if (
        !Number.isInteger(rating) ||
        rating < 1 ||
        rating > 5
      ) {
        setCloseLegError(
          "Select a decision quality rating between 1 and 5.",
        );
        return;
      }
    }

    setSavingClosure(true);

    const closureTimestamp =
      `${closingDate}T${new Date()
        .toTimeString()
        .slice(0, 8)}`;

    try {
      const realisedForThisClosure =
        calculateClosurePnl(
          selectedPosition,
          quantityToClose,
          priceAtClose,
        );

      const newOpenQuantity =
        currentOpenQuantity - quantityToClose;

      const newClosedQuantity =
        Number(selectedPosition.closed_quantity ?? 0) +
        quantityToClose;

      const newPositionRealised =
        Number(selectedPosition.realised_pnl ?? 0) +
        realisedForThisClosure;

      const newPositionStatus =
        newOpenQuantity === 0
          ? "CLOSED"
          : "PARTIALLY_CLOSED";

      /*
       * If your position_closures table uses different column
       * names, Supabase will show the exact missing column.
       * The expected columns here are:
       *
       * position_id
       * strategy_id
       * close_date
       * closure_price
       * quantity_closed
       * realised_pnl
       * reason
       * notes
       */

      const {
        data: closureRecord,
        error: closureError,
      } = await supabase
        .from("position_closures")
        .insert({
          position_id: selectedPosition.id,
          strategy_id: strategy.strategy_id,
          close_date: closingDate,
          close_price: priceAtClose,
          quantity_closed: quantityToClose,
          realised_pnl: realisedForThisClosure,
          closing_reason: closingReason,
          notes: closingNotes.trim() || null,
        })
        .select("id")
        .single();

      if (closureError || !closureRecord) {
        throw new Error(
          `Unable to create the position closure: ${
            closureError?.message ??
            "No closure record returned"
          }`,
        );
      }

      const {
        data: updatedPosition,
        error: positionError,
      } = await supabase
        .from("book_positions")
        .update({
          open_quantity: newOpenQuantity,
          closed_quantity: newClosedQuantity,
          current_price: priceAtClose,
          realised_pnl: newPositionRealised,
          mtm: newOpenQuantity === 0 ? 0 : selectedPosition.mtm,
          status: newPositionStatus,
        })
        .eq("id", selectedPosition.id)
        .select(
          `
          id,
          strategy_event_id,
          instrument_type,
          option_type,
          strike,
          expiry_date,
          position_side,
          quantity,
          open_quantity,
          closed_quantity,
          entry_date,
          entry_price,
          current_price,
          contract_multiplier,
          mtm,
          realised_pnl,
          status
          `,
        )
        .single();

      if (positionError || !updatedPosition) {
        await supabase
          .from("position_closures")
          .delete()
          .eq("id", closureRecord.id);

        throw new Error(
          `Unable to update the position: ${
            positionError?.message ??
            "No updated position returned"
          }`,
        );
      }

      const updatedPositions = positions.map(
        (position) =>
          position.id === updatedPosition.id
            ? updatedPosition
            : position,
      );

      const remainingOpenQuantity =
        updatedPositions.reduce(
          (total, position) =>
            total +
            Number(position.open_quantity ?? 0),
          0,
        );

      const totalRealisedPnl =
        updatedPositions.reduce(
          (total, position) =>
            total +
            Number(position.realised_pnl ?? 0),
          0,
        );

      const totalUnrealisedMtm =
        updatedPositions.reduce(
          (total, position) =>
            total +
            (Number(position.open_quantity ?? 0) > 0
              ? Number(position.mtm ?? 0)
              : 0),
          0,
        );

      const totalPnl =
        totalRealisedPnl + totalUnrealisedMtm;

      const eventType =
        remainingOpenQuantity === 0
          ? "CLOSURE"
          : "PARTIAL_EXIT";

      const eventNotes = [
        `Leg: ${describePosition(selectedPosition)}`,
        `Quantity closed: ${quantityToClose}`,
        `Closing price: ₹${formatNumber(priceAtClose)}`,
        `Realised P&L: ${formatCurrency(
          realisedForThisClosure,
        )}`,
        closingNotes.trim()
          ? `Notes: ${closingNotes.trim()}`
          : null,
        remainingOpenQuantity === 0
          ? `Final review: ${finalReview.trim()}`
          : null,
        remainingOpenQuantity === 0
          ? `Key lesson: ${keyLesson.trim()}`
          : null,
        remainingOpenQuantity === 0
          ? `Would trade again: ${wouldTradeAgain}`
          : null,
        remainingOpenQuantity === 0
          ? `Decision quality rating: ${decisionRating}/5`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

      const {
        data: closureEvent,
        error: eventError,
      } = await supabase
        .from("strategy_events")
        .insert({
          strategy_id: strategy.strategy_id,
          event_type: eventType,
          event_date: closureTimestamp,
          underlying_spot: spotAtClose,
          reason: closingReason,
          notes: eventNotes,
        })
        .select(
          `
          id,
          event_type,
          event_date,
          underlying_spot,
          reason,
          notes
          `,
        )
        .single();

      if (eventError || !closureEvent) {
        throw new Error(
          `The leg was updated, but the timeline event could not be created: ${
            eventError?.message ??
            "No event returned"
          }`,
        );
      }

      const strategyUpdate = {
        realised_pnl: totalRealisedPnl,
        unrealised_mtm:
          remainingOpenQuantity === 0
            ? 0
            : totalUnrealisedMtm,
        total_pnl: totalPnl,
        status:
          remainingOpenQuantity === 0
            ? "CLOSED"
            : strategy.status,
        closed_date:
          remainingOpenQuantity === 0
            ? closureTimestamp
            : strategy.closed_date,
      };

      const {
        data: updatedStrategy,
        error: strategyError,
      } = await supabase
        .from("strategy_master")
        .update(strategyUpdate)
        .eq("strategy_id", strategy.strategy_id)
        .select(
          `
          strategy_id,
          strategy_name,
          symbol,
          strategy_type,
          direction,
          status,
          entry_date,
          expiry_month,
          closed_date,
          entry_spot_price,
          current_spot_price,
          market_data_updated_at,
          trade_thesis,
          adjustment_plan,
          exit_plan,
          realised_pnl,
          unrealised_mtm,
          total_pnl,
          pre_trade_checklist
          `,
        )
        .single();

      if (strategyError || !updatedStrategy) {
        throw new Error(
          `The leg was closed, but the strategy totals could not be updated: ${
            strategyError?.message ??
            "No strategy returned"
          }`,
        );
      }

      setPositions(updatedPositions);
      setStrategy(updatedStrategy);

      setEvents((currentEvents) =>
        [...currentEvents, closureEvent].sort(
          (first, second) =>
            new Date(first.event_date).getTime() -
            new Date(second.event_date).getTime(),
        ),
      );

      setCloseLegDrawerOpen(false);
      setSelectedPosition(null);
    } catch (error) {
      setCloseLegError(
        error instanceof Error
          ? error.message
          : "Unable to close the position leg.",
      );
    } finally {
      setSavingClosure(false);
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

  if (errorMessage || !strategy) {
    return (
      <main className="min-h-screen bg-gray-50 p-10">
        <div className="mx-auto max-w-4xl rounded border border-gray-300 bg-white p-6">
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

  const checklist =
    strategy.pre_trade_checklist ?? {};

  const strategyIsClosed =
    strategy.status === "CLOSED";

  return (
    <main className="min-h-screen bg-gray-50 p-5 text-gray-950 md:p-10">
      <div className="mx-auto max-w-[1500px]">
        <header className="flex flex-col gap-5 border-b border-gray-300 pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em]">
              {strategy.symbol}
            </p>

            <h1 className="mt-2 text-3xl font-bold">
              {strategy.strategy_name}
            </h1>

            <div className="mt-3 flex flex-wrap gap-3 text-sm">
              <span className="rounded border border-gray-400 px-3 py-1">
                {strategy.status}
              </span>

              <span className="rounded border border-gray-300 px-3 py-1">
                {formatStrategyType(
                  strategy.strategy_type,
                )}
              </span>

              <span className="rounded border border-gray-300 px-3 py-1">
                {strategy.direction ?? "No direction"}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/strategies"
              className="rounded border border-gray-400 px-4 py-3 text-sm font-semibold"
            >
              All Strategies
            </Link>

            <button
              type="button"
              onClick={refreshPrices}
              disabled={
                strategyIsClosed ||
                openPositions.length === 0 ||
                refreshingPrices
              }
              className={`rounded border px-4 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                refreshMessage
                  ? "border-green-600 bg-green-50 text-green-700"
                  : "border-blue-600 bg-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              {refreshingPrices
                ? "Refreshing Prices..."
                : refreshMessage
                  ? "Prices Updated ✓"
                  : "Refresh Market Data"}
            </button>

            <button
              type="button"
              onClick={openEditDrawer}
              disabled={strategyIsClosed}
              className="rounded border border-gray-400 px-4 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            >
              Edit Original Plan
            </button>

            <Link
              href={`/strategies/${encodeURIComponent(
                strategy.strategy_id,
              )}/adjustment`}
              aria-disabled={strategyIsClosed}
              className={`rounded border border-gray-400 px-4 py-3 text-sm font-semibold ${
                strategyIsClosed
                  ? "pointer-events-none cursor-not-allowed opacity-40"
                  : ""
              }`}
            >
              Record Adjustment
            </Link>

            <button
              type="button"
              onClick={() => openCloseLegDrawer()}
              disabled={
                strategyIsClosed ||
                openPositions.length === 0
              }
              className="rounded bg-gray-950 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {strategyIsClosed
                ? "Strategy Closed"
                : "Close Leg"}
            </button>
          </div>
        </header>

        {(refreshMessage || refreshError || lastRefreshedAt) && (
          <div
            className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
              refreshError
                ? isZerodhaAuthError(refreshError)
                  ? "border-amber-300 bg-amber-50 text-amber-900"
                  : "border-red-300 bg-red-50 text-red-800"
                : "border-blue-200 bg-blue-50 text-blue-800"
            }`}
          >
            {refreshError ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold">
                    Market data refresh failed
                  </p>
                  <p className="mt-1">{refreshError}</p>
                </div>

                {isZerodhaAuthError(refreshError) && (
                  <a
                    href={ZERODHA_LOGIN_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 rounded bg-gray-950 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-gray-800"
                  >
                    Reconnect Zerodha
                  </a>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">
                  {refreshMessage || "Market prices refreshed."}
                </p>

                {lastRefreshedAt && (
                  <p className="text-xs">
                    Updated {new Date(lastRefreshedAt).toLocaleString("en-IN")}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-8">
          <SummaryCard
            label="Realised P&L"
            value={formatCurrency(strategy.realised_pnl)}
          />

          <SummaryCard
            label="Unrealised MTM"
            value={formatCurrency(strategy.unrealised_mtm)}
          />

          <SummaryCard
            label="Net P&L"
            value={formatCurrency(strategy.total_pnl)}
          />

          <SummaryCard
            label="Current Spot"
            value={
              strategy.current_spot_price
                ? `₹${formatNumber(strategy.current_spot_price)}`
                : "—"
            }
          />

          <SummaryCard
            label="Nearest DTE"
            value={nearestDte === null ? "—" : `${nearestDte} days`}
          />

          <SummaryCard
            label="Margin Used"
            value={
              strategy.margin_used !== null && strategy.margin_used !== undefined
                ? formatCurrency(strategy.margin_used)
                : "—"
            }
          />

          <SummaryCard
            label="Return on Margin"
            value={
              strategy.margin_used && strategy.margin_used > 0
                ? `${((Number(strategy.total_pnl ?? 0) / strategy.margin_used) * 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`
                : "—"
            }
          />

          <SummaryCard
            label="Open Legs"
            value={String(openPositions.length)}
          />
        </section>

        <ObservationPanel observations={observations} />

        <section className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(320px,2fr)_minmax(0,4fr)]">
          <div className="space-y-6">
            <div className="rounded-lg border border-gray-300 bg-white p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">
                    Strategy context
                  </p>

                  <h2 className="mt-1 text-xl font-semibold">
                    Trade decision
                  </h2>
                </div>

                <span className="rounded border border-gray-300 px-3 py-1 text-xs font-semibold">
                  {formatMonth(strategy.expiry_month)}
                </span>
              </div>

              <div className="mt-6 space-y-6">
                <TextSection
                  label="Trade thesis"
                  value={strategy.trade_thesis}
                />

                <TextSection
                  label="Adjustment plan"
                  value={strategy.adjustment_plan}
                />

                <TextSection
                  label="Exit plan"
                  value={strategy.exit_plan}
                />
              </div>
            </div>

            <div className="rounded-lg border border-gray-300 bg-white p-6">
              <h2 className="text-lg font-semibold">
                Strategy information
              </h2>

              <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-1">
                <InformationRow
                  label="Entry date"
                  value={formatDate(
                    strategy.entry_date,
                  )}
                />

                <InformationRow
                  label="Closed date"
                  value={formatDate(
                    strategy.closed_date,
                  )}
                />

                <InformationRow
                  label="Closed legs"
                  value={String(closedPositions.length)}
                />

                <InformationRow
                  label="Entry spot"
                  value={
                    strategy.entry_spot_price
                      ? `₹${formatNumber(strategy.entry_spot_price)}`
                      : "—"
                  }
                />

                <InformationRow
                  label="Market data updated"
                  value={
                    strategy.market_data_updated_at
                      ? new Date(strategy.market_data_updated_at).toLocaleString("en-IN")
                      : "—"
                  }
                />

                <InformationRow
                  label="Strategy ID"
                  value={strategy.strategy_id}
                />
              </dl>
            </div>
          </div>

          <div className="min-w-0">
            <div className="mb-3 flex flex-col gap-3 rounded-lg border border-gray-300 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">
                  Payoff view
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  Current Exposure shows open risk only. The chart is centred on the latest Zerodha underlying spot after each market refresh. Lifecycle P&amp;L adds realised P&amp;L to the open-leg expiry payoff.
                </p>
              </div>

              <div className="flex rounded border border-gray-300 bg-gray-50 p-1">
                <button
                  type="button"
                  onClick={() => setPayoffMode("CURRENT")}
                  className={`rounded px-3 py-2 text-xs font-semibold ${
                    payoffMode === "CURRENT"
                      ? "bg-gray-950 text-white"
                      : "text-gray-600"
                  }`}
                >
                  Current Exposure
                </button>
                <button
                  type="button"
                  onClick={() => setPayoffMode("LIFECYCLE")}
                  className={`rounded px-3 py-2 text-xs font-semibold ${
                    payoffMode === "LIFECYCLE"
                      ? "bg-gray-950 text-white"
                      : "text-gray-600"
                  }`}
                >
                  Lifecycle P&amp;L
                </button>
              </div>
            </div>

            <PayoffPanel
              legs={payoffLegs}
              currentSpot={payoffReferenceSpot}
              expiryMonth={strategy.expiry_month}
              chartHeight={650}
              pnlOffset={
                payoffMode === "LIFECYCLE"
                  ? Number(strategy.realised_pnl ?? 0)
                  : 0
              }
              mtmReference={
                payoffMode === "LIFECYCLE"
                  ? strategy.total_pnl
                  : strategy.unrealised_mtm
              }
              mtmReferenceLabel={
                payoffMode === "LIFECYCLE"
                  ? "Current total P&L"
                  : "Current unrealised MTM"
              }
            />
          </div>
        </section>

        <section className="mt-6 rounded-lg border border-gray-300 bg-white">
          <div className="border-b border-gray-300 p-6">
            <h2 className="text-xl font-semibold">
              Open position ladder
            </h2>

            <p className="mt-1 text-sm text-gray-500">
              Futures first, then Calls from higher to lower strikes, then Puts from higher to lower strikes. Greeks are reserved for Sprint 7.
            </p>
          </div>

          <PositionTable
            positions={sortedOpenPositions}
            strategyIsClosed={strategyIsClosed}
            onCloseLeg={openCloseLegDrawer}
          />

          {sortedClosedPositions.length > 0 && (
            <details className="border-t border-gray-300">
              <summary className="cursor-pointer bg-gray-50 px-6 py-4 font-semibold">
                Closed legs ({sortedClosedPositions.length})
              </summary>

              <PositionTable
                positions={sortedClosedPositions}
                strategyIsClosed={strategyIsClosed}
                onCloseLeg={openCloseLegDrawer}
              />
            </details>
          )}
        </section>

        <section className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-gray-300 bg-white p-6">
            <h2 className="text-xl font-semibold">
              Strategy timeline
            </h2>

            <div className="mt-6 space-y-6">
              {events.map((event) => (
                <div
                  key={event.id}
                  className="relative border-l border-gray-400 pl-6"
                >
                  <div className="absolute -left-2 top-0 h-4 w-4 rounded-full border border-gray-600 bg-white" />

                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">
                        {event.event_type.replaceAll(
                          "_",
                          " ",
                        )}
                      </p>

                      <p className="mt-1 text-sm text-gray-500">
                        {formatDate(event.event_date)}
                      </p>
                    </div>

                    <div className="text-right text-sm">
                      <p className="text-gray-500">
                        Underlying spot
                      </p>

                      <p className="font-semibold">
                        {event.underlying_spot === null
                          ? "—"
                          : `₹${formatNumber(
                              event.underlying_spot,
                            )}`}
                      </p>
                    </div>
                  </div>

                  {event.reason && (
                    <p className="mt-3 text-sm">
                      <span className="font-semibold">
                        Reason:
                      </span>{" "}
                      {event.reason}
                    </p>
                  )}

                  {event.notes && (
                    <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">
                      {event.notes}
                    </p>
                  )}
                </div>
              ))}

              {events.length === 0 && (
                <p className="text-gray-500">
                  No strategy events found.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-gray-300 bg-white p-6">
            <h2 className="text-xl font-semibold">
              Pre-trade checklist
            </h2>

            <div className="mt-5 space-y-3">
              {Object.entries(checklist).map(
                ([key, checked]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between rounded border border-gray-300 p-4"
                  >
                    <span className="text-sm font-medium">
                      {checklistLabel(key)}
                    </span>

                    <span className="text-sm font-semibold">
                      {checked
                        ? "Completed"
                        : "Not completed"}
                    </span>
                  </div>
                ),
              )}

              {Object.keys(checklist).length === 0 && (
                <p className="text-gray-500">
                  No checklist information recorded.
                </p>
              )}
            </div>
          </div>
        </section>

      </div>

      {/* Edit Original Plan drawer */}
      {editDrawerOpen && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="Close edit drawer"
            onClick={closeEditDrawer}
            className="absolute inset-0 bg-black/40"
          />

          <aside className="absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto bg-white shadow-xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-300 bg-white px-6 py-5">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.15em] text-gray-500">
                  {strategy.symbol}
                </p>

                <h2 className="mt-1 text-2xl font-bold">
                  Edit Original Plan
                </h2>
              </div>

              <button
                type="button"
                onClick={closeEditDrawer}
                disabled={savingEdit}
                className="rounded border border-gray-300 px-3 py-2 text-sm font-semibold disabled:opacity-50"
              >
                Close
              </button>
            </div>

            <div className="space-y-6 p-6">
              <Field label="Strategy name">
                <input
                  type="text"
                  value={editStrategyName}
                  onChange={(event) =>
                    setEditStrategyName(
                      event.target.value,
                    )
                  }
                  className="w-full rounded border border-gray-300 px-4 py-3"
                />
              </Field>

              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Entry spot">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={editEntrySpot}
                    onChange={(event) =>
                      setEditEntrySpot(
                        event.target.value,
                      )
                    }
                    className="w-full rounded border border-gray-300 px-4 py-3"
                  />
                </Field>

                <Field label="Strategy month">
                  <input
                    type="month"
                    value={editExpiryMonth}
                    onChange={(event) =>
                      setEditExpiryMonth(
                        event.target.value,
                      )
                    }
                    className="w-full rounded border border-gray-300 px-4 py-3"
                  />
                </Field>
              </div>

              <Field label="Trade thesis">
                <textarea
                  rows={5}
                  value={editTradeThesis}
                  onChange={(event) =>
                    setEditTradeThesis(
                      event.target.value,
                    )
                  }
                  className="w-full rounded border border-gray-300 px-4 py-3"
                />
              </Field>

              <Field label="Adjustment plan">
                <textarea
                  rows={4}
                  value={editAdjustmentPlan}
                  onChange={(event) =>
                    setEditAdjustmentPlan(
                      event.target.value,
                    )
                  }
                  className="w-full rounded border border-gray-300 px-4 py-3"
                />
              </Field>

              <Field label="Exit plan">
                <textarea
                  rows={4}
                  value={editExitPlan}
                  onChange={(event) =>
                    setEditExitPlan(
                      event.target.value,
                    )
                  }
                  className="w-full rounded border border-gray-300 px-4 py-3"
                />
              </Field>

              <div>
                <h3 className="text-sm font-semibold">
                  Pre-trade checklist
                </h3>

                <div className="mt-3 space-y-3">
                  {CHECKLIST_ITEMS.map((item) => (
                    <label
                      key={item.key}
                      className="flex cursor-pointer items-center gap-3 rounded border border-gray-300 p-4"
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(
                          editChecklist[item.key],
                        )}
                        onChange={(event) =>
                          updateChecklistItem(
                            item.key,
                            event.target.checked,
                          )
                        }
                        className="h-4 w-4"
                      />

                      <span className="text-sm font-medium">
                        {item.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {editError && (
                <ErrorBox
                  title="Unable to save changes"
                  message={editError}
                />
              )}

              {editWarning && (
                <div className="rounded border border-amber-300 bg-amber-50 p-4">
                  <p className="font-semibold text-amber-900">
                    Strategy updated with a warning
                  </p>

                  <p className="mt-1 text-sm text-amber-800">
                    {editWarning}
                  </p>
                </div>
              )}
            </div>

            <div className="sticky bottom-0 flex gap-3 border-t border-gray-300 bg-white p-6">
              <button
                type="button"
                onClick={closeEditDrawer}
                disabled={savingEdit}
                className="flex-1 rounded border border-gray-400 px-5 py-3 font-semibold disabled:opacity-50"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={saveDecisionEdit}
                disabled={savingEdit}
                className="flex-1 rounded bg-gray-950 px-5 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingEdit
                  ? "Saving..."
                  : "Save Changes"}
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Close Leg drawer */}
      {closeLegDrawerOpen && selectedPosition && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="Close leg drawer"
            onClick={closeCloseLegDrawer}
            className="absolute inset-0 bg-black/40"
          />

          <aside className="absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto bg-white shadow-xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-300 bg-white px-6 py-5">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.15em] text-gray-500">
                  {strategy.symbol}
                </p>

                <h2 className="mt-1 text-2xl font-bold">
                  Close Leg
                </h2>

                <p className="mt-1 text-sm text-gray-500">
                  {describePosition(
                    selectedPosition,
                  )}
                </p>
              </div>

              <button
                type="button"
                onClick={closeCloseLegDrawer}
                disabled={savingClosure}
                className="rounded border border-gray-300 px-3 py-2 text-sm font-semibold disabled:opacity-50"
              >
                Close
              </button>
            </div>

            <div className="space-y-6 p-6">
              <div className="grid gap-4 rounded border border-gray-300 bg-gray-50 p-4 sm:grid-cols-3">
                <SmallMetric
                  label="Entry price"
                  value={`₹${formatNumber(
                    selectedPosition.entry_price,
                  )}`}
                />

                <SmallMetric
                  label="Open quantity"
                  value={formatNumber(
                    selectedPosition.open_quantity,
                  )}
                />

                <SmallMetric
                  label="Current status"
                  value={selectedPosition.status}
                />
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Closing quantity">
                  <input
                    type="number"
                    min="1"
                    max={
                      selectedPosition.open_quantity
                    }
                    step="1"
                    value={closingQuantity}
                    onChange={(event) =>
                      setClosingQuantity(
                        event.target.value,
                      )
                    }
                    className="w-full rounded border border-gray-300 px-4 py-3"
                  />
                </Field>

                <Field label="Closing price">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={closingPrice}
                    onChange={(event) =>
                      setClosingPrice(
                        event.target.value,
                      )
                    }
                    className="w-full rounded border border-gray-300 px-4 py-3"
                  />
                </Field>

                <Field label="Closing date">
                  <input
                    type="date"
                    value={closingDate}
                    onChange={(event) =>
                      setClosingDate(
                        event.target.value,
                      )
                    }
                    className="w-full rounded border border-gray-300 px-4 py-3"
                  />
                </Field>

                <Field label="Underlying spot">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={closingSpot}
                    onChange={(event) =>
                      setClosingSpot(
                        event.target.value,
                      )
                    }
                    placeholder="Spot at closure"
                    className="w-full rounded border border-gray-300 px-4 py-3"
                  />
                </Field>
              </div>

              <div className="rounded border border-gray-300 bg-gray-50 p-4">
                <p className="text-sm text-gray-500">
                  Estimated realised P&amp;L
                </p>

                <p className="mt-1 text-2xl font-semibold">
                  {formatCurrency(
                    estimatedClosurePnl,
                  )}
                </p>

                <p className="mt-2 text-xs text-gray-500">
                  Calculation uses entry price, closing
                  price, quantity and contract multiplier.
                </p>
              </div>

              <Field label="Reason for closing">
                <select
                  value={closingReason}
                  onChange={(event) =>
                    setClosingReason(
                      event.target.value,
                    )
                  }
                  className="w-full rounded border border-gray-300 px-4 py-3"
                >
                  <option value="">
                    Select closing reason
                  </option>

                  {CLOSE_REASONS.map((reason) => (
                    <option
                      key={reason}
                      value={reason}
                    >
                      {reason}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Closure notes">
                <textarea
                  rows={4}
                  value={closingNotes}
                  onChange={(event) =>
                    setClosingNotes(
                      event.target.value,
                    )
                  }
                  placeholder="Why was this leg closed now?"
                  className="w-full rounded border border-gray-300 px-4 py-3"
                />
              </Field>

              {closesEntireStrategy && (
                <div className="space-y-6 rounded border border-green-300 bg-green-50 p-5">
                  <div>
                    <p className="font-semibold text-green-950">
                      Final open leg
                    </p>

                    <p className="mt-1 text-sm text-green-900">
                      Closing this quantity will
                      automatically close the strategy.
                      Complete the post-trade review.
                    </p>
                  </div>

                  <Field label="Final review">
                    <textarea
                      rows={5}
                      value={finalReview}
                      onChange={(event) =>
                        setFinalReview(
                          event.target.value,
                        )
                      }
                      placeholder="What happened, and how did the strategy perform?"
                      className="w-full rounded border border-green-300 bg-white px-4 py-3"
                    />
                  </Field>

                  <Field label="Key lesson">
                    <textarea
                      rows={4}
                      value={keyLesson}
                      onChange={(event) =>
                        setKeyLesson(
                          event.target.value,
                        )
                      }
                      placeholder="What should influence your next similar decision?"
                      className="w-full rounded border border-green-300 bg-white px-4 py-3"
                    />
                  </Field>

                  <Field label="Would you take this trade again?">
                    <select
                      value={wouldTradeAgain}
                      onChange={(event) =>
                        setWouldTradeAgain(
                          event.target.value,
                        )
                      }
                      className="w-full rounded border border-green-300 bg-white px-4 py-3"
                    >
                      <option value="">
                        Select an answer
                      </option>
                      <option value="Yes">
                        Yes
                      </option>
                      <option value="Yes, with changes">
                        Yes, with changes
                      </option>
                      <option value="No">
                        No
                      </option>
                    </select>
                  </Field>

                  <Field label="Decision quality rating">
                    <select
                      value={decisionRating}
                      onChange={(event) =>
                        setDecisionRating(
                          event.target.value,
                        )
                      }
                      className="w-full rounded border border-green-300 bg-white px-4 py-3"
                    >
                      <option value="">
                        Select rating
                      </option>
                      <option value="1">
                        1 — Poor decision
                      </option>
                      <option value="2">
                        2 — Below expectations
                      </option>
                      <option value="3">
                        3 — Acceptable
                      </option>
                      <option value="4">
                        4 — Good decision
                      </option>
                      <option value="5">
                        5 — Excellent decision
                      </option>
                    </select>
                  </Field>
                </div>
              )}

              {closeLegError && (
                <ErrorBox
                  title="Unable to close leg"
                  message={closeLegError}
                />
              )}
            </div>

            <div className="sticky bottom-0 flex gap-3 border-t border-gray-300 bg-white p-6">
              <button
                type="button"
                onClick={closeCloseLegDrawer}
                disabled={savingClosure}
                className="flex-1 rounded border border-gray-400 px-5 py-3 font-semibold disabled:opacity-50"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={saveLegClosure}
                disabled={savingClosure}
                className="flex-1 rounded bg-gray-950 px-5 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingClosure
                  ? "Saving..."
                  : closesEntireStrategy
                    ? "Close Final Leg"
                    : "Close Leg"}
              </button>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

type PositionTableProps = {
  positions: Position[];
  strategyIsClosed: boolean;
  onCloseLeg: (position?: Position) => void;
};

function positionGroupLabel(position: Position) {
  if (position.instrument_type === "FUTURE") return "FUTURES";
  if (position.instrument_type === "OPTION" && position.option_type === "CE") return "CALLS";
  if (position.instrument_type === "OPTION" && position.option_type === "PE") return "PUTS";
  if (position.instrument_type === "EQUITY") return "EQUITY";
  return "OTHER";
}

function PositionTable({
  positions,
  strategyIsClosed,
  onCloseLeg,
}: PositionTableProps) {
  if (positions.length === 0) {
    return (
      <p className="px-6 py-5 text-sm text-gray-500">
        No positions in this section.
      </p>
    );
  }

  let lastGroup = "";

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1700px] text-left text-sm">
        <thead className="bg-gray-100">
          <tr>
            <th className="p-3">Leg</th>
            <th className="p-3">Expiry</th>
            <th className="p-3 text-right">Qty</th>
            <th className="p-3 text-right">Entry</th>
            <th className="p-3 text-right">LTP</th>
            <th className="p-3 text-right">Unrealised MTM</th>
            <th className="p-3 text-right">DTE</th>
            <th className="p-3">Time Risk</th>
            <th className="p-3 text-right">Δ</th>
            <th className="p-3 text-right">Θ</th>
            <th className="p-3 text-right">Γ</th>
            <th className="p-3 text-right">ν</th>
            <th className="p-3 text-right">Realised P&L</th>
            <th className="p-3">Status</th>
            <th className="p-3">Action</th>
          </tr>
        </thead>

        <tbody>
          {positions.map((position) => {
            const group = positionGroupLabel(position);
            const showGroup = group !== lastGroup;
            lastGroup = group;

            return (
              <Fragment key={position.id}>
                {showGroup && (
                  <tr className="border-t border-gray-300 bg-gray-50">
                    <td
                      colSpan={15}
                      className="px-3 py-2 text-xs font-bold uppercase tracking-[0.16em] text-gray-500"
                    >
                      {group}
                    </td>
                  </tr>
                )}

                <tr className="border-t border-gray-200">
                  <td className="p-3 font-semibold">
                    {describePosition(position)}
                  </td>
                  <td className="p-3">{formatDate(position.expiry_date)}</td>
                  <td className="p-3 text-right">{formatNumber(position.open_quantity)}</td>
                  <td className="p-3 text-right">₹{formatNumber(position.entry_price)}</td>
                  <td className="p-3 text-right">
                    {position.current_price === null
                      ? "—"
                      : `₹${formatNumber(position.current_price)}`}
                  </td>
                  <td
                    className={`p-3 text-right font-semibold ${
                      Number(position.mtm ?? 0) > 0
                        ? "text-green-700"
                        : Number(position.mtm ?? 0) < 0
                          ? "text-red-700"
                          : "text-gray-700"
                    }`}
                  >
                    {Number(position.open_quantity ?? 0) > 0
                      ? formatCurrency(position.mtm)
                      : "—"}
                  </td>
                  <td className="p-3 text-right font-semibold">
                    {calculateDte(position.expiry_date) ?? "—"}
                  </td>
                  <td className="p-3">
                    <span
                      title="DTE-based heuristic only. Actual theta and gamma depend on moneyness, implied volatility and market conditions."
                      className="whitespace-nowrap text-xs text-gray-600"
                    >
                      {timeRiskLabel(position)}
                    </span>
                  </td>
                  <td className="p-3 text-right text-gray-400">—</td>
                  <td className="p-3 text-right text-gray-400">—</td>
                  <td className="p-3 text-right text-gray-400">—</td>
                  <td className="p-3 text-right text-gray-400">—</td>
                  <td className="p-3 text-right font-semibold">
                    {formatCurrency(position.realised_pnl)}
                  </td>
                  <td className="p-3">
                    <span className="rounded border border-gray-400 px-2 py-1">
                      {position.status}
                    </span>
                  </td>
                  <td className="p-3">
                    <button
                      type="button"
                      onClick={() => onCloseLeg(position)}
                      disabled={
                        strategyIsClosed ||
                        Number(position.open_quantity) <= 0
                      }
                      className="rounded border border-gray-400 px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Close
                    </button>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type SummaryCardProps = {
  label: string;
  value: string;
};

function SummaryCard({
  label,
  value,
}: SummaryCardProps) {
  return (
    <div className="rounded-lg border border-gray-300 bg-white p-5">
      <p className="text-sm text-gray-500">
        {label}
      </p>

      <p className="mt-2 text-2xl font-semibold">
        {value}
      </p>
    </div>
  );
}

type SmallMetricProps = {
  label: string;
  value: string;
};

function SmallMetric({
  label,
  value,
}: SmallMetricProps) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">
        {label}
      </p>

      <p className="mt-1 font-semibold">
        {value}
      </p>
    </div>
  );
}

type TextSectionProps = {
  label: string;
  value: string | null;
};

function TextSection({
  label,
  value,
}: TextSectionProps) {
  return (
    <div>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </h3>

      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
        {value || "Not recorded"}
      </p>
    </div>
  );
}

type InformationRowProps = {
  label: string;
  value: string;
};

function InformationRow({
  label,
  value,
}: InformationRowProps) {
  return (
    <div>
      <dt className="text-gray-500">
        {label}
      </dt>

      <dd className="mt-1 break-all font-semibold">
        {value}
      </dd>
    </div>
  );
}

type FieldProps = {
  label: string;
  children: React.ReactNode;
};

function Field({
  label,
  children,
}: FieldProps) {
  return (
    <div>
      <label className="mb-2 block text-sm font-semibold">
        {label}
      </label>

      {children}
    </div>
  );
}

type ErrorBoxProps = {
  title: string;
  message: string;
};

function ErrorBox({
  title,
  message,
}: ErrorBoxProps) {
  return (
    <div className="rounded border border-red-300 bg-red-50 p-4">
      <p className="font-semibold text-red-900">
        {title}
      </p>

      <p className="mt-1 text-sm text-red-800">
        {message}
      </p>
    </div>
  );
}