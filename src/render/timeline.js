/* ============================================================
 * DS Trajectory Studio — render/timeline
 * 甘特时间线视图（v0.3：虚拟滚动）。
 * - 窗口化渲染：仅挂载可视区 ± overscan 的 DOM 行，
 *   10k+ 事件下 DOM 节点数保持 O(视口)，与数据规模无关
 * - 视口缩放（Ctrl+滚轮，指针锚点）/ 拖拽平移 / 双击复位
 * - 事件委托 + DocumentFragment 批量挂载
 * ============================================================ */
(function (root) {
  "use strict";
  const { util, trace } = root.DSTS;

  const TYPE_COLOR = {
    llm: "var(--c-llm)", tool: "var(--c-tool)", thought: "var(--c-thought)",
    observation: "var(--c-obs)", error: "var(--c-error)"
  };
  const ROW_H = 34, AXIS_H = 20, OVERSCAN = 8, LABEL_W = 220;

  class Timeline {
    constructor(wrap, hooks) {
      this.wrap = wrap;
      this.hooks = hooks;
      this.view = null;
      this.run = null;
      this.evs = [];
      this.bottlenecks = new Set();
      this.selected = null;
      this.playheadId = null;
      this._bindGestures();
      this._bindScroll();
    }

    setData(run, bottlenecks, shadowSet) {
      this.run = run;
      this.evs = trace.sorted(run);
      this.bottlenecks = bottlenecks;
      this.shadow = shadowSet || null; // 模型视角：被 compaction 遮蔽的事件 seq 集合
      this.view = null;
      this.render();
    }
    setSelected(id) { this.selected = id; this._markRows(); }
    setPlayhead(id) { this.playheadId = id; this._markRows(); }

    range() {
      const total = trace.runEnd(this.run);
      return this.view || { start: 0, end: total };
    }

    render() {
      const { wrap } = this;
      wrap.innerHTML = "";
      if (!this.run) { this.viewport = null; return; }
      const { start, end } = this.range();
      const span = Math.max(end - start, 1);

      // 刻度轴（自适应整数刻度）
      const axis = util.el("div", "tl-axis");
      for (const t of util.niceTicks(span, 10)) {
        if (t > span) break;
        const s = util.el("span", null, util.fmtMs(start + t));
        s.style.left = (t / span * 100) + "%";
        axis.appendChild(s);
      }
      wrap.appendChild(axis);

      // 虚拟滚动视口：总高度撑开滚动条，行窗口绝对定位
      this.viewport = util.el("div", "tl-viewport");
      this.viewport.style.height = this.evs.length * ROW_H + "px";
      wrap.appendChild(this.viewport);
      // 视口重建必须使窗口缓存失效（否则 setData 后窗口命中缓存不重绘）
      this._winRendered = false;
      this._winFirst = this._winLast = -1;
      this._renderWindow();

      if (!this._delegated) {
        this._delegated = true;
        wrap.addEventListener("click", (ev) => {
          const row = ev.target.closest(".tl-row");
          if (row) this.hooks.onSelect(row.dataset.eid);
        });
      }
    }

    /** 仅渲染可视窗口内的行 */
    _renderWindow() {
      if (!this.viewport) return;
      const scrollTop = this.wrap.scrollTop;
      const viewH = this.wrap.clientHeight || 600;
      const first = Math.max(0, Math.floor((scrollTop - AXIS_H) / ROW_H) - OVERSCAN);
      const last = Math.min(this.evs.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
      if (first === this._winFirst && last === this._winLast && this._winRendered) { this._markRows(); return; }
      this._winFirst = first; this._winLast = last; this._winRendered = true;

      const { start, end } = this.range();
      const span = Math.max(end - start, 1);
      const frag = document.createDocumentFragment();
      for (let i = first; i < last; i++) {
        const e = this.evs[i];
        const row = util.el("div", "tl-row");
        row.dataset.eid = e.id;
        row.style.top = i * ROW_H + "px";
        if (this.shadow && e.seq != null && this.shadow.has(e.seq)) row.classList.add("shadowed");
        if (e.inherited) row.classList.add("inherited");
        const label = util.el("div", "tl-label", `${util.esc(e.id)} · ${util.esc(e.name)}`);
        label.title = e.name;
        const track = util.el("div", "tl-track");
        const bar = util.el("div", "tl-bar", e.dur / span > 0.04 ? util.fmtMs(e.dur) : "");
        bar.style.left = util.clamp((e.t - start) / span * 100, -5, 105) + "%";
        bar.style.width = Math.max(e.dur / span * 100, 0.7) + "%";
        bar.style.background = TYPE_COLOR[e.type];
        bar.title = `${e.name} · ${util.fmtMs(e.dur)}`;
        if (this.bottlenecks.has(e.id)) {
          bar.classList.add("bottleneck");
          bar.appendChild(util.el("span", "tl-badge", "🔥"));
        }
        track.appendChild(bar);
        row.append(label, track);
        frag.appendChild(row);
      }
      this.viewport.replaceChildren(frag);
      this._markRows();
    }

    _bindScroll() {
      let raf = 0;
      this.wrap.addEventListener("scroll", () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; this._renderWindow(); });
      }, { passive: true });
    }

    _markRows() {
      if (!this.viewport) return;
      this.viewport.querySelectorAll(".tl-row").forEach((row) => {
        row.classList.toggle("selected", row.dataset.eid === this.selected);
        row.classList.toggle("replay-current", row.dataset.eid === this.playheadId);
      });
    }

    scrollTo(id) {
      const idx = this.evs.findIndex((e) => e.id === id);
      if (idx < 0) return;
      const top = idx * ROW_H + AXIS_H;
      const { scrollTop, clientHeight } = this.wrap;
      if (top < scrollTop + AXIS_H || top > scrollTop + clientHeight - ROW_H) {
        this.wrap.scrollTo({ top: top - clientHeight / 2, behavior: "smooth" });
      }
      // 平滑滚动后窗口在 scroll 事件中刷新；此处兜底一次
      setTimeout(() => this._renderWindow(), 350);
    }

    _bindGestures() {
      const wrap = this.wrap;
      wrap.addEventListener("wheel", (ev) => {
        if (!this.run || !(ev.ctrlKey || ev.metaKey)) return;
        ev.preventDefault();
        const { start, end } = this.range();
        const span = end - start;
        const rect = wrap.getBoundingClientRect();
        const frac = util.clamp((ev.clientX - rect.left - LABEL_W) / Math.max(rect.width - LABEL_W, 1), 0, 1);
        const anchor = start + frac * span;
        const factor = ev.deltaY > 0 ? 1.25 : 0.8;
        const ns = util.clamp(span * factor, 500, trace.runEnd(this.run));
        const nstart = util.clamp(anchor - frac * ns, 0, trace.runEnd(this.run) - ns);
        this.view = { start: nstart, end: nstart + ns };
        this.render();
      }, { passive: false });

      let drag = null;
      wrap.addEventListener("pointerdown", (ev) => {
        if (!this.run || !ev.target.closest(".tl-track")) return;
        drag = { x: ev.clientX, ...this.range() };
        wrap.setPointerCapture(ev.pointerId);
      });
      wrap.addEventListener("pointermove", (ev) => {
        if (!drag) return;
        const rect = wrap.getBoundingClientRect();
        const span = drag.end - drag.start;
        const dms = -(ev.clientX - drag.x) / Math.max(rect.width - LABEL_W, 1) * span;
        const total = trace.runEnd(this.run);
        const nstart = util.clamp(drag.start + dms, 0, total - span);
        this.view = { start: nstart, end: nstart + span };
        this.render();
      });
      wrap.addEventListener("pointerup", () => (drag = null));
      wrap.addEventListener("dblclick", () => { this.view = null; this.render(); });
    }
  }

  root.DSTS.timeline = { Timeline, TYPE_COLOR };
})(typeof self !== "undefined" ? self : globalThis);
