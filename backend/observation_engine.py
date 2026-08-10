from __future__ import annotations

from datetime import date, datetime
from typing import Any


def _float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _nearest_dte(positions: list[dict[str, Any]], as_of: date) -> int | None:
    values: list[int] = []
    for position in positions:
        raw = position.get("expiry_date")
        if not raw:
            continue
        try:
            expiry = date.fromisoformat(str(raw)[:10])
        except ValueError:
            continue
        values.append(max(0, (expiry - as_of).days))
    return min(values) if values else None


def _observation(
    *,
    category: str,
    code: str,
    severity: str,
    confidence: str,
    title: str,
    summary: str,
    why: str,
    review: str | None,
    evidence: dict[str, Any],
) -> dict[str, Any]:
    return {
        "category": category,
        "code": code,
        "severity": severity,
        "confidence": confidence,
        "title": title,
        "summary": summary,
        "why_it_matters": why,
        "suggested_review": review,
        "evidence": evidence,
        "fingerprint": code,
    }


def _evaluate(current: dict[str, Any], previous: dict[str, Any] | None) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []

    dte = current.get("nearest_dte")
    if dte is not None and dte <= 3:
        findings.append(
            _observation(
                category="TIME",
                code="DTE_CRITICAL_WINDOW",
                severity="CRITICAL",
                confidence="HIGH",
                title="Expiry sensitivity is very high",
                summary=f"The nearest open derivative leg has only {dte} DTE remaining.",
                why="Near expiry, option delta can change quickly for relatively small spot moves and the remaining reward can become small relative to gap and gamma risk.",
                review="Review whether the remaining premium justifies keeping the capital and expiry risk deployed.",
                evidence={"nearest_dte": dte},
            )
        )
    elif dte is not None and dte <= 7:
        findings.append(
            _observation(
                category="TIME",
                code="DTE_GAMMA_WINDOW",
                severity="IMPORTANT",
                confidence="HIGH",
                title="Strategy has entered the high-sensitivity expiry window",
                summary=f"The nearest open derivative leg has {dte} DTE remaining.",
                why="Even before calculated gamma is available, low DTE means the payoff can become substantially more sensitive to spot movement, especially around short strikes.",
                review="Review strike proximity, remaining premium and whether capital should remain deployed through this window.",
                evidence={"nearest_dte": dte},
            )
        )
    elif dte is not None and dte <= 14:
        findings.append(
            _observation(
                category="TIME",
                code="DTE_REVIEW_WINDOW",
                severity="ADVISORY",
                confidence="HIGH",
                title="Time-risk review window has started",
                summary=f"The nearest open derivative leg has {dte} DTE remaining.",
                why="The balance between remaining theta capture, capital efficiency and directional sensitivity often changes materially as expiry approaches.",
                review="Compare remaining reward with margin blocked and alternative opportunities before automatically holding to expiry.",
                evidence={"nearest_dte": dte},
            )
        )

    if previous:
        spot = _float(current.get("current_spot_price"))
        previous_spot = _float(previous.get("current_spot_price"))
        if spot and previous_spot and previous_spot > 0:
            move_pct = ((spot / previous_spot) - 1) * 100
            abs_move = abs(move_pct)
            if abs_move >= 4:
                severity = "CRITICAL"
            elif abs_move >= 2:
                severity = "IMPORTANT"
            else:
                severity = None
            if severity:
                findings.append(
                    _observation(
                        category="MARKET",
                        code="SPOT_SHARP_MOVE",
                        severity=severity,
                        confidence="HIGH",
                        title="Underlying moved sharply between reviews",
                        summary=f"Spot changed {move_pct:+.2f}% since the previous VOTE snapshot.",
                        why="A move of this size can materially alter short-option delta, strike proximity, payoff asymmetry and adjustment requirements even when the headline strategy P&L still looks manageable.",
                        review="Review the side of the strategy toward which spot moved and check whether the original thesis still applies.",
                        evidence={
                            "previous_spot": previous_spot,
                            "current_spot": spot,
                            "move_pct": round(move_pct, 4),
                        },
                    )
                )

        current_margin = _float(current.get("margin_used"))
        previous_margin = _float(previous.get("margin_used"))
        if current_margin and previous_margin and previous_margin > 0:
            margin_change_pct = ((current_margin / previous_margin) - 1) * 100
            if margin_change_pct >= 30:
                severity = "CRITICAL"
            elif margin_change_pct >= 15:
                severity = "IMPORTANT"
            else:
                severity = None
            if severity:
                findings.append(
                    _observation(
                        category="CAPITAL",
                        code="MARGIN_EXPANSION",
                        severity=severity,
                        confidence="HIGH",
                        title="Strategy margin requirement expanded sharply",
                        summary=f"Margin used increased {margin_change_pct:.1f}% since the previous snapshot.",
                        why="A margin increase means the strategy is consuming more of the portfolio's scarce deployable capital, reducing capital efficiency and potentially crowding out better opportunities.",
                        review="Review what changed in the open-leg structure or market risk and whether the additional margin remains justified.",
                        evidence={
                            "previous_margin": previous_margin,
                            "current_margin": current_margin,
                            "change_pct": round(margin_change_pct, 4),
                        },
                    )
                )

        current_mtm = _float(current.get("unrealised_mtm")) or 0.0
        previous_mtm = _float(previous.get("unrealised_mtm")) or 0.0
        margin_base = current_margin or previous_margin
        if margin_base and margin_base > 0:
            mtm_change = current_mtm - previous_mtm
            deterioration_pct = (-mtm_change / margin_base) * 100
            if deterioration_pct >= 2:
                severity = "CRITICAL"
            elif deterioration_pct >= 1:
                severity = "IMPORTANT"
            else:
                severity = None
            if severity:
                findings.append(
                    _observation(
                        category="POSITION",
                        code="MTM_DETERIORATION",
                        severity=severity,
                        confidence="HIGH",
                        title="Unrealised MTM deteriorated materially",
                        summary=f"Unrealised MTM changed by {mtm_change:+,.0f}, equal to {deterioration_pct:.2f}% of current strategy margin.",
                        why="Normalizing the P&L change by margin distinguishes a meaningful deterioration from a large-looking rupee move on a large strategy.",
                        review="Review whether this is normal mark-to-market variation, thesis deterioration, or a change that requires adjustment.",
                        evidence={
                            "previous_unrealised_mtm": previous_mtm,
                            "current_unrealised_mtm": current_mtm,
                            "mtm_change": round(mtm_change, 2),
                            "margin_base": margin_base,
                            "deterioration_pct_of_margin": round(deterioration_pct, 4),
                        },
                    )
                )

        # These rules become live automatically when the Greeks / IV engine starts
        # populating the reserved snapshot fields.
        current_iv = _float(current.get("iv"))
        previous_iv = _float(previous.get("iv"))
        if current_iv is not None and previous_iv is not None and previous_iv > 0:
            iv_change_points = current_iv - previous_iv
            iv_change_pct = (iv_change_points / previous_iv) * 100
            if iv_change_points >= 5 or iv_change_pct >= 20:
                findings.append(
                    _observation(
                        category="VOLATILITY",
                        code="IV_EXPANSION",
                        severity="IMPORTANT" if iv_change_pct < 40 else "CRITICAL",
                        confidence="HIGH",
                        title="Implied volatility expanded sharply",
                        summary=f"Strategy IV rose from {previous_iv:.2f} to {current_iv:.2f} ({iv_change_pct:+.1f}%).",
                        why="For a net option seller, rapid IV expansion can increase mark-to-market losses and vega exposure even without a large underlying move.",
                        review="Review whether the volatility expansion is event-driven, temporary, or a change in regime before adding more short-volatility exposure.",
                        evidence={"previous_iv": previous_iv, "current_iv": current_iv, "change_pct": round(iv_change_pct, 4)},
                    )
                )

        current_gamma = _float(current.get("gamma"))
        previous_gamma = _float(previous.get("gamma"))
        if current_gamma is not None and previous_gamma is not None and abs(previous_gamma) > 1e-9:
            gamma_ratio = abs(current_gamma) / abs(previous_gamma)
            if gamma_ratio >= 2:
                findings.append(
                    _observation(
                        category="GREEKS",
                        code="GAMMA_ACCELERATION",
                        severity="CRITICAL" if gamma_ratio >= 3 else "IMPORTANT",
                        confidence="HIGH",
                        title="Gamma exposure has accelerated",
                        summary=f"Absolute strategy gamma is {gamma_ratio:.1f}× the previous snapshot.",
                        why="Higher gamma means strategy delta can change much faster as spot moves, so a position that appeared balanced can become directional quickly.",
                        review="Review strike proximity, DTE and whether the portfolio can tolerate a faster change in directional exposure.",
                        evidence={"previous_gamma": previous_gamma, "current_gamma": current_gamma, "multiple": round(gamma_ratio, 4)},
                    )
                )

        current_delta = _float(current.get("normalized_delta"))
        previous_delta = _float(previous.get("normalized_delta"))
        if current_delta is not None and previous_delta is not None:
            if abs(current_delta) >= 0.30 and abs(previous_delta) < 0.20:
                findings.append(
                    _observation(
                        category="GREEKS",
                        code="DELTA_DIRECTIONAL_DRIFT",
                        severity="IMPORTANT",
                        confidence="HIGH",
                        title="Strategy has become directional",
                        summary=f"Normalized delta moved from {previous_delta:+.2f} to {current_delta:+.2f}.",
                        why="A strategy that was previously close to neutral now has materially larger directional sensitivity, which can change the intended risk profile without any explicit adjustment.",
                        review="Review whether the new directional exposure is intentional and consistent with the current market view.",
                        evidence={"previous_normalized_delta": previous_delta, "current_normalized_delta": current_delta},
                    )
                )

        current_vega = _float(current.get("vega"))
        previous_vega = _float(previous.get("vega"))
        if current_vega is not None and previous_vega is not None and abs(previous_vega) > 1e-9:
            vega_ratio = abs(current_vega) / abs(previous_vega)
            if vega_ratio >= 1.5:
                findings.append(
                    _observation(
                        category="GREEKS",
                        code="VEGA_EXPANSION",
                        severity="IMPORTANT",
                        confidence="HIGH",
                        title="Volatility sensitivity increased materially",
                        summary=f"Absolute strategy vega is now {vega_ratio:.1f}× the previous snapshot.",
                        why="A larger vega means future changes in implied volatility can have a larger effect on MTM than they did when the strategy was initiated or last reviewed.",
                        review="Review whether this increase in volatility exposure is intentional.",
                        evidence={"previous_vega": previous_vega, "current_vega": current_vega, "multiple": round(vega_ratio, 4)},
                    )
                )

    return findings


