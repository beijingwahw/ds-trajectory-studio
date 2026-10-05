/* ============================================================
 * DS Trajectory Studio — export/image
 * SVG 序列化导出（.svg / .png，Canvas 栅格化，2× 超采样）。
 * ============================================================ */
(function (root) {
  "use strict";

  function download(filename, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** 内联计算样式，确保导出的 SVG 脱离页面仍可正确渲染 */
  function inlineStyles(svgEl) {
    const clone = svgEl.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const cssVars = getComputedStyle(document.documentElement);
    clone.querySelectorAll("[fill^='var']").forEach((n) => {
      const varName = n.getAttribute("fill").match(/var\((--[\w-]+)\)/)?.[1];
      if (varName) n.setAttribute("fill", cssVars.getPropertyValue(varName).trim() || "#888");
    });
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%");
    bg.setAttribute("fill", cssVars.getPropertyValue("--bg").trim() || "#0b0f1a");
    clone.insertBefore(bg, clone.firstChild);
    return clone;
  }

  function exportSVG(svgEl, filename) {
    const xml = new XMLSerializer().serializeToString(inlineStyles(svgEl));
    download(filename, new Blob([xml], { type: "image/svg+xml" }));
  }

  function exportPNG(svgEl, filename, scale = 2) {
    const clone = inlineStyles(svgEl);
    const vb = svgEl.viewBox.baseVal;
    const xml = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = (vb.width || svgEl.clientWidth) * scale;
      canvas.height = (vb.height || svgEl.clientHeight) * scale;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => b && download(filename, b), "image/png");
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  }

  root.DSTS = root.DSTS || {};
  root.DSTS.image = { download, exportSVG, exportPNG };
})(typeof self !== "undefined" ? self : globalThis);
