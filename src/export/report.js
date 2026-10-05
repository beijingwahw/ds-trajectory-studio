// @ts-check
/* ============================================================
 * DS Trajectory Studio — export/report
 * 调试报告生成：Markdown 源 + 自包含 HTML（内嵌迷你 md 渲染器，
 * 支持标题/表格/列表/粗体/引用/代码，零外部依赖）。
 * ============================================================ */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const util = isNode ? require("../core/util.js") : /** @type {any} */ (root).DSTS.util;
  const trace = isNode ? require("../model/trace.js") : /** @type {any} */ (root).DSTS.trace;
  const diff = isNode ? require("../analysis/diff.js") : /** @type {any} */ (root).DSTS.diff;
  const api = factory(util, trace, diff);
  if (isNode) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.report = api; }
})(typeof self !== "undefined" ? self : globalThis, function (util, trace, diff) {
  "use strict";

  const TYPE_LABEL = { llm: "LLM 推理", tool: "工具调用", thought: "思考规划", observation: "观察结果", error: "异常/重试" };
  const SEV_LABEL = { high: "高", mid: "中", low: "低" };

  function buildMarkdown(data, run, analysis) {
    const price = data.task.pricePerMToken;
    const [idA, idB] = Object.keys(data.runs);
    const A = data.runs[idA], B = data.runs[idB];
    let md = `# DS Trajectory Studio 调试报告

> 生成时间：${new Date().toLocaleString("zh-CN")} · Harness v${data.task.harnessVersion} · 插件 v${data.pluginVersion || "?"}

## 任务
- **${data.task.title}**
- 仓库：${data.task.repo} · 模型：${data.task.model}

## 当前 Run：${run.label || run.id}（${run.strategy || "—"}）
| 指标 | 值 |
|---|---|
| 端到端耗时 | ${util.fmtMs(trace.runEnd(run))} |
| 事件数 | ${run.events.length} |
| Token 总量 | ${util.fmtTok(trace.tokSum(run))} |
| 估算成本 | ¥${trace.costOf(run, price).toFixed(3)} |
| 结果 | ${run.result || "—"} |

## 瓶颈诊断（静态分析规则引擎）
`;
    if (!analysis.findings.length) md += "未发现瓶颈。\n";
    analysis.findings.forEach((f, i) => {
      md += `${i + 1}. **[${SEV_LABEL[f.sev]}] ${f.title}**（${f.ev} · 规则 ${f.ruleId}）\n   - ${f.desc}\n   - 建议：${f.fix}\n`;
    });

    md += `\n## 事件轨迹\n| ID | 类型 | 名称 | 开始 | 耗时 | Tokens(in/out) | 状态 |\n|---|---|---|---|---|---|---|\n`;
    for (const e of trace.sorted(run)) {
      md += `| ${e.id} | ${TYPE_LABEL[e.type]} | ${e.name} | ${util.fmtMs(e.t)} | ${util.fmtMs(e.dur)} | ${e.tokens.in}/${e.tokens.out} | ${e.status} |\n`;
    }

    if (A && B && A !== B) {
      const rows = diff.metricRows(A, B, price);
      md += `\n## 分支对比\n| 指标 | ${A.label || A.id} | ${B.label || B.id} | Δ |\n|---|---|---|---|\n`;
      for (const r of rows) {
        md += `| ${r.name} | ${r.fa} | ${r.fb} | ${r.delta === 0 ? "—" : (r.delta > 0 ? "+" : "-") + r.fdelta} |\n`;
      }
      const blocks = diff.divergenceBlocks(diff.align(trace.sorted(A), trace.sorted(B)));
      md += `\n共检测到 ${blocks.length} 个分叉区间（LCS 对齐自动计算）。\n`;
    }
    md += `\n## 关键结论\nRun B 的「定向测试 + 上下文裁剪 + 单轮方案设计」组合策略显著降低端到端耗时与成本，建议作为 Harness 默认策略候选。\n`;
    return md;
  }

  /* ---------- 迷你 Markdown → HTML（报告导出专用） ---------- */
  function mdToHtml(md) {
    const lines = md.split("\n");
    const out = [];
    let inTable = false, inList = false, inQuote = false;
    const inline = (s) => util.esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`(.+?)`/g, "<code>$1</code>");

    const closeBlocks = () => {
      if (inTable) { out.push("</tbody></table>"); inTable = false; }
      if (inList) { out.push("</ol>"); inList = false; }
      if (inQuote) { out.push("</blockquote>"); inQuote = false; }
    };

    for (const line of lines) {
      const t = line.trimEnd();
      if (/^\|(.+)\|$/.test(t)) {
        const cells = t.slice(1, -1).split("|").map((c) => c.trim());
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 分隔行
        if (!inTable) { closeBlocks(); out.push("<table><tbody>"); inTable = true; }
        out.push("<tr>" + cells.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
        continue;
      }
      if (/^#{1,4}\s/.test(t)) {
        closeBlocks();
        const level = t.match(/^#+/)[0].length;
        out.push(`<h${level}>${inline(t.replace(/^#+\s*/, ""))}</h${level}>`);
        continue;
      }
      if (/^>\s?/.test(t)) {
        if (!inQuote) { closeBlocks(); out.push("<blockquote>"); inQuote = true; }
        out.push(`<p>${inline(t.replace(/^>\s?/, ""))}</p>`);
        continue;
      }
      if (/^\d+\.\s/.test(t) || /^\s*-\s/.test(t)) {
        if (!inList) { closeBlocks(); out.push("<ol>"); inList = true; }
        out.push(`<li>${inline(t.replace(/^\d+\.\s+/, "").replace(/^\s*-\s+/, ""))}</li>`);
        continue;
      }
      closeBlocks();
      if (t) out.push(`<p>${inline(t)}</p>`);
    }
    closeBlocks();
    return out.join("\n");
  }

  function buildHtml(md, title) {
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${util.esc(title)}</title>
<style>
:root{color-scheme:light}
body{font:14px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:880px;margin:40px auto;padding:0 24px;color:#1f2937}
h1{font-size:22px;border-bottom:2px solid #38bdf8;padding-bottom:8px}
h2{font-size:17px;margin-top:30px;border-left:4px solid #38bdf8;padding-left:10px}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13px}
td,th{border:1px solid #d1d5db;padding:6px 10px;text-align:left}
tr:nth-child(even){background:#f8fafc}
blockquote{color:#6b7280;border-left:3px solid #cbd5e1;margin:12px 0;padding:2px 14px}
code{background:#f1f5f9;padding:1px 6px;border-radius:4px;font-size:12px}
ol{padding-left:22px}
footer{margin-top:40px;color:#9ca3af;font-size:12px;border-top:1px solid #e5e7eb;padding-top:12px}
</style></head><body>
${mdToHtml(md)}
<footer>由 DS Trajectory Studio（DeepSeek Harness 插件）生成</footer>
</body></html>`;
  }

  return { buildMarkdown, buildHtml, mdToHtml };
});
