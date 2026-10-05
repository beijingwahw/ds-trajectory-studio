/* ============================================================
 * DS Trajectory Studio — replay
 * 重放引擎：播放/暂停/单步/变速，与 store 解耦（仅通过回调通知）。
 * ============================================================ */
(function (root) {
  "use strict";
  const { trace } = root.DSTS;

  class Replay {
    /**
     * @param {{onStep:(e:object, idx:number)=>void, onStop:()=>void}} hooks
     */
    constructor(hooks) {
      this.hooks = hooks;
      this.run = null;
      this.idx = -1;
      this.timer = null;
      this.speed = 800;
    }

    setRun(run) { this.stop(); this.run = run; this.idx = -1; }
    setSpeed(ms) {
      this.speed = ms;
      if (this.timer) { this.stop(); this.play(); } // 以新速度续播
    }
    get playing() { return !!this.timer; }

    toggle() { this.playing ? this.stop() : this.play(); }

    play() {
      if (!this.run || this.timer) return;
      const evs = trace.sorted(this.run);
      if (this.idx >= evs.length - 1) this.idx = -1;
      this.timer = setInterval(() => {
        this.step(1);
        if (this.idx >= evs.length - 1) this.stop();
      }, this.speed);
      this.step(1);
    }

    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.hooks.onStop?.();
    }

    step(delta) {
      if (!this.run) return;
      const evs = trace.sorted(this.run);
      this.idx = Math.min(Math.max(this.idx + delta, 0), evs.length - 1);
      this.hooks.onStep(evs[this.idx], this.idx);
    }
  }

  root.DSTS.replay = { Replay };
})(typeof self !== "undefined" ? self : globalThis);
