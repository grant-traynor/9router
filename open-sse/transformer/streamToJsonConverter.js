/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataLines = [];
  for (const line of String(msg).split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  const dataStr = dataLines.join("\n").trim();
  if (!dataStr || dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  // Official Responses SSE has `event:` + `data:`. Some proxies (Grok CLI)
  // emit data-only frames with `type` on the JSON itself.
  const eventType = (eventMatch?.[1] || "").trim() || parsed.type || "";
  if (!eventType) return;

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || parsed.id || state.responseId;
    state.created = parsed.response?.created_at || parsed.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    const item = parsed.item || parsed.response?.item;
    if (item) state.items.set(parsed.output_index ?? state.items.size, item);
  } else if (eventType === "response.completed" || eventType === "response.done") {
    state.status = "completed";
    const response = parsed.response || parsed;
    if (response?.id) state.responseId = response.id;
    if (response?.created_at) state.created = response.created_at;
    const usage = response?.usage;
    if (usage && typeof usage === "object") {
      state.usage.input_tokens = usage.input_tokens || usage.prompt_tokens || 0;
      state.usage.output_tokens = usage.output_tokens || usage.completion_tokens || 0;
      state.usage.total_tokens = usage.total_tokens || (state.usage.input_tokens + state.usage.output_tokens);
    }
    // Grok often puts the full output only on the completed event, not as
    // per-item `output_item.done` frames. Fill any missing indexes from it.
    if (Array.isArray(response?.output)) {
      response.output.forEach((item, i) => {
        if (!item) return;
        const idx = Number.isInteger(item.output_index) ? item.output_index : i;
        if (!state.items.has(idx)) state.items.set(idx, item);
      });
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index). Skip holes
  // rather than inserting empty placeholder messages — those look like a
  // successful empty completion to Chat Completions clients.
  const output = [...state.items.keys()]
    .sort((a, b) => a - b)
    .map((k) => state.items.get(k))
    .filter(Boolean);

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    output,
    usage: state.usage
  };
}
