/* ============================================================
 * 真实 DSH Session JSONL v4 格式测试。
 * fixture 结构对齐 @deepseek-ai/dsh-session@0.2.0-rc.2 的
 * SessionEventMap（header + turn/step/assistant/tool/compaction/retry）。
 * ============================================================ */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const dsh = require("../src/io/dsh.js");
const trace = require("../src/model/trace.js");

const T0 = 1700000000000;
const line = (type, seq, timeOffset, data) =>
  JSON.stringify({ type, seq, time: T0 + timeOffset, data });

/** 真实结构的最小完整 session */
const SESSION_JSONL = [
  JSON.stringify({ type: "session", version: 4, id: "sess-abc123", createdAt: T0, cwd: "/home/dev/demo", isSeeded: false, delegationDepth: 0, agentPreset: "coder" }),
  line("turn/start", 0, 0, { turn: 1 }),
  line("user/message", 1, 50, { content: "修复分页 bug", source: "human" }),
  line("step/start", 2, 100, { turn: 1, step: 1 }),
  line("assistant/message", 3, 8400, { turn: 1, step: 1, message: { content: "我先读代码" }, stream: [], usage: { inputTokens: 5200, outputTokens: 800, cacheReadTokens: 4000, reasoningTokens: 300 } }),
  line("tool/call", 4, 8500, { turn: 1, step: 1, callId: "call_1", name: "read_file", arguments: "{\"path\":\"paginate.py\"}" }),
  line("tool/result", 5, 9000, { turn: 1, step: 1, message: { toolCallId: "call_1", content: "..." } }),
  line("tool/call", 6, 9100, { turn: 1, step: 1, callId: "call_2", name: "bash", arguments: "{\"cmd\":\"pytest\"}" }),
  line("tool/result", 7, 12000, { turn: 1, step: 1, message: { toolCallId: "call_2", isError: true }, error: { name: "ToolError", code: "exit_1", reason: "3 failed" } }),
  line("assistant/attempt", 8, 15000, { turn: 1, step: 1, stream: [] }),
  line("llm/retry-started", 9, 15200, { turn: 1, step: 1, attempt: 2 }),
  line("compaction/start", 10, 16000, { reason: "threshold" }),
  line("compaction/end", 11, 16200, { pruned: 12 }),
  line("step/end", 12, 16500, { turn: 1, step: 1 }),
  line("turn/end", 13, 16600, { turn: 1, reason: "completed" }),
  line("request/header", 14, 100, { header: {}, reason: "init" }) // 纯日志 → 跳过
].join("\n");

test("识别 session header 并走 v4 路径", () => {
  assert.ok(dsh.isSessionHeader({ type: "session", version: 4 }));
  assert.ok(!dsh.isSessionHeader({ type: "thought" }));
  const run = dsh.parseDSH(SESSION_JSONL);
  assert.equal(run.id, "dsh-sess-abc123");
  assert.ok(run.label.includes("DSH 会话"));
  assert.ok(run.strategy.includes("coder"));
  assert.ok(trace.validateRun(run).ok);
});

test("step 区间重建 + step 事件作为容器父节点", () => {
  const run = dsh.parseDSH(SESSION_JSONL);
  const step = run.events.find((e) => e.id === "step-1.1");
  assert.ok(step, "应生成 step 容器事件");
  assert.equal(step.t, 100);
  assert.equal(step.dur, 16500 - 100, "step 时长 = step/end − step/start");
  // step 内事件挂在 step 上
  const asst = run.events.find((e) => e.type === "llm" && e.name.includes("模型响应"));
  assert.deepEqual(asst.parents, ["step-1.1"]);
});

test("TokenUsage 真实字段映射（含 cacheRead/reasoning）", () => {
  const run = dsh.parseDSH(SESSION_JSONL);
  const asst = run.events.find((e) => e.id === "asst-3");
  assert.equal(asst.tokens.in, 5200);
  assert.equal(asst.tokens.out, 800);
  assert.equal(asst.tokens.cacheIn, 4000);
  assert.ok(asst.detail.includes("reasoning 300"));
  assert.equal(trace.cacheHitRate(run) > 0.7, true);
});

test("tool/call 按 callId 配对 result 计算耗时与错误", () => {
  const run = dsh.parseDSH(SESSION_JSONL);
  const t1 = run.events.find((e) => e.name === "tool/read_file");
  const t2 = run.events.find((e) => e.name === "tool/bash");
  assert.equal(t1.dur, 500);
  assert.equal(t1.status, "ok");
  assert.equal(t2.dur, 12000 - 9100);
  assert.equal(t2.status, "error");
  assert.ok(t2.detail.includes("ToolError"));
  assert.ok(t2.detail.includes("3 failed"));
});

test("attempt/retry/compaction 类型映射 + 纯日志跳过计数", () => {
  const run = dsh.parseDSH(SESSION_JSONL);
  assert.ok(run.events.some((e) => e.id.startsWith("attempt-") && e.status === "error"));
  assert.ok(run.events.some((e) => e.type === "error" && e.name.includes("重试")));
  assert.ok(run.events.some((e) => e.name.includes("上下文压缩")));
  assert.ok(run.label.includes("跳过"), "纯日志事件应计数展示");
  // tool/result、turn/*、request/* 不产生独立事件
  assert.ok(!run.events.some((e) => e.name.startsWith("request/")));
});

test("runEnd 覆盖到最后一个可视化事件（step 容器结束）", () => {
  const run = dsh.parseDSH(SESSION_JSONL);
  // turn/end（16600）为边界标记不产生事件；可视化终点 = step 容器结束（16500）
  assert.equal(trace.runEnd(run), 16500);
});

test("legacy 路径向后兼容（无 header 的 JSONL）", () => {
  const jsonl = JSON.stringify({ type: "llm_call", ts: 1, duration: 100, usage: { inputTokens: 50 } }) + "\n" +
                JSON.stringify({ type: "tool_exec", ts: 200, duration: 50 });
  const run = dsh.parseDSH(jsonl, "legacy-1");
  assert.equal(run.id, "legacy-1");
  assert.equal(run.events[0].tokens.in, 50);
  assert.ok(trace.validateRun(run).ok);
});
