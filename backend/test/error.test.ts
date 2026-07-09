import { describe, expect, it } from "vitest";
import { CtxError, ctxErr } from "../src/ctx/ctx.error";

describe("ctxErr factories", () => {
  it("produces a CtxError with name/msg/data from defaults", () => {
    const err = ctxErr.workspace.notMember();
    expect(err).toBeInstanceOf(CtxError);
    expect(err.name).toBe("WORKSPACE_NOT_MEMBER");
    expect(err.message).toBe("You are not a member of this workspace");
    expect(err.data).toEqual({});
  });

  it("allows overriding msg/data/info per call", () => {
    const err = ctxErr.auth.tokenExpired({ msg: "custom msg", data: { email: "a@b.com" }, info: { x: 1 } });
    expect(err.name).toBe("TOKEN_EXPIRED");
    expect(err.message).toBe("custom msg");
    expect(err.data).toEqual({ email: "a@b.com" });
    expect(err.info).toEqual({ x: 1 });
  });

  it("info defaults undefined and is never part of data", () => {
    const err = ctxErr.general.unknown();
    expect(err.info).toBeUndefined();
  });
});
