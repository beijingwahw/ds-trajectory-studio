// @ts-check
/* ============================================================
 * DS Trajectory Studio — io/corpus
 * 会话语料库算法层（纯函数）：
 * - 同会话多代（generation）合并：相同 session id 按 seq 去重
 * - fork 谱系森林重建：parentSession 链接 → 家族树
 * - 签名去重 / 语料指标行
 * ============================================================ */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const util = isNode ? require("../core/util.js") : /** @type {any} */ (root).DSTS.util;
  const trace = isNode ? require("../model/trace.js") : /** @type {any} */ (root).DSTS.trace;
  const api = factory(util, trace);
  if (isNode) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.corpus = api; }
})(typeof self !== "undefined" ? self : globalThis, function (util, trace) {
  "use strict";

  /** 会话身份：DSH run 用 lineage 源 id（dsh- 前缀还原），否则用 run.id */
  const sessionKeyOf = (run) =>
    run.lineage && run.id.startsWith("dsh-") ? run.id.slice(4) : run.id;

  /**
   * 同会话多代合并：group by sessionKey → seq 去重（后到的代覆盖同 seq）。
   * @param {any[]} runs
   * @returns {{runs: any[], merges: Array<{session:string, generations:number, events:number}>}}
   */
  function mergeGenerations(runs) {
    const groups = new Map();
    for (const r of runs) {
      const key = sessionKeyOf(r);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const out = [], merges = [];
    for (const [key, gens] of groups) {
      if (gens.length === 1) { out.push(gens[0]); continue; }
      // 多代：按 seq 合并（无 seq 的事件保留首代）
      const bySeq = new Map();
      for (const g of gens) {
        for (const e of g.events) {
          const k = e.seq != null ? e.seq : `${g.id}:${e.id}`;
          bySeq.set(k, e); // 后者覆盖 → 最新代生效
        }
      }
      const base = gens[gens.length - 1];
      const events = [...bySeq.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.t - b.t);
      out.push({
        ...base,
        events,
        label: `${base.label || base.id} · ${gens.length} 代合并`,
        generations: gens.length
      });
      merges.push({ session: key, generations: gens.length, events: events.length });
    }
    return { runs: out, merges };
  }

  /** 签名去重：id + 事件数 + 内容指纹 */
  const signatureOf = (run) =>
    `${run.id}:${run.events.length}:${util.sum(run.events, (e) => e.t + e.dur + (e.tokens.in || 0) + (e.tokens.out || 0))}`;

  function dedupeRuns(runs) {
    const seen = new Set();
    const kept = [], dupes = [];
    for (const r of runs) {
      const sig = signatureOf(r);
      if (seen.has(sig)) dupes.push(r.id);
      else { seen.add(sig); kept.push(r); }
    }
    return { kept, dupes };
  }

  /**
   * fork 谱系森林：parentSession 链接 → 树结构。
   * 父会话未导入的节点作为「悬挂根」标记（dangling）。
   * @param {any[]} runs
   * @returns {{roots: string[], children: Map<string, string[]>, dangling: Set<string>, depthOf: Map<string, number>}}
   */
  function buildLineageForest(runs) {
    const ids = new Set(runs.map((r) => r.id));
    const sessionOf = new Map(runs.map((r) => [sessionKeyOf(r), r.id]));
    const children = new Map();
    const dangling = new Set();
    const roots = [];
    for (const r of runs) {
      const parentKey = r.lineage && r.lineage.parent;
      const parentRunId = parentKey ? sessionOf.get(String(parentKey).replace(/[^a-zA-Z0-9_-]/g, "-")) : null;
      if (parentRunId && ids.has(parentRunId)) {
        if (!children.has(parentRunId)) children.set(parentRunId, []);
        children.get(parentRunId).push(r.id);
      } else {
        roots.push(r.id);
        if (parentKey) dangling.add(r.id); // 有父但未导入
      }
    }
    // 深度（BFS）
    const depthOf = new Map();
    const queue = roots.map((id) => [id, 0]);
    while (queue.length) {
      const [id, d] = queue.shift();
      if (depthOf.has(id)) continue;
      depthOf.set(id, d);
      for (const c of children.get(id) || []) queue.push([c, d + 1]);
    }
    return { roots, children, dangling, depthOf };
  }

  /** 语料指标行（语料库表格） */
  function corpusMetrics(run, price) {
    const errors = run.events.filter((e) => e.status === "error" || e.type === "error").length;
    const health = run.health
      ? (run.health.unknownRequired.length ? "warn" : run.health.gaps.length ? "warn" : "ok")
      : "ok";
    return {
      id: run.id,
      label: run.label || run.id,
      duration: trace.runEnd(run),
      events: run.events.length,
      tokens: trace.tokSum(run),
      cacheHit: trace.cacheHitRate(run),
      cost: trace.costOf(run, price),
      errors,
      health,
      lineageDepth: run.lineage ? run.lineage.depth : 0,
      isSeeded: !!(run.lineage && run.lineage.isSeeded)
    };
  }

  return { sessionKeyOf, mergeGenerations, signatureOf, dedupeRuns, buildLineageForest, corpusMetrics };
});
