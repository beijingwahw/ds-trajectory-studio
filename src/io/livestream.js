/* ============================================================
 * DS Trajectory Studio — io/livestream
 * 实时轨迹流：对接 Harness on_trace_event 钩子语义。
 * 事件逐条到达 → 增量追加 → 视图刷新（跟随模式可选）。
 * LiveStream 与数据源解耦：任何事件源（WebSocket/SSE/模拟器）
 * 只需调用 push(event)。
 * ============================================================ */
(function (root) {
  "use strict";

  class LiveStream {
    /**
     * @param {object} run 目标 Run（事件将就地追加，引擎按签名自动失效缓存）
     * @param {object[]} pendingEvents 待流入的事件队列
     * @param {{onEvent:(e:object, done:boolean)=>void}} hooks
     */
    constructor(run, pendingEvents, hooks) {
      this.run = run;
      this.queue = pendingEvents.slice();
      this.hooks = hooks;
      this.timer = null;
    }

    get active() { return !!this.timer; }
    get remaining() { return this.queue.length; }

    /** 单条事件注入（真实 Harness 钩子入口语义） */
    push(event) {
      this.run.events.push(event);
      this.hooks.onEvent(event, this.queue.length === 0 && !this.timer);
    }

    start(intervalMs = 700) {
      if (this.timer || !this.queue.length) return;
      this.timer = setInterval(() => {
        const e = this.queue.shift();
        this.push(e);
        if (!this.queue.length) this.stop();
      }, intervalMs);
    }

    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (!this.queue.length) this.hooks.onEvent(null, true);
    }
  }

  root.DSTS = root.DSTS || {};
  root.DSTS.livestream = { LiveStream };
})(typeof self !== "undefined" ? self : globalThis);
