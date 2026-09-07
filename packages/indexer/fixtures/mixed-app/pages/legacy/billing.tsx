import { useRouter } from "next/router";

// Pages Router screen that fetches server-side. The Pages Router has no file
// convention for loading or error, so state completeness has to be inferred
// from the component rather than from the filesystem.
export async function getServerSideProps() {
  const res = await fetch("https://api.example.com/billing");
  return { props: { billing: await res.json() } };
}

export default function LegacyBilling({ billing }: { billing: unknown }) {
  const router = useRouter();
  return (
    <main>
      <h1>Billing</h1>
      <pre>{JSON.stringify(billing)}</pre>
      <button onClick={() => router.push("/invoices")}>Back to invoices</button>
    </main>
  );
}
