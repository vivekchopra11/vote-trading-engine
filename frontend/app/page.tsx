import Link from "next/link";

const positions = [
  {
    stock: "HDFCBANK",
    strategy: "Short Put",
    expiry: "27 Aug 2026",
    quantity: 550,
    entryPremium: 42,
    currentPremium: 28,
    mtm: 7700,
    status: "Profit",
  },
  {
    stock: "BPCL",
    strategy: "Short Strangle",
    expiry: "27 Aug 2026",
    quantity: 1800,
    entryPremium: 31,
    currentPremium: 35,
    mtm: -7200,
    status: "Loss",
  },
  {
    stock: "ONGC",
    strategy: "Short Call",
    expiry: "27 Aug 2026",
    quantity: 2250,
    entryPremium: 18,
    currentPremium: 13,
    mtm: 11250,
    status: "Profit",
  },
];

export default function Home() {
  const totalMtm = positions.reduce(
    (total, position) => total + position.mtm,
    0,
  );

  return (
    <main className="min-h-screen bg-white p-6 text-gray-950 md:p-10">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-col gap-5 border-b border-gray-300 pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-4xl font-bold">VOTE</h1>

            <p className="mt-2 text-gray-600">
              Vivek Options Trading Engine
            </p>
          </div>

          <nav className="flex flex-wrap gap-5 text-sm font-semibold">
            <Link href="/">Dashboard</Link>
            <Link href="/universe">Universe</Link>
            <Link href="/strategies">Strategies</Link>
            <Link href="/portfolio">Portfolio</Link>
            <Link href="/journal">Journal</Link>
          </nav>
        </header>

        <section className="mt-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-2xl font-semibold">
              Position Dashboard
            </h2>

            <p className="mt-2 text-gray-500">
              Summary of your manually entered open strategies
            </p>
          </div>

          <Link
            href="/strategies/new"
            className="inline-flex items-center justify-center rounded bg-black px-5 py-3 font-semibold text-white"
          >
            + New Strategy
          </Link>
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-gray-300 p-5">
            <p className="text-sm text-gray-500">Current MTM</p>

            <p className="mt-2 text-2xl font-semibold">
              {totalMtm >= 0 ? "+" : "-"}₹
              {Math.abs(totalMtm).toLocaleString("en-IN")}
            </p>
          </div>

          <div className="rounded-lg border border-gray-300 p-5">
            <p className="text-sm text-gray-500">Open strategies</p>

            <p className="mt-2 text-2xl font-semibold">
              {positions.length}
            </p>
          </div>

          <div className="rounded-lg border border-gray-300 p-5">
            <p className="text-sm text-gray-500">
              Stocks with exposure
            </p>

            <p className="mt-2 text-2xl font-semibold">
              {new Set(positions.map((position) => position.stock)).size}
            </p>
          </div>
        </section>

        <section className="mt-8 overflow-x-auto rounded-lg border border-gray-300">
          <table className="w-full min-w-[900px] text-left">
            <thead className="bg-gray-100">
              <tr>
                <th className="p-3">Stock</th>
                <th className="p-3">Strategy</th>
                <th className="p-3">Expiry</th>
                <th className="p-3 text-right">Quantity</th>
                <th className="p-3 text-right">Entry premium</th>
                <th className="p-3 text-right">Current premium</th>
                <th className="p-3 text-right">MTM</th>
                <th className="p-3">Status</th>
              </tr>
            </thead>

            <tbody>
              {positions.map((position) => (
                <tr
                  key={`${position.stock}-${position.strategy}`}
                  className="border-t border-gray-200"
                >
                  <td className="p-3 font-semibold">
                    {position.stock}
                  </td>

                  <td className="p-3">
                    {position.strategy}
                  </td>

                  <td className="p-3">
                    {position.expiry}
                  </td>

                  <td className="p-3 text-right">
                    {position.quantity.toLocaleString("en-IN")}
                  </td>

                  <td className="p-3 text-right">
                    ₹{position.entryPremium.toFixed(2)}
                  </td>

                  <td className="p-3 text-right">
                    ₹{position.currentPremium.toFixed(2)}
                  </td>

                  <td className="p-3 text-right font-semibold">
                    {position.mtm >= 0 ? "+" : "-"}₹
                    {Math.abs(position.mtm).toLocaleString("en-IN")}
                  </td>

                  <td className="p-3">
                    <span className="rounded border border-gray-400 px-2 py-1 text-sm">
                      {position.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <p className="mt-4 text-sm text-gray-500">
          Sample positions are still shown. We will connect this dashboard
          to your real strategy and position tables next.
        </p>
      </div>
    </main>
  );
}