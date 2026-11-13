// ==UserScript==
// @name         VietPhrase Lite (STV scope)
// @namespace    vietphrase-lite
// @version      0.8.14
// @description  Tự động dịch trang web tiếng Trung sang tiếng Việt bằng VietPhrase (bản userscript của extension VietPhrase Lite).
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @grant        GM.registerMenuCommand
// @connect      *
// @license      MIT (vendor/opencc-js: MIT, The nk2028 Project)
// ==/UserScript==

(function () {
"use strict";
/* ===== VietPhrase Lite – lớp tương thích userscript =====
 * Thay thế các API của extension (chrome.storage, runtime.onMessage, getURL, popup, options)
 * bằng GM_* của Tampermonkey/Violentmonkey/Greasemonkey. Phần logic dịch giữ nguyên bản extension.
 */
(function installUserscriptShim() {
  "use strict";

  const g = globalThis;
  const SCOPE = "vietphrase-userscript";
  const IS_TOP = window === window.top;
  const BASE_URL_KEY = "vpDictBaseUrl";
  const DEFAULT_BASE_URL = "https://raw.githubusercontent.com/aoloihpq-debug/vpt-files/main/";
  const SETTINGS_KEY = "vpSettings";
  const DICT_KEY = "vpDictionary";
  const NAME2_KEY = "vpName2Dictionary";
  const VIETPHRASE2_KEY = "vpVietPhrase2Dictionary";
  const WATCHED_KEYS = [DICT_KEY, NAME2_KEY, VIETPHRASE2_KEY];
  const BUNDLED_ENTRY_COUNT = 1003971;
  const REMOTE_FILES = {
    "data/compiled-trie.vpt": "compiled-trie.vpt",
    "data/compiled-hanviet.vpt": "compiled-hanviet.vpt"
  };
  const RELAYED_TYPES = new Set(["refresh", "toggle", "toggleTab", "toggleSite", "setActiveProfile"]);
  const DEFAULT_SETTINGS = {
    enabled: true,
    minChars: 1,
    batchSize: 40,
    translateTitle: true,
    simplifyTraditional: true,
    translateSubframes: true,
    disabledHosts: [],
    fontFamily: "default"
  };
  const FONT_OPTIONS = [
    ["default", "Theo trang web"], ["georgia", "Georgia"], ["times", "Times New Roman"],
    ["palatino", "Palatino"], ["cambria", "Cambria"], ["segoe", "Segoe UI"],
    ["tahoma", "Tahoma"], ["verdana", "Verdana"], ["arial", "Arial"]
  ];

  // ---------- GM_* wrappers ----------
  const hasGM = typeof GM !== "undefined" && GM;
  function lsGet(key) { try { return localStorage.getItem("__vp_" + key); } catch (e) { return null; } }
  function lsSet(key, value) { try { localStorage.setItem("__vp_" + key, value); } catch (e) { /* ignore */ } }

  async function rawGet(key) {
    if (typeof GM_getValue === "function") return GM_getValue(key, undefined);
    if (hasGM && typeof GM.getValue === "function") return GM.getValue(key, undefined);
    const v = lsGet(key);
    return v === null ? undefined : v;
  }
  async function rawSet(key, value) {
    if (typeof GM_setValue === "function") return GM_setValue(key, value);
    if (hasGM && typeof GM.setValue === "function") return GM.setValue(key, value);
    return lsSet(key, value);
  }
  function encode(value) { return JSON.stringify(value); }
  function decode(value) {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch (e) { return value; }
  }

  const storage = {
    async get(keys) {
      const out = {};
      for (const key of keys) {
        const value = decode(await rawGet(key));
        if (value !== undefined && value !== null) out[key] = value;
      }
      return out;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) await rawSet(key, encode(value));
    }
  };

  const changeListeners = [];
  const nativeStorage = {
    onChanged: { addListener(fn) { changeListeners.push(fn); } }
  };
  if (typeof GM_addValueChangeListener === "function") {
    for (const key of WATCHED_KEYS) {
      GM_addValueChangeListener(key, (name, oldValue, newValue) => {
        const changes = { [name]: { oldValue: decode(oldValue), newValue: decode(newValue) } };
        for (const fn of changeListeners) {
          try { fn(changes, "local"); } catch (e) { /* ignore */ }
        }
      });
    }
  }

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      const fn = typeof GM_xmlhttpRequest === "function"
        ? GM_xmlhttpRequest
        : (hasGM && typeof GM.xmlHttpRequest === "function" ? GM.xmlHttpRequest.bind(GM) : null);
      if (!fn) {
        reject(new Error("Trình quản lý userscript không hỗ trợ GM_xmlhttpRequest"));
        return;
      }
      fn({
        method: "GET",
        ...options,
        onload: resolve,
        onerror: () => reject(new Error("Lỗi mạng")),
        ontimeout: () => reject(new Error("Hết thời gian chờ")),
        onabort: () => reject(new Error("Bị hủy"))
      });
    });
  }

  // ---------- Tải từ điển ----------
  async function getBaseUrl() {
    const value = decode(await rawGet(BASE_URL_KEY));
    const url = typeof value === "string" ? value.trim() : "";
    const base = url || DEFAULT_BASE_URL;
    return base.endsWith("/") ? base : base + "/";
  }

  async function gunzipIfNeeded(buffer) {
    const bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buffer;
    if (typeof DecompressionStream !== "function") {
      throw new Error("trình duyệt không hỗ trợ giải nén gzip, hãy dùng file .vpt không nén");
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
  }

  // Từ điển chọn từ máy được lưu trong IndexedDB của trang (mỗi web một bản, chỉ trang có chữ Hán mới nạp).
  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("vp-userscript", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("files");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function idbGet(key) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const req = db.transaction("files").objectStore("files").get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) { return null; }
  }
  async function idbPut(key, value) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDelete(key) {
    try {
      const db = await openDb();
      await new Promise((resolve) => {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").delete(key);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    } catch (e) { /* ignore */ }
  }

  // ---------- Bộ nhớ chung của trình quản lý userscript (dùng cho mọi website) ----------
  const DICT_CACHE_PREFIX = "vpDictFile:";
  const hasGmStorage = typeof GM_setValue === "function" || (hasGM && typeof GM.setValue === "function");
  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }
  function base64ToBuffer(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  async function gmCacheGet(fileName) {
    if (!hasGmStorage) return null;
    try {
      const text = await rawGet(DICT_CACHE_PREFIX + fileName);
      return typeof text === "string" && text ? base64ToBuffer(text) : null;
    } catch (e) { return null; }
  }
  async function gmCacheHas(fileName) {
    if (!hasGmStorage) return false;
    try {
      const text = await rawGet(DICT_CACHE_PREFIX + fileName);
      return typeof text === "string" && text.length > 0;
    } catch (e) { return false; }
  }
  // Có GM storage thì lưu dùng chung cho mọi web; không có thì lưu IndexedDB riêng từng web.
  async function saveDictionaryCache(fileName, buffer) {
    if (hasGmStorage) {
      await rawSet(DICT_CACHE_PREFIX + fileName, bufferToBase64(buffer));
      await idbDelete(fileName);
    } else {
      await idbPut(fileName, buffer);
    }
  }
  async function deleteDictionaryCache(fileName) {
    if (hasGmStorage) { try { await rawSet(DICT_CACHE_PREFIX + fileName, ""); } catch (e) { /* ignore */ } }
    await idbDelete(fileName);
  }
  async function hasDictionaryCache(fileName) {
    return (await gmCacheHas(fileName)) || Boolean(await idbGet(fileName));
  }

  let downloadNotice = null;
  async function downloadDictionaryFile(fileName) {
    const shared = await gmCacheGet(fileName);
    if (shared) {
      try { return await gunzipIfNeeded(shared); } catch (e) { /* hỏng thì tải lại */ }
    }
    const local = await idbGet(fileName);
    if (local) return gunzipIfNeeded(local);
    const base = await getBaseUrl();
    if (!base) {
      if (IS_TOP) promptPickDictionary();
      throw new Error("chưa có file từ điển");
    }
    if (IS_TOP && !downloadNotice) downloadNotice = toast("VietPhrase: đang tải từ điển…", 60000);
    let lastError = null;
    const bases = base === DEFAULT_BASE_URL ? [base] : [base, DEFAULT_BASE_URL];
    const attempts = [];
    for (const b of bases) for (const c of [fileName + ".gz", fileName]) attempts.push(b + c);
    for (const candidate of attempts) {
      try {
        const response = await gmRequest({
          url: candidate,
          responseType: "arraybuffer",
          timeout: 300000,
          anonymous: true
        });
        if (response.status >= 200 && response.status < 300 && response.response) {
          const raw = response.response;
          const plain = await gunzipIfNeeded(raw);
          // Lưu bản tải về vào IndexedDB để lần sau (trang mới cùng web) không phải tải lại.
          // Chạy nền, không chờ: lưu lỗi/treo cũng không được chặn việc dịch.
          try {
            const magic = String.fromCharCode(...new Uint8Array(plain, 0, 4));
            if (magic === "VPT2") saveDictionaryCache(fileName, raw.slice(0)).catch(() => {});
          } catch (e) { /* không lưu được cũng không sao */ }
          return plain;
        }
        lastError = new Error(`HTTP ${response.status} (${candidate})`);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("không tải được " + fileName);
  }

  function makeResponse(buffer, jsonValue) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buffer,
      json: async () => jsonValue
    };
  }

  async function fetchData(path) {
    if (path === "data/compiled.vpd.meta.json") {
      return makeResponse(null, { entryCount: BUNDLED_ENTRY_COUNT });
    }
    const fileName = REMOTE_FILES[path];
    if (!fileName) return { ok: false, status: 404 };
    try {
      const buffer = await downloadDictionaryFile(fileName);
      return makeResponse(buffer, null);
    } catch (error) {
      if (IS_TOP) toast("VietPhrase: không tải được " + fileName + "\nLý do: " + (error && error.message ? error.message : error), 12000);
      throw error;
    } finally {
      if (downloadNotice && path === "data/compiled-hanviet.vpt") {
        downloadNotice.remove();
        downloadNotice = null;
      }
    }
  }

  async function fetchExternal(url) {
    const response = await gmRequest({ url, responseType: "text", timeout: 20000, anonymous: true });
    const ok = response.status >= 200 && response.status < 300;
    return { ok, status: response.status, json: async () => JSON.parse(response.responseText) };
  }

  function download({ url, filename }) {
    const link = document.createElement("a");
    link.href = url;
    link.download = String(filename || "download.txt").split("/").pop();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---------- Nhắn tin giữa các frame (thay cho chrome.tabs.sendMessage) ----------
  let messageListener = null;
  const runtime = { onMessage: { addListener(fn) { messageListener = fn; } } };

  function relayToChildren(message) {
    for (let i = 0; i < window.frames.length; i += 1) {
      try { window.frames[i].postMessage({ __vp: SCOPE, message }, "*"); } catch (e) { /* ignore */ }
    }
  }

  if (!IS_TOP) {
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.__vp !== SCOPE || event.source !== window.parent) return;
      const message = data.message;
      if (!message || !RELAYED_TYPES.has(message.type)) return;
      relayToChildren(message);
      if (messageListener) {
        Promise.resolve(messageListener(message, {}, () => {})).catch(() => {});
      }
    });
  }

  async function send(message) {
    const full = { scope: "vietphrase", ...message };
    if (RELAYED_TYPES.has(full.type)) relayToChildren(full);
    return messageListener ? messageListener(full, {}, () => {}) : null;
  }

  g.vpBrowserApi = {
    usesPromiseApi: true,
    storage,
    nativeStorage,
    runtime,
    downloads: { download },
    getURL: (path) => path,
    fetchData,
    fetchExternal,
    tabs: { query: async () => [], sendMessage: async () => null, update: async () => null, create: async () => null }
  };

  if (!IS_TOP) return; // Từ đây là giao diện: chỉ khung chính.

  // ---------- Giao diện (khung chính) ----------
  let uiHost = null;
  let uiRoot = null;
  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483647;
      max-width: 90vw; background: #1f2933; color: #fff; padding: 10px 16px; border-radius: 10px;
      font-size: 14px; line-height: 1.4; box-shadow: 0 6px 24px rgba(0,0,0,.35); white-space: pre-line; }
    .fab { position: fixed; right: 8px; z-index: 2147483646; width: 44px; height: 44px; touch-action: none;
      border-radius: 22px; border: 0; background: #0f7b68; color: #fff; font-weight: 700; font-size: 14px; opacity: .8;
      box-shadow: 0 2px 10px rgba(0,0,0,.35); }
    .fabmenu { position: fixed; z-index: 2147483647; background: #fff; border-radius: 10px; padding: 6px; min-width: 210px;
      box-shadow: 0 8px 28px rgba(0,0,0,.4); display: flex; flex-direction: column; gap: 4px; }
    .fabmenu button { text-align: left; padding: 11px 12px; font-size: 15px; border: 0; background: transparent; color: #1f2933; }
    .fabmenu button:active { background: #e6f4f1; }
    .overlay { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.5); display: flex;
      align-items: flex-start; justify-content: center; overflow-y: auto; padding: 12px; }
    .dlg { width: min(560px, 100%); background: #fff; color: #1f2933; border-radius: 12px; padding: 16px; margin: auto 0; }
    h2 { font-size: 17px; margin: 0 0 8px; } h3 { font-size: 14px; margin: 16px 0 6px; padding-top: 10px; border-top: 1px solid #e4e7eb; }
    label { display: block; font-size: 13px; margin: 6px 0 2px; }
    label.check { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
    input[type=text], input[type=number], select { width: 100%; padding: 8px; font-size: 14px; border: 1px solid #cbd2d9; border-radius: 6px; }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0; font-size: 13px; }
    .row .grow { flex: 1; min-width: 120px; overflow-wrap: anywhere; }
    button { padding: 6px 10px; font-size: 13px; border: 1px solid #0f7b68; background: #fff; color: #0f7b68; border-radius: 6px; }
    button.primary { background: #0f7b68; color: #fff; }
    button.danger { border-color: #c0392b; color: #c0392b; }
    .hint { font-size: 12px; color: #616e7c; margin: 2px 0; } .msg { font-size: 13px; color: #0a6; min-height: 18px; margin-top: 8px; }
    .foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
  `;

  function ensureUi() {
    if (uiRoot) return uiRoot;
    uiHost = document.createElement("div");
    uiHost.id = "vp-userscript-ui";
    uiRoot = uiHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = UI_CSS;
    uiRoot.appendChild(style);
    (document.body || document.documentElement).appendChild(uiHost);
    return uiRoot;
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === "class") el.className = value;
      else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else if (key in el) el[key] = value;
      else el.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function toast(text, ms = 3000) {
    const root = ensureUi();
    const el = h("div", { class: "toast" }, text);
    root.appendChild(el);
    const timer = setTimeout(() => el.remove(), ms);
    const remove = el.remove.bind(el);
    el.remove = () => { clearTimeout(timer); remove(); };
    return el;
  }

  async function getStatus() {
    const status = await send({ type: "status" });
    return status || { ok: false };
  }

  function formatStatus(status) {
    if (!status.ok) return "Chưa có trạng thái";
    const progress = status.progress && status.progress.label ? `\n${status.progress.label}` : "";
    const missing = status.missingFiles && status.missingFiles.length
      ? `\nLỗi tải: ${status.missingFiles.join("; ")}` : "";
    return `${status.enabled ? "Đang BẬT" : "Đang TẮT"} (tab: ${status.tabDisabled ? "tắt" : "bật"}, web: ${status.siteDisabled ? "tắt" : "bật"})\n` +
      `Mục từ: ${status.entries || 0} (gốc ${status.bundledEntries || 0}, Name2 ${status.name2Entries || 0}, VP2 ${status.vietPhrase2Entries || 0})` +
      progress + missing;
  }

  async function cmdToggleTab() {
    const status = await getStatus();
    const result = await send({ type: "toggleTab", disabled: !status.tabDisabled });
    toast(result && result.tabDisabled ? "VietPhrase: ĐÃ TẮT trên tab này" : "VietPhrase: ĐÃ BẬT trên tab này");
  }

  async function cmdToggleSite() {
    const status = await getStatus();
    const result = await send({ type: "toggleSite", disabled: !status.siteDisabled });
    if (result && result.ok === false) toast(result.error || "Không đổi được");
    else toast(result && result.siteDisabled ? "VietPhrase: ĐÃ TẮT trên web này" : "VietPhrase: ĐÃ BẬT trên web này");
  }

  async function cmdRefresh() {
    toast("VietPhrase: đang dịch lại…");
    await send({ type: "refresh" });
    toast("VietPhrase: đã dịch lại trang");
  }

  async function cmdStatus() { toast(formatStatus(await getStatus()), 6000); }

  async function cmdPickProfile() {
    const result = await send({ type: "getMatchingProfiles" });
    if (!result || !result.ok) { toast("Không đọc được profile Name2"); return; }
    const list = result.matchingProfiles || [];
    if (!list.length) { toast("Chưa có profile Name2 nào khớp trang này.\nImport file Name2-*.txt trong Cài đặt."); return; }
    const lines = ["0. Name2 toàn cục (không dùng profile)"].concat(
      list.map((p, i) => `${i + 1}. ${p.bookName} — ${p.entryCount} mục${p.id === result.activeProfileId ? "  ← đang dùng" : ""}`)
    );
    const answer = prompt("Chọn profile Name2 cho tab này:\n\n" + lines.join("\n"), "");
    if (answer === null || answer.trim() === "") return;
    const index = Number(answer.trim());
    if (!Number.isInteger(index) || index < 0 || index > list.length) { toast("Số không hợp lệ"); return; }
    await send({ type: "setActiveProfile", profileId: index === 0 ? null : list[index - 1].id });
    toast(index === 0 ? "Đã dùng Name2 toàn cục" : `Đã chọn profile: ${list[index - 1].bookName}`);
  }

  let fabSettingHook = null;

  // ---------- Hộp Cài đặt ----------
  function parseDictionaryStrict(text) {
    const core = g.vpName2Profiles;
    const entries = [];
    const byKey = new Map();
    const lines = String(text || "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      const pair = core.splitEntry(line);
      if (!pair) return { ok: false, error: `File không đúng cấu trúc ở dòng ${i + 1}. Cần dạng key=value.` };
      const key = pair[0].trim();
      const value = pair[1].trim();
      if (!key || !value) return { ok: false, error: `File thiếu key hoặc nghĩa ở dòng ${i + 1}.` };
      if (byKey.has(key)) entries[byKey.get(key)] = { key, value };
      else { byKey.set(key, entries.length); entries.push({ key, value }); }
    }
    return entries.length ? { ok: true, entries } : { ok: false, error: "File không có mục hợp lệ." };
  }

  function mergeEntries(current, imported) {
    const byKey = new Map();
    const merged = [];
    let added = 0;
    let updated = 0;
    for (const entry of current) {
      if (byKey.has(entry.key)) continue;
      byKey.set(entry.key, merged.length);
      merged.push({ key: entry.key, value: entry.value });
    }
    for (const entry of imported) {
      if (byKey.has(entry.key)) { merged[byKey.get(entry.key)] = { key: entry.key, value: entry.value }; updated += 1; }
      else { byKey.set(entry.key, merged.length); merged.push({ key: entry.key, value: entry.value }); added += 1; }
    }
    return { entries: merged, added, updated };
  }

  function saveTextFile(name, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    download({ url: URL.createObjectURL(blob), filename: name });
  }

  function pickFile(accept, multiple) {
    return new Promise((resolve) => {
      const input = h("input", { type: "file", accept, multiple: Boolean(multiple), style: "display:none" });
      input.addEventListener("change", () => {
        const list = Array.from(input.files || []);
        resolve(multiple ? list : (list[0] || null));
        input.remove();
      });
      uiRoot.appendChild(input);
      input.click();
    });
  }

  function dictionaryKeyForFile(file) {
    const name = file.name.toLowerCase();
    if (name.includes("hanviet")) return "compiled-hanviet.vpt";
    if (name.includes("trie")) return "compiled-trie.vpt";
    return file.size > 5 * 1024 * 1024 ? "compiled-trie.vpt" : "compiled-hanviet.vpt";
  }

  async function pickDictionaryFiles() {
    ensureUi();
    const files = await pickFile(".gz,.vpt,application/gzip,application/octet-stream,*/*", true);
    if (!files.length) return false;
    const saved = [];
    for (const file of files) {
      const key = dictionaryKeyForFile(file);
      const buffer = await file.arrayBuffer();
      try {
        const plain = await gunzipIfNeeded(buffer);
        const magic = String.fromCharCode(...new Uint8Array(plain, 0, 4));
        if (magic !== "VPT2") throw new Error("sai định dạng");
      } catch (error) {
        toast(`File "${file.name}" không phải từ điển VietPhrase (${error.message}).`, 6000);
        continue;
      }
      await saveDictionaryCache(key, buffer);
      saved.push(key);
    }
    if (!saved.includes("compiled-trie.vpt")) {
      toast(saved.length ? "Đã lưu hanviet nhưng thiếu compiled-trie.vpt.gz (file lớn 12 MB)." : "Chưa lưu được file nào.", 6000);
      return false;
    }
    toast("Đã lưu từ điển vào trình duyệt. Đang tải lại trang…");
    setTimeout(() => location.reload(), 700);
    return true;
  }

  let pickPromptShown = false;
  function promptPickDictionary() {
    if (pickPromptShown) return;
    pickPromptShown = true;
    const root = ensureUi();
    const box = h("div", { class: "toast", style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" },
      "VietPhrase: trang này chưa có từ điển.",
      h("button", { class: "primary", onclick: async () => { await pickDictionaryFiles(); } }, "Chọn file từ điển"),
      h("button", { onclick: () => box.remove() }, "Để sau"));
    root.appendChild(box);
  }

  async function openSettings() {
    const root = ensureUi();
    if (root.querySelector(".overlay")) return;
    const core = g.vpName2Profiles;
    const stored = await storage.get([SETTINGS_KEY, DICT_KEY, NAME2_KEY, VIETPHRASE2_KEY]);
    const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
    let disabledHosts = Array.isArray(settings.disabledHosts) ? [...settings.disabledHosts] : [];
    const storedBaseUrl = String(decode(await rawGet(BASE_URL_KEY)) || "");
    const baseUrl = storedBaseUrl || DEFAULT_BASE_URL;

    const dictStatus = h("div", { class: "hint" });
    async function refreshDictStatus() {
      const trie = await hasDictionaryCache("compiled-trie.vpt");
      const hv = await hasDictionaryCache("compiled-hanviet.vpt");
      dictStatus.textContent = `Đã lưu${hasGmStorage ? " (dùng chung mọi web)" : " (riêng trang này)"}: trie ${trie ? "đã có" : "CHƯA có"}, Hán Việt ${hv ? "đã có" : "CHƯA có"}.`;
    }
    const message = h("div", { class: "msg" });
    const say = (text, isError) => { message.textContent = text; message.style.color = isError ? "#c0392b" : "#0a6"; };

    const urlInput = h("input", { type: "text", value: baseUrl, placeholder: DEFAULT_BASE_URL + " (để trống sẽ dùng mặc định)" });
    const titleInput = h("input", { type: "checkbox", checked: settings.translateTitle !== false });
    const simplifyInput = h("input", { type: "checkbox", checked: settings.simplifyTraditional === true });
    const fabInput = h("input", { type: "checkbox", checked: decode(await rawGet("vpShowFab")) !== false });
    const subframeInput = h("input", { type: "checkbox", checked: settings.translateSubframes !== false });
    const batchInput = h("input", { type: "number", min: 10, max: 300, value: String(settings.batchSize || 40) });
    const fontSelect = h("select", {}, FONT_OPTIONS.map(([value, label]) => h("option", { value, selected: value === settings.fontFamily }, label)));

    const dictRows = h("div");
    const dictDefs = [
      { key: DICT_KEY, label: "Ghi đè nghĩa", file: "Override.txt", hint: "萧炎=Tiêu Viêm" },
      { key: NAME2_KEY, label: "Name2", file: "Name2.txt", hint: "萧炎=Tiêu Viêm" },
      { key: VIETPHRASE2_KEY, label: "VietPhrase2", file: "VietPhrase2.txt", hint: "斗气大陆=đấu khí đại lục" }
    ];
    const dictAreas = new Map();
    const dictCounts = new Map();
    const updateDictCount = (def) => {
      dictCounts.get(def.key).textContent =
        `${def.label}: ${core.parseDictionaryText(dictAreas.get(def.key).value).length} mục`;
    };
    for (const def of dictDefs) {
      const area = h("textarea", { rows: 5, spellcheck: false, placeholder: def.hint,
        style: "width:100%;font:12px monospace;padding:6px;border:1px solid #cbd2d9;border-radius:6px" });
      area.addEventListener("input", () => updateDictCount(def));
      dictAreas.set(def.key, area);
      dictCounts.set(def.key, h("span", { class: "grow" }));
      dictRows.append(
        h("div", { class: "row" },
          dictCounts.get(def.key),
          h("button", { onclick: async () => {
            const file = await pickFile(".txt,.dic,.csv,text/plain,*/*");
            if (!file) return;
            const parsed = parseDictionaryStrict(await file.text());
            if (!parsed.ok) { say(parsed.error, true); return; }
            const merged = mergeEntries(core.parseDictionaryText(area.value), parsed.entries);
            area.value = core.stringifyEntries(merged.entries);
            updateDictCount(def);
            say(`Đã import ${def.label}: thêm ${merged.added}, ghi đè ${merged.updated}. Bấm "Lưu & dịch lại" để áp dụng.`);
          } }, "Import từ máy"),
          h("button", { onclick: () => saveTextFile(def.file, core.stringifyEntries(core.parseDictionaryText(area.value))) }, "Export")),
        area);
      const current = Array.isArray(stored[def.key]) ? stored[def.key] : [];
      area.value = core.stringifyEntries(current);
      updateDictCount(def);
    }

    const profileRows = h("div");
    async function renderProfiles() {
      const profiles = await core.loadProfiles();
      if (!profiles.length) { profileRows.replaceChildren(h("div", { class: "hint" }, "Chưa có profile nào.")); return; }
      profileRows.replaceChildren(...profiles.map((p) => h("div", { class: "row" },
        h("span", { class: "grow" }, `#${String(p.priority).padStart(2, "0")} ${p.bookName} — ${p.host} (${(p.entries || []).length} mục)`),
        h("button", { onclick: () => saveTextFile(core.generateProfileFilename(p), core.stringifyEntries(p.entries || [])) }, "Export"),
        h("button", { class: "danger", onclick: async () => {
          if (!confirm("Xóa profile này?")) return;
          await core.deleteProfile(p.id);
          renderProfiles();
        } }, "Xóa"))));
    }
    async function importProfile() {
      const file = await pickFile(".txt,.dic,.csv,text/plain");
      if (!file) return;
      const parsed = core.parseProfileFilename(file.name);
      if (!parsed) { say("Tên file phải có dạng Name2-<tên truyện>--<ưu tiên>--<host>--<đường_dẫn>.txt", true); return; }
      if (!parsed.host.includes(".")) { say("Hostname không hợp lệ: " + parsed.host, true); return; }
      const entries = core.parseDictionaryText(await file.text());
      if (!entries.length) { say("File không có mục hợp lệ", true); return; }
      await core.upsertProfile({
        id: core.generateProfileId(parsed.priority, parsed.host, parsed.segments),
        priority: parsed.priority, host: parsed.host, segments: parsed.segments,
        bookName: parsed.bookName, entries
      });
      say(`Đã import profile ${parsed.bookName} (${entries.length} mục).`);
      renderProfiles();
    }

    const hostRows = h("div");
    function renderHosts() {
      if (!disabledHosts.length) { hostRows.replaceChildren(h("div", { class: "hint" }, "Chưa có web ngoại lệ.")); return; }
      hostRows.replaceChildren(...disabledHosts.map((host) => h("div", { class: "row" },
        h("span", { class: "grow" }, host),
        h("button", { onclick: () => { disabledHosts = disabledHosts.filter((x) => x !== host); renderHosts(); } }, "Bỏ"))));
    }

    async function save() {
      const nextBase = urlInput.value.trim();
      const baseChanged = nextBase !== baseUrl;
      const next = {
        enabled: true,
        minChars: 1,
        batchSize: Math.min(300, Math.max(10, Number(batchInput.value) || 40)),
        translateTitle: titleInput.checked,
        simplifyTraditional: simplifyInput.checked,
        translateSubframes: subframeInput.checked,
        disabledHosts,
        fontFamily: fontSelect.value
      };
      const dictValues = {};
      for (const def of dictDefs) dictValues[def.key] = core.parseDictionaryText(dictAreas.get(def.key).value);
      await storage.set({ [SETTINGS_KEY]: next, ...dictValues });
      if (fabSettingHook) await fabSettingHook(fabInput.checked);
      await rawSet(BASE_URL_KEY, encode(nextBase));
      overlay.remove();
      if (baseChanged) { toast("Đã lưu URL từ điển. Đang tải lại trang…"); setTimeout(() => location.reload(), 600); return; }
      await cmdRefresh();
    }

    const overlay = h("div", { class: "overlay" }, h("div", { class: "dlg" },
      h("h2", {}, "VietPhrase Lite – Cài đặt"),
      h("h3", { style: "border:0;margin-top:0;padding:0" }, "Từ điển gốc (~1 triệu mục)"),
      dictStatus,
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: pickDictionaryFiles }, "Chọn file từ điển từ máy"),
        h("button", { class: "danger", onclick: async () => {
          if (!confirm("Xóa từ điển đã lưu?")) return;
          await deleteDictionaryCache("compiled-trie.vpt"); await deleteDictionaryCache("compiled-hanviet.vpt");
          say("Đã xóa từ điển đã lưu."); refreshDictStatus();
        } }, "Xóa")),
      h("div", { class: "hint" }, "Chọn cả 2 file: compiled-trie.vpt.gz và compiled-hanviet.vpt.gz. Chỉ cần chọn một lần cho toàn bộ trình duyệt."),
      h("label", {}, "Nâng cao – hoặc tải từ URL (tùy chọn)"),
      urlInput,
      h("h3", {}, "Thiết lập"),
      h("label", { class: "check" }, titleInput, "Dịch tiêu đề trang"),
      h("label", { class: "check" }, simplifyInput, "Đổi phồn thể sang giản thể trước khi dịch"),
      h("label", { class: "check" }, subframeInput, "Dịch cả iframe"),
      h("label", { class: "check" }, fabInput, "Hiện nút nổi VP trên trang"),
      h("label", {}, "Số đoạn mỗi lô (10–300)"), batchInput,
      h("label", {}, "Font"), fontSelect,
      h("h3", {}, "Từ điển cá nhân"), dictRows,
      h("h3", {}, "Name2 theo truyện"),
      h("div", { class: "row" }, h("button", { onclick: importProfile }, "Import Name2-*.txt")),
      profileRows,
      h("h3", {}, "Web bị tắt"), hostRows,
      message,
      h("div", { class: "foot" },
        h("button", { onclick: () => overlay.remove() }, "Đóng"),
        h("button", { class: "primary", onclick: save }, "Lưu & dịch lại"))));
    root.appendChild(overlay);
    renderProfiles();
    renderHosts();
    refreshDictStatus();
  }

  // ---------- Menu ----------
  const commands = [
    ["VietPhrase: Bật/tắt tab này", cmdToggleTab],
    ["VietPhrase: Bật/tắt web này", cmdToggleSite],
    ["VietPhrase: Dịch lại trang", cmdRefresh],
    ["VietPhrase: Chọn profile Name2", cmdPickProfile],
    ["VietPhrase: Trạng thái", cmdStatus],
    ["VietPhrase: Chọn file từ điển", pickDictionaryFiles],
    ["VietPhrase: Cài đặt…", openSettings]
  ];
  const registerMenu = typeof GM_registerMenuCommand === "function"
    ? GM_registerMenuCommand
    : (hasGM && typeof GM.registerMenuCommand === "function" ? GM.registerMenuCommand.bind(GM) : null);
  const runCommand = (fn) => { Promise.resolve(fn()).catch((e) => toast("Lỗi: " + (e && e.message ? e.message : e))); };
  if (registerMenu) {
    for (const [label, fn] of commands) registerMenu(label, () => runCommand(fn));
  }

  // ---------- Nút nổi ----------
  const FAB_SHOW_KEY = "vpShowFab";
  const FAB_POS_KEY = "vpFabPos";
  let fabEl = null;
  let fabMenu = null;

  function closeFabMenu() { if (fabMenu) { fabMenu.remove(); fabMenu = null; } }

  function toggleFabMenu() {
    if (fabMenu) { closeFabMenu(); return; }
    const root = ensureUi();
    const rect = fabEl.getBoundingClientRect();
    fabMenu = h("div", { class: "fabmenu" }, commands.map(([label, fn]) =>
      h("button", { onclick: () => { closeFabMenu(); runCommand(fn); } }, label.replace("VietPhrase: ", ""))));
    const openUp = rect.top > window.innerHeight / 2;
    fabMenu.style.right = "12px";
    if (openUp) fabMenu.style.bottom = (window.innerHeight - rect.top + 8) + "px";
    else fabMenu.style.top = (rect.bottom + 8) + "px";
    root.appendChild(fabMenu);
  }

  async function mountFab() {
    if (fabEl) return;
    const show = decode(await rawGet(FAB_SHOW_KEY));
    if (show === false) return;
    const root = ensureUi();
    fabEl = h("button", { class: "fab", title: "VietPhrase" }, "VP");
    const savedTop = Number(decode(await rawGet(FAB_POS_KEY)));
    fabEl.style.top = (Number.isFinite(savedTop) && savedTop > 0 ? Math.min(savedTop, window.innerHeight - 52) : Math.round(window.innerHeight * 0.6)) + "px";
    // Kéo lên/xuống để đổi vị trí, chạm nhẹ để mở menu.
    let startY = 0; let startTop = 0; let moved = false; let dragging = false;
    fabEl.addEventListener("pointerdown", (e) => {
      dragging = true; moved = false; startY = e.clientY; startTop = fabEl.getBoundingClientRect().top;
      try { fabEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    fabEl.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 6) moved = true;
      if (moved) {
        closeFabMenu();
        fabEl.style.top = Math.max(0, Math.min(window.innerHeight - 44, startTop + dy)) + "px";
      }
    });
    fabEl.addEventListener("pointerup", () => {
      dragging = false;
      if (moved) rawSet(FAB_POS_KEY, encode(Math.round(fabEl.getBoundingClientRect().top)));
      else toggleFabMenu();
    });
    root.appendChild(fabEl);
  }

  function unmountFab() { closeFabMenu(); if (fabEl) { fabEl.remove(); fabEl = null; } }

  fabSettingHook = async (visible) => {
    await rawSet(FAB_SHOW_KEY, encode(visible));
    if (visible) await mountFab(); else unmountFab();
  };

  if (document.body) mountFab(); else document.addEventListener("DOMContentLoaded", mountFab);
})();

