/* ============================================================
 * DS Trajectory Studio — render/perf
 * 性能分析视图：指标卡 / 诊断列表 / 三组水平条形图。
 * ============================================================ */
(function (root) {
  "use strict";
  const { util, trace } = root.DSTS;
  const { TYPE_COLOR } = root.DSTS.timeline;

  const SEV_LABEL = { high: "高", mid: "中", low: "低" };

  function renderMetrics(container, run, analysis, price) {
    container.innerHTML = "";
    const items = [
      [util.fmtMs(trace.runEnd(run)), "端到端耗时"],
      [trace.countBy(run, "llm"), "LLM 调用"],
      [trace.countBy(run, "tool"), "工具调用"],
      [util.fmtTok(trace.tokSum(run)), "Token 总量"],
      ["¥" + trace.costOf(run, price).toFixed(3), "估算成本（含缓存折扣）"],
      [analysis.findings.filter((f) => f.sev === "high").length, "高危瓶颈"]
    ];
    const hitRate = trace.cacheHitRate(run);
    if (hitRate > 0) items.splice(4, 0, [util.fmtPct(hitRate, 1), "KV 缓存命中率"]);
    for (const [v, k] of items) {
      container.appendChild(util.el("div", "metric-card", `<div class="v">${v}</div><div class="k">${k}</div>`));
    }
  }

  function renderFindings(container, analysis, onJump) {
    container.innerHTML = "";
    if (!analysis.findings.length) {
      container.appendChild(util.el("div", "empty-hint", "未发现瓶颈 🎉"));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const f of analysis.findings) {
      const item = util.el("div", "finding",
        `<div class="sev sev-${f.sev}">${SEV_LABEL[f.sev]}</div>
         <div><b>${util.esc(f.title)}</b> <span class="dim-text">[${util.esc(f.ev)} · ${util.esc(f.ruleId)}]</span><br>
         ${util.esc(f.desc)}<br><span class="fx">💡 建议：${util.esc(f.fix)}</span></div>`);
      item.setAttribute("role", "button");
      item.tabIndex = 0;
      const go = () => onJump(f.ev.split(",")[0]);
      item.onclick = go;
      item.onkeydown = (ev) => { if (ev.key === "Enter") go(); };
      frag.appendChild(item);
    }
    container.appendChild(frag);
  }

  /** 通用水平条形图 */
  function hbar(container, rows, val, name, label, color) {
    container.innerHTML = "";
    if (!rows.length) { container.appendChild(util.el("div", "empty-hint", "无数据")); return; }
    const max = Math.max(...rows.map(val), 1);
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const r = util.el("div", "hbar-row");
      const nm = util.el("div", "nm", util.esc(name(row)));
      nm.title = name(row);
      const bar = util.el("div", "bar");
      bar.style.width = (val(row) / max * 100) + "%";
      bar.style.background = color(row);
      r.append(nm, bar, util.el("div", "val", util.esc(label(row))));
      frag.appendChild(r);
    }
    container.appendChild(frag);
  }

  function renderCharts(ids, run) {
    const evs = trace.sorted(run);
    hbar(ids.dur,
      evs.slice().sort((a, b) => b.dur - a.dur).slice(0, 8),
      (e) => e.dur, (e) => `${e.id} ${e.name}`, (e) => util.fmtMs(e.dur),
      (e) => TYPE_COLOR[e.type]);
    hbar(ids.token,
      evs.filter((e) => e.tokens.in + e.tokens.out > 0),
      (e) => e.tokens.in + e.tokens.out,
      (e) => `${e.id} ${e.name}`, (e) => `${util.fmtTok(e.tokens.in)}→${util.fmtTok(e.tokens.out)}`,
      () => "var(--c-llm)");
    const total = util.sum(evs, (e) => e.dur) || 1;
    hbar(ids.phase,
      trace.phases(run),
      (p) => p.dur, (p) => p.label, (p) => `${util.fmtMs(p.dur)} (${util.fmtPct(p.dur / total)})`,
      (p) => TYPE_COLOR[p.key] || "var(--c-obs)");
  }

  root.DSTS.perf = { renderMetrics, renderFindings, renderCharts };
})(typeof self !== "undefined" ? self : globalThis);
