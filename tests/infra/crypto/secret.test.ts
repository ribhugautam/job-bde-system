import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EncryptionUnavailableError,
  decryptSecret,
  encryptSecret,
  encryptionConfigured,
} from "@/lib/infra/crypto/secret";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = KEY_A;
});

afterEach(() => {
  if (saved === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = saved;
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a value", async () => {
    const stored = await encryptSecret("abcd efgh ijkl mnop");
    expect(await decryptSecret(stored)).toBe("abcd efgh ijkl mnop");
  });

  it("never stores the plaintext", async () => {
    const stored = await encryptSecret("hunter2-app-password");
    expect(stored).not.toContain("hunter2");
    expect(stored.startsWith("v1.")).toBe(true);
  });

  it("uses a fresh IV every time, so identical values look different", async () => {
    // A reused IV in GCM is catastrophic, and identical ciphertexts would also
    // leak which colleagues share a password.
    const a = await encryptSecret("same-password");
    const b = await encryptSecret("same-password");
    expect(a).not.toBe(b);
    expect(await decryptSecret(a)).toBe(await decryptSecret(b));
  });

  it("round-trips unicode and empty strings", async () => {
    expect(await decryptSecret(await encryptSecret("pässwörd–✓"))).toBe("pässwörd–✓");
    expect(await decryptSecret(await encryptSecret(""))).toBe("");
  });
});

describe("decryptSecret failure modes", () => {
  it("returns null when the key has changed, rather than throwing", async () => {
    // The realistic incident: somebody rotates ENCRYPTION_KEY. Every stored
    // mailbox becomes unreadable, and the correct behaviour is to treat those
    // mailboxes as unconfigured and queue drafts -- not to fail the whole run.
    const stored = await encryptSecret("app-password");
    process.env.ENCRYPTION_KEY = KEY_B;
    expect(await decryptSecret(stored)).toBeNull();
  });

  it("returns null for a tampered ciphertext", async () => {
    // GCM is authenticated: flipping a byte must be detected, not decrypted
    // into garbage that would then be handed to an SMTP server as a password.
    const stored = await encryptSecret("app-password");
    const [version, iv, data] = stored.split(".");
    const flipped = data.slice(0, -2) + (data.endsWith("00") ? "ff" : "00");
    expect(await decryptSecret(`${version}.${iv}.${flipped}`)).toBeNull();
  });

  it("returns null for a tampered IV", async () => {
    const stored = await encryptSecret("app-password");
    const [version, iv, data] = stored.split(".");
    const flipped = (iv.startsWith("0") ? "f" : "0") + iv.slice(1);
    expect(await decryptSecret(`${version}.${flipped}.${data}`)).toBeNull();
  });

  it("returns null for structurally invalid values without throwing", async () => {
    for (const bad of [
      "",
      "garbage",
      "v1.abc",
      "v1.abc.def.ghi",
      "v2.aabbccddeeff001122334455.aabb", // unknown version
      "v1.zz.aabb", // non-hex iv
      "v1.aabbccddeeff001122334455.zz", // non-hex data
      "v1.aabb.ccdd", // iv of the wrong length
    ]) {
      expect(await decryptSecret(bad), bad).toBeNull();
    }
  });
});

describe("without ENCRYPTION_KEY", () => {
  beforeEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it("reports itself as unconfigured", () => {
    expect(encryptionConfigured()).toBe(false);
  });

  it("refuses to encrypt rather than storing anything in plaintext", async () => {
    await expect(encryptSecret("secret")).rejects.toBeInstanceOf(
      EncryptionUnavailableError
    );
  });

  it("returns null from decrypt rather than throwing", async () => {
    expect(await decryptSecret("v1.aabbccddeeff001122334455.aabb")).toBeNull();
  });

  it("rejects a key that is too short to be a real one", () => {
    process.env.ENCRYPTION_KEY = "tooshort";
    expect(encryptionConfigured()).toBe(false);
  });
});
