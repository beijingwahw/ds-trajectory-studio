// @ts-check
/* ============================================================
 * DS Trajectory Studio — model/criticalpath
 * 关键路径分析（CPM, Critical Path Method）：
 * - 回推动态规划计算每个事件的松弛时间 slack：
 *   事件可延迟而不推迟 Run 结束时间的余量
 * - slack ≈ 0 的事件构成关键路径——优化它们才能缩短端到端耗时，
 *   优化非关键事件对总时长无效（Profiling 的核心洞察）
 * 纯函数，O(V+E)，可在 Node 中测试。
 * ============================================================ */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const trace = isNode ? require("./trace.js") : /** @type {any} */ (root).DSTS.trace;
  const api = factory(trace);
  if (isNode) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.criticalpath = api; }
})(typeof self !== "undefined" ? self : globalThis, function (trace) {
  "use strict";

  const SLACK_EPS = 1; // ms：小于此值视为关键

  /**
   * @param {Array<{id:string, t:number, dur:number, parents:string[]}>} events
   * @param {number} [runEnd] 缺省取 max(t+dur)
   * @returns {{slack: Map<string,number>, path: string[], criticalDur: number, criticalRatio: number}}
   */
  function criticalPath(events, runEnd) {
    const end = runEnd != null ? runEnd : Math.max(...events.map((e) => e.t + e.dur));
    const byId = new Map(events.map((e) => [e.id, e]));
    const children = new Map();
    for (const e of events) {
      for (const p of e.parents) {
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(e.id);
      }
    }
    const ef = (e) => e.t + e.dur;

    // 回推：按拓扑深度降序处理（保证孩子先于父亲就绪）
    const depth = trace.topoDepth(events);
    const byDepthDesc = events.slice().sort((a, b) => depth.get(b.id) - depth.get(a.id));
    const slack = new Map();
    for (const e of byDepthDesc) {
      const kids = children.get(e.id) || [];
      if (!kids.length) {
        slack.set(e.id, Math.max(0, end - ef(e)));
      } else {
        // slack(e) = min over children of ( 边空隙 + child slack )；空隙负值（并行重叠）按 0 计
        slack.set(e.id, Math.min(...kids.map((k) =>
          Math.max(0, byId.get(k).t - ef(e)) + slack.get(k))));
      }
    }

    // 提取主关键链：从最早的零松弛事件出发，沿零松弛孩子贪心推进。
    // 注：链首不必是源点——前段事件与后继之间存在调度间隙（正松弛）属正常，
    // 真正的关键段从间隙闭合处开始。
    const isCritical = (id) => slack.get(id) <= SLACK_EPS;
    const criticals = events.filter((e) => isCritical(e.id)).sort((a, b) => a.t - b.t);
    const path = [];
    if (criticals.length) {
      let cur = criticals[0];
      const guard = events.length + 1;
      for (let i = 0; i < guard && cur; i++) {
        path.push(cur.id);
        const next = (children.get(cur.id) || [])
          .map((id) => byId.get(id))
          .filter((c) => isCritical(c.id))
          .sort((a, b) => a.t - b.t)[0];
        cur = next || null;
      }
    }
    const criticalDur = path.reduce((s, id) => s + byId.get(id).dur, 0);
    return { slack, path, criticalDur, criticalRatio: end ? criticalDur / end : 0 };
  }

  return { criticalPath, SLACK_EPS };
});
