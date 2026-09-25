import live from "../../../../../attestations/live.json";

/**
 * The ERC-8004 agent card of the endpoint the live cadence audits.
 *
 * The endpoint is a provider in its own right, with its own key and its own agentId, because the
 * Reputation Registry refuses feedback an agent writes about itself. The auditor writes a
 * feedback entry against this agent after every live round; the card says what it serves and
 * which attestations it answers to.
 */
export const dynamic = "force-static";

export function GET() {
  const state = live as {
    provider: { address: string; agentId: string };
    versions?: Record<string, { versionId: number; attestation: string; label: string }>;
  };
  return Response.json(
    {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "BACKSTOP reference endpoint",
      description:
        "Qwen3-1.7B served by llama.cpp on a GitHub Actions runner, audited by the BACKSTOP auditor (agent 1824) against the envelope its attestations commit to. Every round is published with its transcripts.",
      image: "https://backstop-smoky.vercel.app/logo.png",
      services: [
        {
          name: "chat-completions",
          endpoint: "https://github.com/Marc-Dvci/BACKSTOP/blob/main/.github/workflows/live.yml",
          version: "openai-compatible",
        },
      ],
      registrations: [
        {
          agentRegistry: "eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e",
          agentId: Number(state.provider.agentId),
        },
      ],
      supportedTrust: ["reputation"],
      attestations: Object.values(state.versions ?? {}).map((v) => ({
        version: v.versionId,
        label: v.label,
        document: `https://github.com/Marc-Dvci/BACKSTOP/blob/main/${v.attestation}`,
      })),
      auditor: { agentId: 1824, card: "https://backstop-smoky.vercel.app/agent.json" },
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
