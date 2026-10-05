/* ============================================================
 * DS Trajectory Studio — data/sample
 * 内置演示轨迹（对齐 OpenTelemetry GenAI 语义约定）。
 * UMD：浏览器挂 DSTS_DATA，Node 可 require 供测试使用。
 * ============================================================ */
(function (root, factory) {
  const data = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  else root.DSTS_DATA = data;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";
  /* 确定性伪随机（LCG，seed 固定 → 压测数据可复现） */
  function lcg(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
  }

  /**
   * 压测/演示数据生成器：合成一条 n 事件的 Agent 轨迹。
   * 相位循环：thought → llm → tool(read) → tool(test) → observation，
   * 每 37 个事件注入一次 error，token 随轮次增长（模拟上下文膨胀）。
   */
  function generateStressRun(n = 2000, id = "run-stress", seed = 42) {
    const rnd = lcg(seed);
    const phases = [
      { type: "thought", name: "阶段规划", dur: () => 300 + rnd() * 900 },
      { type: "llm", name: "推理回合", dur: () => 3000 + rnd() * 9000 },
      { type: "tool", name: "read_file 源码", dur: () => 150 + rnd() * 600 },
      { type: "tool", name: "run_test 验证", dur: () => 1500 + rnd() * 16000 },
      { type: "observation", name: "结果观察", dur: () => 60 + rnd() * 140 }
    ];
    const events = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      const isErr = i > 0 && i % 37 === 0;
      const ph = phases[i % phases.length];
      const dur = Math.round(isErr ? 800 + rnd() * 2500 : ph.dur());
      const round = Math.floor(i / phases.length);
      events.push({
        id: `s${String(i + 1).padStart(4, "0")}`,
        t, dur,
        type: isErr ? "error" : ph.type,
        name: isErr ? "LLM API 超时重试" : `${ph.name} #${round + 1}`,
        parents: i === 0 ? [] : [events[i - 1].id],
        tokens: ph.type === "llm" && !isErr
          ? { in: Math.round(2000 + round * 320 + rnd() * 800), out: Math.round(600 + rnd() * 2400) }
          : { in: 0, out: 0 },
        status: isErr ? "error" : "ok",
        detail: `合成压测事件 ${i + 1}/${n}`
      });
      t += dur + Math.round(rnd() * 400);
    }
    return { id, label: `压测 Run · ${n} 事件`, strategy: "synthetic-stress", result: "success", events };
  }

  return {
    schemaVersion: "otel.genai.v1",
    pluginVersion: "0.6.0",
    generateStressRun,
    task: {
      id: "task-1287",
      title: "修复 issue #1287：分页查询在高并发下返回重复数据",
      repo: "deepseek-harness/demo-commerce",
      model: "deepseek-reasoner",
      harnessVersion: "0.9.4",
      pricePerMToken: { in: 2, out: 8, cacheIn: 0.5 }
    },

    runs: {
      "run-a": {
        id: "run-a", label: "Run A · 基线策略", strategy: "全量测试反馈循环",
        result: "success", branch: "fix/1287-baseline",
        events: [
          { id: "a01", t: 0,      dur: 1200,  type: "thought",     name: "任务规划",              parents: [],              tokens: { in: 0, out: 0 },         status: "ok",    detail: "拆解任务：复现 → 定位 → 修复 → 验证。计划先跑现有测试套件建立基线。" },
          { id: "a02", t: 1200,   dur: 8400,  type: "llm",         name: "分析问题 (reasoner)",   parents: ["a01"],         tokens: { in: 3200, out: 1500 },   status: "ok",    detail: "阅读 issue 描述：并发下 OFFSET 分页返回重复行。初步怀疑排序不稳定。" },
          { id: "a03", t: 9600,   dur: 320,   type: "tool",        name: "read_file paginate.py", parents: ["a02"],         tokens: { in: 0, out: 0 },         status: "ok",    detail: "读取 repo/db/paginate.py（214 行）。发现 build_page_query() 使用 OFFSET/LIMIT。" },
          { id: "a04", t: 10000,  dur: 12000, type: "llm",         name: "定位根因",              parents: ["a03"],         tokens: { in: 5800, out: 2400 },   status: "ok",    detail: "根因假设：ORDER BY created_at 非唯一索引，并发写入时页边界漂移。需要确定性排序键。" },
          { id: "a05", t: 22000,  dur: 450,   type: "tool",        name: "grep OFFSET 用法",      parents: ["a04"],         tokens: { in: 0, out: 0 },         status: "ok",    detail: "全仓搜索 OFFSET：共 7 处调用点，3 处缺少 tiebreaker。" },
          { id: "a06", t: 22500,  dur: 800,   type: "thought",     name: "假设确认",              parents: ["a05"],         tokens: { in: 0, out: 0 },         status: "ok",    detail: "确认非确定性排序是主因。决定先写并发复现测试再修。" },
          { id: "a07", t: 23300,  dur: 18000, type: "tool",        name: "run_test 全量套件",     parents: ["a06"],         tokens: { in: 0, out: 0 },         status: "ok",    detail: "pytest 全量 412 个用例。⚠ 未使用 -k 过滤，耗时 18s。" },
          { id: "a08", t: 41300,  dur: 100,   type: "observation", name: "测试结果: 3 failed",    parents: ["a07"],         tokens: { in: 0, out: 0 },         status: "warn",  detail: "3 个并发分页用例失败，与 issue 吻合。基线建立。" },
          { id: "a09", t: 41400,  dur: 9000,  type: "llm",         name: "生成修复方案 v1",       parents: ["a08"],         tokens: { in: 9200, out: 3100 },   status: "ok",    detail: "方案 v1：ORDER BY created_at, id。仅改 build_page_query()。" },
          { id: "a10", t: 50400,  dur: 600,   type: "tool",        name: "edit_file paginate.py", parents: ["a09"],         tokens: { in: 0, out: 0 },         status: "ok",    detail: "应用 diff：+ORDER BY created_at, id。" },
          { id: "a11", t: 51000,  dur: 17500, type: "tool",        name: "run_test 全量套件 #2",  parents: ["a10"],         tokens: { in: 0, out: 0 },         status: "ok",    detail: "再次全量回归，17.5s。⚠ 重复全量测试。" },
          { id: "a12", t: 68500,  dur: 100,   type: "observation", name: "测试结果: 1 failed",    parents: ["a11"],         tokens: { in: 0, out: 0 },         status: "warn",  detail: "cursor 分页用例失败：v1 未覆盖 keyset 分支。" },
          { id: "a13", t: 68600,  dur: 2200,  type: "error",       name: "LLM API 超时重试 ×2",   parents: ["a12"],         tokens: { in: 0, out: 0 },         status: "error", detail: "deepseek-reasoner 请求超时（30s），Harness 自动重试 2 次，损失 ~4s 墙钟时间。" },
          { id: "a14", t: 70800,  dur: 11500, type: "llm",         name: "生成修复方案 v2",       parents: ["a12", "a13"],  tokens: { in: 12400, out: 3800, cacheIn: 8000 },  status: "ok",    detail: "方案 v2：keyset 分支同样补 tiebreaker + 新增并发复现测试。⚠ 上下文已膨胀至 12.4k tokens（其中 8k 命中 KV 缓存）。" },
          { id: "a15", t: 82300,  dur: 700,   type: "tool",        name: "edit_file + 新增测试",  parents: ["a14"],         tokens: { in: 0, out: 0 },         status: "ok",    detail: "修改 paginate.py 两处 + 新增 tests/test_pagination_concurrent.py。" },
          { id: "a16", t: 83000,  dur: 17900, type: "tool",        name: "run_test 全量套件 #3",  parents: ["a15"],         tokens: { in: 0, out: 0 },         status: "ok",    detail: "第三次全量回归，17.9s。⚠ 三轮全量测试累计 53.4s，占总时长 47%。" },
          { id: "a17", t: 100900, dur: 100,   type: "observation", name: "测试结果: all pass",    parents: ["a16"],         tokens: { in: 0, out: 0 },         status: "ok",    detail: "412/412 通过。" },
          { id: "a18", t: 101000, dur: 6000,  type: "llm",         name: "总结 & 提交说明",       parents: ["a17"],         tokens: { in: 15600, out: 900, cacheIn: 12000 },   status: "ok",    detail: "生成 commit message 与 PR 描述。上下文 15.6k，其中 12k 命中 KV 缓存（DSH 前缀对齐）。" }
        ]
      },

      "run-b": {
        id: "run-b", label: "Run B · 优化策略", strategy: "定向测试 + 上下文裁剪",
        result: "success", branch: "fix/1287-targeted",
        events: [
          { id: "b01", t: 0,     dur: 1100,  type: "thought",     name: "任务规划",                parents: [],       tokens: { in: 0, out: 0 },        status: "ok", detail: "拆解任务，计划使用定向测试（-k pagination）缩短反馈环。" },
          { id: "b02", t: 1100,  dur: 7800,  type: "llm",         name: "分析问题 (reasoner)",     parents: ["b01"],  tokens: { in: 3100, out: 1400 },  status: "ok", detail: "与 Run A 相同的初步判断：排序键非唯一。" },
          { id: "b03", t: 8900,  dur: 300,   type: "tool",        name: "read_file paginate.py",   parents: ["b02"],  tokens: { in: 0, out: 0 },        status: "ok", detail: "读取 paginate.py。" },
          { id: "b04", t: 9200,  dur: 9800,  type: "llm",         name: "定位根因 + 方案设计",     parents: ["b03"],  tokens: { in: 5600, out: 2900, cacheIn: 4500 },  status: "ok", detail: "一次性给出完整方案：两个分支都加 tiebreaker + keyset 迁移建议 + 复合索引 (created_at, id)。" },
          { id: "b05", t: 19000, dur: 2400,  type: "tool",        name: "run_test 定向 (-k pag)",  parents: ["b04"],  tokens: { in: 0, out: 0 },        status: "ok", detail: "pytest -k pagination：仅 28 个用例，2.4s 建立失败基线。" },
          { id: "b06", t: 21400, dur: 800,   type: "tool",        name: "edit_file + 迁移 SQL",    parents: ["b05"],  tokens: { in: 0, out: 0 },        status: "ok", detail: "修改两处排序 + 新增 migrations/0042_composite_idx.sql。" },
          { id: "b07", t: 22200, dur: 2600,  type: "tool",        name: "run_test 定向验证",       parents: ["b06"],  tokens: { in: 0, out: 0 },        status: "ok", detail: "定向回归全部通过，2.6s。" },
          { id: "b08", t: 24800, dur: 16200, type: "tool",        name: "run_test 全量套件",       parents: ["b07"],  tokens: { in: 0, out: 0 },        status: "ok", detail: "仅在最终验证时跑一次全量，16.2s。" },
          { id: "b09", t: 41000, dur: 100,   type: "observation", name: "测试结果: all pass",      parents: ["b08"],  tokens: { in: 0, out: 0 },        status: "ok", detail: "412/412 通过。" },
          { id: "b10", t: 41100, dur: 5200,  type: "llm",         name: "总结 & 提交说明",         parents: ["b09"],  tokens: { in: 7200, out: 850, cacheIn: 6500 },   status: "ok", detail: "上下文经 Harness 裁剪后仅 7.2k tokens，90% 命中 KV 缓存。" }
        ]
      }
    },

    /* 分叉区间的策展影响评估（按 LCS 分叉序号对应；算法先定位，策展补充业务解读） */
    compareNotes: [
      { d: "Run A 将「根因定位」与「方案设计」拆为两轮推理，Run B 合并为单轮并直接给出含索引迁移的完整方案。", impact: "节省一轮 ~9s 推理 + 一次上下文重传" },
      { d: "反馈环测试策略分叉：Run A 全量回归（18s/次），Run B 定向测试 -k pagination（2.4s/次）。", impact: "反馈环提速 ~7.3×，全量仅在最终验证执行" },
      { d: "Run A 因上下文膨胀至 12.4k 触发 API 超时重试；Run B 裁剪至 7.2k 未触发。", impact: "消除重试损耗与失败风险" },
      { d: "Run A 的 v1 方案遗漏 keyset 分支导致返工一轮；Run B 首轮即全覆盖。", impact: "减少一轮完整 编辑→测试 循环（~27s）" }
    ],

    /* 一键 PR 复现包 */
    repro: {
      patch: `diff --git a/repo/db/paginate.py b/repo/db/paginate.py
index 3f8a1c2..9e7d4b1 100644
--- a/repo/db/paginate.py
+++ b/repo/db/paginate.py
@@ -88,7 +88,7 @@ def build_page_query(table, page, size):
     q = select(table).order_by(
-        table.c.created_at
+        table.c.created_at, table.c.id   # tiebreaker: 消除页边界漂移
     ).offset(page * size).limit(size)
     return q
@@ -141,7 +141,7 @@ def build_keyset_query(table, cursor, size):
     q = select(table).where(
         table.c.created_at >= cursor.ts
-    ).order_by(table.c.created_at).limit(size)
+    ).order_by(table.c.created_at, table.c.id).limit(size)
     return q
diff --git a/repo/migrations/0042_composite_idx.sql b/repo/migrations/0042_composite_idx.sql
new file mode 100644
index 0000000..5c1a9e3
--- /dev/null
+++ b/repo/migrations/0042_composite_idx.sql
@@ -0,0 +1,2 @@
+-- 复合索引：保证 (created_at, id) 排序扫描走索引，避免 filesort
+CREATE INDEX CONCURRENTLY idx_orders_created_id ON orders (created_at, id);
diff --git a/tests/test_pagination_concurrent.py b/tests/test_pagination_concurrent.py
new file mode 100644
index 0000000..a2b3f11
--- /dev/null
+++ b/tests/test_pagination_concurrent.py
@@ -0,0 +1,18 @@
+import asyncio, pytest
+from repo.db import paginate
+
+@pytest.mark.asyncio
+async def test_no_duplicates_under_concurrent_writes(db):
+    """并发写入时分页遍历不得出现重复行（issue #1287 复现用例）"""
+    writer = asyncio.create_task(seed_rows_continuously(db, n=500))
+    seen = set()
+    async for row in paginate.iter_pages("orders", size=50):
+        assert row.id not in seen, f"duplicate row {row.id}"
+        seen.add(row.id)
+    await writer`,
      script: `#!/usr/bin/env bash
# DS Trajectory Studio — 一键复现包 (generated from run-b trajectory)
set -euo pipefail
git checkout -b repro/1287-trajectory
git apply repro-1287.patch
python -m pytest tests/test_pagination_concurrent.py -x -q   # 定向复现
python -m pytest -q                                          # 全量回归
echo "[repro] issue #1287 复现环境就绪"`
    }
  };
});
