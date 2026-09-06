import Link from "next/link";
import { notFound } from "next/navigation";
import { BuyForm } from "./BuyForm";
import { getEndpoint } from "@/lib/data";
import { deployment } from "@/lib/chain";
import { formatRay } from "@/lib/format";
import bench from "@/lib/bench.json";

export const revalidate = 30;

export default async function BuyPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const id = Number(versionId);
  const endpoint = await getEndpoint(id);
  if (!endpoint || !endpoint.settlementEligible) notFound();

  const alpha = Number(endpoint.alphaRay) / 1e27;

  // The measured power and delay curve, from the benchmark suite in the repository.
  const curve = bench.delay.find((d) => d.alpha === 0.05 && d.eps === 0.5) ?? bench.delay[0];

  return (
    <>
      <div style={{ padding: "36px 0 24px" }}>
        <Link href={`/endpoint/${id}`} style={{ color: "var(--text-faint)", fontFamily: "var(--mono)", fontSize: 12 }}>
          ← {endpoint.label}
        </Link>
        <h1 style={{ fontFamily: "var(--mono)", fontSize: 26, margin: "12px 0 8px" }}>Take coverage</h1>
        <p className="prose" style={{ margin: 0 }}>
          A policy fixes its endpoint, attestation version, notional, term, premium rate and seasoning
          length at inception and never reprices. It accumulates its own running product from
          inception plus {endpoint.seasoningRounds} seasoning rounds, and a crossing inside its term
          pays the notional in full.
        </p>
      </div>

      <BuyForm
        deployment={deployment()}
        versionId={id}
        endpointId={endpoint.endpointId}
        label={endpoint.label}
        alpha={alpha}
        seasoningRounds={endpoint.seasoningRounds}
        maxNotional="0"
        power={Number(curve?.power ?? 1)}
        medianDelayRounds={Number(curve?.medianDelay ?? 5)}
        departureRatePerYear={0.6}
      />

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <span className="panel-title">What the passkey signs</span>
        </div>
        <div className="panel-body prose" style={{ fontSize: 13 }}>
          <p>
            The assertion signs a digest that commits chain id, verifying contract, attestation
            version, policy version, buyer, notional, term, premium rate, seasoning, nonce and expiry.
            An assertion produced for one contract cannot authorise a policy on another, on another
            chain, or at another notional.
          </p>
          <p style={{ marginBottom: 0 }}>
            The contract verifies the whole ceremony on top of Monad&rsquo;s P256 precompile at{" "}
            <code>0x0100</code>: the signature covers{" "}
            <code>sha256(authenticatorData || sha256(clientDataJSON))</code>, the client data must
            declare <code>webauthn.get</code> and the registered origin, the challenge must equal the
            base64url of the digest, the authenticator must report user presence and user
            verification, the credential must be the one enrolled, and <code>s</code> must be in the
            lower half of the curve order.
          </p>
        </div>
      </div>
    </>
  );
}
