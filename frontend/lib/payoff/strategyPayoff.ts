import {
  FutureLeg,
  OptionLeg,
  PayoffPoint,
  StrategyLeg,
} from "./types";
import { optionLegPayoff } from "./optionPayoff";
import { futureLegPayoff } from "./futurePayoff";

const DEFAULT_RANGE_PERCENT = 5;
const DEFAULT_POINT_COUNT = 201;

function isFutureLeg(leg: StrategyLeg): leg is FutureLeg {
  return leg.instrumentType === "FUTURE";
}

function isValidOptionLeg(leg: OptionLeg): boolean {
  return (
    Number.isFinite(leg.strike) &&
    leg.strike > 0 &&
    Number.isFinite(leg.premium) &&
    leg.premium >= 0 &&
    Number.isFinite(leg.quantity) &&
    leg.quantity > 0 &&
    Number.isFinite(leg.lotSize) &&
    leg.lotSize > 0
  );
}

function isValidFutureLeg(leg: FutureLeg): boolean {
  return (
    Number.isFinite(leg.entryPrice) &&
    leg.entryPrice > 0 &&
    Number.isFinite(leg.quantity) &&
    leg.quantity > 0 &&
    Number.isFinite(leg.lotSize) &&
    leg.lotSize > 0
  );
}

function calculateLegPayoff(
  leg: StrategyLeg,
  expirySpot: number,
): number {
  if (isFutureLeg(leg)) {
    return futureLegPayoff(leg, expirySpot);
  }

  return optionLegPayoff(leg, expirySpot);
}

function getFallbackReferenceSpot(
  legs: StrategyLeg[],
): number | null {
  const referencePrices = legs
    .map((leg) =>
      isFutureLeg(leg) ? leg.entryPrice : leg.strike,
    )
    .filter(
      (value) => Number.isFinite(value) && value > 0,
    );

  if (referencePrices.length === 0) {
    return null;
  }

  return (
    referencePrices.reduce(
      (total, value) => total + value,
      0,
    ) / referencePrices.length
  );
}

export function calculateStrategyPayoff(
  legs: StrategyLeg[],
  currentSpot?: number | null,
  rangePercent = DEFAULT_RANGE_PERCENT,
  pointCount = DEFAULT_POINT_COUNT,
): PayoffPoint[] {
  if (legs.length === 0) {
    return [];
  }

  const validLegs = legs.filter((leg) =>
    isFutureLeg(leg)
      ? isValidFutureLeg(leg)
      : isValidOptionLeg(leg),
  );

  if (validLegs.length === 0) {
    return [];
  }

  const fallbackSpot = getFallbackReferenceSpot(validLegs);

  const referenceSpot =
    currentSpot !== null &&
    currentSpot !== undefined &&
    Number.isFinite(currentSpot) &&
    currentSpot > 0
      ? currentSpot
      : fallbackSpot;

  if (referenceSpot === null) {
    return [];
  }

  const safeRangePercent = Math.max(
    1,
    Math.abs(rangePercent),
  );

  const safePointCount = Math.max(
    3,
    Math.floor(pointCount),
  );

  const payoffPoints: PayoffPoint[] = [];

  for (
    let index = 0;
    index < safePointCount;
    index += 1
  ) {
    const progress = index / (safePointCount - 1);

    const percentMove =
      -safeRangePercent +
      progress * safeRangePercent * 2;

    const spot =
      referenceSpot * (1 + percentMove / 100);

    const pnl = validLegs.reduce(
      (total, leg) =>
        total + calculateLegPayoff(leg, spot),
      0,
    );

    payoffPoints.push({
      percentMove,
      spot,
      pnl,
    });
  }

  return payoffPoints;
}
