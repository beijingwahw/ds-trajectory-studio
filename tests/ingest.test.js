/* ============================================================
 * 真实数据接入测试：OTLP/GenAI 适配器、DSH 日志适配器、
 * 统一导入入口的格式自动识别、OTLP 往返一致性。
 * ============================================================ */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const trace = require("../src/model/trace.js");
const otlp = require("../src/io/otlp.js");
const dsh = require("../src/io/dsh.js");
const DATA = require("../data/sample.js");

// import.js 为浏览器 IIFE：在 Node 中预装配全局命名空间后加载
globalThis.DSTS = {
  util: require("../src/core/util.js"),
  trace,
  otlp,
  dsh
};
require("../src/io/import.js");
const io = globalThis.DSTS.io;

const A = DATA.runs["run-a"];

/* ---------- OTLP ---------- */

test("OTLP 往返：run → toOTLP → parseOTLP 保持关键指标", () => {
  const exported = otlp.toOTLP(A);
  const back = otlp.parseOTLP(exported, "rt");
  const { ok, errors } = trace.validateRun(back);
  assert.ok(ok, errors.join(";"));
  assert.equal(back.events.length, A.events.length);
  assert.equal(trace.tokSum(back), trace.tokSum(A));
  assert.equal(trace.runEnd(back), trace.runEnd(A));
});

test("OTLP 语义映射：operation/type/tokens/error/parents", () => {
  const fixture = {
    resourceSpans: [{
      scopeSpans: [{
        spans: [
          { spanId: "root", parentSpanId: "", name: "invoke_agent coder",
            startTimeUnixNano: "1000000000", endTimeUnixNano: "6000000000",
            attributes: [{ key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } }] },
          { spanId: "s1", parentSpanId: "root", name: "chat deepseek-reasoner",
            startTimeUnixNano: "1000000000", endTimeUnixNano: "3000000000",
            attributes: [
              { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
              { key: "gen_ai.usage.input_tokens", value: { intValue: "1234" } },
              { key: "gen_ai.usage.output_tokens", value: { intValue: 56 } }
            ] },
          { spanId: "s2", parentSpanId: "root", name: "execute_tool read_file",
            startTimeUnixNano: "3000000000", endTimeUnixNano: "3500000000",
            status: { code: 2, message: "file not found" },
            attributes: [
              { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } },
              { key: "gen_ai.tool.name", value: { stringValue: "read_file" } },
              { key: "error.type", value: { stringValue: "FileNotFound" } }
            ] }
        ]
      }]
    }]
  };
  const run = otlp.parseOTLP(fixture, "fx");
  // invoke_agent 容器根被折叠 → 剩 2 个事件
  assert.equal(run.events.length, 2);
  const s1 = run.events.find((e) => e.id === "s1");
  const s2 = run.events.find((e) => e.id === "s2");
  assert.equal(s1.type, "llm");
  assert.equal(s1.tokens.in, 1234);
  assert.equal(s1.tokens.out, 56);
  assert.equal(s1.dur, 2000);
  assert.equal(s2.type, "tool");
  assert.equal(s2.status, "error");
  assert.ok(s2.detail.includes("FileNotFound"));
  // 折叠后子节点重挂：root 被移除，s1/s2 无有效父 → parents 为空
  assert.deepEqual(s1.parents, []);
  assert.equal(trace.runEnd(run), 2500);
});

/* ---------- DSH ---------- */

test("DSH JSONL：同义字段归一 + append-only 链式父子", () => {
  const jsonl = [
    JSON.stringify({ type: "thought", ts: 1700000000000, name: "任务规划" }),
    JSON.stringify({ type: "llm_call", ts: 1700000001200, duration: 8000, usage: { input_tokens: 5000, completion_tokens: 1200 }, name: "推理" }),
    JSON.stringify({ kind: "tool_exec", timestamp: 1700000009200, elapsed_ms: 500, title: "read_file", result: "ok" }),
    JSON.stringify({ event: "retry", at: 1700000009700, ms: 2000, status: "error", message: "LLM 超时" })
  ].join("\n");
  const run = dsh.parseDSH(jsonl, "d1");
  const { ok, errors } = trace.validateRun(run);
  assert.ok(ok, errors.join(";"));
  assert.equal(run.events.length, 4);
  assert.equal(run.events[0].type, "thought");
  assert.equal(run.events[1].type, "llm");
  assert.equal(run.events[1].tokens.in, 5000);
  assert.equal(run.events[1].tokens.out, 1200);
  assert.equal(run.events[2].type, "tool");
  assert.equal(run.events[3].type, "error");
  assert.equal(run.events[3].status, "error");
  // append-only：无显式 parent 时链回前一事件
  assert.deepEqual(run.events[2].parents, [run.events[1].id]);
  assert.equal(run.events[1].t, 1200);
});

test("DSH 类型推断边界", () => {
  assert.equal(dsh.inferType("compaction_replacement"), "thought");
  assert.equal(dsh.inferType("subagent_dispatch"), "thought");
  assert.equal(dsh.inferType("timeout_retry"), "error");
  assert.equal(dsh.inferType("未知新类型"), "thought"); // 保守兜底不丢数据
});

/* ---------- 统一入口自动识别 ---------- */

test("import：三种格式自动识别", () => {
  const r1 = io.parseTraceJson(JSON.stringify(A));
  assert.equal(r1.format, "native");
  assert.equal(r1.runs.length, 1);

  const r2 = io.parseTraceJson(JSON.stringify(otlp.toOTLP(A)));
  assert.equal(r2.format, "OTLP/GenAI");
  assert.equal(r2.runs.length, 1);

  const jsonl = JSON.stringify({ type: "thought", ts: 1, name: "x" }) + "\n" +
                JSON.stringify({ type: "llm_call", ts: 2, duration: 100, name: "y" });
  const r3 = io.parseTraceJson(jsonl);
  assert.equal(r3.format, "DSH-jsonl");
  assert.equal(r3.runs.length, 1);

  const r4 = io.parseTraceJson(JSON.stringify([{ type: "thought", name: "a" }]));
  assert.equal(r4.format, "DSH-array");

  const r5 = io.parseTraceJson('{"foo": 42}');
  assert.equal(r5.runs.length, 0);
  assert.ok(r5.errors.length > 0);
});
