/* ============================================================
 * DS Trajectory Studio — core/profiler
 * 自观测微 Profiler：为应用自身的关键渲染路径计时。
 * 工具能调试 Agent，也应能调试自己（dogfooding）。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.profiler = api; }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const MAX = 50;
  const entries = [];
  const listeners = new Set();
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  function record(name, ms) {
    entries.push({ name, ms, at: Date.now() });
    if (entries.length > MAX) entries.shift();
    listeners.forEach((fn) => fn(entries));
  }

  /** 同步计时 */
  function measure(name, fn) {
    const t0 = now();
    try { return fn(); }
    finally { record(name, now() - t0); }
  }

  /** 异步计时 */
  async function measureAsync(name, p) {
    const t0 = now();
    try { return await p; }
    finally { record(name, now() - t0); }
  }

  const recent = (n = 10) => entries.slice(-n).reverse();
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const clear = () => entries.splice(0, entries.length);

  return { measure, measureAsync, recent, subscribe, clear };
});
