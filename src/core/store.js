// @ts-check
/* ============================================================
 * DS Trajectory Studio — core/store
 * 极简响应式状态容器：单一数据源，订阅-通知，避免组件间直接引用。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.store = api; }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /**
   * @param {object} initial 初始状态
   * @returns {{get:Function, patch:Function, subscribe:Function}}
   */
  function createStore(initial) {
    let state = Object.freeze({ ...initial });
    const listeners = new Set();

    const get = () => state;

    /** 局部更新；相同引用不产生通知 */
    function patch(partial) {
      const changed = Object.keys(partial).filter((k) => state[k] !== partial[k]);
      if (!changed.length) return;
      state = Object.freeze({ ...state, ...partial });
      listeners.forEach((fn) => fn(state, changed));
    }

    /** 订阅；返回取消函数 */
    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    return { get, patch, subscribe };
  }

  return { createStore };
});
