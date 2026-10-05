/* 语料库算法测试：多代合并 / 去重 / 谱系森林 / 指标行 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const corpus = require("../src/io/corpus.js");

const mkEvent = (id, seq, t = 0) => ({
  id, seq, t, dur: 100, type: "tool", name: id, parents: [],
  tokens: { in: 10, out: 5 }, status: "ok", detail: ""
});
const mkRun = (id, events, lineage = null) => ({
  id, label: id, events, lineage,
  result: "success", strategy: "t", branch: ""
});

test("mergeGenerations：同会话多代按 seq 合并，后到的代覆盖", () => {
  const gen1 = mkRun("dsh-sess1", [mkEvent("a", 0), mkEvent("b-old", 1, 100)], { parent: null, isSeeded: false, depth: 0, inheritedCut: -1 });
  const gen2 = mkRun("dsh-sess1", [mkEvent("b-new", 1, 100), mkEvent("c", 2, 200)], { parent: null, isSeeded: false, depth: 0, inheritedCut: -1 });
  const other = mkRun("run-x", [mkEvent("z", 0)]);
  const { runs, merges } = corpus.mergeGenerations([gen1, gen2, other]);
  assert.equal(runs.length, 2);
  const merged = runs.find((r) => r.id === "dsh-sess1");
  assert.equal(merged.events.length, 3, "a + b(覆盖) + c");
  assert.ok(merged.events.some((e) => e.id === "b-new"), "后到的代覆盖同 seq");
  assert.ok(!merged.events.some((e) => e.id === "b-old"));
  assert.equal(merged.generations, 2);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].generations, 2);
});

test("dedupeRuns：同签名去重", () => {
  const r1 = mkRun("r1", [mkEvent("a", 0)]);
  const r1copy = mkRun("r1", [mkEvent("a", 0)]);
  const r2 = mkRun("r2", [mkEvent("b", 0, 500)]);
  const { kept, dupes } = corpus.dedupeRuns([r1, r1copy, r2]);
  assert.equal(kept.length, 2);
  assert.deepEqual(dupes, ["r1"]);
});

test("buildLineageForest：家族树 + 悬挂根标记 + 深度", () => {
  const parent = mkRun("dsh-p1", [mkEvent("a", 0)], { parent: null, isSeeded: false, depth: 0, inheritedCut: -1 });
  const child = mkRun("dsh-c1", [mkEvent("b", 0)], { parent: "p1", isSeeded: true, depth: 1, inheritedCut: 3 });
  const grand = mkRun("dsh-g1", [mkEvent("c", 0)], { parent: "c1", isSeeded: true, depth: 2, inheritedCut: 5 });
  const orphan = mkRun("dsh-o1", [mkEvent("d", 0)], { parent: "missing-parent", isSeeded: true, depth: 1, inheritedCut: 2 });
  const free = mkRun("run-free", [mkEvent("e", 0)]);
  const forest = corpus.buildLineageForest([parent, child, grand, orphan, free]);
  assert.deepEqual(forest.children.get("dsh-p1"), ["dsh-c1"]);
  assert.deepEqual(forest.children.get("dsh-c1"), ["dsh-g1"]);
  assert.equal(forest.depthOf.get("dsh-p1"), 0);
  assert.equal(forest.depthOf.get("dsh-c1"), 1);
  assert.equal(forest.depthOf.get("dsh-g1"), 2);
  // 父未导入 → 悬挂根
  assert.ok(forest.dangling.has("dsh-o1"));
  assert.ok(forest.roots.includes("dsh-o1") && forest.roots.includes("run-free"));
});

test("corpusMetrics：指标行完整", () => {
  const run = mkRun("r1", [
    mkEvent("a", 0),
    { ...mkEvent("b", 1, 200), type: "error", status: "error", tokens: { in: 1000, out: 100, cacheIn: 800 } }
  ], { parent: "p", isSeeded: true, depth: 2, inheritedCut: 1 });
  run.health = { gaps: [], unknownRequired: [], unknownIgnorable: 0 };
  const m = corpus.corpusMetrics(run, { in: 2, out: 8, cacheIn: 0.5 });
  assert.equal(m.events, 2);
  assert.equal(m.errors, 1);
  assert.equal(m.health, "ok");
  assert.equal(m.isSeeded, true);
  assert.equal(m.lineageDepth, 2);
  assert.ok(m.cacheHit > 0);
});
