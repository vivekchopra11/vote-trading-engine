export type OptionType = "CE" | "PE";

export type PositionSide = "BUY" | "SELL";

export interface OptionLeg {
  /**
   * Optional for backward compatibility with existing option-only callers.
   */
  instrumentType?: "OPTION";

  side: PositionSide;
  optionType: OptionType;

  strike: number;
  premium: number;

  quantity: number;
  lotSize: number;
}

export interface FutureLeg {
  instrumentType: "FUTURE";

  side: PositionSide;

  /**
   * Futures entry price used as the payoff reference price.
   */
  entryPrice: number;

  quantity: number;
  lotSize: number;
}

export type StrategyLeg = OptionLeg | FutureLeg;

export interface PayoffPoint {
  /**
   * Percentage movement from the current spot.
   *
   * Examples:
   * -5 = 5% below current spot
   *  0 = current spot
   *  5 = 5% above current spot
   */
  percentMove: number;

  /**
   * Absolute underlying price for this scenario.
   */
  spot: number;

  /**
   * Total strategy payoff at expiry.
   */
  pnl: number;
}

export interface StrategyMetrics {
  payoffAtCurrentSpot: number | null;

  maxProfit: number | null;
  maxLoss: number | null;

  breakevens: number[];

  lowerBreakeven: number | null;
  upperBreakeven: number | null;

  distanceToLowerBreakeven: number | null;
  distanceToUpperBreakeven: number | null;
}
