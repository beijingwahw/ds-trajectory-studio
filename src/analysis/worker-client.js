/* ============================================================
 * DS Trajectory Studio — analysis/worker-client
 * Worker 分析客户端（仅浏览器）：
 * - http(s) 环境：真·后台线程分析，请求-响应配对，带超时保护
 * - file:// 环境或 Worker 失败：透明降级为主线程异步分析
 * 对调用方暴露统一的 analyze(run) => Promise 接口。
 * ============================================================ */
(function (root) {
  "use strict";
  const { engine } = root.DSTS;

  const WORKER_TIMEOUT = 5000;

  function workerSupported() {
    return typeof Worker !== "undefined" && location.protocol !== "file:";
  }

  function createAnalyzer(workerUrl) {
    let worker = null;
    let broken = false;
    let seq = 0;
    const pending = new Map();

    function ensureWorker() {
      if (broken || !workerSupported()) return null;
      if (worker) return worker;
      try {
        worker = new Worker(workerUrl);
        worker.onmessage = (e) => {
          const { id, ok, result, error } = e.data;
          const p = pending.get(id);
          if (!p) return;
          pending.delete(id);
          clearTimeout(p.timer);
          if (ok) p.resolve({ ...result, bottleneckIds: new Set(result.bottleneckIds) });
          else p.reject(new Error(error));
        };
        worker.onerror = () => {
          broken = true;
          for (const p of pending.values()) {
            clearTimeout(p.timer);
            p.resolve(engine.analyze(p.run)); // 在途请求降级完成
          }
          pending.clear();
        };
        return worker;
      } catch {
        broken = true;
        return null;
      }
    }

    /**
     * @param {object} run
     * @returns {Promise<{findings:object[], stats:object, bottleneckIds:Set, runEnd:number}>}
     */
    function analyze(run) {
      const w = ensureWorker();
      if (!w) return engine.analyzeAsync(run);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          broken = true; // 超时视为 Worker 不可用，后续走降级
          resolve(engine.analyze(run));
        }, WORKER_TIMEOUT);
        pending.set(id, { resolve, reject, timer, run });
        try {
          w.postMessage({ id, run });
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          resolve(engine.analyze(run));
        }
      });
    }

    return { analyze, get usingWorker() { return !!worker && !broken; } };
  }

  root.DSTS = root.DSTS || {};
  root.DSTS.workerClient = { createAnalyzer, workerSupported };
})(typeof self !== "undefined" ? self : globalThis);
