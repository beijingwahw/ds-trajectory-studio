/* ============================================================
 * DS Trajectory Studio — main
 * 应用装配层：store 驱动的视图编排、工具栏、标签页、
 * 键盘快捷键、轨迹导入、导出。
 * 快捷键：1-4 切标签 · Space 播放 · ←/→ 单步 · F DAG适配 · E 导出MD
 * ============================================================ */
(function (root) {
  "use strict";
  const D = root.DSTS;
  const DATA = root.DSTS_DATA;
  const { util, engine, store, detail, perf, compare, io, image, report } = D;
  const $ = (s) => document.querySelector(s);

  /* ---------- 运行时数据（内置 + 导入的 Run 注册表） ---------- */
  const runRegistry = new Map(Object.entries(DATA.runs));
  const runIds = () => [...runRegistry.keys()];
  const price = DATA.task.pricePerMToken;

  /* ---------- 状态 ---------- */
  const st = store.createStore({
    runId: runIds()[0],
    compareA: runIds()[0],
    compareB: runIds()[1] || runIds()[0],
    selected: null,
    playhead: null,
    tab: "timeline",
    surfaceView: false
  });
  const curRun = () => runRegistry.get(st.get().runId);
  const analysis = () => engine.analyze(curRun());
  /** Worker 分析客户端（http 环境真后台线程；file:// 透明降级） */
  const analyzer = D.workerClient.createAnalyzer("src/analysis/worker.js");

  /* ---------- 视图实例 ---------- */
  const timeline = new D.timeline.Timeline($("#timelineWrap"), { onSelect: selectEvent });
  const dag = new D.dag.Dag($("#dagWrap"), { onSelect: selectEvent });
  const flame = new D.flame.Flame($("#flameWrap"), { onSelect: selectEvent });
  const replay = new D.replay.Replay({
    onStep(e) {
      st.patch({ selected: e.id, playhead: e.id });
      timeline.scrollTo(e.id);
    },
    onStop() { $("#btnReplayPlay").textContent = "▶"; }
  });

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
  }

  /* ---------- 渲染编排 ---------- */
  function renderLegend() {
    const items = Object.entries(D.timeline.TYPE_COLOR)
      .map(([k, color]) => `<span><i style="background:${color}"></i>${D.detail.TYPE_LABEL[k]}</span>`).join("");
    $("#legend").innerHTML = items + `<span><i style="background:transparent;box-shadow:0 0 0 2px var(--c-bn)"></i>瓶颈</span>`;
  }

  let renderSeq = 0; // 异步分析的竞态保护：仅最新一次渲染生效
  async function renderCurrent() {
    const run = curRun();
    const seq = ++renderSeq;
    let an;
    try {
      an = await D.profiler.measureAsync("analysis", analyzer.analyze(run));
    } catch (err) {
      toast(`分析引擎异常（已容错）：${String(err.message || err).slice(0, 80)}`);
      an = { findings: [], stats: {}, bottleneckIds: new Set(), runEnd: 1 };
    }
    if (seq !== renderSeq || curRun() !== run) return;
    D.profiler.measure("render.views", () => {
      // 关键路径（CPM）：零松弛事件——只有优化它们才能缩短端到端耗时
      const cp = D.criticalpath.criticalPath(run.events, an.runEnd);
      const criticalSet = new Set(cp.path);
      // 模型视角：DSH surface 重建——被 compaction 遮蔽的事件集合
      const shadow = st.get().surfaceView && run.surface ? new Set(run.surface.shadowedSeqs) : null;
      timeline.setData(run, an.bottleneckIds, shadow);
      updateSurfaceUI(run);
      dag.setData(run, an.bottleneckIds, criticalSet);
      flame.setData(run, an.bottleneckIds, criticalSet);
      perf.renderMetrics($("#perfSummary"), run, an, price);
      perf.renderFindings($("#findings"), an, jumpToEvent);
      perf.renderCharts({ dur: $("#chartDur"), token: $("#chartToken"), phase: $("#chartPhase") }, run);
      renderCriticalPath(cp);
    });
    renderSelection();
  }

  /** 模型视角 UI：按钮状态 + 表面统计信息 + 完整性警告 */
  function updateSurfaceUI(run) {
    const btn = $("#btnSurfaceView");
    const info = $("#surfaceInfo");
    const has = !!run.surface;
    btn.disabled = !has;
    btn.classList.toggle("active", has && st.get().surfaceView);
    if (!has) { info.textContent = ""; return; }
    const total = run.surface.finalSurfaceSize + run.surface.shadowedSeqs.length;
    info.textContent = st.get().surfaceView
      ? `模型当前可见 ${run.surface.finalSurfaceSize}/${total} 表面节点 · ${run.surface.shadowedSeqs.length} 个被压缩遮蔽`
      : `surface: ${total} 节点 · ${run.surface.replacements.length} 次替换`;
    // 谱系提示
    if (run.lineage && run.lineage.isSeeded) {
      info.textContent += ` · ⑂ fork 自 ${String(run.lineage.parent).slice(0, 14)}（继承 ${run.lineage.inheritedCut + 1} 事件）`;
    }
    // 完整性警告
    const h = run.health;
    if (h && (h.gaps.length || h.unknownRequired.length)) {
      info.textContent += ` · ⚠ ${h.gaps.length} 处 seq 间隙 / ${h.unknownRequired.length} 类未知必需事件`;
      info.style.color = "var(--c-warn)";
    } else {
      info.style.color = "";
    }
  }

  /** 关键路径面板：主关键链 + 占端到端耗时比例 */
  function renderCriticalPath(cp) {
    const box = $("#critPath");
    box.innerHTML = "";
    if (!cp.path.length) { box.appendChild(util.el("div", "empty-hint", "无关键路径")); return; }
    box.appendChild(util.el("div", "crit-summary",
      `主关键链 <b>${cp.path.length}</b> 个关键事件 · 累计 <b>${util.fmtMs(cp.criticalDur)}</b> · 占端到端 <b>${util.fmtPct(cp.criticalRatio, 1)}</b>`));
    const chain = util.el("div", "chain");
    cp.path.forEach((id) => {
      const c = util.el("span", "chip crit-chip", util.esc(id));
      c.setAttribute("role", "button");
      c.tabIndex = 0;
      c.onclick = () => jumpToEvent(id);
      chain.appendChild(c);
    });
    box.appendChild(chain);
    box.appendChild(util.el("div", "dim-text", "其余事件均存在松弛时间：优化它们无法缩短端到端耗时。"));
  }

  function renderSelection() {
    const id = st.get().selected;
    timeline.setSelected(id);
    timeline.setPlayhead(st.get().playhead);
    dag.setSelected(id);
    const e = id && curRun().events.find((x) => x.id === id);
    const html = '<div class="empty-hint">点击事件查看详情</div>';
    if (e) {
      detail.renderDetail($("#detailPanel"), curRun(), e, selectEvent);
      detail.renderDetail($("#dagDetail"), curRun(), e, selectEvent);
    } else {
      $("#detailPanel").innerHTML = html;
      $("#dagDetail").innerHTML = html;
    }
  }

  function renderCompareView() {
    const ids = runIds();
    // A/B 选择器与注册表同步
    for (const [selId, key] of [["#cmpASelect", "compareA"], ["#cmpBSelect", "compareB"]]) {
      const sel = $(selId);
      const prev = st.get()[key];
      sel.innerHTML = "";
      for (const id of ids) {
        const o = util.el("option", null, util.esc(runRegistry.get(id).label || id));
        o.value = id;
        sel.appendChild(o);
      }
      sel.value = runRegistry.has(prev) ? prev : (key === "compareA" ? ids[0] : (ids[1] || ids[0]));
      sel.onchange = () => st.patch({ [key]: sel.value });
    }
    const A = runRegistry.get($("#cmpASelect").value);
    const B = runRegistry.get($("#cmpBSelect").value);
    const byT = (x, y) => x.t - y.t;
    const alignment = D.diff.align(A.events.slice().sort(byT), B.events.slice().sort(byT));
    compare.renderSummary($("#cmpSummaryWrap"), A, B, alignment);
    compare.renderMetricsTable($("#compareMetrics"), A, B, price);
    compare.renderCurves($("#cmpCurves"), A, B);
    compare.renderTornado($("#cmpTornado"), alignment, A, B);
    compare.renderLanes($("#compareLanes"), A, B, (runId, eid) => {
      st.patch({ runId, selected: eid, tab: "timeline" });
      syncTabUI();
    });
    compare.renderDivergence($("#divergence"), A, B);
  }

  /* ---------- 交互动作 ---------- */
  function selectEvent(id) { st.patch({ selected: id }); }

  function jumpToEvent(id) {
    st.patch({ selected: id, tab: "timeline" });
    syncTabUI();
    timeline.scrollTo(id);
  }

  function switchRun(id) {
    replay.stop();
    replay.setRun(runRegistry.get(id));
    st.patch({ runId: id, selected: null, playhead: null, surfaceView: false });
  }

  /* ---------- 实时轨迹流（on_trace_event 钩子语义） ---------- */
  let live = null;
  function updateLiveBtn() {
    $("#btnLive").textContent = live && live.active ? "■ 停止流" : "◉ 实时流";
  }
  function toggleLive() {
    if (live && live.active) { live.stop(); live = null; updateLiveBtn(); return; }
    const full = DATA.generateStressRun(16, "run-live", 7);
    full.label = "实时流 Run · on_trace_event";
    const [first, ...rest] = full.events;
    const liveRun = { ...full, events: [first] };
    runRegistry.set(liveRun.id, liveRun);
    st._rebuildRunOptions();
    switchRun(liveRun.id);
    toast("实时流开始：事件逐条到达（跟随模式）");
    live = new D.livestream.LiveStream(liveRun, rest, {
      onEvent(e, done) {
        renderCurrent();
        if (e) {
          st.patch({ playhead: e.id, selected: e.id });
          timeline.scrollTo(e.id);
        }
        if (done) { toast("实时流结束：16 个事件全部到达"); live = null; updateLiveBtn(); }
      }
    });
    live.start(650);
    updateLiveBtn();
  }

  function syncTabUI() {
    const tab = st.get().tab;
    document.querySelectorAll(".tab").forEach((t) => {
      const active = t.dataset.tab === tab;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".tabpane").forEach((p) =>
      p.classList.toggle("active", p.id === "tab-" + tab));
    if (tab === "compare") renderCompareView();
    if (tab === "corpus") renderCorpusTab();
  }

  /* ---------- Store 订阅 ---------- */
  st.subscribe((state, changed) => {
    if (changed.includes("runId")) {
      $("#runSelect").value = state.runId;
      renderCurrent();
      if (state.tab === "compare") renderCompareView();
    }
    if (changed.includes("compareA") || changed.includes("compareB")) {
      if (state.tab === "compare") renderCompareView();
    }
    if (changed.includes("surfaceView")) renderCurrent();
    if (changed.includes("selected") || changed.includes("playhead")) renderSelection();
    if (changed.includes("tab")) syncTabUI();
  });

  /* ---------- 工具栏 ---------- */
  function initTopbar() {
    $("#taskInfo").innerHTML =
      `<b>${util.esc(DATA.task.title)}</b> · ${util.esc(DATA.task.repo)} · ${util.esc(DATA.task.model)} · Harness v${util.esc(DATA.task.harnessVersion)}`;

    const sel = $("#runSelect");
    const rebuildOptions = () => {
      sel.innerHTML = "";
      for (const [id, r] of runRegistry) {
        const o = util.el("option", null, util.esc(r.label || id));
        o.value = id;
        sel.appendChild(o);
      }
      sel.value = st.get().runId;
    };
    rebuildOptions();
    sel.onchange = () => switchRun(sel.value);
    st._rebuildRunOptions = rebuildOptions;

    $("#btnReplayPlay").onclick = () => {
      replay.toggle();
      $("#btnReplayPlay").textContent = replay.playing ? "⏸" : "▶";
    };
    $("#btnReplayNext").onclick = () => replay.step(1);
    $("#btnReplayPrev").onclick = () => replay.step(-1);
    $("#replaySpeed").onchange = (e) => replay.setSpeed(parseInt(e.target.value, 10));

    $("#btnExportMd").onclick = () => {
      const md = report.buildMarkdown(DATA, curRun(), analysis());
      image.download(`ds-trajectory-report-${st.get().runId}.md`, new Blob([md], { type: "text/markdown" }));
      toast("Markdown 报告已导出");
    };
    $("#btnExportHtml").onclick = () => {
      const md = report.buildMarkdown(DATA, curRun(), analysis());
      const html = report.buildHtml(md, "DS Trajectory 调试报告");
      image.download(`ds-trajectory-report-${st.get().runId}.html`, new Blob([html], { type: "text/html" }));
      toast("HTML 报告已导出");
    };
    $("#btnExportDag").onclick = () => {
      if (!dag.svgEl) { toast("请先切换到因果图标签页"); return; }
      image.exportPNG(dag.svgEl, `dag-${st.get().runId}.png`);
      toast("DAG 快照已导出 (PNG 2×)");
    };
    $("#btnRepro").onclick = () => {
      const run = curRun();
      // 成功兄弟 Run（用于分叉点处方）；内置样例附带真实修复 patch
      const siblingId = st.get().compareB !== run.id ? st.get().compareB : st.get().compareA;
      const siblingRun = siblingId !== run.id && runRegistry.has(siblingId) ? runRegistry.get(siblingId) : null;
      const sampleRepro = (run.id === "run-a" || run.id === "run-b") ? DATA.repro : null;
      const bundle = D.repro.buildReproBundle(run, analysis(), {
        task: DATA.task, siblingRun, sampleRepro
      });
      const files = [
        [`repro-${run.id}.json`, bundle.json, "application/json"],
        [`repro-${run.id}.md`, bundle.md, "text/markdown"],
        [`repro-${run.id}.sh`, bundle.sh, "text/x-sh"],
        [`repro-verify-${run.id}.sh`, bundle.verifySh, "text/x-sh"]
      ];
      if (bundle.minJson) files.unshift([`repro-${run.id}.min.json`, bundle.minJson, "application/json"]);
      if (bundle.patch) files.push(["repro-1287.patch", bundle.patch, "text/plain"]);
      files.forEach(([name, content, mime], i) =>
        setTimeout(() => image.download(name, new Blob([content], { type: mime })), i * 250));
      const minInfo = bundle.meta.min
        ? ` · 最小集 ${bundle.meta.min.events.length}/${bundle.meta.min.originalCount} 事件 · ${bundle.extractedCommands} 条真实命令`
        : "";
      toast(`复现包已导出（${files.length} 个文件）${minInfo}`);
    };
    $("#btnLive").onclick = toggleLive;
    $("#btnSurfaceView").onclick = () => st.patch({ surfaceView: !st.get().surfaceView });
    $("#btnImport").onclick = () => $("#fileImport").click();
    $("#fileImport").onchange = (e) => {
      for (const file of e.target.files || []) importQueued(file);
      e.target.value = "";
    };
  }

  /* ---------- 轨迹导入（批量协调：去重 + 多代合并 + Manifest） ---------- */
  const batch = { pending: 0, entries: [], items: [] };
  let manifest = { items: [], merges: [], dupes: [] };

  function importQueued(file) {
    batch.pending++;
    io.importFile(file, {
      onImport(runs, format, fileName) {
        batch.pending--;
        for (const r of runs) batch.entries.push({ run: r, file: fileName, format });
        batch.items.push({ file: fileName, ok: true, format, events: runs.reduce((s, r) => s + r.events.length, 0) });
        finalizeBatch();
      },
      onError(errors, fileName) {
        batch.pending--;
        batch.items.push({ file: fileName || "未知文件", ok: false, error: errors[0].split("\n")[0] });
        console.error("[DSTS] 导入校验失败:\n" + errors.join("\n"));
        finalizeBatch();
      }
    });
  }

  function finalizeBatch() {
    if (batch.pending > 0 || !batch.items.length) return;
    // 1) 批内 + 对注册表签名去重
    const existingSigs = new Set([...runRegistry.values()].map(D.corpus.signatureOf));
    const fresh = batch.entries.filter((x) => !existingSigs.has(D.corpus.signatureOf(x.run)));
    const registryDupes = batch.entries.length - fresh.length;
    const { kept, dupes } = D.corpus.dedupeRuns(fresh.map((x) => x.run));
    // 2) 同会话多代合并
    const { runs: merged, merges } = D.corpus.mergeGenerations(kept);
    // 3) 注册 + 持久化
    for (const r of merged) {
      if (runRegistry.has(r.id)) runRegistry.delete(r.id);
      runRegistry.set(r.id, r);
      D.persist.saveRun(r);
    }
    st._rebuildRunOptions();
    manifest = { items: batch.items.slice(), merges, dupes: [...dupes, ...Array(registryDupes).fill("registry")] };
    const okCount = batch.items.filter((i) => i.ok).length;
    toast(`导入完成：${okCount}/${batch.items.length} 文件` +
      (merges.length ? ` · ${merges.length} 组多代合并` : "") +
      (dupes.length + registryDupes ? ` · ${dupes.length + registryDupes} 重复跳过` : ""));
    // 完整性体检警告
    const last = merged[merged.length - 1];
    if (last && last.health && last.health.unknownRequired.length) {
      setTimeout(() => toast(`⚠ 日志含 ${last.health.unknownRequired.length} 类未知必需事件，可能由高版本 Harness 写入`), 3200);
    }
    if (last) switchRun(last.id);
    if (batch.items.length > 1) st.patch({ tab: "corpus" }); // 批量 → 直达语料库
    batch.entries = [];
    batch.items = [];
  }

  /* ---------- 语料库视图 ---------- */
  function renderCorpusTab() {
    const runs = [...runRegistry.values()];
    D.corpusView.renderManifest($("#corpusManifest"), manifest);
    D.corpusView.renderLineage($("#corpusLineage"), runs, (id) => {
      switchRun(id);
      st.patch({ tab: "timeline" });
    });
    D.corpusView.renderTable($("#corpusTable"), runs, price, {
      open: (id) => { switchRun(id); st.patch({ tab: "timeline" }); },
      setA: (id) => { st.patch({ compareA: id }); toast(`对比 A ← ${id}`); },
      setB: (id) => { st.patch({ compareB: id }); toast(`对比 B ← ${id}`); }
    });
  }

  /* ---------- 标签页 & 键盘 ---------- */
  const TABS = ["timeline", "dag", "flame", "perf", "compare", "corpus"];
  function initTabs() {
    document.querySelectorAll(".tab").forEach((t) => {
      t.onclick = () => st.patch({ tab: t.dataset.tab });
    });
  }
  /* ---------- 自观测 HUD（Ctrl+Shift+D） ---------- */
  function initHud() {
    const hud = $("#hud");
    const paint = () => {
      hud.innerHTML = "<b>自观测 Profiler</b>" + (D.profiler.recent(8)
        .map((x) => `<div class="hud-row"><span>${util.esc(x.name)}</span><span>${x.ms.toFixed(1)}ms</span></div>`)
        .join("") || '<div class="hud-row">暂无记录</div>');
    };
    D.profiler.subscribe(() => { if (!hud.classList.contains("hidden")) paint(); });
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        hud.classList.toggle("hidden");
        if (!hud.classList.contains("hidden")) paint(); // 打开时回填历史记录
      }
    });
  }

  function initKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input,select,textarea")) return;
      const tabIdx = ["1", "2", "3", "4", "5", "6"].indexOf(e.key);
      if (tabIdx >= 0) return st.patch({ tab: TABS[tabIdx] });
      switch (e.key) {
        case " ": e.preventDefault(); $("#btnReplayPlay").click(); break;
        case "ArrowRight": replay.step(1); break;
        case "ArrowLeft": replay.step(-1); break;
        case "f": case "F": if (st.get().tab === "dag") dag.fit(); break;
        case "e": case "E": $("#btnExportMd").click(); break;
        case "m": case "M": if (!$("#btnSurfaceView").disabled) $("#btnSurfaceView").click(); break;
      }
    });
  }

  /* ---------- 全局错误边界：坏数据/渲染异常不白屏 ---------- */
  function initErrorBoundary() {
    window.addEventListener("error", (e) => {
      console.error("[DSTS] 已捕获异常:", e.error || e.message);
      toast(`异常已捕获：${String(e.message).slice(0, 80)}`);
    });
    window.addEventListener("unhandledrejection", (e) => {
      console.error("[DSTS] 未处理的 Promise 拒绝:", e.reason);
      toast(`异步异常已捕获：${String(e.reason && e.reason.message || e.reason).slice(0, 80)}`);
      e.preventDefault();
    });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    initTopbar();
    initTabs();
    initKeyboard();
    initHud();
    initErrorBoundary();
    io.attachDropImport(document.body, {
      onImport: (runs, format, fileName) => {
        batch.pending++;
        // 拖拽路径：importFile 已完成解析，直接复用批量收集
        for (const r of runs) batch.entries.push({ run: r, file: fileName, format });
        batch.items.push({ file: fileName || "拖拽文件", ok: true, format, events: runs.reduce((s, r) => s + r.events.length, 0) });
        batch.pending--;
        finalizeBatch();
      },
      onError: (errors, fileName) => {
        batch.items.push({ file: fileName || "拖拽文件", ok: false, error: errors[0].split("\n")[0] });
        finalizeBatch();
      }
    });
    // 从 IndexedDB 恢复历史导入轨迹
    D.persist.loadAll().then((runs) => {
      let n = 0;
      for (const r of runs) {
        if (!runRegistry.has(r.id)) { runRegistry.set(r.id, r); n++; }
      }
      if (n) { st._rebuildRunOptions(); toast(`已从本地恢复 ${n} 条历史导入轨迹`); }
    });
    // 压测模式：?stress=N 注入合成轨迹，验证虚拟滚动与大规模渲染
    const stressN = parseInt(new URLSearchParams(location.search).get("stress") || "0", 10);
    if (stressN > 0) {
      const r = DATA.generateStressRun(stressN);
      runRegistry.set(r.id, r);
      st._rebuildRunOptions();
      st.patch({ runId: r.id });
      toast(`压测模式：${stressN} 事件（虚拟滚动渲染中）`);
    }
    replay.setRun(curRun());
    renderLegend();
    renderCurrent();
    syncTabUI();
  }
  boot();
})(typeof self !== "undefined" ? self : globalThis);
