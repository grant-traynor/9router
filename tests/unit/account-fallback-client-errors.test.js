import { beforeEach, describe, expect, it, vi } from "vitest";

const { getProviderConnectionsMock, updateProviderConnectionMock } = vi.hoisted(() => ({
  getProviderConnectionsMock: vi.fn(),
  updateProviderConnectionMock: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: getProviderConnectionsMock,
  updateProviderConnection: updateProviderConnectionMock,
  validateApiKey: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

describe("account fallback classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderConnectionsMock.mockResolvedValue([
      { id: "connection-1", displayName: "Account 1", backoffLevel: 0 },
    ]);
  });

  it.each([400, 413, 415, 422])(
    "does not fall back or cool down for client-invalid HTTP %i",
    (status) => {
      expect(checkFallbackError(status, "invalid request payload", 0)).toEqual({
        shouldFallback: false,
        cooldownMs: 0,
      });
    },
  );

  it("does not lock malformed media requests", async () => {
    const result = await markAccountUnavailable(
      "connection-1",
      400,
      "image.source.base64.media_type: Input should be image/jpeg, image/png, image/gif or image/webp",
      "claude",
      "claude-sonnet-4-6",
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(updateProviderConnectionMock).not.toHaveBeenCalled();
  });

  it("keeps quota text fallback even when a provider reports HTTP 400", () => {
    expect(checkFallbackError(400, "quota exceeded for this account", 0)).toMatchObject({
      shouldFallback: true,
      cooldownMs: 2_000,
      newBackoffLevel: 1,
    });
  });

  it("keeps Kiro model-tier fallback for its HTTP 400 error text", () => {
    expect(checkFallbackError(400, "Improperly formed request", 0)).toMatchObject({
      shouldFallback: true,
      cooldownMs: 120_000,
    });
  });

  it.each([
    [401, 120_000],
    [402, 120_000],
    [403, 120_000],
    [404, 120_000],
    [406, 30_000],
    [429, 2_000],
    [503, 30_000],
  ])("retains fallback cooldown for HTTP %i", (status, cooldownMs) => {
    expect(checkFallbackError(status, "provider unavailable", 0)).toMatchObject({
      shouldFallback: true,
      cooldownMs,
    });
  });

  it("still persists a model lock for rate limits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await markAccountUnavailable(
      "connection-1",
      429,
      "rate limit exceeded",
      "claude",
      "claude-sonnet-4-6",
    );

    expect(result).toMatchObject({ shouldFallback: true, cooldownMs: 2_000 });
    expect(updateProviderConnectionMock).toHaveBeenCalledWith(
      "connection-1",
      expect.objectContaining({
        "modelLock_claude-sonnet-4-6": expect.any(String),
        testStatus: "unavailable",
        errorCode: 429,
        backoffLevel: 1,
      }),
    );
  });
});
