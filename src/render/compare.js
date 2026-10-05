/* ============================================================
 * DS Trajectory Studio — render/compare
 * 分支对比视图：
 * - 指标 Δ 表（自动计算占优方）
 * - LCS 对齐泳道（match/sub/ins/del 四态着色）
 * - 分叉区间自动提取 + 数据层可选的策展注释（compareNotes）
 * ============================================================ */
(function (root) {
  "use strict";
  const { util, trace, diff, svg: svgx } = root.DSTS;
  const { TYPE_COLOR } = root.DSTS.timeline;

  /* ==================== v2 升维渲染 ==================== */

  /** 相似度仪表 + 同源前缀横幅 */
  function renderSummary(container, runA, runB, alignment) {
    container.innerHTML = "";
    const score = diff.alignmentScore(alignment);
    const pct = Math.round(score * 100);
    const hue = score > 0.75 ? "var(--c-ok)" : score > 0.45 ? "var(--c-warn)" : "var(--c-error)";
    const shared = diff.sharedPrefix(runA.events, runB.events);
    // fork 谱系关联：A 的父会话即 B（或反之）
    const linA = runA.lineage, linB = runB.lineage;
    const forkLinked = (linA && linA.parent && `dsh-${String(linA.parent).replace(/[^a-zA-Z0-9_-]/g, "-")}` === runB.id)
      || (linB && linB.parent && `dsh-${String(linB.parent).replace(/[^a-zA-Z0-9_-]/g, "-")}` === runA.id);

    container.appendChild(util.el("div", "cmp-summary",
      `<div class="gauge" style="--p:${pct};--gc:${hue}"><span>${pct}%</span></div>
       <div><b>轨迹相似度</b><br><span class="dim-text">NW 对齐加权评分 · match=1 / sub=相似度 / gap=0</span></div>
       ${shared >= 2 ? `<div class="fork-banner">⑂ 同源前缀 <b>${shared}</b> 事件 · 分叉于第 ${shared + 1} 个事件${forkLinked ? "（fork 谱系关联）" : ""}</div>` : ""}
       ${forkLinked && shared < 2 ? `<div class="fork-banner">⑂ fork 谱系关联</div>` : ""}`));
  }

  /** 累积 Token/耗时双曲线（SVG 双折线） */
  function renderCurves(container, runA, runB) {
    container.innerHTML = "";
    const W = Math.max(container.clientWidth - 20, 600), H = 220, PL = 54, PB = 22, PT = 10, PR = 14;
    const mk = (run) => ({
      tok: diff.cumulativeSeries(run.events, (e) => e.tokens.in + e.tokens.out),
      end: trace.runEnd(run)
    });
    const A = mk(runA), B = mk(runB);
    const maxX = Math.max(A.end, B.end, 1);
    const maxY = Math.max(A.tok.at(-1)[1], B.tok.at(-1)[1], 1);
    const X = (v) => PL + (v / maxX) * (W - PL - PR);
    const Y = (v) => H - PB - (v / maxY) * (H - PT - PB);
    const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");

    const svg = svgx.createSVG(W, H);
    // 轴与刻度
    for (let i = 0; i <= 4; i++) {
      const xv = (maxX / 4) * i, yv = (maxY / 4) * i;
      svg.appendChild(svgx.elNS("line", { x1: X(xv), y1: Y(0), x2: X(xv), y2: Y(maxY), class: "chart-grid" }));
      const t1 = svgx.elNS("text", { x: X(xv), y: H - 6, class: "chart-tick", "text-anchor": "middle" });
      t1.textContent = util.fmtMs(xv);
      svg.appendChild(t1);
      const t2 = svgx.elNS("text", { x: PL - 6, y: Y(yv) + 4, class: "chart-tick", "text-anchor": "end" });
      t2.textContent = util.fmtTok(Math.round(yv));
      svg.appendChild(t2);
    }
    const pA = svgx.elNS("path", { d: path(A.tok), class: "chart-line", stroke: "#818cf8" });
    const pB = svgx.elNS("path", { d: path(B.tok), class: "chart-line", stroke: "#22d3ee" });
    svg.append(pA, pB);
    // 端点标注
    const endA = A.tok.at(-1), endB = B.tok.at(-1);
    for (const [pt, color, label] of [[endA, "#818cf8", `A ${util.fmtTok(endA[1])}`], [endB, "#22d3ee", `B ${util.fmtTok(endB[1])}`]]) {
      svg.appendChild(svgx.elNS("circle", { cx: X(pt[0]), cy: Y(pt[1]), r: 4, fill: color }));
      const t = svgx.elNS("text", { x: X(pt[0]) - 4, y: Y(pt[1]) - 8, class: "chart-end", fill: color, "text-anchor": "end" });
      t.textContent = label;
      svg.appendChild(t);
    }
    container.appendChild(svg);
    container.appendChild(util.el("div", "dim-text",
      `<span style="color:#818cf8">━</span> ${util.esc(runA.label || "A")} &nbsp; <span style="color:#22d3ee">━</span> ${util.esc(runB.label || "B")} · 曲线分叉点即成本策略分叉点`));
  }

  /** 差分耗时 tornado 图（对齐事件对 Δdur，红=B 更慢 / 绿=B 更快，取 |Δ| Top 12） */
  function renderTornado(container, alignment, runA, runB) {
    container.innerHTML = "";
    const pairs = diff.pairDeltas(alignment)
      .filter((p) => p.dDur !== 0)
      .sort((x, y) => Math.abs(y.dDur) - Math.abs(x.dDur))
      .slice(0, 12);
    if (!pairs.length) {
      container.appendChild(util.el("div", "empty-hint", "对齐事件对耗时完全一致"));
      return;
    }
    const max = Math.max(...pairs.map((p) => Math.abs(p.dDur)), 1);
    const frag = document.createDocumentFragment();
    for (const p of pairs) {
      const row = util.el("div", "tornado-row");
      const bFaster = p.dDur < 0;
      row.appendChild(util.el("div", "nm", `${util.esc(p.a.id)}⇄${util.esc(p.b.id)} ${util.esc(p.b.name.slice(0, 12))}`));
      const track = util.el("div", "tornado-track");
      const bar = util.el("div", "tornado-bar " + (bFaster ? "faster" : "slower"));
      bar.style.width = (Math.abs(p.dDur) / max * 50) + "%";
      if (bFaster) bar.style.right = "50%";
      else bar.style.left = "50%";
      bar.title = `A ${util.fmtMs(p.a.dur)} → B ${util.fmtMs(p.b.dur)}`;
      track.appendChild(bar);
      row.appendChild(track);
      row.appendChild(util.el("div", "val " + (bFaster ? "better" : "worse"),
        `${bFaster ? "−" : "+"}${util.fmtMs(Math.abs(p.dDur))}`));
      frag.appendChild(row);
    }
    container.appendChild(frag);
    container.appendChild(util.el("div", "dim-text",
      `绿 = ${util.esc(runB.label || "B")} 更快 · 红 = 更慢 · 按 |Δ| 排序（对齐口径：NW 事件对）`));
  }

  const STATUS_META = {
    match: { label: "一致", cls: "al-match" },
    sub:   { label: "替换", cls: "al-sub" },
    del:   { label: "仅 A", cls: "al-del" },
    ins:   { label: "仅 B", cls: "al-ins" }
  };

  function renderMetricsTable(container, runA, runB, price) {
    const rows = diff.metricRows(runA, runB, price);
    let html = `<table class="cmp-table"><thead><tr><th>指标</th><th>${util.esc(runA.label || runA.id)}</th><th>${util.esc(runB.label || runB.id)}</th><th>Δ (B−A)</th></tr></thead><tbody>`;
    for (const r of rows) {
      const delta = r.delta === 0 ? "—" : (r.delta > 0 ? "+" : "−") + r.fdelta;
      html += `<tr><td>${util.esc(r.name)}</td>
        <td class="${r.betterA ? "better" : "worse"}">${util.esc(r.fa)}</td>
        <td class="${!r.betterA ? "better" : "worse"}">${util.esc(r.fb)}</td>
        <td>${util.esc(delta)}</td></tr>`;
    }
    container.innerHTML = html + "</tbody></table>";
  }

  /** 共享时间轴双泳道 + LCS 对齐表 */
  function renderLanes(container, runA, runB, onJump) {
    container.innerHTML = "";
    const total = Math.max(trace.runEnd(runA), trace.runEnd(runB));

    for (const r of [runA, runB]) {
      container.appendChild(util.el("div", "lane-title",
        `${util.esc(r.label || r.id)} · ${util.esc(r.strategy || "")}`));
      const track = util.el("div", "cmp-track");
      for (const e of r.events) {
        const bar = util.el("div");
        bar.title = `${e.id} ${e.name} (${util.fmtMs(e.dur)})`;
        bar.style.cssText = `left:${e.t / total * 100}%;width:${Math.max(e.dur / total * 100, 0.6)}%;background:${TYPE_COLOR[e.type]}`;
        bar.onclick = () => onJump(r.id, e.id);
        track.appendChild(bar);
      }
      container.appendChild(track);
    }

    // 对齐明细表
    const alignment = diff.align(trace.sorted(runA), trace.sorted(runB));
    const tbl = util.el("table", "cmp-table align-table");
    tbl.innerHTML = `<thead><tr><th>${util.esc(runA.label || "A")}</th><th>对齐</th><th>${util.esc(runB.label || "B")}</th></tr></thead>`;
    const tb = util.el("tbody");
    for (const it of alignment) {
      const meta = STATUS_META[it.status];
      const tr = util.el("tr", meta.cls);
      const cellA = it.a ? `${util.esc(it.a.id)} ${util.esc(it.a.name)}` : "—";
      const cellB = it.b ? `${util.esc(it.b.id)} ${util.esc(it.b.name)}` : "—";
      tr.innerHTML = `<td>${cellA}</td><td class="al-status">${meta.label}</td><td>${cellB}</td>`;
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    container.appendChild(util.el("div", "lane-title", "事件级 LCS 对齐"));
    container.appendChild(tbl);
  }

  /** 分叉区间：算法自动提取 + 影响自动量化排序；策展注释退化为补充解读 */
  function renderDivergence(container, runA, runB) {
    container.innerHTML = "";
    const alignment = diff.align(trace.sorted(runA), trace.sorted(runB));
    const blocks = diff.divergenceBlocks(alignment)
      .map((b, i) => ({ ...b, idx: i, impact: diff.blockImpact(b) }))
      .sort((x, y) => Math.abs(y.impact.dDur) - Math.abs(x.impact.dDur));
    const notes = (root.DSTS_DATA && root.DSTS_DATA.compareNotes) || [];

    if (!blocks.length) {
      container.appendChild(util.el("div", "empty-hint", "两条轨迹完全一致"));
      return;
    }
    blocks.forEach((b, rank) => {
      const aIds = b.items.filter((x) => x.a).map((x) => x.a.id);
      const bIds = b.items.filter((x) => x.b).map((x) => x.b.id);
      const kinds = b.kinds.map((k) => STATUS_META[k].label).join("/");
      const note = notes[b.idx];
      const imp = b.impact;
      const durCls = imp.dDur <= 0 ? "better" : "worse";
      const tokCls = imp.dTok <= 0 ? "better" : "worse";
      const html = `<b>⚡ 分叉 #${b.idx + 1}（${kinds}）</b>
        <span class="impact-badge ${durCls}">Δ耗时 ${imp.dDur <= 0 ? "−" : "+"}${util.fmtMs(Math.abs(imp.dDur))}</span>
        <span class="impact-badge ${tokCls}">Δtokens ${imp.dTok <= 0 ? "−" : "+"}${util.fmtTok(Math.abs(imp.dTok))}</span>
        <span class="dim-text">影响排名 #${rank + 1} · 起点 ${util.esc(b.startA || "—")}</span><br>
        <span class="dim-text">A:</span> ${util.esc(aIds.join(", ") || "—")} &nbsp;
        <span class="dim-text">B:</span> ${util.esc(bIds.join(", ") || "—")}<br>
        ${note ? `<span class="dim-text">解读：</span>${util.esc(note.d)}` : ""}`;
      container.appendChild(util.el("div", "div-item", html));
    });
  }

  root.DSTS.compare = { renderMetricsTable, renderLanes, renderDivergence, renderSummary, renderCurves, renderTornado };
})(typeof self !== "undefined" ? self : globalThis);
