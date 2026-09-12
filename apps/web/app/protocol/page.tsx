import { IndexPanel } from "./IndexPanel";
import { INDEXER_URL, INDEX_QUERY } from "@/lib/indexer";

export const metadata = { title: "Protocol index · BACKSTOP" };

/**
 * The history the chain cannot answer.
 *
 * Every other page in this product reads contract state directly, because current state is
 * what a contract is good at. This page reads the Envio index, because everything on it is a
 * fold over the event stream: a realised loss ratio needs every settlement, a mean detection
 * delay needs every crossing measured against the policy that was live at the time, a void
 * rate needs every scheduled execution ever attempted. None of those is a storage slot.
 *
 * The read itself happens in the browser. See `IndexPanel`.
 */
export default function ProtocolPage() {
  return (
    <div style={{ padding: "36px 0" }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 26, margin: "0 0 10px" }}>Protocol index</h1>
      <p className="prose" style={{ marginBottom: 26 }}>
        Realised protocol history, served by the BACKSTOP indexer over the six deployed contracts.
        Current state is read straight from Monad everywhere else in this product. What is here is
        what a contract cannot answer: the loss ratio the underwriting side actually realised, how
        many rounds passed between a departure and the crossing that paid for it, and how often the
        evidence layer voided.
      </p>

      <IndexPanel />

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <span className="panel-title">The query behind this page</span>
        </div>
        <div className="panel-body">
          <p className="prose" style={{ fontSize: 13, marginBottom: 12 }}>
            One document, one round trip. Paste it into the GraphQL console at{" "}
            <code>{INDEXER_URL.replace(/\/v1\/graphql$/, "")}</code> to get exactly what rendered
            above.
          </p>
          <pre className="scroll-x" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            <code>{INDEX_QUERY}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
