/* ============================================================
 * DS Trajectory Studio — render/svg
 * SVG 命名空间构造助手（仅浏览器端）。
 * ============================================================ */
(function (root) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";

  function elNS(tag, attrs = {}) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  function createSVG(width, height) {
    const svg = elNS("svg", { width, height, role: "img" });
    const defs = elNS("defs");
    const marker = elNS("marker", { id: "dsts-arr", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    marker.appendChild(elNS("path", { d: "M0,0 L10,5 L0,10 z", fill: "#3b4a6b" }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    return svg;
  }

  /** 三次贝塞尔竖向曲线（父→子） */
  const curveDown = (x1, y1, x2, y2) =>
    `M${x1},${y1} C${x1},${y1 + 28} ${x2},${y2 - 28} ${x2},${y2}`;

  root.DSTS = root.DSTS || {};
  root.DSTS.svg = { NS, elNS, createSVG, curveDown };
})(typeof self !== "undefined" ? self : globalThis);
