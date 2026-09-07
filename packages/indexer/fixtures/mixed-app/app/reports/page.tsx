import Link from "next/link";

// Positive case for `flow.orphan`: nothing anywhere links to /reports, so the
// screen exists but cannot be reached from an entry point.
export default async function ReportsPage() {
  const res = await fetch("https://api.example.com/reports");
  const reports = (await res.json()) as Array<{ id: string; name: string }>;

  return (
    <main>
      <h1>Reports</h1>
      <ul>
        {reports.map((report) => (
          <li key={report.id}>
            <Link href="/invoices">{report.name}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
