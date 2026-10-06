import Link from "next/link";
import { listSuppliers } from "@/lib/db/repository";
import { bootstrap } from "@/lib/bootstrap";
import { requireSession } from "@/lib/auth/guard";
import { CATEGORY_LABEL, type Supplier } from "@/lib/domain/types";
import { formatMoney, formatPercent } from "@/lib/util";
import { Panel, PanelHeader, Pill, ScoreBar, StatCard } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  await requireSession("/suppliers");
  await bootstrap();
  const suppliers = listSuppliers();

  const avgOnTime =
    suppliers.length === 0
      ? 0
      : suppliers.reduce((total, supplier) => total + supplier.onTimeRate, 0) /
        suppliers.length;
  const certified = suppliers.filter(
    (supplier) => supplier.certifications.includes("ISO 9001"),
  ).length;
  const local = suppliers.filter(
    (supplier) => supplier.country === "South Africa",
  ).length;

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Supplier panel</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-300">
          The Supplier Agent searches this panel. Every supplier here is scored
          on fit, price, lead time, certifications and risk before it is ever
          asked for a quotation.
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Suppliers" value={String(suppliers.length)} sub="in the panel" />
        <StatCard
          label="Average on-time"
          value={formatPercent(avgOnTime * 100, 0)}
          sub="delivery performance"
          tone="gain"
        />
        <StatCard
          label="ISO 9001 certified"
          value={String(certified)}
          sub={`${local} based in South Africa`}
        />
        <StatCard
          label="Distressed suppliers"
          value={String(
            suppliers.filter((supplier) => supplier.financialHealth === "distressed")
              .length,
          )}
          sub="flagged by the Risk Agent when relevant"
          tone="brand"
        />
      </section>

      <Panel>
        <PanelHeader
          title="All suppliers"
          hint="Scored the same way on every request, so the comparison is defensible"
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
                <th className="px-5 py-2.5 font-medium">Supplier</th>
                <th className="px-5 py-2.5 font-medium">Categories</th>
                <th className="px-5 py-2.5 font-medium">Certifications</th>
                <th className="px-5 py-2.5 text-right font-medium">On time</th>
                <th className="px-5 py-2.5 text-right font-medium">Quality</th>
                <th className="px-5 py-2.5 text-right font-medium">Min order</th>
                <th className="px-5 py-2.5 font-medium">Financial</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {suppliers.map((supplier) => (
                <SupplierRow key={supplier.id} supplier={supplier} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <p className="text-xs text-ink-500">
        Looking for a specific request?{" "}
        <Link href="/" className="text-brand-400 hover:underline">
          Back to the dashboard
        </Link>
        .
      </p>
    </div>
  );
}

function SupplierRow({ supplier }: { supplier: Supplier }) {
  return (
    <tr className="transition hover:bg-ink-800/40">
      <td className="px-5 py-3">
        <span className="block font-medium text-ink-100">{supplier.name}</span>
        <span className="block text-xs text-ink-400">
          {supplier.city ? `${supplier.city}, ` : ""}
          {supplier.country} · {supplier.yearsInBusiness} yrs ·{" "}
          {formatPercent(supplier.responseRate * 100, 0)} response
        </span>
      </td>
      <td className="px-5 py-3">
        <div className="flex max-w-56 flex-wrap gap-1">
          {supplier.categories.map((category) => (
            <Pill key={category}>{CATEGORY_LABEL[category]}</Pill>
          ))}
        </div>
      </td>
      <td className="px-5 py-3">
        <div className="flex max-w-48 flex-wrap gap-1">
          {supplier.certifications.length === 0 ? (
            <span className="text-xs text-risk-500">none on file</span>
          ) : (
            supplier.certifications.map((cert) => (
              <Pill key={cert} tone="brand">
                {cert}
              </Pill>
            ))
          )}
        </div>
      </td>
      <td className="px-5 py-3 text-right">
        <div className="ml-auto w-20">
          <ScoreBar
            value={supplier.onTimeRate * 100}
            tone={
              supplier.onTimeRate >= 0.95
                ? "gain"
                : supplier.onTimeRate >= 0.85
                  ? "warn"
                  : "risk"
            }
          />
          <span className="mt-1 block font-mono text-[11px] text-ink-400">
            {formatPercent(supplier.onTimeRate * 100, 0)}
          </span>
        </div>
      </td>
      <td className="px-5 py-3 text-right">
        <div className="ml-auto w-20">
          <ScoreBar value={supplier.qualityScore * 100} />
          <span className="mt-1 block font-mono text-[11px] text-ink-400">
            {formatPercent(supplier.qualityScore * 100, 0)}
          </span>
        </div>
      </td>
      <td className="px-5 py-3 text-right font-mono text-xs text-ink-300">
        {formatMoney(supplier.minOrderValue, supplier.currency)}
      </td>
      <td className="px-5 py-3">
        <Pill
          tone={
            supplier.financialHealth === "strong"
              ? "gain"
              : supplier.financialHealth === "stable"
                ? "brand"
                : supplier.financialHealth === "watch"
                  ? "warn"
                  : "risk"
          }
        >
          {supplier.financialHealth}
        </Pill>
      </td>
    </tr>
  );
}
