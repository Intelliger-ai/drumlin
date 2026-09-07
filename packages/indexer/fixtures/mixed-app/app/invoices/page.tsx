import Link from "next/link";
import { Select, SelectItem } from "../../components/ui/select";

// Async list screen with no loading.tsx and no error.tsx in this segment.
// Positive case for `state.route.no-loading` and `state.route.no-error`.
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; region?: string; page?: string }>;
}) {
  const filters = await searchParams;
  const res = await fetch(
    `https://api.example.com/invoices?status=${filters.status ?? "all"}`,
  );
  const invoices = (await res.json()) as Array<{ id: string; vendor: string }>;

  return (
    <main>
      <h1>Invoices</h1>

      {/* Positive case for `component.select-overload`: bound to an unbounded
          collection rather than a searchable control. */}
      <Select name="vendor">
        {invoices.map((invoice) => (
          <SelectItem key={invoice.id} value={invoice.id}>
            {invoice.vendor}
          </SelectItem>
        ))}
      </Select>

      <ul>
        {invoices.map((invoice) => (
          <li key={invoice.id}>
            {/* Positive case for `context.navigation.drops-search-params`:
                leaves a filtered list without carrying status/region/page. */}
            <Link href={`/invoices/${invoice.id}`}>{invoice.vendor}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
