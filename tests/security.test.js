/* ============================================================
 * 安全测试套件：XSS 攻击面审计。
 * 威胁模型：导入的轨迹是完全不可信输入 —— 事件名称/详情/id
 * 可携带任意注入载荷，所有渲染路径必须经过转义。
 * ============================================================ */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const util = require("../src/core/util.js");
const report = require("../src/export/report.js");
const engine = require("../src/analysis/engine.js");
const trace = require("../src/model/trace.js");

/* 经典 XSS 载荷库（OWASP cheat sheet 子集） */
const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '"><script>alert(1)</script>',
  "javascript:alert(1)",
  '<a href="javascript:alert(1)">x</a>',
  '<iframe src="javascript:alert(1)">',
  '{{constructor.constructor("alert(1)")()}}',
  '<style>*{background:url("javascript:alert(1)")}</style>',
  '"/><img src=x onerror=alert(1)//'
];

test("esc 中和全部 XSS 载荷", () => {
  for (const p of PAYLOADS) {
    const out = util.esc(p);
    assert.ok(!out.includes("<script"), p);
    assert.ok(!out.includes("<img"), p);
    assert.ok(!out.includes("<svg"), p);
    assert.ok(!out.includes("<iframe"), p);
    assert.ok(!/<[a-z]/i.test(out.replace(/&lt;/g, "")), `残留尖括号: ${out}`);
  }
});

test("mdToHtml 对含载荷的 Markdown 输出无活标签", () => {
  for (const p of PAYLOADS) {
    const html = report.mdToHtml(`# 标题 ${p}\n\n| ${p} | b |\n|---|---|\n| 1 | 2 |`);
    // 判定标准：不存在「活标签」（未被转义的 <tag），
    // 转义后的字面文本（如 &lt;img...&gt;）是安全的展示内容
    assert.ok(!/<script/i.test(html), p);
    assert.ok(!/<img/i.test(html), p);
    assert.ok(!/<svg/i.test(html), p);
    assert.ok(!/<iframe/i.test(html), p);
    assert.ok(!/<style/i.test(html), p);
  }
});

test("恶意轨迹可通过 Schema 校验但分析引擎不执行任何字符串", () => {
  const evil = {
    id: "evil<b>",
    events: [{
      id: 'e1<img src=x onerror=alert(1)>', t: 0, dur: 100, type: "llm",
      name: '<svg onload=alert(1)>', parents: [],
      tokens: { in: 1, out: 1 }, status: "ok", detail: "javascript:alert(1)"
    }]
  };
  // Schema 校验不拒绝特殊字符（字符本身合法），安全责任在渲染层转义
  const { ok } = trace.validateRun(evil);
  assert.ok(ok);
  // 分析引擎将字符串视为纯数据，不产生异常
  const res = engine.analyze(evil);
  assert.ok(res.runEnd === 100);
  // 报告导出同样转义
  const DATA_MOCK = { task: { title: "t", repo: "r", model: "m", harnessVersion: "1", pricePerMToken: { in: 1, out: 1 } }, runs: { a: evil, b: evil }, pluginVersion: "t" };
  const html = report.buildHtml(report.buildMarkdown(DATA_MOCK, evil, res), "t");
  assert.ok(!html.includes("<img src=x onerror"));
});

test("esc 双向不可逆：转义后再次转义不会还原载荷", () => {
  const once = util.esc("<script>");
  assert.equal(util.esc(once), "&amp;lt;script&amp;gt;");
});
