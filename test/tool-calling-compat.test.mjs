import assert from "node:assert/strict";
import test from "node:test";

import "../worker.js";

const {
  applyStoredAuth,
  authCacheKey,
  buildModelCatalog,
  buildHeaders,
  buildPayload,
  extractActualModel,
  extractGeminiBl,
  getConfig,
  getUrl,
  messagesToPrompt,
  parseAuthPayload,
  parseGoogleFunctionCalls,
  parseToolCalls,
  guestModelCatalog,
  defaultModelName,
  resolveModel,
  computeAccountCapacity,
  buildModelSelectHeader,
  routeStatus,
  toOpenAIStreamToolCallDeltas,
} = globalThis.__GEMINI_WORKER_TEST__;

function statusRow(primary, display, category, route) {
  const row = [];
  row[0] = primary;
  row[1] = display.replace(/^\d+(?:\.\d+)?\s+/, "");
  row[2] = `${display} description`;
  row[6] = [route];
  row[11] = display;
  row[12] = `${display} description`;
  row[17] = category;
  return row;
}

const statusPayload = new Array(16).fill(null);
statusPayload[15] = [
  statusRow("cf41b0e0dd7d53e5", "3.5 Flash-Lite", 6, "8c46e95b1a07cecc"),
  statusRow("fbb127bbb056c959", "3.7 Flash", 1, "56fdd199312815e2"),
  statusRow("9d8ca3786ebdfbea", "3.1 Pro", 3, "e6fa609c3fa255c0"),
];
const appHtml = [
  '[["cf41b0e0dd7d53e5","8c46e95b1a07cecc"]]',
  '[["56fdd199312815e2","fbb127bbb056c959"]]',
  '[["e6fa609c3fa255c0","9d8ca3786ebdfbea"]]',
].join("");
const models = buildModelCatalog(statusPayload, appHtml);

test("unknown client aliases keep the thinking suffix on guest auto routing", () => {
  const guest = guestModelCatalog();
  assert.equal(defaultModelName(guest), "gemini-auto");
  assert.equal(resolveModel("gemini-3.6-flash", "", guest).name, "gemini-auto");
  assert.equal(resolveModel("gemini-3.6-flash", "", guest).modeId, 4);
  assert.equal(resolveModel("gemini-3.6-flash", "", guest).thinkingLevel, 1);
  assert.equal(resolveModel("gemini-3.6-flash-thinking", "", guest).name, "gemini-auto-thinking");
  assert.equal(resolveModel("gemini-3.1-pro-thinking", "", guest).thinkingLevel, 2);
  assert.equal(resolveModel("gemini-3.1-pro-thinking", "", guest).modeId, 4);
  assert.equal(resolveModel("gemini-auto-thinking", "", guest).extra, null);
});

test("GetUserStatus builds exactly three current models with a thinking variant each", () => {
  assert.deepEqual(Object.keys(models), [
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash-lite-thinking",
    "gemini-3.7-flash",
    "gemini-3.7-flash-thinking",
    "gemini-3.1-pro",
    "gemini-3.1-pro-thinking",
  ]);
  assert.equal(resolveModel("missing-client-alias", "", models).name, "gemini-3.7-flash");
});

test("GetUserStatus prefers the newest routable rollout in a model category", () => {
  const older = statusRow("1111111111111111", "3.6 Flash", 1, "2222222222222222");
  const newer = statusRow("3333333333333333", "3.8 Flash", 1, "4444444444444444");
  const html = [
    appHtml,
    '[["1111111111111111","2222222222222222"]]',
    '[["3333333333333333","4444444444444444"]]',
  ].join("");
  const catalog = buildModelCatalog({ ...statusPayload, 15: [statusPayload[15][0], older, newer, statusPayload[15][2]] }, html);

  assert.equal(catalog["gemini-3.8-flash"].model, "3333333333333333");
  assert.equal(catalog["gemini-3.8-flash"].submodel, "4444444444444444");
  assert.equal(catalog["gemini-3.6-flash"], undefined);
});

