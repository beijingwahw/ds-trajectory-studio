/* 工具层 + 报告生成测试 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const util = require("../src/core/util.js");
const report = require("../src/export/report.js");
const engine = require("../src/analysis/engine.js");
const DATA = require("../data/sample.js");

test("esc 防注入", () => {
  assert.equal(util.esc('<script>"x"</script>'), "&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
  assert.equal(util.esc("a'b"), "a&#39;b");
});

test("fmtMs / fmtTok / fmtPct", () => {
  assert.equal(util.fmtMs(500), "500ms");
  assert.equal(util.fmtMs(17500), "17.5s");
  assert.equal(util.fmtTok(900), "900");
  assert.equal(util.fmtTok(12400), "12.4k");
  assert.equal(util.fmtPct(0.473), "47%");
});

test("meanStd", () => {
  const { mean, std } = util.meanStd([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(mean, 5);
  assert.equal(std, 2);
  assert.deepEqual(util.meanStd([]), { mean: 0, std: 0 });
});

test("niceTicks 生成整数刻度且覆盖上限", () => {
  const ticks = util.niceTicks(107000, 10);
  assert.ok(ticks.every((t) => Number.isInteger(t)));
  assert.ok(ticks[ticks.length - 1] >= 100000);
  assert.ok(ticks.length <= 25);
  assert.deepEqual(util.niceTicks(0), [0]);
});

test("报告 Markdown 包含关键章节", () => {
  const run = DATA.runs["run-a"];
  const md = report.buildMarkdown(DATA, run, engine.analyze(run));
  for (const section of ["# DS Trajectory Studio 调试报告", "## 瓶颈诊断", "## 事件轨迹", "## 分支对比", "repeated-full-regression"]) {
    assert.ok(md.includes(section), `缺少章节: ${section}`);
  }
});

test("mdToHtml 转换标题/表格/加粗", () => {
  const html = report.mdToHtml("# 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n**粗体**");
  assert.ok(html.includes("<h1>标题</h1>"));
  assert.ok(html.includes("<table>") && html.includes("<td>1</td>"));
  assert.ok(html.includes("<b>粗体</b>"));
  // 表格分隔行不应进入输出
  assert.ok(!html.includes("---"));
});
