/* 关键路径（CPM）测试 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { criticalPath, SLACK_EPS } = require("../src/model/criticalpath.js");
const trace = require("../src/model/trace.js");
const DATA = require("../data/sample.js");

const A = DATA.runs["run-a"];

test("纯链事件全部零松弛", () => {
  const evs = [
    { id: "e1", t: 0, dur: 100, type: "llm", parents: [] },
    { id: "e2", t: 100, dur: 200, type: "tool", parents: ["e1"] },
    { id: "e3", t: 300, dur: 50, type: "tool", parents: ["e2"] }
  ];
  const { slack, path, criticalRatio } = criticalPath(evs);
  for (const e of evs) assert.ok(slack.get(e.id) <= SLACK_EPS);
  assert.deepEqual(path, ["e1", "e2", "e3"]);
  assert.equal(criticalRatio, 1);
});

test("并行分支的短支获得正松弛", () => {
  const evs = [
    { id: "root", t: 0, dur: 100, type: "llm", parents: [] },
    { id: "long", t: 100, dur: 900, type: "tool", parents: ["root"] },
    { id: "short", t: 100, dur: 100, type: "tool", parents: ["root"] },
    { id: "join", t: 1000, dur: 100, type: "tool", parents: ["long", "short"] }
  ];
  const { slack, path } = criticalPath(evs);
  assert.ok(slack.get("long") <= SLACK_EPS, "长支为关键路径");
  assert.ok(slack.get("short") > SLACK_EPS, "短支有松弛（800ms）");
  assert.equal(slack.get("short"), 800);
  assert.deepEqual(path, ["root", "long", "join"]);
});

test("样例 Run A：关键链因果连续、末端正确、前段间隙事件有正松弛", () => {
  const { slack, path, criticalDur, criticalRatio } = criticalPath(A.events, trace.runEnd(A));
  assert.ok(path.length > 0);
  assert.equal(path[path.length - 1], "a18", "末端事件（紧贴 runEnd）必在关键链上");
  // 前段存在调度间隙（a03→a04 80ms、a05→a06 50ms）→ a01 有正松弛，不在关键链
  assert.equal(slack.get("a01"), 130);
  assert.ok(!path.includes("a01"));
  assert.ok(path.includes("a06") && path.includes("a16"));
  // 链上相邻事件必须存在因果关系
  const byId = new Map(A.events.map((e) => [e.id, e]));
  for (let i = 1; i < path.length; i++) {
    assert.ok(byId.get(path[i]).parents.includes(path[i - 1]), `${path[i]} 应以 ${path[i - 1]} 为父`);
  }
  assert.ok(criticalRatio > 0.5, "串行 Agent 轨迹关键路径应占大头");
  assert.ok(criticalDur <= trace.runEnd(A));
  // 所有松弛非负
  for (const v of slack.values()) assert.ok(v >= 0);
});

test("观察类瞬时事件（dur=100ms）的松弛语义", () => {
  const { slack } = criticalPath(A.events, trace.runEnd(A));
  // a17 是 a18 的唯一父节点且紧贴其前 → 关键
  assert.ok(slack.get("a17") <= SLACK_EPS);
});