def capture_strategy_observations(
    database: Any,
    *,
    strategy_id: str,
    captured_at: str,
    positions: list[dict[str, Any]],
    current_spot_price: float | None,
    realised_pnl: float,
    unrealised_mtm: float,
    net_pnl: float,
    margin_used: float | None,
    normalized_delta: float | None = None,
    theta: float | None = None,
    gamma: float | None = None,
    vega: float | None = None,
    iv: float | None = None,
) -> dict[str, Any]:
    captured_dt = datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
    nearest_dte = _nearest_dte(positions, captured_dt.date())

    previous_response = (
        database.table("strategy_risk_snapshots")
        .select("*")
        .eq("strategy_id", strategy_id)
        .order("captured_at", desc=True)
        .limit(1)
        .execute()
    )
    previous = previous_response.data[0] if previous_response.data else None

    current = {
        "strategy_id": strategy_id,
        "captured_at": captured_at,
        "current_spot_price": current_spot_price,
        "realised_pnl": realised_pnl,
        "unrealised_mtm": unrealised_mtm,
        "net_pnl": net_pnl,
        "margin_used": margin_used,
        "nearest_dte": nearest_dte,
        "normalized_delta": normalized_delta,
        "theta": theta,
        "gamma": gamma,
        "vega": vega,
        "iv": iv,
        "source": "MARKET_REFRESH",
    }

    database.table("strategy_risk_snapshots").insert(current).execute()
    findings = _evaluate(current, previous)

    active_response = (
        database.table("strategy_observations")
        .select("id,fingerprint,occurrence_count,status,first_seen_at")
        .eq("strategy_id", strategy_id)
        .eq("status", "ACTIVE")
        .execute()
    )
    active_existing = {row["fingerprint"]: row for row in (active_response.data or [])}
    fired = {item["fingerprint"] for item in findings}

    for item in findings:
        existing = active_existing.get(item["fingerprint"])
        if existing:
            database.table("strategy_observations").update(
                {
                    **item,
                    "status": "ACTIVE",
                    "last_seen_at": captured_at,
                    "resolved_at": None,
                    "occurrence_count": int(existing.get("occurrence_count") or 1) + 1,
                }
            ).eq("id", existing["id"]).execute()
        else:
            prior_any = (
                database.table("strategy_observations")
                .select("id,occurrence_count")
                .eq("strategy_id", strategy_id)
                .eq("fingerprint", item["fingerprint"])
                .limit(1)
                .execute()
            )
            if prior_any.data:
                row = prior_any.data[0]
                database.table("strategy_observations").update(
                    {
                        **item,
                        "status": "ACTIVE",
                        "last_seen_at": captured_at,
                        "resolved_at": None,
                        "occurrence_count": int(row.get("occurrence_count") or 0) + 1,
                    }
                ).eq("id", row["id"]).execute()
            else:
                database.table("strategy_observations").insert(
                    {
                        "strategy_id": strategy_id,
                        **item,
                        "status": "ACTIVE",
                        "first_seen_at": captured_at,
                        "last_seen_at": captured_at,
                        "occurrence_count": 1,
                    }
                ).execute()

    for fingerprint, existing in active_existing.items():
        if fingerprint not in fired:
            database.table("strategy_observations").update(
                {
                    "status": "RESOLVED",
                    "resolved_at": captured_at,
                    "last_seen_at": captured_at,
                }
            ).eq("id", existing["id"]).execute()

    return {
        "nearest_dte": nearest_dte,
        "observations_active": len(findings),
        "observation_codes": [item["code"] for item in findings],
    }
