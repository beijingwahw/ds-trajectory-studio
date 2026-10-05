// @ts-check
/* ============================================================
 * DS Trajectory Studio — analysis/diff
 * 双轨迹比对与分叉检测。
 * v0.3：LCS 升级为 Needleman-Wunsch 全局序列比对——
 * 代价函数融合事件类型匹配度与名称 Jaccard 相似度，
 * 使「语义相近但措辞不同」的步骤正确对齐为替换（sub），
 * 而非被误判为 删除+新增 两个独立事件。
 * ============================================================ */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const util = isNode ? require("../core/util.js") : /** @type {any} */ (root).DSTS.util;
  const trace = isNode ? require("../model/trace.js") : /** @type {any} */ (root).DSTS.trace;
  const api = factory(util, trace);
  if (isNode) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.diff = api; }
})(typeof self !== "undefined" ? self : globalThis, function (util, trace) {
  "use strict";

  /** 完全等价签名（用于区分 match 与 sub） */
  function signature(e) {
    const norm = e.name
      .toLowerCase()
      .replace(/#\d+/g, "")
      .replace(/(全量套件|定向.*|reasoner)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return `${e.type}:${norm}`;
  }

  /**
   * 比对相似度 ∈ [0,1]：类型一致占 0.6，名称 Jaccard 占 0.4。
   * 签名完全等价直接计 1。
   */
  function similarity(a, b) {
    if (signature(a) === signature(b)) return 1;
    return (a.type === b.type ? 0.6 : 0) + 0.4 * util.jaccard(a.name, b.name);
  }

  const ALIGN_THRESHOLD = 0.45; // 相似度 ≥ 此值才允许配对
  const GAP = -1;               // 空位罚分
  const MISMATCH = -0.5;        // 低相似配对的罚分

  /**
   * Needleman-Wunsch 全局比对。
   * @returns {Array<{a: object|null, b: object|null, status: 'match'|'sub'|'del'|'ins', score:number}>}
   */
  function align(eventsA, eventsB) {
    const n = eventsA.length, m = eventsB.length;
    // dp[i][j] = A[:i] 与 B[:j] 的最优比对得分
    const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const back = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1=diag 2=up(del) 3=left(ins)
    for (let i = 1; i <= n; i++) { dp[i][0] = i * GAP; back[i][0] = 2; }
    for (let j = 1; j <= m; j++) { dp[0][j] = j * GAP; back[0][j] = 3; }

    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const sim = similarity(eventsA[i - 1], eventsB[j - 1]);
        const diagScore = sim >= ALIGN_THRESHOLD ? sim : MISMATCH;
        const diag = dp[i - 1][j - 1] + diagScore;
        const up = dp[i - 1][j] + GAP;
        const left = dp[i][j - 1] + GAP;
        // 偏好配对（diag），再删（up），后增（left）——保证确定性回溯
        if (diag >= up && diag >= left && sim >= ALIGN_THRESHOLD) {
          dp[i][j] = diag; back[i][j] = 1;
        } else if (up >= left) {
          dp[i][j] = up; back[i][j] = 2;
        } else {
          dp[i][j] = left; back[i][j] = 3;
        }
      }
    }

    const out = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
      const dir = back[i][j];
      if (i > 0 && j > 0 && dir === 1) {
        const a = eventsA[i - 1], b = eventsB[j - 1];
        out.unshift({ a, b, status: signature(a) === signature(b) ? "match" : "sub", score: similarity(a, b) });
        i--; j--;
      } else if (i > 0 && (j === 0 || dir === 2)) {
        out.unshift({ a: eventsA[i - 1], b: null, status: "del", score: 0 });
        i--;
      } else {
        out.unshift({ a: null, b: eventsB[j - 1], status: "ins", score: 0 });
        j--;
      }
    }
    return out;
  }

  /** 分叉区间：连续的非 match 段 */
  function divergenceBlocks(alignment) {
    const blocks = [];
    let cur = null;
    for (const item of alignment) {
      if (item.status === "match") { cur = null; continue; }
      if (!cur) { cur = { startA: item.a ? item.a.id : null, items: [], kinds: new Set() }; blocks.push(cur); }
      cur.items.push(item);
      cur.kinds.add(item.status);
    }
    return blocks.map((b) => ({ ...b, kinds: [...b.kinds] }));
  }

  /** 指标对比行（自动计算 Δ 与占优方；dir: min=越小越好, max=越大越好） */
  function metricRows(runA, runB, price) {
    const defs = [
      ["端到端耗时", trace.runEnd, util.fmtMs, "min"],
      ["事件总数", (r) => r.events.length, String, "min"],
      ["LLM 调用次数", (r) => trace.countBy(r, "llm"), String, "min"],
      ["工具调用次数", (r) => trace.countBy(r, "tool"), String, "min"],
      ["全量测试次数", (r) => r.events.filter((e) => /全量/.test(e.name)).length, String, "min"],
      ["Token 总量", trace.tokSum, util.fmtTok, "min"],
      ["KV 缓存命中", trace.tokCache, util.fmtTok, "max"],
      ["估算成本 (¥)", (r) => trace.costOf(r, price), (v) => v.toFixed(3), "min"],
      ["异常/重试", (r) => trace.countBy(r, "error"), String, "min"]
    ];
    return defs.map(([name, f, fmt, dir]) => {
      const va = f(runA), vb = f(runB);
      return {
        name, va, vb, fa: fmt(va), fb: fmt(vb),
        delta: vb - va, fdelta: fmt(Math.abs(vb - va)),
        betterA: dir === "max" ? va >= vb : va <= vb
      };
    });
  }

  /* ==================== v2 升维：对比分析算法 ==================== */

  /**
   * 轨迹整体相似度 ∈ [0,1]：对齐得分之和 / 较长序列长度。
   * match 计 1、sub 计其相似度、del/ins 计 0。
   */
  function alignmentScore(alignment) {
    const nA = alignment.filter((x) => x.a).length;
    const nB = alignment.filter((x) => x.b).length;
    const denom = Math.max(nA, nB, 1);
    const s = alignment.reduce((sum, x) => sum + (x.a && x.b ? x.score : 0), 0);
    return s / denom;
  }

  /** 分叉区间影响量化：两侧耗时/token 加和与 Δ（B−A） */
  function blockImpact(block) {
    let durA = 0, durB = 0, tokA = 0, tokB = 0;
    for (const it of block.items) {
      if (it.a) { durA += it.a.dur; tokA += (it.a.tokens.in || 0) + (it.a.tokens.out || 0); }
      if (it.b) { durB += it.b.dur; tokB += (it.b.tokens.in || 0) + (it.b.tokens.out || 0); }
    }
    return { durA, durB, tokA, tokB, dDur: durB - durA, dTok: tokB - tokA };
  }

  /**
   * 累积曲线：事件结束时刻的累积值序列（用于双 Run 成本/耗时曲线对比）。
   * @param {any[]} events
   * @param {(e:any)=>number} valueFn
   * @returns {Array<[number, number]>} [wallMs, cumulative]
   */
  function cumulativeSeries(events, valueFn) {
    const sorted = events.slice().sort((a, b) => a.t - b.t);
    let acc = 0;
    /** @type {Array<[number, number]>} */
    const pts = [[0, 0]];
    for (const e of sorted) {
      acc += valueFn(e);
      pts.push([e.t + e.dur, acc]);
    }
    return pts;
  }

  /** 同源前缀：两条序列开头 id+type 完全相同的事件数（fork 共享历史检测） */
  function sharedPrefix(eventsA, eventsB) {
    const a = eventsA.slice().sort((x, y) => x.t - y.t);
    const b = eventsB.slice().sort((x, y) => x.t - y.t);
    let n = 0;
    while (n < a.length && n < b.length && a[n].id === b[n].id && a[n].type === b[n].type) n++;
    return n;
  }

  /** 对齐事件对的逐对 Δ（差分图数据）：B 相对 A 的耗时差 */
  function pairDeltas(alignment) {
    return alignment
      .filter((x) => x.a && x.b)
      .map((x) => ({
        a: x.a, b: x.b,
        dDur: x.b.dur - x.a.dur,
        dTok: (x.b.tokens.in + x.b.tokens.out) - (x.a.tokens.in + x.a.tokens.out),
        status: x.status
      }));
  }

  return { signature, similarity, align, divergenceBlocks, metricRows, alignmentScore, blockImpact, cumulativeSeries, sharedPrefix, pairDeltas };
});
