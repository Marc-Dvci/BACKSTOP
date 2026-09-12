import type { Metadata } from "next";
import Link from "next/link";
import { Providers } from "@/components/Providers";
import { TopBarWallet } from "@/components/TopBarWallet";
import "./globals.css";

export const metadata: Metadata = {
  title: "BACKSTOP",
  description:
    "Capital-backed verification for hosted AI inference. Continuous statistical proof that an endpoint still serves what it claims, with a payout attached.",
  openGraph: {
    title: "BACKSTOP",
    description:
      "Black-box detection of model substitution is practical. BACKSTOP attaches economic consequence to it.",
  },
};

const NAV = [
  { href: "/", label: "index" },
  { href: "/pool", label: "pool" },
  { href: "/protocol", label: "protocol" },
  { href: "/method", label: "method" },
  { href: "/vault", label: "vault" },
  { href: "/docs", label: "docs" },
  { href: "/judges", label: "start here" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand">
              <span className="dot" />
              BACKSTOP
            </Link>
            <nav className="nav">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href}>
                  {n.label}
                </Link>
              ))}
            </nav>
            <span className="spacer" />
            <TopBarWallet enabled={Boolean(process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID)} />
          </div>
        </header>
        <main className="shell">{children}</main>
        <footer className="shell" style={{ paddingTop: 0, paddingBottom: 40 }}>
          <div className="hr" />
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 12, color: "var(--text-faint)" }}>
            <span>Testnet only. No real premium is charged and no underwriter is solicited.</span>
            <span className="spacer" />
            <a href="https://github.com/Marc-Dvci/BACKSTOP">repository</a>
          </div>
        </footer>
        </Providers>
      </body>
    </html>
  );
}
