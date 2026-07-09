import { describe, expect, it, vi } from "vitest";
import { consumeToken, generateRawToken, hashToken } from "../src/auth/magic";

function fakeDb(opts: { changes: number; row: { expires_at: number; used_at: number | null } | null }) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: opts.changes } });
  const first = vi.fn().mockResolvedValue(opts.row);
  const bind = vi.fn().mockReturnValue({ run, first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare, bind, run, first } as any;
}

describe("generateRawToken / hashToken", () => {
  it("generates a 64-char hex-ish token with no dashes", () => {
    const raw = generateRawToken();
    expect(raw).not.toContain("-");
    expect(raw).toHaveLength(64);
  });

  it("hashes deterministically", async () => {
    const raw = generateRawToken();
    const h1 = await hashToken(raw);
    const h2 = await hashToken(raw);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("consumeToken", () => {
  it("succeeds when the conditional UPDATE affects exactly one row", async () => {
    const db = fakeDb({ changes: 1, row: null });
    await expect(consumeToken(db, "hash", 1000, "magic_link_tokens")).resolves.toBeUndefined();
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE magic_link_tokens"));
  });

  it("throws INVALID_TOKEN when no row exists for the hash", async () => {
    const db = fakeDb({ changes: 0, row: null });
    await expect(consumeToken(db, "hash", 1000, "magic_link_tokens")).rejects.toMatchObject({
      name: "INVALID_TOKEN",
    });
  });

  it("throws TOKEN_EXPIRED when the row exists but the UPDATE matched nothing (used or expired)", async () => {
    const db = fakeDb({ changes: 0, row: { expires_at: 500, used_at: null } });
    await expect(consumeToken(db, "hash", 1000, "magic_link_tokens")).rejects.toMatchObject({
      name: "TOKEN_EXPIRED",
    });
  });

  it("supports a custom used-column name (invites use accepted_at, not used_at)", async () => {
    const db = fakeDb({ changes: 1, row: null });
    await consumeToken(db, "hash", 1000, "invites", "accepted_at");
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("accepted_at"));
    expect(db.prepare).not.toHaveBeenCalledWith(expect.stringContaining("used_at"));
  });
});
