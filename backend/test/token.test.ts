import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  signAccessToken,
  signRefreshToken,
  signWidgetToken,
  verifyAccessToken,
  verifyRefreshToken,
  verifyWidgetToken,
} from "../src/auth/token";
import { AUTH } from "../src/common/const";
import type { Env } from "../src/types";

const fakeEnv = {
  JWT_ACCESS_SECRET: "access-secret",
  JWT_REFRESH_SECRET: "refresh-secret",
  WIDGET_TOKEN_SECRET: "widget-secret",
} as Env;

describe("token sign/verify", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips an access token", async () => {
    const jwt = await signAccessToken(fakeEnv, "user-1");
    const payload = await verifyAccessToken(fakeEnv, jwt);
    expect(payload.sub).toBe("user-1");
  });

  it("round-trips a refresh token", async () => {
    const jwt = await signRefreshToken(fakeEnv, "user-1");
    const payload = await verifyRefreshToken(fakeEnv, jwt);
    expect(payload.sub).toBe("user-1");
  });

  it("round-trips a widget token with ws + kind", async () => {
    const jwt = await signWidgetToken(fakeEnv, "user-1", "ws-1");
    const payload = await verifyWidgetToken(fakeEnv, jwt);
    expect(payload).toMatchObject({ sub: "user-1", ws: "ws-1", kind: "CONTACT" });
  });

  it("throws EXPIRED_ACCESS_TOKEN once the access TTL has passed", async () => {
    const jwt = await signAccessToken(fakeEnv, "user-1");
    vi.advanceTimersByTime((AUTH.ACCESS_TOKEN_TTL_SEC + 5) * 1000);
    await expect(verifyAccessToken(fakeEnv, jwt)).rejects.toMatchObject({
      name: "EXPIRED_ACCESS_TOKEN",
    });
  });

  it("throws INVALID_ACCESS_TOKEN for a token signed with a different secret", async () => {
    const jwt = await signAccessToken({ ...fakeEnv, JWT_ACCESS_SECRET: "other-secret" } as Env, "user-1");
    await expect(verifyAccessToken(fakeEnv, jwt)).rejects.toMatchObject({
      name: "INVALID_ACCESS_TOKEN",
    });
  });

  it("throws INVALID_REFRESH_TOKEN for a garbage token", async () => {
    await expect(verifyRefreshToken(fakeEnv, "not-a-jwt")).rejects.toMatchObject({
      name: "INVALID_REFRESH_TOKEN",
    });
  });
});
