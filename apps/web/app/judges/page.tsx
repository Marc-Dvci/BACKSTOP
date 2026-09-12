import Link from "next/link";
import { Faucet } from "./Faucet";
import { deployment } from "@/lib/chain";
import { getEndpoints } from "@/lib/data";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Start here · BACKSTOP" };

const CONTRACTS: { label: string; key: keyof ReturnType<typeof deployment> }[] = [
  { label: "AttestationRegistry", key: "attestationRegistry" },
  { label: "AuditRegistry", key: "auditRegistry" },
  { label: "CoveragePool", key: "coveragePool" },
  { label: "PolicyRegistry", key: "policyRegistry" },
  { label: "Settlement", key: "settlement" },
  { label: "TicketRegistry", key: "ticketRegistry" },
  { label: "Settlement asset (bUSDC)", key: "asset" },
];

export default async function JudgesPage() {
  const d = deployment();
  const endpoints = await getEndpoints();
  const crossed = endpoints.find((e) => e.versionLogRay >= e.boundaryRay && e.boundaryRay > 0n);
  const control = endpoints.find((e) => e.settlementEligible && e !== crossed);

  return (
    <div style={{ padding: "36px 0" }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 26, margin: "0 0 10px" }}>Start here</h1>
      <p className="prose" style={{ marginBottom: 26 }}>
        Everything below is live on Monad testnet. No login, no credentials, nothing to install.
        The two steps that need a wallet are optional; every page reads without one.
      </p>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Two minutes, no wallet</span>
        </div>
        <div className="panel-body prose" style={{ fontSize: 13.5 }}>
          <ol style={{ paddingLeft: 20, marginBottom: 0 }}>
            <li>
              <Link href={`/endpoint/${crossed?.versionId ?? 1}`}>
                Open the endpoint that departed
              </Link>
              . One graph carries the whole result: the audited endpoint climbing to a boundary
              fixed on chain before round 0, and{" "}
              {control ? "a control endpoint that never departs" : "a control endpoint"} flat beside
              it on the same axes.
            </li>
            <li>
              <Link href="/method">Read the method</Link>. Every number there was produced by the
              code in the repository, and each section names the command that regenerates it.
            </li>
            <li>
              <Link href="/pool">Look at the pool</Link>. Maximum outstanding liability is fully
              collateralised at all times, and the invariants are listed with the fuzz suite that
              holds them.
            </li>
            <li>
              <Link href="/vault">Try the claim vault</Link>. One passkey, three namespaces, none
              of them a wallet. Open it in a second browser profile with the same passkey and the
              derived keys reproduce.
            </li>
            <li>
              <Link href="/protocol">Read the protocol index</Link>. Realised loss ratio, mean
              detection delay and void rate, folded out of the event stream by the self-hosted
              indexer rather than read from a storage slot. The page prints the GraphQL document
              that produced it.
            </li>
          </ol>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Drive it yourself</span>
        </div>
        <div className="panel-body">
          <p className="prose" style={{ fontSize: 13.5, marginBottom: 16 }}>
            The settlement asset is freely mintable on testnet, so you can fund yourself and buy
            real coverage. Gas comes from the Monad faucet.
          </p>
          <Faucet deployment={d} />
          <p className="prose" style={{ fontSize: 13.5, marginTop: 18, marginBottom: 0 }}>
            Then{" "}
            <Link href={`/buy/${control?.versionId ?? crossed?.versionId ?? 1}`}>take coverage</Link>:
            enrol a passkey, and sign a domain-bound policy digest with it. The assertion is
            verified on chain by Monad&rsquo;s P256 precompile inside the full WebAuthn ceremony, so
            what authorises the policy is the device you already carry.
          </p>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Verify it without trusting the page</span>
        </div>
        <div className="panel-body prose" style={{ fontSize: 13.5 }}>
          <pre>
            <code>{`git clone https://github.com/Marc-Dvci/BACKSTOP && cd BACKSTOP
make install
make test        # 64 contract tests, 7 invariants, the differential suite
make ci-audit    # the CLI catching a substitution, no chain and no key needed
make demo        # the whole protocol end to end on a local chain
make gate-zero   # the lifetime Type-I bound, measured
make replay      # recompute a verdict published on this testnet, from its record
make indexer     # the self-hosted index over this deployment, GraphQL on :8080`}</code>
          </pre>
          <p>
            <code>make replay</code> is the one to run if you only run one. It exports the round
            that crossed on this testnet, refuses to write unless the E(t) it recomputes equals
            the one the AuditRegistry holds, and then checks the seed chain, the cell selection
            and every Merkle proof in the revealed calibration slice against the pool root fixed
            at issuance.
          </p>
          <p>
            <code>make ci-audit</code> is the one that needs nothing at all: no chain, no API key
            and no GPU. It serves the probe battery from the laws measured off a real open-weight
            model, runs the published CLI against it at the attested precision and at the
            substituted one, and asserts both verdicts. The substitution crosses at round 2, which
            is where the live llama.cpp run crossed too.
          </p>
          <p style={{ marginBottom: 0 }}>
            <code>make demo</code> stands up a chain with Monad&rsquo;s P256 precompile at{" "}
            <code>0x0100</code>, deploys the six contracts, buys policies with real passkey
            assertions, runs the audit over behaviour measured from a real open-weight model at two
            quantisations, switches the endpoint partway through, and settles the cohort in one
            transaction.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Deployed on Monad testnet</span>
          <span className="spacer" />
          <span className="hint">chain 10143</span>
        </div>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Address</th>
              </tr>
            </thead>
            <tbody>
              {CONTRACTS.map((c) => (
                <tr key={c.key}>
                  <td>{c.label}</td>
                  <td>
                    <a
                      href={`https://testnet.monadexplorer.com/address/${d[c.key]}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--cyan)" }}
                    >
                      {String(d[c.key])}
                    </a>
                  </td>
                </tr>
              ))}
              <tr>
                <td>ERC-8004 auditor</td>
                <td>
                  <a
                    href="https://testnet.monadexplorer.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e"
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--cyan)" }}
                  >
                    agentId 1824 in the Identity Registry
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
