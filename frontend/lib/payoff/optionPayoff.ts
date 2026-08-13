import { OptionLeg } from "./types";

export function optionLegPayoff(
  leg: OptionLeg,
  spot: number,
): number {
  const intrinsic =
    leg.optionType === "CE"
      ? Math.max(spot - leg.strike, 0)
      : Math.max(leg.strike - spot, 0);

  let payoffPerShare = 0;

  if (
    leg.side === "BUY" &&
    leg.optionType === "CE"
  ) {
    payoffPerShare = intrinsic - leg.premium;
  }

  if (
    leg.side === "SELL" &&
    leg.optionType === "CE"
  ) {
    payoffPerShare = leg.premium - intrinsic;
  }

  if (
    leg.side === "BUY" &&
    leg.optionType === "PE"
  ) {
    payoffPerShare = intrinsic - leg.premium;
  }

  if (
    leg.side === "SELL" &&
    leg.optionType === "PE"
  ) {
    payoffPerShare = leg.premium - intrinsic;
  }

  return (
    payoffPerShare *
    leg.quantity *
    leg.lotSize
  );
}