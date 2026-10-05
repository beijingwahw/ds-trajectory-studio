/* 链式压缩 + KV 缓存成本模型测试 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const layout = require("../src/model/layout.js");
const trace = require("../src/model/trace.js");
const otlp = require("../src/io/otlp.js");
const dsh = require("../src/io/dsh.js");

const mkChain = (n, prefix = "c") =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`, t: i * 100, dur: 80, type: "tool", name: `step${i}`,
    parents: i === 0 ? [] : [`${prefix}${i - 1}`],
    tokens: { in: 10, out: 5 }, status: "ok", detail: ""
  }));

test("compressChains：10 节点纯链 → 首/尾保留 + 中段聚合", () => {
  const { events, mapping } = layout.compressChains(mkChain(10), 6);
  // 链首 c0（无父）与链尾 c9（无子）不属于「严格中段」，保留；c1..c8 聚合
  assert.equal(events.length, 3);
  const agg = events.find((e) => e.aggregate);
  assert.equal(agg.aggregate.length, 8);
  assert.equal(mapping.size, 1);
  // 聚合时长覆盖中段（c1.t=100 → c8.end=880）
  assert.equal(agg.dur, 780);
  // token 加和
  assert.equal(agg.tokens.in, 80);
  // 边正确重挂：聚合节点父为 c0，c9 父为聚合节点
  assert.deepEqual(agg.parents, ["c0"]);
  assert.deepEqual(events.find((e) => e.id === "c9").parents, [agg.id]);
  // 压缩后仍通过 Schema 校验
  assert.ok(trace.validateRun({ id: "x", events }).ok);
});

test("compressChains：短链不压缩，分支结构完整保留", () => {
  const events = [
    ...mkChain(3, "s"),                    // 3 节点短链 → 保留
    { id: "root", t: 500, dur: 50, type: "llm", name: "r", parents: [], tokens: { in: 0, out: 0 }, status: "ok", detail: "" },
    { id: "b1", t: 600, dur: 50, type: "tool", name: "b1", parents: ["root"], tokens: { in: 0, out: 0 }, status: "ok", detail: "" },
    { id: "b2", t: 600, dur: 50, type: "tool", name: "b2", parents: ["root"], tokens: { in: 0, out: 0 }, status: "ok", detail: "" }
  ];
  const { events: out, mapping } = layout.compressChains(events, 6);
  assert.equal(mapping.size, 0);
  assert.equal(out.length, events.length);
});

test("compressChains：压缩点两侧边正确重挂", () => {
  const events = [
    { id: "head", t: 0, dur: 50, type: "llm", name: "h", parents: [], tokens: { in: 0, out: 0 }, status: "ok", detail: "" },
    ...mkChain(8).map((e) => ({ ...e, parents: e.id === "c0" ? ["head"] : e.parents })),
    { id: "tail", t: 1000, dur: 50, type: "llm", name: "t", parents: ["c7"], tokens: { in: 0, out: 0 }, status: "ok", detail: "" }
  ];
  const { events: out } = layout.compressChains(events, 6);
  assert.equal(out.length, 3); // head + agg + tail
  const agg = out.find((e) => e.aggregate);
  const tail = out.find((e) => e.id === "tail");
  assert.deepEqual(agg.parents, ["head"]);
  assert.deepEqual(tail.parents, [agg.id], "tail 应重挂到聚合节点");
  assert.ok(trace.validateRun({ id: "x", events: out }).ok);
  // 布局在压缩图上正常工作
  const l = layout.layeredLayout(out);
  assert.equal(l.pos.size, 3);
});

test("成本模型：缓存命中按折扣价计费", () => {
  const price = { in: 2, out: 8, cacheIn: 0.5 };
  const run = { id: "c", events: [
    { id: "e1", t: 0, dur: 1, type: "llm", parents: [], tokens: { in: 10000, out: 1000, cacheIn: 8000 }, status: "ok", detail: "" }
  ]};
  // (10000-8000)*2 + 8000*0.5 + 1000*8 = 4000+4000+8000 = 16000 / 1e6
  assert.equal(trace.costOf(run, price), 0.016);
  assert.equal(trace.cacheHitRate(run), 0.8);
  // 无 cacheIn 价格时回退到全价输入
  assert.equal(trace.costOf(run, { in: 2, out: 8 }), 0.028);
});

test("OTLP：缓存字段解析与往返保留", () => {
  const run = { id: "r", label: "r", events: [
    { id: "e1", t: 0, dur: 100, type: "llm", name: "chat", parents: [], tokens: { in: 5000, out: 500, cacheIn: 4000 }, status: "ok", detail: "" }
  ]};
  const back = otlp.parseOTLP(otlp.toOTLP(run), "rt");
  assert.equal(back.events[0].tokens.cacheIn, 4000);
});

test("DSH：缓存同义字段归一", () => {
  const run = dsh.parseDSH([
    { type: "llm_call", ts: 1, duration: 10, usage: { input_tokens: 100, cache_read_input_tokens: 80 } }
  ], "d");
  assert.equal(run.events[0].tokens.cacheIn, 80);
});
