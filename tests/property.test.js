/* ============================================================
 * 属性测试（Property-Based Testing 风格）：
 * 固定种子的随机 DAG 生成器 + 代数不变量断言。
 * 不验证具体数值，而验证「对任意合法输入都成立」的性质。
 * ============================================================ */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const util = require("../src/core/util.js");
const trace = require("../src/model/trace.js");
const layout = require("../src/model/layout.js");
const { criticalPath, SLACK_EPS } = require("../src/model/criticalpath.js");
const diff = require("../src/analysis/diff.js");
const engine = require("../src/analysis/engine.js");

/* 确定性随机源 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

/** 随机 DAG：n 节点，每节点至多 3 个父（仅指向更早节点 → 天然无环） */
function randomDag(n, rnd) {
  const types = trace.EVENT_TYPES;
  return Array.from({ length: n }, (_, i) => {
    const parentCount = i === 0 ? 0 : Math.floor(rnd() * 4);
    const parents = new Set();
    while (parents.size < Math.min(parentCount, i)) {
      parents.add(`n${Math.floor(rnd() * i)}`);
    }
    return {
      id: `n${i}`, t: i * 100 + Math.floor(rnd() * 50), dur: 50 + Math.floor(rnd() * 3000),
      type: types[Math.floor(rnd() * types.length)], name: `step ${i % 7}`,
      parents: [...parents], tokens: { in: Math.floor(rnd() * 15000), out: Math.floor(rnd() * 3000) },
      status: "ok", detail: ""
    };
  });
}

const RUNS = Array.from({ length: 40 }, (_, k) => {
  const rnd = lcg(1000 + k);
  return { id: `prop-${k}`, events: randomDag(5 + Math.floor(rnd() * 55), rnd) };
});

test("性质：任意随机 DAG 均通过 Schema 校验", () => {
  for (const run of RUNS) {
    assert.ok(trace.validateRun(run).ok, run.id);
  }
});

test("性质：拓扑深度 ∈ [0, n-1] 且父深度恒小于子深度", () => {
  for (const run of RUNS) {
    const depth = trace.topoDepth(run.events);
    for (const e of run.events) {
      assert.ok(depth.get(e.id) >= 0 && depth.get(e.id) < run.events.length);
      for (const p of e.parents) assert.ok(depth.get(p) < depth.get(e.id));
    }
  }
});

test("性质：祖先与后代集合互斥且不含自身", () => {
  for (const run of RUNS.slice(0, 10)) {
    for (const e of run.events.slice(0, 8)) {
      const anc = new Set(trace.ancestors(run.events, e.id));
      const desc = new Set(trace.descendants(run.events, e.id));
      assert.ok(!anc.has(e.id) && !desc.has(e.id));
      for (const x of anc) assert.ok(!desc.has(x), `${run.id}/${e.id}: 祖先=后代 → 隐含环`);
    }
  }
});

test("性质：布局坐标全局唯一", () => {
  for (const run of RUNS) {
    const { pos } = layout.layeredLayout(run.events);
    const seen = new Set();
    for (const { x, y } of pos.values()) {
      const key = `${x},${y}`;
      assert.ok(!seen.has(key), `${run.id}: 坐标冲突`);
      seen.add(key);
    }
  }
});

test("性质：关键路径 slack 非负、链因果连续、汇点松弛 = runEnd − ef", () => {
  for (const run of RUNS) {
    const end = trace.runEnd(run);
    const { slack, path } = criticalPath(run.events, end);
    for (const v of slack.values()) assert.ok(v >= -1e-9);
    const byId = new Map(run.events.map((e) => [e.id, e]));
    const hasChild = new Set(run.events.flatMap((e) => e.parents));
    for (const e of run.events) {
      if (!hasChild.has(e.id)) assert.equal(slack.get(e.id), Math.max(0, end - (e.t + e.dur)));
    }
    for (let i = 1; i < path.length; i++) {
      assert.ok(byId.get(path[i]).parents.includes(path[i - 1]));
      assert.ok(slack.get(path[i]) <= SLACK_EPS);
    }
  }
});

test("性质：比对长度 ≥ max(n,m) 且 match 保序", () => {
  for (let k = 0; k < 10; k++) {
    const a = RUNS[k].events, b = RUNS[k + 20].events;
    const al = diff.align(a, b);
    assert.ok(al.length >= Math.max(a.length, b.length));
    assert.ok(al.every((x) => x.a || x.b));
    const pairs = al.filter((x) => x.a && x.b);
    for (let i = 1; i < pairs.length; i++) {
      assert.ok(a.indexOf(pairs[i - 1].a) < a.indexOf(pairs[i].a), "A 侧保序");
      assert.ok(b.indexOf(pairs[i - 1].b) < b.indexOf(pairs[i].b), "B 侧保序");
    }
  }
});

test("性质：jaccard 对称且有界", () => {
  const names = RUNS.flatMap((r) => r.events.map((e) => e.name)).slice(0, 60);
  for (let i = 0; i < names.length; i++) {
    for (let j = i; j < names.length; j++) {
      const s1 = util.jaccard(names[i], names[j]);
      const s2 = util.jaccard(names[j], names[i]);
      assert.ok(Math.abs(s1 - s2) < 1e-12);
      assert.ok(s1 >= 0 && s1 <= 1);
    }
  }
});

test("性质：分析引擎对任意随机轨迹不抛错且结果按严重度有序", () => {
  const order = { high: 0, mid: 1, low: 2 };
  for (const run of RUNS) {
    const { findings } = engine.analyze(run);
    for (let i = 1; i < findings.length; i++) {
      assert.ok(order[findings[i - 1].sev] <= order[findings[i].sev]);
    }
  }
});
