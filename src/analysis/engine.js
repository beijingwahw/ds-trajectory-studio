// @ts-check
/* ============================================================
 * DS Trajectory Studio — analysis/engine
 * 分析引擎：执行规则注册表，产出诊断 + 统计 + 瓶颈事件集合。
 * - 纯函数 analyze()：可测试、可在 Web Worker 中运行
 * - analyzeAsync()：Promise 接口，未来可无缝切换 Worker 卸载
 * - 结果按 run 签名记忆化，避免重复计算
 * ============================================================ */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const util = isNode ? require("../core/util.js") : /** @type {any} */ (root).DSTS.util;
  const trace = isNode ? require("../model/trace.js") : /** @type {any} */ (root).DSTS.trace;
  const { RULES } = isNode ? require("./rules.js") : /** @type {any} */ (root).DSTS.rules;
  const api = factory(util, trace, RULES);
  if (isNode) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.engine = api; }
})(typeof self !== "undefined" ? self : globalThis, function (util, trace, RULES) {
  "use strict";

  const SEV_ORDER = { high: 0, mid: 1, low: 2 };
  const cache = new Map();

  const runSignature = (run) =>
    `${run.id}:${run.events.length}:${util.sum(run.events, (e) => e.t + e.dur + e.tokens.in + e.tokens.out)}`;

  /**
   * 同步执行全部规则。
   * @returns {{findings: object[], stats: object, bottleneckIds: Set<string>, runEnd: number}}
   */
  function analyze(run) {
    const sig = runSignature(run);
    if (cache.has(sig)) return cache.get(sig);

    const events = trace.sorted(run);
    const durs = events.map((e) => e.dur);
    const stats = { ...util.meanStd(durs), robust: util.madStats(durs), p95: util.percentile(durs, 95) };
    const ctx = { run, events, stats, runEnd: trace.runEnd(run), gaps: trace.idleGaps(run) };

    const findings = [];
    for (const rule of RULES) {
      const res = rule.check.call(rule, ctx);
      if (Array.isArray(res)) findings.push(...res);
      else if (res) findings.push(res);
    }
    findings.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || a.ev.localeCompare(b.ev));

    const bottleneckIds = new Set(findings.flatMap((f) => f.ev.split(",")));
    const result = { findings, stats, bottleneckIds, runEnd: ctx.runEnd };
    cache.set(sig, result);
    return result;
  }

  /** 异步接口（当前微任务调度；可替换为 Worker postMessage 实现） */
  function analyzeAsync(run) {
    return new Promise((resolve) => setTimeout(() => resolve(analyze(run)), 0));
  }

  /** 测试/热重载用：清空记忆化缓存 */
  const clearCache = () => cache.clear();

  return { analyze, analyzeAsync, clearCache };
});
