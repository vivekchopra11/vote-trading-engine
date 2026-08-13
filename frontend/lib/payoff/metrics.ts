import { PayoffPoint } from "./types";

export type PayoffMetrics = {
  breakevens: number[];
  lowerBreakeven: number | null;
  upperBreakeven: number | null;
  maxProfit: number;
  maxLoss: number;
  payoffAtCurrentSpot: number | null;
  distanceToLowerBreakeven: number | null;
  distanceToUpperBreakeven: number | null;
};

function interpolateBreakeven(
  firstPoint: PayoffPoint,
  secondPoint: PayoffPoint,
): number {
  const pnlDifference =
    secondPoint.pnl - firstPoint.pnl;

  if (pnlDifference === 0) {
    return firstPoint.spot;
  }

  const proportion =
    -firstPoint.pnl / pnlDifference;

  return (
    firstPoint.spot +
    proportion *
      (secondPoint.spot - firstPoint.spot)
  );
}

export function calculateBreakevens(
  payoffPoints: PayoffPoint[],
): number[] {
  const breakevens: number[] = [];

  for (
    let index = 0;
    index < payoffPoints.length - 1;
    index += 1
  ) {
    const currentPoint = payoffPoints[index];
    const nextPoint = payoffPoints[index + 1];

    if (currentPoint.pnl === 0) {
      breakevens.push(currentPoint.spot);
      continue;
    }

    const crossesZero =
      (currentPoint.pnl < 0 &&
        nextPoint.pnl > 0) ||
      (currentPoint.pnl > 0 &&
        nextPoint.pnl < 0);

    if (crossesZero) {
      breakevens.push(
        interpolateBreakeven(
          currentPoint,
          nextPoint,
        ),
      );
    }
  }

  const finalPoint =
    payoffPoints[payoffPoints.length - 1];

  if (finalPoint?.pnl === 0) {
    breakevens.push(finalPoint.spot);
  }

  return Array.from(
    new Set(
      breakevens.map(
        (breakeven) =>
          Math.round(breakeven * 100) / 100,
      ),
    ),
  ).sort((first, second) => first - second);
}

export function calculatePayoffAtSpot(
  payoffPoints: PayoffPoint[],
  currentSpot: number,
): number | null {
  if (
    payoffPoints.length === 0 ||
    !Number.isFinite(currentSpot)
  ) {
    return null;
  }

  const exactPoint = payoffPoints.find(
    (point) => point.spot === currentSpot,
  );

  if (exactPoint) {
    return exactPoint.pnl;
  }

  for (
    let index = 0;
    index < payoffPoints.length - 1;
    index += 1
  ) {
    const currentPoint = payoffPoints[index];
    const nextPoint = payoffPoints[index + 1];

    const spotIsBetweenPoints =
      currentSpot > currentPoint.spot &&
      currentSpot < nextPoint.spot;

    if (spotIsBetweenPoints) {
      const proportion =
        (currentSpot - currentPoint.spot) /
        (nextPoint.spot -
          currentPoint.spot);

      return (
        currentPoint.pnl +
        proportion *
          (nextPoint.pnl -
            currentPoint.pnl)
      );
    }
  }

  return null;
}

export function calculatePayoffMetrics(
  payoffPoints: PayoffPoint[],
  currentSpot?: number | null,
): PayoffMetrics {
  if (payoffPoints.length === 0) {
    return {
      breakevens: [],
      lowerBreakeven: null,
      upperBreakeven: null,
      maxProfit: 0,
      maxLoss: 0,
      payoffAtCurrentSpot: null,
      distanceToLowerBreakeven: null,
      distanceToUpperBreakeven: null,
    };
  }

  const breakevens =
    calculateBreakevens(payoffPoints);

  const pnlValues = payoffPoints.map(
    (point) => point.pnl,
  );

  const maxProfit = Math.max(...pnlValues);
  const maxLoss = Math.min(...pnlValues);

  const lowerBreakeven =
    breakevens.length > 0
      ? breakevens[0]
      : null;

  const upperBreakeven =
    breakevens.length > 1
      ? breakevens[
          breakevens.length - 1
        ]
      : null;

  const validCurrentSpot =
    currentSpot !== null &&
    currentSpot !== undefined &&
    Number.isFinite(currentSpot);

  const payoffAtCurrentSpot =
    validCurrentSpot
      ? calculatePayoffAtSpot(
          payoffPoints,
          currentSpot,
        )
      : null;

  const distanceToLowerBreakeven =
    validCurrentSpot &&
    lowerBreakeven !== null
      ? currentSpot - lowerBreakeven
      : null;

  const distanceToUpperBreakeven =
    validCurrentSpot &&
    upperBreakeven !== null
      ? upperBreakeven - currentSpot
      : null;

  return {
    breakevens,
    lowerBreakeven,
    upperBreakeven,
    maxProfit,
    maxLoss,
    payoffAtCurrentSpot,
    distanceToLowerBreakeven,
    distanceToUpperBreakeven,
  };
}
