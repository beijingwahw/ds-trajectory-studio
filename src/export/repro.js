// @ts-check
/* ============================================================
 * DS Trajectory Studio — export/repro（v2 升维）
 * 数据驱动复现包生成器。五件套：
 *   repro-<run>.min.json   最小因果闭包（静态 ddmin：仅失败链事件）
 *   repro-<run>.json       完整轨迹
 *   repro-<run>.md         复现报告（失败签名 + 分叉点处方 + 环境指纹）
 *   repro-<run>.sh         可执行复现脚本（从 tool/call.arguments 提取真实命令）
 *   repro-verify-<run>.sh  自验证脚本（断言失败签名复现 → 退出码）
 * ============================================================ */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const util = isNode ? require("../core/util.js") : /** @type {any} */ (root).DSTS.util;
  const trace = isNode ? require("../model/trace.js") : /** @type {any} */ (root).DSTS.trace;
  const minimize = isNode ? require("../analysis/minimize.js") : /** @type {any} */ (root).DSTS.minimize;
  const api = factory(util, trace, minimize);
  if (isNode) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.repro = api; }
})(typeof self !== "undefined" ? self : globalThis, function (util, trace, minimize) {
  "use strict";

  /* ---------- 真实命令提取 ---------- */

  /** 从事件 args（tool/call.arguments 原始 JSON）提取可执行命令 */
  function extractCommand(e) {
    if (!e.args) return null;
    let parsed;
    try { parsed = JSON.parse(e.args); } catch { return null; }
    if (!parsed || typeof parsed !== "object") return null;
    const cmd = parsed.cmd || parsed.command || parsed.script;
    if (typeof cmd === "string" && cmd.trim()) return cmd.trim();
    if (Array.isArray(parsed.argv) && parsed.argv.length) return parsed.argv.join(" ");
    return null;
  }

  /** 环境指纹（复现可移植性的关键） */
  function fingerprint(run, task) {
    return {
      generatedBy: "DS Trajectory Studio",
      capturedAt: new Date().toISOString(),
      run: { id: run.id, strategy: run.strategy || null, branch: run.branch || null },
      model: (task && task.model) || "unknown",
      harnessVersion: (task && task.harnessVersion) || "unknown",
      priceSnapshot: (task && task.pricePerMToken) || null
    };
  }

  /**
   * @param {any} run
   * @param {{findings: any[]}} analysis
   * @param {{task?: any, siblingRun?: any, sampleRepro?: {patch?: string, script?: string}}} [opts]
   */
  function buildReproBundle(run, analysis, opts = {}) {
    const min = minimize.minimizeForFailure(run);
    const fork = minimize.forkPrescription(run, opts.siblingRun || null);
    const fp = fingerprint(run, opts.task);
    const failures = run.events.filter((e) => e.status === "error" || e.type === "error");

    /* ----- 复现报告 MD ----- */
    const mdParts = [
      `# 轨迹复现报告：${run.label || run.id}`,
      ``,
      `> DS Trajectory Studio 生成 · ${fp.capturedAt}`,
      ``,
      `## 概要`,
      `- 端到端 ${util.fmtMs(trace.runEnd(run))} · ${run.events.length} 事件 · Token ${util.fmtTok(trace.tokSum(run))} · 失败 ${failures.length} 个`,
      min ? `- **最小复现集**：${min.events.length}/${min.originalCount} 事件（压缩 ${util.fmtPct(min.reduction)}，静态因果闭包，未经执行验证）` : `- 无失败事件`,
      ``
    ];
    if (min) {
      mdParts.push(
        `## 失败签名`,
        `\`${min.signature}\` · 首个失败：**${min.target.id} ${min.target.name}**（${util.fmtMs(min.target.t)} 起）`,
        ``,
        min.target.detail || "（无详情）",
        ``
      );
    }
    mdParts.push(
      `## 分叉点处方（fork prescription）`,
      fork
        ? `- 依据：${fork.basis === "sibling-prefix" ? "与成功兄弟 Run 的共享前缀" : "首失败的父链"}\n- **最后已知良好点**：\`${fork.forkAfter}\`${fork.forkAfterSeq != null ? `（seq ${fork.forkAfterSeq}）` : ""} · ${util.fmtMs(fork.forkAtMs)}\n- 首个偏航事件：\`${fork.divergenceAt}\`\n- DSH 精确回放：\`dsh session fork <session-id>\` 后从该点重跑`
        : "- 无法确定分叉点（无失败且无兄弟 Run）",
      ``,
      `## 最小复现集事件链`
    );
    if (min) min.events.forEach((e) => mdParts.push(`- \`${e.id}\` ${e.name}（${util.fmtMs(e.dur)}）`));
    else mdParts.push("- —");
    mdParts.push(``, `## 环境指纹`, "```json", JSON.stringify(fp, null, 2), "```");
    const md = mdParts.join("\n");

    /* ----- 可执行复现脚本 ----- */
    const shLines = [
      `#!/usr/bin/env bash`,
      `# 复现脚本（${run.id}）— 命令提取自 tool/call.arguments 原始参数`,
      `# ⚠ 请先审查再执行：脚本按墙钟顺序重放工具调用`,
      `set -uo pipefail   # 不用 -e：复现需要经历预期的失败`,
      ``,
      `REPRO_LOG=repro-output.log`,
      `: > "$REPRO_LOG"`,
      ``
    ];
    let extracted = 0;
    const toolEvents = run.events.filter((x) => x.type === "tool");
    for (const e of toolEvents) {
      const cmd = extractCommand(e);
      const mark = e.status === "error" ? " # ← 预期失败点" : "";
      if (cmd) {
        extracted++;
        shLines.push(`echo "== [${e.id}] ${e.name}" | tee -a "$REPRO_LOG"`);
        shLines.push(`(${cmd}) 2>&1 | tee -a "$REPRO_LOG"${mark}`);
      } else {
        shLines.push(`# [${e.id}] ${e.name}（非命令类工具，参数见 min.json）${mark}`);
      }
    }
    shLines.push(``, `echo "[repro] 回放完毕：${extracted} 条真实命令 / ${toolEvents.length} 个工具事件"`);

    /* ----- 自验证脚本 ----- */
    const errInfo = min && min.target.errorInfo
      ? `${min.target.errorInfo.name}/${min.target.errorInfo.code}`
      : (min ? min.signature : null);
    let verifyBody;
    if (errInfo && errInfo.includes("/")) {
      const needle = errInfo.split("/")[1] || errInfo;
      verifyBody = `if grep -qF "${needle}" repro-output.log; then\n  echo "[verify] PASS：失败签名 ${errInfo} 已复现"\n  exit 0\nelse\n  echo "[verify] FAIL：未观察到预期失败签名 ${errInfo}"\n  exit 1\nfi`;
    } else {
      verifyBody = `echo "[verify] 该轨迹无机器可验证的失败签名，脚本执行完成即通过"\nexit 0`;
    }
    const verifySh = [
      `#!/usr/bin/env bash`,
      `# 自验证：复现必须重现失败签名 ${errInfo || "（无）"}`,
      `set -uo pipefail`,
      `cd "$(dirname "$0")"`,
      `bash "repro-${run.id}.sh"`,
      ``,
      verifyBody
    ].join("\n");

    const bundle = {
      minJson: min ? JSON.stringify({ signature: min.signature, target: min.target.id, originalCount: min.originalCount, removedCount: min.removedCount, reduction: min.reduction, events: min.events }, null, 2) : null,
      json: JSON.stringify(run, null, 2),
      md,
      sh: shLines.join("\n"),
      verifySh,
      extractedCommands: extracted,
      meta: { min, fork, fingerprint: fp }
    };
    if (opts.sampleRepro && opts.sampleRepro.patch) bundle.patch = opts.sampleRepro.patch;
    return bundle;
  }

  return { buildReproBundle, extractCommand, fingerprint };
});
