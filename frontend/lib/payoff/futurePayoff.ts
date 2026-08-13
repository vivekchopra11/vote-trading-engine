import { FutureLeg } from "./types";

export function futureLegPayoff(
  leg: FutureLeg,
  expirySpot: number,
): number {
  const direction = leg.side === "BUY" ? 1 : -1;

  return (
    direction *
    (expirySpot - leg.entryPrice) *
    leg.quantity *
    leg.lotSize
  );
}
