/* ============================================================
 * DSH 适配器 v3 升维测试：
 * 模型视角（surface replace）/ fork 谱系 / 完整性体检 / TTFT。
 * fixture 对齐 dsh-session@0.2.0-rc.2 真实信封语义。
 * ============================================================ */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const dsh = require("../src/io/dsh.js");
const trace = require("../src/model/trace.js");

const T0 = 1700000000000;
const ev = (type, seq, off, data, extra = {}) =>
  JSON.stringify({ type, seq, time: T0 + off, data, ...extra });

/* fork 子会话：继承前缀 3 事件 + surface replace + 未知事件 + seq 间隙 + 流式 TTFT */
const FORK_SESSION = [
  JSON.stringify({ type: "session", version: 4, id: "child-9z", createdAt: T0, isSeeded: true, parentSession: "parent-1a", delegationDepth: 1, agentPreset: "coder" }),
  ev("user/message", 0, 0, { content: "历史任务" }),
  ev("step/start", 1, 100, { turn: 1, step: 1 }),
  ev("assistant/message", 2, 5000, { turn: 1, step: 1, message: { content: "旧回复" }, stream: [] }),
  ev("session/end-seed", 3, 5100, { inherited: true }),                 // 继承切点
  ev("step/end", 4, 5150, { turn: 1, step: 1 }),
  ev("step/start", 5, 5200, { turn: 2, step: 1 }),
  ev("assistant/message", 6, 12000, { turn: 2, step: 1, message: { content: "压缩后摘要" }, stream: [{ time: T0 + 5600, chunk: "压" }, { time: T0 + 5900, chunk: "缩" }] },
     { surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] }), // surface 替换
  ev("future/feature-x", 7, 12100, {}),                                  // 未知必需事件
  ev("future/noise-y", 8, 12200, {}, { ignorable: true }),               // 未知可忽略
  ev("step/end", 10, 13000, { turn: 2, step: 1 }),                       // seq 9 缺失 → 间隙
  ev("turn/end", 11, 13100, { turn: 2, reason: "completed" })
].join("\n");

test("谱系：header 谱系元数据 + 继承前缀标记", () => {
  const run = dsh.parseDSH(FORK_SESSION);
  assert.equal(run.lineage.parent, "parent-1a");
  assert.equal(run.lineage.isSeeded, true);
  assert.equal(run.lineage.inheritedCut, 3);
  // 继承前缀（seq ≤ 3）的事件带 inherited 标记
  const inheritedEvents = run.events.filter((e) => e.inherited);
  assert.ok(inheritedEvents.length >= 3);
  assert.ok(inheritedEvents.every((e) => e.seq <= 3));
  // 切点之后的事件不标记
  assert.ok(!run.events.find((e) => e.id === "asst-6").inherited);
});

test("模型视角：replace 重放计算遮蔽集合", () => {
  const run = dsh.parseDSH(FORK_SESSION);
  assert.deepEqual(run.surface.shadowedSeqs.sort((a, b) => a - b), [1, 2]);
  assert.equal(run.surface.replacements.length, 1);
  assert.equal(run.surface.replacements[0].startSeq, 1);
  assert.ok(run.surface.finalSurfaceSize >= 2, "user/message + 替换后 assistant/message 仍在表面");
  // replace 事件详情携带遮蔽说明
  const asst = run.events.find((e) => e.id === "asst-6");
  assert.ok(asst.name.includes("surface 替换"));
  assert.ok(asst.detail.includes("seq 1..2"));
});

test("完整性体检：seq 间隙 + 未知事件 ignorable 分类", () => {
  const run = dsh.parseDSH(FORK_SESSION);
  assert.deepEqual(run.health.gaps, [[8, 10]]);
  assert.deepEqual(run.health.unknownRequired, ["future/feature-x"]);
  assert.equal(run.health.unknownIgnorable, 1);
});

test("TTFT：从流式记录提取首 token 延迟", () => {
  const run = dsh.parseDSH(FORK_SESSION);
  const asst = run.events.find((e) => e.id === "asst-6");
  // step-2.1 起点 5200，首条 stream 记录 5600 → TTFT 400ms
  assert.ok(asst.detail.includes("TTFT 400ms"), asst.detail);
});

test("官方词汇表完整性：59 类已知事件（与官方包逐一核对）", () => {
  assert.equal(dsh.KNOWN_SESSION_EVENT_TYPES.size, 59);
  for (const t of ["assistant/message", "tool/call", "compaction/prune", "session/end-seed", "subagent/catalog"]) {
    assert.ok(dsh.KNOWN_SESSION_EVENT_TYPES.has(t));
  }
});

test("整体可校验且 step 语义保持", () => {
  const run = dsh.parseDSH(FORK_SESSION);
  assert.ok(trace.validateRun(run).ok);
  const step = run.events.find((e) => e.id === "step-2.1");
  assert.equal(step.dur, 13000 - 5200);
});
