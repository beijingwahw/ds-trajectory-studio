// @ts-check
/* ============================================================
 * DS Trajectory Studio — io/otlp
 * OpenTelemetry GenAI 语义约定适配器（真实行业标准）。
 *
 * 输入：标准 OTLP/JSON trace 导出（OTel Collector / Jaeger /
 *       Vercel AI SDK / AG2 / Honeycomb 等均产出此格式）
 *   { resourceSpans: [{ scopeSpans: [{ spans: [...] }] }] }
 *
 * 映射规则（gen_ai.* 语义约定）：
 *   operation.name = chat/generate_content/text_completion → llm
 *   operation.name = execute_tool                        → tool
 *   operation.name = invoke_agent/create_agent           → thought
 *   status.code = ERROR 或 error.type 存在               → error
 *   gen_ai.usage.input_tokens / output_tokens            → tokens
 *   parentSpanId（包含关系）                              → 因果父节点
 *
 * 容器 span 处理：拥有子节点的 invoke_agent 根 span 会被折叠
 * （其子节点重挂到其父），避免全景大条掩盖步骤级结构。
 * ============================================================ */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const api = factory();
  if (isNode) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.otlp = api; }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const isOTLP = (obj) => !!obj && Array.isArray(obj.resourceSpans);

  /** OTLP attributeValue → JS 值 */
  function attrVal(v) {
    if (v == null || typeof v !== "object") return v;
    if ("stringValue" in v) return v.stringValue;
    if ("intValue" in v) return Number(v.intValue);
    if ("doubleValue" in v) return v.doubleValue;
    if ("boolValue" in v) return v.boolValue;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(attrVal);
    return undefined;
  }

  const attrsToMap = (span) => {
    const m = {};
    for (const a of span.attributes || []) m[a.key] = attrVal(a.value);
    return m;
  };

  const isErrorStatus = (span) => {
    const c = span.status && span.status.code;
    return c === 2 || c === "STATUS_CODE_ERROR";
  };

  function opToType(op, span, a) {
    if (isErrorStatus(span) && !op) return "error";
    switch (op) {
      case "chat":
      case "generate_content":
      case "text_completion":
      case "embeddings":
        return "llm";
      case "execute_tool":
      case "retrieval":
        return "tool";
      case "invoke_agent":
      case "create_agent":
      case "invoke_workflow":
        return "thought";
      default:
        return isErrorStatus(span) || a["error.type"] ? "error" : "tool";
    }
  }

  /**
   * 解析 OTLP/JSON → 内部 Run 模型。
   * @param {any} obj
   * @param {string} [fallbackId]
   * @returns {object} Run（未校验，交由 trace.validateRun 把关）
   */
  function parseOTLP(obj, fallbackId = "run-otlp") {
    const spans = [];
    for (const rs of obj.resourceSpans || []) {
      for (const ss of rs.scopeSpans || []) {
        for (const sp of ss.spans || []) spans.push(sp);
      }
    }
    if (!spans.length) throw new Error("OTLP 中未找到任何 span");

    const minStart = Math.min(...spans.map((s) => Number(s.startTimeUnixNano || 0)));
    const childrenCount = new Map();
    spans.forEach((s) => {
      if (s.parentSpanId) childrenCount.set(s.parentSpanId, (childrenCount.get(s.parentSpanId) || 0) + 1);
    });

    // 折叠容器 span：有子节点 + agent 类 operation + 时长覆盖 ≥90% 全轨迹。
    // 「覆盖全轨迹」是容器 span 的本质特征——避免误折叠有子节点的普通步骤。
    const spanDur = (s) => Number(s.endTimeUnixNano || 0) - Number(s.startTimeUnixNano || 0);
    const traceSpan = Math.max(...spans.map((s) => Number(s.endTimeUnixNano || 0))) - minStart;
    const collapsed = new Set(
      spans.filter((s) => {
        const a = attrsToMap(s);
        const op = a["gen_ai.operation.name"];
        return childrenCount.has(s.spanId)
          && (op === "invoke_agent" || op === "create_agent")
          && spanDur(s) >= 0.9 * traceSpan;
      }).map((s) => s.spanId)
    );
    const remapParent = (pid) => {
      let cur = pid;
      const guard = 64;
      for (let i = 0; i < guard && collapsed.has(cur); i++) {
        cur = (spans.find((s) => s.spanId === cur) || {}).parentSpanId;
      }
      return cur;
    };

    const kept = spans.filter((s) => !collapsed.has(s.spanId));
    const keptIds = new Set(kept.map((s) => s.spanId));
    let model = "";
    const events = kept.map((s) => {
      const a = attrsToMap(s);
      const op = a["gen_ai.operation.name"] || "";
      model = model || a["gen_ai.request.model"] || "";
      const parent = s.parentSpanId ? remapParent(s.parentSpanId) : undefined;
      return {
        id: String(s.spanId),
        t: Math.round((Number(s.startTimeUnixNano || 0) - minStart) / 1e6),
        dur: Math.round((Number(s.endTimeUnixNano || 0) - Number(s.startTimeUnixNano || 0)) / 1e6),
        type: opToType(op, s, a),
        name: String(s.name || a["gen_ai.tool.name"] || op || "span"),
        args: a["gen_ai.tool.call.arguments"] ? String(a["gen_ai.tool.call.arguments"]) : undefined,
        parents: parent && keptIds.has(parent) ? [String(parent)] : [],
        tokens: {
          in: Number(a["gen_ai.usage.input_tokens"] || 0),
          out: Number(a["gen_ai.usage.output_tokens"] || 0),
          // KV 缓存命中（OTel GenAI 缓存扩展字段，兼容两种命名）
          cacheIn: Number(a["gen_ai.usage.cache_read.input_tokens"] || a["gen_ai.usage.cache_read_input_tokens"] || 0)
        },
        status: isErrorStatus(s) ? "error" : "ok",
        detail: String(
          a["gen_ai.tool.call.result"] || a["error.type"] ||
          (s.status && s.status.message) || op || ""
        ).slice(0, 500)
      };
    });

    return {
      id: fallbackId,
      label: `OTLP 导入 · ${model || "unknown model"}`,
      strategy: "otel.genai",
      result: events.some((e) => e.status === "error") ? "error" : "success",
      events
    };
  }

  /* ---------- 编码（内部 Run → OTLP/JSON）：生成真实格式样例 & 往返测试 ---------- */

  const toAttr = (key, value) => ({
    key,
    value: typeof value === "number"
      ? (Number.isInteger(value) ? { intValue: value } : { doubleValue: value })
      : { stringValue: String(value) }
  });

  const OP_BY_TYPE = { llm: "chat", tool: "execute_tool", thought: "invoke_agent", observation: "execute_tool", error: "execute_tool" };

  function toOTLP(run, model = "deepseek-reasoner") {
    const minT = Math.min(...run.events.map((e) => e.t));
    const epochNano = (ms) => String(1_700_000_000_000_000_000n + BigInt(Math.round(ms)) * 1_000_000n);
    const spans = run.events.map((e) => {
      const attributes = [
        toAttr("gen_ai.operation.name", OP_BY_TYPE[e.type] || "execute_tool"),
        toAttr("gen_ai.request.model", model)
      ];
      if (e.tokens.in) attributes.push(toAttr("gen_ai.usage.input_tokens", e.tokens.in));
      if (e.tokens.out) attributes.push(toAttr("gen_ai.usage.output_tokens", e.tokens.out));
      if (e.tokens.cacheIn) attributes.push(toAttr("gen_ai.usage.cache_read.input_tokens", e.tokens.cacheIn));
      return {
        traceId: "dsts-" + run.id,
        spanId: e.id,
        parentSpanId: e.parents[0] || "",
        name: e.name,
        kind: e.type === "llm" ? 3 : 1,
        startTimeUnixNano: epochNano(e.t - minT),
        endTimeUnixNano: epochNano(e.t - minT + e.dur),
        attributes,
        status: { code: e.status === "error" ? 2 : 1, message: e.status === "error" ? e.detail : "" }
      };
    });
    return {
      resourceSpans: [{
        resource: { attributes: [toAttr("service.name", "ds-trajectory-studio")] },
        scopeSpans: [{ scope: { name: "otel.genai" }, spans }]
      }]
    };
  }

  return { isOTLP, parseOTLP, toOTLP, attrsToMap, attrVal };
});
