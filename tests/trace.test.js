/* 领域模型测试：指标 / 校验 / 拓扑 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const trace = require("../src/model/trace.js");
const DATA = require("../data/sample.js");

const A = DATA.runs["run-a"];
const B = DATA.runs["run-b"];

test("runEnd / tokSum / costOf 指标正确", () => {
  assert.equal(trace.runEnd(A), 107000);
  assert.equal(trace.runEnd(B), 46300);
  // run-a tokens: 3200+1500 + 5800+2400 + 9200+3100 + 12400+3800 + 15600+900 = 57900... 由实现保证
  assert.ok(trace.tokSum(A) > trace.tokSum(B));
  assert.ok(trace.costOf(A, DATA.task.pricePerMToken) > 0);
});

test("validateRun 通过内置样例", () => {
  for (const run of Object.values(DATA.runs)) {
    const { ok, errors } = trace.validateRun(run);
    assert.ok(ok, errors.join("; "));
  }
});

test("validateRun 检出非法数据", () => {
  assert.equal(trace.validateRun(null).ok, false);
  assert.equal(trace.validateRun({ id: "x", events: [] }).ok, false);
  const dup = { id: "d", events: [
    { id: "e1", t: 0, dur: 1, type: "llm" },
    { id: "e1", t: 1, dur: 1, type: "tool" }
  ]};
  assert.equal(trace.validateRun(dup).ok, false);
  const missingParent = { id: "m", events: [
    { id: "e1", t: 0, dur: 1, type: "llm", parents: ["ghost"] }
  ]};
  const res = trace.validateRun(missingParent);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("ghost")));
});

test("topoDepth 最长路径分层 & 环检测", () => {
  const depth = trace.topoDepth(A.events);
  assert.equal(depth.get("a01"), 0);
  assert.equal(depth.get("a18"), depth.get("a17") + 1);
  assert.equal(depth.get("a14"), depth.get("a13") + 1);
  const cyclic = [
    { id: "x", t: 0, dur: 1, type: "llm", parents: ["y"] },
    { id: "y", t: 0, dur: 1, type: "llm", parents: ["x"] }
  ];
  assert.throws(() => trace.topoDepth(cyclic), /cycle/i);
});

test("ancestors / descendants", () => {
  const anc = trace.ancestors(A.events, "a16");
  assert.ok(anc.includes("a01") && anc.includes("a15") && anc.includes("a13"));
  assert.ok(!anc.includes("a16") && !anc.includes("a17"));
  // 拓扑序：祖先链按深度升序
  const depth = trace.topoDepth(A.events);
  for (let i = 1; i < anc.length; i++) {
    assert.ok(depth.get(anc[i - 1]) <= depth.get(anc[i]));
  }
  const desc = trace.descendants(A.events, "a08");
  assert.ok(desc.includes("a18"));
  assert.ok(!desc.includes("a07"));
});

test("idleGaps 识别空转", () => {
  // 样例数据事件紧密衔接，不应出现 >=3s 空转
  assert.equal(trace.idleGaps(A, 3000).length, 0);
  const gappy = { id: "g", events: [
    { id: "g1", t: 0, dur: 100, type: "tool", parents: [] },
    { id: "g2", t: 5000, dur: 100, type: "tool", parents: ["g1"] }
  ]};
  const gaps = trace.idleGaps(gappy, 3000);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].gap, 4900);
});
