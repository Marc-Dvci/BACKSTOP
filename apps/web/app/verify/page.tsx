import { ReplayLab } from "./ReplayLab";

export const metadata = { title: "Verify a round · BACKSTOP", description: "Recompute a real inference audit in your browser, inspect the response commitments, and check its Monad anchor." };

export default function VerifyPage() {
  return <div style={{ padding: "36px 0" }}>
    <h1 style={{ fontFamily: "var(--mono)", fontSize: 26, margin: "0 0 12px" }}>Verify the evidence</h1>
    <p className="prose">Recompute a real Qwen3-1.7B audit on your device. Every reference proof, recorded response and arithmetic check runs in your browser.</p>
    <ReplayLab />
  </div>;
}
