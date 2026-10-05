/* 复现包 v2 测试：最小因果闭包 / 命令提取 / 分叉点处方 / 自验证 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const minimize = require("../src/analysis/minimize.js");
const repro = require("../src/export/repro.js");
const DATA = require("../data/sample.js");

const A = DATA.runs["run-a"];
const B = DATA.runs["run-b"];

/* ---------- 最小因果闭包 ---------- */

test("firstFailure 定位首个失败（a13 超时重试）", () => {
  const f = minimize.firstFailure(A.events);
  assert.equal(f.id, "a13");
});

test("最小因果闭包：因果封闭 + 最小性 + 失败签名保持", () => {
  const min = minimize.minimizeForFailure(A);
  assert.equal(min.target.id, "a13");
  // 闭包包含 a13 的全部祖先 + 自身，不含无关事件（a14+ 在其后发生）
  const ids = new Set(min.events.map((e) => e.id));
  assert.ok(ids.has("a01") && ids.has("a12") && ids.has("a13"));
  assert.ok(!ids.has("a14") && !ids.has("a18"), "失败之后的事件不应进入最小集");
  // 因果封闭：集合内每个事件的父都在集合内或为根
  for (const e of min.events) {
    for (const p of e.parents) assert.ok(ids.has(p), `${e.id} 的父 ${p} 不在闭包内`);
  }
  // 显著压缩
  assert.ok(min.reduction > 0.25, `压缩率 ${min.reduction}`);
  assert.equal(min.removedCount, min.originalCount - min.events.length);
});

test("无失败轨迹返回 null", () => {
  assert.equal(minimize.minimizeForFailure(B), null);
});

test("failureSignature：提取结构化错误标识", () => {
  const e = { type: "tool", status: "error", detail: "参数: {}\n错误 ToolError/exit_1: 3 failed" };
  assert.equal(minimize.failureSignature(e), "ToolError/exit_1");
  const plain = { type: "error", status: "error", detail: "timeout" };
  assert.equal(minimize.failureSignature(plain), "error:error");
});

/* ---------- 分叉点处方 ---------- */

test("forkPrescription：兄弟前缀优先", () => {
  // run-live 与自身共享前缀 → sibling 路径
  const p = minimize.forkPrescription(A, A);
  assert.equal(p.basis, "sibling-prefix");
  assert.equal(p.forkAfter, "a18");
  // 无共享前缀的兄弟 → 回退 failure-parent
  const p2 = minimize.forkPrescription(A, B);
  assert.equal(p2.basis, "failure-parent");
  assert.equal(p2.forkAfter, "a12", "a13 的父链末端为最后已知良好点");
  assert.equal(p2.divergenceAt, "a13");
});

/* ---------- 复现包生成 ---------- */

const fakeRun = {
  id: "run-cmd", label: "命令提取测试", strategy: "t",
  events: [
    { id: "s1", t: 0, dur: 100, type: "thought", name: "规划", parents: [], tokens: { in: 0, out: 0 }, status: "ok", detail: "" },
    { id: "t1", t: 100, dur: 500, type: "tool", name: "tool/bash", parents: ["s1"], tokens: { in: 0, out: 0 }, status: "ok", detail: "", args: "{\"cmd\":\"pytest -k pagination -x\"}" },
    { id: "t2", t: 600, dur: 800, type: "tool", name: "tool/bash", parents: ["t1"], tokens: { in: 0, out: 0 }, status: "error", detail: "错误 ToolError/exit_1: 3 failed", args: "{\"cmd\":\"pytest -q\"}", errorInfo: { name: "ToolError", code: "exit_1", reason: "3 failed" } },
    { id: "t3", t: 1400, dur: 200, type: "tool", name: "tool/read_file", parents: ["t2"], tokens: { in: 0, out: 0 }, status: "ok", detail: "", args: "{\"path\":\"a.py\"}" }
  ]
};

test("extractCommand：bash 命令可执行化，非命令工具返回 null", () => {
  assert.equal(repro.extractCommand(fakeRun.events[1]), "pytest -k pagination -x");
  assert.equal(repro.extractCommand(fakeRun.events[3]), null);
  assert.equal(repro.extractCommand({ args: "not-json" }), null);
  assert.equal(repro.extractCommand({}), null);
});

test("复现包五件套完整且内容正确", () => {
  const bundle = repro.buildReproBundle(fakeRun, { findings: [] }, { task: DATA.task, siblingRun: fakeRun });
  assert.ok(bundle.minJson && bundle.json && bundle.md && bundle.sh && bundle.verifySh);
  // 最小集：t2 失败链 = s1→t1→t2（t3 在其后）
  const min = JSON.parse(bundle.minJson);
  assert.equal(min.events.length, 3);
  assert.equal(min.signature, "ToolError/exit_1");
  // 脚本含 2 条真实命令 + 1 条注释
  assert.equal(bundle.extractedCommands, 2);
  assert.ok(bundle.sh.includes("(pytest -k pagination -x)"));
  assert.ok(bundle.sh.includes("(pytest -q)"));
  assert.ok(bundle.sh.includes("非命令类工具"));
  // 自验证脚本断言 exit_1
  assert.ok(bundle.verifySh.includes('grep -qF "exit_1"'));
  // 报告含分叉点处方与环境指纹
  assert.ok(bundle.md.includes("最后已知良好点"));
  assert.ok(bundle.md.includes('"model": "deepseek-reasoner"'));
  assert.ok(bundle.md.includes("最小复现集"));
});

test("无失败轨迹的复现包退化为完整轨迹 + 提示", () => {
  const bundle = repro.buildReproBundle(B, { findings: [] }, { task: DATA.task });
  assert.equal(bundle.minJson, null);
  assert.ok(bundle.md.includes("无失败事件"));
  assert.ok(bundle.verifySh.includes("无机器可验证的失败签名"));
});
