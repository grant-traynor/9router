import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

describe("Responses API non-streaming core path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "msg_claude_core",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "core response" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      transformedBody: null,
    });
  });

  it("defaults an omitted stream field to JSON and returns a Responses envelope", async () => {
    const result = await handleChatCore({
      body: {
        model: "claude/claude-sonnet-4-6",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        }],
      },
      modelInfo: { provider: "claude", model: "claude-sonnet-4-6" },
      credentials: { accessToken: "test-token", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() },
      connectionId: "test-connection",
      sourceFormatOverride: FORMATS.OPENAI_RESPONSES,
      clientRawRequest: { endpoint: "/v1/responses", body: {}, headers: {} },
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      pxpipeEnabled: false,
    });

    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({ stream: false }));
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("application/json");

    const body = await result.response.json();
    expect(body).toMatchObject({
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "core response" }],
      }],
    });
    expect(body.choices).toBeUndefined();
  });
});
