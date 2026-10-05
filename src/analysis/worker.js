/* ============================================================
 * DS Trajectory Studio — analysis/worker
 * Web Worker：在后台线程执行规则引擎，主线程零阻塞。
 * 通过 importScripts 复用与主线程完全相同的 UMD 模块，
 * 保证 Worker/主线程分析结果严格一致（单一事实来源）。
 * 注：file:// 协议下浏览器禁止 Worker，客户端会自动降级。
 * ============================================================ */
"use strict";

importScripts("../core/util.js", "../model/trace.js", "./rules.js", "./engine.js");

self.onmessage = (e) => {
  const { id, run } = e.data;
  try {
    const res = self.DSTS.engine.analyze(run);
    // Set 需要转为数组以便结构化克隆跨环境兼容
    self.postMessage({
      id,
      ok: true,
      result: { ...res, bottleneckIds: [...res.bottleneckIds] }
    });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
