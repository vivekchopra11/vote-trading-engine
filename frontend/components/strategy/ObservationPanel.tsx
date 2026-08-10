"use client";

export type StrategyObservation = {
  id: number;
  category: string;
  code: string;
  severity: "INFO" | "ADVISORY" | "IMPORTANT" | "CRITICAL";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  title: string;
  summary: string;
  why_it_matters: string;
  suggested_review: string | null;
  evidence: Record<string, unknown> | null;
  status: "ACTIVE" | "RESOLVED" | "DISMISSED";
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
};

const severityOrder: Record<StrategyObservation["severity"], number> = {
  CRITICAL: 4,
  IMPORTANT: 3,
  ADVISORY: 2,
  INFO: 1,
};

function severityClass(severity: StrategyObservation["severity"]) {
  if (severity === "CRITICAL") {
    return "border-red-300 bg-red-50 text-red-900";
  }
  if (severity === "IMPORTANT") {
    return "border-amber-300 bg-amber-50 text-amber-900";
  }
  if (severity === "ADVISORY") {
    return "border-blue-300 bg-blue-50 text-blue-900";
  }
  return "border-gray-300 bg-gray-50 text-gray-800";
}

export default function ObservationPanel({
  observations,
}: {
  observations: StrategyObservation[];
}) {
  const sorted = [...observations].sort((a, b) => {
    const severityDifference = severityOrder[b.severity] - severityOrder[a.severity];
    if (severityDifference !== 0) return severityDifference;
    return new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime();
  });

  return (
    <section className="mt-6 rounded-xl border border-gray-300 bg-white shadow-sm">
      <div className="flex flex-col gap-2 border-b border-gray-300 p-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">
            Observation Engine
          </p>
          <h2 className="mt-1 text-xl font-semibold">What changed that deserves attention?</h2>
          <p className="mt-1 text-sm text-gray-500">
            Deterministic observations generated from VOTE snapshots. VOTE advises; the trader decides.
          </p>
        </div>
        <span className="rounded-full border border-gray-300 px-3 py-1 text-xs font-semibold text-gray-600">
          {sorted.length} active
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="p-6 text-sm text-gray-500">
          No active observation currently crosses a VOTE review threshold. Refresh market data to create the next risk snapshot.
        </div>
      ) : (
        <div className="grid gap-4 p-6 xl:grid-cols-2">
          {sorted.map((observation) => (
            <article
              key={observation.id}
              className={`rounded-lg border p-5 ${severityClass(observation.severity)}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full border border-current/20 px-2.5 py-1 text-[11px] font-bold tracking-wide">
                    {observation.severity}
                  </span>
                  <span className="rounded-full border border-current/20 px-2.5 py-1 text-[11px] font-semibold">
                    {observation.category}
                  </span>
                </div>
                <span className="text-xs font-semibold opacity-70">
                  {observation.confidence} confidence
                </span>
              </div>

              <h3 className="mt-4 text-base font-bold">{observation.title}</h3>
              <p className="mt-2 text-sm leading-6">{observation.summary}</p>

              <div className="mt-4 rounded-md border border-current/15 bg-white/50 p-4">
                <p className="text-xs font-bold uppercase tracking-wide opacity-70">Why it matters</p>
                <p className="mt-1 text-sm leading-6">{observation.why_it_matters}</p>
              </div>

              {observation.suggested_review && (
                <div className="mt-3">
                  <p className="text-xs font-bold uppercase tracking-wide opacity-70">Suggested review</p>
                  <p className="mt-1 text-sm leading-6">{observation.suggested_review}</p>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs opacity-70">
                <span>Seen {observation.occurrence_count}×</span>
                <span>{new Date(observation.last_seen_at).toLocaleString("en-IN")}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
