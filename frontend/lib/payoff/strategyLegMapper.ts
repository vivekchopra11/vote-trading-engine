import type { StrategyLeg } from "./types";

export type PositionLike = {
  instrument_type?: string | null;
  option_type?: string | null;
  strike?: number | null;
  position_side?: string | null;

  open_quantity?: number | null;
  quantity?: number | null;

  entry_price?: number | null;

  contract_multiplier?: number | null;
  lot_size?: number | null;
};

export function mapPositionsToStrategyLegs(
  positions: PositionLike[],
): StrategyLeg[] {
  return positions.flatMap((position) => {
    const quantity = Number(
      position.open_quantity ??
        position.quantity ??
        0,
    );

    const lotSize = Number(
      position.contract_multiplier ??
        position.lot_size ??
        1,
    );

    const side =
      position.position_side === "BUY"
        ? "BUY"
        : position.position_side === "SELL"
          ? "SELL"
          : null;

    if (
      !side ||
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
        position.option_type === "PE")
    ) {
      const strike = Number(position.strike);
      const premium = Number(
        position.entry_price ?? 0,
      );

      if (
        !Number.isFinite(strike) ||
        strike <= 0 ||
        !Number.isFinite(premium) ||
        premium < 0
      ) {
        return [];
      }

      return [
        {
          instrumentType: "OPTION",
          side,
          optionType: position.option_type,
          strike,
          premium,
          quantity,
          lotSize,
        },
      ];
    }

    if (position.instrument_type === "FUTURE") {
      const entryPrice = Number(
        position.entry_price,
      );

      if (
        !Number.isFinite(entryPrice) ||
        entryPrice <= 0
      ) {
        return [];
      }

      return [
        {
          instrumentType: "FUTURE",
          side,
          entryPrice,
          quantity,
          lotSize,
        },
      ];
    }

    return [];
  });
}