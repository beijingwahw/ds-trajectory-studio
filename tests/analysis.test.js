/* 分析引擎测试：规则触发 / 严重度排序 / 记忆化 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../src/analysis/engine.js");
const DATA = require("../data/sample.js");

const A = DATA.runs["run-a"];
const B = DATA.runs["run-b"];

test("Run A 触发预期规则", () => {
  const { findings } = engine.analyze(A);
  const ruleIds = new Set(findings.map((f) => f.ruleId));
  assert.ok(ruleIds.has("slow-step"), "应检出慢步骤");
  assert.ok(ruleIds.has("repeated-full-regression"), "应检出重复全量回归");
  assert.ok(ruleIds.has("context-bloat"), "应检出上下文膨胀");
  assert.ok(ruleIds.has("unstable-call"), "应检出不稳定调用");
  assert.ok(ruleIds.has("serial-llm-chain"), "应检出 LLM 串行链");
  assert.ok(ruleIds.has("error-amplification"), "应检出错误放大 (a13→a14)");
});

test("Run B 显著更少诊断且无高危循环", () => {
  const fa = engine.analyze(A).findings;
  const fb = engine.analyze(B).findings;
  assert.ok(fb.length < fa.length);
  assert.ok(!fb.some((f) => f.ruleId === "repeated-full-regression"));
  assert.ok(!fb.some((f) => f.ruleId === "unstable-call"));
});

test("诊断按严重度排序", () => {
  const order = { high: 0, mid: 1, low: 2 };
  const { findings } = engine.analyze(A);
  for (let i = 1; i < findings.length; i++) {
    assert.ok(order[findings[i - 1].sev] <= order[findings[i].sev]);
  }
});

test("bottleneckIds 覆盖关键事件", () => {
  const { bottleneckIds } = engine.analyze(A);
  for (const id of ["a07", "a11", "a16", "a14"]) {
    assert.ok(bottleneckIds.has(id), `${id} 应被标记为瓶颈`);
  }
});

test("记忆化：同签名返回同一引用", () => {
  engine.clearCache();
  const r1 = engine.analyze(A);
  const r2 = engine.analyze(A);
  assert.equal(r1, r2);
});

test("analyzeAsync 异步接口与同步结果一致", async () => {
  const sync = engine.analyze(A);
  const asyncRes = await engine.analyzeAsync(A);
  assert.deepEqual(asyncRes.findings, sync.findings);
});
