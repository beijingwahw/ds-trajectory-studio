/* ============================================================
 * DS Trajectory Studio — render/dag
 * 因果 DAG 视图：
 * - 最长路径分层布局（topoDepth）
 * - 滚轮缩放（指针锚点）/ 拖拽平移 / fit 自适应 / 双击复位
 * - 点击节点 → 高亮因果祖先链（其余 dim）
 * ============================================================ */
(function (root) {
  "use strict";
  const { util, trace, svg: svgx, layout: layoutModel } = root.DSTS;
  const { TYPE_COLOR } = root.DSTS.timeline;

  const NODE_W = 150, NODE_H = 34, GAP_X = 30, GAP_Y = 78, PAD = 20;

  class Dag {
    constructor(wrap, hooks) {
      this.wrap = wrap;
      this.hooks = hooks;      // {onSelect(id)}
      this.run = null;
      this.bottlenecks = new Set();
      this.selected = null;
      this.svgEl = null;
      this.vb = null;          // viewBox {x,y,w,h}
      this._bindGestures();
    }

    setData(run, bottlenecks, critical) {
      this.run = run;
      this.bottlenecks = bottlenecks || new Set();
      this.critical = critical || new Set();
      this.render();
    }
    setSelected(id) { this.selected = id; this._applyHighlight(); }

    layout() {
      // 大规模轨迹先做链式压缩（>60 事件），渲染规模与数据量解耦
      this.displayEvents = this.run.events.length > 60
        ? layoutModel.compressChains(this.run.events, 6).events
        : this.run.events;
      // Barycenter 启发式层内排序（model/layout 纯函数，可测试）
      return layoutModel.layeredLayout(this.displayEvents, {
        nodeW: NODE_W, nodeH: NODE_H, gapX: GAP_X, gapY: GAP_Y, pad: PAD
      });
    }

    /** 瓶颈/关键判定：聚合节点涵盖其全部成员 */
    _has(set, e) {
      if (set.has(e.id)) return true;
      return Array.isArray(e.aggregate) && e.aggregate.some((id) => set.has(id));
    }

    render() {
      this.wrap.innerHTML = "";
      if (!this.run) return;
      const { pos, w, h } = this.layout();
      const evs = this.displayEvents;
      const svg = svgx.createSVG(w, h);
      // 自然尺寸渲染（1:1），缩放完全由 viewBox 控制，避免窄图被拉伸放大
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      this.fullVb = { x: 0, y: 0, w, h };
      this.vb = { ...this.fullVb };

      const g = svgx.elNS("g", { transform: `translate(${PAD},${PAD})` });
      svg.appendChild(g);

      // 边（基于压缩后的显示事件集）
      for (const e of evs) {
        for (const p of e.parents) {
          const a = pos.get(p), b = pos.get(e.id);
          if (!a || !b) continue;
          const path = svgx.elNS("path", {
            d: svgx.curveDown(a.x + NODE_W / 2, a.y + NODE_H, b.x + NODE_W / 2, b.y),
            class: "dag-edge" + (e.type === "error" || e.status === "error" ? " err" : ""),
            "marker-end": "url(#dsts-arr)"
          });
          path.dataset.from = p;
          path.dataset.to = e.id;
          g.appendChild(path);
        }
      }
      // 节点
      for (const e of evs) {
        const p = pos.get(e.id);
        if (!p) continue;
        const isAgg = Array.isArray(e.aggregate);
        const node = svgx.elNS("g", { class: "dag-node" + (isAgg ? " agg" : ""), tabindex: "0", role: "button" });
        node.dataset.eid = e.id;
        const rect = svgx.elNS("rect", { x: p.x, y: p.y, width: NODE_W, height: NODE_H, rx: 6, fill: TYPE_COLOR[e.type] });
        if (isAgg) {
          rect.setAttribute("stroke-dasharray", "6 3");
          rect.setAttribute("stroke", "var(--text-dim)");
          rect.setAttribute("stroke-width", "1.5");
        }
        if (this._has(this.bottlenecks, e)) {
          rect.setAttribute("stroke", "var(--c-bn)");
          rect.setAttribute("stroke-width", "3");
        } else if (this._has(this.critical, e)) {
          rect.setAttribute("stroke", "var(--c-crit)");
          rect.setAttribute("stroke-width", "2.5");
          rect.setAttribute("class", "critical");
        }
        const t1 = svgx.elNS("text", { x: p.x + 8, y: p.y + 15 });
        t1.textContent = isAgg ? `⛓ ×${e.aggregate.length} ${e.name.slice(0, 9)}` : `${e.id} ${e.name.slice(0, 12)}`;
        const t2 = svgx.elNS("text", { x: p.x + 8, y: p.y + 28 });
        t2.textContent = `${util.fmtMs(e.dur)}`;
        node.append(rect, t1, t2);
        g.appendChild(node);
      }
      this.wrap.appendChild(svg);
      this.svgEl = svg;

      if (!this._delegated) {
        this._delegated = true;
        this.wrap.addEventListener("click", (ev) => {
          const node = ev.target.closest(".dag-node");
          if (!node) return;
          const e = this.displayEvents.find((x) => x.id === node.dataset.eid);
          // 聚合节点：选中其首个成员事件
          this.hooks.onSelect(e && e.aggregate ? e.aggregate[0] : node.dataset.eid);
        });
      }
      this._applyHighlight();
    }

    _applyHighlight() {
      if (!this.svgEl) return;
      const id = this.selected;
      const anc = id ? new Set(trace.ancestors(this.run.events, id)).add(id) : null;
      const evById = new Map(this.displayEvents.map((x) => [x.id, x]));
      // 祖先判定聚合感知：成员属于祖先链的聚合节点视为命中
      const inChain = (dispId) => {
        if (!anc) return true;
        if (anc.has(dispId)) return true;
        const e = evById.get(dispId);
        return !!(e && e.aggregate && e.aggregate.some((m) => anc.has(m)));
      };
      this.svgEl.querySelectorAll(".dag-node").forEach((n) =>
        n.classList.toggle("dim", !!anc && !inChain(n.dataset.eid)));
      this.svgEl.querySelectorAll(".dag-edge").forEach((ed) => {
        const on = anc && inChain(ed.dataset.from) && inChain(ed.dataset.to);
        ed.classList.toggle("dim", !!anc && !on);
        ed.classList.toggle("ancestor", !!on);
      });
    }

    fit() { this.vb = { ...this.fullVb }; this._applyVb(); }
    _applyVb() {
      const { x, y, w, h } = this.vb;
      this.svgEl.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    }

    _bindGestures() {
      this.wrap.addEventListener("wheel", (ev) => {
        if (!this.svgEl) return;
        ev.preventDefault();
        const factor = ev.deltaY > 0 ? 1.2 : 0.85;
        const rect = this.svgEl.getBoundingClientRect();
        const fx = (ev.clientX - rect.left) / rect.width;
        const fy = (ev.clientY - rect.top) / rect.height;
        const { x, y, w, h } = this.vb;
        const nw = util.clamp(w * factor, this.fullVb.w / 8, this.fullVb.w * 2);
        const nh = util.clamp(h * factor, this.fullVb.h / 8, this.fullVb.h * 2);
        this.vb = { x: x + (w - nw) * fx, y: y + (h - nh) * fy, w: nw, h: nh };
        this._applyVb();
      }, { passive: false });

      let drag = null;
      this.wrap.addEventListener("pointerdown", (ev) => {
        if (!this.svgEl || ev.target.closest(".dag-node")) return;
        drag = { cx: ev.clientX, cy: ev.clientY, ...this.vb };
        this.wrap.setPointerCapture(ev.pointerId);
      });
      this.wrap.addEventListener("pointermove", (ev) => {
        if (!drag) return;
        const rect = this.svgEl.getBoundingClientRect();
        this.vb = {
          ...this.vb,
          x: drag.x - (ev.clientX - drag.cx) / rect.width * drag.w,
          y: drag.y - (ev.clientY - drag.cy) / rect.height * drag.h
        };
        this._applyVb();
      });
      this.wrap.addEventListener("pointerup", () => (drag = null));
      this.wrap.addEventListener("dblclick", () => this.fit());
    }
  }

  root.DSTS.dag = { Dag };
})(typeof self !== "undefined" ? self : globalThis);
