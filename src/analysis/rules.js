// @ts-check
/* ============================================================
 * DS Trajectory Studio — analysis/rules
 * 瓶颈诊断规则注册表。每条规则为纯函数：
 *   (ctx) => Finding | Finding[] | null
 * ctx = { run, events, stats:{mean,std}, runEnd, gaps }
 * Finding = { ruleId, sev, ev, title, desc, fix, category }
 * 新增规则只需向 RULES 数组追加一项，引擎自动拾取。
 * ============================================================ */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const util = isNode ? require("../core/util.js") : /** @type {any} */ (root).DSTS.util;
  const trace = isNode ? require("../model/trace.js") : /** @type {any} */ (root).DSTS.trace;
  const api = factory(util, trace);
  if (isNode) module.exports = api;
  else { const r = /** @type {any} */ (root); r.DSTS = r.DSTS || {}; r.DSTS.rules = api; }
})(typeof self !== "undefined" ? self : globalThis, function (util, trace) {
  "use strict";

  const SEV = { HIGH: "high", MID: "mid", LOW: "low" };

  const RULES = [
    {
      id: "slow-step",
      category: "latency",
      describe: "修正 Z 分数 > 3.5（MAD 稳健检测）且 > 8s 的单步骤",
      check(ctx) {
        const { median, modifiedZ } = ctx.stats.robust;
        return ctx.events
          .filter((e) => modifiedZ(e.dur) > 3.5 && e.dur > 8000)
          .map((e) => ({
            ruleId: this.id, sev: SEV.HIGH, ev: e.id, category: this.category,
            title: `慢步骤：${e.name}`,
            desc: `耗时 ${util.fmtMs(e.dur)}，修正 Z 分数 ${modifiedZ(e.dur).toFixed(1)}（中位数 ${util.fmtMs(median)}，MAD 稳健检测）。`,
            fix: e.type === "tool"
              ? "缩小作用范围（如定向测试 -k 过滤）或异步化。"
              : "裁剪上下文 / 启用流式输出降低 TTFT 感知延迟。"
          }));
      }
    },
    {
      id: "repeated-full-regression",
      category: "loop",
      describe: "反馈环内重复执行全量测试",
      check(ctx) {
        const full = ctx.events.filter((e) => e.type === "tool" && /全量/.test(e.name));
        if (full.length < 2) return null;
        const total = util.sum(full, (e) => e.dur);
        return {
          ruleId: this.id, sev: SEV.HIGH, ev: full.map((e) => e.id).join(","), category: this.category,
          title: `重复全量回归 ×${full.length}`,
          desc: `全量测试累计 ${util.fmtMs(total)}，占 Run 总时长 ${util.fmtPct(total / ctx.runEnd)}。`,
          fix: "反馈环内使用定向测试，全量回归仅在最终验证执行一次。"
        };
      }
    },
    {
      id: "context-bloat",
      category: "cost",
      describe: "单次 LLM 输入超过 10k tokens",
      check(ctx) {
        return ctx.events
          .filter((e) => e.tokens.in >= 10000)
          .map((e) => ({
            ruleId: this.id, sev: SEV.MID, ev: e.id, category: this.category,
            title: `上下文膨胀：${e.name}`,
            desc: `输入 ${util.fmtTok(e.tokens.in)} tokens，推理成本与延迟随上下文近似线性增长。`,
            fix: "启用 Harness 上下文裁剪（observation masking）或滑动窗口摘要。"
          }));
      }
    },
    {
      id: "unstable-call",
      category: "reliability",
      describe: "API 超时 / 重试 / 错误事件",
      check(ctx) {
        return ctx.events
          .filter((e) => e.type === "error" || e.status === "error")
          .map((e) => ({
            ruleId: this.id, sev: SEV.MID, ev: e.id, category: this.category,
            title: `不稳定调用：${e.name}`,
            desc: e.detail || "调用失败并触发重试。",
            fix: "配置指数退避 + 长超时档位；重试期间复用已缓存的 prompt 前缀。"
          }));
      }
    },
    {
      id: "serial-llm-chain",
      category: "structure",
      describe: "LLM 串行轮次过多，存在可合并推理",
      check(ctx) {
        const llms = ctx.events.filter((e) => e.type === "llm");
        if (llms.length < 4) return null;
        return {
          ruleId: this.id, sev: SEV.LOW, ev: llms[0].id, category: this.category,
          title: `LLM 串行链较长（${llms.length} 次）`,
          desc: "多次 LLM 调用存在可合并的推理轮次，每多一轮都伴随一次全量上下文重传。",
          fix: "将「定位根因」与「方案设计」合并为单次推理，减少上下文重传。"
        };
      }
    },
    {
      id: "idle-gap",
      category: "latency",
      describe: "事件间墙钟空转超过 3s（调度/IO 等待）",
      check(ctx) {
        return ctx.gaps.map((g) => ({
          ruleId: this.id, sev: SEV.LOW, ev: g.after, category: this.category,
          title: `调度空转：${g.after} → ${g.before}`,
          desc: `两个事件之间存在 ${util.fmtMs(g.gap)} 墙钟空隙，疑似 Harness 调度或 IO 等待。`,
          fix: "检查事件循环的 await 链与工具队列；必要时开启流水线化调度。"
        }));
      }
    },
    {
      id: "error-amplification",
      category: "reliability",
      describe: "错误事件之后紧跟高上下文 LLM 调用（错误放大）",
      check(ctx) {
        const out = [];
        ctx.events.forEach((e) => {
          if (e.type !== "error") return;
          const depth = trace.topoDepth(ctx.events);
          const dErr = depth.get(e.id);
          ctx.events.forEach((x) => {
            if (x.type === "llm" && x.tokens.in >= 8000 && x.parents.includes(e.id) && depth.get(x.id) === dErr + 1) {
              out.push({
                ruleId: this.id, sev: SEV.MID, ev: x.id, category: this.category,
                title: `错误放大：${x.name}`,
                desc: `在错误事件 ${e.id} 之后立即以 ${util.fmtTok(x.tokens.in)} tokens 的大上下文重试推理，重试成本被放大。`,
                fix: "重试前先做上下文压缩或降级到更小模型验证思路。"
              });
            }
          });
        });
        return out.length ? out : null;
      }
    }
  ];

  return { RULES, SEV };
});
