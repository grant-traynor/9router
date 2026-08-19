import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function sseStream(chunks) {
  const text = Array.isArray(chunks) ? chunks.join("") : chunks;
  return new Response(text, { headers: { "content-type": "text/event-stream" } }).body;
}

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("convertResponsesStreamToJson", () => {
  it("uses response.completed.output when no output_item.done frames arrive", async () => {
    const sse = frame("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello from completed" }],
        }],
      },
    });
    const out = await convertResponsesStreamToJson(sseStream(sse));
    expect(out.status).toBe("completed");
    expect(out.usage.output_tokens).toBe(4);
    expect(out.output[0].content[0].text).toBe("hello from completed");
  });

  it("accepts data-only frames with type on the JSON", async () => {
    const sse = `data: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", encrypted_content: "enc1", summary: [{ type: "summary_text", text: "think" }] },
    })}\n\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_2", status: "completed", usage: { input_tokens: 1, output_tokens: 2 } },
    })}\n\n`;
    const out = await convertResponsesStreamToJson(sseStream(sse));
    expect(out.output).toHaveLength(1);
    expect(out.output[0].encrypted_content).toBe("enc1");
  });
});

describe("handleForcedSSEToJson grok reasoning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function run(sse) {
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI,
      provider: "grok-cli",
      model: "grok-4.6-low",
      body: { model: "hippocrates", messages: [{ role: "user", content: "hi" }], stream: false },
      stream: true,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now(),
      connectionId: "c1",
      apiKey: "k",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      trackDone: () => {},
      appendLog: () => {},
      reqTag: "t",
      log: { line: () => {} },
    });
    const json = await result.response.json();
    return json;
  }

  it("puts reasoning summary in content when there is no output_text", async () => {
    const sse = frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "reasoning",
        encrypted_content: "enc_blob",
        summary: [{ type: "summary_text", text: "A campaign is a planned outreach." }],
      },
    }) + frame("response.completed", {
      type: "response.completed",
      response: { id: "resp_r", status: "completed", usage: { input_tokens: 100, output_tokens: 351 } },
    });
    const json = await run(sse);
    const msg = json.choices[0].message;
    expect(msg.content).toMatch(/planned outreach/);
    expect(msg.reasoning_content).toMatch(/planned outreach/);
    expect(msg.encrypted_content).toBe("enc_blob");
    expect(msg.tool_calls).toBeUndefined();
  });

  it("keeps encrypted_content on a tool-call turn so the next store=false hop works", async () => {
    const sse = frame("response.output_item.done", {
      output_index: 0,
      item: { type: "reasoning", encrypted_content: "enc_tool", summary: [{ type: "summary_text", text: "need search" }] },
    }) + frame("response.output_item.done", {
      output_index: 1,
      item: { type: "function_call", call_id: "c1", name: "code_search", arguments: "{\"q\":\"x\"}" },
    }) + frame("response.completed", {
      response: { id: "resp_t", status: "completed", usage: { input_tokens: 8, output_tokens: 3 } },
    });
    const json = await run(sse);
    const msg = json.choices[0].message;
    expect(msg.tool_calls[0].function.name).toBe("code_search");
    expect(msg.encrypted_content).toBe("enc_tool");
    expect(msg.content).toBeNull();
  });
});
