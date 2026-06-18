import assert from "node:assert/strict";
import test from "node:test";

import { parseToolCalls, toOpenAIStreamToolCallDeltas } from "../worker.js";

test("tool_call blocks are parsed into OpenAI tool_calls", () => {
  const [clean, toolCalls] = parseToolCalls(
    [
      "```tool_call",
      '{"name":"read_file","arguments":{"path":"README.md"}}',
      "```",
    ].join("\n"),
  );

  assert.equal(clean, "");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].type, "function");
  assert.equal(toolCalls[0].function.name, "read_file");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
    path: "README.md",
  });
});

test("streaming tool_calls include OpenAI-compatible indexes", () => {
  const deltas = toOpenAIStreamToolCallDeltas([
    {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
    },
  ]);

  assert.equal(deltas[0].index, 0);
  assert.equal(deltas[0].id, "call_1");
  assert.equal(deltas[0].type, "function");
  assert.equal(deltas[0].function.name, "read_file");
});
