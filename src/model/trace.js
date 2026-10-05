// @ts-check
/* ============================================================
 * DS Trajectory Studio — model/trace
 * 轨迹领域模型：Schema 校验 / 派生指标 / 拓扑工具。
 * 全部为纯函数，是分析引擎与渲染层的共同地基。
 * ============================================================ */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const util = isNode ? require("../core/util.js") : /** @type {any} */ (root).DSTS.util;
  const api = factory(util);
  if (isNode) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.trace = api; }
})(typeof self !== "undefined" ? self : globalThis, function (util) {
  "use strict";

  const EVENT_TYPES = ["llm", "tool", "thought", "observation", "error"];

  /* ---------- Schema 校验 ---------- */

  /**
   * 校验一个 Run 对象是否符合轨迹 Schema。
   * @returns {{ok:boolean, errors:string[]}}
   */
  function validateRun(run) {
    const errors = [];
    if (!run || typeof run !== "object") return { ok: false, errors: ["run 不是对象"] };
    if (typeof run.id !== "string" || !run.id) errors.push("缺少 run.id");
    if (!Array.isArray(run.events) || !run.events.length) errors.push("run.events 必须为非空数组");
    const ids = new Set();
    (run.events || []).forEach((e, i) => {
      const at = `events[${i}]`;
      if (typeof e.id !== "string" || !e.id) errors.push(`${at}: 缺少 id`);
      else if (ids.has(e.id)) errors.push(`${at}: id 重复 "${e.id}"`);
      else ids.add(e.id);
      if (!EVENT_TYPES.includes(e.type)) errors.push(`${at} (${e.id}): 非法 type "${e.type}"`);
      if (typeof e.t !== "number" || e.t < 0) errors.push(`${at} (${e.id}): t 必须为非负数值`);
      if (typeof e.dur !== "number" || e.dur < 0) errors.push(`${at} (${e.id}): dur 必须为非负数值`);
      if (!e.tokens) e.tokens = { in: 0, out: 0 };
      if (!Array.isArray(e.parents)) e.parents = [];
      if (!e.status) e.status = "ok";
      if (!e.detail) e.detail = "";
    });
    // 父引用完整性 + 环检测
    (run.events || []).forEach((e) => {
      e.parents.forEach((p) => { if (!ids.has(p)) errors.push(`${e.id}: 父节点 "${p}" 不存在`); });
    });
    if (!errors.length) {
      try { topoDepth(run.events); } catch (err) { errors.push(`因果图存在环: ${err.message}`); }
    }
    return { ok: errors.length === 0, errors };
  }

  /* ---------- 派生指标 ---------- */

  const sorted = (run) => run.events.slice().sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  const runEnd = (run) => Math.max(...run.events.map((e) => e.t + e.dur));
  const tokSum = (run) => util.sum(run.events, (e) => e.tokens.in + e.tokens.out);
  const tokCache = (run) => util.sum(run.events, (e) => e.tokens.cacheIn || 0);
  const countBy = (run, type) => run.events.filter((e) => e.type === type).length;
  const durBy = (run, type) => util.sum(run.events.filter((e) => e.type === type), (e) => e.dur);

  /**
   * 成本模型：KV 缓存命中部分按折扣价计费（对齐 DeepSeek 缓存定价与
   * DSH KV Cache 优化卖点）。pricePerM = { in, out, cacheIn? }。
   */
  function costOf(run, pricePerM) {
    const tin = util.sum(run.events, (e) => e.tokens.in);
    const tout = util.sum(run.events, (e) => e.tokens.out);
    const cache = Math.min(tokCache(run), tin);
    const cachePrice = pricePerM.cacheIn != null ? pricePerM.cacheIn : pricePerM.in;
    return ((tin - cache) * pricePerM.in + cache * cachePrice + tout * pricePerM.out) / 1e6;
  }

  /** 缓存命中率（无缓存字段时返回 0） */
  function cacheHitRate(run) {
    const tin = util.sum(run.events, (e) => e.tokens.in);
    return tin ? tokCache(run) / tin : 0;
  }

  /** 阶段耗时归因（事件持续时间的加和视角，非墙钟） */
  function phases(run) {
    const llm = durBy(run, "llm");
    const tool = durBy(run, "tool");
    const other = util.sum(run.events, (e) => e.dur) - llm - tool;
    return [
      { key: "llm", label: "LLM 推理", dur: llm },
      { key: "tool", label: "工具执行", dur: tool },
      { key: "other", label: "思考/观察/异常", dur: Math.max(other, 0) }
    ];
  }

  /** 调度空转：相邻事件之间的墙钟空隙 */
  function idleGaps(run, minGapMs = 3000) {
    const evs = sorted(run);
    const gaps = [];
    for (let i = 1; i < evs.length; i++) {
      const gap = evs[i].t - (evs[i - 1].t + evs[i - 1].dur);
      if (gap >= minGapMs) gaps.push({ after: evs[i - 1].id, before: evs[i].id, gap });
    }
    return gaps;
  }

  /* ---------- 拓扑工具 ---------- */

  /** 最长路径分层（DFS 记忆化；检测到环时抛错） */
  function topoDepth(events) {
    const map = new Map(events.map((e) => [e.id, e]));
    const depth = new Map();
    const visiting = new Set();
    function d(id) {
      if (depth.has(id)) return depth.get(id);
      if (visiting.has(id)) throw new Error(`cycle at ${id}`);
      const e = map.get(id);
      if (!e) return 0;
      visiting.add(id);
      const v = e.parents.length ? Math.max(...e.parents.map(d)) + 1 : 0;
      visiting.delete(id);
      depth.set(id, v);
      return v;
    }
    events.forEach((e) => d(e.id));
    return depth;
  }

  /** 因果祖先（按拓扑序返回） */
  function ancestors(events, id) {
    const map = new Map(events.map((e) => [e.id, e]));
    const seen = new Set();
    (function walk(cur) {
      (map.get(cur)?.parents || []).forEach((p) => {
        if (!seen.has(p)) { seen.add(p); walk(p); }
      });
    })(id);
    const depth = topoDepth(events);
    return [...seen].sort((a, b) => depth.get(a) - depth.get(b));
  }

  /** 因果后代 */
  function descendants(events, id) {
    const children = new Map();
    events.forEach((e) => e.parents.forEach((p) => {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(e.id);
    }));
    const seen = new Set();
    (function walk(cur) {
      (children.get(cur) || []).forEach((c) => { if (!seen.has(c)) { seen.add(c); walk(c); } });
    })(id);
    return [...seen];
  }

  return { EVENT_TYPES, validateRun, sorted, runEnd, tokSum, tokCache, countBy, durBy, costOf, cacheHitRate, phases, idleGaps, topoDepth, ancestors, descendants };
});