(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
  typeof define === 'function' && define.amd ? define(['exports'], factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.OpenCC = {}));
})(this, (function (exports) { 'use strict';

  /**
   * 字典，範例："a alpha|b beta" 或 [["a", "alpha"], ["b", "beta"]]
   * @typedef {string|string[][]} DictLike
   */

  /**
   * 字典群組
   * @typedef {DictLike[]} DictGroup
   */

  /**
   * 地區設定資料
   * @typedef {object} LocalePreset
   * @property {object.<string, DictGroup>} from
   * @property {object.<string, DictGroup>} to
   */

  /**
   * Trie 樹。
   */
   class Trie {
    // 使用 Map 實作 Trie 樹
    // Trie 的每個節點為一個 Map 物件
    // key 為 code point，value 為子節點（也是一個 Map）。
    // 如果 Map 物件有 trie_val 屬性，則該屬性為值字串，代表替換的字詞。

    constructor() {
      this.map = new Map();
    }

    /**
     * 將一項資料加入字典樹
     * @param {string} s 要匹配的字串
     * @param {string} v 若匹配成功，則替換為此字串
     */
    addWord(s, v) {
      let { map } = this;
      for (const c of s) {
        const cp = c.codePointAt(0);
        const nextMap = map.get(cp);
        if (nextMap == null) {
          const tmp = new Map();
          map.set(cp, tmp);
          map = tmp;
        } else {
          map = nextMap;
        }
      }
      map.trie_val = v;
    }

    /**
       * 讀取字典資料
       * @param {DictLike} d 字典
       */
    loadDict(d) {
      if (typeof d === 'string') {
        d = d.split('|');
        for (const line of d) {
          const [l, r] = line.split(' ');
          this.addWord(l, r);
        }
      } else {
        for (let arr of d) {
          const [l, r] = arr;
          this.addWord(l, r);
        }
      }
    }

    /**
     * 讀取多個字典資料
     * @param {DictLike[]} arr 字典
     */
    loadDictGroup(arr) {
      arr.forEach(d => {
        this.loadDict(d);
      });
    }

    /**
     * 根據字典樹中的資料轉換字串。
     * @param {string} s 要轉換的字串
     */
    convert(s) {
      const t = this.map;
      const n = s.length, arr = [];
      let orig_i;
      for (let i = 0; i < n;) {
        let t_curr = t, k = 0, v;
        for (let j = i; j < n;) {
          const x = s.codePointAt(j);
          j += x > 0xffff ? 2 : 1;

          const t_next = t_curr.get(x);
          if (typeof t_next === 'undefined') {
            break;
          }
          t_curr = t_next;

          const v_curr = t_curr.trie_val;
          if (typeof v_curr !== 'undefined') {
            k = j;
            v = v_curr;
          }
        }
        if (k > 0) { // 有替代
          if (orig_i !== null) {
            arr.push(s.slice(orig_i, i));
            orig_i = null;
          }
          arr.push(v);
          i = k;
        } else { // 無替代
          if (orig_i === null) {
            orig_i = i;
          }
          i += s.codePointAt(i) > 0xffff ? 2 : 1;
        }
      }
      if (orig_i !== null) {
        arr.push(s.slice(orig_i, n));
      }
      return arr.join('');
    }
  }

  /**
   * Create a OpenCC converter
   * @param  {...DictGroup} dictGroup
   * @returns The converter that performs the conversion.
   */
  function ConverterFactory(...dictGroups) {
    const trieArr = dictGroups.map(grp => {
      const t = new Trie();
      t.loadDictGroup(grp);
      return t;
    });
    /**
     * The converter that performs the conversion.
     * @param {string} s The string to be converted.
     * @returns {string} The converted string.
     */
    function convert(s) {
      return trieArr.reduce((res, t) => {
        return t.convert(res);
      }, s);
    }
    return convert;
  }

  /**
   * Build Converter function with locale data
   * @param {LocalePreset} localePreset
   * @returns Converter function
   */
  function ConverterBuilder(localePreset) {
    return function Converter(options) {
      let dictGroups = [];
      ['from', 'to'].forEach(type => {
        if (typeof options[type] !== 'string') {
          throw new Error('Please provide the `' + type + '` option');
        }
        if (options[type] !== 't') {
          dictGroups.push(localePreset[type][options[type]]);
        }
      });
      return ConverterFactory.apply(null, dictGroups);
    }
  }

  /**
   * Create a custom converter.
   * @param {string[][]} dict The dictionary to be used for conversion.
   * @returns The converter that performs the conversion.
   */
  function CustomConverter(dict) {
    return ConverterFactory([dict]);
  }

  /**
   * Create a HTML page converter.
   * @param {(s: string) => string} converter The converter that performs the conversion.
   * @param {HTMLElement} rootNode The root node for recursive conversions.
   * @param {string} fromLangTag The lang tag to be converted.
   * @param {string} toLangTag The lang tag of the conversion result.
   * @returns The HTML page converter.
   */
  function HTMLConverter(converter, rootNode, fromLangTag, toLangTag) {
    /**
     * Perform the conversion on the page.
     */
    function convert() {
      function inner(currentNode, langMatched) {
        /* class list 包含 ignore-opencc 的元素會跳過後續的轉換 */
        if (currentNode.nodeType === Node.ELEMENT_NODE && currentNode.classList.contains('ignore-opencc')) return;

        if (currentNode.lang === fromLangTag) {
          langMatched = true;
          currentNode.shouldChangeLang = true; // 記住 lang 屬性被修改了，以便恢復
          currentNode.lang = toLangTag;
        } else if (currentNode.lang && currentNode.lang.length) {
          langMatched = false;
        }

        if (langMatched) {
          /* Do not convert these elements */
          if (currentNode.tagName === 'SCRIPT') return;
          if (currentNode.tagName === 'STYLE') return;

          /* 處理特殊屬性 */
          if (currentNode.tagName === 'META' && currentNode.name === 'description') {
            if (currentNode.originalContent == null) {
              currentNode.originalContent = currentNode.content;
            }
            currentNode.content = converter(currentNode.originalContent);
          } else if (currentNode.tagName === 'META' && currentNode.name === 'keywords') {
            if (currentNode.originalContent == null) {
              currentNode.originalContent = currentNode.content;
            }
            currentNode.content = converter(currentNode.originalContent);
          } else if (currentNode.tagName === 'IMG') {
            if (currentNode.originalAlt == null) {
              currentNode.originalAlt = currentNode.alt;
            }
            currentNode.alt = converter(currentNode.originalAlt);
          } else if (currentNode.tagName === 'INPUT' && currentNode.type === 'button') {
            if (currentNode.originalValue == null) {
              currentNode.originalValue = currentNode.value;
            }
            currentNode.value = converter(currentNode.originalValue);
          }
        }

        for (const node of currentNode.childNodes) {
          if (node.nodeType === Node.TEXT_NODE && langMatched) {
            if (node.originalString == null) {
              node.originalString = node.nodeValue; // 存儲原始字串，以便恢復
            }
            node.nodeValue = converter(node.originalString);
          } else {
            inner(node, langMatched);
          }
        }
      }
      inner(rootNode, false);
    }

    /**
     * Restore the page to the state before the conversion.
     */
    function restore() {
      function inner(currentNode) {
        /* class list 包含 ignore-opencc 的元素會跳過後續的轉換 */
        if (currentNode.nodeType === Node.ELEMENT_NODE && currentNode.classList.contains('ignore-opencc')) return;

        if (currentNode.shouldChangeLang) {
          currentNode.lang = fromLangTag;
        }

        if (currentNode.originalString !== undefined) {
          currentNode.nodeValue = currentNode.originalString;
        }

        /* 處理特殊屬性 */
        if (currentNode.tagName === 'META' && currentNode.name === 'description') {
          if (currentNode.originalContent !== undefined) {
            currentNode.content = currentNode.originalContent;
          }
        } else if (currentNode.tagName === 'META' && currentNode.name === 'keywords') {
          if (currentNode.originalContent !== undefined) {
            currentNode.content = currentNode.originalContent;
          }
        } else if (currentNode.tagName === 'IMG') {
          if (currentNode.originalAlt !== undefined) {
            currentNode.alt = currentNode.originalAlt;
          }
        } else if (currentNode.tagName === 'INPUT' && currentNode.type === 'button') {
          if (currentNode.originalValue !== undefined) {
            currentNode.value = currentNode.originalValue;
          }
        }

        for (const node of currentNode.childNodes) {
          inner(node);
        }
      }
      inner(rootNode);
    }

    return { convert, restore };
  }

  var HKVariantsRev = "偽 僞|兑 兌|卧 臥|叁 叄|台 臺|吃 喫|唇 脣|啟 啓|囱 囪|媪 媼|媯 嬀|悦 悅|愠 慍|户 戶|抬 擡|捝 挩|揾 搵|敍 敘|敚 敓|枱 檯|枴 柺|棁 梲|榅 榲|氲 氳|涚 涗|温 溫|溈 潙|潀 潨|濕 溼|灶 竈|為 爲|煴 熅|痴 癡|皂 皁|眾 衆|秘 祕|税 稅|稜 棱|粧 妝|粽 糉|糭 糉|緼 縕|缽 鉢|脱 脫|腽 膃|葱 蔥|蒀 蒕|蒍 蔿|藴 蘊|蜕 蛻|衞 衛|衹 只|説 說|踴 踊|輼 轀|醖 醞|針 鍼|鈎 鉤|鋭 銳|閲 閱|鰛 鰮";

  var HKVariantsRevPhrases = "一口吃個 一口喫個|一口吃成 一口喫成|一家三口 一家三口|一家五口 一家五口|一家六口 一家六口|一家四口 一家四口|七星巖 七星巖|世胄 世胄|介胄 介冑|傅巖 傅巖|免胄 免冑|冠胄 冠冑|千巖競秀 千巖競秀|千巖萬壑 千巖萬壑|千巖萬谷 千巖萬谷|口吃 口吃|台山 台山|台州 台州|台州地區 台州地區|台州市 台州市|吃口 喫口|吃口令 吃口令|吃口飯 喫口飯|吃吃 喫喫|吃子 喫子|名胄 名胄|國胄 國胄|圍巖 圍巖|地胄 地胄|壓胄子 壓冑子|士胄 士胄|大巖桐 大巖桐|天台女 天台女|天台宗 天台宗|天台山 天台山|天台縣 天台縣|天潢貴胄 天潢貴胄|奇巖 奇巖|寶胄 寶胄|小巖洞 小巖洞|岫巖縣 岫巖縣|峯巖 峯巖|嵌巖 嵌巖|巉巖 巉巖|巖壁 巖壁|巖居 巖居|巖居穴處 巖居穴處|巖居谷飲 巖居谷飲|巖岸 巖岸|巖巉 巖巉|巖巖 巖巖|巖徼 巖徼|巖手縣 巖手縣|巖村 巖村|巖洞 巖洞|巖流圈 巖流圈|巖牆 巖牆|巖牆之下 巖牆之下|巖畫 巖畫|巖穴 巖穴|巖穴之士 巖穴之士|巖薔薇 巖薔薇|巖邑 巖邑|巖郎 巖郎|巖阻 巖阻|巖陛 巖陛|帝胄 帝胄|幽巖 幽巖|幽棲巖谷 幽棲巖谷|張口 張口|懸巖 懸巖|懸巖峭壁 懸巖峭壁|懸胄 懸冑|攀巖 攀巖|支胄 支胄|教胄 教胄|景胄 景胄|望胄 望胄|末胄 末胄|村胄 村胄|枕巖漱流 枕巖漱流|枝胄 枝胄|氏胄 氏胄|洪胄 洪胄|浙江天台縣 浙江天台縣|清胄 清胄|灰巖殘丘 灰巖殘丘|玄胄 玄胄|甲胄 甲冑|甲胄魚類 甲冑魚類|皇胄 皇胄|石灰巖洞 石灰巖洞|神胄 神胄|簪纓世胄 簪纓世胄|系胄 系胄|紅巖 紅巖|絕巖 絕巖|緒胄 緒胄|纂胄 纂胄|胃口 胃口|胄嗣 胄嗣|胄子 胄子|胄序 胄序|胄族 胄族|胄甲 冑甲|胄監 胄監|胄科 冑科|胄緒 胄緒|胄胤 胄胤|胄裔 胄裔|胄裔繁衍 胄裔繁衍|胄閥 胄閥|胡雪巖 胡雪巖|胤胄 胤胄|苗胄 苗胄|英胄 英胄|華胄 華胄|血胄 血胄|裔胄 裔胄|訓胄 訓胄|試胄 試胄|豪門貴胄 豪門貴胄|貝胄 貝冑|貴胄 貴胄|賢胄 賢胄|蹇吃 蹇吃|躬擐甲胄 躬擐甲冑|遐胄 遐胄|遙胄 遙胄|遙遙華胄 遙遙華胄|遠胄 遠胄|遺胄 遺胄|鄧艾吃 鄧艾吃|重巖疊嶂 重巖疊嶂|金胄 金胄|鎧胄 鎧冑|鑿巖 鑿巖|門胄 門胄|開口 開口|雲巖區 雲巖區|非層巖 非層巖|韓侂胄 韓侂冑|飮胄 飮冑|骨巖巖 骨巖巖|高胄 高胄|魚胄 魚冑|鮮胄 鮮胄|鴻胄 鴻胄|黃巖區 黃巖區|黃巖島 黃巖島|黃炎貴胄 黃炎貴胄|齒胄 齒胄|龍巖 龍巖|龍巖市 龍巖市|龍巖村 龍巖村|龍胄 龍胄";

  var from_hk = [HKVariantsRev, HKVariantsRevPhrases];

  var TWVariantsRev = "偽 僞|參 蔘|吃 喫|唇 脣|啟 啓|媯 嬀|嫻 嫺|峰 峯|床 牀|抬 擡|汙 污|洩 泄|溈 潙|潀 潨|灶 竈|為 爲|痴 癡|痺 痹|皂 皁|眾 衆|睪 睾|秘 祕|稜 棱|簷 檐|粽 糉|缽 鉢|群 羣|著 着|蒍 蔿|裡 裏|踴 踊|韁 繮|顎 齶|鯰 鮎|麵 麪";

  var TWVariantsRevPhrases = "一口吃個 一口喫個|一口吃成 一口喫成|一家三口 一家三口|一家五口 一家五口|一家六口 一家六口|一家四口 一家四口|凶事 凶事|凶信 凶信|凶兆 凶兆|凶吉 凶吉|凶地 凶地|凶多吉少 凶多吉少|凶宅 凶宅|凶年 凶年|凶德 凶德|凶怪 凶怪|凶日 凶日|凶服 凶服|凶歲 凶歲|凶死 凶死|凶氣 凶氣|凶煞 凶煞|凶燄 凶燄|凶神 凶神|凶禮 凶禮|凶耗 凶耗|凶肆 凶肆|凶荒 凶荒|凶訊 凶訊|凶豎 凶豎|凶身 凶身|凶逆 凶逆|凶門 凶門|口吃 口吃|吃口 喫口|吃口令 吃口令|吃口飯 喫口飯|吃吃 喫喫|吃子 喫子|合著 合著|吉凶 吉凶|名著 名著|四凶 四凶|大凶 大凶|巨著 巨著|張口 張口|昭著 昭著|歲凶 歲凶|胃口 胃口|著作 著作|著名 著名|著式 著式|著志 著志|著於 著於|著書 著書|著白 著白|著稱 著稱|著者 著者|著述 著述|著錄 著錄|蹇吃 蹇吃|逢凶 逢凶|避凶 避凶|鄧艾吃 鄧艾吃|鉅著 鉅著|開口 開口|閔凶 閔凶|顯著 顯著";

  var from_tw = [TWVariantsRev, TWVariantsRevPhrases];

  var TWPhrasesRev = "PN接面 PN結|SQL隱碼攻擊 SQL注入|三極體 三極管|下拉選單 下拉列表|丟擲 拋出|中介軟體 中間件|串列埠 串口|主機板 主板|主開機記錄 主引導記錄|乙太網 以太網|乳酪 奶酪|二極體 二極管|互動 交互|互動式 交互式|亞塞拜然 阿塞拜疆|人工智慧 人工智能|介面 接口|介面卡 適配器|代碼 代碼|伺服器 服務器|佇列 隊列|位元 比特|位元率 比特率|位元組 字節|位元速率 碼率|位址 地址|位址列 地址欄|低級 低級|低階 低級|作業系統 操作系統|使用者 用戶|使用者名稱 用戶名|來電轉駁 呼叫轉移|例項 實例|信號 信號|偵錯 調試|偵錯程式 調試器|傅立葉 傅里葉|傳送 發送|傷心小棧 紅心大戰|價效比 性價比|優先順序 優先級|儲存 保存|元件 組件|光碟 光盤|光碟機 光驅|克羅埃西亞 克羅地亞|入口網站 門戶網站|內建 內置|內碼表 代碼頁|全域性 全局|全形 全角|全球資訊網 萬維網|冰棒 冰棍|冷盤 涼菜|函式 函數|函數語言程式設計 函數式編程|刀鋒伺服器 刀片服務器|分割槽 分區|分散式 分佈式|分時多工 時分複用|分時多重進接 時分多址|分碼多重進接 碼分多址|分空間多重進接 空分多址|分頻多工 頻分複用|分頻多重進接 頻分多址|列印 打印|列支敦斯登 列支敦士登|列舉 枚舉|前處理器 預處理器|剪下 剪切|剪貼簿 剪貼板|副檔名 擴展名|加彭 加蓬|匯入 導入|匯出 導出|匯流排 總線|區域性 局部|區域網 局域網|千里達及托巴哥 特立尼達和多巴哥|半形 半角|卡達 卡塔爾|印表機 打印機|厄利垂亞 厄立特里亞|厄瓜多 厄瓜多爾|原始檔 源文件|原始碼 原代碼|原生代碼 本地代碼|參數列 參數表|取樣 採樣|取樣率 採樣率|叢集 集羣|史瓦濟蘭 斯威士蘭|吉布地 吉布堤|吉里巴斯 基里巴斯|名稱空間 命名空間|吐瓦魯 圖瓦盧|向量 矢量|呼叫 調用|命令列 命令行|咖哩 咖喱|哈薩克 哈薩克斯坦|哥斯大黎加 哥斯達黎加|啟用 激活|喫茶小舖 喫茶小舖|喬治亞 格魯吉亞|單核心 宏內核|回撥 回調|圖示 圖標|土庫曼 土庫曼斯坦|地址 地址|坦尚尼亞 坦桑尼亞|型別 類型|埠 端口|執行 運行|執行緒 線程|執行長 首席執行官|堆疊 堆棧|場效電晶體 場效應管|塑膠 塑料|塔吉克 塔吉克斯坦|塞席爾 塞舌爾|塞普勒斯 塞浦路斯|壁紙 壁紙|夏農 香農|外來鍵 外鍵|外掛 插件|外接 外置|多型 多態|多執行緒 多線程|多工 多任務|多明尼加 多米尼加|太空梭 航天飛機|奈及利亞 尼日利亞|奈米 納米|子音 輔音|字串 字符串|字元 字符|字型 字體|字型檔 字庫|字尾 後綴|字符集 字符集|字首 前綴|存取 訪問|存檔 存盤|安地卡及巴布達 安提瓜和巴布達|宏都拉斯 洪都拉斯|宕機 死機|定址 尋址|宣告 聲明|實例 實例|實體地址 物理地址|實體記憶體 物理內存|寬頻 寬帶|寮國 老撾|專案 項目|對映 映射|對話方塊 對話框|對象 對象|尚比亞 贊比亞|尤拉 歐拉|尼日 尼日爾|巢狀 嵌套|工作列 任務欄|工作管理員 任務管理器|巨集 宏|巴布亞紐幾內亞 巴布亞新幾內亞|巴貝多 巴巴多斯|布吉納法索 布基納法索|布林 布爾|帛琉 帕勞|平行計算 並行計算|幾內亞比索 幾內亞比紹|序列 串行|序號產生器 註冊機|建構函式 構造函數|建立 創建|引數 參數|彙編 彙編|影印 複印|影片 視頻|影象 圖像|後設資料 元數據|循環 循環|微控制器 單片機|快取 緩存|快取記憶體 高速緩存|快捷半導體 仙童半導體|快閃記憶體 閃存|感測 傳感|截圖 截屏|打開 打開|批次 批量|技術長 首席技術官|指令式程式設計 命令式編程|指令碼 腳本|指標 指針|捲軸 滾動條|掃描器 掃描儀|排程 調度|控制代碼 句柄|控制元件 控件|搜尋 搜索|摺積 捲積|撥出 呼出|擴充套件 擴展|擴音 免提|擷取 截取|攜帶型 便攜式|支持者 支持者|支援 支持|效能 性能|整合 集成|數位 數字|數位印刷 數字印刷|數位電子 數字電子|數位電路 數字電路|數字 數字|數據機 調製解調器|文件 文檔|文字 文本|文書處理 文字處理|斯洛維尼亞 斯洛文尼亞|新增 添加|映象 鏡像|映象管 顯像管|時脈頻率 時鐘頻率|晶片 芯片|智慧 智能|智慧財產權 知識產權|暫存器 寄存器|最佳化 優化|有失真壓縮 有損壓縮|李彥宏 李彥宏|查德 乍得|查詢 查找|核心 內核|格瑞那達 格林納達|桌上型 桌面型|桌上型電腦 臺式機|桌布 壁紙|標頭檔案 頭文件|模擬 仿真|模組 模塊|模里西斯 毛里求斯|機率 幾率|檔名 文件名|檔案 文件|檢視 查看|欄位 字段|正規化 範式|正規表示式 正則表達式|母音 元音|比特幣 比特幣|氣泡排序 冒泡排序|永珍 萬象|永續性 持久性|汶萊 文萊|沙烏地阿拉伯 沙特阿拉伯|泡麵 方便麪|波士尼亞赫塞哥維納 波斯尼亞黑塞哥維那|波札那 博茨瓦納|波長分波多工 波分複用|海內存知己 海內存知己|消息 消息|游標 光標|溢位 溢出|滑鼠 鼠標|演算法 算法|烏茲別克 烏茲別克斯坦|無失真壓縮 無損壓縮|燒錄 刻錄|營運長 首席運營官|片語 詞組|物件 對象|物件導向 面向對象|狀態列 狀態欄|獅子山 塞拉利昂|瓜地馬拉 危地馬拉|甘比亞 岡比亞|畫素 像素|登入 登錄|登出 註銷|登錄檔 註冊表|盧安達 盧旺達|目的碼 目標代碼|直譯器 解釋器|相容 兼容|相簿 圖庫|真實模式 實模式|矽 硅|砈 砹|破圖 花屏|硬碟 硬盤|硬體 硬件|碟片 盤片|磁碟 磁盤|磁碟機代號 盤符|磁軌 磁道|社區 社區|社羣 社區|程序 進程|程序不正義 程序不正義|程序導向 面向過程|程序式程式設計 過程式編程|程序正義 程序正義|程式 程序|程式碼 代碼|程式設計 編程|程式設計師 程序員|程式語言 編程語言|稽覈 審覈|積體電路 集成電路|空氣清淨機 空氣淨化器|空間多工 空分複用|突尼西亞 突尼斯|簡報 演示文稿|簡訊 短信|簽帳金融卡 借記卡|粘貼 粘貼|紐西蘭 新西蘭|純喫茶 純喫茶|索羅門羣島 所羅門羣島|索馬利亞 索馬里|終端使用者 最終用戶|組合語言 彙編語言|組譯 彙編|結束通話 掛斷|維德角 佛得角|網咖 網吧|網絡卡 網卡|網路 網絡|網路上的芳鄰 網上鄰居|網際網路 互聯網|線上 在線|縮圖 縮略圖|縮排 縮進|繫結 綁定|義大利 意大利|聖克里斯多福及尼維斯 聖基茨和尼維斯|聖文森及格瑞那丁 聖文森特和格林納丁斯|聖露西亞 聖盧西亞|聖馬利諾 聖馬力諾|聯結器 連接器|聯絡 聯繫|肯亞 肯尼亞|腳踏車 自行車|膝上型電腦 筆記本電腦|自動旋轉螢幕 自動轉屏|茅利塔尼亞 毛里塔尼亞|莫三比克 莫桑比克|菜單 菜單|萬用字元 通配符|萬那杜 瓦努阿圖|葉門 也門|葛摩 科摩羅|蒲隆地 布隆迪|蓋亞那 圭亞那|藍色畫面 藍屏|藍芽 藍牙|蘇利南 蘇里南|虛擬函式 虛函數|虛擬機器 虛擬機|虛擬碼 僞代碼|螢幕 屏幕|行內函數 內聯函數|行動式 便攜式|行動硬碟 移動硬盤|行動網路 移動網絡|行動資料 移動資料|行動通訊 移動通信|行動電話 移動電話|衣索比亞 埃塞俄比亞|表示式 表達式|裝置 設備|複製 拷貝|覈取按鈕 複選按鈕|覈取方塊 複選框|視窗 窗口|視覺化 可視化|視訊 視頻|視訊會議 視頻會議|視訊記憶體 顯存|視訊通話 視頻通話|解析度 分辨率|解構函式 析構函數|解除安裝 卸載|觸控 觸摸|觸控式螢幕 觸摸屏|計程車 出租車|訊息 消息|訊號 信號|訊雜比 信噪比|記憶體 內存|訪問 訪問|設定 設置|許可權 權限|調色盤 調色板|調變 調制|諾魯 瑙魯|識別符號 標識符|變數 變量|象牙海岸 科特迪瓦|貝南 貝寧|貝里斯 伯利茲|貼上 粘貼|資料 數據|資料來源 數據源|資料倉儲 數據倉庫|資料包 數據報|資料夾 文件夾|資料庫 數據庫|資料探勘 數據挖掘|資訊 信息|資訊保安 信息安全|資訊理論 信息論|資訊科技 信息技術|資訊長 首席信息官|賓士 奔馳|賴比瑞亞 利比里亞|賴索托 萊索托|超程式設計 元編程|跳脫字元 轉義字符|軟碟機 軟驅|軟體 軟件|載入 加載|載入程式 引導程序|辛巴威 津巴布韋|迦納 加納|迴圈 循環|透過 通過|通訊 通信|通話卡 通訊卡|通話記錄 聯繫歷史|通過 通過|通道 信道|速食麵 方便麪|連結 鏈接|連結串列 鏈表|連線 連接|進位制 進制|進程 進程|進階 高端|運算元 操作數|運算子 操作符|運算式 表達式|過載 重載|遞迴 遞歸|遠端 遠程|遮蔽 屏蔽|選單 菜單|邏輯閘 邏輯門|那杜 溫納圖萬|部落格 博客|都會網路 城域網|醯 酰|釋出 發佈|重新命名 重命名|重新整理 刷新|重灌 重裝|金氧半導體 金屬氧化物半導體|金鑰 密鑰|鈽 鈈|鉲 鐦|鉳 錇|鋂 鎇|錄影 錄像|錼 鎿|鍅 鈁|鎝 鍀|鎦 鑥|鐳射 激光|鑀 鎄|開啟 打開|閘流體 晶閘管|閘道器 網關|閘電路 門電路|關聯式資料庫 關係數據庫|防寫 寫保護|防毒 殺毒|阿拉伯聯合大公國 阿拉伯聯合酋長國|陣列 數組|除錯 調試|隨身碟 U盤|雜湊 哈希|離線 脫機|雲端儲存 雲存儲|雲端計算 雲計算|電晶體 晶體管|電腦保安 計算機安全|電腦科學 計算機科學|非同步 異步|韌體 固件|音效卡 聲卡|音訊 音頻|頁尾 頁腳|頁首 頁眉|預設 缺省|預設值 默認值|頻寬 帶寬|類别範本 類模板|類比 模擬|類比電子 模擬電子|類比電路 模擬電路|顯示卡 顯卡|飛航模式 飛行模式|馬利共和國 馬里共和國|馬爾地夫 馬爾代夫|駭客 黑客|高效能運算 高性能計算|高畫質 高清|高空彈跳 蹦極|高級 高級|高階 高端|黃宏 黃宏|點選 點擊|點陣圖 位圖";

  var from_twp = [TWVariantsRev, TWVariantsRevPhrases, TWPhrasesRev];

  var JPVariantsRev = "万 萬|与 與|両 兩|乗 乘|乱 亂|亀 龜|争 爭|亘 亙|亜 亞|仏 佛|仮 假|会 會|伝 傳|体 體|価 價|倹 儉|偽 僞|児 兒|党 黨|内 內|円 圓|写 寫|処 處|刹 剎|剣 劍|剤 劑|剰 剩|励 勵|労 勞|効 效|勅 敕|勧 勸|勲 勳|匀 勻|区 區|医 醫|単 單|却 卻|厠 廁|厳 嚴|参 參|双 雙|収 收|叙 敘|号 號|呉 吳|呪 咒|唇 脣|唖 啞|営 營|嘘 噓|嘱 囑|噛 嚙|団 團|囲 圍|図 圖|国 國|圏 圈|圧 壓|堕 墮|塁 壘|塩 鹽|増 增|壊 壞|壌 壤|壮 壯|声 聲|壱 壹|売 賣|変 變|奥 奧|奨 奬|嬢 孃|学 學|宝 寶|実 實|寛 寬|寝 寢|対 對|寿 壽|専 專|将 將|尽 盡|届 屆|属 屬|岳 嶽|峡 峽|峰 峯|巌 巖|巣 巢|巻 卷|帯 帶|帰 歸|庁 廳|広 廣|床 牀|廃 廢|弁 瓣|弐 貳|弥 彌|弯 彎|弾 彈|当 當|彦 彥|径 徑|従 從|御 禦|徳 德|徴 徵|応 應|恋 戀|恒 恆|恵 惠|悦 悅|悩 惱|悪 惡|惨 慘|懐 懷|戦 戰|戯 戲|戸 戶|戻 戾|払 拂|抜 拔|択 擇|担 擔|拝 拜|拠 據|拡 擴|挙 舉|挟 挾|挿 插|捜 搜|掲 揭|掴 摑|掻 搔|揺 搖|摂 攝|撃 擊|撹 攪|数 數|斉 齊|斎 齋|断 斷|旧 舊|昼 晝|晋 晉|晩 晚|暁 曉|暦 曆|曁 暨|曽 曾|条 條|来 來|枢 樞|査 查|栄 榮|桜 櫻|桝 枡|桟 棧|検 檢|楡 榆|楼 樓|楽 樂|様 樣|権 權|横 橫|欧 歐|歓 歡|歩 步|歯 齒|歳 歲|歴 歷|残 殘|殴 毆|殻 殼|毎 每|気 氣|汚 污|没 沒|沢 澤|沪 濾|浄 淨|浅 淺|浜 濱|涙 淚|涛 濤|渇 渴|済 濟|渉 涉|渋 澀|渓 溪|温 溫|湾 灣|湿 溼|満 滿|溌 潑|滝 瀧|滞 滯|潜 潛|瀬 瀨|灯 燈|炉 爐|点 點|為 爲|焔 焰|焼 燒|煙 菸|犠 犧|状 狀|独 獨|狭 狹|猟 獵|猫 貓|献 獻|獣 獸|産 產|画 畫|畳 疊|疏 疎|痩 瘦|痴 癡|痺 痹|発 發|皐 皋|盗 盜|県 縣|砕 碎|礼 禮|祷 禱|禄 祿|禅 禪|秘 祕|称 稱|税 稅|稜 棱|稲 稻|穂 穗|穏 穩|穣 穰|窃 竊|竃 竈|竜 龍|粋 粹|粛 肅|粧 妝|粽 糉|経 經|絵 繪|絶 絕|継 繼|続 續|総 總|緑 綠|緒 緖|縁 緣|縄 繩|縦 縱|繊 纖|繋 繫|繍 繡|群 羣|聡 聰|聴 聽|胆 膽|脚 腳|脱 脫|脳 腦|臓 臟|舎 舍|舗 鋪|芦 蘆|芸 藝|茎 莖|茘 荔|荘 莊|莱 萊|葱 蔥|蒋 蔣|蔵 藏|薫 薰|薬 藥|虚 虛|虫 蟲|蚕 蠶|蛍 螢|蛮 蠻|蝋 蠟|装 裝|覇 霸|覚 覺|覧 覽|観 觀|触 觸|訳 譯|証 證|誉 譽|説 說|読 讀|謡 謠|譲 讓|豊 豐|賛 贊|贋 贗|践 踐|転 轉|軽 輕|輌 輛|辞 辭|辺 邊|逓 遞|遅 遲|遙 遥|郷 鄉|酔 醉|醋 酢|醗 醱|醤 醬|醸 釀|釈 釋|鉄 鐵|鉱 鑛|銭 錢|鋳 鑄|錬 鍊|録 錄|関 關|閲 閱|闘 鬥|陥 陷|険 險|随 隨|隠 隱|雑 雜|霊 靈|静 靜|頴 穎|頼 賴|顔 顏|顕 顯|駅 驛|駆 驅|騒 騷|験 驗|髄 髓|髪 髮|鴎 鷗|鶏 雞|鹸 鹼|麦 麥|麹 麴|麺 麪|黄 黃|黒 黑|黙 默|鼈 鱉|齢 齡";

  var JPShinjitaiCharacters = "両 兩|弁 辨|欠 缺|糸 絲|芸 藝|浜 濱";

  var JPShinjitaiPhrases = "一獲千金 一攫千金|丁寧 叮嚀|丁重 鄭重|三差路 三叉路|世論 輿論|亜鈴 啞鈴|交差 交叉|供宴 饗宴|俊馬 駿馬|保塁 堡壘|個条書 箇条書|偏平 扁平|停泊 碇泊|優俊 優駿|先兵 尖兵|先鋭 尖鋭|共役 共軛|冗舌 饒舌|凶器 兇器|削岩 鑿岩|包丁 庖丁|包帯 繃帯|区画 區劃|厳然 儼然|友宜 友誼|反乱 叛乱|収集 蒐集|叙情 抒情|台頭 擡頭|合弁 合辦|喜遊曲 嬉遊曲|嘆願 歎願|回転 廻転|回遊 回游|奉持 捧持|委縮 萎縮|展転 輾轉|希少 稀少|幻惑 眩惑|広範 廣汎|広野 曠野|廃虚 廢墟|建坪率 建蔽率|弁当 辨當|弁膜 瓣膜|弁護 辯護|弁髪 辮髮|弦歌 絃歌|恩義 恩誼|意向 意嚮|慰謝料 慰藉料|憶断 臆断|憶病 臆病|戦没 戰歿|扇情 煽情|手帳 手帖|技量 伎倆|抜粋 抜萃|披歴 披瀝|抵触 牴触|抽選 抽籤|拘引 勾引|拠出 醵出|拠金 醵金|掘削 掘鑿|控除 扣除|援護 掩護|放棄 抛棄|散水 撒水|敬謙 敬虔|敷延 敷衍|断固 断乎|族生 簇生|昇叙 陞敘|暖房 煖房|暗唱 暗誦|暗夜 闇夜|暴露 曝露|枯渇 涸渇|格好 恰好|格幅 恰幅|棄損 毀損|模索 摸索|橋頭保 橋頭堡|欠缺 欠缺|死体 屍體|殿部 臀部|母指 拇指|気迫 気魄|決別 訣別|決壊 決潰|沈殿 沈澱|油送船 油槽船|波乱 波瀾|注釈 註釋|洗浄 洗滌|活発 活潑|浸透 滲透|浸食 浸蝕|消却 銷卻|混然 渾然|湾曲 彎曲|溶接 熔接|漁労 漁撈|漂然 飄然|激高 激昂|火炎 火焰|焦燥 焦躁|班点 斑点|留飲 溜飲|略奪 掠奪|疎通 疏通|発酵 醱酵|白亜 白堊|相克 相剋|知恵 智慧|破棄 破毀|確固 確乎|禁固 禁錮|符丁 符牒|粉装 扮装|紫班 紫斑|終息 終熄|総合 綜合|編集 編輯|義援 義捐|耕運機 耕耘機|肝心 肝腎|肩甲骨 肩胛骨|背徳 悖德|脈拍 脈搏|膨張 膨脹|芳純 芳醇|英知 叡智|蒸留 蒸溜|薫蒸 燻蒸|薫製 燻製|衣装 衣裳|衰退 衰退|裕然 悠然|補佐 輔佐|訓戒 訓誡|試練 試煉|詭弁 詭辯|講和 媾和|象眼 象嵌|貫録 貫禄|買弁 買辦|賛辞 讚辭|踏襲 蹈襲|車両 車輛|転倒 顛倒|輪郭 輪廓|退色 褪色|途絶 杜絶|連係 連繫|連合 聯合|選考 銓衡|酢酸 醋酸|野卑 野鄙|鉱石 礦石|間欠 間歇|関数 函數|防御 防禦|険阻 嶮岨|障壁 牆壁|障害 障礙|隠滅 湮滅|集落 聚落|雇用 雇傭|風諭 諷喩|飛語 蜚語|香典 香奠|骨格 骨骼|高進 亢進|鳥観 鳥瞰";

  var from_jp = [JPVariantsRev, JPShinjitaiCharacters, JPShinjitaiPhrases];

  var TSCharacters = "㑮 𫝈|㑯 㑔|㑳 㑇|㑶 㐹|㒓 𠉂|㓄 𪠟|㓨 刾|㔋 𪟎|㖮 𪠵|㗲 𠵾|㗿 𪡛|㘉 𠰱|㘓 𪢌|㘔 𫬐|㘚 㘎|㛝 𫝦|㜄 㚯|㜏 㛣|㜐 𫝧|㜗 𡞋|㜢 𡞱|㜷 𡝠|㞞 𪨊|㟺 𪩇|㠏 㟆|㠣 𫵷|㢗 𪪑|㢝 𢋈|㥮 㤘|㦎 𢛯|㦛 𢗓|㦞 𪫷|㨻 𪮃|㩋 𪮋|㩜 㨫|㩳 㧐|㩵 擜|㪎 𪯋|㯤 𣘐|㰙 𣗙|㵗 𣳆|㵾 𪷍|㶆 𫞛|㷍 𤆢|㷿 𤈷|㸇 𤎺|㹽 𫞣|㺏 𤠋|㺜 𪺻|㻶 𪼋|㿖 𪽮|㿗 𤻊|㿧 𤽯|䀉 𥁢|䀹 𥅴|䁪 𥇢|䁻 䀥|䂎 𥎝|䃮 鿎|䅐 𫀨|䅳 𫀬|䆉 𫁂|䉑 𫁲|䉙 𥬀|䉬 𫂈|䉲 𥮜|䉶 𫁷|䊭 𥺅|䊷 䌶|䊺 𫄚|䋃 𫄜|䋔 𫄞|䋙 䌺|䋚 䌻|䋦 𫄩|䋹 䌿|䋻 䌾|䋼 𫄮|䋿 𦈓|䌈 𦈖|䌋 𦈘|䌖 𦈜|䌝 𦈟|䌟 𦈞|䌥 𦈠|䌰 𦈙|䍤 𫅅|䍦 䍠|䍽 𦍠|䎙 𫅭|䎱 䎬|䓣 𬜯|䕤 𫟕|䕳 𦰴|䖅 𫟑|䗅 𫊪|䗿 𧉞|䙔 𫋲|䙡 䙌|䙱 𧜭|䚩 𫌯|䛄 𫍠|䛳 𫍫|䜀 䜧|䜖 𫟢|䝭 𫎧|䝻 𧹕|䝼 䞍|䞈 𧹑|䞋 𫎪|䞓 𫎭|䟃 𫎺|䟆 𫎳|䟐 𫎱|䠆 𫏃|䠱 𨅛|䡐 𫟤|䡩 𫟥|䡵 𫟦|䢨 𨑹|䤤 𫟺|䥄 𫠀|䥇 䦂|䥑 鿏|䥕 𬭯|䥗 𫔋|䥩 𨱖|䥯 𫔆|䥱 䥾|䦘 𨸄|䦛 䦶|䦟 䦷|䦯 𫔵|䦳 𨷿|䧢 𨸟|䪊 𫖅|䪏 𩏼|䪗 𩐀|䪘 𩏿|䪴 𫖫|䪾 𫖬|䫀 𫖱|䫂 𫖰|䫟 𫖲|䫴 𩖗|䫶 𫖺|䫻 𫗇|䫾 𫠈|䬓 𫗊|䬘 𩙮|䬝 𩙯|䬞 𩙧|䬧 𫗟|䭀 𩠇|䭃 𩠈|䭑 𫗱|䭔 𫗰|䭿 𩧭|䮄 𫠊|䮝 𩧰|䮞 𩨁|䮠 𩧿|䮫 𩨇|䮰 𫘮|䮳 𩨏|䮾 𩧪|䯀 䯅|䯤 𩩈|䰾 鲃|䱀 𫚐|䱁 𫚏|䱙 𩾈|䱧 𫚠|䱬 𩾊|䱰 𩾋|䱷 䲣|䱸 𫠑|䱽 䲝|䲁 鳚|䲅 𫚜|䲖 𩾂|䲘 鳤|䲰 𪉂|䳜 𫛬|䳢 𫛰|䳤 𫛮|䳧 𫛺|䳫 𫛼|䴉 鹮|䴋 𫜅|䴬 𪎈|䴱 𫜒|䴴 𪎋|䴽 𫜔|䵳 𪑅|䵴 𫜙|䶕 𫜨|䶲 𫜳|丟 丢|並 并|乾 干|亂 乱|亙 亘|亞 亚|佇 伫|佈 布|佔 占|併 并|來 来|侖 仑|侶 侣|侷 局|俁 俣|係 系|俓 𠇹|俔 伣|俠 侠|俥 伡|俬 私|倀 伥|倆 俩|倈 俫|倉 仓|個 个|們 们|倖 幸|倫 伦|倲 㑈|偉 伟|偑 㐽|側 侧|偵 侦|偽 伪|傌 㐷|傑 杰|傖 伧|傘 伞|備 备|傢 家|傭 佣|傯 偬|傳 传|傴 伛|債 债|傷 伤|傾 倾|僂 偻|僅 仅|僉 佥|僑 侨|僕 仆|僞 伪|僤 𫢸|僥 侥|僨 偾|僱 雇|價 价|儀 仪|儁 俊|儂 侬|億 亿|儈 侩|儉 俭|儎 傤|儐 傧|儔 俦|儕 侪|儘 尽|償 偿|儣 𠆲|優 优|儭 𠋆|儲 储|儷 俪|儸 㑩|儺 傩|儻 傥|儼 俨|兇 凶|兌 兑|兒 儿|兗 兖|內 内|兩 两|冊 册|冑 胄|冪 幂|凈 净|凍 冻|凙 𪞝|凜 凛|凱 凯|別 别|刪 删|剄 刭|則 则|剋 克|剎 刹|剗 刬|剛 刚|剝 剥|剮 剐|剴 剀|創 创|剷 铲|剾 𠛅|劃 划|劇 剧|劉 刘|劊 刽|劌 刿|劍 剑|劏 㓥|劑 剂|劚 㔉|勁 劲|勑 𠡠|動 动|務 务|勛 勋|勝 胜|勞 劳|勢 势|勣 𪟝|勩 勚|勱 劢|勳 勋|勵 励|勸 劝|勻 匀|匭 匦|匯 汇|匱 匮|區 区|協 协|卹 恤|卻 却|卽 即|厙 厍|厠 厕|厤 历|厭 厌|厲 厉|厴 厣|參 参|叄 叁|叢 丛|吒 咤|吳 吴|吶 呐|呂 吕|咼 呙|員 员|哯 𠯟|唄 呗|唓 𪠳|唸 念|問 问|啓 启|啞 哑|啟 启|啢 唡|喎 㖞|喚 唤|喪 丧|喫 吃|喬 乔|單 单|喲 哟|嗆 呛|嗇 啬|嗊 唝|嗎 吗|嗚 呜|嗩 唢|嗰 𠮶|嗶 哔|嗹 𪡏|嘆 叹|嘍 喽|嘓 啯|嘔 呕|嘖 啧|嘗 尝|嘜 唛|嘩 哗|嘪 𪡃|嘮 唠|嘯 啸|嘰 叽|嘳 𪡞|嘵 哓|嘸 呒|嘺 𪡀|嘽 啴|噁 恶|噅 𠯠|噓 嘘|噚 㖊|噝 咝|噞 𪡋|噠 哒|噥 哝|噦 哕|噯 嗳|噲 哙|噴 喷|噸 吨|噹 当|嚀 咛|嚇 吓|嚌 哜|嚐 尝|嚕 噜|嚙 啮|嚛 𪠸|嚥 咽|嚦 呖|嚧 𠰷|嚨 咙|嚮 向|嚲 亸|嚳 喾|嚴 严|嚶 嘤|嚽 𪢕|囀 啭|囁 嗫|囂 嚣|囃 𠱞|囅 冁|囈 呓|囉 啰|囌 苏|囑 嘱|囒 𪢠|囪 囱|圇 囵|國 国|圍 围|園 园|圓 圆|圖 图|團 团|圞 𪢮|垻 坝|埡 垭|埨 𫭢|埬 𪣆|埰 采|執 执|堅 坚|堊 垩|堖 垴|堚 𪣒|堝 埚|堯 尧|報 报|場 场|塊 块|塋 茔|塏 垲|塒 埘|塗 涂|塚 冢|塢 坞|塤 埙|塵 尘|塸 𫭟|塹 堑|塿 𪣻|墊 垫|墜 坠|墠 𫮃|墮 堕|墰 坛|墲 𪢸|墳 坟|墶 垯|墻 墙|墾 垦|壇 坛|壈 𡒄|壋 垱|壎 埙|壓 压|壗 𡋤|壘 垒|壙 圹|壚 垆|壜 坛|壞 坏|壟 垄|壠 垅|壢 坜|壣 𪤚|壩 坝|壪 塆|壯 壮|壺 壶|壼 壸|壽 寿|夠 够|夢 梦|夥 伙|夾 夹|奐 奂|奧 奥|奩 奁|奪 夺|奬 奖|奮 奋|奼 姹|妝 妆|姍 姗|姦 奸|娙 𫰛|娛 娱|婁 娄|婡 𫝫|婦 妇|婭 娅|媈 𫝨|媧 娲|媯 妫|媰 㛀|媼 媪|媽 妈|嫋 袅|嫗 妪|嫵 妩|嫺 娴|嫻 娴|嫿 婳|嬀 妫|嬃 媭|嬇 𫝬|嬈 娆|嬋 婵|嬌 娇|嬙 嫱|嬡 嫒|嬣 𪥰|嬤 嬷|嬦 𫝩|嬪 嫔|嬰 婴|嬸 婶|嬻 𪥿|孃 娘|孄 𫝮|孆 𫝭|孇 𪥫|孋 㛤|孌 娈|孎 𡠟|孫 孙|學 学|孻 𡥧|孾 𪧀|孿 孪|宮 宫|寀 采|寠 𪧘|寢 寝|實 实|寧 宁|審 审|寫 写|寬 宽|寵 宠|寶 宝|將 将|專 专|尋 寻|對 对|導 导|尷 尴|屆 届|屍 尸|屓 屃|屜 屉|屢 屡|層 层|屨 屦|屩 𪨗|屬 属|岡 冈|峯 峰|峴 岘|島 岛|峽 峡|崍 崃|崑 昆|崗 岗|崙 仑|崢 峥|崬 岽|嵐 岚|嵗 岁|嵼 𡶴|嵽 𫶇|嵾 㟥|嶁 嵝|嶄 崭|嶇 岖|嶈 𡺃|嶔 嵚|嶗 崂|嶘 𡺄|嶠 峤|嶢 峣|嶧 峄|嶨 峃|嶮 崄|嶸 嵘|嶹 𫝵|嶺 岭|嶼 屿|嶽 岳|巊 𪩎|巋 岿|巒 峦|巔 巅|巖 岩|巗 𪨷|巘 𪩘|巰 巯|巹 卺|帥 帅|師 师|帳 帐|帶 带|幀 帧|幃 帏|幓 㡎|幗 帼|幘 帻|幝 𪩷|幟 帜|幣 币|幩 𪩸|幫 帮|幬 帱|幹 干|幾 几|庫 库|廁 厕|廂 厢|廄 厩|廈 厦|廎 庼|廕 荫|廚 厨|廝 厮|廞 𫷷|廟 庙|廠 厂|廡 庑|廢 废|廣 广|廧 𪪞|廩 廪|廬 庐|廳 厅|弒 弑|弔 吊|弳 弪|張 张|強 强|彃 𪪼|彄 𫸩|彆 别|彈 弹|彌 弥|彎 弯|彔 录|彙 汇|彠 彟|彥 彦|彫 雕|彲 彨|彿 佛|後 后|徑 径|從 从|徠 徕|復 复|徵 征|徹 彻|徿 𪫌|恆 恒|恥 耻|悅 悦|悞 悮|悵 怅|悶 闷|悽 凄|惡 恶|惱 恼|惲 恽|惻 恻|愛 爱|愜 惬|愨 悫|愴 怆|愷 恺|愻 𢙏|愾 忾|慄 栗|態 态|慍 愠|慘 惨|慚 惭|慟 恸|慣 惯|慤 悫|慪 怄|慫 怂|慮 虑|慳 悭|慶 庆|慺 㥪|慼 戚|慾 欲|憂 忧|憊 惫|憐 怜|憑 凭|憒 愦|憖 慭|憚 惮|憢 𢙒|憤 愤|憫 悯|憮 怃|憲 宪|憶 忆|憸 𪫺|憹 𢙐|懀 𢙓|懇 恳|應 应|懌 怿|懍 懔|懎 𢠁|懞 蒙|懟 怼|懣 懑|懤 㤽|懨 恹|懲 惩|懶 懒|懷 怀|懸 悬|懺 忏|懼 惧|懾 慑|戀 恋|戇 戆|戔 戋|戧 戗|戩 戬|戰 战|戱 戯|戲 戏|戶 户|拋 抛|挩 捝|挱 挲|挾 挟|捨 舍|捫 扪|捱 挨|捲 卷|掃 扫|掄 抡|掆 㧏|掗 挜|掙 挣|掚 𪭵|掛 挂|採 采|揀 拣|揚 扬|換 换|揮 挥|揯 搄|損 损|搖 摇|搗 捣|搵 揾|搶 抢|摋 𢫬|摐 𪭢|摑 掴|摜 掼|摟 搂|摯 挚|摳 抠|摶 抟|摺 折|摻 掺|撈 捞|撊 𪭾|撏 挦|撐 撑|撓 挠|撝 㧑|撟 挢|撣 掸|撥 拨|撧 𪮖|撫 抚|撲 扑|撳 揿|撻 挞|撾 挝|撿 捡|擁 拥|擄 掳|擇 择|擊 击|擋 挡|擓 㧟|擔 担|據 据|擟 𪭧|擠 挤|擣 捣|擫 𢬍|擬 拟|擯 摈|擰 拧|擱 搁|擲 掷|擴 扩|擷 撷|擺 摆|擻 擞|擼 撸|擽 㧰|擾 扰|攄 摅|攆 撵|攋 𪮶|攏 拢|攔 拦|攖 撄|攙 搀|攛 撺|攜 携|攝 摄|攢 攒|攣 挛|攤 摊|攪 搅|攬 揽|敎 教|敓 敚|敗 败|敘 叙|敵 敌|數 数|斂 敛|斃 毙|斅 𢽾|斆 敩|斕 斓|斬 斩|斷 断|斸 𣃁|於 于|旂 旗|旣 既|昇 升|時 时|晉 晋|晛 𬀪|晝 昼|暈 晕|暉 晖|暐 𬀩|暘 旸|暢 畅|暫 暂|曄 晔|曆 历|曇 昙|曉 晓|曊 𪰶|曏 向|曖 暧|曠 旷|曥 𣆐|曨 昽|曬 晒|書 书|會 会|朥 𦛨|朧 胧|朮 术|東 东|枴 拐|柵 栅|柺 拐|査 查|桱 𣐕|桿 杆|梔 栀|梖 𪱷|梘 枧|梜 𬂩|條 条|梟 枭|梲 棁|棄 弃|棊 棋|棖 枨|棗 枣|棟 栋|棡 㭎|棧 栈|棲 栖|棶 梾|椏 桠|椲 㭏|楇 𣒌|楊 杨|楓 枫|楨 桢|業 业|極 极|榘 矩|榦 干|榪 杩|榮 荣|榲 榅|榿 桤|構 构|槍 枪|槓 杠|槤 梿|槧 椠|槨 椁|槫 𣏢|槮 椮|槳 桨|槶 椢|槼 椝|樁 桩|樂 乐|樅 枞|樑 梁|樓 楼|標 标|樞 枢|樠 𣗊|樢 㭤|樣 样|樤 𣔌|樧 榝|樫 㭴|樳 桪|樸 朴|樹 树|樺 桦|樿 椫|橈 桡|橋 桥|機 机|橢 椭|橫 横|橯 𣓿|檁 檩|檉 柽|檔 档|檜 桧|檟 槚|檢 检|檣 樯|檭 𣘴|檮 梼|檯 台|檳 槟|檵 𪲛|檸 柠|檻 槛|櫃 柜|櫅 𪲎|櫍 𬃊|櫓 橹|櫚 榈|櫛 栉|櫝 椟|櫞 橼|櫟 栎|櫠 𪲮|櫥 橱|櫧 槠|櫨 栌|櫪 枥|櫫 橥|櫬 榇|櫱 蘖|櫳 栊|櫸 榉|櫻 樱|欄 栏|欅 榉|欇 𪳍|權 权|欍 𣐤|欏 椤|欐 𪲔|欑 𪴙|欒 栾|欓 𣗋|欖 榄|欘 𣚚|欞 棂|欽 钦|歎 叹|歐 欧|歟 欤|歡 欢|歲 岁|歷 历|歸 归|歿 殁|殘 残|殞 殒|殢 𣨼|殤 殇|殨 㱮|殫 殚|殭 僵|殮 殓|殯 殡|殰 㱩|殲 歼|殺 杀|殻 壳|殼 壳|毀 毁|毆 殴|毊 𪵑|毿 毵|氂 牦|氈 毡|氌 氇|氣 气|氫 氢|氬 氩|氭 𣱝|氳 氲|氾 泛|汎 泛|汙 污|決 决|沒 没|沖 冲|況 况|泝 溯|洩 泄|洶 汹|浹 浃|浿 𬇙|涇 泾|涗 涚|涼 凉|淒 凄|淚 泪|淥 渌|淨 净|淩 凌|淪 沦|淵 渊|淶 涞|淺 浅|渙 涣|減 减|渢 沨|渦 涡|測 测|渾 浑|湊 凑|湋 𣲗|湞 浈|湧 涌|湯 汤|溈 沩|準 准|溝 沟|溡 𪶄|溫 温|溮 浉|溳 涢|溼 湿|滄 沧|滅 灭|滌 涤|滎 荥|滙 汇|滬 沪|滯 滞|滲 渗|滷 卤|滸 浒|滻 浐|滾 滚|滿 满|漁 渔|漊 溇|漍 𬇹|漚 沤|漢 汉|漣 涟|漬 渍|漲 涨|漵 溆|漸 渐|漿 浆|潁 颍|潑 泼|潔 洁|潕 𣲘|潙 沩|潚 㴋|潛 潜|潣 𫞗|潤 润|潯 浔|潰 溃|潷 滗|潿 涠|澀 涩|澅 𣶩|澆 浇|澇 涝|澐 沄|澗 涧|澠 渑|澤 泽|澦 滪|澩 泶|澫 𬇕|澬 𫞚|澮 浍|澱 淀|澾 㳠|濁 浊|濃 浓|濄 㳡|濆 𣸣|濕 湿|濘 泞|濚 溁|濛 蒙|濜 浕|濟 济|濤 涛|濧 㳔|濫 滥|濰 潍|濱 滨|濺 溅|濼 泺|濾 滤|濿 𪵱|瀂 澛|瀃 𣽷|瀅 滢|瀆 渎|瀇 㲿|瀉 泻|瀋 沈|瀏 浏|瀕 濒|瀘 泸|瀝 沥|瀟 潇|瀠 潆|瀦 潴|瀧 泷|瀨 濑|瀰 弥|瀲 潋|瀾 澜|灃 沣|灄 滠|灍 𫞝|灑 洒|灒 𪷽|灕 漓|灘 滩|灙 𣺼|灝 灏|灡 㳕|灣 湾|灤 滦|灧 滟|灩 滟|災 灾|為 为|烏 乌|烴 烃|無 无|煇 𪸩|煉 炼|煒 炜|煙 烟|煢 茕|煥 焕|煩 烦|煬 炀|煱 㶽|熂 𪸕|熅 煴|熉 𤈶|熌 𤇄|熒 荧|熓 𤆡|熗 炝|熚 𤇹|熡 𤋏|熰 𬉼|熱 热|熲 颎|熾 炽|燀 𬊤|燁 烨|燈 灯|燉 炖|燒 烧|燖 𬊈|燙 烫|燜 焖|營 营|燦 灿|燬 毁|燭 烛|燴 烩|燶 㶶|燻 熏|燼 烬|燾 焘|爃 𫞡|爄 𤇃|爇 𦶟|爍 烁|爐 炉|爖 𤇭|爛 烂|爥 𪹳|爧 𫞠|爭 争|爲 为|爺 爷|爾 尔|牀 床|牆 墙|牘 牍|牽 牵|犖 荦|犛 牦|犞 𪺭|犢 犊|犧 牺|狀 状|狹 狭|狽 狈|猌 𪺽|猙 狰|猶 犹|猻 狲|獁 犸|獃 呆|獄 狱|獅 狮|獊 𪺷|獎 奖|獨 独|獩 𤞃|獪 狯|獫 猃|獮 狝|獰 狞|獱 㺍|獲 获|獵 猎|獷 犷|獸 兽|獺 獭|獻 献|獼 猕|玀 猡|玁 𤞤|珼 𫞥|現 现|琱 雕|琺 珐|琿 珲|瑋 玮|瑒 玚|瑣 琐|瑤 瑶|瑩 莹|瑪 玛|瑲 玱|瑻 𪻲|瑽 𪻐|璉 琏|璊 𫞩|璕 𬍤|璗 𬍡|璝 𪻺|璡 琎|璣 玑|璦 瑷|璫 珰|璯 㻅|環 环|璵 玙|璸 瑸|璼 𫞨|璽 玺|璾 𫞦|璿 璇|瓄 𪻨|瓅 𬍛|瓊 琼|瓏 珑|瓔 璎|瓕 𤦀|瓚 瓒|瓛 𤩽|甌 瓯|甕 瓮|產 产|産 产|甦 苏|甯 宁|畝 亩|畢 毕|畫 画|異 异|畵 画|當 当|畼 𪽈|疇 畴|疊 叠|痙 痉|痠 酸|痮 𪽪|痾 疴|瘂 痖|瘋 疯|瘍 疡|瘓 痪|瘞 瘗|瘡 疮|瘧 疟|瘮 瘆|瘱 𪽷|瘲 疭|瘺 瘘|瘻 瘘|療 疗|癆 痨|癇 痫|癉 瘅|癐 𤶊|癒 愈|癘 疠|癟 瘪|癡 痴|癢 痒|癤 疖|癥 症|癧 疬|癩 癞|癬 癣|癭 瘿|癮 瘾|癰 痈|癱 瘫|癲 癫|發 发|皁 皂|皚 皑|皟 𤾀|皰 疱|皸 皲|皺 皱|盃 杯|盜 盗|盞 盏|盡 尽|監 监|盤 盘|盧 卢|盨 𪾔|盪 荡|眝 𪾣|眞 真|眥 眦|眾 众|睍 𪾢|睏 困|睜 睁|睞 睐|瞘 眍|瞜 䁖|瞞 瞒|瞤 𥆧|瞶 瞆|瞼 睑|矇 蒙|矉 𪾸|矑 𪾦|矓 眬|矚 瞩|矯 矫|硃 朱|硜 硁|硤 硖|硨 砗|硯 砚|碕 埼|碙 𥐻|碩 硕|碭 砀|碸 砜|確 确|碼 码|碽 䂵|磑 硙|磚 砖|磠 硵|磣 碜|磧 碛|磯 矶|磽 硗|磾 䃅|礄 硚|礆 硷|礎 础|礐 𬒈|礒 𥐟|礙 碍|礦 矿|礪 砺|礫 砾|礬 矾|礮 𪿫|礱 砻|祕 秘|祿 禄|禍 祸|禎 祯|禕 祎|禡 祃|禦 御|禪 禅|禮 礼|禰 祢|禱 祷|禿 秃|秈 籼|稅 税|稈 秆|稏 䅉|稜 棱|稟 禀|種 种|稱 称|穀 谷|穇 䅟|穌 稣|積 积|穎 颖|穠 秾|穡 穑|穢 秽|穩 稳|穫 获|穭 穞|窩 窝|窪 洼|窮 穷|窯 窑|窵 窎|窶 窭|窺 窥|竄 窜|竅 窍|竇 窦|竈 灶|竊 窃|竚 𥩟|竪 竖|竱 𫁟|競 竞|筆 笔|筍 笋|筧 笕|筴 䇲|箇 个|箋 笺|箏 筝|節 节|範 范|築 筑|篋 箧|篔 筼|篘 𥬠|篠 筿|篢 𬕂|篤 笃|篩 筛|篳 筚|篸 𥮾|簀 箦|簂 𫂆|簍 篓|簑 蓑|簞 箪|簡 简|簢 𫂃|簣 篑|簫 箫|簹 筜|簽 签|簾 帘|籃 篮|籅 𥫣|籋 𥬞|籌 筹|籔 䉤|籙 箓|籛 篯|籜 箨|籟 籁|籠 笼|籤 签|籩 笾|籪 簖|籬 篱|籮 箩|籲 吁|粵 粤|糉 粽|糝 糁|糞 粪|糧 粮|糰 团|糲 粝|糴 籴|糶 粜|糹 纟|糺 𫄙|糾 纠|紀 纪|紂 纣|紃 𬘓|約 约|紅 红|紆 纡|紇 纥|紈 纨|紉 纫|紋 纹|納 纳|紐 纽|紓 纾|純 纯|紕 纰|紖 纼|紗 纱|紘 纮|紙 纸|級 级|紛 纷|紜 纭|紝 纴|紞 𬘘|紟 𫄛|紡 纺|紬 䌷|紮 扎|細 细|紱 绂|紲 绁|紳 绅|紵 纻|紹 绍|紺 绀|紼 绋|紿 绐|絀 绌|絁 𫄟|終 终|絃 弦|組 组|絅 䌹|絆 绊|絍 𫟃|絎 绗|結 结|絕 绝|絙 𫄠|絛 绦|絝 绔|絞 绞|絡 络|絢 绚|絥 𫄢|給 给|絧 𫄡|絨 绒|絪 𬘡|絰 绖|統 统|絲 丝|絳 绛|絶 绝|絹 绢|絺 𫄨|綀 𦈌|綁 绑|綃 绡|綄 𬘫|綆 绠|綇 𦈋|綈 绨|綉 绣|綋 𫟄|綌 绤|綎 𬘩|綏 绥|綐 䌼|綑 捆|經 经|綖 𫄧|綜 综|綝 𬘭|綞 缍|綟 𫄫|綠 绿|綡 𫟅|綢 绸|綣 绻|綧 𬘯|綪 𬘬|綫 线|綬 绶|維 维|綯 绹|綰 绾|綱 纲|網 网|綳 绷|綴 缀|綵 彩|綸 纶|綹 绺|綺 绮|綻 绽|綽 绰|綾 绫|綿 绵|緄 绲|緇 缁|緊 紧|緋 绯|緍 𦈏|緑 绿|緒 绪|緓 绬|緔 绱|緗 缃|緘 缄|緙 缂|線 线|緝 缉|緞 缎|緟 𫟆|締 缔|緡 缗|緣 缘|緤 𫄬|緦 缌|編 编|緩 缓|緬 缅|緮 𫄭|緯 纬|緰 𦈕|緱 缑|緲 缈|練 练|緶 缏|緷 𦈉|緸 𦈑|緹 缇|緻 致|緼 缊|縈 萦|縉 缙|縊 缢|縋 缒|縍 𫄰|縎 𦈔|縐 绉|縑 缣|縕 缊|縗 缞|縛 缚|縝 缜|縞 缟|縟 缛|縣 县|縧 绦|縫 缝|縬 𦈚|縭 缡|縮 缩|縯 𬙂|縰 𫄳|縱 纵|縲 缧|縳 䌸|縴 纤|縵 缦|縶 絷|縷 缕|縸 𫄲|縹 缥|縺 𦈐|總 总|績 绩|繂 𫄴|繃 绷|繅 缫|繆 缪|繈 𫄶|繏 𦈝|繐 𰬸|繒 缯|繓 𦈛|織 织|繕 缮|繚 缭|繞 绕|繟 𦈎|繡 绣|繢 缋|繨 𫄤|繩 绳|繪 绘|繫 系|繬 𫄱|繭 茧|繮 缰|繯 缳|繰 缲|繳 缴|繶 𫄷|繷 𫄣|繸 䍁|繹 绎|繻 𦈡|繼 继|繽 缤|繾 缱|繿 䍀|纁 𫄸|纆 𬙊|纇 颣|纈 缬|纊 纩|續 续|纍 累|纏 缠|纓 缨|纔 才|纕 𬙋|纖 纤|纗 𫄹|纘 缵|纚 𫄥|纜 缆|缽 钵|罃 䓨|罈 坛|罌 罂|罎 坛|罰 罚|罵 骂|罷 罢|羅 罗|羆 罴|羈 羁|羋 芈|羣 群|羥 羟|羨 羡|義 义|羵 𫅗|羶 膻|習 习|翫 玩|翬 翚|翹 翘|翽 翙|耬 耧|耮 耢|聖 圣|聞 闻|聯 联|聰 聪|聲 声|聳 耸|聵 聩|聶 聂|職 职|聹 聍|聻 𫆏|聽 听|聾 聋|肅 肃|脅 胁|脈 脉|脛 胫|脣 唇|脥 𣍰|脩 修|脫 脱|脹 胀|腎 肾|腖 胨|腡 脶|腦 脑|腪 𣍯|腫 肿|腳 脚|腸 肠|膃 腽|膕 腘|膚 肤|膞 䏝|膠 胶|膢 𦝼|膩 腻|膹 𪱥|膽 胆|膾 脍|膿 脓|臉 脸|臍 脐|臏 膑|臗 𣎑|臘 腊|臚 胪|臟 脏|臠 脔|臢 臜|臥 卧|臨 临|臺 台|與 与|興 兴|舉 举|舊 旧|舘 馆|艙 舱|艣 𫇛|艤 舣|艦 舰|艫 舻|艱 艰|艷 艳|芻 刍|苧 苎|茲 兹|荊 荆|莊 庄|莖 茎|莢 荚|莧 苋|菕 𰰨|華 华|菴 庵|菸 烟|萇 苌|萊 莱|萬 万|萴 荝|萵 莴|葉 叶|葒 荭|葝 𫈎|葤 荮|葦 苇|葯 药|葷 荤|蒍 𫇭|蒐 搜|蒓 莼|蒔 莳|蒕 蒀|蒞 莅|蒭 𫇴|蒼 苍|蓀 荪|蓆 席|蓋 盖|蓧 𦰏|蓮 莲|蓯 苁|蓴 莼|蓽 荜|蔄 𬜬|蔔 卜|蔘 参|蔞 蒌|蔣 蒋|蔥 葱|蔦 茑|蔭 荫|蔯 𫈟|蔿 𫇭|蕁 荨|蕆 蒇|蕎 荞|蕒 荬|蕓 芸|蕕 莸|蕘 荛|蕝 𫈵|蕢 蒉|蕩 荡|蕪 芜|蕭 萧|蕳 𫈉|蕷 蓣|蕽 𫇽|薀 蕰|薆 𫉁|薈 荟|薊 蓟|薌 芗|薑 姜|薔 蔷|薘 荙|薟 莶|薦 荐|薩 萨|薳 䓕|薴 苧|薵 䓓|薹 苔|薺 荠|藍 蓝|藎 荩|藝 艺|藥 药|藪 薮|藭 䓖|藴 蕴|藶 苈|藷 𫉄|藹 蔼|藺 蔺|蘀 萚|蘄 蕲|蘆 芦|蘇 苏|蘊 蕴|蘋 苹|蘚 藓|蘞 蔹|蘟 𦻕|蘢 茏|蘭 兰|蘺 蓠|蘿 萝|虆 蔂|虉 𬟁|處 处|虛 虚|虜 虏|號 号|虧 亏|虯 虬|蛺 蛱|蛻 蜕|蜆 蚬|蝀 𬟽|蝕 蚀|蝟 猬|蝦 虾|蝨 虱|蝸 蜗|螄 蛳|螞 蚂|螢 萤|螮 䗖|螻 蝼|螿 螀|蟂 𫋇|蟄 蛰|蟈 蝈|蟎 螨|蟘 𫋌|蟜 𫊸|蟣 虮|蟬 蝉|蟯 蛲|蟲 虫|蟳 𫊻|蟶 蛏|蟻 蚁|蠀 𧏗|蠁 蚃|蠅 蝇|蠆 虿|蠍 蝎|蠐 蛴|蠑 蝾|蠔 蚝|蠙 𧏖|蠟 蜡|蠣 蛎|蠦 𫊮|蠨 蟏|蠱 蛊|蠶 蚕|蠻 蛮|蠾 𧑏|衆 众|衊 蔑|術 术|衕 同|衚 胡|衛 卫|衝 冲|袞 衮|裊 袅|裏 里|補 补|裝 装|裡 里|製 制|複 复|褌 裈|褘 袆|褲 裤|褳 裢|褸 褛|褻 亵|襀 𫌀|襇 裥|襉 裥|襏 袯|襓 𫋹|襖 袄|襗 𫋷|襘 𫋻|襝 裣|襠 裆|襤 褴|襪 袜|襬 摆|襯 衬|襰 𧝝|襲 袭|襴 襕|襵 𫌇|覈 核|見 见|覎 觃|規 规|覓 觅|視 视|覘 觇|覛 𫌪|覡 觋|覥 觍|覦 觎|親 亲|覬 觊|覯 觏|覲 觐|覷 觑|覹 𫌭|覺 觉|覼 𫌨|覽 览|覿 觌|觀 观|觴 觞|觶 觯|觸 触|訁 讠|訂 订|訃 讣|計 计|訊 讯|訌 讧|討 讨|訏 𬣙|訐 讦|訑 𫍙|訒 讱|訓 训|訕 讪|訖 讫|託 托|記 记|訛 讹|訜 𫍛|訝 讶|訞 𫍚|訟 讼|訢 䜣|訣 诀|訥 讷|訨 𫟞|訩 讻|訪 访|設 设|許 许|訴 诉|訶 诃|診 诊|註 注|証 证|詀 𧮪|詁 诂|詆 诋|詊 𫟟|詎 讵|詐 诈|詑 𫍡|詒 诒|詓 𫍜|詔 诏|評 评|詖 诐|詗 诇|詘 诎|詛 诅|詝 𬣞|詞 词|詠 咏|詡 诩|詢 询|詣 诣|試 试|詩 诗|詪 𬣳|詫 诧|詬 诟|詭 诡|詮 诠|詰 诘|話 话|該 该|詳 详|詵 诜|詷 𫍣|詼 诙|詿 诖|誂 𫍥|誄 诔|誅 诛|誆 诓|誇 夸|誋 𫍪|誌 志|認 认|誑 诳|誒 诶|誕 诞|誘 诱|誚 诮|語 语|誠 诚|誡 诫|誣 诬|誤 误|誥 诰|誦 诵|誨 诲|說 说|誫 𫍨|説 说|誰 谁|課 课|誳 𫍮|誴 𫟡|誶 谇|誷 𫍬|誹 诽|誺 𫍧|誼 谊|誾 訚|調 调|諂 谄|諄 谆|談 谈|諉 诿|請 请|諍 诤|諏 诹|諑 诼|諒 谅|諓 𬣡|論 论|諗 谂|諛 谀|諜 谍|諝 谞|諞 谝|諟 𬤊|諡 谥|諢 诨|諣 𫍩|諤 谔|諥 𫍳|諦 谛|諧 谐|諫 谏|諭 谕|諮 咨|諯 𫍱|諰 𫍰|諱 讳|諲 𬤇|諳 谙|諴 𫍯|諶 谌|諷 讽|諸 诸|諺 谚|諼 谖|諾 诺|謀 谋|謁 谒|謂 谓|謄 誊|謅 诌|謆 𫍸|謉 𫍷|謊 谎|謎 谜|謏 𫍲|謐 谧|謔 谑|謖 谡|謗 谤|謙 谦|謚 谥|講 讲|謝 谢|謠 谣|謡 谣|謨 谟|謫 谪|謬 谬|謭 谫|謯 𫍹|謱 𫍴|謳 讴|謸 𫍵|謹 谨|謾 谩|譁 哗|譂 𫟠|譅 𰶎|譆 𫍻|證 证|譊 𫍢|譎 谲|譏 讥|譑 𫍤|譓 𬤝|譖 谮|識 识|譙 谯|譚 谭|譜 谱|譞 𫍽|譟 噪|譨 𫍦|譫 谵|譭 毁|譯 译|議 议|譴 谴|護 护|譸 诪|譽 誉|譾 谫|讀 读|讅 谉|變 变|讋 詟|讌 䜩|讎 雠|讒 谗|讓 让|讕 谰|讖 谶|讚 赞|讜 谠|讞 谳|豈 岂|豎 竖|豐 丰|豔 艳|豬 猪|豵 𫎆|豶 豮|貓 猫|貗 𫎌|貙 䝙|貝 贝|貞 贞|貟 贠|負 负|財 财|貢 贡|貧 贫|貨 货|販 贩|貪 贪|貫 贯|責 责|貯 贮|貰 贳|貲 赀|貳 贰|貴 贵|貶 贬|買 买|貸 贷|貺 贶|費 费|貼 贴|貽 贻|貿 贸|賀 贺|賁 贲|賂 赂|賃 赁|賄 贿|賅 赅|資 资|賈 贾|賊 贼|賑 赈|賒 赊|賓 宾|賕 赇|賙 赒|賚 赉|賜 赐|賝 𫎩|賞 赏|賟 𧹖|賠 赔|賡 赓|賢 贤|賣 卖|賤 贱|賦 赋|賧 赕|質 质|賫 赍|賬 账|賭 赌|賰 䞐|賴 赖|賵 赗|賺 赚|賻 赙|購 购|賽 赛|賾 赜|贃 𧹗|贄 贽|贅 赘|贇 赟|贈 赠|贉 𫎫|贊 赞|贋 赝|贍 赡|贏 赢|贐 赆|贑 𫎬|贓 赃|贔 赑|贖 赎|贗 赝|贚 𫎦|贛 赣|贜 赃|赬 赪|趕 赶|趙 赵|趨 趋|趲 趱|跡 迹|踐 践|踰 逾|踴 踊|蹌 跄|蹔 𫏐|蹕 跸|蹟 迹|蹠 跖|蹣 蹒|蹤 踪|蹳 𫏆|蹺 跷|蹻 𫏋|躂 跶|躉 趸|躊 踌|躋 跻|躍 跃|躎 䟢|躑 踯|躒 跞|躓 踬|躕 蹰|躘 𨀁|躚 跹|躝 𨅬|躡 蹑|躥 蹿|躦 躜|躪 躏|軀 躯|軉 𨉗|車 车|軋 轧|軌 轨|軍 军|軏 𫐄|軑 轪|軒 轩|軔 轫|軕 𫐅|軗 𨐅|軛 轭|軜 𫐇|軝 𬨂|軟 软|軤 轷|軨 𫐉|軫 轸|軬 𫐊|軲 轱|軷 𫐈|軸 轴|軹 轵|軺 轺|軻 轲|軼 轶|軾 轼|軿 𫐌|較 较|輄 𨐈|輅 辂|輇 辁|輈 辀|載 载|輊 轾|輋 𪨶|輒 辄|輓 挽|輔 辅|輕 轻|輖 𫐏|輗 𫐐|輛 辆|輜 辎|輝 辉|輞 辋|輟 辍|輢 𫐎|輥 辊|輦 辇|輨 𫐑|輩 辈|輪 轮|輬 辌|輮 𫐓|輯 辑|輳 辏|輶 𬨎|輷 𫐒|輸 输|輻 辐|輼 辒|輾 辗|輿 舆|轀 辒|轂 毂|轄 辖|轅 辕|轆 辘|轇 𫐖|轉 转|轊 𫐕|轍 辙|轎 轿|轐 𫐗|轔 辚|轗 𫐘|轟 轰|轠 𫐙|轡 辔|轢 轹|轣 𫐆|轤 轳|辦 办|辭 辞|辮 辫|辯 辩|農 农|迴 回|逕 迳|這 这|連 连|週 周|進 进|遊 游|運 运|過 过|達 达|違 违|遙 遥|遜 逊|遞 递|遠 远|遡 溯|適 适|遱 𫐷|遲 迟|遷 迁|選 选|遺 遗|遼 辽|邁 迈|還 还|邇 迩|邊 边|邏 逻|邐 逦|郟 郏|郵 邮|鄆 郓|鄉 乡|鄒 邹|鄔 邬|鄖 郧|鄟 𫑘|鄧 邓|鄩 𬩽|鄭 郑|鄰 邻|鄲 郸|鄳 𫑡|鄴 邺|鄶 郐|鄺 邝|酇 酂|酈 郦|醃 腌|醖 酝|醜 丑|醞 酝|醟 蒏|醣 糖|醫 医|醬 酱|醱 酦|醲 𬪩|醶 𫑷|釀 酿|釁 衅|釃 酾|釅 酽|釋 释|釐 厘|釒 钅|釓 钆|釔 钇|釕 钌|釗 钊|釘 钉|釙 钋|釚 𫟲|針 针|釟 𫓥|釣 钓|釤 钐|釦 扣|釧 钏|釨 𫓦|釩 钒|釲 𫟳|釳 𨰿|釴 𬬩|釵 钗|釷 钍|釹 钕|釺 钎|釾 䥺|釿 𬬱|鈀 钯|鈁 钫|鈃 钘|鈄 钭|鈅 钥|鈆 𫓪|鈇 𫓧|鈈 钚|鈉 钠|鈋 𨱂|鈍 钝|鈎 钩|鈐 钤|鈑 钣|鈒 钑|鈔 钞|鈕 钮|鈖 𫟴|鈗 𫟵|鈛 𫓨|鈞 钧|鈠 𨱁|鈡 钟|鈣 钙|鈥 钬|鈦 钛|鈧 钪|鈮 铌|鈯 𨱄|鈰 铈|鈲 𨱃|鈳 钶|鈴 铃|鈷 钴|鈸 钹|鈹 铍|鈺 钰|鈽 钸|鈾 铀|鈿 钿|鉀 钾|鉁 𨱅|鉅 巨|鉆 钻|鉈 铊|鉉 铉|鉊 𬬿|鉋 铇|鉍 铋|鉑 铂|鉔 𫓬|鉕 钷|鉗 钳|鉚 铆|鉛 铅|鉝 𫟷|鉞 钺|鉠 𫓭|鉢 钵|鉤 钩|鉥 𬬸|鉦 钲|鉧 𬭁|鉬 钼|鉭 钽|鉮 𬬹|鉳 锫|鉶 铏|鉷 𫟹|鉸 铰|鉺 铒|鉻 铬|鉽 𫟸|鉾 𫓴|鉿 铪|銀 银|銁 𫓲|銂 𫟻|銃 铳|銅 铜|銈 𫓯|銊 𫓰|銍 铚|銏 𫟶|銑 铣|銓 铨|銖 铢|銘 铭|銚 铫|銛 铦|銜 衔|銠 铑|銣 铷|銥 铱|銦 铟|銨 铵|銩 铥|銪 铕|銫 铯|銬 铐|銱 铞|銳 锐|銶 𨱇|銷 销|銹 锈|銻 锑|銼 锉|鋁 铝|鋂 𰾄|鋃 锒|鋅 锌|鋇 钡|鋉 𨱈|鋌 铤|鋏 铗|鋐 𬭎|鋒 锋|鋗 𫓶|鋙 铻|鋝 锊|鋟 锓|鋠 𫓵|鋣 铘|鋤 锄|鋥 锃|鋦 锔|鋨 锇|鋩 铓|鋪 铺|鋭 锐|鋮 铖|鋯 锆|鋰 锂|鋱 铽|鋶 锍|鋸 锯|鋹 𬬮|鋼 钢|錀 𬬭|錁 锞|錂 𨱋|錄 录|錆 锖|錇 锫|錈 锩|錏 铔|錐 锥|錒 锕|錕 锟|錘 锤|錙 锱|錚 铮|錛 锛|錜 𫓻|錝 𫓽|錞 𬭚|錟 锬|錠 锭|錡 锜|錢 钱|錤 𫓹|錥 𫓾|錦 锦|錨 锚|錩 锠|錫 锡|錮 锢|錯 错|録 录|錳 锰|錶 表|錸 铼|錼 镎|錽 𫓸|鍀 锝|鍁 锨|鍃 锪|鍄 𨱉|鍅 钫|鍆 钔|鍇 锴|鍈 锳|鍉 𫔂|鍊 炼|鍋 锅|鍍 镀|鍒 𫔄|鍔 锷|鍘 铡|鍚 钖|鍛 锻|鍠 锽|鍤 锸|鍥 锲|鍩 锘|鍬 锹|鍭 𬭤|鍮 𨱎|鍰 锾|鍵 键|鍶 锶|鍺 锗|鍼 针|鍾 钟|鎂 镁|鎄 锿|鎇 镅|鎈 𫟿|鎊 镑|鎌 镰|鎍 𫔅|鎓 𬭩|鎔 镕|鎖 锁|鎘 镉|鎙 𫔈|鎚 锤|鎛 镈|鎝 𨱏|鎞 𫔇|鎡 镃|鎢 钨|鎣 蓥|鎦 镏|鎧 铠|鎩 铩|鎪 锼|鎬 镐|鎭 镇|鎮 镇|鎯 𨱍|鎰 镒|鎲 镋|鎳 镍|鎵 镓|鎶 鿔|鎷 𨰾|鎸 镌|鎿 镎|鏃 镞|鏆 𨱌|鏇 旋|鏈 链|鏉 𨱒|鏌 镆|鏍 镙|鏏 𬭬|鏐 镠|鏑 镝|鏗 铿|鏘 锵|鏚 𬭭|鏜 镗|鏝 镘|鏞 镛|鏟 铲|鏡 镜|鏢 镖|鏤 镂|鏥 𫔊|鏦 𫓩|鏨 錾|鏰 镚|鏵 铧|鏷 镤|鏹 镪|鏺 䥽|鏻 𬭸|鏽 锈|鏾 𫔌|鐃 铙|鐄 𨱑|鐇 𫔍|鐈 𫓱|鐋 铴|鐍 𫔎|鐎 𨱓|鐏 𨱔|鐐 镣|鐒 铹|鐓 镦|鐔 镡|鐘 钟|鐙 镫|鐝 镢|鐠 镨|鐥 䦅|鐦 锎|鐧 锏|鐨 镄|鐩 𬭼|鐪 𫓺|鐫 镌|鐮 镰|鐯 䦃|鐲 镯|鐳 镭|鐵 铁|鐶 镮|鐸 铎|鐺 铛|鐼 𫔁|鐽 𫟼|鐿 镱|鑀 𰾭|鑄 铸|鑉 𫠁|鑊 镬|鑌 镔|鑑 鉴|鑒 鉴|鑔 镲|鑕 锧|鑞 镴|鑠 铄|鑣 镳|鑥 镥|鑪 𬬻|鑭 镧|鑰 钥|鑱 镵|鑲 镶|鑴 𫔔|鑷 镊|鑹 镩|鑼 锣|鑽 钻|鑾 銮|鑿 凿|钁 镢|钂 镋|長 长|門 门|閂 闩|閃 闪|閆 闫|閈 闬|閉 闭|開 开|閌 闶|閍 𨸂|閎 闳|閏 闰|閐 𨸃|閑 闲|閒 闲|間 间|閔 闵|閗 𫔯|閘 闸|閝 𫠂|閞 𫔰|閡 阂|閣 阁|閤 合|閥 阀|閨 闺|閩 闽|閫 阃|閬 阆|閭 闾|閱 阅|閲 阅|閵 𫔴|閶 阊|閹 阉|閻 阎|閼 阏|閽 阍|閾 阈|閿 阌|闃 阒|闆 板|闇 暗|闈 闱|闉 𬮱|闊 阔|闋 阕|闌 阑|闍 阇|闐 阗|闑 𫔶|闒 阘|闓 闿|闔 阖|闕 阙|闖 闯|關 关|闞 阚|闠 阓|闡 阐|闢 辟|闤 阛|闥 闼|陘 陉|陝 陕|陞 升|陣 阵|陰 阴|陳 陈|陸 陆|陽 阳|隉 陧|隊 队|階 阶|隑 𬮿|隕 陨|際 际|隤 𬯎|隨 随|險 险|隮 𬯀|隯 陦|隱 隐|隴 陇|隸 隶|隻 只|雋 隽|雖 虽|雙 双|雛 雏|雜 杂|雞 鸡|離 离|難 难|雲 云|電 电|霑 沾|霢 霡|霣 𫕥|霧 雾|霼 𪵣|霽 霁|靂 雳|靄 霭|靆 叇|靈 灵|靉 叆|靚 靓|靜 静|靝 靔|靦 腼|靧 𫖃|靨 靥|鞏 巩|鞝 绱|鞦 秋|鞽 鞒|鞾 𫖇|韁 缰|韃 鞑|韆 千|韉 鞯|韋 韦|韌 韧|韍 韨|韓 韩|韙 韪|韚 𫠅|韛 𫖔|韜 韬|韝 鞲|韞 韫|韠 𫖒|韻 韵|響 响|頁 页|頂 顶|頃 顷|項 项|順 顺|頇 顸|須 须|頊 顼|頌 颂|頍 𫠆|頎 颀|頏 颃|預 预|頑 顽|頒 颁|頓 顿|頔 𬱖|頗 颇|領 领|頜 颌|頠 𬱟|頡 颉|頤 颐|頦 颏|頫 𫖯|頭 头|頮 颒|頰 颊|頲 颋|頴 颕|頵 𫖳|頷 颔|頸 颈|頹 颓|頻 频|頽 颓|顂 𩓋|顃 𩖖|顅 𫖶|顆 颗|題 题|額 额|顎 颚|顏 颜|顒 颙|顓 颛|顔 颜|顗 𫖮|願 愿|顙 颡|顛 颠|類 类|顢 颟|顣 𫖹|顥 颢|顧 顾|顫 颤|顬 颥|顯 显|顰 颦|顱 颅|顳 颞|顴 颧|風 风|颭 飐|颮 飑|颯 飒|颰 𩙥|颱 台|颳 刮|颶 飓|颷 𩙪|颸 飔|颺 飏|颻 飖|颼 飕|颾 𩙫|飀 飗|飄 飘|飆 飙|飈 飚|飋 𫗋|飛 飞|飠 饣|飢 饥|飣 饤|飥 饦|飦 𫗞|飩 饨|飪 饪|飫 饫|飭 饬|飯 饭|飱 飧|飲 饮|飴 饴|飵 𫗢|飶 𫗣|飼 饲|飽 饱|飾 饰|飿 饳|餃 饺|餄 饸|餅 饼|餈 糍|餉 饷|養 养|餌 饵|餎 饹|餏 饻|餑 饽|餒 馁|餓 饿|餔 𫗦|餕 馂|餖 饾|餗 𫗧|餘 余|餚 肴|餛 馄|餜 馃|餞 饯|餡 馅|餦 𫗠|餧 𫗪|館 馆|餪 𫗬|餫 𫗥|餬 糊|餭 𫗮|餱 糇|餳 饧|餵 喂|餶 馉|餷 馇|餸 𩠌|餺 馎|餼 饩|餾 馏|餿 馊|饁 馌|饃 馍|饅 馒|饈 馐|饉 馑|饊 馓|饋 馈|饌 馔|饑 饥|饒 饶|饗 飨|饘 𫗴|饜 餍|饞 馋|饟 𫗵|饠 𫗩|饢 馕|馬 马|馭 驭|馮 冯|馯 𫘛|馱 驮|馳 驰|馴 驯|馹 驲|馼 𫘜|駁 驳|駃 𫘝|駉 𬳶|駊 𫘟|駎 𩧨|駐 驻|駑 驽|駒 驹|駓 𬳵|駔 驵|駕 驾|駘 骀|駙 驸|駚 𩧫|駛 驶|駝 驼|駞 𫘞|駟 驷|駡 骂|駢 骈|駤 𫘠|駧 𩧲|駩 𩧴|駪 𬳽|駫 𫘡|駭 骇|駰 骃|駱 骆|駶 𩧺|駸 骎|駻 𫘣|駼 𬳿|駿 骏|騁 骋|騂 骍|騃 𫘤|騄 𫘧|騅 骓|騉 𫘥|騊 𫘦|騌 骔|騍 骒|騎 骑|騏 骐|騑 𬴂|騔 𩨀|騖 骛|騙 骗|騚 𩨊|騜 𫘩|騝 𩨃|騞 𬴃|騟 𩨈|騠 𫘨|騤 骙|騧 䯄|騪 𩨄|騫 骞|騭 骘|騮 骝|騰 腾|騱 𫘬|騴 𫘫|騵 𫘪|騶 驺|騷 骚|騸 骟|騻 𫘭|騼 𫠋|騾 骡|驀 蓦|驁 骜|驂 骖|驃 骠|驄 骢|驅 驱|驊 骅|驋 𩧯|驌 骕|驍 骁|驎 𬴊|驏 骣|驓 𫘯|驕 骄|驗 验|驙 𫘰|驚 惊|驛 驿|驟 骤|驢 驴|驤 骧|驥 骥|驦 骦|驨 𫘱|驪 骊|驫 骉|骯 肮|髏 髅|髒 脏|體 体|髕 髌|髖 髋|髮 发|鬆 松|鬍 胡|鬖 𩭹|鬚 须|鬠 𫘽|鬢 鬓|鬥 斗|鬧 闹|鬨 哄|鬩 阋|鬮 阄|鬱 郁|鬹 鬶|魎 魉|魘 魇|魚 鱼|魛 鱽|魟 𫚉|魢 鱾|魥 𩽹|魦 𫚌|魨 鲀|魯 鲁|魴 鲂|魵 𫚍|魷 鱿|魺 鲄|魽 𫠐|鮀 𬶍|鮁 鲅|鮃 鲆|鮄 𫚒|鮅 𫚑|鮆 𫚖|鮈 𬶋|鮊 鲌|鮋 鲉|鮍 鲏|鮎 鲇|鮐 鲐|鮑 鲍|鮒 鲋|鮓 鲊|鮚 鲒|鮜 鲘|鮝 鲞|鮞 鲕|鮟 𩽾|鮠 𬶏|鮡 𬶐|鮣 䲟|鮤 𫚓|鮦 鲖|鮪 鲔|鮫 鲛|鮭 鲑|鮮 鲜|鮯 𫚗|鮰 𫚔|鮳 鲓|鮵 𫚛|鮶 鲪|鮸 𩾃|鮺 鲝|鮿 𫚚|鯀 鲧|鯁 鲠|鯄 𩾁|鯆 𫚙|鯇 鲩|鯉 鲤|鯊 鲨|鯒 鲬|鯔 鲻|鯕 鲯|鯖 鲭|鯗 鲞|鯛 鲷|鯝 鲴|鯞 𫚡|鯡 鲱|鯢 鲵|鯤 鲲|鯧 鲳|鯨 鲸|鯪 鲮|鯫 鲰|鯬 𫚞|鯰 鲶|鯱 𩾇|鯴 鲺|鯶 𩽼|鯷 鳀|鯻 𬶟|鯽 鲫|鯾 𫚣|鯿 鳊|鰁 鳈|鰂 鲗|鰃 鳂|鰆 䲠|鰈 鲽|鰉 鳇|鰊 𬶠|鰋 𫚢|鰌 䲡|鰍 鳅|鰏 鲾|鰐 鳄|鰑 𫚊|鰒 鳆|鰓 鳃|鰕 𫚥|鰛 鳁|鰜 鳒|鰟 鳑|鰠 鳋|鰣 鲥|鰤 𫚕|鰥 鳏|鰦 𫚤|鰧 䲢|鰨 鳎|鰩 鳐|鰫 𫚦|鰭 鳍|鰮 鳁|鰱 鲢|鰲 鳌|鰳 鳓|鰵 鳘|鰶 𬶭|鰷 鲦|鰹 鲣|鰺 鲹|鰻 鳗|鰼 鳛|鰽 𫚧|鰾 鳔|鱀 𬶨|鱂 鳉|鱄 𫚋|鱅 鳙|鱆 𫠒|鱇 𩾌|鱈 鳕|鱉 鳖|鱊 𫚪|鱒 鳟|鱔 鳝|鱖 鳜|鱗 鳞|鱘 鲟|鱚 𬶮|鱝 鲼|鱟 鲎|鱠 鲙|鱢 𫚫|鱣 鳣|鱤 鳡|鱧 鳢|鱨 鲿|鱭 鲚|鱮 𫚈|鱯 鳠|鱲 𫚭|鱷 鳄|鱸 鲈|鱺 鲡|鳥 鸟|鳧 凫|鳩 鸠|鳬 凫|鳲 鸤|鳳 凤|鳴 鸣|鳶 鸢|鳷 𫛛|鳼 𪉃|鳽 𫛚|鳾 䴓|鴀 𫛜|鴃 𫛞|鴅 𫛝|鴆 鸩|鴇 鸨|鴉 鸦|鴐 𫛤|鴒 鸰|鴔 𫛡|鴕 鸵|鴗 𫁡|鴛 鸳|鴜 𪉈|鴝 鸲|鴞 鸮|鴟 鸱|鴣 鸪|鴥 𫛣|鴦 鸯|鴨 鸭|鴮 𫛦|鴯 鸸|鴰 鸹|鴲 𪉆|鴳 𫛩|鴴 鸻|鴷 䴕|鴻 鸿|鴽 𫛪|鴿 鸽|鵁 䴔|鵂 鸺|鵃 鸼|鵊 𫛥|鵏 𬷕|鵐 鹀|鵑 鹃|鵒 鹆|鵓 鹁|鵚 𪉍|鵜 鹈|鵝 鹅|鵟 𫛭|鵠 鹄|鵡 鹉|鵧 𫛨|鵩 𫛳|鵪 鹌|鵫 𫛱|鵬 鹏|鵮 鹐|鵯 鹎|鵰 雕|鵲 鹊|鵷 鹓|鵾 鹍|鶄 䴖|鶇 鸫|鶉 鹑|鶊 鹒|鶌 𫛵|鶒 𫛶|鶓 鹋|鶖 鹙|鶗 𫛸|鶘 鹕|鶚 鹗|鶠 𬸘|鶡 鹖|鶥 鹛|鶦 𫛷|鶩 鹜|鶪 䴗|鶬 鸧|鶭 𫛯|鶯 莺|鶰 𫛫|鶱 𬸣|鶲 鹟|鶴 鹤|鶹 鹠|鶺 鹡|鶻 鹘|鶼 鹣|鶿 鹚|鷀 鹚|鷁 鹢|鷂 鹞|鷄 鸡|鷅 𫛽|鷉 䴘|鷊 鹝|鷐 𫜀|鷓 鹧|鷔 𪉑|鷖 鹥|鷗 鸥|鷙 鸷|鷚 鹨|鷟 𬸦|鷣 𫜃|鷤 𫛴|鷥 鸶|鷦 鹪|鷨 𪉊|鷩 𫜁|鷫 鹔|鷭 𬸪|鷯 鹩|鷲 鹫|鷳 鹇|鷴 鹇|鷷 𫜄|鷸 鹬|鷹 鹰|鷺 鹭|鷽 鸴|鷿 𬸯|鸂 㶉|鸇 鹯|鸊 䴙|鸋 𫛢|鸌 鹱|鸏 鹲|鸑 𬸚|鸕 鸬|鸗 𫛟|鸘 鹴|鸚 鹦|鸛 鹳|鸝 鹂|鸞 鸾|鹵 卤|鹹 咸|鹺 鹾|鹼 碱|鹽 盐|麗 丽|麥 麦|麨 𪎊|麩 麸|麪 面|麫 面|麬 𤿲|麯 曲|麲 𪎉|麳 𪎌|麴 曲|麵 面|麷 𫜑|麼 么|麽 么|黃 黄|黌 黉|點 点|黨 党|黲 黪|黴 霉|黶 黡|黷 黩|黽 黾|黿 鼋|鼂 鼌|鼉 鼍|鼕 冬|鼴 鼹|齊 齐|齋 斋|齎 赍|齏 齑|齒 齿|齔 龀|齕 龁|齗 龂|齘 𬹼|齙 龅|齜 龇|齟 龃|齠 龆|齡 龄|齣 出|齦 龈|齧 啮|齩 𫜪|齪 龊|齬 龉|齭 𫜭|齮 𬺈|齯 𫠜|齰 𫜬|齲 龋|齴 𫜮|齶 腭|齷 龌|齼 𬺓|齾 𫜰|龍 龙|龎 厐|龐 庞|龑 䶮|龓 𫜲|龔 龚|龕 龛|龜 龟|龭 𩨎|龯 𨱆|鿁 䜤|鿓 鿒|𠁞 𠀾|𠌥 𠆿|𠏢 𠉗|𠐊 𫝋|𠗣 㓆|𠞆 𠛆|𠠎 𠚳|𠬙 𪠡|𠽃 𪠺|𠿕 𪜎|𡂡 𪢒|𡃄 𪡺|𡃕 𠴛|𡃤 𪢐|𡄔 𠴢|𡄣 𠵸|𡅏 𠲥|𡅯 𪢖|𡑍 𫭼|𡑭 𡋗|𡓁 𪤄|𡓾 𡋀|𡔖 𡍣|𡞵 㛟|𡟫 𫝪|𡠹 㛿|𡢃 㛠|𡮉 𡭜|𡮣 𡭬|𡳳 𡳃|𡸗 𪨩|𡹬 𪨹|𡻕 岁|𡽗 𡸃|𡾱 㟜|𡿖 𪩛|𢍰 𪪴|𢠼 𢙑|𢣐 𪬚|𢣚 𢘝|𢣭 𢘞|𢤩 𪫡|𢤱 𢘙|𢤿 𪬯|𢯷 𪭝|𢶒 𪭯|𢶫 𢫞|𢷮 𢫊|𢹿 𢬦|𢺳 𪮳|𣈶 暅|𣋋 𣈣|𣍐 𫧃|𣙎 㭣|𣜬 𪳗|𣝕 𣘷|𣞻 𣘓|𣠩 𣞎|𣠲 𣑶|𣯩 𣯣|𣯴 𣭤|𣯶 毶|𣽏 𪶮|𣾷 㳢|𣿉 𣶫|𤁣 𣺽|𤄷 𪶒|𤅶 𣷷|𤑳 𤎻|𤑹 𪹀|𤒎 𤊀|𤒻 𪹹|𤓌 𪹠|𤓎 𤎺|𤓩 𤊰|𤘀 𪺣|𤛮 𤙯|𤛱 𫞢|𤜆 𪺪|𤠮 𪺸|𤢟 𤝢|𤢻 𢢐|𤩂 𫞧|𤪺 㻘|𤫩 㻏|𤬅 𪼴|𤳷 𪽝|𤳸 𤳄|𤷃 𪽭|𤸫 𤶧|𤺔 𪽴|𥊝 𥅿|𥌃 𥅘|𥏝 𪿊|𥕥 𥐰|𥖅 𥐯|𥖲 𪿞|𥗇 𪿵|𥗽 𬒗|𥜐 𫀓|𥜰 𫀌|𥞵 𥞦|𥢢 䅪|𥢶 𫞷|𥢷 𫀮|𥨐 𥧂|𥪂 𥩺|𥯤 𫁳|𥴨 𫂖|𥴼 𫁺|𥵃 𥱔|𥵊 𥭉|𥶽 𫁱|𥸠 𥮋|𥻦 𫂿|𥼽 𥹥|𥽖 𥺇|𥾯 𫄝|𥿊 𦈈|𦀖 𫄦|𦂅 𦈒|𦃄 𦈗|𦃩 𫄯|𦅇 𫄪|𦅈 𫄵|𦆲 𫟇|𦒀 𫅥|𦔖 𫅼|𦘧 𡳒|𦟼 𫆝|𦠅 𫞅|𦡝 𫆫|𦢈 𣍨|𦣎 𦟗|𦧺 𫇘|𦪙 䑽|𦪽 𦨩|𦱌 𫇪|𦾟 𦶻|𧎈 𧌥|𧒯 𫊹|𧔥 𧒭|𧕟 𧉐|𧜗 䘞|𧜵 䙊|𧝞 䘛|𧞫 𫌋|𧟀 𧝧|𧡴 𫌫|𧢄 𫌬|𧦝 𫍞|𧦧 𫍟|𧩕 𫍭|𧩙 䜥|𧩼 𫍶|𧫝 𫍺|𧬤 𫍼|𧭈 𫍾|𧭹 𫍐|𧳟 𧳕|𧵳 䞌|𧶔 𧹓|𧶧 䞎|𧷎 𪠀|𧸘 𫎨|𧹈 𪥠|𧽯 𫎸|𨂐 𫏌|𨄣 𨀱|𨅍 𨁴|𨆪 𫏕|𨇁 𧿈|𨇞 𨅫|𨇤 𫏨|𨇰 𫏞|𨇽 𫏑|𨈊 𨂺|𨈌 𨄄|𨊰 䢀|𨊸 䢁|𨊻 𨐆|𨋢 䢂|𨌈 𫐍|𨍰 𫐔|𨎌 𫐋|𨎮 𨐉|𨏠 𨐇|𨏥 𨐊|𨞺 𫟫|𨟊 𫟬|𨢿 𨡙|𨣈 𨡺|𨣞 𨟳|𨣧 𨠨|𨤻 𨤰|𨥛 𨱀|𨥟 𫓫|𨦫 䦀|𨧀 𬭊|𨧜 䦁|𨧰 𫟽|𨧱 𨱊|𨨏 𬭛|𨨛 𫓼|𨨢 𫓿|𨩰 𫟾|𨪕 𫓮|𨫒 𨱐|𨬖 𫔏|𨭆 𬭶|𨭎 𬭳|𨭖 𫔑|𨭸 𫔐|𨮂 𨱕|𨮳 𫔒|𨯅 䥿|𨯟 𫔓|𨰃 𫔉|𨰋 𫓳|𨰥 𫔕|𨰲 𫔃|𨲳 𫔖|𨳑 𨸁|𨳕 𨸀|𨴗 𨸅|𨴹 𫔲|𨵩 𨸆|𨵸 𨸇|𨶀 𨸉|𨶏 𨸊|𨶮 𨸌|𨶲 𨸋|𨷲 𨸎|𨼳 𫔽|𨽏 𨸘|𩀨 𫕚|𩅙 𫕨|𩎖 𫖑|𩎢 𩏾|𩏂 𫖓|𩏠 𫖖|𩏪 𩏽|𩏷 𫃗|𩑔 𫖪|𩒎 𫖭|𩓣 𩖕|𩓥 𫖵|𩔑 𫖷|𩔳 𫖴|𩖰 𫠇|𩗀 𩙦|𩗓 𫗈|𩗴 𫗉|𩘀 𩙩|𩘝 𩙭|𩘹 𩙨|𩘺 𩙬|𩙈 𩙰|𩚛 𩟿|𩚥 𩠀|𩚩 𫗡|𩚵 𩠁|𩛆 𩠂|𩛌 𫗤|𩛡 𫗨|𩛩 𩠃|𩜇 𩠉|𩜦 𩠆|𩜵 𩠊|𩝔 𩠋|𩝽 𫗳|𩞄 𩠎|𩞦 𩠏|𩞯 䭪|𩟐 𩠅|𩟗 𫗚|𩠴 𩠠|𩡣 𩡖|𩡺 𩧦|𩢡 𩧬|𩢴 𩧵|𩢸 𩧳|𩢾 𩧮|𩣏 𩧶|𩣑 䯃|𩣫 𩧸|𩣵 𩧻|𩣺 𩧼|𩤊 𩧩|𩤙 𩨆|𩤲 𩨉|𩤸 𩨅|𩥄 𩨋|𩥇 𩨍|𩥉 𩧱|𩥑 𩨌|𩦠 𫠌|𩧆 𩨐|𩭙 𩬣|𩯁 𫙂|𩯳 𩯒|𩰀 𩬤|𩰹 𩰰|𩳤 𩲒|𩴵 𩴌|𩵦 𫠏|𩵩 𩽺|𩵹 𩽻|𩶁 𫚎|𩶘 䲞|𩶰 𩽿|𩶱 𩽽|𩷰 𩾄|𩸃 𩾅|𩸄 𫚝|𩸡 𫚟|𩸦 𩾆|𩻗 𫚨|𩻬 𫚩|𩻮 𫚘|𩼶 𫚬|𩽇 𩾎|𩿅 𫠖|𩿤 𫛠|𩿪 𪉄|𪀖 𫛧|𪀦 𪉅|𪀾 𪉋|𪁈 𪉉|𪁖 𪉌|𪂆 𪉎|𪃍 𪉐|𪃏 𪉏|𪃒 𫛻|𪃧 𫛹|𪄆 𪉔|𪄕 𪉒|𪅂 𫜂|𪆷 𫛾|𪇳 𪉕|𪈼 𱊜|𪉸 𫜊|𪋿 𫧮|𪌭 𫜓|𪍠 𫜕|𪓰 𫜟|𪔵 𪔭|𪘀 𪚏|𪘯 𪚐|𪙏 𫜯|𪟖 𠛾|𪷓 𣶭|𫒡 𫓷|𫜦 𫜫";

  var TSPhrases = "一目瞭然 一目了然|上鍊 上链|不瞭解 不了解|么麼 幺麽|么麽 幺麽|乾乾淨淨 干干净净|乾乾脆脆 干干脆脆|乾元 乾元|乾卦 乾卦|乾嘉 乾嘉|乾圖 乾图|乾坤 乾坤|乾坤一擲 乾坤一掷|乾坤再造 乾坤再造|乾坤大挪移 乾坤大挪移|乾宅 乾宅|乾斷 乾断|乾旦 乾旦|乾曜 乾曜|乾清宮 乾清宫|乾盛世 乾盛世|乾紅 乾红|乾綱 乾纲|乾縣 乾县|乾象 乾象|乾造 乾造|乾道 乾道|乾陵 乾陵|乾隆 乾隆|乾隆年間 乾隆年间|乾隆皇帝 乾隆皇帝|二噁英 二𫫇英|以免藉口 以免借口|以功覆過 以功复过|侔德覆載 侔德复载|傢俱 家具|傷亡枕藉 伤亡枕藉|八濛山 八濛山|凌藉 凌借|出醜狼藉 出丑狼藉|函覆 函复|千鍾粟 千锺粟|反反覆覆 反反复复|反覆 反复|反覆思維 反复思维|反覆思量 反复思量|反覆性 反复性|名覆金甌 名复金瓯|哪吒 哪吒|回覆 回复|壺裏乾坤 壶里乾坤|大目乾連冥間救母變文 大目乾连冥间救母变文|宫商角徵羽 宫商角徵羽|射覆 射复|尼乾陀 尼乾陀|幺麼 幺麽|幺麼小丑 幺麽小丑|幺麼小醜 幺麽小丑|康乾 康乾|張法乾 张法乾|彷彿 仿佛|彷徨 彷徨|徵弦 徵弦|徵絃 徵弦|徵羽摩柯 徵羽摩柯|徵聲 徵声|徵調 徵调|徵音 徵音|情有獨鍾 情有独钟|憑藉 凭借|憑藉着 凭借着|手鍊 手链|扭轉乾坤 扭转乾坤|找藉口 找借口|拉鍊 拉链|拉鍊工程 拉链工程|拜覆 拜复|據瞭解 据了解|文錦覆阱 文锦复阱|於世成 於世成|於乎 於乎|於仲完 於仲完|於倫 於伦|於其一 於其一|於則 於则|於勇明 於勇明|於呼哀哉 於呼哀哉|於單 於单|於坦 於坦|於崇文 於崇文|於忠祥 於忠祥|於惟一 於惟一|於戲 於戏|於敖 於敖|於梨華 於梨华|於清言 於清言|於潛 於潜|於琳 於琳|於穆 於穆|於竹屋 於竹屋|於菟 於菟|於邑 於邑|於陵子 於陵子|旋乾轉坤 旋乾转坤|旋轉乾坤 旋转乾坤|旋轉乾坤之力 旋转乾坤之力|明瞭 明了|明覆 明复|書中自有千鍾粟 书中自有千锺粟|有序 有序|朝乾夕惕 朝乾夕惕|木吒 木吒|李乾德 李乾德|李澤鉅 李泽钜|李鍊福 李链福|李鍾郁 李锺郁|樊於期 樊於期|沈沒 沉没|沈沒成本 沉没成本|沈積 沉积|沈船 沉船|沈默 沉默|流徵 流徵|浪蕩乾坤 浪荡乾坤|滑藉 滑借|無序 无序|牴牾 抵牾|牴觸 抵触|狐藉虎威 狐借虎威|珍珠項鍊 珍珠项链|甚鉅 甚钜|申覆 申复|畢昇 毕昇|發覆 发复|瞭如 了如|瞭如指掌 了如指掌|瞭望 瞭望|瞭然 了然|瞭然於心 了然于心|瞭若指掌 了若指掌|瞭解 了解|瞭解到 了解到|示覆 示复|神祇 神祇|稟覆 禀复|答覆 答复|篤麼 笃麽|簡單明瞭 简单明了|籌畫 筹划|素藉 素借|老態龍鍾 老态龙钟|肘手鍊足 肘手链足|茵藉 茵借|萬鍾 万锺|蒜薹 蒜薹|蕓薹 芸薹|蕩覆 荡复|蕭乾 萧乾|藉代 借代|藉以 借以|藉助 借助|藉助於 借助于|藉卉 借卉|藉口 借口|藉喻 借喻|藉寇兵 借寇兵|藉寇兵齎盜糧 借寇兵赍盗粮|藉手 借手|藉據 借据|藉故 借故|藉故推辭 借故推辞|藉方 借方|藉條 借条|藉槁 借槁|藉機 借机|藉此 借此|藉此機會 借此机会|藉甚 借甚|藉由 借由|藉着 借着|藉端 借端|藉端生事 借端生事|藉箸代籌 借箸代筹|藉草枕塊 借草枕块|藉藉 藉藉|藉藉无名 藉藉无名|藉詞 借词|藉讀 借读|藉資 借资|衹得 只得|衹見樹木 只见树木|衹見樹木不見森林 只见树木不见森林|袖裏乾坤 袖里乾坤|覆上 复上|覆住 复住|覆信 复信|覆冒 复冒|覆呈 复呈|覆命 复命|覆墓 复墓|覆宗 复宗|覆帳 复帐|覆幬 复帱|覆成 复成|覆按 复按|覆文 复文|覆杯 复杯|覆校 复校|覆瓿 复瓿|覆盂 复盂|覆盆 覆盆|覆盆子 覆盆子|覆盤 覆盘|覆育 复育|覆蕉尋鹿 复蕉寻鹿|覆逆 复逆|覆醢 复醢|覆醬瓿 复酱瓿|覆電 复电|覆露 复露|覆鹿尋蕉 复鹿寻蕉|覆鹿遺蕉 复鹿遗蕉|覆鼎 复鼎|見覆 见复|角徵 角徵|角徵羽 角徵羽|計畫 计划|變徵 变徵|變徵之聲 变徵之声|變徵之音 变徵之音|貂覆額 貂复额|買臣覆水 买臣复水|踅門瞭戶 踅门了户|躪藉 躏借|郭子乾 郭子乾|酒逢知己千鍾少 酒逢知己千锺少|酒逢知己千鍾少話不投機半句多 酒逢知己千锺少话不投机半句多|醞藉 酝借|重覆 重复|金吒 金吒|金鍊 金链|鈞覆 钧复|鉅子 钜子|鉅萬 钜万|鉅防 钜防|鉸鍊 铰链|銀鍊 银链|錢鍾書 钱锺书|鍊墜 链坠|鍊子 链子|鍊形 链形|鍊條 链条|鍊錘 链锤|鍊鎖 链锁|鍛鍾 锻锺|鍾繇 钟繇|鍾萬梅 锺万梅|鍾重發 锺重发|鍾鍛 锺锻|鍾馗 锺馗|鎖鍊 锁链|鐵鍊 铁链|鑽石項鍊 钻石项链|雁杳魚沈 雁杳鱼沉|雖覆能復 虽覆能复|電覆 电复|露覆 露复|項鍊 项链|頗覆 颇复|頸鍊 颈链|顛乾倒坤 颠乾倒坤|顛倒乾坤 颠倒乾坤|顧藉 顾借|麼些族 麽些族|黄鍾公 黄锺公|龍鍾 龙钟";

  var to_cn = [TSCharacters, TSPhrases];

  const fromDicts = {
      hk: from_hk,
      tw: from_tw,
      twp: from_twp,
      jp: from_jp
  };

  const toDicts = {
      cn: to_cn
  };

  var Locale = /*#__PURE__*/Object.freeze({
    __proto__: null,
    from: fromDicts,
    to: toDicts
  });

  const Converter = ConverterBuilder(Locale);

  exports.Converter = Converter;
  exports.ConverterFactory = ConverterFactory;
  exports.CustomConverter = CustomConverter;
  exports.HTMLConverter = HTMLConverter;
  exports.Locale = Locale;
  exports.Trie = Trie;

}));

