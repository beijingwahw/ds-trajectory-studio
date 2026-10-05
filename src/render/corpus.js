/* ============================================================
 * DS Trajectory Studio — render/corpus
 * 语料库视图（第 6 标签页）：
 * - 导入 Manifest 报告（批量导入结果汇总）
 * - fork 谱系图（家族树 SVG，点击节点打开 Run）
 * - 语料指标表（排序 + 打开/设为对比 A B 快捷操作）
 * ============================================================ */
(function (root) {
  "use strict";
  const { util, trace, corpus, svg: svgx } = root.DSTS;

  const HEALTH_META = { ok: ["●", "var(--c-ok)"], warn: ["▲", "var(--c-warn)"] };

  /* ---------- 导入 Manifest ---------- */
  function renderManifest(container, manifest) {
    container.innerHTML = "";
    if (!manifest || !manifest.items.length) {
      container.appendChild(util.el("div", "empty-hint", "尚未进行批量导入 · 拖入多个 session JSONL 文件试试"));
      return;
    }
    const okCount = manifest.items.filter((x) => x.ok).length;
    container.appendChild(util.el("div", "crit-summary",
      `最近批量导入：<b>${okCount}</b>/${manifest.items.length} 成功` +
      (manifest.merges.length ? ` · <b>${manifest.merges.length}</b> 组多代合并` : "") +
      (manifest.dupes.length ? ` · <b>${manifest.dupes.length}</b> 个重复跳过` : "")));
    for (const it of manifest.items) {
      const cls = it.ok ? "better" : "worse";
      container.appendChild(util.el("div", "div-item",
        `<span class="${cls}">${it.ok ? "✓" : "✗"}</span> <b>${util.esc(it.file)}</b>
         <span class="dim-text">${it.ok ? `${util.esc(it.format)} · ${it.events} 事件` : util.esc(it.error || "解析失败")}</span>`));
    }
  }

  /* ---------- fork 谱系图 ---------- */
  function renderLineage(container, runs, onOpen) {
    container.innerHTML = "";
    const forest = corpus.buildLineageForest(runs);
    const hasLinks = [...forest.children.values()].some((c) => c.length);
    if (!hasLinks) {
      container.appendChild(util.el("div", "empty-hint", "语料中暂无 fork 谱系关联（导入互为父子会话的多个 session 后自动出现）"));
      return;
    }
    const NODE_W = 200, NODE_H = 40, GAP_X = 24, GAP_Y = 64, PAD = 16;
    // 分层布局：depthOf 分层，层内按序
    const layers = new Map();
    forest.depthOf.forEach((d, id) => {
      if (!layers.has(d)) layers.set(d, []);
      layers.get(d).push(id);
    });
    const pos = new Map();
    let maxW = 0;
    layers.forEach((ids, d) => {
      ids.forEach((id, i) => {
        pos.set(id, { x: i * (NODE_W + GAP_X), y: d * (NODE_H + GAP_Y) });
        maxW = Math.max(maxW, (i + 1) * (NODE_W + GAP_X));
      });
    });
    const maxD = Math.max(...forest.depthOf.values());
    const W = maxW + PAD * 2, H = (maxD + 1) * (NODE_H + GAP_Y) + PAD * 2;
    const svg = svgx.createSVG(W, H);
    const g = svgx.elNS("g", { transform: `translate(${PAD},${PAD})` });
    svg.appendChild(g);
    // 边
    forest.children.forEach((kids, pid) => {
      const a = pos.get(pid);
      for (const kid of kids) {
        const b = pos.get(kid);
        if (!a || !b) continue;
        g.appendChild(svgx.elNS("path", {
          d: svgx.curveDown(a.x + NODE_W / 2, a.y + NODE_H, b.x + NODE_W / 2, b.y),
          class: "dag-edge", "marker-end": "url(#dsts-arr)"
        }));
      }
    });
    // 节点
    const byId = new Map(runs.map((r) => [r.id, r]));
    forest.depthOf.forEach((d, id) => {
      const r = byId.get(id);
      const p = pos.get(id);
      if (!r || !p) return;
      const node = svgx.elNS("g", { class: "dag-node lineage-node", tabindex: "0", role: "button" });
      node.dataset.rid = id;
      const isChild = d > 0;
      const rect = svgx.elNS("rect", {
        x: p.x, y: p.y, width: NODE_W, height: NODE_H, rx: 6,
        fill: isChild ? "#123a4a" : "#1a2332",
        stroke: forest.dangling.has(id) ? "var(--c-warn)" : "var(--accent)",
        "stroke-width": 1.5
      });
      const t1 = svgx.elNS("text", { x: p.x + 8, y: p.y + 16, class: "lineage-label" });
      t1.textContent = `${isChild ? "⑂ " : "◈ "}${(r.label || r.id).slice(0, 20)}`;
      const t2 = svgx.elNS("text", { x: p.x + 8, y: p.y + 31, class: "lineage-sub" });
      t2.textContent = `${r.events.length} 事件 · ${util.fmtMs(trace.runEnd(r))}` + (forest.dangling.has(id) ? " · ⚠父未导入" : "");
      node.append(rect, t1, t2);
      g.appendChild(node);
    });
    container.appendChild(svg);
    if (!container.dataset.delegated) {
      container.dataset.delegated = "1";
      container.addEventListener("click", (ev) => {
        const n = ev.target.closest(".lineage-node");
        if (n) onOpen(n.dataset.rid);
      });
    }
  }

  /* ---------- 语料指标表 ---------- */
  let sortKey = "duration", sortDir = -1;
  function renderTable(container, runs, price, hooks) {
    container.innerHTML = "";
    if (!runs.length) { container.appendChild(util.el("div", "empty-hint", "语料库为空")); return; }
    const rows = runs.map((r) => corpus.corpusMetrics(r, price));
    const cols = [
      ["label", "Run", (v) => v], ["duration", "耗时", util.fmtMs], ["events", "事件", String],
      ["tokens", "Tokens", util.fmtTok], ["cacheHit", "缓存命中", (v) => util.fmtPct(v, 0)],
      ["cost", "成本", (v) => "¥" + v.toFixed(3)], ["errors", "错误", String]
    ];
    rows.sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * sortDir;
    });
    let html = `<table class="cmp-table corpus-table"><thead><tr>`;
    for (const [key, name] of cols) {
      html += `<th data-key="${key}" class="sortable">${name}${sortKey === key ? (sortDir < 0 ? " ↓" : " ↑") : ""}</th>`;
    }
    html += `<th>谱系</th><th>健康</th><th>操作</th></tr></thead><tbody>`;
    for (const r of rows) {
      const [icon, color] = HEALTH_META[r.health];
      html += `<tr>
        <td>${util.esc(String(r.label).slice(0, 34))}</td>
        <td>${util.fmtMs(r.duration)}</td><td>${r.events}</td>
        <td>${util.fmtTok(r.tokens)}</td><td>${util.fmtPct(r.cacheHit, 0)}</td>
        <td>¥${r.cost.toFixed(3)}</td>
        <td class="${r.errors ? "worse" : "better"}">${r.errors || "0"}</td>
        <td>${r.isSeeded ? "⑂ 子会话" : r.lineageDepth ? `⑂ L${r.lineageDepth}` : "—"}</td>
        <td style="color:${color}">${icon}</td>
        <td class="corpus-ops">
          <button data-act="open" data-id="${util.esc(r.id)}">打开</button>
          <button data-act="setA" data-id="${util.esc(r.id)}">A</button>
          <button data-act="setB" data-id="${util.esc(r.id)}">B</button>
        </td></tr>`;
    }
    container.innerHTML = html + "</tbody></table>";
    // 事件委托：排序 + 操作
    container.querySelectorAll("th.sortable").forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.key;
        if (sortKey === k) sortDir *= -1;
        else { sortKey = k; sortDir = -1; }
        renderTable(container, runs, price, hooks);
      };
    });
    container.querySelectorAll(".corpus-ops button").forEach((btn) => {
      btn.onclick = () => hooks[btn.dataset.act](btn.dataset.id);
    });
  }

  root.DSTS.corpusView = { renderManifest, renderLineage, renderTable };
})(typeof self !== "undefined" ? self : globalThis);