test("standard and extended payloads use current route IDs and independent thinking levels", () => {
  for (const [base, route, category] of [
    ["gemini-3.5-flash-lite", "8c46e95b1a07cecc", 6],
    ["gemini-3.7-flash", "56fdd199312815e2", 1],
    ["gemini-3.1-pro", "e6fa609c3fa255c0", 3],
  ]) {
    for (const [name, level] of [[base, 1], [`${base}-thinking`, 2]]) {
      const rm = resolveModel(name, "", models);
      const outer = JSON.parse(new URLSearchParams(buildPayload("PING", rm.modeId, rm.thinkingLevel, null, rm.extra)).get("f.req"));
      const inner = JSON.parse(outer[1]);

      assert.match(inner[59], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.deepEqual(inner[17], [[4]]);
      assert.equal(inner[31], null);
      assert.equal(inner[64], route);
      assert.equal(inner[75], category);
      assert.equal(inner[79], category);
      assert.equal(inner[80], level);
    }
  }
});

test("Pro model header uses the GetUserStatus primary ID and account capacity", () => {
  assert.deepEqual(computeAccountCapacity({ 16: [8, 0, 38], 17: [19] }), { capacity: 2, capacity_field: 12 });
  assert.equal(
    buildModelSelectHeader("e6fa609c3fa255c0", 3, 2, 12),
    `[1,null,null,null,"e6fa609c3fa255c0",null,null,0,[4,5,6,8],null,null,2,null,null,3]`,
  );

  const paidPayload = statusPayload.slice();
  paidPayload[16] = [8, 0, 38];
  paidPayload[17] = [19];
  const paid = buildModelCatalog(paidPayload, appHtml);
  const pro = resolveModel("gemini-3.1-pro", "", paid);
  assert.equal(pro.header, `[1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4,5,6,8],null,null,2,null,null,3]`);
  assert.equal(resolveModel("gemini-auto", "", guestModelCatalog()).header, "");
});

test("raw Cookie and gemini-auth JSON preserve account metadata", async () => {
  const raw = "NID=534=value=with=equals; SAPISID=sapi/value; __Secure-1PSID=session; S=a=b";
  const parsed = parseAuthPayload(raw, true);
  assert.equal(parsed.cookie, "SAPISID=sapi/value; NID=534=value=with=equals; __Secure-1PSID=session");
  assert.equal(parsed.sapisid, "sapi/value");
  assert.equal(parsed.removed_cookie_count, 1);

  const baseCfg = getConfig({
    GEMINI_COOKIE: JSON.stringify({
      cookie: raw,
      sapisid: "sapi/value",
      auth_user: 2,
      xsrf_token: "xsrf-token",
      gemini_bl: "boq_assistant-bard-web-server_test",
    }),
    SAPISID: "must-be-ignored",
    GEMINI_AUTH_USER: "9",
    GEMINI_XSRF_TOKEN: "must-be-ignored",
  });
  assert.equal(baseCfg.cookie, "");
  assert.equal(baseCfg.sapisid, "");
  assert.equal(baseCfg.auth_user, null);
  assert.equal(baseCfg.xsrf_token, "");

  const cfg = applyStoredAuth(baseCfg, {
    cookie: raw,
    sapisid: "sapi/value",
    auth_user: 2,
    xsrf_token: "xsrf-token",
    gemini_bl: "boq_assistant-bard-web-server_test",
  });
  assert.equal(cfg.auth_user, "2");
  assert.equal(cfg.xsrf_token, "xsrf-token");
  assert.match(getUrl(cfg), /\/u\/2\/_\/BardChatUi/);
  const headers = await buildHeaders(cfg);
  assert.equal(headers["X-Goog-AuthUser"], "2");
  assert.equal(headers.Referer, "https://gemini.google.com/u/2/app");
});

test("Cookie import normalizes markdown-escaped browser paste", () => {
  const parsed = parseAuthPayload(
    "\\_\\_Secure-BUCKET=bucket; SEARCH\\_SAMESITE=same; SAPISID=sapi\\_value; SID=session; **Secure-3PAPISID=pap; \\_*Secure-3PSIDRTS=ts",
    true,
  );

  assert.equal(
    parsed.cookie,
    "SID=session; SAPISID=sapi_value; __Secure-BUCKET=bucket; __Secure-3PAPISID=pap; __Secure-3PSIDRTS=ts",
  );
  assert.equal(parsed.sapisid, "sapi_value");
});

test("Cookie validation rejects an incomplete login session", () => {
  assert.throws(() => parseAuthPayload("SAPISID=value", true), /工作階段 Cookie/);
});

test("page-token cache identity changes with the Cookie", async () => {
  const a = await authCacheKey(applyStoredAuth(getConfig({}), { cookie: "SAPISID=a; SID=session-a" }));
  const b = await authCacheKey(applyStoredAuth(getConfig({}), { cookie: "SAPISID=b; SID=session-b" }));
  assert.notEqual(a, b);
});

test("Gemini build is extracted from the app page", () => {
  assert.equal(
    extractGeminiBl('<script>"cfb2h":"boq_assistant-bard-web-server_20260806.01_p0"</script>'),
    "boq_assistant-bard-web-server_20260806.01_p0",
  );
});

test("actual upstream model and fallback routing are extracted from StreamGenerate", () => {
  const inner = new Array(43).fill(null);
  inner[42] = "3.5 Flash-Lite";
  const raw = JSON.stringify([["wrb.fr", "rpc", JSON.stringify(inner)]]);

  assert.equal(extractActualModel(raw), "3.5 Flash-Lite");
  assert.equal(routeStatus(6, "3.5 Flash-Lite"), "matched");
  assert.equal(routeStatus(3, "3.5 Flash-Lite"), "fallback");
  assert.equal(routeStatus(3, "3.1 Pro"), "matched");
  assert.equal(routeStatus(4, "3.5 Flash-Lite"), "auto");
});

const tools = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a local file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["path", "content"],
      },
    },
  },
];

