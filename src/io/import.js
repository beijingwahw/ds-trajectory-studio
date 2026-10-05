/* ============================================================
 * DS Trajectory Studio — io/import
 * 真实轨迹导入：统一入口，自动识别三种真实数据格式：
 *   1. 原生 Run / { runs: {...} }        —— 插件内部格式
 *   2. OTLP/JSON（OTel GenAI 语义约定）   —— resourceSpans 结构
 *   3. DSH append-only 日志               —— JSONL 或事件数组
 * 全部经 Schema 校验 + 因果环检测后才允许进入注册表。
 * ============================================================ */
(function (root) {
  "use strict";
  const { trace, otlp, dsh } = root.DSTS;

  /**
   * 解析并校验任意支持的输入文本。
   * @returns {{runs: object[], errors: string[], format: string|null}}
   */
  function parseTraceJson(text) {
    const src = String(text);
    // 1) 尝试整体 JSON；失败则按 JSONL（DSH 日志）处理
    let obj;
    let isJson = true;
    try { obj = JSON.parse(src); } catch { isJson = false; }

    let candidates;
    let format;

    try {
      if (obj && otlp.isOTLP(obj)) {
        format = "OTLP/GenAI";
        candidates = [otlp.parseOTLP(obj)];
      } else if (obj && obj.runs && typeof obj.runs === "object") {
        format = "native-collection";
        candidates = Object.values(obj.runs);
      } else if (obj && Array.isArray(obj.events)) {
        format = "native";
        candidates = [obj];
      } else if (dsh.looksLikeDSH(obj)) {
        format = "DSH-array";
        candidates = [dsh.parseDSH(obj)];
      } else if (!isJson) {
        format = "DSH-jsonl";
        candidates = [dsh.parseDSH(src)];
      } else {
        return { runs: [], errors: ["无法识别的格式：既非原生 Run / OTLP，也非 DSH 事件流"], format: null };
      }
    } catch (err) {
      return { runs: [], errors: [`${format || "输入"} 解析失败：${err.message}`], format };
    }

    const runs = [], errors = [];
    candidates.forEach((c, i) => {
      const { ok, errors: errs } = trace.validateRun(c);
      if (ok) runs.push(c);
      else errors.push(`候选 ${i + 1}（${c.id || "未命名"}）:\n  - ` + errs.join("\n  - "));
    });
    return { runs, errors, format };
  }

  /**
   * 绑定拖拽导入。
   * @param {HTMLElement} zone
   * @param {{onImport:(runs:object[], format:string)=>void, onError:(errs:string[])=>void}} hooks
   */
  function attachDropImport(zone, hooks) {
    let depth = 0;
    zone.addEventListener("dragenter", (e) => { e.preventDefault(); if (++depth === 1) zone.classList.add("drop-active"); });
    zone.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; zone.classList.remove("drop-active"); } });
    zone.addEventListener("dragover", (e) => e.preventDefault());
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      zone.classList.remove("drop-active");
      for (const file of e.dataTransfer.files || []) importFile(file, hooks);
    });
  }

  function importFile(file, hooks) {
    const reader = new FileReader();
    reader.onload = () => {
      const { runs, errors, format } = parseTraceJson(String(reader.result));
      if (runs.length) hooks.onImport(runs, format || "unknown", file.name);
      if (errors.length) hooks.onError(errors, file.name);
    };
    reader.onerror = () => hooks.onError(["文件读取失败"], file.name);
    reader.readAsText(file);
  }

  root.DSTS = root.DSTS || {};
  root.DSTS.io = { parseTraceJson, attachDropImport, importFile };
})(typeof self !== "undefined" ? self : globalThis);
