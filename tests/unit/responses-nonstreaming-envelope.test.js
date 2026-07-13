import { describe, expect, it } from "vitest";

import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Responses API non-streaming response envelope", () => {
  it("converts a Claude message response into a Responses API object", () => {
    const result = translateNonStreamingResponse(
      {
        id: "msg_claude_123",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "ROUTERPDF7429" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 21, output_tokens: 4 },
      },
      FORMATS.CLAUDE,
      FORMATS.OPENAI_RESPONSES,
    );

    expect(result).toMatchObject({
      object: "response",
      status: "completed",
      model: "claude-sonnet-4-6",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ROUTERPDF7429" }],
        },
      ],
      usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25 },
    });
    expect(result.id).toMatch(/^resp_/);
    expect(result.created_at).toEqual(expect.any(Number));
    expect(result.choices).toBeUndefined();
  });

  it("converts an OpenAI chat completion with reasoning and tools", () => {
    const result = translateNonStreamingResponse(
      {
        id: "chatcmpl-openai-123",
        object: "chat.completion",
        created: 1_752_345_678,
        model: "gpt-5",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "I will inspect it.",
              reasoning_content: "Need the file first.",
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"a.txt"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      },
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
    );

    expect(result).toMatchObject({
      id: "resp_chatcmpl-openai-123",
      object: "response",
      created_at: 1_752_345_678,
      status: "completed",
      model: "gpt-5",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Need the file first." }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I will inspect it." }],
        },
        {
          type: "function_call",
          call_id: "call_123",
          name: "read_file",
          arguments: '{"path":"a.txt"}',
        },
      ],
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    });
    expect(result.choices).toBeUndefined();
  });
});
