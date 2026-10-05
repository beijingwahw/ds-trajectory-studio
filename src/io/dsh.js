// @ts-check
/* ============================================================
 * DS Trajectory Studio — io/dsh
 * DeepSeek Harness（DSH）Session 日志适配器 —— 对齐真实契约：
 *
 * 物理格式（@deepseek-ai/dsh-session-persistence-jsonl，format v4）：
 *   第 1 行：session header { type:'session', version:4, id, createdAt,
 *            cwd?, parentSession?, isSeeded, agentPreset?, ... }
 *   后续行：SessionEvent { type, seq, time, data, ignorable? }
 *
 * 事件语义（@deepseek-ai/dsh-session SessionEventMap，57 类）：
 *   step = 一次模型调用 + 其请求的工具执行（step/start ~ step/end）
 *   tool/call.callId 与 tool/result 配对计算工具耗时
 *   assistant/message.usage: TokenUsage { inputTokens, outputTokens,
 *     totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }
 *   assistant/attempt = 未提交表面的失败/重试尝试
 *   llm/retry(-started) / compaction/* / approval/* / user/message …
 *
 * 非 DSH 格式的 JSONL/数组走 legacy 同义归一路径（向后兼容）。
 * ============================================================ */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const api = factory();
  if (isNode) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.dsh = api; }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /* ==================== 通用工具 ==================== */

  function parseJSONL(text) {
    const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const records = [];
    const bad = [];
    lines.forEach((l, i) => {
      try { records.push(JSON.parse(l)); }
      catch { bad.push(i + 1); }
    });
    if (bad.length) throw new Error(`第 ${bad.join(",")} 行不是合法 JSON`);
    return records;
  }

  const pick = (obj, keys, dft) => {
    for (const k of keys) if (obj[k] != null) return obj[k];
    return dft;
  };
  const preview = (v, n = 220) => {
    const s = typeof v === "string" ? v : JSON.stringify(v) || "";
    return s.length > n ? s.slice(0, n) + "…" : s;
  };

  /** 事件是否为 DSH session header 行 */
  const isSessionHeader = (rec) => !!rec && rec.type === "session" && typeof rec.version === "number";

  /* ==================== 官方事件词汇表（dsh-session@0.2.0-rc.2 实测提取） ==================== */
  const KNOWN_SESSION_EVENT_TYPES = new Set([
    "agent-preset/selected", "agent/inbox/spliced", "approval/asked", "approval/decided",
    "approval/policy", "assistant/attempt", "assistant/message", "command/done", "command/run",
    "compaction/end", "compaction/prune", "compaction/start", "compaction/summary",
    "deliverables/presented", "developer/message", "feedback/message-delete", "feedback/message-put",
    "feedback/record", "goal/change", "hook/invoked", "hook/result", "image/offload",
    "llm/retry", "llm/retry-started", "model/selection", "permission/preset", "plan/mode",
    "request/context", "request/header", "sandbox/mode", "schedule/change",
    "session-log-deepseek/delivery-accepted", "session/end-seed", "session/title",
    "session/title-llm-request", "step/end", "step/start", "subagent/catalog",
    "subagent/descriptor", "subagent/model-selection-policy", "system/message", "team/member",
    "team/message/delivered", "team/message/queued", "team/task", "todo/write",
    "tool-workflow/agent-end", "tool-workflow/agent-start", "tool-workflow/run-end",
    "tool-workflow/run-start", "tool/call", "tool/ptc-dispatch", "tool/ptc-dispatch-start",
    "tool/result", "turn/end", "turn/start", "user/message",
    "web/deepseek-search-llm-request", "workspace/changes"
  ]);

  /** 模型可见表面事件（官方 SurfaceEventType） */
  const SURFACE_TYPES = new Set(["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]);

  /**
   * 日志完整性体检（镜像官方 read path 哲学）：
   * - seq 必须连续递增，间隙意味着日志损坏/截断
   * - 未知事件按 ignorable 分类：必需未知事件 = 高版本写入，重建可能不完整
   */
  function analyzeLogHealth(rawEvents) {
    const gaps = [];
    const unknownRequired = new Set();
    let unknownIgnorable = 0;
    for (let i = 0; i < rawEvents.length; i++) {
      const e = rawEvents[i];
      if (i > 0 && typeof e.seq === "number" && typeof rawEvents[i - 1].seq === "number"
          && e.seq !== rawEvents[i - 1].seq + 1) {
        gaps.push([rawEvents[i - 1].seq, e.seq]);
      }
      if (!KNOWN_SESSION_EVENT_TYPES.has(e.type)) {
        if (e.ignorable === true) unknownIgnorable++;
        else unknownRequired.add(e.type);
      }
    }
    return { gaps, unknownRequired: [...unknownRequired], unknownIgnorable };
  }

  /**
   * 模型视角重建（Surface 双视角核心）：
   * 重放全部 surfaceOp —— replace{startSeq,endSeq} 使区间内表面节点被遮蔽
   * （数据仍在日志中，但模型此后不可见），sourceEventSeqs 同样被遮蔽。
   * @returns {{shadowedSeqs: number[], replacements: any[], finalSurfaceSize: number}}
   */
  function reconstructSurface(rawEvents) {
    const shadowed = new Set();
    const replacements = [];
    let appends = 0;
    for (const e of rawEvents) {
      if (!SURFACE_TYPES.has(e.type)) continue;
      const op = e.surfaceOp;
      if (op && typeof op === "object" && op.op === "replace") {
        for (let s = op.startSeq; s <= op.endSeq; s++) shadowed.add(s);
        for (const s of e.sourceEventSeqs || []) shadowed.add(s);
        replacements.push({ seq: e.seq, startSeq: op.startSeq, endSeq: op.endSeq, time: e.time });
      } else {
        appends++;
      }
    }
    return { shadowedSeqs: [...shadowed], replacements, finalSurfaceSize: appends };
  }

  /** 继承切点：最后一个 tagged session/end-seed 标记的 seq（此前为 fork 继承前缀） */
  function findInheritedCut(rawEvents) {
    let cut = -1;
    for (const e of rawEvents) {
      if (e.type === "session/end-seed" && e.data && e.data.inherited === true && typeof e.seq === "number") {
        cut = Math.max(cut, e.seq);
      }
    }
    return cut;
  }

  /* ==================== 真实 DSH Session v4 解析 ==================== */

  /** TokenUsage（dsh-llm 真实定义）→ 内部 tokens */
  function mapUsage(usage) {
    if (!usage) return { in: 0, out: 0, cacheIn: 0 };
    return {
      in: Number(usage.inputTokens || 0),
      out: Number(usage.outputTokens || 0),
      cacheIn: Number(usage.cacheReadTokens || 0)
    };
  }

  /**
   * 解析 DSH Session JSONL（header + SessionEvent 序列）→ 内部 Run。
   * 重建步骤：
   *  1. step/start ~ step/end 配对为 step 容器（thought）
   *  2. step 内的 assistant/tool/retry 事件挂到所属 step
   *  3. tool/call 与 tool/result 按 callId 配对计算耗时
   *  4. 纯日志类事件（request/*、session/* 等）跳过但计数
   */
  function parseDSHSession(records) {
    const header = records[0];
    const rawEvents = records.slice(1).filter((r) => r && typeof r.type === "string" && typeof r.time === "number");
    if (!rawEvents.length) throw new Error("DSH session 中无有效事件");
    const t0 = rawEvents[0].time;

    // 预扫描：step 区间与 tool 结果配对
    const stepOpen = new Map();
    const stepSpan = new Map();
    const toolResults = new Map();
    for (const e of rawEvents) {
      const d = e.data || {};
      if (e.type === "step/start") stepOpen.set(`${d.turn}.${d.step}`, e);
      if (e.type === "step/end") {
        const key = `${d.turn}.${d.step}`;
        const open = stepOpen.get(key);
        if (open) stepSpan.set(key, { t: open.time - t0, dur: Math.max(0, e.time - open.time) });
      }
      if (e.type === "tool/result") {
        const callId = d.callId != null ? d.callId : (d.message && d.message.toolCallId);
        if (callId != null) toolResults.set(String(callId), e);
      }
    }

    const events = [];
    let skipped = 0;
    let lastEmitted = null;
    const stepEventId = new Map();
    const curStepOf = (d) => (d && d.turn != null && d.step != null) ? `${d.turn}.${d.step}` : null;

    // ---- v3 升维：体检 / 表面重建 / 谱系 ----
    const health = analyzeLogHealth(rawEvents);
    const surface = reconstructSurface(rawEvents);
    const inheritedCut = findInheritedCut(rawEvents);
    const replaceBySeq = new Map(surface.replacements.map((r) => [r.seq, r]));

    const emit = (e) => { events.push(e); lastEmitted = e.id; return e; };
    const parentForStep = (key) => (key && stepEventId.has(key)) ? [stepEventId.get(key)] : (lastEmitted ? [lastEmitted] : []);
    const inherited = (seq) => inheritedCut >= 0 && typeof seq === "number" && seq <= inheritedCut;

    for (const e of rawEvents) {
      const d = e.data || {};
      const t = Math.max(0, Math.round(e.time - t0));
      const inh = inherited(e.seq);
      switch (e.type) {
        case "step/start": {
          const key = `${d.turn}.${d.step}`;
          const span = stepSpan.get(key);
          const id = `step-${key}`;
          stepEventId.set(key, id);
          emit({
            id, t, dur: span ? span.dur : 0, type: "thought", seq: e.seq, inherited: inh,
            name: `Step ${d.turn}.${d.step}（一次模型调用 + 工具执行）`,
            parents: lastEmitted ? [lastEmitted] : [],
            tokens: { in: 0, out: 0 }, status: "ok", detail: ""
          });
          break;
        }
        case "assistant/message": {
          const usage = mapUsage(d.usage);
          const reasoning = d.usage && d.usage.reasoningTokens ? ` · reasoning ${d.usage.reasoningTokens}` : "";
          const span = stepSpan.get(curStepOf(d));
          // 语义：模型调用从 step 起点开始、到消息提交时间结束
          const start = span ? span.t : t;
          const dur = span ? Math.min(Math.max(0, t - start), span.dur) : 0;
          // TTFT：stream 首条记录的到达时间 − step 起点（流式记录存在时）
          let ttftText = "";
          if (Array.isArray(d.stream) && d.stream.length && typeof d.stream[0].time === "number" && span) {
            ttftText = ` · TTFT ${Math.max(0, d.stream[0].time - t0 - span.t)}ms`;
          }
          // 该消息若为 compaction 的 replace 事件 → 附遮蔽信息
          const rep = replaceBySeq.get(e.seq);
          const repText = rep ? `\n[surface] 本消息替换表面节点 seq ${rep.startSeq}..${rep.endSeq}（原数据仍在日志，模型此后不可见）` : "";
          emit({
            id: `asst-${e.seq}`, t: start, dur, type: "llm", seq: e.seq, inherited: inh,
            name: `assistant/message（模型响应）${d.interrupted ? " · 中断" : ""}${rep ? " · surface 替换" : ""}`,
            parents: parentForStep(curStepOf(d)),
            tokens: usage, status: d.interrupted ? "warn" : "ok",
            detail: preview(d.message && (d.message.content != null ? d.message.content : d.message)) + reasoning + ttftText + repText
          });
          break;
        }
        case "assistant/attempt":
          emit({
            id: `attempt-${e.seq}`, t, dur: 0, type: "llm", seq: e.seq, inherited: inh,
            name: "LLM 尝试未提交（失败/重试/取消）",
            parents: parentForStep(curStepOf(d)),
            tokens: { in: 0, out: 0 }, status: "error",
            detail: preview(d.stream)
          });
          break;
        case "tool/call": {
          const res = toolResults.get(String(d.callId));
          const resErr = res && res.data && res.data.error;
          emit({
            id: `tool-${e.seq}`, t,
            dur: res ? Math.max(0, res.time - e.time) : 0, type: "tool", seq: e.seq, inherited: inh,
            name: `tool/${d.name || "unknown"}`,
            parents: parentForStep(curStepOf(d)),
            tokens: { in: 0, out: 0 },
            status: resErr ? "error" : "ok",
            // 保留原始参数（复现包提取真实命令用）
            args: typeof d.arguments === "string" ? d.arguments : JSON.stringify(d.arguments || {}),
            errorInfo: resErr ? { name: resErr.name, code: resErr.code, reason: resErr.reason || "" } : null,
            detail: `参数: ${preview(d.arguments, 300)}` + (resErr ? `\n错误 ${resErr.name}/${resErr.code}: ${resErr.reason || ""}` : "")
          });
          break;
        }
        case "llm/retry":
        case "llm/retry-started":
          emit({
            id: `retry-${e.seq}`, t, dur: 0, type: "error", seq: e.seq, inherited: inh,
            name: e.type === "llm/retry-started" ? "LLM 重试开始" : "LLM 重试",
            parents: parentForStep(curStepOf(d)),
            tokens: { in: 0, out: 0 }, status: "error", detail: preview(d)
          });
          break;
        case "user/message":
          emit({
            id: `user-${e.seq}`, t, dur: 0, type: "thought", seq: e.seq, inherited: inh,
            name: `用户/注入消息${d.source ? `（${d.source}）` : ""}`,
            parents: lastEmitted ? [lastEmitted] : [],
            tokens: { in: 0, out: 0 }, status: "ok", detail: preview(d.content != null ? d.content : d)
          });
          break;
        case "compaction/start":
        case "compaction/end":
        case "compaction/prune":
        case "compaction/summary": {
          const shadowNote = surface.shadowedSeqs.length && e.type === "compaction/end"
            ? ` · 已遮蔽 ${surface.shadowedSeqs.length} 个历史表面节点` : "";
          emit({
            id: `compact-${e.seq}`, t, dur: 0, type: "thought", seq: e.seq, inherited: inh,
            name: `上下文压缩（${e.type.split("/")[1]}）`,
            parents: lastEmitted ? [lastEmitted] : [],
            tokens: { in: 0, out: 0 }, status: "ok", detail: preview(d) + shadowNote
          });
          break;
        }
        case "approval/asked":
        case "approval/decided":
          emit({
            id: `approval-${e.seq}`, t, dur: 0, type: "observation", seq: e.seq, inherited: inh,
            name: e.type === "approval/asked" ? "审批请求" : "审批决定",
            parents: lastEmitted ? [lastEmitted] : [],
            tokens: { in: 0, out: 0 }, status: "ok", detail: preview(d)
          });
          break;
        case "todo/write":
        case "goal/change":
        case "model/selection":
        case "deliverables/presented":
          emit({
            id: `misc-${e.seq}`, t, dur: 0, type: "thought", seq: e.seq, inherited: inh,
            name: e.type, parents: lastEmitted ? [lastEmitted] : [],
            tokens: { in: 0, out: 0 }, status: "ok", detail: preview(d)
          });
          break;
        case "tool/result":
        case "step/end":
        case "turn/start":
        case "turn/end":
          skipped++; // 已用于配对/区间，不单独成事件
          break;
        default:
          skipped++; // 纯日志类（request/*、session/*、hook/* 等）
      }
    }

    if (!events.length) throw new Error("DSH session 解析后无可视化事件");
    const sid = String(header.id || "unknown").replace(/[^a-zA-Z0-9_-]/g, "-");
    return {
      id: `dsh-${sid}`,
      label: `DSH 会话 ${String(header.id || "").slice(0, 18)} · ${events.length} 事件` + (skipped ? `（跳过 ${skipped} 条纯日志）` : ""),
      strategy: header.agentPreset ? `preset: ${header.agentPreset}` : "deepseek-harness session v4",
      result: events.some((e) => e.status === "error") ? "error" : "success",
      branch: header.cwd || "",
      events,
      // ---- v3 升维元数据 ----
      surface,           // 模型视角：shadowedSeqs / replacements / finalSurfaceSize
      health,            // 完整性体检：seq 间隙 / 未知必需事件 / 未知可忽略事件
      lineage: {         // fork 谱系
        parent: header.parentSession || null,
        isSeeded: !!header.isSeeded,
        depth: header.delegationDepth || 0,
        inheritedCut
      }
    };
  }

  /* ==================== Legacy 同义归一（非 DSH 格式向后兼容） ==================== */

  function inferType(raw) {
    const k = String(raw || "").toLowerCase();
    if (/error|retry|exception|timeout/.test(k)) return "error";
    if (/tool|exec|command|edit|read_file|write|bash/.test(k)) return "tool";
    if (/llm|model|chat|completion|reason/.test(k)) return "llm";
    if (/observ|result|output|feedback/.test(k)) return "observation";
    return "thought";
  }

  function normalizeLegacy(raw, idx, t0, prevId) {
    const kind = pick(raw, ["type", "event", "kind", "op"], "thought");
    const ts = Number(pick(raw, ["ts", "time", "timestamp", "at"], t0 + idx * 1000));
    const dur = Number(pick(raw, ["duration", "dur", "elapsed_ms", "elapsedMs", "ms"], 0));
    const tokens = raw.tokens || raw.usage || {};
    const statusRaw = String(pick(raw, ["status", "result"], "ok")).toLowerCase();
    return {
      id: String(pick(raw, ["id", "event_id", "eventId", "span_id"], `e${idx + 1}`)),
      t: Math.max(0, Math.round(ts - t0)),
      dur: Math.max(0, Math.round(dur)),
      type: inferType(kind),
      name: String(pick(raw, ["name", "title", "summary"], kind)).slice(0, 80),
      parents: raw.parents ? raw.parents.map(String)
        : raw.parent || raw.parent_id || raw.parentId ? [String(raw.parent || raw.parent_id || raw.parentId)]
        : prevId ? [prevId] : [],
      tokens: {
        in: Number(pick(tokens, ["in", "input", "input_tokens", "inputTokens", "prompt_tokens"], 0)),
        out: Number(pick(tokens, ["out", "output", "output_tokens", "outputTokens", "completion_tokens"], 0)),
        cacheIn: Number(pick(tokens, ["cacheIn", "cache_read", "cache_hit", "cacheReadTokens", "cache_read_input_tokens"], 0))
      },
      status: /error|fail|timeout/.test(statusRaw) ? "error" : statusRaw === "warn" ? "warn" : "ok",
      detail: String(pick(raw, ["detail", "content", "message", "payload"], "")).slice(0, 500)
    };
  }

  /**
   * 统一入口：JSONL 文本或事件数组 → 内部 Run。
   * 首条记录为 session header → 真实 DSH v4 路径；否则 legacy 归一。
   */
  function parseDSH(input, fallbackId = "run-dsh") {
    const records = Array.isArray(input) ? input : parseJSONL(input);
    if (!records.length) throw new Error("日志为空");
    if (isSessionHeader(records[0])) return parseDSHSession(records);

    const t0 = Number(pick(records[0], ["ts", "time", "timestamp", "at"], 0));
    let prevId = null;
    const events = records.map((raw, i) => {
      const e = normalizeLegacy(raw, i, t0, prevId);
      prevId = e.id;
      return e;
    });
    return {
      id: fallbackId,
      label: `DSH 轨迹导入 · ${events.length} 事件`,
      strategy: "append-only log (legacy synonym mapping)",
      result: events.some((e) => e.status === "error") ? "error" : "success",
      events
    };
  }

  const looksLikeDSH = (obj) =>
    Array.isArray(obj) && obj.length > 0 && obj.every((x) => x && typeof x === "object" && !Array.isArray(x));

  return {
    parseDSH, parseDSHSession, parseJSONL, looksLikeDSH, inferType, isSessionHeader, mapUsage,
    analyzeLogHealth, reconstructSurface, findInheritedCut, KNOWN_SESSION_EVENT_TYPES
  };
});
