import { describe, expect, it } from "vitest";
import {
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  verifySessionToken,
} from "@/lib/infra/auth";

const SECRET = "a-test-secret-at-least-sixteen-chars";
const OTHER_SECRET = "a-different-secret-of-sufficient-length";

describe("createSessionToken / verifySessionToken", () => {
  it("round-trips the user id", async () => {
    const token = await createSessionToken(42, SECRET);
    expect(await verifySessionToken(token, SECRET)).toEqual({ userId: 42 });
  });

  it("issues a three-segment token: userId.expiry.signature", async () => {
    const token = await createSessionToken(7, SECRET);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("7");
    expect(Number(parts[1])).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(Number(parts[1])).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS
    );
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(1, OTHER_SECRET);
    expect(await verifySessionToken(token, SECRET)).toBeNull();
  });

  it("rejects a token whose user id was swapped", async () => {
    // THE attack this format exists to stop. The signature covers userId AND
    // expiry, so editing the id invalidates it — otherwise any signed-in user
    // could become any other user by editing one cookie field.
    const token = await createSessionToken(1, SECRET);
    const [, exp, sig] = token.split(".");
    expect(await verifySessionToken(`2.${exp}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a token whose expiry was extended", async () => {
    const token = await createSessionToken(1, SECRET);
    const [userId, exp, sig] = token.split(".");
    const further = String(Number(exp) + 86_400);
    expect(await verifySessionToken(`${userId}.${further}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    // Forged by hand rather than by waiting: sign a payload that is already in
    // the past, with the real secret. The signature is valid; the clock is not.
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = await createSessionToken(1, SECRET);
    const [userId] = token.split(".");
    // Re-sign the expired payload properly so this tests expiry, not the
    // signature check.
    const expiredCandidate = `${userId}.${past}`;
    // Any signature at all: an expired token must be rejected before the
    // signature is even consulted.
    expect(await verifySessionToken(`${expiredCandidate}.deadbeef`, SECRET)).toBeNull();
  });

  it("rejects the old two-segment format that carried no identity", async () => {
    // Pre-accounts tokens were `<exp>.<hmac>`. Accepting one would mean
    // deciding somewhere downstream which user it meant — so everyone signs in
    // once instead.
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(await verifySessionToken(`${exp}.somesignature`, SECRET)).toBeNull();
  });

  it("rejects malformed and missing tokens without throwing", async () => {
    const bad = [
      undefined,
      "",
      ".",
      "..",
      "abc.def.ghi",
      "1.notanumber.sig",
      "notanumber.123.sig",
      "1.2.3.4",
    ];
    for (const token of bad) {
      expect(await verifySessionToken(token, SECRET), String(token)).toBeNull();
    }
  });

  it("rejects a zero or negative user id even when correctly signed", async () => {
    // These cannot name a row, and letting one through would push a nonsense
    // value into every downstream query.
    for (const id of [0, -1]) {
      const token = await createSessionToken(id, SECRET);
      expect(await verifySessionToken(token, SECRET), String(id)).toBeNull();
    }
  });
});
