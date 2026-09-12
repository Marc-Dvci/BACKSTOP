import agentCard from "../../../../agent.json";

/**
 * The ERC-8004 agent card, served from the deployed product.
 *
 * The identity registry holds a URI, and whatever that URI returns is what a reader of the
 * registry sees. Pointing it at a source-control raw URL makes the card's availability
 * depend on repository visibility; pointing it here makes it depend on the same deployment
 * the registry entry is describing. The file itself stays at the repository root, so the
 * card, the README and the contract addresses have one source.
 */
export const dynamic = "force-static";

export function GET() {
  return Response.json(agentCard, {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "application/json",
    },
  });
}
