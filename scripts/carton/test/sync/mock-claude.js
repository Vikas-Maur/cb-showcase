// A stand-in for the Messages API that real Claude Code talks to (ANTHROPIC_BASE_URL), for hook-bench.js: it answers
// each turn with the next tool call of a plan, then "done". No model, nothing leaves the machine. Records when each
// request arrived and the tool result it carried.
const http = require("http");

function start(plan) {
  const log = []; // {at, step, toolResult}
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const at = performance.now();
      let j = {};
      try { j = JSON.parse(body || "{}"); } catch {}
      if (req.method !== "POST" || !/\/v1\/messages(\?|$)/.test(req.url) || !Array.isArray(j.messages) || !Array.isArray(j.tools) || !j.tools.length) {
        // anything else Claude Code asks (a title, a count, settings): a short text answer or nothing
        if (req.method === "POST" && /\/v1\/messages(\?|$)/.test(req.url)) return reply(res, j.stream, [{ type: "text", text: "ok" }], "end_turn");
        res.writeHead(404, { "content-type": "application/json" });
        return res.end('{"type":"error","error":{"type":"not_found_error","message":"mock"}}');
      }
      // the step: how many of our tool calls this conversation has had answered
      const step = j.messages.filter((m) => m.role === "assistant").length;
      const last = j.messages[j.messages.length - 1];
      const results = Array.isArray(last?.content) ? last.content.filter((c) => c.type === "tool_result") : [];
      log.push({ at, step, toolResult: results.map((r) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content))).join("\n").slice(0, 2000), isError: results.some((r) => r.is_error) });
      if (step < plan.length) {
        const { tool, input } = plan[step];
        return reply(res, j.stream, [{ type: "tool_use", id: `toolu_mock${++n}`, name: tool, input }], "tool_use");
      }
      return reply(res, j.stream, [{ type: "text", text: "done" }], "end_turn");
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ port: server.address().port, log, close: () => new Promise((c) => server.close(c)) })));
}

function reply(res, stream, content, stop) {
  const id = "msg_mock" + Math.random().toString(36).slice(2, 10);
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id, type: "message", role: "assistant", model: "mock", content, stop_reason: stop, stop_sequence: null, usage }));
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { id, type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage } });
  content.forEach((c, i) => {
    if (c.type === "tool_use") {
      ev("content_block_start", { index: i, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } });
      ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } });
    } else {
      ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: i, delta: { type: "text_delta", text: c.text } });
    }
    ev("content_block_stop", { index: i });
  });
  ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  ev("message_stop", {});
  res.end();
}

module.exports = { start };
