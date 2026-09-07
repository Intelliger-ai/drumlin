import Link from "next/link";

// Negative case for the missing-state rules: fetches nothing, so it needs no
// loading or error boundary.
export default function HomePage() {
  return (
    <main>
      <h1>Overview</h1>
      <Link href="/invoices">Go to invoices</Link>
    </main>
  );
}
