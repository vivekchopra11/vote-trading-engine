"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Stock = {
  id: number;
  symbol: string;
  company_name: string;
  sector: string | null;
};

export default function Home() {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [search, setSearch] = useState("");
  const [selectedSector, setSelectedSector] = useState("All");
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    async function loadStocks() {
      setLoading(true);
      setErrorMessage("");

      const { data, error } = await supabase
        .from("stocks")
        .select("id, symbol, company_name, sector")
        .order("symbol");

      if (error) {
        setErrorMessage(error.message);
        setLoading(false);
        return;
      }

      setStocks(data ?? []);
      setLoading(false);
    }

    loadStocks();
  }, []);

  const sectors = useMemo(() => {
    const uniqueSectors = Array.from(
      new Set(
        stocks
          .map((stock) => stock.sector)
          .filter((sector): sector is string => Boolean(sector)),
      ),
    ).sort();

    return ["All", ...uniqueSectors];
  }, [stocks]);

  const filteredStocks = useMemo(() => {
    const searchText = search.trim().toLowerCase();

    return stocks.filter((stock) => {
      const matchesSearch =
        stock.symbol.toLowerCase().includes(searchText) ||
        stock.company_name.toLowerCase().includes(searchText);

      const matchesSector =
        selectedSector === "All" || stock.sector === selectedSector;

      return matchesSearch && matchesSector;
    });
  }, [stocks, search, selectedSector]);

  return (
    <main className="min-h-screen bg-white p-6 text-gray-950 md:p-10">
      <div className="mx-auto max-w-7xl">
        <header>
          <h1 className="text-4xl font-bold">VOTE</h1>

          <p className="mt-2 text-gray-600">
            Vivek Options Trading Engine
          </p>
        </header>

        <section className="mt-10 rounded-lg border border-gray-300 p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-2xl font-semibold">Universe</h2>

              <p className="mt-2 text-gray-500">
                Your active trading and research universe
              </p>
            </div>

            <div className="text-left md:text-right">
              <p className="text-sm text-gray-500">Stocks displayed</p>

              <p className="text-2xl font-semibold">
                {filteredStocks.length}
              </p>
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-3 md:flex-row">
            <input
              type="text"
              placeholder="Search symbol or company"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-full rounded border border-gray-300 px-4 py-3 outline-none focus:border-black"
            />

            <select
              value={selectedSector}
              onChange={(event) => setSelectedSector(event.target.value)}
              className="rounded border border-gray-300 px-4 py-3 outline-none focus:border-black md:w-64"
            >
              {sectors.map((sector) => (
                <option key={sector} value={sector}>
                  {sector}
                </option>
              ))}
            </select>
          </div>

          {loading && (
            <p className="mt-6 text-gray-500">Loading stocks...</p>
          )}

          {errorMessage && (
            <div className="mt-6 rounded border border-gray-400 p-4">
              <p className="font-semibold">Unable to load stocks</p>
              <p className="mt-1 text-sm text-gray-600">
                {errorMessage}
              </p>
            </div>
          )}

          {!loading && !errorMessage && (
            <div className="mt-6 overflow-x-auto rounded border border-gray-300">
              <table className="w-full min-w-[700px] text-left">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-3">Symbol</th>
                    <th className="p-3">Company</th>
                    <th className="p-3">Sector</th>
                  </tr>
                </thead>

                <tbody>
                  {filteredStocks.map((stock) => (
                    <tr
                      key={stock.id}
                      className="border-t border-gray-200 hover:bg-gray-50"
                    >
                      <td className="p-3 font-semibold">
                        <Link
                          href={`/stocks/${stock.symbol}`}
                          className="underline underline-offset-4"
                        >
                          {stock.symbol}
                        </Link>
                      </td>

                      <td className="p-3">
                        {stock.company_name}
                      </td>

                      <td className="p-3">
                        {stock.sector ?? "Not assigned"}
                      </td>
                    </tr>
                  ))}

                  {filteredStocks.length === 0 && (
                    <tr className="border-t border-gray-200">
                      <td
                        colSpan={3}
                        className="p-6 text-center text-gray-500"
                      >
                        No matching stocks found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}