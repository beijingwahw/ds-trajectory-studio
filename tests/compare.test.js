/* 对比分析 v2 算法测试：相似度 / 影响量化 / 累积曲线 / 同源前缀 / 差分对 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const diff = require("../src/analysis/diff.js");
const trace = require("../src/model/trace.js");
const DATA = require("../data/sample.js");

const A = DATA.runs["run-a"];
const B = DATA.runs["run-b"];
const AL = diff.align(trace.sorted(A), trace.sorted(B));

test("alignmentScore：自身=1，A/B ∈ (0.2, 0.9)，对称", () => {
  const alSame = diff.align(trace.sorted(A), trace.sorted(A));
  assert.equal(diff.alignmentScore(alSame), 1);
  const s = diff.alignmentScore(AL);
  assert.ok(s > 0.2 && s < 0.9, `score=${s}`);
  const sRev = diff.alignmentScore(diff.align(trace.sorted(B), trace.sorted(A)));
  assert.ok(Math.abs(s - sRev) < 0.15, "交换方向应近似对称");
});

test("blockImpact：量化分叉区间的耗时/token Δ", () => {
  const blocks = diff.divergenceBlocks(AL);
  assert.ok(blocks.length >= 2);
  for (const b of blocks) {
    const imp = diff.blockImpact(b);
    assert.equal(imp.dDur, imp.durB - imp.durA);
    assert.equal(imp.dTok, imp.tokB - imp.tokA);
  }
  // 全量测试策略分叉：A 侧多轮全量回归，Δ 应为显著负值（B 更快）
  const totalImpact = blocks.reduce((s, b) => s + diff.blockImpact(b).dDur, 0);
  assert.ok(totalImpact < 0, `总 Δ 应为负（B 省时），实际 ${totalImpact}`);
});

test("cumulativeSeries：单调不减且终点=总量", () => {
  const pts = diff.cumulativeSeries(A.events, (e) => e.tokens.in + e.tokens.out);
  assert.equal(pts[0][1], 0);
  assert.equal(pts.at(-1)[1], trace.tokSum(A));
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i][1] >= pts[i - 1][1], "累积值单调不减");
    assert.ok(pts[i][0] >= pts[i - 1][0], "墙钟单调不减");
  }
});

test("sharedPrefix：检测共同祖先前缀", () => {
  assert.equal(diff.sharedPrefix(A.events, A.events), A.events.length);
  // 构造 fork 兄弟：前 3 事件完全相同
  const mk = (ids) => ids.map((id, i) => ({ id, t: i * 100, dur: 10, type: "tool", name: id, parents: [], tokens: { in: 0, out: 0 } }));
  assert.equal(diff.sharedPrefix(mk(["x", "y", "z", "a1"]), mk(["x", "y", "z", "b1"])), 3);
  assert.equal(diff.sharedPrefix(mk(["x", "y"]), mk(["p", "q"])), 0);
});

test("pairDeltas：对齐对 Δ 与样例预期一致", () => {
  const pairs = diff.pairDeltas(AL);
  assert.ok(pairs.length > 0);
  assert.ok(pairs.every((p) => p.dDur === p.b.dur - p.a.dur));
  // 全量测试对（a07↔b08）B 更快 → 负 Δ
  const testPair = pairs.find((p) => /run_test/.test(p.a.name) && /run_test/.test(p.b.name));
  assert.ok(testPair && testPair.dDur < 0);
});

test("metricRows 方向感知：缓存命中是 max 方向", () => {
  const rows = diff.metricRows(A, B, DATA.task.pricePerMToken);
  const cache = rows.find((r) => r.name === "KV 缓存命中");
  // run-a 缓存 20000 > run-b 11000 → betterA 应为 true（max 方向）
  assert.equal(cache.betterA, true);
  const dur = rows.find((r) => r.name === "端到端耗时");
  assert.equal(dur.betterA, false);
});
