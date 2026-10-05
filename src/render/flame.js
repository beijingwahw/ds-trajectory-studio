/* ============================================================
 * DS Trajectory Studio — render/flame
 * Icicle 火焰图：x = 墙钟时间，宽度 = 时长，y = 因果拓扑深度。
 * 一眼看清「哪一层吃了多少时间」；关键路径金色描边。
 * ============================================================ */
(function (root) {
  "use strict";
  const { util, trace, svg: svgx } = root.DSTS;
  const { TYPE_COLOR } = root.DSTS.timeline;

  const ROW_H = 30, PAD = 4, LABEL_MIN_W = 46;

  class Flame {
    constructor(wrap, hooks) {
      this.wrap = wrap;
      this.hooks = hooks; // {onSelect(id)}
      this.run = null;
      this.bottlenecks = new Set();
      this.critical = new Set();
    }

    setData(run, bottlenecks, critical) {
      this.run = run;
      this.bottlenecks = bottlenecks || new Set();
      this.critical = critical || new Set();
      this.render();
    }

    render() {
      const { wrap, run } = this;
      wrap.innerHTML = "";
      if (!run) return;
      const total = Math.max(trace.runEnd(run), 1);
      const depth = trace.topoDepth(run.events);
      const maxD = Math.max(...depth.values(), 0);
      const W = Math.max(wrap.clientWidth - 4, 800);
      const H = (maxD + 1) * ROW_H + PAD * 2;

      const svg = svgx.createSVG(W, H);
      svg.setAttribute("class", "flame-svg");
      const frag = document.createDocumentFragment();

      for (const e of trace.sorted(run)) {
        const d = depth.get(e.id);
        const x = PAD + (e.t / total) * (W - PAD * 2);
        const w = Math.max((e.dur / total) * (W - PAD * 2), 2);
        const y = PAD + d * ROW_H;
        const g = svgx.elNS("g", { class: "flame-cell", tabindex: "0", role: "button" });
        g.dataset.eid = e.id;
        const rect = svgx.elNS("rect", {
          x, y, width: w, height: ROW_H - 3, rx: 3,
          fill: TYPE_COLOR[e.type],
          class: this.critical.has(e.id) ? "critical" : ""
        });
        if (this.bottlenecks.has(e.id)) rect.classList.add("bottleneck");
        g.appendChild(rect);
        if (w > LABEL_MIN_W) {
          const t = svgx.elNS("text", { x: x + 5, y: y + 19 });
          t.textContent = `${e.id} ${e.name}`.slice(0, Math.floor(w / 7));
          g.appendChild(t);
        }
        const title = svgx.elNS("title");
        title.textContent = `${e.id} ${e.name} · ${util.fmtMs(e.dur)} · depth ${d}`;
        g.appendChild(title);
        frag.appendChild(g);
      }
      svg.appendChild(frag);
      wrap.appendChild(svg);

      if (!this._delegated) {
        this._delegated = true;
        wrap.addEventListener("click", (ev) => {
          const cell = ev.target.closest(".flame-cell");
          if (cell) this.hooks.onSelect(cell.dataset.eid);
        });
      }
    }
  }

  root.DSTS = root.DSTS || {};
  root.DSTS.flame = { Flame };
})(typeof self !== "undefined" ? self : globalThis);
