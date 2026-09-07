import Link from "next/link";
import { Button } from "../../../components/ui/button";
import { approveInvoice, deleteInvoice } from "../actions";

// Async detail screen that does declare loading and error states.
// Negative case for the missing-state rules.
export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await fetch(`https://api.example.com/invoices/${id}`);
  const invoice = (await res.json()) as { id: string; vendor: string };

  return (
    <main>
      <h1>{invoice.vendor}</h1>

      <form action={approveInvoice}>
        <input type="hidden" name="id" value={invoice.id} />
        <Button type="submit">Approve</Button>
      </form>

      <form action={deleteInvoice}>
        <input type="hidden" name="id" value={invoice.id} />
        <Button type="submit" variant="destructive">
          Delete invoice
        </Button>
      </form>

      <Link href="/invoices">Back to invoices</Link>
    </main>
  );
}
