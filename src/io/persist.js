/* ============================================================
 * DS Trajectory Studio — io/persist
 * IndexedDB 持久化：导入的轨迹跨会话保留。
 * 环境不支持（隐私模式 / file:// 受限）时静默降级为无操作。
 * ============================================================ */
(function (root) {
  "use strict";

  const DB_NAME = "dsts";
  const STORE = "runs";

  const available = () => {
    try { return typeof indexedDB !== "undefined"; }
    catch { return false; }
  };

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!available()) return reject(new Error("IndexedDB 不可用"));
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => {
        if (!rq.result.objectStoreNames.contains(STORE)) {
          rq.result.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }

  /** 保存（upsert）一条 Run；失败静默 */
  async function saveRun(run) {
    try {
      const db = await openDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(run);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch { return false; }
  }

  /** 读取全部已保存 Run；失败返回空数组 */
  async function loadAll() {
    try {
      const db = await openDB();
      return await new Promise((resolve) => {
        const rq = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        rq.onsuccess = () => resolve(rq.result || []);
        rq.onerror = () => resolve([]);
      });
    } catch { return []; }
  }

  /** 删除指定 Run */
  async function remove(id) {
    try {
      const db = await openDB();
      db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
      return true;
    } catch { return false; }
  }

  root.DSTS = root.DSTS || {};
  root.DSTS.persist = { saveRun, loadAll, remove };
})(typeof self !== "undefined" ? self : globalThis);
