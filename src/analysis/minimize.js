// @ts-check
/* ============================================================
 * DS Trajectory Studio — analysis/minimize
 * 最小复现集计算（静态 Delta Debugging）。
 *
 * 经典 ddmin 通过反复执行二分最小失败输入；轨迹场景无法重放执行，
 * 因此采用结构等价物：失败事件 F 的「最小因果闭包」——
 * F 的全部因果祖先 ∪ {F}。性质（可证明）：
 *   1. 因果封闭：集合内每个事件的父节点仍在集合内或为根
 *   2. 最小性：删除任一成员都会切断 F 的至少一条因果路径
 *   3. 保持失败签名：F 及其错误状态完整保留
 * 诚实边界：这是静态最小化，未经验证执行；多失败时取首失败为主目标。
 * ============================================================ */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const trace = isNode ? require("../model/trace.js") : /** @type {any} */ (root).DSTS.trace;
  const api = factory(trace);
  if (isNode) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.minimize = api; }
})(typeof self !== "undefined" ? self : globalThis, function (trace) {
  "use strict";

  /** 首个失败事件（按墙钟）：status=error 或 type=error */
  function firstFailure(events) {
    return trace.sorted({ events }).find((e) => e.status === "error" || e.type === "error") || null;
  }

  /**
   * 因果闭包：target 事件及其全部祖先（保持原顺序）。
   * @param {any[]} events
   * @param {string[]} targetIds
   */
  function causalClosure(events, targetIds) {
    const keep = new Set(targetIds);
    for (const id of targetIds) {
      for (const a of trace.ancestors(events, id)) keep.add(a);
    }
    return events.filter((e) => keep.has(e.id));
  }

  /** 失败签名：用于复现验证的稳定标识 */
  function failureSignature(e) {
    const m = String(e.detail || "").match(/([A-Za-z]*Error)[/: ]([\w-]+)/);
    return m ? `${m[1]}/${m[2]}` : `${e.type}:${e.status}`;
  }

  /**
   * 计算最小复现集。
   * @param {any} run
   * @returns {null | {target: object, signature: string, events: any[], originalCount: number, removedCount: number, reduction: number}}
   */
  function minimizeForFailure(run) {
    const target = firstFailure(run.events);
    if (!target) return null;
    const kept = causalClosure(run.events, [target.id]);
    return {
      target,
      signature: failureSignature(target),
      events: kept,
      originalCount: run.events.length,
      removedCount: run.events.length - kept.length,
      reduction: 1 - kept.length / run.events.length
    };
  }

  /**
   * 分叉点处方：与成功兄弟 Run 对比，找最后已知良好点。
   * 优先级：共享前缀末端 > 首失败的最后一个非失败祖先。
   */
  function forkPrescription(run, siblingRun) {
    if (siblingRun) {
      const a = run.events.slice().sort((x, y) => x.t - y.t);
      const b = siblingRun.events.slice().sort((x, y) => x.t - y.t);
      let n = 0;
      while (n < a.length && n < b.length && a[n].id === b[n].id && a[n].type === b[n].type) n++;
      if (n > 0) {
        const last = a[n - 1];
        return {
          basis: "sibling-prefix",
          forkAfter: last.id,
          forkAfterSeq: last.seq != null ? last.seq : null,
          forkAtMs: last.t + last.dur,
          divergenceAt: a[n] ? a[n].id : null
        };
      }
    }
    const f = firstFailure(run.events);
    if (f && f.parents.length) {
      const parent = run.events.find((e) => e.id === f.parents[0]);
      return {
        basis: "failure-parent",
        forkAfter: parent.id,
        forkAfterSeq: parent.seq != null ? parent.seq : null,
        forkAtMs: parent.t + parent.dur,
        divergenceAt: f.id
      };
    }
    return null;
  }

  return { firstFailure, causalClosure, failureSignature, minimizeForFailure, forkPrescription };
});
