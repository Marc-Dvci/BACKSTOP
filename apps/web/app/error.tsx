"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return <section style={{ padding: "48px 0" }} role="alert">
    <h1>Live data is temporarily unavailable</h1>
    <p className="prose">The page could not finish reading Monad. You can retry, or follow the published evidence and replay instructions.</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      <button className="btn btn-primary" onClick={reset}>Try again</button>
      <Link className="btn" href="/docs">Read the verification guide</Link>
      <a className="btn" href="https://github.com/Marc-Dvci/BACKSTOP/tree/live-data">Published round records</a>
    </div>
  </section>;
}
