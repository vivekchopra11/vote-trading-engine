"use client";

import { useMemo, useState } from "react";
import {
  calculatePayoffMetrics,
  calculateStrategyPayoff,
  OptionLeg,
} from "@/lib/payoff";

type PayoffPanelProps = {
  legs: OptionLeg[];
  currentSpot: number | null;
  expiryMonth?: string | null;
  executionReserve?: number;
  chartHeight?: number;
  pnlOffset?: number;
  mtmReference?: number | null;
  mtmReferenceLabel?: string;
  comparisonLegs?: OptionLeg[];
  primaryLabel?: string;
  comparisonLabel?: string;
};

type HoverPoint = {
  spot: number;
  pnl: number;
  x: number;
  y: number;
};

type StrikeMarker = {
  strike: number;
  side: "BUY" | "SELL";
  labels: string[];
};

const RANGE_OPTIONS = [2, 5, 10, 15, 20];

function formatCompactCurrency(value: number | null) {
  if (value === null) {
    return "—";
  }

  const sign = value >= 0 ? "+" : "-";
  const absoluteValue = Math.abs(value);

  if (absoluteValue >= 10000000) {
    return `${sign}₹${(
      absoluteValue / 10000000
    ).toFixed(1)}Cr`;
  }

  if (absoluteValue >= 100000) {
    return `${sign}₹${(
      absoluteValue / 100000
    ).toFixed(1)}L`;
  }

  if (absoluteValue >= 1000) {
    return `${sign}₹${(
      absoluteValue / 1000
    ).toFixed(1)}K`;
  }

  return `${sign}₹${Math.round(absoluteValue)}`;
}

function formatAxisCurrency(value: number) {
  const absoluteValue = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (absoluteValue >= 10000000) {
    return `${sign}₹${(
      absoluteValue / 10000000
    ).toFixed(1)}Cr`;
  }

  if (absoluteValue >= 100000) {
    return `${sign}₹${(
      absoluteValue / 100000
    ).toFixed(1)}L`;
  }

  if (absoluteValue >= 1000) {
    return `${sign}₹${(
      absoluteValue / 1000
    ).toFixed(1)}K`;
  }

  return `${sign}₹${Math.round(absoluteValue)}`;
}

function formatNumber(
  value: number | null | undefined,
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return "—";
  }

  return value.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  });
}

function formatExpiry(
  value: string | null | undefined,
) {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    year: "2-digit",
  }).format(new Date(value));
}

function createTicks(
  minimum: number,
  maximum: number,
  tickCount: number,
) {
  if (tickCount <= 1 || minimum === maximum) {
    return [minimum];
  }

  const interval =
    (maximum - minimum) / (tickCount - 1);

  return Array.from(
    { length: tickCount },
    (_, index) => minimum + interval * index,
  );
}

function calculateDistancePercent(
  spot: number | null,
  breakeven: number | null,
) {
  if (
    spot === null ||
    breakeven === null ||
    !Number.isFinite(spot) ||
    spot <= 0
  ) {
    return null;
  }

  return ((breakeven - spot) / spot) * 100;
}

function buildStrikeMarkers(
  legs: OptionLeg[],
): StrikeMarker[] {
  const grouped = new Map<string, StrikeMarker>();

  legs.forEach((leg) => {
    const rawLeg = leg as OptionLeg & {
      instrumentType?: string | null;
      strike?: number | null;
      optionType?: string | null;
      side?: string | null;
    };

    // Strike markers are only meaningful for valid option legs.
    // Futures/equities and malformed legs are ignored at the UI boundary.
    if (
      rawLeg.instrumentType &&
      rawLeg.instrumentType !== "OPTION"
    ) {
      return;
    }

    const strike = Number(rawLeg.strike);
    const side = rawLeg.side;
    const optionType = rawLeg.optionType;

    if (
      !Number.isFinite(strike) ||
      strike <= 0 ||
      (side !== "BUY" && side !== "SELL") ||
      (optionType !== "CE" && optionType !== "PE")
    ) {
      return;
    }

    const key = `${side}-${strike}`;
    const existing = grouped.get(key);

    if (existing) {
      if (!existing.labels.includes(optionType)) {
        existing.labels.push(optionType);
      }
      return;
    }

    grouped.set(key, {
      strike,
      side,
      labels: [optionType],
    });
  });

  return Array.from(grouped.values()).sort(
    (first, second) =>
      first.strike - second.strike ||
      first.side.localeCompare(second.side),
  );
}

