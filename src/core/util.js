// @ts-check
/* ============================================================
 * DS Trajectory Studio — core/util
 * 纯函数工具层：格式化 / DOM / 统计。无环境依赖，可在 Node 中测试。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.util = api; }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /** HTML 转义，防注入（详情/导入数据均经过此函数） */
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms");
  const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
  const fmtPct = (x, digits = 0) => (x * 100).toFixed(digits) + "%";
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + f(x), 0);

  function meanStd(arr) {
    if (!arr.length) return { mean: 0, std: 0 };
    const mean = sum(arr) / arr.length;
    const std = Math.sqrt(sum(arr, (x) => (x - mean) ** 2) / arr.length);
    return { mean, std };
  }

  /* ---------- 稳健统计（抗极端值） ---------- */

  function median(sortedArr) {
    const n = sortedArr.length;
    if (!n) return 0;
    const mid = n >> 1;
    return n % 2 ? sortedArr[mid] : (sortedArr[mid - 1] + sortedArr[mid]) / 2;
  }

  /** 百分位（输入无需有序，内部复制排序） */
  function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const idx = clamp((p / 100) * (s.length - 1), 0, s.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }

  /**
   * MAD（中位数绝对偏差）+ 修正 Z 分数（Iglewicz-Hoaglin）。
   * 相比 mean±kσ，对轨迹耗时这类重尾分布不敏感于异常值本身。
   * @returns {{median:number, mad:number, modifiedZ:(x:number)=>number}}
   */
  function madStats(arr) {
    if (!arr.length) return { median: 0, mad: 0, modifiedZ: () => 0 };
    const s = arr.slice().sort((a, b) => a - b);
    const med = median(s);
    const mad = median(s.map((x) => Math.abs(x - med)).sort((a, b) => a - b));
    const denom = mad === 0 ? 1e-9 : mad;
    return { median: med, mad, modifiedZ: (x) => 0.6745 * (x - med) / denom };
  }

  /** 名称相似度：token 集合 Jaccard。拉丁词按整体，CJK 按字符二元组（业界通行的 CJK 相似度分词） */
  function jaccard(a, b) {
    const tok = (s) => {
      const str = String(s).toLowerCase();
      const set = new Set(str.match(/[a-z0-9]+/g) || []);
      const cjk = str.match(/[\u4e00-\u9fff]/g) || [];
      for (let i = 0; i + 1 < cjk.length; i++) set.add(cjk[i] + cjk[i + 1]);
      if (cjk.length === 1) set.add(cjk[0]);
      return set;
    };
    const A = tok(a), B = tok(b);
    if (!A.size && !B.size) return 1;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter || 1);
  }

  /** 自适应「整数值」时间刻度：1/2/5 × 10^n */
  function niceTicks(max, count = 10) {
    if (max <= 0) return [0];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    const ticks = [];
    for (let t = 0; t <= max + step * 0.5; t += step) ticks.push(Math.round(t));
    return ticks;
  }

  /** DOM 构造（仅浏览器端调用） */
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function debounce(fn, wait) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  }

  let _uid = 0;
  const uid = (prefix = "id") => `${prefix}-${++_uid}`;

  return { esc, fmtMs, fmtTok, fmtPct, clamp, sum, meanStd, median, percentile, madStats, jaccard, niceTicks, el, debounce, uid };
});
