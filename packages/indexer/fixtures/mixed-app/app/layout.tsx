import Link from "next/link";
import * as React from "react";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Home</Link>
          <Link href="/invoices">Invoices</Link>
          <Link href="/settings">Settings</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