(function exposeName2Profiles(global) {
  if (global.vpName2Profiles) return;

  const NAME2_PROFILES_KEY = "vpName2Profiles";
  const ACTIVE_PER_TAB_KEY = "vpName2ActivePerTab";
  const SESSION_ACTIVE_KEY = "vpName2ActiveProfile";

  function parseProfileFilename(filename) {
    const name = String(filename || "").trim();
    if (!name.startsWith("Name2-")) return null;

    const stripped = name.slice(6);
    const dotIndex = stripped.lastIndexOf(".");
    const body = dotIndex > 0 ? stripped.slice(0, dotIndex) : stripped;
    if (!body) return null;

    const parts = body.split("--").filter(Boolean);
    if (parts.length < 4) return null;

    const pathPrefixFormatted = parts[parts.length - 1];
    const host = normalizeHost(parts[parts.length - 2]);
    if (!host) return null;

    const priority = parseInt(parts[parts.length - 3], 10);
    if (!Number.isFinite(priority) || priority < 0) return null;

    const bookName = parts.slice(0, parts.length - 3).join("--").trim();
    if (!bookName) return null;

    const pathPrefix = "/" + pathPrefixFormatted.replace(/_/g, "/") + "/";

    return {
      priority,
      host,
      pathPrefix,
      bookName,
      segments: []
    };
  }

  function normalizeHost(host) {
    return String(host || "").trim().toLocaleLowerCase("en-US").replace(/^www\./, "");
  }

  function extractUrlIdentifiers(url) {
    try {
      const parsed = new URL(url);
      const host = normalizeHost(parsed.hostname);
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      const segments = pathParts.filter((part) => /^\d+$/.test(part));
      const pathPrefix = pathParts.length > 1
        ? "/" + pathParts.slice(0, -1).join("/") + "/"
        : "/";
      return { host, segments, pathPrefix };
    } catch (e) {
      return { host: "", segments: [], pathPrefix: "/" };
    }
  }

  function profileMatchesUrl(profile, urlInfo) {
    if (!profile || !urlInfo) return false;
    if (!profile.host || profile.host !== urlInfo.host) return false;
    if (profile.pathPrefix && profile.pathPrefix !== urlInfo.pathPrefix) return false;
    return true;
  }

  function countMatchingSegments(profileSegments, urlSegments) {
    if (!profileSegments || !profileSegments.length) return 0;
    return profileSegments.filter((seg) => urlSegments.includes(seg)).length;
  }

  function findMatchingProfiles(profiles, urlInfo) {
    const matching = (profiles || []).filter((p) => profileMatchesUrl(p, urlInfo));
    matching.sort((a, b) => {
      const aMatch = countMatchingSegments(a.segments, urlInfo.segments);
      const bMatch = countMatchingSegments(b.segments, urlInfo.segments);
      if (bMatch !== aMatch) return bMatch - aMatch;
      return (a.priority || 99) - (b.priority || 99);
    });
    return matching;
  }

  function mergeName2WithProfile(name2Entries, profileEntries) {
    const byKey = new Map();
    for (const e of name2Entries || []) {
      if (e.key) byKey.set(e.key, e.value);
    }
    for (const e of profileEntries || []) {
      if (e.key) byKey.set(e.key, e.value);
    }
    return Array.from(byKey.entries())
      .map(([key, value]) => ({ key, value }))
      .filter((e) => e.key && e.value);
  }

  function generateProfileId(priority, host, pathPrefix) {
    const pathPart = pathPrefix
      ? pathPrefix.replace(/^\/|\/$/g, "").replace(/\//g, "_").replace(/[^a-z0-9_]/gi, "")
      : "";
    return `prof_${priority}_${host.replace(/[^a-z0-9]/g, "")}_${pathPart}`;
  }

  async function loadProfiles() {
    const api = global.vpBrowserApi;
    if (!api) return [];
    const stored = await api.storage.get([NAME2_PROFILES_KEY]);
    return Array.isArray(stored[NAME2_PROFILES_KEY]) ? stored[NAME2_PROFILES_KEY] : [];
  }

  async function saveProfiles(profiles) {
    const api = global.vpBrowserApi;
    if (!api) return;
    await api.storage.set({ [NAME2_PROFILES_KEY]: profiles });
  }

  async function deleteProfile(id) {
    const profiles = await loadProfiles();
    const next = profiles.filter((p) => p.id !== id);
    await saveProfiles(next);
    return next;
  }

  async function upsertProfile(profile) {
    const profiles = await loadProfiles();
    const idx = profiles.findIndex(
      (p) => p.id === profile.id
    );
    if (idx >= 0) {
      profiles[idx] = profile;
    } else {
      profiles.push(profile);
    }
    await saveProfiles(profiles);
    return profiles;
  }

  async function loadActivePerTab() {
    const api = global.vpBrowserApi;
    if (!api) return {};
    const stored = await api.storage.get([ACTIVE_PER_TAB_KEY]);
    return stored[ACTIVE_PER_TAB_KEY] || {};
  }

  async function setActiveForTab(tabId, profileId) {
    const api = global.vpBrowserApi;
    if (!api) return;
    const active = await loadActivePerTab();
    if (profileId) {
      active[String(tabId)] = profileId;
    } else {
      delete active[String(tabId)];
    }
    await api.storage.set({ [ACTIVE_PER_TAB_KEY]: active });
  }

  function parseDictionaryText(text) {
    const entries = [];
    const seen = new Set();
    const lines = String(text || "").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      const pair = splitEntry(line);
      if (!pair) continue;
      const key = pair[0].trim();
      const value = pair[1].trim();
      if (!key || !value || seen.has(key)) continue;
      seen.add(key);
      entries.push({ key, value });
    }
    return entries;
  }

  function stringifyEntries(entries) {
    return entries.map((e) => `${e.key || ""}=${e.value || ""}`).join("\n");
  }

  function splitEntry(line) {
    const separators = ["=>", "\t", "=", ":"];
    for (const separator of separators) {
      const index = line.indexOf(separator);
      if (index > 0) {
        return [line.slice(0, index), line.slice(index + separator.length)];
      }
    }
    return null;
  }

  function generateProfileFilename(profile) {
    const pathPrefix = profile.pathPrefix
      ? profile.pathPrefix.replace(/^\/|\/$/g, "").replace(/\//g, "_")
      : "";
    const padded = String(profile.priority).padStart(2, "0");
    return `Name2-${profile.bookName}--${padded}--${profile.host}--${pathPrefix}.txt`;
  }

  global.vpName2Profiles = {
    NAME2_PROFILES_KEY,
    ACTIVE_PER_TAB_KEY,
    SESSION_ACTIVE_KEY,
    parseProfileFilename,
    normalizeHost,
    extractUrlIdentifiers,
    profileMatchesUrl,
    countMatchingSegments,
    findMatchingProfiles,
    mergeName2WithProfile,
    generateProfileId,
    loadProfiles,
    saveProfiles,
    deleteProfile,
    upsertProfile,
    loadActivePerTab,
    setActiveForTab,
    parseDictionaryText,
    stringifyEntries,
    splitEntry,
    generateProfileFilename
  };
})(globalThis);
(() => {
  "use strict";

  const api = globalThis.vpBrowserApi;
  const IS_TOP = window === window.top;

  // ---- Hỗ trợ iframe -------------------------------------------------------
  // Mỗi frame là một content script riêng nên mỗi frame tự nạp trie (~37 MB).
  // Để không nổ RAM trên trang có nhiều iframe (quảng cáo, player, tracker),
  // iframe con chỉ được dịch khi: bật "translateSubframes", đủ lớn, và có đủ chữ Hán.
  const SUBFRAME_MIN_WIDTH = 0;
  const SUBFRAME_MIN_HEIGHT = 0;
  const SUBFRAME_MIN_CJK_CHARS = 1;
  const CJK_GLOBAL_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;

  function safeTopWindow() {
    try { void window.top.location.href; return window.top; } catch (e) { return null; }
  }

  // sessionStorage của tab: iframe cùng origin dùng chung với top; khác origin dùng của chính nó.
  const tabStore = {
    _s() {
      if (IS_TOP) return sessionStorage;
      const top = safeTopWindow();
      return top ? top.sessionStorage : sessionStorage;
    },
    getItem(k) { try { return this._s().getItem(k); } catch (e) { return null; } },
    setItem(k, v) { try { this._s().setItem(k, v); } catch (e) { /* ignore */ } },
    removeItem(k) { try { this._s().removeItem(k); } catch (e) { /* ignore */ } }
  };

  // URL của trang chứa (dùng để khớp profile Name2 và chọn host bị tắt).
  function getPageUrl() {
    if (IS_TOP) return location.href;
    const top = safeTopWindow();
    if (top) return top.location.href;
    try {
      const origins = location.ancestorOrigins; // Chromium
      if (origins && origins.length) return origins[origins.length - 1] + "/";
    } catch (e) { /* ignore */ }
    return document.referrer || location.href;
  }

  function isSubframeEligible() {
    if (IS_TOP) return true;
    if (settings.translateSubframes === false) return false;
    return window.innerWidth >= SUBFRAME_MIN_WIDTH && window.innerHeight >= SUBFRAME_MIN_HEIGHT;
  }
  const SETTINGS_KEY = "vpSettings";
  const DICT_KEY = "vpDictionary";
  const NAME2_KEY = "vpName2Dictionary";
  const VIETPHRASE2_KEY = "vpVietPhrase2Dictionary";
  const MACHINE_SETTINGS_KEY = "vpMachineSettings";
  const EDIT_PANEL_SIZE_KEY = "vpEditPanelSize";
  const PACKED_TRIE = "data/compiled-trie.vpt";
  const PACKED_HANVIET_TRIE = "data/compiled-hanviet.vpt";
  const PACKED_META = "data/compiled.vpd.meta.json";
  const PACKED_FORMAT_VERSION = 2;
  const PACKED_TRIE_HEADER_SIZE = 32;
  const OVERFLOW_CHAR = 0xffff; // cạnh có mã ký tự > U+FFFF được tra trong bảng overflow
  const BASE_TRIE_RELEASE_DELAY_MS = 30000;
  const DICTIONARY_PROGRESS_TOTAL = 6;
  const DEFAULT_SETTINGS = {
    enabled: true, // Chế độ tự động dịch trang web tiếng Trung mặc định
    minChars: 1,
    batchSize: 40,
    translateTitle: true,
    simplifyTraditional: true,
    translateSubframes: true,
    disabledHosts: [],
    fontFamily: "default"
  };
  const FONT_FAMILIES = new Map([
    ["georgia", "Georgia, \"Times New Roman\", serif"],
    ["times", "\"Times New Roman\", Times, serif"],
    ["palatino", "\"Palatino Linotype\", Palatino, \"Book Antiqua\", serif"],
    ["cambria", "Cambria, Georgia, serif"],
    ["segoe", "\"Segoe UI\", Tahoma, sans-serif"],
    ["tahoma", "Tahoma, Geneva, sans-serif"],
    ["verdana", "Verdana, Geneva, sans-serif"],
    ["arial", "Arial, Helvetica, sans-serif"]
  ]);
  const VIETNAMESE_SAFE_FONT_STACK = "\"Segoe UI\", Tahoma, Arial, Helvetica, sans-serif";
  const FONT_STYLE_ID = "vp-vietnamese-font-style";
  const TRANSLATED_TEXT_STYLE_ID = "vp-translated-text-style";
  const DEBUG_PERF = false;
  const MUTATION_DEBOUNCE_MS = 100;
  // Phạm vi dịch theo STV: chỉ bỏ SCRIPT/STYLE (và ô nhập liệu, đã có xử lý riêng).
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION"
  ]);
  // Nhận diện phụ đề / danmaku để ưu tiên dịch nhanh (học từ STV-Lite)
  const SUBTITLE_HINT_RE = /subtitle|caption|vtt|sub-text|sub_text|player-sub|ytp-caption|bpx-player-subtitle|subtitle-text|danmaku|danmu|cue|track-text|subtitles?/i;
  const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
  const CHINESE_PUNCTUATION_RE = /[，。！？；：、（）【】《》「」『』“”‘’…～　〔〕〖〗]|——/;
  const POSSESSIVE_PARTICLE = "的";
  const PUNCTUATION_MAP = new Map([
    ["，", ","],
    ["。", "."],
    ["！", "!"],
    ["？", "?"],
    ["；", ";"],
    ["：", ":"],
    ["、", ","],
    ["（", "("],
    ["）", ")"],
    ["【", "["],
    ["】", "]"],
    ["《", "\""],
    ["》", "\""],
    ["「", "\""],
    ["」", "\""],
    ["『", "'"],
    ["』", "'"],
    ["“", "\""],
    ["”", "\""],
    ["‘", "'"],
    ["’", "'"],
    ["…", "..."],
    ["——", "-"],
    ["～", "~"],
    ["　", " "],
    ["〔", "["],
    ["〕", "]"],
    ["〖", "["],
    ["〗", "]"]
  ]);
  const CLOSING_PUNCTUATION = new Set([".", ",", "!", "?", ";", ":", ")", "]", "\"", "'"]);
  const OPENING_PUNCTUATION = new Set(["(", "[", "\"", "'"]);
  const WORD_END_RE = /[\p{L}\p{N}]$/u;
  const WORD_START_RE = /^[\p{L}\p{N}]/u;
  const FORM_TEXT_ATTRIBUTES = ["placeholder", "title"];
  const TRANSLATABLE_INPUT_VALUE_TYPES = new Set([
    "submit"
  ]);
  const ICON_CLASS_RE = /(^|\s)(material-icons|material-symbols(?:-[\w-]+)?|fa|fas|far|fab|fa-solid|fa-regular|fa-brands|iconfont|anticon|van-icon|el-icon|layui-icon|q-icon|mdi(?:-[\w-]+)?)(\s|$)/i;
  const ICON_TEXT_RE = /^[\s\p{S}\p{P}\uE000-\uF8FF]+$/u;

  let settings = { ...DEFAULT_SETTINGS };
  let dictionaryKeys = new Set();
  let customEntryMap = new Map();
  let name2EntryMap = new Map();
  let vietPhrase2EntryMap = new Map();
  let baseTrie = createEmptyPackedTrie();
  let hanVietTrie = createEmptyPackedTrie();
  let customTrie = createTrie([]);
  let name2Trie = createTrie([]);
  let vietPhrase2Trie = createTrie([]);
  let enabled = true;
  let tabDisabled = false;
  let originalText = new WeakMap();
  let textNodesWithOriginalText = new Set();
  let originalFormText = new WeakMap();
  let formElementsWithOriginalText = new Set();
  let translatedText = new WeakMap();
  let pendingNodes = [];
  let queuedNodes = new WeakSet();
  let processing = false;
  let observer = null;
  let pendingMutationRoots = [];
  let mutationTimer = 0;
  let editPanel = null;
  let editPanelTimer = 0;
  let editPanelState = null;
  let ignoreSelectionUntil = 0;
  let editPanelResultDraft = "";
  let hasEditPanelResultDraft = false;
  let editOpenButton = null;
  let pendingEditOpen = null;
  let editHighlight = null;
  let editPanelSyncFrame = 0;
  let editPanelViewportSnapshot = null;
  let editPanelSize = "m";
  let machineTranslateRequestId = 0;
  let lastMachineTranslateKey = "";
  let lastMachineTranslateLang = "";
  const editPanelJustSaved = new Map();
  const EDIT_SAVE_SKIP_MS = 300;
  let lastMachineTranslateResult = "";
  let openCcSimplifier = null;
  let openCcSimplifierInitialized = false;
  let translatedSegments = new WeakMap();
  let originalTitle = "";
  let dictionaryLoading = null;
  let isDictionaryReady = false;
  // Trie gốc (~37 MB) chỉ được nạp khi trang thật sự có chữ Hán.
  let baseTriesLoaded = false;
  let baseTriesPromise = null;
  let baseTriesReleaseTimer = 0;
  let bundledEntryHint = 0;
  let dictionaryStats = {
    bundled: 0,
    custom: 0,
    name2: 0,
    vietPhrase2: 0,
    total: 0,
    missing: []
  };
  let dictionaryProgress = {
    stage: "idle",
    current: 0,
    total: 1,
    percent: 0,
    label: "Chưa nạp"
  };

  init();

  function init() {
    setupMessages();
    setupSelectionEditor();
    startObserver();
    if (IS_TOP) startPeriodicScan();
    else setupSubframeResize();

    dictionaryLoading = reloadDictionary().then(() => {
      isDictionaryReady = true;
      if (enabled) queueDocument();
    });
  }

  // Quét định kỳ các vùng động (comment Bilibili, shadow DOM, custom elements) giống STV-Lite
  const DYNAMIC_SELECTORS = [
    // Bilibili comments
    ".bili-comment-text", ".comment-content", ".comment-item", ".reply-content",
    "[data-v-comment]", ".bili-comment", ".reply-item",
    // Danmaku / live
    ".bili-danmaku-x-dm", ".danmu-item", ".chat-item", ".danmu-content",
    // Subtitles
    ".bpx-player-subtitle-panel-text", ".bpx-player-subtitle-wrap",
    ".subtitle-item-text", ".subtitle-text", ".player-subtitle",
    ".vjs-text-track-cue", ".ytp-caption-segment",
    // Generic
    "[class*='comment']", "[class*='reply']", "[class*='danmu']", "[class*='danmaku']"
  ];

  // Iframe có thể được đổi kích thước/hiện ra muộn: kiểm tra lại khi resize.
  function setupSubframeResize() {
    let timer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (enabled && isDictionaryReady && isSubframeEligible()) queueDocument();
      }, 300);
    });
  }

  function startPeriodicScan() {
    setInterval(() => {
      if (!enabled || !isDictionaryReady) return;
      try {
        // Quét các selector phổ biến
        for (const selector of DYNAMIC_SELECTORS) {
          try {
            document.querySelectorAll(selector).forEach((el) => {
              queueNodeTree(el);
            });
          } catch (e) { /* selector lỗi trên một số trang */ }
        }

        // Xử lý shadow DOM của custom elements (Bilibili hay dùng)
        const customTags = [
          "bili-comment-thread-renderer",
          "bili-comment-item-renderer",
          "bili-comment-replies-renderer",
          "bili-comment-box",
          "bili-comments",
          "bili-comment"
        ];
        for (const tag of customTags) {
          const els = document.getElementsByTagName(tag);
          for (let i = 0; i < els.length; i++) {
            const el = els[i];
            queueNodeTree(el);
            if (el.shadowRoot) {
              queueNodeTree(el.shadowRoot);
            }
          }
        }

        // Quét vùng comment chính của Bilibili
        const commentRoots = document.querySelectorAll(
          "#comment, .comment, .bili-comment, .reply-list, .comment-list, [class*='comment-container'], [class*='Comment']"
        );
        commentRoots.forEach((el) => queueNodeTree(el));

        scheduleWork();
      } catch (err) {
        // im lặng
      }
    }, 1200);
  }

  async function reloadDictionary() {
    isDictionaryReady = false;
    setDictionaryProgress("storage", 0, DICTIONARY_PROGRESS_TOTAL, "Đọc thiết lập");
    const startedAt = now();
    const stored = await api.storage.get([SETTINGS_KEY, DICT_KEY, NAME2_KEY, VIETPHRASE2_KEY, EDIT_PANEL_SIZE_KEY]);
    settings = normalizeSettings(stored[SETTINGS_KEY] || {});
    editPanelSize = normalizeEditPanelSize(stored[EDIT_PANEL_SIZE_KEY]);
    let savedTabDisabled;
    try { savedTabDisabled = JSON.parse(tabStore.getItem("vpTabDisabled")); } catch (e) { /* ignore */ }
    tabDisabled = savedTabDisabled !== null && savedTabDisabled !== undefined
      ? savedTabDisabled
      : settings.enabled === false;
    enabled = isCurrentPageEnabled();
    applyConfiguredFont();
    let missingFiles = dictionaryStats.missing || [];
    if (baseTriesLoaded || baseTriesPromise || (enabled && documentHasCjk())) {
      const trieData = await ensureBaseTries();
      missingFiles = trieData.missing;
    } else {
      bundledEntryHint = await fetchBundledEntryCount();
    }
    const bundledCount = baseTriesLoaded ? baseTrie.entryCount : bundledEntryHint;
    const parsedAt = now();
    setDictionaryProgress(
      "personal",
      5,
      DICTIONARY_PROGRESS_TOTAL,
      "Dựng trie cá nhân"
    );
    const custom = normalizeEntryList(stored[DICT_KEY] || []);
    const name2Base = normalizeEntryList(stored[NAME2_KEY] || []);
    const vietPhrase2Raw = normalizeStoredEntryList(stored[VIETPHRASE2_KEY] || []);
    const vietPhrase2 = vietPhrase2Raw.map(
      (e) => ({ key: e.key, value: pickPrimaryMeaning(e.value) })
    );

    let name2 = name2Base;
    const name2Profiles = globalThis.vpName2Profiles;
    let activeProfileId = name2Profiles && tabStore.getItem(name2Profiles.SESSION_ACTIVE_KEY);
    if (!activeProfileId && name2Profiles) {
      const profiles = await name2Profiles.loadProfiles();
      const urlInfo = name2Profiles.extractUrlIdentifiers(getPageUrl());
      const matching = name2Profiles.findMatchingProfiles(profiles, urlInfo);
      if (matching.length > 0) {
        activeProfileId = matching[0].id;
        tabStore.setItem(name2Profiles.SESSION_ACTIVE_KEY, activeProfileId);
      }
    }
    if (activeProfileId && name2Profiles) {
      const profiles = await name2Profiles.loadProfiles();
      const activeProfile = profiles.find(p => p.id === activeProfileId);
      if (activeProfile && activeProfile.entries && activeProfile.entries.length) {
        name2 = name2Profiles.mergeName2WithProfile(name2Base, activeProfile.entries);
      }
    }

    customEntryMap = entriesToMap(custom);
    name2EntryMap = entriesToMap(name2);
    vietPhrase2EntryMap = entriesToMap(vietPhrase2Raw);
    customTrie = createTrie(custom);
    name2Trie = createTrie(name2);
    vietPhrase2Trie = createTrie(vietPhrase2);
    dictionaryKeys = new Set([
      ...custom.map((e) => e.key),
      ...name2.map((e) => e.key),
      ...vietPhrase2.map((e) => e.key)
    ]);
    dictionaryStats = {
      bundled: bundledCount,
      custom: custom.length,
      name2: name2.length,
      vietPhrase2: vietPhrase2.length,
      total: bundledCount + custom.length + name2.length + vietPhrase2.length,
      missing: missingFiles
    };
    perfLog("dictionary.parse.ms", parsedAt - startedAt);
    perfLog("dictionary.personalTrie.ms", now() - parsedAt);
    isDictionaryReady = true;
    setDictionaryProgress(
      "ready",
      DICTIONARY_PROGRESS_TOTAL,
      DICTIONARY_PROGRESS_TOTAL,
      "Sẵn sàng"
    );
  }

  function setupMessages() {
    if (!api.runtime || !api.runtime.onMessage) return;

    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.scope !== "vietphrase") return false;

      if (!IS_TOP) {
        // Iframe con áp dụng thay đổi nhưng KHÔNG trả lời, để phản hồi của top frame
        // (trạng thái hiển thị ở popup) không bị phản hồi của iframe chen vào.
        handleMessage(message).catch(() => {});
        return false;
      }

      if (api.usesPromiseApi) {
        return handleMessage(message);
      }

      handleMessage(message)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    });
  }

  const nativeStorage = api.nativeStorage;
  if (nativeStorage && nativeStorage.onChanged) {
    nativeStorage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const storageKeys = [NAME2_KEY, VIETPHRASE2_KEY, DICT_KEY];
      const changedStorageKeys = storageKeys.filter(k => k in changes);
      if (!changedStorageKeys.length) return;

      const nowMs = Date.now();
      const wasEditSave = changedStorageKeys.some(k => {
        const t = editPanelJustSaved.get(k);
        return t && (nowMs - t < EDIT_SAVE_SKIP_MS);
      });

      const viewportAnchor = captureViewportAnchor();

      for (const storageKey of changedStorageKeys) {
        const newEntries = normalizeStoredEntryList(changes[storageKey].newValue || []);

        if (storageKey === NAME2_KEY) {
          const normalized = normalizeEntryList(newEntries);
          name2EntryMap = entriesToMap(normalized);
          name2Trie = createTrie(normalized);
        } else if (storageKey === VIETPHRASE2_KEY) {
          const trieEntries = newEntries.map(
            e => ({ key: e.key, value: pickPrimaryMeaning(e.value) })
          );
          vietPhrase2EntryMap = entriesToMap(newEntries);
          vietPhrase2Trie = createTrie(trieEntries);
        } else if (storageKey === DICT_KEY) {
          const normalized = normalizeEntryList(newEntries);
          customEntryMap = entriesToMap(normalized);
          customTrie = createTrie(normalized);
        }
      }

      dictionaryKeys = new Set([
        ...customEntryMap.keys(),
        ...name2EntryMap.keys(),
        ...vietPhrase2EntryMap.keys()
      ]);
      dictionaryStats = {
        ...dictionaryStats,
        custom: customEntryMap.size,
        name2: name2EntryMap.size,
        vietPhrase2: vietPhrase2EntryMap.size,
        total: dictionaryStats.bundled + customEntryMap.size + name2EntryMap.size + vietPhrase2EntryMap.size
      };

      if (!wasEditSave && enabled) {
        refreshDocumentForEntry();
      }

      if (!wasEditSave) {
        restoreViewportAnchorSoon(viewportAnchor);
      }
    });
  }

  async function handleMessage(message) {
    if (message.type === "refresh") {
      dictionaryLoading = reloadDictionary();
      await dictionaryLoading;
      restoreDocument();
      if (enabled) queueDocument();
      return buildStatus();
    }

    if (message.type === "toggle") {
      settings = { ...settings, enabled: Boolean(message.enabled) };
      enabled = isCurrentPageEnabled();
      if (IS_TOP) await api.storage.set({ [SETTINGS_KEY]: settings });
      applyConfiguredFont();
      if (enabled) queueDocument();
      else { restoreDocument(); scheduleBaseTrieRelease(); }
      return buildStatus();
    }

    if (message.type === "toggleTab") {
      tabDisabled = message.disabled !== false;
      // Lưu trạng thái tab vào sessionStorage để persist qua chuyển trang cùng tab
      try { tabStore.setItem("vpTabDisabled", JSON.stringify(tabDisabled)); } catch (e) { /* ignore */ }
      enabled = isCurrentPageEnabled();
      applyConfiguredFont();
      if (enabled) queueDocument();
      else { restoreDocument(); scheduleBaseTrieRelease(); }
      return buildStatus();
    }

    if (message.type === "toggleSite") {
      const host = getCurrentHost();
      if (!host) return { ok: false, error: "Trang này không có hostname" };
      settings = setHostDisabled(settings, host, message.disabled !== false);
      enabled = isCurrentPageEnabled();
      if (IS_TOP) await api.storage.set({ [SETTINGS_KEY]: settings });
      applyConfiguredFont();
      if (enabled) queueDocument();
      else { restoreDocument(); scheduleBaseTrieRelease(); }
      return buildStatus();
    }

    if (message.type === "status") {
      if (dictionaryLoading && !isDictionaryReady) {
        return buildStatus();
      }
      return buildStatus();
    }

    if (message.type === "getMatchingProfiles") {
      const name2Profiles = globalThis.vpName2Profiles;
      if (!name2Profiles) return { ok: false, error: "Name2 profiles not available" };
      const profiles = await name2Profiles.loadProfiles();
      const urlInfo = name2Profiles.extractUrlIdentifiers(getPageUrl());
      const matching = name2Profiles.findMatchingProfiles(profiles, urlInfo);
      const activeProfileId = tabStore.getItem(name2Profiles.SESSION_ACTIVE_KEY) || null;
      return {
        ok: true,
        matchingProfiles: matching.map(p => ({
          id: p.id,
          priority: p.priority,
          host: p.host,
          pathPrefix: p.pathPrefix,
          bookName: p.bookName,
          entryCount: (p.entries || []).length
        })),
        activeProfileId
      };
    }

    if (message.type === "setActiveProfile") {
      const name2Profiles = globalThis.vpName2Profiles;
      if (!name2Profiles) return { ok: false, error: "Name2 profiles not available" };
      const profileId = message.profileId || null;
      if (profileId) {
        tabStore.setItem(name2Profiles.SESSION_ACTIVE_KEY, profileId);
      } else {
        tabStore.removeItem(name2Profiles.SESSION_ACTIVE_KEY);
      }
      dictionaryLoading = reloadDictionary();
      await dictionaryLoading;
      restoreDocument();
      if (enabled) queueDocument();
      return buildStatus();
    }

    return { ok: false, error: "Unknown message" };
  }

  function buildStatus() {
    return {
      ok: true,
      enabled,
      globalEnabled: settings.enabled !== false,
      tabDisabled,
      siteDisabled: isCurrentHostDisabled(),
      currentHost: getCurrentHost(),
      loading: !isDictionaryReady || Boolean(baseTriesPromise && !baseTriesLoaded),
      baseTriesLoaded,
      entries: dictionaryStats.total,
      bundledEntries: dictionaryStats.bundled,
      customEntries: dictionaryStats.custom,
      name2Entries: dictionaryStats.name2,
      vietPhrase2Entries: dictionaryStats.vietPhrase2,
      missingFiles: dictionaryStats.missing,
      progress: dictionaryProgress
    };
  }

  function setDictionaryProgress(stage, current, total, label) {
    const safeTotal = Math.max(1, total);
    const safeCurrent = Math.min(safeTotal, Math.max(0, current));
    dictionaryProgress = {
      stage,
      current: safeCurrent,
      total: safeTotal,
      percent: Math.round((safeCurrent / safeTotal) * 100),
      label
    };
    updateDocumentStatus();
  }

  function updateDocumentStatus() {
    if (!document || !document.documentElement) return;
    const dataset = document.documentElement.dataset;
    dataset.vpStatus = dictionaryProgress.stage;
    dataset.vpProgress = String(dictionaryProgress.percent);
    dataset.vpProgressLabel = dictionaryProgress.label;
    dataset.vpEntries = String(dictionaryStats.total || 0);
    dataset.vpBundledEntries = String(dictionaryStats.bundled || 0);
    dataset.vpName2Entries = String(dictionaryStats.name2 || 0);
    dataset.vpVietPhrase2Entries = String(dictionaryStats.vietPhrase2 || 0);
    dataset.vpMissingFiles = (dictionaryStats.missing || []).join(",");
  }

  function applyConfiguredFont() {
    const existing = document.getElementById(FONT_STYLE_ID);
    const family = enabled ? FONT_FAMILIES.get(settings.fontFamily) : "";

    if (!enabled || !family) {
      if (existing) existing.remove();
      if (document.documentElement) delete document.documentElement.dataset.vpFontFamily;
      if (document.documentElement) delete document.documentElement.dataset.vpCompactText;
      return;
    }

    const style = existing || document.createElement("style");
    style.id = FONT_STYLE_ID;
    style.textContent = `
      html[data-vp-font-family] body :not(.vp-edit-panel):not(.vp-edit-panel *):not(button):not(button *):not(input):not(textarea):not(select):not(svg):not(svg *):not(canvas):not(code):not(pre):not(kbd):not(samp):not([class*="icon" i]):not([class*="fa-" i]):not(video):not(video *):not(audio):not(audio *):not(iframe) {
        font-family: ${family} !important;
      }
    `;
    if (family) document.documentElement.dataset.vpFontFamily = settings.fontFamily;
    else delete document.documentElement.dataset.vpFontFamily;
    delete document.documentElement.dataset.vpCompactText;
    if (!existing) document.documentElement.appendChild(style);
  }

  function ensureTranslatedTextStyle() {
    if (document.getElementById(TRANSLATED_TEXT_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = TRANSLATED_TEXT_STYLE_ID;
    style.textContent = `
      [data-vp-translated-text="1"],
      [data-vp-translated-text="1"] p,
      [data-vp-translated-text="1"] span {
        text-align: start !important;
        text-justify: auto !important;
        word-spacing: normal !important;
        letter-spacing: normal !important;
        word-break: keep-all !important;
        overflow-wrap: break-word !important;
        hyphens: auto !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function removeTranslatedTextStyle() {
    const style = document.getElementById(TRANSLATED_TEXT_STYLE_ID);
    if (style) style.remove();
  }

  function markTranslatedTextParent(element) {
    if (!shouldMarkTranslatedTextParent(element)) return;
    ensureTranslatedTextStyle();
    element.dataset.vpTranslatedText = "1";
  }

  function cleanupTranslatedTextParent(element) {
    if (!element || !element.dataset || element.dataset.vpTranslatedText !== "1") return;
    if (elementHasTranslatedText(element)) return;
    delete element.dataset.vpTranslatedText;
  }

  function clearTranslatedTextMarkers(root = document) {
    const elements = root.querySelectorAll ? root.querySelectorAll("[data-vp-translated-text]") : [];
    for (const element of elements) {
      delete element.dataset.vpTranslatedText;
    }
    removeTranslatedTextStyle();
  }

  function shouldMarkTranslatedTextParent(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (shouldSkipElement(element)) return false;
    if (isIconLikeElement(element, "")) return false;
    return true;
  }

  function elementHasTranslatedText(element) {
    if (!element || !element.childNodes) return false;
    for (const child of element.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE) continue;
      const original = originalText.get(child);
      const translated = translatedText.get(child);
      if (original && translated && translated !== original && child.nodeValue === translated) {
        return true;
      }
    }
    return false;
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      let hasNormal = false;
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && shouldSkipElement(node)) continue;
            if (node.nodeType === Node.TEXT_NODE && node.parentElement && shouldSkipElement(node.parentElement)) continue;

            // Phụ đề → dịch ngay (không chờ debounce)
            if (isLikelySubtitle(node)) {
              queueNodeTree(node);
              scheduleWorkImmediate();
            } else {
              pendingMutationRoots.push(node);
              hasNormal = true;
            }
          }
        } else if (mutation.type === "characterData") {
          const target = mutation.target;
          const parent = target && target.parentElement;
          if (!parent || shouldSkipElement(parent)) continue;

          if (isLikelySubtitle(target) || isLikelySubtitle(parent)) {
            // Xóa bản dịch cũ để dịch lại khi phụ đề thay đổi
            if (originalText.has(target)) {
              originalText.delete(target);
              translatedText.delete(target);
              translatedSegments.delete(target);
              textNodesWithOriginalText.delete(target);
            }
            queueTextNode(target);
            scheduleWorkImmediate();
          } else {
            pendingMutationRoots.push(target);
            hasNormal = true;
          }
        } else if (mutation.type === "attributes") {
          if (!shouldSkipElement(mutation.target)) {
            pendingMutationRoots.push(mutation.target);
            hasNormal = true;
          }
        }
      }
      if (hasNormal) scheduleMutationFlush();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["placeholder", "title", "aria-label", "value"]
    });
  }

  function scheduleMutationFlush() {
    clearTimeout(mutationTimer);
    mutationTimer = window.setTimeout(() => {
      const roots = pendingMutationRoots;
      pendingMutationRoots = [];
      for (const root of roots) {
        queueNodeTree(root);
      }
      scheduleWork();
    }, MUTATION_DEBOUNCE_MS);
  }

  // Ưu tiên cao cho phụ đề: dùng rAF thay vì requestIdleCallback
  function scheduleWorkImmediate() {
    if (processing) return;
    processing = true;
    requestAnimationFrame(() => {
      processBatch({ timeRemaining: () => 16 });
    });
  }

  function queueDocument() {
    if (!document.body) return;
    if (!baseTriesLoaded) {
      // Trang không có chữ Hán thì không tốn 37 MB cho từ điển.
      if (documentHasCjk()) requestBaseTries();
      return;
    }
    queueNodeTree(document.body);
    if (IS_TOP && settings.translateTitle && document.title) {
      if (!originalTitle) originalTitle = document.title;
      document.title = translateText(originalTitle);
    }
    scheduleWork();
  }

  // Theo dõi các shadow root đã observe để tránh trùng
  const observedShadowRoots = new WeakSet();

  function queueNodeTree(root) {
    if (!root) return;

    if (root.nodeType === Node.TEXT_NODE) {
      queueTextNode(root);
      return;
    }

    // ShadowRoot hoặc DocumentFragment
    if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE || (root.host != null)) {
      // Observe shadow root để bắt nội dung động
      if (root.host != null && !observedShadowRoots.has(root)) {
        observedShadowRoots.add(root);
        observeShadowRoot(root);
      }
      if (root.childNodes) {
        for (const child of Array.from(root.childNodes)) {
          queueNodeTree(child);
        }
      }
      return;
    }

    if (root.nodeType !== Node.ELEMENT_NODE) return;

    // Bỏ qua thẻ không cần dịch
    if (SKIP_TAGS.has(root.tagName)) return;
    if (root.isContentEditable) return;

    queueFormControlText(root);
    queueFormControls(root);

    // Vào shadow DOM nếu có (quan trọng với Bilibili comments)
    if (root.shadowRoot) {
      queueNodeTree(root.shadowRoot);
    }

    // Nếu nằm trong vùng player (không phải subtitle) thì bỏ qua toàn bộ cây
    if (shouldSkipElement(root) && !isLikelySubtitle(root)) {
      return;
    }

    // Duyệt đệ quy childNodes giống STV-Lite (bắt được nhiều hơn TreeWalker trên một số site)
    if (root.childNodes && root.childNodes.length) {
      for (const child of Array.from(root.childNodes)) {
        queueNodeTree(child);
      }
    }
  }

  function observeShadowRoot(shadowRoot) {
    try {
      const mo = new MutationObserver((mutations) => {
        if (!enabled) return;
        for (const mutation of mutations) {
          if (mutation.type === "childList") {
            for (const node of mutation.addedNodes) {
              queueNodeTree(node);
            }
          } else if (mutation.type === "characterData") {
            queueNodeTree(mutation.target);
          }
        }
        scheduleWork();
      });
      mo.observe(shadowRoot, {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch (e) {
      // một số shadow root có thể không observe được
    }
  }

  function queueTextNode(node) {
    if (!shouldProcessText(node.nodeValue) || queuedNodes.has(node)) return;
    if (!baseTriesLoaded) requestBaseTries();
    queuedNodes.add(node);
    pendingNodes.push(node);
  }

  function scheduleWork() {
    if (processing) return;
    processing = true;
    scheduleIdle(processBatch);
  }

  function processBatch(deadline) {
    if (!baseTriesLoaded) {
      // Chưa có từ điển: giữ nguyên hàng đợi, sẽ chạy lại khi nạp xong.
      processing = false;
      return;
    }
    const maxBatch = Math.max(10, Number(settings.batchSize) || DEFAULT_SETTINGS.batchSize);
    let processed = 0;
    const startedAt = now();

    while (pendingNodes.length && processed < maxBatch && hasIdleTime(deadline)) {
      const node = pendingNodes.shift();
      queuedNodes.delete(node);
      translateNode(node);
      processed += 1;
    }

    if (processed) {
      perfLog("dom.batch", { nodes: processed, ms: now() - startedAt });
    }

    if (pendingNodes.length) {
      scheduleIdle(processBatch);
    } else {
      processing = false;
      setTimeout(fixNavOverflow, 100);
      setTimeout(fixMobileOverflow, 150);
    }
  }

  function translateNode(node) {
    const value = node.nodeValue;
    if (!shouldProcessText(value)) return;
    const parent = node.parentElement;
    if (!shouldTranslateVisibleTextInElement(parent, value)) return;
    if (!originalText.has(node)) {
      originalText.set(node, value);
      textNodesWithOriginalText.add(node);
    }

    const source = originalText.get(node);
    const result = translateTextWithSegments(source);
    const translated = result.text;
    translatedSegments.set(node, result.segments);
    translatedText.set(node, translated);
    if (translated !== source) {
      node.nodeValue = translated;
      markTranslatedTextParent(parent);
    } else {
      cleanupTranslatedTextParent(parent);
    }
  }

  function queueFormControls(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    for (const element of root.querySelectorAll("input, textarea, select, option")) {
      queueFormControlText(element);
    }
  }

  function queueFormControlText(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || shouldSkipFormElement(element)) return;

    for (const attribute of FORM_TEXT_ATTRIBUTES) {
      translateElementField(
        element,
        `attr:${attribute}`,
        () => element.getAttribute(attribute) || "",
        (value) => {
          if (value) element.setAttribute(attribute, value);
          else element.removeAttribute(attribute);
        }
      );
    }

    if (element.tagName === "OPTION") {
      translateElementField(
        element,
        "text",
        () => element.textContent || "",
        (value) => {
          element.textContent = value;
        }
      );
      return;
    }

    if (shouldTranslateElementValue(element)) {
      translateElementField(
        element,
        "value",
        () => element.value || "",
        (value) => {
          element.value = value;
        }
      );
    }
  }

  function translateElementField(element, field, read, write) {
    const current = read();
    let fields = originalFormText.get(element);
    let record = fields ? fields.get(field) : null;
    let source = current;

    if (record) {
      if (current === record.translated) {
        source = record.source;
      } else if (current !== record.source) {
        source = current;
      } else {
        source = record.source;
      }
    }

    if (!shouldProcessText(source)) return;

    const translated = translateText(source);
    if (translated === source) return;

    if (!fields) {
      fields = new Map();
      originalFormText.set(element, fields);
      formElementsWithOriginalText.add(element);
    }
    fields.set(field, { source, translated });
    write(translated);
  }

  function shouldTranslateElementValue(element) {
    const tagName = element.tagName;
    if (tagName === "INPUT") {
      const type = String(element.getAttribute("type") || "text").toLocaleLowerCase("en-US");
      return TRANSLATABLE_INPUT_VALUE_TYPES.has(type) || element.readOnly || element.disabled;
    }
    if (tagName === "TEXTAREA") {
      return element.readOnly || element.disabled;
    }
    return false;
  }

  function restoreFormControlText() {
    for (const element of formElementsWithOriginalText) {
      const fields = originalFormText.get(element);
      if (!fields) continue;

      for (const [field, record] of fields.entries()) {
        restoreElementField(element, field, record.source);
      }
    }
  }

  function restoreElementField(element, field, source) {
    if (!element || !field) return;
    if (field.startsWith("attr:")) {
      const attribute = field.slice(5);
      if (source) element.setAttribute(attribute, source);
      else element.removeAttribute(attribute);
      return;
    }
    if (field === "text") {
      element.textContent = source;
      return;
    }
    if (field === "value") {
      element.value = source;
    }
  }

  function restoreDocument() {
    clearEditHighlight();
    pendingNodes = [];
    queuedNodes = new WeakSet();
    translatedSegments = new WeakMap();

    if (originalTitle) {
      document.title = originalTitle;
    }

    if (document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const original = originalText.get(node);
        if (original) node.nodeValue = original;
        node = walker.nextNode();
      }
    }
    clearTranslatedTextMarkers();
    restoreFormControlText();
    restoreNavOverflow();
    restoreMobileOverflow();
  }

  function fixNavOverflow() {
	  const navSelectors = ['header', 'nav', '[role="navigation"]', '.headbox', '.menu1']; // Bổ sung class của twkan
	  
	  navSelectors.forEach(selector => {
		const elements = document.querySelectorAll(selector);
		elements.forEach(el => {
		  // 1. Xử lý lỗi tràn do Flexbox (Code cũ của bạn)
		  if (el.style.display === 'flex' || el.style.display === 'inline-flex') {
			if (el.scrollWidth > el.clientWidth) {
			  if (!el.hasAttribute('data-vp-fixed')) {
				el.setAttribute('data-vp-orig-flexwrap', el.style.flexWrap || '');
				el.setAttribute('data-vp-orig-height', el.style.height || '');
				el.style.flexWrap = 'wrap';
				el.style.height = 'auto';
				el.setAttribute('data-vp-fixed', '1');
			  }
			}
		  }
		  
		  // 2. BỔ SUNG: Xử lý lỗi tràn cho thanh Menu của twkan (Dùng float/block khiến chữ bị đẩy ra ngoài)
		  if (window.innerWidth <= 720 && (el.classList.contains('headbox') || el.classList.contains('menu1'))) {
			if (!el.hasAttribute('data-vp-fixed')) {
			  el.setAttribute('data-vp-orig-overflow', el.style.overflow || '');
			  el.setAttribute('data-vp-orig-height', el.style.height || '');
			  
			  el.style.setProperty('height', 'auto', 'important');
			  el.style.setProperty('overflow', 'visible', 'important'); // Cho phép menu rớt dòng tự nhiên xuống dưới
			  el.setAttribute('data-vp-fixed', '1');
			}
		  }
		});
	  });
	}

  function restoreNavOverflow() {
    document.querySelectorAll('[data-vp-fixed]').forEach(el => {
      if (el.dataset.vpOrigFlexWrap !== undefined) {
        el.style.flexWrap = el.dataset.vpOrigFlexWrap;
        delete el.dataset.vpOrigFlexWrap;
      }
      if (el.dataset.vpOrigHeight !== undefined) {
        el.style.height = el.dataset.vpOrigHeight;
        delete el.dataset.vpOrigHeight;
      }
      el.style.minHeight = '';
      delete el.dataset.vpFixed;
    });
  }

  function fixMobileOverflow() {
	  if (window.innerWidth > 720) return; // Chỉ chạy trên mobile

	  // Thêm các selector phổ biến của trang truyện vào đây
	  // Thêm '.content', '.show_per', '.read-content', '#content' tùy theo cấu trúc trang
	  const selectors = [
		'.txtnav', '#txtcontent', '[class*="txtcontent"]', 
		'.chapter-content', '.read-content', '#content', '.content', 
		'article', '.novel-content', 'body' // Thêm 'body' hoặc 'html' nếu muốn ép toàn trang
	  ];

	  selectors.forEach(selector => {
		const elements = document.querySelectorAll(selector);
		elements.forEach(el => {
		  // Nếu phần tử có khả năng bị tràn hoặc để chắc chắn không bị kéo ngang:
		  if (el.scrollWidth > el.clientWidth || selector === 'body' || selector === '#content') {
			if (!el.hasAttribute('data-vp-txt-fixed')) {
			  // Lưu lại thuộc tính cũ
			  el.setAttribute('data-vp-orig-txt-maxwidth', el.style.maxWidth || '');
			  el.setAttribute('data-vp-orig-txt-overflowx', el.style.overflowX || '');
			  el.setAttribute('data-vp-orig-txt-overflowwrap', el.style.overflowWrap || '');
			  el.setAttribute('data-vp-orig-txt-wordwrap', el.style.wordWrap || '');

			  // Ép CSS chuẩn để không bao giờ tràn màn hình mobile
			  el.style.setProperty('max-width', '100vw', 'important'); 
			  el.style.setProperty('overflow-x', 'hidden', 'important');
			  el.style.setProperty('overflow-wrap', 'break-word', 'important');
			  el.style.setProperty('word-wrap', 'break-word', 'important');
			  el.style.setProperty('box-sizing', 'border-box', 'important'); // Tránh padding làm tràn dòng

			  el.setAttribute('data-vp-txt-fixed', '1');
			}
		  }
		});
	  });
	}

  function restoreMobileOverflow() {
    document.querySelectorAll('[data-vp-txt-fixed]').forEach(el => {
      if (el.dataset.vpOrigTxtMaxWidth !== undefined) {
        el.style.maxWidth = el.dataset.vpOrigTxtMaxWidth;
        delete el.dataset.vpOrigTxtMaxWidth;
      }
      if (el.dataset.vpOrigTxtOverflowX !== undefined) {
        el.style.overflowX = el.dataset.vpOrigTxtOverflowX;
        delete el.dataset.vpOrigTxtOverflowX;
      }
      if (el.dataset.vpOrigTxtOverflowWrap !== undefined) {
        el.style.overflowWrap = el.dataset.vpOrigTxtOverflowWrap;
        delete el.dataset.vpOrigTxtOverflowWrap;
      }
      if (el.dataset.vpOrigTxtWordWrap !== undefined) {
        el.style.wordWrap = el.dataset.vpOrigTxtWordWrap;
        delete el.dataset.vpOrigTxtWordWrap;
      }
      delete el.dataset.vpTxtFixed;
    });
  }

  function refreshDocumentForEntry() {
    if (!enabled) return;
    refreshTextNodesForEntry();
    refreshFormControlsForEntry();
    refreshTitleForEntry();
  }

  function refreshTextNodesForEntry() {
    for (const node of Array.from(textNodesWithOriginalText)) {
      if (!node || !node.isConnected) {
        textNodesWithOriginalText.delete(node);
        continue;
      }

      const source = originalText.get(node);
      if (!source || !shouldProcessText(source)) continue;

      const result = translateTextWithSegments(source);
      translatedSegments.set(node, result.segments);
      translatedText.set(node, result.text);
      if (node.nodeValue !== result.text) node.nodeValue = result.text;
      if (result.text !== source) {
        markTranslatedTextParent(node.parentElement);
      } else {
        cleanupTranslatedTextParent(node.parentElement);
      }
    }
  }

  function refreshFormControlsForEntry() {
    for (const element of Array.from(formElementsWithOriginalText)) {
      if (!element || !element.isConnected) {
        formElementsWithOriginalText.delete(element);
        continue;
      }

      const fields = originalFormText.get(element);
      if (!fields || !Array.from(fields.values()).some((record) => shouldProcessText(String(record.source || "")))) {
        continue;
      }
      queueFormControlText(element);
    }
  }

  function refreshTitleForEntry() {
    if (!settings.translateTitle || !originalTitle) return;
    document.title = translateText(originalTitle);
  }

  function translateText(text) {
    return translateTextWithSegments(text).text;
  }

  function isLatinOrDigit(char) {
    return /[a-zA-Z0-9]/.test(char);
  }

  function translateTextWithSegments(text) {
    if (!shouldProcessText(text)) return { text, segments: [] };
    if (!baseTriesLoaded) {
      requestBaseTries();
      return { text, segments: [] };
    }

    const input = createTranslationInput(text);
    const source = input.text;
    const tokens = [];
    let index = 0;

    while (index < source.length) {
      const match = findLongestMatch(source, index);
      if (match) {
        if (source[index] === POSSESSIVE_PARTICLE && match.length === POSSESSIVE_PARTICLE.length) {
          tokens.push({ type: "space", value: " " });
        } else {
          tokens.push({
            type: "word",
            value: match.value,
            key: source.slice(index, index + match.length),
            sourceStart: input.mapIndex(index),
            sourceEnd: input.mapIndex(index + match.length)
          });
        }
        index += match.length;
        continue;
      }

      const punct = normalizeChinesePunctuationAt(source, index);
      if (punct) {
        tokens.push({ type: classifyPunctuation(punct.value), value: punct.value });
        index += punct.length;
        continue;
      }

      const char = source[index];
      tokens.push({ type: classifyRawChar(char), value: char });
      index += 1;
    }

    const merged = [];
    for (const token of tokens) {
      if (token.type === "raw"
          && isLatinOrDigit(token.value)
          && merged.length > 0
          && merged[merged.length - 1].type === "raw"
          && isLatinOrDigit(merged[merged.length - 1].value)) {
        merged[merged.length - 1].value += token.value;
      } else {
        merged.push(token);
      }
    }
    return joinTokens(merged);
  }

  function joinTokens(tokens) {
    return joinTokensWithOptions(tokens, { capitalize: true });
  }

  function joinTokensWithoutCapitalization(tokens) {
    return joinTokensWithOptions(tokens, { capitalize: false });
  }

  function joinTokensWithOptions(tokens, options = {}) {
    let output = "";
    let previousType = "";
    let previousToken = null;
    const rawSegments = [];

    for (const token of tokens) {
      if (!token.value) continue;

      if (token.type === "space") {
        output += token.value;
        previousType = "space";
        previousToken = token;
        continue;
      }

      if (shouldInsertSpace(output, previousType, previousToken, token)) {
        output += " ";
      }

      const start = output.length;
      output += token.value;
      if (token.type === "word" && token.key) {
        rawSegments.push({
          start,
          end: output.length,
          key: token.key,
          sourceStart: token.sourceStart,
          sourceEnd: token.sourceEnd
        });
      }
      previousType = token.type;
      previousToken = token;
    }

    const normalized = normalizePunctuationSpacingWithMap(output);
    const text = options.capitalize === false
      ? normalized.text
      : capitalizeSentenceStarts(normalized.text);
    return {
      text,
      segments: rawSegments.map((segment) => ({
        start: normalized.map[segment.start],
        end: normalized.map[segment.end],
        key: segment.key,
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd
      })).filter((segment) => segment.end > segment.start)
    };
  }

  function normalizePunctuationSpacing(text) {
    return normalizePunctuationSpacingWithMap(text).text;
  }

  function normalizePunctuationSpacingWithMap(text) {
    const source = String(text || "");
    const map = new Array(source.length + 1);
    let output = "";
    let lastEmitted = "";
    let insideQuotes = false;

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1] || "";
      const isHorizontalSpace = char === " " || char === "\t";
      map[index] = output.length;

      if (char === '"' || char === "'") {
        if (!insideQuotes) {
          if (lastEmitted && (WORD_END_RE.test(lastEmitted) || lastEmitted === ":")) {
            output += " ";
          }
          output += char;
          lastEmitted = char;
          insideQuotes = true;
        } else {
          output += char;
          lastEmitted = char;
          insideQuotes = false;
          if (next && WORD_START_RE.test(next)) {
            output += " ";
          }
        }
        map[index] = output.length;
        continue;
      }

      if (isHorizontalSpace && (/[,.!?;:\)\]]/.test(next) || (OPENING_PUNCTUATION.has(lastEmitted) && lastEmitted !== '"' && lastEmitted !== "'"))) {
        continue;
      }

      if (
        lastEmitted &&
        /[,.!?;:\)\]]/.test(lastEmitted) &&
        !/\s/.test(char) &&
        !/[\)\]\}"']/.test(char)
      ) {
        output += " ";
      } else if (lastEmitted === ":" && (char === "\"" || char === "'")) {
        output += " ";
      }

      output += char;
      lastEmitted = char;
    }

    map[source.length] = output.length;
    return { text: output, map };
  }

  function capitalizeSentenceStarts(text) {
    let output = "";
    let shouldCapitalize = true;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (shouldCapitalize && /\p{L}/u.test(char)) {
        output += char.toLocaleUpperCase("vi-VN");
        shouldCapitalize = false;
        continue;
      }

      output += char;

      if (char === "\n" || char === "." || char === "!" || char === "?") {
        shouldCapitalize = true;
      } else if (char === '"' || char === "'") {
        if (!shouldCapitalize) {
          const prev = output.slice(0, -1);
          const trimmed = prev.replace(/\s+$/, "");
          shouldCapitalize = trimmed.endsWith(":");
        }
      } else if (shouldCapitalize && /\S/.test(char) && !OPENING_PUNCTUATION.has(char)) {
        shouldCapitalize = false;
      }
    }

    return output;
  }

  function shouldInsertSpace(output, previousType, previousToken, token) {
    if (!output || previousType === "space") return false;
    if (token.type === "closingPunctuation") return false;
    if (previousType === "raw" && token.type === "raw") return false;
    if (isNumericWordToken(previousToken) && isNumericWordToken(token)) return false;

    const lastChar = output[output.length - 1];
    if (OPENING_PUNCTUATION.has(lastChar)) return false;
    if (/\s/.test(lastChar)) return false;
    if ((lastChar === ")" || lastChar === "]") &&
        (token.type === "word" || (token.type === "raw" && WORD_START_RE.test(token.value)))) {
      return true;
    }
    if (!WORD_END_RE.test(lastChar)) return false;

    return token.type === "word" || (token.type === "raw" && WORD_START_RE.test(token.value));
  }

  function classifyRawChar(char) {
    if (/\s/.test(char)) return "space";
    if (CJK_RE.test(char)) return "rawCjk";
    return "raw";
  }

  function isNumericWordToken(token) {
    return Boolean(token && token.type === "word" && /^[0-9]+$/.test(String(token.value || "").trim()));
  }

  function classifyPunctuation(value) {
    if (CLOSING_PUNCTUATION.has(value)) return "closingPunctuation";
    if (OPENING_PUNCTUATION.has(value)) return "openingPunctuation";
    return "punctuation";
  }

  function normalizeChinesePunctuationAt(text, index) {
    if (text.startsWith("……", index)) return { value: "...", length: 2 };
    if (text.startsWith("——", index)) return { value: "-", length: 2 };
    const char = text[index];
    if (!PUNCTUATION_MAP.has(char)) return null;
    return { value: PUNCTUATION_MAP.get(char), length: 1 };
  }

  function findLongestMatch(text, start) {
    const name2Match = findObjectTrieMatch(name2Trie, text, start);
    if (name2Match) return name2Match;

    const vp2Match = findObjectTrieMatch(vietPhrase2Trie, text, start);
    const vpMatch = findPackedTrieMatch(text, start);
    let bestVP = null;
    if (vp2Match && vpMatch) {
      bestVP = vp2Match.length >= vpMatch.length ? vp2Match : vpMatch;
    } else {
      bestVP = vp2Match || vpMatch;
    }

    if (bestVP && bestVP.length > 1) {
      let name2ConflictPos = null;
      for (let i = start + 1; i < start + bestVP.length; i++) {
        if (findObjectTrieMatch(name2Trie, text, i)) {
          name2ConflictPos = i;
          break;
        }
      }

      if (name2ConflictPos !== null) {
        const maxShorterLen = name2ConflictPos - start;
        const shorterVP2 = findObjectTrieMatchUpTo(vietPhrase2Trie, text, start, maxShorterLen);
        const shorterVP = findPackedTrieMatchUpTo(baseTrie, text, start, maxShorterLen);
        let bestShorterVP = null;
        if (shorterVP2 && shorterVP) {
          bestShorterVP = shorterVP2.length >= shorterVP.length ? shorterVP2 : shorterVP;
        } else {
          bestShorterVP = shorterVP2 || shorterVP;
        }

        if (bestShorterVP && bestShorterVP.length >= settings.minChars) {
          return bestShorterVP;
        }

        const charCode = text.codePointAt(start);
        const charLength = charCode > 0xffff ? 2 : 1;
        const charStr = text.slice(start, start + charLength);
        const singleCharValue = pickPrimaryMeaning(findPackedTrieExactValue(charStr));
        return singleCharValue
          ? { value: singleCharValue, length: charLength }
          : { value: charStr, length: charLength };
      }
    }
    if (bestVP) return bestVP;

    return findPackedTrieMatchFromTrie(hanVietTrie, text, start);
  }

  function findObjectTrieMatch(root, text, start) {
    let node = root;
    let best = null;
    let index = start;
    let matchedChars = 0;

    while (index < text.length) {
      const charCode = text.codePointAt(index);
      if (!charCode) break;
      const char = String.fromCodePoint(charCode);
      const charLength = char.length;
      node = node.children.get(char);
      if (!node) break;
      matchedChars += 1;
      if (node.value) {
        if (matchedChars >= settings.minChars) {
          best = { value: node.value, length: index - start + charLength };
        }
      }
      index += charLength;
    }

    return best;
  }

  function findObjectTrieMatchUpTo(root, text, start, maxLen) {
    let node = root;
    let best = null;
    let index = start;
    let matchedChars = 0;

    while (index < text.length && matchedChars < maxLen) {
      const charCode = text.codePointAt(index);
      if (!charCode) break;
      const char = String.fromCodePoint(charCode);
      const charLength = char.length;
      node = node.children.get(char);
      if (!node) break;
      matchedChars += 1;
      if (node.value) {
        if (matchedChars >= settings.minChars) {
          best = { value: node.value, length: index - start + charLength };
        }
      }
      index += charLength;
    }

    return best;
  }

  function isTrieEmpty(trie) {
    return !trie || !trie.nodeCount;
  }

  function findPackedTrieMatchFromTrie(trie, text, start) {
    return findPackedTrieMatchUpTo(trie, text, start, Infinity);
  }

  function findPackedTrieMatch(text, start) {
    return findPackedTrieMatchFromTrie(baseTrie, text, start);
  }

  // Giải mã giá trị một lần duy nhất ở node khớp dài nhất (không giải mã các node trung gian).
  function findPackedTrieMatchUpTo(trie, text, start, maxLen) {
    if (isTrieEmpty(trie)) return null;

    let nodeIndex = 0;
    let bestNode = -1;
    let bestLength = 0;
    let index = start;
    let matchedChars = 0;

    while (index < text.length && matchedChars < maxLen) {
      const charCode = text.codePointAt(index);
      if (!charCode) break;
      const charLength = charCode > 0xffff ? 2 : 1;
      const targetIndex = findPackedTrieChildFromTrie(trie, nodeIndex, charCode);
      if (targetIndex < 0) break;

      nodeIndex = targetIndex;
      matchedChars += 1;
      if (trie.valueIds[nodeIndex] > 0 && matchedChars >= settings.minChars) {
        bestNode = nodeIndex;
        bestLength = index - start + charLength;
      }
      index += charLength;
    }

    return bestNode < 0
      ? null
      : { value: readPackedTrieValueFromTrie(trie, bestNode), length: bestLength };
  }

  function findPackedTrieChild(nodeIndex, charCode) {
    return findPackedTrieChildFromTrie(baseTrie, nodeIndex, charCode);
  }

  // Node đánh số theo BFS: cạnh thứ k luôn trỏ tới node k + 1.
  function findPackedTrieChildFromTrie(trie, nodeIndex, charCode) {
    const edgeChars = trie.edgeChars;
    let low = trie.firstEdge[nodeIndex];
    let high = trie.firstEdge[nodeIndex + 1] - 1;

    while (low <= high) {
      const middle = (low + high) >> 1;
      let middleChar = edgeChars[middle];
      if (middleChar === OVERFLOW_CHAR) middleChar = trie.overflow.get(middle) || OVERFLOW_CHAR;
      if (middleChar === charCode) return middle + 1;
      if (middleChar < charCode) low = middle + 1;
      else high = middle - 1;
    }

    return -1;
  }

  function readPackedTrieValue(nodeIndex) {
    return readPackedTrieValueFromTrie(baseTrie, nodeIndex);
  }

  function readPackedTrieValueFromTrie(trie, nodeIndex) {
    const valueId = trie.valueIds[nodeIndex];
    if (!valueId) return "";
    const cached = trie.valueCache.get(valueId);
    if (cached !== undefined) return cached;
    const value = pickPrimaryMeaning(readStringById(trie, valueId));
    trie.valueCache.set(valueId, value);
    return value;
  }

  function readPackedTrieRawValue(nodeIndex) {
    return readPackedTrieRawValueFromTrie(baseTrie, nodeIndex);
  }

  function readPackedTrieRawValueFromTrie(trie, nodeIndex) {
    const valueId = trie.valueIds[nodeIndex];
    return valueId ? readStringById(trie, valueId) : "";
  }

  function readStringById(trie, valueId) {
    const start = trie.stringOffsets[valueId - 1];
    const end = trie.stringOffsets[valueId];
    return trie.decoder.decode(trie.stringBytes.subarray(start, end));
  }

  function createTrie(entries) {
    const root = { children: new Map(), value: "" };

    for (const entry of entries) {
      insertTrieEntry(root, entry.key, entry.value);
    }

    return root;
  }

  function insertTrieEntry(root, key, value) {
    if (!key || !value) return;
    let node = root;
    for (const char of key) {
      if (!node.children.has(char)) {
        node.children.set(char, { children: new Map(), value: "" });
      }
      node = node.children.get(char);
    }
    node.value = value;
  }

  function removeTrieEntry(root, key) {
    if (!key) return;
    let node = root;
    const path = [];
    for (const char of key) {
      if (!node.children.has(char)) return;
      path.push([node, char]);
      node = node.children.get(char);
    }
    node.value = "";
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const [parent, char] = path[i];
      const child = parent.children.get(char);
      if (child.children.size === 0 && !child.value) {
        parent.children.delete(char);
      } else {
        break;
      }
    }
  }

  function countCodePoints(value) {
    return Array.from(value).length;
  }

  function documentHasCjk() {
    if (!isSubframeEligible()) return false;
    if (IS_TOP && CJK_RE.test(document.title || "")) return true;
    const root = document.body || document.documentElement;
    if (!root) return false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let cjkChars = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && SKIP_TAGS.has(parent.tagName)) continue;
      if (shouldProcessText(node.nodeValue)) {
        if (IS_TOP) return true;
        // iframe: cần đủ chữ Hán để đáng nạp 37 MB từ điển
        const matches = node.nodeValue.match(CJK_GLOBAL_RE);
        cjkChars += matches ? matches.length : 0;
        if (cjkChars >= SUBFRAME_MIN_CJK_CHARS) return true;
      }
    }
    return false;
  }

  function ensureBaseTries() {
    clearTimeout(baseTriesReleaseTimer);
    if (baseTriesPromise) return baseTriesPromise;
    baseTriesPromise = loadTries().then((data) => {
      baseTrie = data.baseTrie;
      hanVietTrie = data.hanVietTrie;
      baseTriesLoaded = true;
      if (baseTrie.entryCount) bundledEntryHint = baseTrie.entryCount;
      dictionaryStats.bundled = bundledEntryHint;
      dictionaryStats.total = bundledEntryHint + dictionaryStats.custom + dictionaryStats.name2 + dictionaryStats.vietPhrase2;
      dictionaryStats.missing = data.missing;
      if (!enabled) scheduleBaseTrieRelease();
      return data;
    });
    return baseTriesPromise;
  }

  function requestBaseTries() {
    // Chờ từ điển cá nhân sẵn sàng; reloadDictionary tự quyết định nạp ở lần khởi tạo.
    if (baseTriesLoaded || baseTriesPromise || !enabled || !isDictionaryReady) return;
    if (!IS_TOP && !documentHasCjk()) return; // iframe nhỏ/ít chữ Hán: không nạp từ điển
    ensureBaseTries().then(() => {
      setDictionaryProgress("ready", DICTIONARY_PROGRESS_TOTAL, DICTIONARY_PROGRESS_TOTAL, "Sẵn sàng");
      if (enabled) queueDocument();
    });
  }

  function scheduleBaseTrieRelease() {
    clearTimeout(baseTriesReleaseTimer);
    if (!baseTriesLoaded) return;
    baseTriesReleaseTimer = window.setTimeout(() => {
      if (enabled) return;
      baseTrie = createEmptyPackedTrie();
      hanVietTrie = createEmptyPackedTrie();
      baseTriesLoaded = false;
      baseTriesPromise = null;
    }, BASE_TRIE_RELEASE_DELAY_MS);
  }

  async function fetchBundledEntryCount() {
    if (bundledEntryHint) return bundledEntryHint;
    try {
      const response = await api.fetchData(PACKED_META);
      if (!response.ok) return 0;
      const meta = await response.json();
      return Number(meta && meta.entryCount) || 0;
    } catch (error) {
      return 0;
    }
  }

  async function loadTries() {
    const missing = [];

    setDictionaryProgress("fetch", 1, DICTIONARY_PROGRESS_TOTAL, "Nạp compiled-trie.vpt");
    let baseTrieResult;
    try {
      baseTrieResult = await fetchPackedTrie(PACKED_TRIE, "Giải mã trie");
    } catch (error) {
      missing.push(`${PACKED_TRIE}: ${error.message}`);
      baseTrieResult = createEmptyPackedTrie();
    }

    setDictionaryProgress("fetch-hv", 3, DICTIONARY_PROGRESS_TOTAL, "Nạp compiled-hanviet.vpt");
    let hanVietTrieResult;
    try {
      hanVietTrieResult = await fetchPackedTrie(PACKED_HANVIET_TRIE, "Giải mã hanviet");
    } catch (error) {
      missing.push(`${PACKED_HANVIET_TRIE}: ${error.message}`);
      hanVietTrieResult = createEmptyPackedTrie();
    }

    return {
      baseTrie: baseTrieResult,
      hanVietTrie: hanVietTrieResult,
      missing
    };
  }

  async function fetchPackedTrie(path, decodeLabel) {
    const response = await api.fetchData(path);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    setDictionaryProgress("decode", path === PACKED_HANVIET_TRIE ? 4 : 2, DICTIONARY_PROGRESS_TOTAL, decodeLabel || "Giải mã trie");
    return decodePackedTrie(buffer);
  }

  function decodePackedTrie(buffer) {
    if (!buffer || buffer.byteLength < PACKED_TRIE_HEADER_SIZE) {
      throw new Error("file quá nhỏ");
    }

    const view = new DataView(buffer);
    const magic = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3)
    );
    if (magic !== "VPT2") {
      throw new Error("sai định dạng trie (cần VPT2)");
    }

    const version = view.getUint32(4, true);
    if (version !== PACKED_FORMAT_VERSION) {
      throw new Error(`version ${version} không hỗ trợ`);
    }

    const nodeCount = view.getUint32(8, true);
    const stringCount = view.getUint32(12, true);
    const stringBytesLength = view.getUint32(16, true);
    const entryCount = view.getUint32(20, true);
    const overflowCount = view.getUint32(24, true);
    const edgeCount = Math.max(0, nodeCount - 1);

    // Bố cục (đều căn 4 byte): firstEdge | valueIds | stringOffsets | edgeChars(+đệm) | overflow | stringBytes
    const firstEdgeStart = PACKED_TRIE_HEADER_SIZE;
    const valueIdsStart = firstEdgeStart + (nodeCount + 1) * 4;
    const stringOffsetsStart = valueIdsStart + nodeCount * 4;
    const edgeCharsStart = stringOffsetsStart + (stringCount + 1) * 4;
    const edgeCharsBytes = Math.ceil((edgeCount * 2) / 4) * 4;
    const overflowStart = edgeCharsStart + edgeCharsBytes;
    const stringBytesStart = overflowStart + overflowCount * 8;
    const expectedLength = stringBytesStart + stringBytesLength;

    if (expectedLength !== buffer.byteLength) {
      throw new Error("kích thước trie không khớp");
    }

    const overflowPairs = new Uint32Array(buffer, overflowStart, overflowCount * 2);
    const overflow = new Map();
    for (let i = 0; i < overflowCount; i += 1) {
      overflow.set(overflowPairs[i * 2], overflowPairs[i * 2 + 1]);
    }

    return {
      nodeCount,
      firstEdge: new Uint32Array(buffer, firstEdgeStart, nodeCount + 1),
      valueIds: new Uint32Array(buffer, valueIdsStart, nodeCount),
      stringOffsets: new Uint32Array(buffer, stringOffsetsStart, stringCount + 1),
      edgeChars: new Uint16Array(buffer, edgeCharsStart, edgeCount),
      overflow,
      stringBytes: new Uint8Array(buffer, stringBytesStart, stringBytesLength),
      valueCache: new Map(),
      decoder: new TextDecoder("utf-8"),
      entryCount
    };
  }

  function createEmptyPackedTrie() {
    return {
      nodeCount: 0,
      firstEdge: new Uint32Array(0),
      valueIds: new Uint32Array(0),
      stringOffsets: new Uint32Array(0),
      edgeChars: new Uint16Array(0),
      overflow: new Map(),
      stringBytes: new Uint8Array(0),
      valueCache: new Map(),
      decoder: new TextDecoder("utf-8"),
      entryCount: 0
    };
  }

  function normalizeEntryList(entries) {
    return Array.isArray(entries)
      ? entries
          .map((entry) => ({
            key: String(entry.key || "").trim(),
            value: pickPrimaryMeaning(entry.value)
          }))
          .filter((entry) => entry.key && entry.value)
      : [];
  }

  function entriesToMap(entries) {
    return new Map((entries || []).map((entry) => [entry.key, entry.value]));
  }

  function normalizeSettings(storedSettings) {
    const next = { ...DEFAULT_SETTINGS, ...(storedSettings || {}) };
    next.enabled = true; // Luôn giữ chế độ tự động dịch
    next.disabledHosts = normalizeHostList(next.disabledHosts);
    return next;
  }

  function normalizeHostList(hosts) {
    if (!Array.isArray(hosts)) return [];
    return [...new Set(hosts.map(normalizeHost).filter(Boolean))];
  }

  function normalizeHost(host) {
    return String(host || "").trim().toLocaleLowerCase("en-US").replace(/^www\./, "");
  }

  function getCurrentHost() {
    if (IS_TOP) return normalizeHost(location.hostname);
    try { return normalizeHost(new URL(getPageUrl()).hostname); } catch (e) { return normalizeHost(location.hostname); }
  }

  function isCurrentHostDisabled() {
    const host = getCurrentHost();
    return Boolean(host && settings.disabledHosts.includes(host));
  }

  function isCurrentPageEnabled() {
    if (!IS_TOP && settings.translateSubframes === false) return false;
    if (settings.enabled === false) {
      // Global tắt: tab toggle có thể ghi đè
      // Nếu !tabDisabled=true (người dùng bật tab) thì trang vẫn được dịch
      return !tabDisabled;
    }
    // Global bật: giữ nguyên logic cũ (cần tab + site đều không bị chặn)
    return !tabDisabled && !isCurrentHostDisabled();
  }

  function setHostDisabled(sourceSettings, host, disabled) {
    const normalizedHost = normalizeHost(host);
    const hosts = new Set(normalizeHostList(sourceSettings.disabledHosts));
    if (!normalizedHost) return { ...sourceSettings, disabledHosts: [...hosts].sort() };
    if (disabled) hosts.add(normalizedHost);
    else hosts.delete(normalizedHost);
    return {
      ...sourceSettings,
      disabledHosts: [...hosts].sort()
    };
  }

  function setupSelectionEditor() {
    document.addEventListener("selectionchange", () => {
      if (now() < ignoreSelectionUntil) return;
      clearTimeout(editPanelTimer);
      editPanelTimer = window.setTimeout(showPanelForSelection, 180);
    });
  }

  function showPanelForSelection() {
    if (!enabled) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      hideEditOpenButton();
      return;
    }

    const range = selection.getRangeAt(0);
    if (!range || shouldSkipSelection(range)) {
      hideEditOpenButton();
      return;
    }

    const selectedText = selection.toString().trim();
    const context = createSelectionEditContext(range, selectedText);
    if (!context.key || !CJK_RE.test(context.key)) {
      hideEditOpenButton();
      return;
    }

    if (isAndroidEnvironment()) {
      showEditOpenButton(range, context);
      return;
    }

    showEditPanel(range, context);
  }

  function shouldSkipSelection(range) {
    const container = range.commonAncestorContainer;
    const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    return !element || shouldSkipElement(element);
  }

  function createSelectionEditContext(range, selectedText) {
    const mapping = findOriginalSelectionMapping(range, selectedText);
    const key = simplifyChineseText(mapping.key || findOriginalKeyFromSelection(range, selectedText));
    const textNode = mapping.textNode || (range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer : null);
    const original = textNode
      ? originalText.get(textNode) || textNode.nodeValue || ""
      : "";
    const sourceSentence = CJK_RE.test(original) ? original : key;
    const sentence = simplifyChineseText(sourceSentence);
    const fallbackStart = findSourceStartForKey(textNode, key, range.startOffset);
    const startIndex = Number.isFinite(mapping.sourceStart)
      ? mapping.sourceStart
      : fallbackStart >= 0 ? fallbackStart : sentence.indexOf(key);
    const endIndex = Number.isFinite(mapping.sourceEnd)
      ? mapping.sourceEnd
      : startIndex >= 0 ? startIndex + key.length : key.length;
    return {
      key,
      sentence,
      startIndex: startIndex >= 0 ? startIndex : 0,
      endIndex: startIndex >= 0 ? endIndex : key.length,
      textNode,
      highlightStart: Number.isFinite(mapping.highlightStart) ? mapping.highlightStart : range.startOffset,
      highlightEnd: Number.isFinite(mapping.highlightEnd) ? mapping.highlightEnd : range.endOffset
    };
  }

  function findOriginalSelectionMapping(range, selectedText) {
    const start = range.startContainer;
    if (!start || start.nodeType !== Node.TEXT_NODE || !selectedText) return {};

    if (CJK_RE.test(selectedText) && range.endContainer === start) {
      const sourceStart = range.startOffset;
      return {
        key: simplifyChineseText(selectedText),
        textNode: start,
        sourceStart,
        sourceEnd: sourceStart + selectedText.length,
        highlightStart: range.startOffset,
        highlightEnd: range.endOffset
      };
    }

    const selectedByNode = [];
    const selectedNodes = getRangeTextNodes(range);
    for (const node of selectedNodes) {
      const segments = translatedSegments.get(node);
      if (!segments || !segments.length) continue;

      const selectionStart = node === range.startContainer ? range.startOffset : 0;
      const selectionEnd = node === range.endContainer
        ? range.endOffset
        : String(node.nodeValue || "").length;
      const selectedSegments = segments.filter((segment) => hasMeaningfulSegmentOverlap(segment, selectionStart, selectionEnd));
      if (selectedSegments.length) {
        selectedByNode.push({ node, selectionStart, selectionEnd, segments: selectedSegments });
      }
    }

    if (!selectedByNode.length) return {};

    const first = selectedByNode[0];
    const last = selectedByNode[selectedByNode.length - 1];
    const firstSegment = first.segments[0];
    const lastSegment = last.segments[last.segments.length - 1];
    const sameNode = first.node === last.node;

    return {
      key: selectedByNode.flatMap((item) => item.segments.map((segment) => segment.key)).join("").trim(),
      textNode: first.node,
      sourceStart: firstSegment.sourceStart,
      sourceEnd: lastSegment.sourceEnd,
      highlightStart: sameNode ? Math.min(...first.segments.map((segment) => segment.start)) : first.selectionStart,
      highlightEnd: sameNode ? Math.max(...first.segments.map((segment) => segment.end)) : first.selectionEnd
    };
  }

  function getRangeTextNodes(range) {
    if (range.startContainer === range.endContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
      return [range.startContainer];
    }

    const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
    if (!root) return [];

    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let node = walker.nextNode();
    while (node) {
      nodes.push(node);
      node = walker.nextNode();
    }
    return nodes;
  }

  function hasMeaningfulSegmentOverlap(segment, selectionStart, selectionEnd) {
    const overlapStart = Math.max(segment.start, selectionStart);
    const overlapEnd = Math.min(segment.end, selectionEnd);
    if (overlapEnd <= overlapStart) return false;
    const overlapLength = overlapEnd - overlapStart;
    const segmentLength = Math.max(1, segment.end - segment.start);
    return overlapLength / segmentLength >= 0.5;
  }

  function findHighlightRangeForKey(node, key, fallbackRange) {
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      return { start: fallbackRange.startOffset, end: fallbackRange.endOffset };
    }

    const segments = translatedSegments.get(node) || [];
    const matching = [];
    let combinedKey = "";
    for (const segment of segments) {
      if (!key.startsWith(combinedKey + segment.key)) {
        matching.length = 0;
        combinedKey = "";
      }
      if (key.startsWith(combinedKey + segment.key)) {
        matching.push(segment);
        combinedKey += segment.key;
        if (combinedKey === key) {
          return { start: matching[0].start, end: matching[matching.length - 1].end };
        }
      }
    }

    return { start: fallbackRange.startOffset, end: fallbackRange.endOffset };
  }

  function findSourceStartForKey(node, key, hintOffset) {
    const segments = translatedSegments.get(node) || [];
    let best = -1;
    let bestDistance = Infinity;
    let combinedKey = "";
    let firstSourceStart = -1;
    let firstSegmentStart = -1;
    for (const segment of segments) {
      if (!key.startsWith(combinedKey + segment.key)) {
        combinedKey = "";
        firstSourceStart = -1;
        firstSegmentStart = -1;
      }
      if (key.startsWith(combinedKey + segment.key)) {
        if (firstSourceStart < 0) {
          firstSourceStart = segment.sourceStart;
          firstSegmentStart = segment.start;
        }
        combinedKey += segment.key;
        if (combinedKey === key) {
          const distance = Number.isFinite(hintOffset)
            ? Math.abs(firstSegmentStart - hintOffset)
            : 0;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = firstSourceStart;
          }
          combinedKey = "";
          firstSourceStart = -1;
          firstSegmentStart = -1;
        }
      }
    }
    return best;
  }

  function findOriginalKeyFromSelection(range, selectedText) {
    const start = range.startContainer;
    if (CJK_RE.test(selectedText)) return simplifyChineseText(selectedText);

    if (start && start.nodeType === Node.TEXT_NODE) {
      const mapped = findMappedOriginalKey(range, selectedText);
      if (mapped) return mapped;

      const direct = String(start.nodeValue || "").slice(range.startOffset, range.endOffset).trim();
      if (CJK_RE.test(direct)) return simplifyChineseText(direct);
    }

    return "";
  }

  function findMappedOriginalKey(range, selectedText) {
    const start = range.startContainer;
    if (!start || start.nodeType !== Node.TEXT_NODE || !selectedText) return "";

    const segments = translatedSegments.get(start);
    if (!segments || !segments.length) return "";

    const selectionStart = range.startOffset;
    const selectionEnd = range.endContainer === start
      ? range.endOffset
      : selectionStart + selectedText.length;
    const keys = [];

    for (const segment of segments) {
      if (segment.end <= selectionStart) continue;
      if (segment.start >= selectionEnd) break;
      keys.push(segment.key);
    }

    return simplifyChineseText(keys.join("").trim());
  }

  function pickCjkRun(text, offset) {
    if (!text || !CJK_RE.test(text)) return "";
    let start = Math.min(offset, text.length);
    while (start > 0 && CJK_RE.test(text[start - 1])) start -= 1;
    let end = Math.min(offset, text.length);
    while (end < text.length && CJK_RE.test(text[end])) end += 1;
    return text.slice(start, end).trim();
  }

  function pickFirstCjkRun(text) {
    const match = String(text || "").match(/[\u3400-\u9fff\uf900-\ufaff]+/);
    return match ? match[0] : "";
  }

  function showEditOpenButton(range, context) {
    hideEditPanel();
    hideEditOpenButton();

    const rect = range.getBoundingClientRect();
    pendingEditOpen = {
      range: range.cloneRange(),
      context
    };

    editOpenButton = document.createElement("button");
    editOpenButton.type = "button";
    editOpenButton.className = "vp-edit-open-button";
    editOpenButton.dataset.vpIgnore = "1";
    editOpenButton.textContent = "Sửa";
    editOpenButton.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "min-width:56px",
      "min-height:40px",
      "padding:2px 14px",
      "border:1px solid rgba(8, 94, 78, 0.7)",
      "border-radius:8px",
      "background:#0f7b68",
      "color:#fff",
      "box-shadow:0 6px 16px rgba(0, 0, 0, 0.22)",
      `font:700 14px/1.35 Georgia, "Times New Roman", ${VIETNAMESE_SAFE_FONT_STACK}`,
      "cursor:pointer",
      "touch-action:manipulation",
      "user-select:none",
      "-webkit-user-select:none"
    ].join(";");
    editOpenButton.addEventListener("click", openPendingEditPanel);
    document.documentElement.appendChild(editOpenButton);
    positionEditOpenButton(rect);
  }

  function positionEditOpenButton(rect) {
    if (!editOpenButton) return;
    const viewport = getVisibleViewportBox(6);
    const gap = isAndroidEnvironment() ? 48 : 12;
    const width = 44;
    const height = 32;
    const viewportLeft = viewport.left;
    const viewportRight = viewport.right;
    const viewportTop = viewport.top;
    const viewportBottom = viewport.bottom;
    const rightSideLeft = rect.right + gap;
    let left = rightSideLeft;
    let top = rect.top + (rect.height - height) / 2;

    if (rightSideLeft + width > viewportRight) {
      const topBelow = rect.bottom + gap;
      const topAbove = rect.top - height - gap;
      const viewportBottomInClient = viewport.offsetTop + viewport.height;
      left = Math.min(
        Math.max(viewportLeft, rect.left),
        Math.max(viewportLeft, viewportRight - width)
      );
      top = (topBelow + height <= viewportBottomInClient ? topBelow : Math.max(viewport.offsetTop, topAbove));
    }

    top = Math.min(Math.max(viewportTop, top), Math.max(viewportTop, viewportBottom - height));
    editOpenButton.style.left = `${left}px`;
    editOpenButton.style.top = `${top}px`;
  }

  function openPendingEditPanel(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const pending = pendingEditOpen;
    if (!pending) return;
    const range = pending.range;
    const context = pending.context;
    pendingEditOpen = null;
    if (editOpenButton) {
      editOpenButton.removeEventListener("click", openPendingEditPanel);
      editOpenButton.remove();
      editOpenButton = null;
    }
    const selection = window.getSelection();
    if (selection) {
      ignoreSelectionUntil = now() + 500;
      selection.removeAllRanges();
    }
    showEditPanel(range, context);
    range.detach();
  }

  function hideEditOpenButton() {
    if (editOpenButton) {
      editOpenButton.removeEventListener("click", openPendingEditPanel);
      editOpenButton.remove();
      editOpenButton = null;
    }
    if (pendingEditOpen && pendingEditOpen.range) {
      pendingEditOpen.range.detach();
    }
    pendingEditOpen = null;
  }

  function showEditPanel(range, context) {
    hideEditPanel();

    const rect = range.getBoundingClientRect();
    editPanelState = normalizeEditPanelState(context);
    editPanelResultDraft = "";
    hasEditPanelResultDraft = false;
    editPanel = document.createElement("div");
    editPanel.className = "vp-edit-panel";
    if (isAndroidEnvironment()) {
      editPanel.classList.add("vp-edit-panel-android");
    }
    else if (isDesktopWindowsEnvironment()) editPanel.classList.add("vp-edit-panel-desktop-win");
    editPanel.classList.add("vp-size-" + editPanelSize);
    editPanel.appendChild(createEditPanelStyle());
    renderEditPanelContent();

    document.documentElement.appendChild(editPanel);
    if (isAndroidEnvironment()) {
      editPanel.addEventListener("pointerdown", stopAndroidEditPanelEvent, true);
      editPanel.addEventListener("touchstart", stopAndroidEditPanelEvent, true);
      editPanel.addEventListener("mousedown", stopAndroidEditPanelEvent, true);
      editPanel.addEventListener("click", handleEditPanelClick, true);
    } else {
      editPanel.addEventListener("pointerdown", quietEditPanelEvent, true);
      editPanel.addEventListener("touchstart", quietEditPanelEvent, true);
      editPanel.addEventListener("mousedown", quietEditPanelEvent, true);
      editPanel.addEventListener("click", handleEditPanelClick);
    }
    editPanel.addEventListener("change", handleEditPanelChange);
    window.addEventListener("resize", syncEditPanelGeometry);
    window.addEventListener("scroll", scheduleEditPanelGeometrySync, true);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", syncEditPanelGeometry);
      window.visualViewport.addEventListener("scroll", scheduleEditPanelGeometrySync);
    }
    if (!syncEditPanelGeometry()) {
      positionEditPanel(rect);
      updateEditHighlight();
    }
    if (!isAndroidEnvironment()) {
      const resultInput = editPanel ? editPanel.querySelector("[data-field='result']") : null;
      if (resultInput) resultInput.focus();
    }
  }

  function normalizeEditPanelState(context) {
    const sentence = String(context.sentence || context.key || "");
    const startIndex = Math.max(0, Math.min(sentence.length, Number(context.startIndex) || 0));
    const endIndex = Math.max(startIndex, Math.min(sentence.length, Number(context.endIndex) || startIndex));
    const key = sentence.slice(startIndex, endIndex) || String(context.key || "").trim();
    return {
      sentence,
      startIndex,
      endIndex,
      key,
      textNode: context.textNode || null,
      highlightStart: Number(context.highlightStart) || 0,
      highlightEnd: Number(context.highlightEnd) || 0
    };
  }

  function renderEditPanelContent() {
    if (!editPanel || !editPanelState) return;
    const state = editPanelState;
    const key = state.key;
    const vpOptions = getVietPhraseOptions(key);
    const vpValue = vpOptions[0] || "";
    const nameValue = findStoredEntryValue(NAME2_KEY, key);
    const resultValue = hasEditPanelResultDraft
      ? editPanelResultDraft
      : vpValue || findStoredEntryValue(VIETPHRASE2_KEY, key) || nameValue;

    editPanel.textContent = "";
    editPanel.appendChild(createEditPanelStyle());
    editPanel.appendChild(createEditToolbar());
    editPanel.appendChild(createEditRow("TQ", "tq", key, { readonly: true, action: "search" }));
    editPanel.appendChild(createEditRow("HV", "hv", createHanVietHint(key), { readonly: true, action: "copy" }));
    editPanel.appendChild(createMachineRow());
    // Khôi phục cache dịch máy ngay lập tức, tránh hiện placeholder khi panel render lại
    const machineLangEl = editPanel.querySelector("[data-field='machineLang']");
    const currentLang = machineLangEl ? machineLangEl.value : "";
    if (lastMachineTranslateKey === key && lastMachineTranslateLang === currentLang && lastMachineTranslateResult) {
      const machineInput = editPanel.querySelector("[data-field='machine']");
      if (machineInput) machineInput.value = lastMachineTranslateResult;
    }
    editPanel.appendChild(createVpRow(vpOptions));
    editPanel.appendChild(createEditRow("Name", "name", nameValue, { readonly: true, action: "deleteName", actionText: "Xóa" }));
    editPanel.appendChild(createEditRow("KQ", "result", resultValue, { action: "clearResult", actionText: "X" }));
    editPanel.appendChild(createTransformBar());
    editPanel.appendChild(createSaveBar());
    void updateCreateName2ButtonState();
    void initializeMachineControls();
  }

  function createEditToolbar() {
    const bar = document.createElement("div");
    bar.className = "vp-edit-toolbar";
    bar.append(
      createPanelButton("< Mở rộng", "expandLeft"),
      createPanelButton("Thu nhỏ >", "shrinkLeft"),
      createPanelButton("< Thu nhỏ", "shrinkRight"),
      createPanelButton("Mở rộng >", "expandRight"),
      createPanelButton("X", "cancel")
    );
    return bar;
  }

  function createMachineRow() {
    const row = document.createElement("div");
    row.className = "vp-edit-row vp-machine-row";
    const provider = document.createElement("span");
    provider.textContent = "G";
    const lang = document.createElement("select");
    lang.dataset.field = "machineLang";
    for (const value of ["vi", "en", "jp"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      lang.appendChild(option);
    }
    const input = document.createElement("input");
    input.dataset.field = "machine";
    input.placeholder = "dịch máy";
    input.readOnly = true;
    row.append(provider, lang, input, createPanelButton("✓", "copy", "machine"));
    return row;
  }

  function createVpRow(options) {
    const row = document.createElement("label");
    row.className = "vp-edit-row";
    const label = document.createElement("span");
    label.textContent = "VP";
    const select = document.createElement("select");
    select.dataset.field = "vp";
    for (const value of options.length ? options : [""]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
    row.append(label, select, createPanelButton("✓", "copy", "vp"));
    return row;
  }

  function createEditRow(labelText, fieldName, value, options = {}) {
    const row = document.createElement("label");
    row.className = "vp-edit-row";
    const label = document.createElement("span");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.dataset.field = fieldName;
    input.value = value || "";
    input.readOnly = Boolean(options.readonly);
    if (options.autofocus) input.autofocus = true;
    row.append(label, input);
    if (options.action) {
      row.appendChild(createPanelButton(options.actionText || (options.action === "search" ? "🔎" : "✓"), options.action, fieldName));
    }
    return row;
  }

  function createTransformBar() {
    const bar = document.createElement("div");
    bar.className = "vp-edit-transform";
    bar.append(
      createPanelButton("Thường", "lower"),
      createPanelButton("Hoa\nchữ đầu", "capFirst"),
      createPanelButton("Hoa 2\nchữ đầu", "capTwo"),
      createPanelButton("Thường\nchữ cuối", "lowerLast"),
      createPanelButton("Hoa\ntoàn bộ", "upper")
    );
    return bar;
  }

  function createSaveBar() {
    const bar = document.createElement("div");
    bar.className = "vp-save-row";
    bar.append(
      createPanelButton("Size: " + editPanelSize.toUpperCase(), "cyclePanelSize"),
      createPanelButton("+ Name truyện", "createName2Profile"),
      createPanelButton("+ Thêm Name", "saveName"),
      createPanelButton("+ Thêm VietPhrase", "saveVietPhrase")
    );
    return bar;
  }

  function createPanelButton(text, action, source) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    if (source) button.dataset.source = source;
    button.textContent = text;
    return button;
  }

  function normalizeEditPanelSize(value) {
    return value === "s" || value === "m" || value === "l" ? value : "m";
  }

  function cycleEditPanelSize() {
    editPanelSize = editPanelSize === "s" ? "m" : editPanelSize === "m" ? "l" : "s";
    updateEditPanelSizeClass();
    updateEditPanelSizeButton();
    void api.storage.set({ [EDIT_PANEL_SIZE_KEY]: editPanelSize });
    scheduleEditPanelGeometrySync();
  }

  function updateEditPanelSizeClass() {
    if (!editPanel) return;
    editPanel.classList.remove("vp-size-s", "vp-size-m", "vp-size-l");
    editPanel.classList.add("vp-size-" + editPanelSize);
  }

  function updateEditPanelSizeButton() {
    if (!editPanel) return;
    const button = editPanel.querySelector("[data-action='cyclePanelSize']");
    if (button) button.textContent = "Size: " + editPanelSize.toUpperCase();
  }

  function createEditPanelStyle() {
    const style = document.createElement("style");
    style.textContent = `
      .vp-edit-panel {
        position: fixed;
        z-index: 2147483647;
        width: min(300px, calc(100vw - 16px));
        max-width: calc(100vw - 16px);
        max-height: 80dvh;
        overflow-y: auto;
        padding: 5px;
        border: 1px solid rgba(15, 123, 104, 0.45);
        border-radius: 4px;
        background: #fbfaf6;
        color: #1d241f;
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.22);
        font: 7px/1.35 Georgia, "Times New Roman", ${VIETNAMESE_SAFE_FONT_STACK};
      }
      .vp-edit-toolbar,
      .vp-edit-transform { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 3px; }
      .vp-save-row { display: flex; flex-wrap: nowrap; gap: 3px; margin-bottom: 3px; }
      .vp-save-row button { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .vp-edit-row {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr) auto;
        align-items: center;
        gap: 3px;
        margin-bottom: 3px;
      }
      .vp-machine-row { grid-template-columns: 22px 24px minmax(0, 1fr) auto; }
      .vp-edit-row > span { color: #667066; font-size: 6px; }
      .vp-edit-panel input,
      .vp-edit-panel select {
        width: 100%;
        min-width: 0;
        min-height: 17px;
        border: 1px solid #d8ddce;
        border-radius: 3px;
        padding: 0 4px;
        box-sizing: border-box;
        background: #fff;
        color: #1d241f;
        font: 9px/1.35 Georgia, "Times New Roman", ${VIETNAMESE_SAFE_FONT_STACK};
      }
      .vp-edit-panel .vp-actions { display: flex; justify-content: flex-end; gap: 3px; }
      .vp-edit-panel button {
        min-height: 17px;
        border: 1px solid #0f7b68;
        border-radius: 3px;
        padding: 0 5px;
        background: #0f7b68;
        color: #fff;
        font: inherit;
        cursor: pointer;
      }
      .vp-edit-row > button { font-size: 9px; padding: 0 8px; min-width: 34px; }
      .vp-edit-transform button {
        white-space: pre-line;
        line-height: 1.1;
      }
      .vp-save-row { margin-bottom: 0; }
      .vp-edit-panel button[data-action="cancel"] {
        width: 30px;
        min-width: 30px;
        height: 30px;
        min-height: 30px;
        padding: 0;
        border-color: #b42318;
        border-radius: 4px;
        background: #d92d20;
        color: #fff;
        font-weight: 700;
      }
      .vp-edit-panel.vp-edit-panel-android {
        padding: 8px;
        border-radius: 4px;
        font: 8.75px/1.35 Georgia, "Times New Roman", ${VIETNAMESE_SAFE_FONT_STACK};
      }
      .vp-edit-panel.vp-edit-panel-android .vp-edit-toolbar,
      .vp-edit-panel.vp-edit-panel-android .vp-edit-transform {
        display: grid;
        gap: 5px;
      }
      .vp-edit-panel.vp-edit-panel-android .vp-edit-toolbar {
        grid-template-columns: repeat(4, minmax(0, 1fr)) auto;
      }
      .vp-edit-panel.vp-edit-panel-android .vp-edit-transform {
        grid-template-columns: repeat(5, minmax(0, 1fr));
      }
      .vp-edit-panel.vp-edit-panel-android .vp-edit-toolbar button,
      .vp-edit-panel.vp-edit-panel-android .vp-edit-transform button {
        width: 100%;
        min-width: 0;
        white-space: normal;
        line-height: 1.1;
        padding: 0 3px;
      }
      .vp-edit-panel.vp-edit-panel-android .vp-edit-toolbar button:last-child {
        margin-left: 0;
      }
      .vp-edit-panel.vp-edit-panel-android button[data-action="cancel"] {
        width: 40px;
        min-width: 40px;
        height: 40px;
        min-height: 40px;
        padding: 0;
        border-color: #b42318;
        border-radius: 4px;
        background: #d92d20;
        color: #fff;
        font-size: 14px;
        font-weight: 700;
      }
      .vp-edit-panel.vp-edit-panel-android .vp-edit-row {
        grid-template-columns: 28px minmax(0, 1fr) auto;
        gap: 5px;
        margin-bottom: 5px;
      }
      .vp-edit-panel.vp-edit-panel-android .vp-machine-row {
        grid-template-columns: 28px 30px minmax(0, 1fr) auto;
      }
      .vp-edit-panel.vp-edit-panel-android .vp-edit-row > span {
        font-size: 7.5px;
      }
      .vp-edit-panel.vp-edit-panel-android input,
      .vp-edit-panel.vp-edit-panel-android select {
        min-width: 0;
        min-height: 27px;
        padding: 0 5px;
        border-radius: 4px;
        box-sizing: border-box;
        font: 11.25px/1.35 Georgia, "Times New Roman", ${VIETNAMESE_SAFE_FONT_STACK};
      }
      .vp-edit-panel.vp-edit-panel-android button {
        min-height: 27px;
        padding: 0 6px;
        border-radius: 4px;
        touch-action: manipulation;
        user-select: none;
        -webkit-user-select: none;
      }
      .vp-edit-panel.vp-edit-panel-android .vp-edit-row > button { font-size: 11px; padding: 0 10px; min-width: 42px; }
      .vp-edit-panel.vp-edit-panel-android .vp-save-row button { font-size: 11px; }
      .vp-edit-panel.vp-edit-panel-desktop-win {
        width: min(520px, calc(100vw - 16px));
        padding: 7px;
        border-radius: 8px;
        font: 13px/1.35 Georgia, "Times New Roman", ${VIETNAMESE_SAFE_FONT_STACK};
      }
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-row > span {
        font-size: 11px;
      }
      .vp-edit-panel.vp-edit-panel-desktop-win input,
      .vp-edit-panel.vp-edit-panel-desktop-win select {
        min-width: 0;
        min-height: 26px;
        padding: 0 6px;
        border-radius: 5px;
        box-sizing: border-box;
        font: inherit;
      }
      .vp-edit-panel.vp-edit-panel-desktop-win button {
        min-height: 26px;
        padding: 0 8px;
        border-radius: 5px;
        font: inherit;
      }
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-row > button { font-size: 14px; padding: 0 12px; min-width: 54px; }
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-toolbar,
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-transform {
        display: grid;
        gap: 6px;
      }
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-toolbar {
        grid-template-columns: repeat(4, minmax(0, 1fr)) auto;
      }
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-transform {
        grid-template-columns: repeat(5, minmax(0, 1fr));
      }
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-toolbar button,
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-transform button {
        width: 100%;
        min-width: 0;
        white-space: normal;
        line-height: 1.1;
      }
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-toolbar button:last-child {
        margin-left: 0;
      }
      .vp-edit-panel.vp-edit-panel-desktop-win button[data-action="cancel"] {
        width: 44px;
        min-width: 44px;
        height: 44px;
        min-height: 44px;
        padding: 0;
        border-color: #b42318;
        border-radius: 8px;
        background: #d92d20;
        color: #fff;
        font-size: 20px;
        font-weight: 700;
      }
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-transform button {
        white-space: normal;
      }
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-toolbar,
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-transform,
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-save-row {
        gap: 4px;
        margin-bottom: 4px;
      }
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-edit-row {
        gap: 4px;
        margin-bottom: 3px;
        grid-template-columns: 44px minmax(0, 1fr) auto;
      }
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-machine-row {
        grid-template-columns: 44px 48px minmax(0, 1fr) auto;
      }
      .vp-edit-panel.vp-edit-panel-desktop-win .vp-save-row button { font-size: 14px; }
      .vp-edit-panel.vp-size-s { width: min(240px, calc(100vw - 16px)); }
      .vp-edit-panel.vp-size-l { width: min(400px, calc(100vw - 16px)); }
      .vp-edit-panel.vp-edit-panel-desktop-win.vp-size-s { width: min(380px, calc(100vw - 16px)); }
      .vp-edit-panel.vp-edit-panel-desktop-win.vp-size-l { width: min(680px, calc(100vw - 16px)); }
      .vp-edit-panel.vp-edit-panel-android.vp-size-s {
        padding: 6px;
        max-height: 60dvh;
        font: 7px/1.35 Georgia, "Times New Roman", ${VIETNAMESE_SAFE_FONT_STACK};
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-s input,
      .vp-edit-panel.vp-edit-panel-android.vp-size-s select {
        min-height: 22px;
        padding: 0 4px;
        font: 9px/1.35 Georgia, "Times New Roman", ${VIETNAMESE_SAFE_FONT_STACK};
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-s button {
        min-height: 22px;
        padding: 0 4px;
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-s .vp-edit-row > span {
        font-size: 6px;
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-s .vp-edit-row > button {
        font-size: 9px;
        padding: 0 8px;
        min-width: 36px;
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-s button[data-action="cancel"] {
        width: 32px;
        min-width: 32px;
        height: 32px;
        min-height: 32px;
        font-size: 11px;
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-s .vp-edit-row {
        grid-template-columns: 22px minmax(0, 1fr) auto;
        gap: 4px;
        margin-bottom: 4px;
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-s .vp-machine-row {
        grid-template-columns: 22px 24px minmax(0, 1fr) auto;
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-s .vp-save-row button { font-size: 9px; }
      .vp-edit-panel.vp-edit-panel-android.vp-size-l {
        padding: 10px;
        max-height: 90dvh;
        font: 11px/1.35 Georgia, "Times New Roman", ${VIETNAMESE_SAFE_FONT_STACK};
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-l input,
      .vp-edit-panel.vp-edit-panel-android.vp-size-l select {
        min-height: 34px;
        padding: 0 6px;
        font: 14px/1.35 Georgia, "Times New Roman", ${VIETNAMESE_SAFE_FONT_STACK};
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-l button {
        min-height: 34px;
        padding: 0 7px;
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-l .vp-edit-row > span {
        font-size: 9.5px;
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-l .vp-edit-row > button {
        font-size: 14px;
        padding: 0 12px;
        min-width: 52px;
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-l button[data-action="cancel"] {
        width: 48px;
        min-width: 48px;
        height: 48px;
        min-height: 48px;
        font-size: 18px;
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-l .vp-edit-row {
        grid-template-columns: 35px minmax(0, 1fr) auto;
        gap: 7px;
        margin-bottom: 7px;
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-l .vp-machine-row {
        grid-template-columns: 35px 38px minmax(0, 1fr) auto;
      }
      .vp-edit-panel.vp-edit-panel-android.vp-size-l .vp-save-row button { font-size: 14px; }
      .vp-edit-open-button {
        position: fixed;
        z-index: 2147483647;
        min-width: 56px;
        min-height: 40px;
        padding: 2px 14px;
        border: 1px solid rgba(8, 94, 78, 0.7);
        border-radius: 8px;
        background: #0f7b68;
        color: #fff;
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);
        font: 700 14px/1.35 Georgia, "Times New Roman", ${VIETNAMESE_SAFE_FONT_STACK};
        font-weight: 700;
        cursor: pointer;
        touch-action: manipulation;
        user-select: none;
        -webkit-user-select: none;
      }
      .vp-edit-highlight {
        position: fixed !important;
        z-index: 2147483646 !important;
        background: rgba(255, 224, 102, 0.48) !important;
        outline: 1px solid rgba(15, 123, 104, 0.55) !important;
        border-radius: 2px !important;
        pointer-events: none !important;
      }
    `;
    return style;
  }

  function isDesktopWindowsEnvironment() {
    const ua = String(navigator.userAgent || "");
    return ua.includes("Windows") && !ua.includes("Android");
  }

  function isAndroidEnvironment() {
    return String(navigator.userAgent || "").includes("Android");
  }

  function captureEditPanelViewportSnapshot() {
    // No longer needed — panel uses fixed-size layout
    editPanelViewportSnapshot = null;
  }

  function getStableEditPanelViewportSize() {
    // No longer needed — panel uses fixed-size layout
    return { width: 360, height: 640, scale: 1 };
  }

  function getCurrentVisualViewportSize() {
    const viewport = window.visualViewport;
    const width = viewport && Number.isFinite(viewport.width) ? viewport.width : window.innerWidth;
    const height = viewport && Number.isFinite(viewport.height) ? viewport.height : window.innerHeight;
    const scale = getVisualViewportScale();
    return { width, height, scale };
  }

  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getVisualViewportScale() {
    const scale = window.visualViewport && Number.isFinite(window.visualViewport.scale)
      ? window.visualViewport.scale
      : 1;
    return scale > 0 ? scale : 1;
  }

  function createPanelField(labelText, tagName, fieldName) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = labelText;
    const field = document.createElement(tagName);
    field.dataset.field = fieldName;
    label.append(span, field);
    return { label, field };
  }

  function stopAndroidEditPanelEvent(event) {
    const target = event ? event.target : null;
    if (target && editPanel && editPanel.contains(target)) {
      quietEditPanelSelectionChanges();
      event.stopPropagation();
    }
  }

  function quietEditPanelEvent(event) {
    const target = event ? event.target : null;
    if (target && editPanel && editPanel.contains(target)) {
      quietEditPanelSelectionChanges();
    }
  }

  function quietEditPanelSelectionChanges() {
    ignoreSelectionUntil = now() + 500;
    clearTimeout(editPanelTimer);
  }

  function handleEditPanelClick(event) {
    const target = event ? event.target : null;
    if (isAndroidEnvironment() && target && editPanel && editPanel.contains(target)) {
      event.stopPropagation();
    }
    const button = target && typeof target.closest === "function"
      ? target.closest("button[data-action]")
      : null;
    if (!button || !editPanel || !editPanelState) return;
    event.preventDefault();
    event.stopPropagation();
    quietEditPanelSelectionChanges();
    const action = button.dataset.action;
    const source = button.dataset.source || "";

    if (action === "cancel") hideEditPanel();
    else if (action === "copy") copyEditSource(source);
    else if (action === "search") searchEditKey();
    else if (action === "clearResult") clearEditResult();
    else if (action === "deleteName") deleteNameEntry();
    else if (action === "saveName") saveEditPanelEntry(NAME2_KEY);
    else if (action === "saveVietPhrase") saveEditPanelEntry(VIETPHRASE2_KEY);
    else if (action === "createName2Profile") createName2ProfileForCurrentUrl();
    else if (action === "cyclePanelSize") cycleEditPanelSize();
    else if (action === "expandLeft" || action === "shrinkLeft" || action === "shrinkRight" || action === "expandRight") {
      adjustEditSelection(action);
    } else {
      transformEditResult(action);
    }
  }

  function handleEditPanelChange(event) {
    quietEditPanelSelectionChanges();
    const field = event.target && event.target.dataset ? event.target.dataset.field : "";
    if (field === "vp") {
      const result = editPanel ? editPanel.querySelector("[data-field='result']") : null;
      if (result) {
        result.value = event.target.value || "";
        editPanelResultDraft = result.value;
        hasEditPanelResultDraft = true;
      }
      return;
    }
    if (field !== "machineLang") return;
    void saveMachineSettings();
    void refreshMachineTranslation();
  }

  async function initializeMachineControls() {
    if (!editPanel) return;
    const stored = await api.storage.get([MACHINE_SETTINGS_KEY]);
    const machineSettings = stored[MACHINE_SETTINGS_KEY] || {};
    const lang = editPanel.querySelector("[data-field='machineLang']");
    if (lang && machineSettings.lang) lang.value = machineSettings.lang;
    await refreshMachineTranslation();
  }

  async function saveMachineSettings(extra = {}) {
    if (!editPanel) return;
    const lang = editPanel.querySelector("[data-field='machineLang']");
    const stored = await api.storage.get([MACHINE_SETTINGS_KEY]);
    await api.storage.set({
      [MACHINE_SETTINGS_KEY]: {
        ...(stored[MACHINE_SETTINGS_KEY] || {}),
        lang: lang ? lang.value : "vi",
        ...extra
      }
    });
  }

  async function refreshMachineTranslation() {
    if (!editPanel || !editPanelState) return;
    const requestId = ++machineTranslateRequestId;
    const input = editPanel.querySelector("[data-field='machine']");
    const lang = editPanel.querySelector("[data-field='machineLang']");
    const text = editPanelState.key;
    if (!input || !lang || !text) return;

    // Nếu key + ngôn ngữ không đổi và đã có cache, dùng lại không cần fetch
    if (text === lastMachineTranslateKey && lang.value === lastMachineTranslateLang && lastMachineTranslateResult) {
      input.value = lastMachineTranslateResult;
      return;
    }

    input.value = "Đang dịch...";
    const translated = await translateWithGoogle(text, lang.value).catch(() => "");
    if (requestId === machineTranslateRequestId && editPanel) {
      const result = translated || "";
      input.value = result;
      lastMachineTranslateKey = text;
      lastMachineTranslateLang = lang.value;
      lastMachineTranslateResult = result;
    }
  }

  async function translateWithGoogle(text, targetLang) {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "zh-CN");
    url.searchParams.set("tl", normalizeMachineTargetLang(targetLang));
    url.searchParams.set("dt", "t");
    if (targetLang === "jp") url.searchParams.append("dt", "rm");
    url.searchParams.set("q", text);
    const response = await api.fetchExternal(url.toString());
    if (!response.ok) return "";
    const data = await response.json();
    if (targetLang === "jp") {
      return extractGoogleRomanization(data) || extractGoogleTranslation(data);
    }
    return extractGoogleTranslation(data);
  }

  function extractGoogleTranslation(data) {
    return Array.isArray(data && data[0])
      ? data[0].map((part) => Array.isArray(part) ? part[0] : "").join("").trim()
      : "";
  }

  function extractGoogleRomanization(data) {
    if (!Array.isArray(data && data[0])) return "";
    for (const part of data[0]) {
      if (!Array.isArray(part)) continue;
      for (const value of part) {
        if (typeof value === "string" && /[A-Za-z]/.test(value) && !CJK_RE.test(value)) {
          return value.trim();
        }
      }
    }
    return "";
  }

  function normalizeMachineTargetLang(lang) {
    if (lang === "jp") return "ja";
    return lang || "vi";
  }

  function copyEditSource(source) {
    const input = editPanel.querySelector(`[data-field='${source}']`);
    const result = editPanel.querySelector("[data-field='result']");
    if (input && result) {
      result.value = input.value;
      editPanelResultDraft = result.value;
      hasEditPanelResultDraft = true;
    }
  }

  function clearEditResult() {
    const result = editPanel ? editPanel.querySelector("[data-field='result']") : null;
    if (!result) return;
    result.value = "";
    editPanelResultDraft = "";
    hasEditPanelResultDraft = true;
    result.focus();
  }

  function searchEditKey() {
    const key = editPanelState.key;
    if (key) {
      const query = `${key} dịch tiếng việt là gì`;
      globalThis.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, "_blank");
    }
  }

  function adjustEditSelection(action) {
    const state = editPanelState;
    if (!state.sentence) return;
    editPanelResultDraft = "";
    hasEditPanelResultDraft = false;
    if (action === "expandLeft") state.startIndex = previousCjkBoundary(state.sentence, state.startIndex);
    if (action === "shrinkLeft") state.startIndex = shrinkLeftBoundary(state.sentence, state.startIndex, state.endIndex);
    if (action === "shrinkRight") state.endIndex = shrinkRightBoundary(state.sentence, state.endIndex, state.startIndex);
    if (action === "expandRight") state.endIndex = nextCjkBoundary(state.sentence, state.endIndex, state.sentence.length);
    // Giữ ít nhất 1 ký tự được chọn, không để khoảng chọn rỗng
    if (state.startIndex >= state.endIndex) {
      if (action === "shrinkLeft") state.startIndex = Math.max(0, state.endIndex - 1);
      if (action === "shrinkRight") state.endIndex = Math.min(state.sentence.length, state.startIndex + 1);
    }
    state.key = state.sentence.slice(state.startIndex, state.endIndex).trim();
    if (!state.key && state.startIndex < state.endIndex) {
      while (state.startIndex < state.endIndex && /\s/.test(state.sentence[state.startIndex])) state.startIndex += 1;
      while (state.endIndex > state.startIndex && /\s/.test(state.sentence[state.endIndex - 1])) state.endIndex -= 1;
      state.key = state.sentence.slice(state.startIndex, state.endIndex).trim();
    }
    if (!state.key) return;
    updateHighlightRangeForState();
    renderEditPanelContent();
    syncEditPanelGeometry();
  }

  function updateHighlightRangeForState() {
    const state = editPanelState;
    if (!state || !state.textNode) return;
    const segments = translatedSegments.get(state.textNode) || [];
    const matching = segments.filter((segment) => segment.sourceEnd > state.startIndex && segment.sourceStart < state.endIndex);
    if (matching.length) {
      state.highlightStart = Math.min(...matching.map((segment) => segment.start));
      state.highlightEnd = Math.max(...matching.map((segment) => segment.end));
    }
  }

  function updateEditHighlight() {
    clearEditHighlight();
    const range = createEditPanelRange();
    if (!range) return;
    editHighlight = [];
    for (const rect of range.getClientRects()) {
      const overlay = document.createElement("div");
      overlay.className = "vp-edit-highlight";
      overlay.dataset.vpIgnore = "1";
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      document.documentElement.appendChild(overlay);
      editHighlight.push(overlay);
    }
    range.detach();
  }

  function createEditPanelRange() {
    const state = editPanelState;
    if (!state || !state.textNode || state.highlightEnd <= state.highlightStart) return null;
    const node = state.textNode;
    if (!node.isConnected || node.nodeType !== Node.TEXT_NODE) return null;

    const length = node.nodeValue ? node.nodeValue.length : 0;
    const start = Math.max(0, Math.min(length, state.highlightStart));
    const end = Math.max(start, Math.min(length, state.highlightEnd));
    if (end <= start) return null;

    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return range;
  }

  function clearEditHighlight() {
    if (!editHighlight) return;
    const overlays = Array.isArray(editHighlight) ? editHighlight : [editHighlight];
    editHighlight = null;
    for (const overlay of overlays) {
      if (overlay && overlay.parentNode) overlay.remove();
    }
  }

  function previousCjkBoundary(text, index, minIndex = 0) {
    let next = Math.max(minIndex, index - 1);
    while (next > minIndex && !CJK_RE.test(text[next])) next -= 1;
    return next;
  }

  function nextCjkBoundary(text, index, maxIndex) {
    let next = Math.min(maxIndex, index + 1);
    while (next < maxIndex && !CJK_RE.test(text[next - 1])) next += 1;
    return next;
  }

  function shrinkLeftBoundary(text, index, maxIndex) {
    if (index >= maxIndex) return index;
    const nextChar = text[index] || "";
    if (text.startsWith("——", index)) return Math.min(maxIndex, index + 2);
    if (nextChar && !CJK_RE.test(nextChar)) return Math.min(maxIndex, index + nextChar.length);
    return nextCjkBoundary(text, index, maxIndex);
  }

  function shrinkRightBoundary(text, index, minIndex) {
    if (index <= minIndex) return index;
    if (text.slice(Math.max(minIndex, index - 2), index) === "——") return Math.max(minIndex, index - 2);
    const previousChar = text[index - 1] || "";
    if (previousChar && !CJK_RE.test(previousChar)) return Math.max(minIndex, index - previousChar.length);
    return previousCjkBoundary(text, index, minIndex);
  }

  function transformEditResult(action) {
    const result = editPanel.querySelector("[data-field='result']");
    if (!result) return;
    const value = String(result.value || "").normalize("NFC");
    if (action === "lower") result.value = value.toLocaleLowerCase("vi-VN");
    else if (action === "upper") result.value = capitalizeWords(value.toLocaleLowerCase("vi-VN"), Infinity);
    else if (action === "capFirst") result.value = capitalizeWords(value.toLocaleLowerCase("vi-VN"), 1);
    else if (action === "capTwo") result.value = capitalizeWords(value.toLocaleLowerCase("vi-VN"), 2);
    else if (action === "lowerLast") result.value = lowerLastWord(capitalizeWords(value.toLocaleLowerCase("vi-VN"), Infinity));
    editPanelResultDraft = result.value;
    hasEditPanelResultDraft = true;
    result.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function capitalizeWords(value, count) {
    if (count <= 0) return String(value || "");
    let seen = 0;
    return String(value || "").normalize("NFC").replace(/\p{L}[\p{L}\p{M}]*/gu, (word) => {
      seen += 1;
      if (seen > count) return word;
      return uppercaseFirstLetter(word);
    });
  }

  function lowerLastWord(value) {
    const text = String(value || "").normalize("NFC");
    const matches = [...text.matchAll(/\p{L}[\p{L}\p{M}]*/gu)];
    const last = matches[matches.length - 1];
    if (!last) return text;
    return text.slice(0, last.index) + last[0].toLocaleLowerCase("vi-VN") + text.slice(last.index + last[0].length);
  }

  function uppercaseFirstLetter(word) {
    const letters = Array.from(String(word || ""));
    if (!letters.length) return "";
    return letters[0].toLocaleUpperCase("vi-VN") + letters.slice(1).join("");
  }

  function positionEditPanel(rect) {
    const gap = 8;
    const panelRect = editPanel.getBoundingClientRect();
    const viewport = getVisibleViewportBox(gap);
    const clientViewportTop = viewport.offsetTop;
    const clientViewportBottom = viewport.offsetTop + viewport.height;
    const outOfViewport = rect.bottom < clientViewportTop || rect.top > clientViewportBottom;
    if (outOfViewport) {
      editPanel.style.visibility = "hidden";
      clearEditHighlight();
      return false;
    }
    editPanel.style.visibility = "visible";
    const viewportLeft = viewport.left;
    const viewportRight = viewport.right;
    const left = isAndroidEnvironment()
      ? viewportLeft
      : Math.max(viewportLeft, (viewportLeft + viewportRight) / 2 - panelRect.width / 2);
    const maxLeft = viewportRight - panelRect.width - 8;
    const clampedLeft = Math.max(viewportLeft, Math.min(left, maxLeft));
    const belowSpace = viewport.height - (rect.bottom - viewport.offsetTop) - gap;
    const aboveSpace = rect.top - viewport.offsetTop - gap;
    const placeBelow = belowSpace >= panelRect.height || belowSpace >= aboveSpace;
    const panelTop = placeBelow
      ? rect.bottom + gap
      : rect.top - panelRect.height - gap;
    const minTop = viewport.top;
    const maxTop = Math.max(minTop, viewport.bottom - panelRect.height);
    const top = Math.min(Math.max(minTop, panelTop), maxTop);
    editPanel.style.left = `${clampedLeft}px`;
    editPanel.style.top = `${top}px`;
    return true;
  }

  function getVisibleViewportBox(gap = 0) {
    const visualViewport = window.visualViewport;
    const offsetLeft = visualViewport ? visualViewport.offsetLeft : 0;
    const offsetTop = visualViewport ? visualViewport.offsetTop : 0;
    const width = visualViewport ? visualViewport.width : window.innerWidth;
    const height = visualViewport ? visualViewport.height : window.innerHeight;
    return {
      left: offsetLeft + gap,
      right: offsetLeft + width - gap,
      top: offsetTop + gap,
      bottom: offsetTop + height - gap,
      width: Math.max(0, width - gap * 2),
      height: Math.max(0, height - gap * 2),
      offsetLeft,
      offsetTop
    };
  }

  function syncEditPanelGeometry() {
    editPanelSyncFrame = 0;
    if (!editPanel || !editPanelState) return false;
    const range = createEditPanelRange();
    if (!range) return false;
    const visible = positionEditPanel(range.getBoundingClientRect());
    range.detach();
    if (visible === false) return true;
    updateEditHighlight();
    return true;
  }

  function scheduleEditPanelGeometrySync() {
    if (editPanelSyncFrame) return;
    editPanelSyncFrame = window.requestAnimationFrame(syncEditPanelGeometry);
  }

  function captureViewportAnchor() {
    const paragraph = findViewportAnchorElement();
    const paragraphRect = paragraph ? paragraph.getBoundingClientRect() : null;
    const fallback = {
      x: window.scrollX,
      y: window.scrollY,
      top: null,
      paragraph,
      paragraphTop: paragraphRect && Number.isFinite(paragraphRect.top) ? paragraphRect.top : null
    };
    const range = createEditPanelRange();
    if (!range) return fallback;

    const rect = range.getBoundingClientRect();
    range.detach();
    if (!Number.isFinite(rect.top)) return fallback;
    return {
      x: window.scrollX,
      y: window.scrollY,
      top: rect.top,
      paragraph,
      paragraphTop: fallback.paragraphTop
    };
  }

  function restoreViewportAnchor(anchor) {
    if (!anchor) return;
    if (anchor.paragraph && anchor.paragraph.isConnected && Number.isFinite(anchor.paragraphTop)) {
      const rect = anchor.paragraph.getBoundingClientRect();
      if (Number.isFinite(rect.top)) {
        window.scrollTo(anchor.x, window.scrollY + rect.top - anchor.paragraphTop);
        return;
      }
    }

    const range = createEditPanelRange();
    if (!range || !Number.isFinite(anchor.top)) {
      window.scrollTo(anchor.x, anchor.y);
      return;
    }

    const rect = range.getBoundingClientRect();
    range.detach();
    if (!Number.isFinite(rect.top)) {
      window.scrollTo(anchor.x, anchor.y);
      return;
    }

    window.scrollTo(anchor.x, window.scrollY + rect.top - anchor.top);
  }

  function restoreViewportAnchorSoon(anchor) {
    restoreViewportAnchor(anchor);
    window.requestAnimationFrame(() => restoreViewportAnchor(anchor));
    window.setTimeout(() => restoreViewportAnchor(anchor), 250);
  }

  function findViewportAnchorElement() {
    const node = editPanelState ? editPanelState.textNode : null;
    const element = node && node.nodeType === Node.TEXT_NODE
      ? node.parentElement
      : node && node.nodeType === Node.ELEMENT_NODE
        ? node
        : null;
    if (!element || !element.isConnected) return null;
    return element.closest("p, li, blockquote, pre, article, section, main, td, th, dd, dt, h1, h2, h3, h4, h5, h6, div")
      || element;
  }

  async function saveEditPanelEntry(storageKey) {
    const key = editPanelState ? editPanelState.key.trim() : "";
    const valueInput = editPanel ? editPanel.querySelector("[data-field='result']") : null;
    const value = pickPrimaryMeaning(valueInput ? valueInput.value : "");
    if (!key || !value) return;
    const viewportAnchor = captureViewportAnchor();

    const name2Profiles = globalThis.vpName2Profiles;
    let activeProfileId = storageKey === NAME2_KEY && name2Profiles
      ? tabStore.getItem(name2Profiles.SESSION_ACTIVE_KEY)
      : null;

    if (!activeProfileId && storageKey === NAME2_KEY && name2Profiles) {
      const profiles = await name2Profiles.loadProfiles();
      const urlInfo = name2Profiles.extractUrlIdentifiers(getPageUrl());
      const matching = name2Profiles.findMatchingProfiles(profiles, urlInfo);
      if (matching.length > 0) {
        activeProfileId = matching[0].id;
        tabStore.setItem(name2Profiles.SESSION_ACTIVE_KEY, activeProfileId);
      }
    }

    let layerSize = 0;

    if (activeProfileId) {
      const profiles = await name2Profiles.loadProfiles();
      const activeProfile = profiles.find(p => p.id === activeProfileId);
      if (activeProfile) {
        if (!activeProfile.entries) activeProfile.entries = [];
        const existingIdx = activeProfile.entries.findIndex(e => e.key === key);
        if (existingIdx >= 0) {
          activeProfile.entries[existingIdx].value = value;
        } else {
          activeProfile.entries.push({ key, value });
        }
        await name2Profiles.saveProfiles(profiles);
        layerSize = activeProfile.entries.length;
      }
    } else {
      const stored = await api.storage.get([storageKey]);
      const entries = storageKey === VIETPHRASE2_KEY
        ? normalizeStoredEntryList(stored[storageKey] || [])
        : normalizeEntryList(stored[storageKey] || []);
      const byKey = new Map(entries.map((entry) => [entry.key, entry.value]));
      const nextValue = storageKey === VIETPHRASE2_KEY
        ? mergeVietPhraseValue(key, value, byKey.get(key))
        : value;
      byKey.set(key, nextValue);
      await api.storage.set({
        [storageKey]: [...byKey.entries()].map(([entryKey, entryValue]) => ({
          key: entryKey,
          value: entryValue
        }))
      });
      layerSize = byKey.size;
    }

    editPanelJustSaved.set(storageKey, Date.now());
    setTimeout(() => editPanelJustSaved.delete(storageKey), EDIT_SAVE_SKIP_MS);

    hideEditPanel();
    insertPersonalEntry(storageKey, key, value, layerSize);
    refreshDocumentForEntry();
    restoreViewportAnchorSoon(viewportAnchor);
  }

  async function updateCreateName2ButtonState() {
    const btn = editPanel && editPanel.querySelector('[data-action="createName2Profile"]');
    if (!btn) return;
    const name2Profiles = globalThis.vpName2Profiles;
    if (!name2Profiles) return;

    const activeId = tabStore.getItem(name2Profiles.SESSION_ACTIVE_KEY);
    if (activeId) {
      const profiles = await name2Profiles.loadProfiles();
      const profileExists = profiles.some(p => p.id === activeId);
      if (profileExists) {
        btn.disabled = true;
        btn.style.opacity = "0.4";
        btn.style.cursor = "not-allowed";
        btn.title = "Đã có Name2 cho truyện này";
        return;
      }
      tabStore.removeItem(name2Profiles.SESSION_ACTIVE_KEY);
    }

    const profiles = await name2Profiles.loadProfiles();
    const urlInfo = name2Profiles.extractUrlIdentifiers(getPageUrl());
    const matching = name2Profiles.findMatchingProfiles(profiles, urlInfo);
    if (matching.length > 0) {
      btn.disabled = true;
      btn.style.opacity = "0.4";
      btn.style.cursor = "not-allowed";
      btn.title = "Đã có Name2 cho truyện này";
    }
  }

  async function createName2ProfileForCurrentUrl() {
    const name2Profiles = globalThis.vpName2Profiles;
    if (!name2Profiles) return;

    const urlInfo = name2Profiles.extractUrlIdentifiers(getPageUrl());
    if (!urlInfo.host) return;

    const profiles = await name2Profiles.loadProfiles();
    const matching = name2Profiles.findMatchingProfiles(profiles, urlInfo);
    if (matching.length > 0) {
      tabStore.setItem(name2Profiles.SESSION_ACTIVE_KEY, matching[0].id);
      dictionaryLoading = reloadDictionary();
      await dictionaryLoading;
      restoreDocument();
      if (enabled) queueDocument();
      return;
    }

    const defaultName = document.title || urlInfo.host;
    const bookName = prompt(
      "Nhập tên truyện:\n\n(Lưu ý: Hãy đảm bảo bạn đang mở 1 chương bất kỳ của truyện để Name hoạt động chính xác)",
      defaultName
    );
    if (!bookName || !bookName.trim()) return;

    const maxPriority = profiles.length
      ? Math.max(...profiles.map(p => p.priority || 0)) + 1
      : 1;

    const newProfile = {
      id: name2Profiles.generateProfileId(maxPriority, urlInfo.host, urlInfo.pathPrefix),
      priority: maxPriority,
      host: urlInfo.host,
      pathPrefix: urlInfo.pathPrefix,
      bookName: bookName.trim(),
      bookUrl: getPageUrl(),
      entries: []
    };

    await name2Profiles.upsertProfile(newProfile);

    const filename = name2Profiles.generateProfileFilename(newProfile);
    const content = `# ${filename}\n# ${urlInfo.host}${urlInfo.pathPrefix}\n`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const downloadUrl = URL.createObjectURL(blob);
    const downloadsApi = api.downloads;
    if (downloadsApi && downloadsApi.download) {
      downloadsApi.download({
        url: downloadUrl,
        filename: `name2-profiles/${filename}`,
        saveAs: false
      });
    }

    tabStore.setItem(name2Profiles.SESSION_ACTIVE_KEY, newProfile.id);
    dictionaryLoading = reloadDictionary();
    await dictionaryLoading;
    restoreDocument();
    if (enabled) queueDocument();
  }

  async function deleteNameEntry() {
    const key = editPanelState ? editPanelState.key.trim() : "";
    if (!key) return;
    const viewportAnchor = captureViewportAnchor();

    const name2Profiles = globalThis.vpName2Profiles;
    let activeProfileId = name2Profiles
      ? tabStore.getItem(name2Profiles.SESSION_ACTIVE_KEY)
      : null;

    if (!activeProfileId && name2Profiles) {
      const profiles = await name2Profiles.loadProfiles();
      const urlInfo = name2Profiles.extractUrlIdentifiers(getPageUrl());
      const matching = name2Profiles.findMatchingProfiles(profiles, urlInfo);
      if (matching.length > 0) {
        activeProfileId = matching[0].id;
        tabStore.setItem(name2Profiles.SESSION_ACTIVE_KEY, activeProfileId);
      }
    }

    let name2Count = 0;

    if (activeProfileId && name2Profiles) {
      const profiles = await name2Profiles.loadProfiles();
      const activeProfile = profiles.find(p => p.id === activeProfileId);
      if (activeProfile && activeProfile.entries) {
        const before = activeProfile.entries.length;
        activeProfile.entries = activeProfile.entries.filter(e => e.key !== key);
        if (activeProfile.entries.length === before) return;
        await name2Profiles.saveProfiles(profiles);
        name2Count = activeProfile.entries.length;
      } else {
        return;
      }
    } else {
      const stored = await api.storage.get([NAME2_KEY]);
      const entries = normalizeEntryList(stored[NAME2_KEY] || []);
      const nextEntries = entries.filter((entry) => entry.key !== key);
      if (nextEntries.length === entries.length) return;
      await api.storage.set({ [NAME2_KEY]: nextEntries });
      name2Count = nextEntries.length;
    }

    editPanelJustSaved.set(NAME2_KEY, Date.now());
    setTimeout(() => editPanelJustSaved.delete(NAME2_KEY), EDIT_SAVE_SKIP_MS);

    hideEditPanel();
    name2EntryMap.delete(key);
    removeTrieEntry(name2Trie, key);
    dictionaryKeys.delete(key);
    dictionaryStats.name2 = name2Count;
    dictionaryStats.total -= 1;
    refreshDocumentForEntry();
    restoreViewportAnchorSoon(viewportAnchor);
  }

  function normalizeStoredEntryList(entries) {
    return Array.isArray(entries)
      ? entries
          .map((entry) => ({
            key: String(entry.key || "").trim(),
            value: String(entry.value || "").trim()
          }))
          .filter((entry) => entry.key && entry.value)
      : [];
  }

  function mergeVietPhraseValue(key, value, currentValue) {
    const values = [
      value,
      currentValue,
      findPackedTrieExactValue(key),
      customEntryMap.get(key)
    ];
    const merged = [];
    const seen = new Set();

    for (const source of values) {
      for (const part of String(source || "").split("/")) {
        const item = part.trim();
        const normalized = item.normalize("NFC").toLocaleLowerCase("vi-VN");
        if (!item || seen.has(normalized)) continue;
        seen.add(normalized);
        merged.push(item);
      }
    }

    return merged.join("/");
  }

  function findStoredEntryValue(storageKey, key) {
    if (storageKey === NAME2_KEY) return name2EntryMap.get(key) || "";
    if (storageKey === VIETPHRASE2_KEY) return vietPhrase2EntryMap.get(key) || "";
    if (storageKey === DICT_KEY) return customEntryMap.get(key) || "";
    return "";
  }

  function getVietPhraseOptions(key) {
    const values = [];
    const storedVp = findStoredEntryValue(VIETPHRASE2_KEY, key);
    const exactVp = findExactTranslation(key);
    appendMeaningOptions(values, storedVp);
    appendMeaningOptions(values, exactVp);

    if (!values.length && key) {
      appendMeaningOptions(values, translateTextForEditOption(key));
    }

    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  function appendMeaningOptions(target, value) {
    for (const part of String(value || "").split("/")) {
      const item = part.trim();
      if (item) target.push(item);
    }
  }

  function findExactTranslation(key) {
    const customVal = findObjectTrieExactValue(customTrie, key);
    if (customVal) return customVal;
    const name2Val = findObjectTrieExactValue(name2Trie, key);
    if (name2Val) return name2Val;
    const vp2Val = findObjectTrieExactValue(vietPhrase2Trie, key);
    if (vp2Val) return vp2Val;
    return findPackedTrieExactValue(key) || "";
  }

  function translateTextForEditOption(text) {
    if (!shouldProcessText(text)) return text;

    const input = createTranslationInput(text);
    const source = input.text;
    const tokens = [];
    let index = 0;

    while (index < source.length) {
      const match = findLongestMatch(source, index);
      if (match) {
        if (source[index] === POSSESSIVE_PARTICLE && match.length === POSSESSIVE_PARTICLE.length) {
          tokens.push({ type: "space", value: " " });
        } else {
          tokens.push({
            type: "word",
            value: match.value,
            key: source.slice(index, index + match.length),
            sourceStart: input.mapIndex(index),
            sourceEnd: input.mapIndex(index + match.length)
          });
        }
        index += match.length;
        continue;
      }

      const punct = normalizeChinesePunctuationAt(source, index);
      if (punct) {
        tokens.push({ type: classifyPunctuation(punct.value), value: punct.value });
        index += punct.length;
        continue;
      }

      const char = source[index];
      tokens.push({ type: classifyRawChar(char), value: char });
      index += 1;
    }

    return joinTokensWithoutCapitalization(tokens).text;
  }

  function createTranslationInput(text) {
    const source = String(text || "");
    const simplified = simplifyChineseText(source);
    if (simplified === source) {
      return {
        text: source,
        mapIndex(index) {
          return index;
        }
      };
    }

    return {
      text: simplified,
      mapIndex(index) {
        if (simplified.length === source.length) return index;
        if (!simplified.length) return 0;
        return Math.max(0, Math.min(source.length, Math.round((index / simplified.length) * source.length)));
      }
    };
  }

  function simplifyChineseText(text) {
    const source = String(text || "");
    if (!settings.simplifyTraditional || !source || !CJK_RE.test(source)) return source;
    const converter = getOpenCcSimplifier();
    if (!converter) return source;
    try {
      return converter(source);
    } catch (error) {
      perfLog("opencc.error", error && error.message ? error.message : error);
      return source;
    }
  }

  function getOpenCcSimplifier() {
    if (openCcSimplifierInitialized) return openCcSimplifier;
    openCcSimplifierInitialized = true;
    try {
      const openCc = globalThis.OpenCC;
      openCcSimplifier = openCc && typeof openCc.Converter === "function"
        ? openCc.Converter({ from: "tw", to: "cn" })
        : null;
    } catch (error) {
      perfLog("opencc.init.error", error && error.message ? error.message : error);
      openCcSimplifier = null;
    }
    return openCcSimplifier;
  }

  function findObjectTrieExactValue(root, key) {
    if (!root || !key) return "";
    let node = root;
    for (const char of key) {
      node = node.children.get(char);
      if (!node) return "";
    }
    return node.value || "";
  }

  function findPackedTrieExactValue(key) {
    return findPackedTrieExactValueFromTrie(baseTrie, key);
  }

  function findPackedTrieExactValueFromTrie(trie, key) {
    if (isTrieEmpty(trie) || !key) return "";
    let nodeIndex = 0;
    for (let index = 0; index < key.length;) {
      const charCode = key.codePointAt(index);
      const charLength = charCode > 0xffff ? 2 : 1;
      const targetIndex = findPackedTrieChildFromTrie(trie, nodeIndex, charCode);
      if (targetIndex < 0) return "";
      nodeIndex = targetIndex;
      index += charLength;
    }
    return trie.valueIds[nodeIndex] > 0 ? readPackedTrieRawValueFromTrie(trie, nodeIndex) : "";
  }

  function createHanVietHint(key) {
    return Array.from(String(key || ""))
      .map((char) => pickPrimaryMeaning(findPackedTrieExactValueFromTrie(hanVietTrie, char)) || char)
      .join(" ");
  }

  function insertPersonalEntry(storageKey, key, value, layerSize) {
    const wasKnown = dictionaryKeys.has(key);
    const runtimeValue = pickPrimaryMeaning(value);
    dictionaryKeys.add(key);
    if (!wasKnown) dictionaryStats.total += 1;
    if (storageKey === NAME2_KEY) {
      name2EntryMap.set(key, value);
      insertTrieEntry(name2Trie, key, runtimeValue);
      dictionaryStats.name2 = layerSize;
    } else if (storageKey === VIETPHRASE2_KEY) {
      vietPhrase2EntryMap.set(key, value);
      insertTrieEntry(vietPhrase2Trie, key, runtimeValue);
      dictionaryStats.vietPhrase2 = layerSize;
    } else if (storageKey === DICT_KEY) {
      customEntryMap.set(key, value);
      insertTrieEntry(customTrie, key, runtimeValue);
      dictionaryStats.custom = layerSize;
    }
  }

  function pickPrimaryMeaning(value) {
    const text = String(value || "").trim();
    if (!text.includes("/")) return text;
    return text.split("/").map((part) => part.trim()).find(Boolean) || text;
  }

  function hideEditPanel() {
    window.removeEventListener("resize", syncEditPanelGeometry);
    window.removeEventListener("scroll", scheduleEditPanelGeometrySync, true);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", syncEditPanelGeometry);
      window.visualViewport.removeEventListener("scroll", scheduleEditPanelGeometrySync);
    }
    if (editPanelSyncFrame) {
      window.cancelAnimationFrame(editPanelSyncFrame);
      editPanelSyncFrame = 0;
    }
    hideEditOpenButton();
    clearEditHighlight();
    if (editPanel) {
      editPanel.remove();
      editPanel = null;
    }
    editPanelState = null;
    editPanelResultDraft = "";
    hasEditPanelResultDraft = false;
    editPanelViewportSnapshot = null;
  }

  function shouldProcessText(value) {
    return Boolean(value && (CJK_RE.test(value) || CHINESE_PUNCTUATION_RE.test(value)));
  }

  function shouldSkipElement(element) {
    if (!element || SKIP_TAGS.has(element.tagName)) return true;
    if (element.isContentEditable) return true;
    if (element.closest("[data-vp-ignore], .vp-ignore, .vp-edit-panel")) return true;

    // Cho phép dịch phụ đề / danmaku (stv-lite style)
    const isSubtitleLike = element.closest(
      ".bpx-player-subtitle-panel-text, .bpx-player-subtitle-wrap, .subtitle-item-text, .subtitle-text, .player-subtitle, .vjs-text-track-display, .vjs-text-track-cue, .ytp-caption-segment, .captions-text, [class*='subtitle' i], [class*='caption' i], .bili-danmaku-x-dm, .danmu-item, .web-player-danmaku"
    );
    if (isSubtitleLike) return false;

    // Bỏ qua vùng control/player chính để không phá video
    // (STV scope) không loại trừ vùng player: dịch mọi text node.
    return false;
  }

  function shouldSkipFormElement(element) {
    if (!element) return true;
    if (!["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(element.tagName)) return true;
    if (element.closest("[data-vp-ignore], .vp-ignore, .vp-edit-panel")) return true;
    return false;
  }

  // Ưu tiên dịch nhanh phụ đề / danmaku (giống STV-Lite)
  function isLikelySubtitle(node) {
    if (!node) return false;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const t = (node.nodeType === Node.TEXT_NODE ? node.textContent : el.textContent) || "";
    if (t.length === 0 || t.length > 150) return false;
    if (!CJK_RE.test(t)) return false;
    const cls = (el.className && String(el.className)) || "";
    const id = el.id || "";
    if (SUBTITLE_HINT_RE.test(cls) || SUBTITLE_HINT_RE.test(id)) return true;
    const p = el.parentElement;
    if (p) {
      const pc = (p.className && String(p.className)) || "";
      const pi = p.id || "";
      if (SUBTITLE_HINT_RE.test(pc) || SUBTITLE_HINT_RE.test(pi)) return true;
    }
    // Text ngắn gần video thường là phụ đề
    if (t.length <= 90) return true;
    return false;
  }

  function shouldTranslateVisibleTextInElement(element, source) {
    if (!element) return false;
    if (isIconLikeElement(element, source)) return false;
    return true;
  }

  function isIconLikeElement(element, source) {
    if (!element) return false;
    if (CJK_RE.test(String(source || ""))) return false;
    if (element.closest("svg, [aria-hidden='true'], [role='img'], [data-icon], .vp-edit-panel")) return true;
    if (ICON_TEXT_RE.test(String(source || "").trim())) return true;

    let current = element;
    let depth = 0;
    while (current && current.nodeType === Node.ELEMENT_NODE && depth < 5) {
      const className = typeof current.className === "string" ? current.className : "";
      if (ICON_CLASS_RE.test(className)) return true;
      current = current.parentElement;
      depth += 1;
    }
    return false;
  }

  function scheduleIdle(callback) {
    if ("requestIdleCallback" in globalThis) {
      globalThis.requestIdleCallback(callback, { timeout: 250 });
    } else {
      globalThis.setTimeout(() => callback(null), 0);
    }
  }

  function hasIdleTime(deadline) {
    return !deadline || deadline.timeRemaining() > 1 || deadline.didTimeout;
  }

  function now() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  function perfLog(label, value) {
    if (DEBUG_PERF) console.debug("[VietPhrase]", label, value);
  }
})();


})();
