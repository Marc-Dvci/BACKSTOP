import type { Metadata } from "next";
import Link from "next/link";
import { Providers } from "@/components/Providers";
import { TopBarWallet } from "@/components/TopBarWallet";
import "./globals.css";

export const metadata: Metadata = {
  title: "BACKSTOP",
  description:
    "Detect changes in hosted AI inference, replay the evidence, and explore passkey-authorised testnet coverage on Monad.",
  metadataBase: new URL("https://backstop-smoky.vercel.app"),
  icons: { icon: "/favicon.png" },
  openGraph: {
    title: "BACKSTOP",
    description:
      "Black-box detection of model substitution is practical. BACKSTOP attaches economic consequence to it.",
    images: [{ url: "/cover.png", width: 1600, height: 900, alt: "BACKSTOP: verifiable AI inference on Monad" }],
  },
};

const NAV = [
  { href: "/", label: "index" },
  { href: "/pool", label: "pool" },
  { href: "/protocol", label: "protocol" },
  { href: "/method", label: "method" },
  { href: "/verify", label: "verify" },
  { href: "/vault", label: "vault" },
  { href: "/docs", label: "docs" },
  { href: "/judges", label: "start here" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
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
        <main id="main-content" className="shell">{children}</main>
        <footer className="shell" style={{ paddingTop: 0, paddingBottom: 40 }}>
          <div className="hr" />
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 12, color: "var(--text-faint)" }}>
            <span>Monad testnet. Premiums and payouts use test bUSDC.</span>
            <span className="spacer" />
            <a href="https://github.com/Marc-Dvci/BACKSTOP">repository</a>
          </div>
        </footer>
        </Providers>
      </body>
    </html>
  );
}
