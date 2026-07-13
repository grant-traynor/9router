import { describe, it, expect } from "vitest";
import { convertOpenAIContentToParts } from "../../open-sse/translator/formats/gemini.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { convertResponsesApiFormat } from "../../open-sse/translator/formats/responsesApi.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { VALID_OPENAI_CONTENT_TYPES, OPENAI_BLOCK, CLAUDE_BLOCK } from "../../open-sse/translator/schema/index.js";

const PDF_DATA = "data:application/pdf;base64,JVBERi0xLjE=";
const PNG_DATA = "data:image/png;base64,iVBORw0KGgo=";

describe("file/document block support", () => {
  it("schema: file is a valid openai content type", () => {
    expect(VALID_OPENAI_CONTENT_TYPES).toContain(OPENAI_BLOCK.FILE);
    expect(OPENAI_BLOCK.FILE).toBe("file");
    expect(CLAUDE_BLOCK.DOCUMENT).toBe("document");
  });

  it("gemini: openai file block -> inlineData", () => {
    const parts = convertOpenAIContentToParts([
      { type: "text", text: "read this" },
      { type: "file", file: { filename: "d.pdf", file_data: PDF_DATA } },
    ]);
    const inline = parts.find((p) => p.inlineData);
    expect(inline).toBeTruthy();
    expect(inline.inlineData.mime_type).toBe("application/pdf");
    expect(inline.inlineData.data).toBe("JVBERi0xLjE=");
  });

  it("gemini: PDF image_url remains inlineData", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: PDF_DATA } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, getCapabilitiesForModel("antigravity", "gemini-3-flash"));
    const parts = convertOpenAIContentToParts(body.messages[0].content);
    expect(parts[0].inlineData).toEqual({
      mime_type: "application/pdf",
      data: "JVBERi0xLjE=",
    });
  });

  it("gemini: ignores non-data-uri file", () => {
    const parts = convertOpenAIContentToParts([
      { type: "file", file: { filename: "d.pdf", file_data: "https://x/d.pdf" } },
    ]);
    expect(parts.some((p) => p.inlineData)).toBe(false);
  });

  it("claude: openai file (pdf) -> document block", () => {
    const body = {
      messages: [{ role: "user", content: [
        { type: "text", text: "read" },
        { type: "file", file: { filename: "d.pdf", file_data: PDF_DATA } },
      ] }],
    };
    stripUnsupportedModalities(body, FORMATS.OPENAI, getCapabilitiesForModel("claude", "claude-sonnet-4-6"));
    const out = openaiToClaudeRequest("claude-sonnet-4-6", body, false);
    const blocks = out.messages[0].content;
    const doc = blocks.find((b) => b.type === "document");
    expect(doc).toBeTruthy();
    expect(doc.source.media_type).toBe("application/pdf");
  });

  it("claude: non-pdf file is dropped (not a document)", () => {
    const out = openaiToClaudeRequest("claude-x", {
      messages: [{ role: "user", content: [
        { type: "text", text: "read" },
        { type: "file", file: { filename: "i.png", file_data: PNG_DATA } },
      ] }],
    }, false);
    const blocks = out.messages[0].content;
    expect(blocks.some((b) => b.type === "document")).toBe(false);
  });

  it("claude: pdf data URI carried as image_url -> document block", () => {
    const out = openaiToClaudeRequest("claude-sonnet-4-6", {
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: PDF_DATA } },
      ] }],
    }, false);
    const block = out.messages[0].content[0];
    expect(block.type).toBe(CLAUDE_BLOCK.DOCUMENT);
    expect(block.source).toEqual({
      type: "base64",
      media_type: "application/pdf",
      data: "JVBERi0xLjE=",
    });
  });

  it("claude: supported image data URI remains an image block", () => {
    const out = openaiToClaudeRequest("claude-sonnet-4-6", {
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: PNG_DATA } },
      ] }],
    }, false);
    expect(out.messages[0].content[0]).toEqual({
      type: CLAUDE_BLOCK.IMAGE,
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });

  it("claude: native document-only message survives preparation", () => {
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: [{
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjE=" },
      }] }],
    };
    stripUnsupportedModalities(body, FORMATS.CLAUDE, getCapabilitiesForModel("claude", body.model));
    const out = prepareClaudeRequest(body, "claude");
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].content[0].type).toBe(CLAUDE_BLOCK.DOCUMENT);
  });

  it("claude: OpenAI-compatible document block is preserved", () => {
    const source = { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjE=" };
    const out = openaiToClaudeRequest("claude-sonnet-4-6", {
      messages: [{ role: "user", content: [{ type: "document", source }] }],
    }, false);
    expect(out.messages[0].content[0]).toEqual({ type: CLAUDE_BLOCK.DOCUMENT, source });
  });

  it("claude: OpenAI file_url -> URL document source", () => {
    const out = openaiToClaudeRequest("claude-sonnet-4-6", {
      messages: [{ role: "user", content: [{
        type: "file",
        file: { filename: "d.pdf", file_url: "https://example.com/d.pdf" },
      }] }],
    }, false);
    expect(out.messages[0].content[0]).toEqual({
      type: CLAUDE_BLOCK.DOCUMENT,
      source: { type: "url", url: "https://example.com/d.pdf" },
    });
  });

  it("claude: non-PDF file_url is not emitted as a document", () => {
    const out = openaiToClaudeRequest("claude-sonnet-4-6", {
      messages: [{ role: "user", content: [
        { type: "text", text: "inspect" },
        { type: "file", file: { filename: "image.png", file_url: "https://example.com/image.png" } },
      ] }],
    }, false);
    expect(out.messages[0].content.some((block) => block.type === CLAUDE_BLOCK.DOCUMENT)).toBe(false);
  });

  it("responses: input_file data becomes canonical OpenAI file block", () => {
    const out = convertResponsesApiFormat({
      input: [{ type: "message", role: "user", content: [{
        type: "input_file",
        filename: "d.pdf",
        file_data: PDF_DATA,
      }] }],
    });
    expect(out.messages[0].content[0]).toEqual({
      type: OPENAI_BLOCK.FILE,
      file: { filename: "d.pdf", file_data: PDF_DATA },
    });

    const claude = openaiToClaudeRequest("claude-sonnet-4-6", out, false);
    expect(claude.messages[0].content[0].type).toBe(CLAUDE_BLOCK.DOCUMENT);
  });
});