test("OpenAI tool prompt uses DSML and explains local tool execution", () => {
  const [prompt] = messagesToPrompt([{ role: "user", content: "Update README.md" }], tools, "auto");

  assert.match(prompt, /<\|DSML\|tool_calls>/);
  assert.match(prompt, /CDATA/);
  assert.match(prompt, /local environment/i);
  assert.match(prompt, /write_file/);
});

test("DSML tool calls are parsed into OpenAI tool_calls with typed arguments", () => {
  const [clean, toolCalls] = parseToolCalls(
    [
      "Preparing the edit.",
      '<|DSML|tool_calls>',
      '  <|DSML|invoke name="write_file">',
      '    <|DSML|parameter name="path"><![CDATA[README.md]]></|DSML|parameter>',
      '    <|DSML|parameter name="content"><![CDATA[# Title\\n<keep>]]></|DSML|parameter>',
      '    <|DSML|parameter name="overwrite">true</|DSML|parameter>',
      '  </|DSML|invoke>',
      '</|DSML|tool_calls>',
    ].join("\n"),
    tools,
  );

  assert.equal(clean, "Preparing the edit.");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].type, "function");
  assert.equal(toolCalls[0].function.name, "write_file");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
    path: "README.md",
    content: "# Title\\n<keep>",
    overwrite: true,
  });
});

test("legacy tool_call code fences still parse", () => {
  const [clean, toolCalls] = parseToolCalls(
    [
      "```tool_call",
      '{"name":"write_file","arguments":{"path":"README.md","content":"ok"}}',
      "```",
    ].join("\n"),
    tools,
  );

  assert.equal(clean, "");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "write_file");
});

test("streaming tool_calls include OpenAI-compatible indexes", () => {
  const deltas = toOpenAIStreamToolCallDeltas([
    {
      id: "call_1",
      type: "function",
      function: { name: "write_file", arguments: "{\"path\":\"README.md\",\"content\":\"ok\"}" },
    },
  ]);

  assert.equal(deltas[0].index, 0);
  assert.equal(deltas[0].id, "call_1");
  assert.equal(deltas[0].type, "function");
});

test("Google function calling parser accepts DSML tool calls", () => {
  const [clean, calls] = parseGoogleFunctionCalls(
    [
      '<|DSML|tool_calls>',
      '  <|DSML|invoke name="write_file">',
      '    <|DSML|parameter name="path"><![CDATA[README.md]]></|DSML|parameter>',
      '    <|DSML|parameter name="content"><![CDATA[ok]]></|DSML|parameter>',
      '  </|DSML|invoke>',
      '</|DSML|tool_calls>',
    ].join("\n"),
    tools,
  );

  assert.equal(clean, "");
  assert.deepEqual(calls, [{ name: "write_file", args: { path: "README.md", content: "ok" } }]);
});
