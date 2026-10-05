// @ts-check
/* ============================================================
 * DS Trajectory Studio — model/layout
 * DAG 分层布局纯函数：
 * - 最长路径分层（topoDepth）
 * - Barycenter 启发式层内排序（迭代扫描，减少边交叉）
 * 与渲染完全解耦，可在 Node 中测试。
 * ============================================================ */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const trace = isNode ? require("./trace.js") : /** @type {any} */ (root).DSTS.trace;
  const api = factory(trace);
  if (isNode) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.layout = api; }
})(typeof self !== "undefined" ? self : globalThis, function (trace) {
  "use strict";

  /**
   * @param {Array<{id:string, parents:string[]}>} events
   * @param {{nodeW?:number, gapX?:number, gapY?:number, pad?:number, sweeps?:number}} opts
   * @returns {{pos: Map<string,{x:number,y:number}>, w:number, h:number, layers: Map<number,string[]>, crossings:number}}
   */
  function layeredLayout(events, opts = {}) {
    const { nodeW = 150, gapX = 30, gapY = 78, pad = 20, sweeps = 4 } = opts;
    const depth = trace.topoDepth(events);

    // 分层（初始序 = 输入序）
    const layers = new Map();
    events.forEach((e) => {
      const d = depth.get(e.id);
      if (!layers.has(d)) layers.set(d, []);
      layers.get(d).push(e.id);
    });
    const maxD = Math.max(...depth.values(), 0);
    const order = new Map(); // id → 层内序号
    const reindex = () => layers.forEach((ids) => ids.forEach((id, i) => order.set(id, i)));
    reindex();

    const childrenOf = new Map();
    events.forEach((e) => e.parents.forEach((p) => {
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(e.id);
    }));
    const byId = new Map(events.map((e) => [e.id, e]));

    /** 按邻居平均序号（barycenter）对某层排序 */
    const sortLayer = (ids, neighbors) => {
      const bary = (id) => {
        const ns = (neighbors(id) || []).filter((x) => order.has(x));
        return ns.length ? ns.reduce((s, x) => s + order.get(x), 0) / ns.length : order.get(id);
      };
      ids.sort((a, b) => bary(a) - bary(b) || order.get(a) - order.get(b)); // 稳定决胜，保证确定性
    };

    // 下扫（按父排）+ 上扫（按子排）迭代
    for (let s = 0; s < sweeps; s++) {
      for (let d = 1; d <= maxD; d++) { sortLayer(layers.get(d), (id) => byId.get(id).parents); reindex(); }
      for (let d = maxD - 1; d >= 0; d--) { sortLayer(layers.get(d), (id) => childrenOf.get(id)); reindex(); }
    }

    // 坐标
    const pos = new Map();
    let maxW = 0;
    layers.forEach((ids, d) => {
      ids.forEach((id, i) => {
        pos.set(id, { x: i * (nodeW + gapX), y: d * gapY });
        maxW = Math.max(maxW, (i + 1) * (nodeW + gapX));
      });
    });

    return { pos, w: maxW + pad * 2, h: (maxD + 1) * gapY + pad * 2, layers, crossings: countCrossings(events, depth, order) };
  }

  /** 边交叉计数（相邻层之间，用于评估布局质量） */
  function countCrossings(events, depth, order) {
    let total = 0;
    const byLayerPair = new Map();
    for (const e of events) {
      for (const p of e.parents) {
        const key = `${depth.get(p)}→${depth.get(e.id)}`;
        if (!byLayerPair.has(key)) byLayerPair.set(key, []);
        byLayerPair.get(key).push([order.get(p), order.get(e.id)]);
      }
    }
    for (const edges of byLayerPair.values()) {
      for (let i = 0; i < edges.length; i++) {
        for (let j = i + 1; j < edges.length; j++) {
          const [a1, b1] = edges[i], [a2, b2] = edges[j];
          if ((a1 - a2) * (b1 - b2) < 0) total++;
        }
      }
    }
    return total;
  }

  /**
   * 链式压缩（trace summarization）：
   * 将「入度=1 且 出度=1」的线性串行长链聚合为单个虚拟节点，
   * 使 DAG 渲染规模与事件总量解耦（3000 事件 → 数百节点）。
   * 纯函数；聚合节点带 aggregate 成员列表，可溯源。
   *
   * @param {any[]} events 轨迹事件（tokens 至少含 in/out，可选 cacheIn）
   * @param {number} [minChain] 触发压缩的最小链长（默认 6）
   * @returns {{events: object[], mapping: Map<string,string[]>}}
   */
  function compressChains(events, minChain = 6) {
    const byId = new Map(events.map((e) => [e.id, e]));
    const children = new Map();
    for (const e of events) {
      for (const p of e.parents) {
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(e.id);
      }
    }
    const isMid = (id) => {
      const e = byId.get(id);
      return !!e && e.parents.length === 1 && (children.get(id) || []).length === 1;
    };

    const visited = new Set();
    const mapping = new Map();
    const out = [];
    for (const e of events) {
      if (visited.has(e.id)) continue;
      if (!isMid(e.id)) { visited.add(e.id); out.push(e); continue; }
      // 沿单链向后延展
      const chain = [e.id];
      visited.add(e.id);
      let cur = e.id;
      while (true) {
        const next = (children.get(cur) || [])[0];
        if (next == null || !isMid(next) || visited.has(next)) break;
        chain.push(next);
        visited.add(next);
        cur = next;
      }
      if (chain.length < minChain) {
        chain.forEach((id) => out.push(byId.get(id)));
        continue;
      }
      // 聚合：首节点父母 / 末节点孩子 / 全链时长与 token 加和
      const members = chain.map((id) => byId.get(id));
      const first = members[0], last = members[members.length - 1];
      const aggId = `agg:${first.id}..${last.id}`;
      const statusRank = { error: 3, warn: 2, ok: 1 };
      mapping.set(aggId, chain);
      out.push({
        id: aggId,
        t: first.t,
        dur: last.t + last.dur - first.t,
        type: first.type,
        name: `串行链 ×${members.length}（${first.name} …）`,
        parents: first.parents.slice(),
        tokens: {
          in: members.reduce((s, m) => s + (m.tokens?.in || 0), 0),
          out: members.reduce((s, m) => s + (m.tokens?.out || 0), 0)
        },
        status: members.reduce((w, m) => (statusRank[m.status] > statusRank[w] ? m.status : w), "ok"),
        detail: `聚合 ${members.length} 个串行事件：${chain.join(" → ")}`,
        aggregate: chain
      });
    }
    // 重挂：指向被压缩成员的外部孩子 → 改指聚合节点
    const memberToAgg = new Map();
    for (const [aggId, chain] of mapping) for (const id of chain) memberToAgg.set(id, aggId);
    for (const e of out) {
      e.parents = [...new Set(e.parents.map((p) => memberToAgg.get(p) || p))].filter((p) => p !== e.id);
    }
    return { events: out, mapping };
  }

  return { layeredLayout, countCrossings, compressChains };
});