export default function PayoffPanel({
  legs,
  currentSpot,
  expiryMonth,
  executionReserve = 0,
  chartHeight = 450,
  pnlOffset = 0,
  mtmReference = null,
  mtmReferenceLabel = "Current MTM",
  comparisonLegs,
  primaryLabel = "Current",
  comparisonLabel = "Preview",
}: PayoffPanelProps) {
  const [rangePercent, setRangePercent] =
    useState(5);
  const [realisticMode, setRealisticMode] =
    useState(executionReserve > 0);
  const [hoverPoint, setHoverPoint] =
    useState<HoverPoint | null>(null);

  const payoffPoints = useMemo(
    () =>
      calculateStrategyPayoff(
        legs,
        currentSpot,
        rangePercent,
        201,
      ),
    [legs, currentSpot, rangePercent],
  );

  const displayedPayoffPoints = useMemo(
    () =>
      payoffPoints
        .map((point) => ({
          ...point,
          pnl:
            point.pnl +
            pnlOffset -
            (realisticMode ? executionReserve : 0),
        }))
        .filter(
          (point) =>
            Number.isFinite(point.spot) &&
            Number.isFinite(point.pnl),
        ),
    [
      payoffPoints,
      pnlOffset,
      realisticMode,
      executionReserve,
    ],
  );

  const comparisonPayoffPoints = useMemo(
    () =>
      comparisonLegs && comparisonLegs.length > 0
        ? calculateStrategyPayoff(
            comparisonLegs,
            currentSpot,
            rangePercent,
            201,
          )
        : [],
    [comparisonLegs, currentSpot, rangePercent],
  );

  const displayedComparisonPayoffPoints = useMemo(
    () =>
      comparisonPayoffPoints
        .map((point) => ({
          ...point,
          pnl:
            point.pnl +
            pnlOffset -
            (realisticMode ? executionReserve : 0),
        }))
        .filter(
          (point) =>
            Number.isFinite(point.spot) &&
            Number.isFinite(point.pnl),
        ),
    [
      comparisonPayoffPoints,
      pnlOffset,
      realisticMode,
      executionReserve,
    ],
  );

  const metrics = useMemo(
    () =>
      calculatePayoffMetrics(
        displayedPayoffPoints,
        currentSpot,
      ),
    [displayedPayoffPoints, currentSpot],
  );

  const strikeMarkers = useMemo(
    () => buildStrikeMarkers(legs),
    [legs],
  );

  const lowerDistancePercent =
    calculateDistancePercent(
      currentSpot,
      metrics.lowerBreakeven,
    );

  const upperDistancePercent =
    calculateDistancePercent(
      currentSpot,
      metrics.upperBreakeven,
    );

  if (
    legs.length === 0 ||
    displayedPayoffPoints.length === 0
  ) {
    return (
      <section className="rounded-lg border border-gray-300 bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">
          Strategy Map
        </p>

        <p className="mt-3 text-sm text-gray-500">
          No open option legs are available for
          payoff calculation.
        </p>
      </section>
    );
  }

  const width = 1000;
  const height = Math.max(450, chartHeight);

  const leftPadding = 78;
  const rightPadding = 24;
  const topPadding = 58;
  const bottomPadding = 58;

  const minSpot = displayedPayoffPoints[0].spot;

  const maxSpot =
    displayedPayoffPoints[
      displayedPayoffPoints.length - 1
    ].spot;

  const pnlValues = [
    ...displayedPayoffPoints.map((point) => point.pnl),
    ...displayedComparisonPayoffPoints.map((point) => point.pnl),
  ];

  const validMtmReference =
    mtmReference !== null &&
    Number.isFinite(Number(mtmReference))
      ? Number(mtmReference)
      : null;

  const rawMinPnl = Math.min(
    ...pnlValues,
    0,
    ...(validMtmReference === null
      ? []
      : [validMtmReference]),
  );

  const rawMaxPnl = Math.max(
    ...pnlValues,
    0,
    ...(validMtmReference === null
      ? []
      : [validMtmReference]),
  );

  const pnlPadding =
    Math.max(
      rawMaxPnl - rawMinPnl,
      1,
    ) * 0.08;

  const minPnl =
    rawMinPnl - pnlPadding;

  const maxPnl =
    rawMaxPnl + pnlPadding;

  const spotRange =
    maxSpot - minSpot || 1;

  const pnlRange =
    maxPnl - minPnl || 1;

  function xScale(spot: number) {
    return (
      leftPadding +
      ((spot - minSpot) / spotRange) *
        (
          width -
          leftPadding -
          rightPadding
        )
    );
  }

  function yScale(pnl: number) {
    return (
      height -
      bottomPadding -
      ((pnl - minPnl) / pnlRange) *
        (
          height -
          topPadding -
          bottomPadding
        )
    );
  }

  function handleChartMouseMove(
    event: React.MouseEvent<SVGSVGElement>,
  ) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;

    const svgX =
      ((event.clientX - bounds.left) / bounds.width) * width;

    const clampedX = Math.min(
      width - rightPadding,
      Math.max(leftPadding, svgX),
    );

    const hoveredSpot =
      minSpot +
      ((clampedX - leftPadding) /
        (width - leftPadding - rightPadding)) *
        spotRange;

    let nearest = displayedPayoffPoints[0];
    let nearestDistance = Math.abs(nearest.spot - hoveredSpot);

    for (const point of displayedPayoffPoints) {
      const distance = Math.abs(point.spot - hoveredSpot);
      if (distance < nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }

    setHoverPoint({
      spot: nearest.spot,
      pnl: nearest.pnl,
      x: xScale(nearest.spot),
      y: yScale(nearest.pnl),
    });
  }

  const payoffPath = displayedPayoffPoints
    .map((point, index) => {
      const prefix =
        index === 0 ? "M" : "L";

      return `${prefix} ${xScale(
        point.spot,
      )} ${yScale(point.pnl)}`;
    })
    .join(" ");

  const comparisonPayoffPath = displayedComparisonPayoffPoints
    .map((point, index) => {
      const prefix = index === 0 ? "M" : "L";
      return `${prefix} ${xScale(point.spot)} ${yScale(point.pnl)}`;
    })
    .join(" ");

  const zeroY = yScale(0);

  const currentSpotX =
    currentSpot !== null &&
    Number.isFinite(currentSpot) &&
    currentSpot >= minSpot &&
    currentSpot <= maxSpot
      ? xScale(currentSpot)
      : null;

  const xTicks = createTicks(
    minSpot,
    maxSpot,
    7,
  );

  const yTicks = createTicks(
    minPnl,
    maxPnl,
    6,
  );

  const breakevenRange =
    metrics.lowerBreakeven !== null &&
    metrics.upperBreakeven !== null
      ? `${formatNumber(
          metrics.lowerBreakeven,
        )}–${formatNumber(
          metrics.upperBreakeven,
        )}`
      : metrics.breakevens.length === 1
        ? formatNumber(
            metrics.breakevens[0],
          )
        : "—";

  const nearestBreakevenDistance = [
    lowerDistancePercent,
    upperDistancePercent,
  ]
    .filter(
      (value): value is number =>
        value !== null &&
        Number.isFinite(value),
    )
    .sort(
      (first, second) =>
        Math.abs(first) -
        Math.abs(second),
    )[0];

  return (
    <section className="overflow-hidden rounded-lg border border-gray-300 bg-white">
      <div className="flex flex-col gap-4 border-b border-gray-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">
            Strategy Map
          </p>

          <p className="mt-1 text-sm text-gray-600">
            Combined expiry payoff and active
            option strikes
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {displayedComparisonPayoffPoints.length > 0 && (
            <div className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-6 bg-gray-900" />
                {primaryLabel}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-6 border-t-2 border-dashed border-blue-600" />
                {comparisonLabel}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1 rounded border border-gray-300 bg-gray-50 p-1">
            <button
              type="button"
              onClick={() => setRealisticMode(false)}
              aria-pressed={!realisticMode}
              className={`rounded px-3 py-1.5 text-[11px] font-semibold transition ${
                !realisticMode
                  ? "bg-gray-950 text-white"
                  : "text-gray-600 hover:bg-gray-200"
              }`}
            >
              Theoretical
            </button>

            <button
              type="button"
              onClick={() => setRealisticMode(true)}
              aria-pressed={realisticMode}
              disabled={executionReserve <= 0}
              title={
                executionReserve > 0
                  ? `Deducts ₹${executionReserve.toLocaleString("en-IN")} execution reserve`
                  : "No execution reserve is available for this strategy"
              }
              className={`rounded px-3 py-1.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                realisticMode
                  ? "bg-gray-950 text-white"
                  : "text-gray-600 hover:bg-gray-200"
              }`}
            >
              Realistic
            </button>
          </div>

          {executionReserve > 0 && (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              Reserve ₹{executionReserve.toLocaleString("en-IN")}
            </span>
          )}

          <div className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-orange-500" />
              Sell
            </span>

            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-sky-500" />
              Buy
            </span>
          </div>

          <div className="flex items-center gap-1 rounded border border-gray-300 bg-gray-50 p-1">
            <span className="px-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              Range
            </span>

            {RANGE_OPTIONS.map(
              (rangeOption) => {
                const selected =
                  rangePercent ===
                  rangeOption;

                return (
                  <button
                    key={rangeOption}
                    type="button"
                    onClick={() =>
                      setRangePercent(
                        rangeOption,
                      )
                    }
                    aria-pressed={selected}
                    className={`rounded px-2 py-1 text-[11px] font-semibold transition ${
                      selected
                        ? "bg-gray-950 text-white"
                        : "text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    ±{rangeOption}%
                  </button>
                );
              },
            )}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto px-3 pt-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full min-w-[720px]"
          role="img"
          aria-label="Combined expiry payoff chart with strike markers"
          onMouseMove={handleChartMouseMove}
          onMouseLeave={() => setHoverPoint(null)}
        >
          {yTicks.map((tick) => {
            const y = yScale(tick);

            return (
              <g key={`y-${tick}`}>
                <line
                  x1={leftPadding}
                  y1={y}
                  x2={
                    width -
                    rightPadding
                  }
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity="0.09"
                />

                <text
                  x={leftPadding - 10}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="11"
                  fill="currentColor"
                  opacity="0.65"
                >
                  {formatAxisCurrency(
                    tick,
                  )}
                </text>
              </g>
            );
          })}

          {xTicks.map((tick) => {
            const x = xScale(tick);

            return (
              <g key={`x-${tick}`}>
                <line
                  x1={x}
                  y1={topPadding}
                  x2={x}
                  y2={
                    height -
                    bottomPadding
                  }
                  stroke="currentColor"
                  strokeOpacity="0.06"
                />

                <text
                  x={x}
                  y={
                    height -
                    bottomPadding +
                    22
                  }
                  textAnchor="middle"
                  fontSize="11"
                  fill="currentColor"
                  opacity="0.68"
                >
                  {Math.round(
                    tick,
                  ).toLocaleString(
                    "en-IN",
                  )}
                </text>
              </g>
            );
          })}

          <line
            x1={leftPadding}
            y1={
              height -
              bottomPadding
            }
            x2={
              width -
              rightPadding
            }
            y2={
              height -
              bottomPadding
            }
            stroke="currentColor"
            strokeOpacity="0.28"
          />

          <line
            x1={leftPadding}
            y1={zeroY}
            x2={
              width -
              rightPadding
            }
            y2={zeroY}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeOpacity="0.42"
          />

          {validMtmReference !== null && (
            <g>
              <line
                x1={leftPadding}
                y1={yScale(validMtmReference)}
                x2={width - rightPadding}
                y2={yScale(validMtmReference)}
                stroke="#7c3aed"
                strokeWidth="2"
                strokeDasharray="10 6"
                strokeOpacity="0.9"
              />

              <rect
                x={leftPadding + 8}
                y={yScale(validMtmReference) - 24}
                width="190"
                height="20"
                rx="5"
                fill="#f5f3ff"
                stroke="#7c3aed"
                strokeOpacity="0.85"
              />

              <text
                x={leftPadding + 16}
                y={yScale(validMtmReference) - 10}
                fontSize="10"
                fontWeight="700"
                fill="#6d28d9"
              >
                {mtmReferenceLabel}: {formatCompactCurrency(validMtmReference)}
              </text>
            </g>
          )}

          {strikeMarkers.map(
            (marker, index) => {
              if (
                !Number.isFinite(marker.strike) ||
                marker.strike < minSpot ||
                marker.strike > maxSpot
              ) {
                return null;
              }

              const x = xScale(marker.strike);

              if (!Number.isFinite(x)) {
                return null;
              }

              const isSell =
                marker.side ===
                "SELL";

              const labelY =
                index % 2 === 0
                  ? topPadding - 29
                  : topPadding - 10;

              return (
                <g
                  key={`${marker.side}-${marker.strike}`}
                >
                  <line
                    x1={x}
                    y1={topPadding}
                    x2={x}
                    y2={
                      height -
                      bottomPadding
                    }
                    stroke={
                      isSell
                        ? "#f97316"
                        : "#0ea5e9"
                    }
                    strokeWidth={
                      isSell
                        ? 2
                        : 1.5
                    }
                    strokeDasharray={
                      isSell
                        ? "5 4"
                        : "2 5"
                    }
                    strokeOpacity={
                      isSell
                        ? 0.7
                        : 0.5
                    }
                  />

                  <rect
                    x={x - 34}
                    y={labelY - 12}
                    width="68"
                    height="18"
                    rx="4"
                    fill={
                      isSell
                        ? "#fff7ed"
                        : "#f0f9ff"
                    }
                    stroke={
                      isSell
                        ? "#f97316"
                        : "#0ea5e9"
                    }
                    strokeOpacity="0.8"
                  />

                  <text
                    x={x}
                    y={labelY}
                    textAnchor="middle"
                    fontSize="9"
                    fontWeight="700"
                    fill={
                      isSell
                        ? "#c2410c"
                        : "#0369a1"
                    }
                  >
                    {marker.side}{" "}
                    {formatNumber(
                      marker.strike,
                    )}{" "}
                    {marker.labels.join(
                      "/",
                    )}
                  </text>
                </g>
              );
            },
          )}

          <path
            d={payoffPath}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {comparisonPayoffPath && (
            <path
              d={comparisonPayoffPath}
              fill="none"
              stroke="#2563eb"
              strokeWidth="3"
              strokeDasharray="9 6"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {metrics.breakevens.map(
            (breakeven) => {
              if (
                !Number.isFinite(breakeven) ||
                breakeven < minSpot ||
                breakeven > maxSpot
              ) {
                return null;
              }

              return (
                <g
                  key={breakeven}
                >
                  <line
                    x1={xScale(
                      breakeven,
                    )}
                    y1={topPadding}
                    x2={xScale(
                      breakeven,
                    )}
                    y2={
                      height -
                      bottomPadding
                    }
                    stroke="currentColor"
                    strokeDasharray="4 6"
                    strokeOpacity="0.35"
                  />

                  <circle
                    cx={xScale(
                      breakeven,
                    )}
                    cy={zeroY}
                    r="4.5"
                    fill="currentColor"
                  />

                  <text
                    x={xScale(
                      breakeven,
                    )}
                    y={zeroY - 9}
                    textAnchor="middle"
                    fontSize="10"
                    fontWeight="600"
                    fill="currentColor"
                  >
                    BE{" "}
                    {formatNumber(
                      breakeven,
                    )}
                  </text>
                </g>
              );
            },
          )}

          {currentSpotX !== null && (
            <>
              <line
                x1={currentSpotX}
                y1={topPadding}
                x2={currentSpotX}
                y2={
                  height -
                  bottomPadding
                }
                stroke="#2563eb"
                strokeDasharray="8 5"
                strokeWidth="2.5"
                strokeOpacity="0.85"
              />

              <circle
                cx={currentSpotX}
                cy={yScale(
                  metrics.payoffAtCurrentSpot ??
                    0,
                )}
                r="6"
                fill="#2563eb"
              />

              <rect
                x={
                  currentSpotX -
                  38
                }
                y={
                  topPadding +
                  8
                }
                width="76"
                height="20"
                rx="5"
                fill="#eff6ff"
                stroke="#2563eb"
              />

              <text
                x={currentSpotX}
                y={
                  topPadding +
                  22
                }
                textAnchor="middle"
                fontSize="10"
                fontWeight="700"
                fill="#1d4ed8"
              >
                SPOT{" "}
                {formatNumber(
                  currentSpot,
                )}
              </text>
            </>
          )}

          {hoverPoint && (
            <g pointerEvents="none">
              <line
                x1={hoverPoint.x}
                y1={topPadding}
                x2={hoverPoint.x}
                y2={height - bottomPadding}
                stroke="#111827"
                strokeWidth="1"
                strokeDasharray="3 4"
                strokeOpacity="0.45"
              />
              <line
                x1={leftPadding}
                y1={hoverPoint.y}
                x2={width - rightPadding}
                y2={hoverPoint.y}
                stroke="#111827"
                strokeWidth="1"
                strokeDasharray="3 4"
                strokeOpacity="0.28"
              />
              <circle
                cx={hoverPoint.x}
                cy={hoverPoint.y}
                r="5"
                fill="#111827"
                stroke="white"
                strokeWidth="2"
              />
              <g
                transform={`translate(${Math.min(
                  hoverPoint.x + 12,
                  width - rightPadding - 168,
                )}, ${Math.max(topPadding + 8, hoverPoint.y - 54)})`}
              >
                <rect
                  width="158"
                  height="48"
                  rx="6"
                  fill="#111827"
                  opacity="0.94"
                />
                <text
                  x="10"
                  y="18"
                  fontSize="11"
                  fontWeight="600"
                  fill="white"
                >
                  Spot ₹{formatNumber(hoverPoint.spot)}
                </text>
                <text
                  x="10"
                  y="36"
                  fontSize="11"
                  fontWeight="700"
                  fill="white"
                >
                  P&amp;L {formatCompactCurrency(hoverPoint.pnl)}
                </text>
              </g>
            </g>
          )}

          <text
            x={
              leftPadding +
              (
                width -
                leftPadding -
                rightPadding
              ) /
                2
            }
            y={height - 12}
            textAnchor="middle"
            fontSize="11"
            fontWeight="600"
            fill="currentColor"
            opacity="0.72"
          >
            Underlying price at expiry
          </text>
        </svg>
      </div>

      <div className="grid grid-cols-2 border-t border-gray-200 bg-gray-50 sm:grid-cols-4 xl:grid-cols-8">
        <CompactMetric
          label="Spot"
          value={
            currentSpot === null
              ? "—"
              : `₹${formatNumber(
                  currentSpot,
                )}`
          }
        />

        <CompactMetric
          label="Breakeven"
          value={breakevenRange}
        />

        <CompactMetric
          label="Nearest BE"
          value={
            nearestBreakevenDistance ===
            undefined
              ? "—"
              : `${
                  nearestBreakevenDistance >=
                  0
                    ? "+"
                    : ""
                }${nearestBreakevenDistance.toFixed(
                  1,
                )}%`
          }
        />

        <CompactMetric
          label="Expiry"
          value={formatExpiry(
            expiryMonth,
          )}
        />

        <CompactMetric
          label="At spot"
          value={formatCompactCurrency(
            metrics.payoffAtCurrentSpot,
          )}
        />

        <CompactMetric
          label="Execution reserve"
          value={
            executionReserve > 0
              ? `-₹${executionReserve.toLocaleString("en-IN", {
                  maximumFractionDigits: 0,
                })}`
              : "₹0"
          }
        />

        <CompactMetric
          label={realisticMode ? "Realistic max" : "Max profit"}
          value={formatCompactCurrency(
            metrics.maxProfit,
          )}
        />

        <CompactMetric
          label="Max loss"
          value={formatCompactCurrency(
            metrics.maxLoss,
          )}
        />
      </div>
    </section>
  );
}

function CompactMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 border-b border-r border-gray-200 px-3 py-3 last:border-r-0 sm:border-b-0">
      <p className="truncate text-[9px] font-semibold uppercase tracking-[0.12em] text-gray-500">
        {label}
      </p>

      <p className="mt-1 truncate text-xs font-semibold text-gray-950">
        {value}
      </p>
    </div>
  );
}