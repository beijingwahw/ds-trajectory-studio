/* 轨迹 diff 测试：LCS 对齐 / 分叉区间 / 指标对比 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const diff = require("../src/analysis/diff.js");
const trace = require("../src/model/trace.js");
const DATA = require("../data/sample.js");

const A = DATA.runs["run-a"];
const B = DATA.runs["run-b"];

test("signature 归一化序号与策略修饰", () => {
  const e1 = { type: "tool", name: "run_test 全量套件 #2" };
  const e2 = { type: "tool", name: "run_test 全量套件" };
  assert.equal(diff.signature(e1), diff.signature(e2));
});

test("相同序列对齐为全 match", () => {
  const evs = trace.sorted(A);
  const al = diff.align(evs, evs);
  assert.ok(al.every((x) => x.status === "match"));
  assert.equal(diff.divergenceBlocks(al).length, 0);
});

test("A/B 对齐包含 match 与非 match", () => {
  const al = diff.align(trace.sorted(A), trace.sorted(B));
  const statuses = new Set(al.map((x) => x.status));
  assert.ok(statuses.has("match"));
  assert.ok(statuses.size > 1, "应存在分叉项");
  // 每条对齐项至少有一侧非空
  assert.ok(al.every((x) => x.a || x.b));
  // 「任务规划」应对齐为 match（两条 Run 的共同起点）
  assert.equal(al[0].status, "match");
  assert.equal(al[0].a.id, "a01");
  assert.equal(al[0].b.id, "b01");
});

test("分叉区间检测非空且结构正确", () => {
  const al = diff.align(trace.sorted(A), trace.sorted(B));
  const blocks = diff.divergenceBlocks(al);
  assert.ok(blocks.length >= 2, "A/B 应存在多个分叉区间");
  for (const b of blocks) {
    assert.ok(b.items.every((x) => x.status !== "match"), "分叉区间内不应有 match 项");
    assert.ok(b.kinds.length > 0);
  }
});

test("插入与删除事件正确分类", () => {
  const mkRun = (ids) => ids.map((id, i) => ({ id, t: i * 100, dur: 50, type: "tool", name: "step", parents: [] }));
  const base = mkRun(["x1", "x2", "x3"]);
  const withIns = mkRun(["y1", "y2", "y3"]);
  withIns.splice(1, 0, { id: "yNew", t: 150, dur: 50, type: "error", name: "unique-error", parents: [] });
  const al = diff.align(base, withIns);
  const ins = al.filter((x) => x.status === "ins");
  assert.equal(ins.length, 1);
  assert.equal(ins[0].b.id, "yNew");
});

test("metricRows 自动计算 Δ 与占优方", () => {
  const rows = diff.metricRows(A, B, DATA.task.pricePerMToken);
  const dur = rows.find((r) => r.name === "端到端耗时");
  assert.equal(dur.va, 107000);
  assert.equal(dur.vb, 46300);
  assert.equal(dur.delta, -60700);
  assert.equal(dur.betterA, false);
  const tok = rows.find((r) => r.name === "Token 总量");
  assert.ok(tok.va > tok.vb);
});
