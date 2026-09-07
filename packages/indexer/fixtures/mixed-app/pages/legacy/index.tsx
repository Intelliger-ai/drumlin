import Link from "next/link";

// Pages Router screen. Must land in the same IR as App Router screens so a
// rule never has to care which router produced a node.
export default function LegacyHome() {
  return (
    <main>
      <h1>Legacy console</h1>
      <Link href="/legacy/billing">Billing</Link>
    </main>
  );
}
