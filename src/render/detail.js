/* ============================================================
 * DS Trajectory Studio — render/detail
 * 事件详情面板：指标 + 描述 + 因果祖先/后代链（可点击跳转）。
 * ============================================================ */
(function (root) {
  "use strict";
  const { util, trace } = root.DSTS;

  const TYPE_LABEL = {
    llm: "LLM 推理", tool: "工具调用", thought: "思考规划",
    observation: "观察结果", error: "异常/重试"
  };

  /**
   * @param {HTMLElement} container
   * @param {object} run
   * @param {object} e 事件
   * @param {(id:string)=>void} onJump 点击祖先/后代 chip 的回调
   */
  function renderDetail(container, run, e, onJump) {
    container.innerHTML = "";
    const card = util.el("div", "detail-card");
    card.appendChild(util.el("h4", null, `${util.esc(e.id)} · ${util.esc(e.name)}`));

    const kv = util.el("dl", "kv");
    const rows = [
      ["类型", TYPE_LABEL[e.type] || e.type],
      ["状态", `<span class="status-pill status-${e.status}">${util.esc(e.status)}</span>`],
      ["开始", util.fmtMs(e.t)],
      ["耗时", util.fmtMs(e.dur)],
      ["Tokens", e.tokens.in + e.tokens.out ? `in ${util.fmtTok(e.tokens.in)} / out ${util.fmtTok(e.tokens.out)}` : "—"],
      ["因果父节点", e.parents.length ? e.parents.map(util.esc).join(", ") : "（根节点）"]
    ];
    for (const [k, v] of rows) {
      kv.appendChild(util.el("dt", null, util.esc(k)));
      kv.appendChild(util.el("dd", null, v));
    }
    card.appendChild(kv);
    if (e.detail) card.appendChild(util.el("div", "detail-text", util.esc(e.detail)));

    const chain = (title, ids) => {
      if (!ids.length) return;
      const box = util.el("div", "chain", `<b>${title}</b><br>`);
      ids.forEach((id) => {
        const c = util.el("span", "chip", util.esc(id));
        c.setAttribute("role", "button");
        c.tabIndex = 0;
        c.onclick = () => onJump(id);
        c.onkeydown = (ev) => { if (ev.key === "Enter") onJump(id); };
        box.appendChild(c);
      });
      card.appendChild(box);
    };
    chain("因果祖先链：", trace.ancestors(run.events, e.id));
    chain("因果后代：", trace.descendants(run.events, e.id));

    container.appendChild(card);
  }

  root.DSTS.detail = { renderDetail, TYPE_LABEL };
})(typeof self !== "undefined" ? self : globalThis);
