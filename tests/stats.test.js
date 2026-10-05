/* 稳健统计 + 布局 + 相似度测试 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const util = require("../src/core/util.js");
const layout = require("../src/model/layout.js");
const diff = require("../src/analysis/diff.js");
const DATA = require("../data/sample.js");

const A = DATA.runs["run-a"];

test("median / percentile", () => {
  assert.equal(util.median([1, 3, 5]), 3);
  assert.equal(util.median([1, 2, 3, 4]), 2.5);
  assert.equal(util.percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(util.percentile([10, 20], 95), 19.5);
  assert.equal(util.percentile([], 95), 0);
});

test("madStats 修正 Z 分数抗极端值", () => {
  // 重尾分布：一个极大异常值不应扭曲对其它大值的判断
  const arr = [100, 110, 120, 130, 140, 150, 160, 10000];
  const { median, mad, modifiedZ } = util.madStats(arr);
  assert.equal(median, 135);
  assert.ok(mad > 0);
  assert.ok(modifiedZ(10000) > 3.5, "极端值应被检出");
  assert.ok(modifiedZ(150) < 3.5, "正常大值不应误报");
  // 全相同值时 mad=0 不抛错
  assert.equal(util.madStats([5, 5, 5]).modifiedZ(5), 0);
});

test("jaccard 名称相似度", () => {
  assert.equal(util.jaccard("生成修复方案 v1", "生成修复方案 v1"), 1);
  assert.ok(util.jaccard("生成修复方案 v1", "修复方案 v2 生成") > 0.4);
  assert.equal(util.jaccard("run_test", "read_file"), 0);
  assert.equal(util.jaccard("", ""), 1);
});

test("layeredLayout：全部事件定位且确定性", () => {
  const l1 = layout.layeredLayout(A.events);
  const l2 = layout.layeredLayout(A.events);
  assert.equal(l1.pos.size, A.events.length);
  assert.deepEqual([...l1.pos.entries()], [...l2.pos.entries()], "两次布局应完全一致");
  // 层内无重叠坐标
  const seen = new Set();
  for (const { x, y } of l1.pos.values()) {
    const key = `${x},${y}`;
    assert.ok(!seen.has(key), `坐标冲突 ${key}`);
    seen.add(key);
  }
  assert.ok(l1.crossings >= 0);
});

test("barycenter 排序不劣于输入序（交叉不增加）", () => {
  // 构造一个明显可优化交叉的图：两层，边交叉排列
  const events = [
    { id: "p1", t: 0, dur: 1, type: "llm", parents: [] },
    { id: "p2", t: 0, dur: 1, type: "llm", parents: [] },
    { id: "c1", t: 10, dur: 1, type: "tool", parents: ["p2"] },
    { id: "c2", t: 10, dur: 1, type: "tool", parents: ["p1"] }
  ];
  const res = layout.layeredLayout(events);
  assert.equal(res.crossings, 0, "barycenter 应消除可避免的交叉");
});

test("NW 比对：语义相近步骤对齐为 sub 而非 del+ins", () => {
  const mk = (id, type, name) => ({ id, t: 0, dur: 1, type, name, parents: [] });
  const al = diff.align(
    [mk("a1", "llm", "生成修复方案 v1")],
    [mk("b1", "llm", "修复方案 v2 生成")]
  );
  assert.equal(al.length, 1, "应配对而非拆成两个独立事件");
  assert.equal(al[0].status, "sub");
  assert.ok(al[0].score > 0.45);
});

test("similarity：签名等价 = 1，跨类型相似度受限", () => {
  const e1 = { type: "tool", name: "run_test 全量套件 #3" };
  const e2 = { type: "tool", name: "run_test 全量套件" };
  assert.equal(diff.similarity(e1, e2), 1);
  const e3 = { type: "llm", name: "run_test" };
  assert.ok(diff.similarity(e1, e3) < 1);
});
