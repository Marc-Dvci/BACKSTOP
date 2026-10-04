import { describe, expect, it } from "vitest";
import { credentialKey } from "../src/passkey.js";

describe("WebAuthn credential registry key", () => {
  it.each([16, 32, 64, 256])("accepts a %i-byte credential while producing bytes32", (size) => {
    const id = new Uint8Array(size).fill(42).buffer;
    expect(credentialKey(id)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(credentialKey(id)).toBe(credentialKey(id.slice(0)));
  });
  it("keeps different credentials distinct", () => {
    expect(credentialKey(new Uint8Array([1]).buffer)).not.toBe(credentialKey(new Uint8Array([2]).buffer));
  });
});
