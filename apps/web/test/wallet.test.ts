import { describe, expect, it, vi } from "vitest";
import type { WalletClient } from "viem";
import { ensureChain } from "../components/wallet";

function wallet(chain = 1) {
  return { getChainId: vi.fn().mockResolvedValue(chain), switchChain: vi.fn().mockResolvedValue(undefined),
    addChain: vi.fn().mockResolvedValue(undefined) };
}
describe("network selection", () => {
  it("does not prompt when already on Monad", async () => {
    const client = wallet(10143);
    await ensureChain(client as unknown as WalletClient);
    expect(client.switchChain).not.toHaveBeenCalled();
  });
  it("switches directly when the network is known", async () => {
    const client = wallet();
    await ensureChain(client as unknown as WalletClient);
    expect(client.switchChain).toHaveBeenCalledTimes(1);
    expect(client.addChain).not.toHaveBeenCalled();
  });
  it("honours a rejected switch without opening an add-network prompt", async () => {
    const client = wallet();
    const error = { code: 4001, message: "User rejected" };
    client.switchChain.mockRejectedValueOnce(error);
    await expect(ensureChain(client as unknown as WalletClient)).rejects.toBe(error);
    expect(client.addChain).not.toHaveBeenCalled();
  });
  it("adds an unknown network even when viem wraps the provider error", async () => {
    const client = wallet();
    client.switchChain.mockRejectedValueOnce({ cause: { cause: { code: 4902 } } });
    await ensureChain(client as unknown as WalletClient);
    expect(client.addChain).toHaveBeenCalledTimes(1);
    expect(client.switchChain).toHaveBeenCalledTimes(2);
  });
  it("stops if the user rejects adding the network", async () => {
    const client = wallet();
    client.switchChain.mockRejectedValueOnce({ code: 4902 });
    client.addChain.mockRejectedValueOnce({ code: 4001 });
    await expect(ensureChain(client as unknown as WalletClient)).rejects.toEqual({ code: 4001 });
    expect(client.switchChain).toHaveBeenCalledTimes(1);
  });
});
