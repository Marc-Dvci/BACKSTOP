import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";
import { handlers } from "./registration";
import "../src/handlers/EventHandlers";

const producer = "0x1234567890123456789012345678901234567890";
const zero = `0x${"00".repeat(32)}` as const;
const openAbi = parseAbi(["function openRound(uint256 versionId, uint32 round, bytes32 issuerShare, bytes32 beaconValue, uint32 scheduled)"]);

function store() {
  const rows = new Map<string, any>();
  return { get: async (id: string) => rows.get(id), set: (row: any) => rows.set(row.id, row) };
}
function setup() {
  const context: any = {};
  for (const name of ["Endpoint", "ProtocolIndex", "Round", "Producer", "ExecutionTicket", "Policy", "Pool"])
    context[name] = store();
  context.Endpoint.set({ id: "6", versionLogRay: 0n, scheduledTotal: 0, voidedTotal: 0, missingScheduledRounds: 0, inWarningRegion: false, crossed: false });
  const emit = async (eventName: string, params: any, input?: string) => {
    await handlers.get(eventName)!({ context, event: { params, block: { timestamp: 1234 }, transaction: { input } } });
  };
  const open = (input = encodeFunctionData({ abi: openAbi, functionName: "openRound", args: [6n, 0, zero, zero, 768] })) =>
    emit("AuditRegistry.RoundOpened", { versionId: 6n, round: 0, seed: zero }, input);
  return { context, emit, open };
}

describe("derived index event accounting", () => {
  it("uses the version's own boundary and schedule for CRE or proxy openings", async () => {
    const { context, emit, open } = setup();
    await emit("AttestationRegistry.VersionConfigured", { versionId: 6n, boundaryRay: 1000n, scheduledPerRound: 768 });
    await open("0xdeadbeef");
    await emit("AuditRegistry.RoundClosed", { versionId: 6n, round: 0, warning: false, versionCrossed: false, eRoundRay: 1n, cumLogRay: 500n });
    const row = await context.Endpoint.get("6");
    expect(row.scheduledTotal).toBe(768);
    expect(row.distanceBps).toBe(5000);
    expect(row.missingScheduledRounds).toBe(0);
  });

  it("leaves the distance unavailable when the historical boundary is unknown", async () => {
    const { context, emit, open } = setup();
    await open();
    await emit("AuditRegistry.RoundClosed", { versionId: 6n, round: 0, warning: false, versionCrossed: false, eRoundRay: 1n, cumLogRay: 500n });
    expect((await context.Endpoint.get("6")).distanceBps).toBeUndefined();
  });

  it("does not display a zero void rate when part of the denominator is missing", async () => {
    const { context, emit, open } = setup();
    await open("0xdeadbeef");
    await emit("AuditRegistry.RoundSealed", { versionId: 6n, round: 0, transcriptRoot: zero, voided: 96 });
    expect((await context.Endpoint.get("6")).voidRateBps).toBeUndefined();
    await emit("AuditRegistry.RoundScheduled", { versionId: 6n, round: 0, scheduled: 768 });
    expect((await context.Endpoint.get("6")).voidRateBps).toBe(1250);
    expect((await context.Endpoint.get("6")).missingScheduledRounds).toBe(0);
  });

  it("reconciles an authoritative count without counting the same schedule twice", async () => {
    const { context, emit, open } = setup();
    await open();
    await emit("AuditRegistry.RoundScheduled", { versionId: 6n, round: 0, scheduled: 768 });
    await emit("AuditRegistry.RoundScheduled", { versionId: 6n, round: 0, scheduled: 768 });
    expect((await context.ProtocolIndex.get("index")).totalScheduledExecutions).toBe(768);
  });

  it("refuses calldata belonging to a different version or round", async () => {
    const { context, open } = setup();
    await open(encodeFunctionData({ abi: openAbi, functionName: "openRound", args: [7n, 1, zero, zero, 999] }));
    expect((await context.Round.get("6-0")).scheduledKnown).toBe(false);
    expect((await context.Endpoint.get("6")).missingScheduledRounds).toBe(1);
  });
  it("decodes real ABI calldata and counts scheduled executions at round opening", async () => {
    const { context, open } = setup();
    await open();
    expect((await context.Round.get("6-0")).scheduled).toBe(768);
    expect((await context.Endpoint.get("6")).scheduledTotal).toBe(768);
    expect((await context.ProtocolIndex.get("index")).totalScheduledExecutions).toBe(768);
  });

  it("ignores proxy, malformed and out-of-range calldata rather than inventing a denominator", async () => {
    for (const input of ["0xdeadbeef", `0x1cd8c331${"0".repeat(256)}${"g".repeat(64)}`, `0x1cd8c331${"0".repeat(256)}${"f".repeat(64)}`]) {
      const { context, open } = setup();
      await open(input);
      expect((await context.Round.get("6-0")).scheduled).toBe(0);
    }
  });

  it("counts authoritative voids at sealing", async () => {
    const { context, emit, open } = setup();
    await open();
    await emit("AuditRegistry.RoundSealed", { versionId: 6n, round: 0, transcriptRoot: zero, voided: 96 });
    expect((await context.Endpoint.get("6")).voidRateBps).toBe(1250);
    expect((await context.ProtocolIndex.get("index")).totalVoidedExecutions).toBe(96);
  });

  it("joins published tickets to producer and round without counting executions again", async () => {
    const { context, emit, open } = setup();
    await open();
    await emit("TicketRegistry.ProducerRegistered", { producer, bond: 100n });
    const reservation = { ticket: zero, producer, versionId: 6n, round: 0 };
    await emit("TicketRegistry.TicketReserved", reservation);
    await emit("TicketRegistry.TicketReserved", reservation);
    await emit("TicketRegistry.TicketPublished", { ticket: zero });
    await emit("TicketRegistry.TicketPublished", { ticket: zero });
    expect((await context.Producer.get(producer)).ticketsReserved).toBe(1);
    expect((await context.Producer.get(producer)).ticketsPublished).toBe(1);
    expect((await context.Round.get("6-0")).ticketsPublished).toBe(1);
    expect((await context.ProtocolIndex.get("index")).totalScheduledExecutions).toBe(768);
  });

  it("records a void once, updates its round and preserves the authoritative aggregate", async () => {
    const { context, emit, open } = setup();
    await open();
    await emit("TicketRegistry.ProducerRegistered", { producer, bond: 100n });
    await emit("TicketRegistry.TicketReserved", { ticket: zero, producer, versionId: 6n, round: 0 });
    await emit("TicketRegistry.TicketVoided", { ticket: zero, producer });
    await emit("TicketRegistry.TicketVoided", { ticket: zero, producer });
    expect((await context.Producer.get(producer)).ticketsVoided).toBe(1);
    expect((await context.Round.get("6-0")).ticketsVoided).toBe(1);
    expect((await context.ProtocolIndex.get("index")).totalVoidedExecutions).toBe(0);
  });

  it("removes endpoints from the warning count when they leave the warning region", async () => {
    const { context, emit, open } = setup();
    await open();
    for (const [round, warning] of [[0, true], [1, true], [2, false]] as const)
      await emit("AuditRegistry.RoundClosed", { versionId: 6n, round, warning, versionCrossed: false, eRoundRay: 1n, cumLogRay: 1n });
    expect((await context.ProtocolIndex.get("index")).endpointsInWarning).toBe(0);
    expect((await context.ProtocolIndex.get("index")).roundsClosed).toBe(3);
  });
});
