/*
 * Sinheo-Comfyui-PromptLibrary · 前端扩展
 *
 * 仿 Goohai 图库节点的紧凑版式：两行控件（勾选菜单触发 / 随机开关）+ 词库管理条
 * + 可编辑文本框 + 底部一行按钮（＋ 添加到 / 选择小类 / 生成 / 复制），不显示常驻说明文字。
 * 勾选菜单里：大类 -> 小类 -> 具体词条，可搜索、可勾选、可每个大类随机、可 ▲▼ 循环排序。
 * 词库只有两级：大类文件夹 / 小类.txt，一个小类就是一个 TXT，每次只贡献 1 条关键词。
 * 随机「关」：只输出文本框里的文字，可手改；底部「生成」手动抽词、「＋ 添加到」收藏到词库。
 * 随机「开」：每次运行按勾选菜单重新随机抽词，文本框只读且内容不参与输出；
 *             「生成」停用，但「复制」可复制本次运行产生的提示词，「＋ 添加到」也能收藏它。
 * 数据全部来自 ComfyUI/models/Sinheo/prompts/**，节点本身不保存提示词。
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "SinheoLoadText";
const MAX_ITEMS = 300;
const UNGROUPED = "未分组";

const nodes = new Set();
const states = new WeakMap();
let libraryCache = null;
let pendingLibrary = null;
let popup = null;
let mgr = null;
let exporter = null;
let adder = null;

/* ------------------------------------------------------------------ 工具 */

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function button(label, title, onClick, extraClass) {
  const el = make("button", `sh-btn${extraClass ? " " + extraClass : ""}`, label);
  el.type = "button";
  if (title) el.title = title;
  el.onclick = onClick;
  return el;
}

function stopCanvasEvents(el) {
  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick",
                      "wheel", "keydown", "keyup", "contextmenu", "dragover", "drop"]) {
    el.addEventListener(type, event => event.stopPropagation());
  }
}

function injectCSS() {
  let href;
  try {
    href = new URL("./sinheo.css", import.meta.url).href;
  } catch (error) {
    href = "/extensions/Sinheo-Comfyui-PromptLibrary/sinheo.css";
  }
  if (document.querySelector('link[data-sinheo="1"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.sinheo = "1";
  document.head.appendChild(link);
}

async function requestJSON(path, options) {
  const response = await api.fetchApi(path, options);
  let data = {};
  try { data = await response.json(); } catch (error) { /* 非 JSON 响应 */ }
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

async function getLibrary(force = false) {
  if (force) libraryCache = null;
  if (libraryCache) return libraryCache;
  if (pendingLibrary) return pendingLibrary;
  pendingLibrary = (async () => {
    const data = await requestJSON("/sinheo/library");
    libraryCache = data;
    return data;
  })().finally(() => { pendingLibrary = null; });
  return pendingLibrary;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) { /* 走兜底 */ }
  const area = make("textarea");
  area.value = text;
  area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (error) { /* 忽略 */ }
  area.remove();
  return ok;
}

const PREVIEW_HINT = "手写提示词，或点「生成」随机抽词";
const RANDOM_HINT = "随机模式：运行工作流后这里显示本次生成的提示词";

function flash(el, text, restore, delay = 1400) {
  if (!el) return;
  el.textContent = text;
  setTimeout(() => { el.textContent = restore; }, delay);
}

/** 底部不再常驻说明文字：状态记在隐藏元素里，详情挂到按钮 title 供悬停查看。 */
function setStatus(node, text, btn) {
  const state = stateOf(node);
  const value = String(text ?? "");
  if (state.statusEl) state.statusEl.textContent = value;
  state.lastStatus = value;
  if (btn) btn.title = value;
  return value;
}

function highlight(container, text, query) {
  container.replaceChildren();
  if (!query) { container.textContent = text; return; }
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let cursor = 0, index;
  while ((index = lower.indexOf(needle, cursor)) !== -1) {
    if (index > cursor) container.appendChild(document.createTextNode(text.slice(cursor, index)));
    container.appendChild(make("mark", "", text.slice(index, index + needle.length)));
    cursor = index + needle.length;
  }
  if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
}

function naturalCompare(a, b) {
  const ax = String(a).split(/(\d+)/), bx = String(b).split(/(\d+)/);
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const av = ax[i] ?? "", bv = bx[i] ?? "";
    const an = /^\d+$/.test(av), bn = /^\d+$/.test(bv);
    if (an && bn) {
      const diff = Number(av) - Number(bv);
      if (diff) return diff;
    } else if (av.toLowerCase() !== bv.toLowerCase()) {
      return av.toLowerCase() < bv.toLowerCase() ? -1 : 1;
    }
  }
  return 0;
}

function orderedIds(keys, preferred) {
  const available = new Set(keys);
  const seen = new Set(), head = [];
  for (const key of (Array.isArray(preferred) ? preferred : [])) {
    if (available.has(key) && !seen.has(key)) { seen.add(key); head.push(key); }
  }
  const tail = keys.filter(key => !seen.has(key)).sort(naturalCompare);
  return head.concat(tail);
}

/**
 * 排序：相邻交换；到顶再按 ▲ 会绕到底部，到底再按 ▼ 会绕回顶部。
 * 大类和同组内的小类都走这个函数。
 */
function moveOrdered(arr, index, delta) {
  if (index < 0 || arr.length < 2) return false;
  const target = index + delta;
  if (target >= 0 && target < arr.length) {
    [arr[index], arr[target]] = [arr[target], arr[index]];
    return true;
  }
  const [item] = arr.splice(index, 1);
  if (delta < 0) arr.push(item);       // 顶部上移 -> 底部
  else arr.unshift(item);              // 底部下移 -> 顶部
  return true;
}

/* ------------------------------------------------- 配置（存进工作流 JSON） */

function defaultConfig() {
  return {
    randomize: false,
    order: [], catOrder: {}, groups: {}, cats: {},
    separator: ", ", prefix: "", suffix: "", extra: "", count: 1, seed: 0,
  };
}

function configWidget(node) {
  return (node.widgets || []).find(widget => widget.name === "config");
}

function manualWidget(node) {
  return (node.widgets || []).find(widget => widget.name === "manual_text");
}

function readConfig(node) {
  const base = defaultConfig();
  try {
    const raw = configWidget(node)?.value;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(base, parsed);
  } catch (error) { /* 坏配置按默认处理 */ }
  for (const key of ["catOrder", "groups", "cats"]) {
    if (!base[key] || typeof base[key] !== "object" || Array.isArray(base[key])) base[key] = {};
  }
  if (!Array.isArray(base.order)) base.order = [];
  return base;
}

function writeConfig(node) {
  const state = states.get(node);
  const widget = configWidget(node);
  if (!state || !widget) return;
  widget.value = JSON.stringify(state.config);
  node.setDirtyCanvas?.(true, true);
  try { node.graph?.change?.(); } catch (error) { /* 忽略旧版差异 */ }
}

function stateOf(node) {
  let state = states.get(node);
  if (!state) {
    state = {
      config: readConfig(node), library: null, filter: "",
      collapsed: new Set(), expanded: new Set(), lastText: "", lastRandomText: "",
      initialFill: false, textTimer: null, addTargets: new Set(),
      rootEl: null, triggerEl: null, valueEl: null, randomEl: null,
      barEl: null, previewEl: null, statusEl: null,
      genEl: null, copyEl: null, addEl: null, addTargetEl: null,
      popupList: null,
    };
    states.set(node, state);
  }
  return state;
}

function groupCfg(state, gid) {
  if (!state.config.groups[gid] || typeof state.config.groups[gid] !== "object") {
    state.config.groups[gid] = { on: true, random: false, pick: 1 };
  }
  return state.config.groups[gid];
}

function catCfg(state, cid) {
  if (!state.config.cats[cid] || typeof state.config.cats[cid] !== "object") {
    state.config.cats[cid] = { on: true, picks: [] };
  }
  const cfg = state.config.cats[cid];
  if (!Array.isArray(cfg.picks)) cfg.picks = [];
  delete cfg.mode;                  // 旧工作流残留的「全部拼接」一律忽略
  return cfg;
}

const isGroupOn = (state, gid) => state.config.groups[gid]?.on !== false;
const isCatOn = (state, cid) => state.config.cats[cid]?.on !== false;

function groupMap(state) {
  return new Map((state.library?.groups || []).map(group => [group.id, group]));
}

function currentGroupOrder(state) {
  return orderedIds((state.library?.groups || []).map(group => group.id), state.config.order);
}

function currentCatOrder(state, group) {
  return orderedIds((group?.categories || []).map(cat => cat.id),
                    state.config.catOrder[group?.id] || []);
}

function materializeOrder(state) {
  state.config.order = currentGroupOrder(state);
  const next = {};
  for (const group of state.library?.groups || []) {
    next[group.id] = currentCatOrder(state, group);
  }
  state.config.catOrder = next;
}

/* ------------------------------------------------------------- 节点主体 UI */

function setPreview(node, text, hint = false) {
  const state = stateOf(node);
  const el = state.previewEl;
  if (!el) return;
  el.value = hint ? "" : String(text ?? "");
  el.placeholder = hint ? String(text ?? "") : PREVIEW_HINT;
  el.classList.toggle("sh-placeholder", hint);
}

/** 把一段文字写进「文本框 + 隐藏的 manual_text widget」，不覆盖配置。 */
function setText(node, text) {
  const state = stateOf(node);
  const value = String(text ?? "");
  const widget = manualWidget(node);
  if (widget) widget.value = value;      // 隐藏 widget 仍会参与工作流序列化
  state.lastText = value;
  const el = state.previewEl;
  if (el) {
    el.value = value;
    el.classList.remove("sh-placeholder");
  }
}

/** 打字时延迟标记工作流已改动，避免每个按键都触发一次全图序列化。 */
function commitText(node) {
  const state = stateOf(node);
  clearTimeout(state.textTimer);
  state.textTimer = setTimeout(() => {
    try { node.graph?.change?.(); } catch (error) { /* 旧版差异 */ }
  }, 250);
}

function syncControls(node) {
  const state = stateOf(node);
  const locked = Boolean(state.config.randomize);
  if (state.genEl) {
    state.genEl.disabled = locked;
    state.genEl.title = locked
      ? "随机开关已打开：运行时自动抽词，「生成」停用；关掉「随机」后恢复"
      : "按勾选菜单随机抽一批提示词填进文本框，可手动修改（仅随机关闭时可用）";
  }
  // 「复制」在两种模式下都可用：随机模式复制的是本次运行产生的提示词
  if (state.copyEl) {
    state.copyEl.disabled = false;
    state.copyEl.title = locked
      ? "复制本次运行产生的随机提示词（先运行一次工作流，文本框里就是结果）"
      : "复制文本框里的提示词";
  }
  if (state.addEl) {
    state.addEl.disabled = false;
    state.addEl.title = "把当前提示词按行追加到目标小类；右边「选择小类」可弹窗勾选目标";
  }
  if (state.addTargetEl) {
    const count = state.addTargets.size;
    state.addTargetEl.textContent = count ? `🎯 已选 ${count} 类 ▾` : "🎯 选择小类 ▾";
    state.addTargetEl.classList.toggle("sh-picked-target", count > 0);
  }
}

function updateSummary(node) {
  const state = stateOf(node);
  if (!state.rootEl) return;
  const lib = state.library;
  const gmap = groupMap(state);
  const random = Boolean(state.config.randomize);
  let enabled = 0;
  for (const gid of currentGroupOrder(state)) {
    const group = gmap.get(gid);
    if (!group || !isGroupOn(state, gid)) continue;
    for (const cat of group.categories) if (isCatOn(state, cat.id)) enabled++;
  }
  // 行内只显示结果，不再写长句说明
  state.valueEl.textContent = random
    ? `🎲 随机 · ${enabled} 个小类`
    : `☑ 已选 ${enabled} 个小类`;
  state.randomEl.classList.toggle("sh-on", random);
  state.randomEl.title = random
    ? "随机：开 —— 每次运行从已勾选的小类里重新抽词，文本框内容不参与输出（「生成」停用，「复制」仍可用）"
    : "随机：关 —— 只输出文本框里的提示词，可点「生成」重新抽词";
  state.barEl.textContent = `⚙ 词库管理 · ${lib?.categories?.length || 0} 个小类 / ${lib?.total || 0} 条`;
  setStatus(node, lib
    ? (random ? `随机模式 · 运行时自动抽词（${enabled} 个小类）`
              : `文本框模式 · ${enabled} 个小类`)
    : "读取词库中…");
}

function applyMode(node) {
  const state = stateOf(node);
  const random = Boolean(state.config.randomize);
  const widget = manualWidget(node);
  const cfg = configWidget(node);
  // 原生多行框永远隐藏：可编辑文本框由节点面板自己提供
  if (widget) widget.hidden = true;
  if (cfg) cfg.hidden = true;

  const el = state.previewEl;
  if (el) {
    el.readOnly = random;
    el.classList.toggle("sh-locked", random);
    if (random) {
      // 随机模式只「展示」最近一次随机结果，绝不写回 manual_text
      setPreview(node, state.lastRandomText || RANDOM_HINT, !state.lastRandomText);
    } else {
      // 关闭随机后恢复用户自己写的文字
      setPreview(node, typeof widget?.value === "string" ? widget.value : "", false);
    }
  }
  state.rootEl?.classList.toggle("sh-random-on", random);
  syncControls(node);
  updateSummary(node);
  node.setDirtyCanvas?.(true, true);
}

/** 「生成」按钮：手动随机抽一批词填进文本框（仅在随机关闭时可用）。 */
async function generateInto(node, btn) {
  const state = stateOf(node);
  if (state.config.randomize) return;
  const label = "生成";
  btn.disabled = true;
  btn.textContent = "生成中…";
  try {
    if (!state.library) await loadInto(node, true);
    if (!state.library) {
      setStatus(node, "词库读取失败，点词库管理里的 ↻ 重试", btn);
      flash(btn, "词库不可用", label);
      return;
    }
    const payload = { ...state.config };
    delete payload.text;               // 正文不在 config 里，去掉冗余字段
    const data = await requestJSON("/sinheo/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: payload, random: true }),
    });
    const text = typeof data.text === "string" ? data.text : "";
    setText(node, text);
    commitText(node);
    setStatus(node, text
      ? "已随机生成，可直接改文字；运行时按改动后的内容输出"
      : "词库为空或没勾任何小类，请在类型菜单里勾几项", btn);
    flash(btn, text ? "已生成" : "词库为空", label);
  } catch (error) {
    setStatus(node, `生成失败：${error.message}`, btn);
    flash(btn, "生成失败", label);
  } finally {
    btn.disabled = Boolean(state.config.randomize);
  }
}

/** 新节点（文本框为空）自动按菜单顺序填一份确定性提示词，避免空输出。 */
async function ensureInitialText(node) {
  const state = stateOf(node);
  if (state.initialFill || !state.library || state.config.randomize) return;
  const widget = manualWidget(node);
  if (typeof widget?.value === "string" && widget.value.trim()) return;
  state.initialFill = true;
  try {
    const data = await requestJSON("/sinheo/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: state.config, random: false }),
    });
    const text = typeof data.text === "string" ? data.text : "";
    if (text.trim()) {
      setText(node, text);
      commitText(node);
      setStatus(node, "已按菜单顺序填入初始提示词，可手动修改；点「生成」换一批随机词");
    }
  } catch (error) { /* 静默：用户仍可点「生成」或手写 */ }
}

function buildBody(node) {
  const state = stateOf(node);
  injectCSS();
  const root = make("div", "sh-body");
  stopCanvasEvents(root);

  const trigger = make("div", "sh-row sh-trigger");
  trigger.title = "打开勾选菜单：搜索 / 勾选 / 每个大类随机 / 手动排序";
  const valueEl = make("span", "sh-row-value", "读取词库中…");
  trigger.append(make("span", "sh-arrow", "◀"), make("span", "sh-row-label", "类型"),
                 valueEl, make("span", "sh-caret", "▾"));
  trigger.onclick = event => { event.stopPropagation(); toggleChecklist(node, trigger); };

  const randomRow = make("div", "sh-row sh-random");
  randomRow.append(make("span", "sh-arrow", "◀"), make("span", "sh-row-label", "随机"),
                   make("span", "sh-switch"));
  randomRow.onclick = event => {
    event.stopPropagation();
    state.config.randomize = !state.config.randomize;
    writeConfig(node);
    applyMode(node);
  };

  const bar = make("div", "sh-bar");
  const barMain = make("button", "sh-bar-main", "⚙ 词库管理");
  barMain.type = "button";
  barMain.onclick = event => { event.stopPropagation(); void openManager(node); };
  const refresh = make("button", "sh-bar-gear", "↻");
  refresh.type = "button";
  refresh.title = "重新扫描 models/Sinheo/prompts";
  refresh.onclick = event => { event.stopPropagation(); void refreshAll(true); };
  bar.append(barMain, refresh);

  const preview = make("textarea", "sh-preview sh-placeholder");
  preview.spellcheck = false;
  preview.wrap = "soft";
  preview.placeholder = PREVIEW_HINT;
  preview.title = "随机关闭时，节点只输出这段文本；可直接手动修改";
  preview.oninput = () => {
    if (state.config.randomize) return;      // 随机模式只读
    setText(node, preview.value);
    commitText(node);
  };
  preview.onchange = () => commitText(node);

  // 底部只留一行按钮：＋ 添加到 / 🎯 选择小类 / 生成 / 复制，不显示常驻说明文字
  const foot = make("div", "sh-foot");
  const status = make("span", "sh-status", "");
  status.hidden = true;                  // 仅作内部状态记录，不参与布局
  const add = button("＋ 添加到", "把当前提示词按行追加到目标小类（弹窗勾选）",
                     () => void addCurrent(node));
  const addTarget = button("🎯 选择小类 ▾", "弹窗勾选要添加到哪些小类",
                           () => openAdder(node, false));
  const generate = button("生成", "按勾选菜单随机抽一批提示词填进文本框（仅随机关闭时可用）",
                          () => void generateInto(node, generate));
  const copy = button("复制", "复制文本框里的提示词（随机模式下复制本次运行结果）", async () => {
    const text = currentPromptText(node);
    if (!text.trim()) {
      setStatus(node, state.config.randomize
        ? "请先运行一次工作流，文本框里才会显示本次随机提示词"
        : "文本框是空的，没有可复制的内容", copy);
      flash(copy, "无内容", "复制");
      return;
    }
    const ok = await copyText(text);
    if (ok) setStatus(node, state.config.randomize
      ? "已复制本次运行产生的随机提示词"
      : "已复制文本框里的提示词", copy);
    flash(copy, ok ? "已复制" : "复制失败", "复制");
  });
  foot.append(add, addTarget, generate, copy);
  root.append(trigger, randomRow, bar, preview, foot, status);
  Object.assign(state, {
    rootEl: root, triggerEl: trigger, valueEl, randomEl: randomRow,
    barEl: barMain, previewEl: preview, statusEl: status,
    genEl: generate, copyEl: copy, addEl: add, addTargetEl: addTarget,
  });

  let domWidget = null;
  try {
    domWidget = node.addDOMWidget("sinheo_body", "sinheo_body", root, {
      serialize: false, hideOnZoom: false, margin: 12,
      getMinHeight: () => 340, getMaxHeight: () => undefined,
    });
  } catch (error) {
    console.error("[Sinheo] 无法创建节点面板：", error);
  }
  const previous = node.getWidgetOnPos;
  node.getWidgetOnPos = function () {
    const found = previous?.apply(this, arguments);
    return found === domWidget ? undefined : found;
  };
  try { node.setSize?.([Math.max(node.size?.[0] || 0, 400), Math.max(node.size?.[1] || 0, 560)]); }
  catch (error) { /* 旧版节点无 setSize */ }
  return root;
}

async function loadInto(node, force = false) {
  const state = stateOf(node);
  try {
    state.library = await getLibrary(force);
    state.config = readConfig(node);
    applyMode(node);
    void ensureInitialText(node);
  } catch (error) {
    setPreview(node, `读取词库失败：${error.message}`, true);
  }
}

async function refreshAll(force = true) {
  if (force) libraryCache = null;
  await Promise.all([...nodes].map(node => loadInto(node, force)));
  if (popup) renderPopup(popup.node);
  if (mgr && !mgr.wrap.hidden) await refreshManager(force);
}

/* -------------------------------------------------------------- 勾选菜单 */

function closePopup() {
  if (!popup) return;
  const current = popup;
  popup = null;
  current.el.remove();
  document.removeEventListener("pointerdown", current.onDoc, true);
  document.removeEventListener("keydown", current.onKey, true);
  const state = states.get(current.node);
  if (state) state.popupList = null;
}

function positionPopup(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = 340, wanted = 520;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.bottom + 4;
  if (top + wanted > window.innerHeight - 8) top = Math.max(8, rect.top - wanted - 4);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.maxHeight = `${Math.max(180, Math.min(560, window.innerHeight - top - 8))}px`;
}

function toggleChecklist(node, anchor) {
  if (popup && popup.node === node) { closePopup(); return; }
  closePopup();
  const state = stateOf(node);
  const el = make("div", "sh-pop");
  stopCanvasEvents(el);

  const head = make("div", "sh-pop-head");
  const filter = make("input", "sh-filter");
  filter.type = "text";
  filter.placeholder = "Filter list";
  filter.title = "搜索大类 / 小类 / 具体提示词";
  let timer = null;
  filter.oninput = () => {
    clearTimeout(timer);
    const value = filter.value;
    timer = setTimeout(() => { state.filter = value; renderPopup(node); }, 120);
  };
  head.append(filter, button("✕", "关闭", () => closePopup(), "sh-mini"));

  const tools = make("div", "sh-pop-tools");
  tools.append(
    button("全选", "勾选当前筛选出的小类", () => bulkSet(node, "on"), "sh-mini"),
    button("全不选", "取消当前筛选出的小类", () => bulkSet(node, "off"), "sh-mini"),
    button("反选", "反转当前筛选出的小类", () => bulkSet(node, "invert"), "sh-mini"),
    button("↻ 刷新", "重新读取词库", () => void refreshAll(true), "sh-mini"),
  );

  const list = make("div", "sh-pop-list");
  const foot = make("div", "sh-pop-foot");
  const details = make("details");
  details.append(make("summary", "", "⚙ 拼接设置 · 分隔符 / 前后缀 / 条数"));
  const opts = make("div", "sh-opts");
  const optionInput = (label, key, width) => {
    const wrap = make("label", "", label);
    const input = make("input", `sh-input ${width}`);
    input.type = key === "count" ? "number" : "text";
    if (key === "count") { input.min = "1"; input.max = "50"; }
    input.value = state.config[key] ?? "";
    input.onchange = () => {
      state.config[key] = key === "count"
        ? Math.max(1, Math.min(50, Number(input.value) || 1))
        : input.value;
      writeConfig(node);
    };
    wrap.append(input);
    return wrap;
  };
  opts.append(
    optionInput(" 分隔符 ", "separator", "w-sm"),
    optionInput(" 前缀 ", "prefix", "w-md"),
    optionInput(" 后缀 ", "suffix", "w-md"),
    optionInput(" 条数 ", "count", "w-sm"),
  );
  details.append(opts);
  const hint = make("div", "sh-hint", "输出顺序 = 上方菜单顺序，用 ▲▼ 调整；改完勾选点节点上的「生成」才会更新文本框。");
  hint.style.cssText = "margin-top:5px;color:#8d97a8;font-size:10px;";
  foot.append(details, hint);

  el.append(head, tools, list, foot);
  document.body.appendChild(el);
  positionPopup(el, anchor);

  const onDoc = event => {
    if (!el.contains(event.target) && !anchor.contains(event.target)) closePopup();
  };
  const onKey = event => { if (event.key === "Escape") closePopup(); };
  document.addEventListener("pointerdown", onDoc, true);
  document.addEventListener("keydown", onKey, true);
  popup = { el, node, onDoc, onKey };
  state.popupList = list;
  renderPopup(node);
}

function bulkSet(node, action) {
  const state = stateOf(node);
  const query = state.filter.trim().toLowerCase();
  for (const group of state.library?.groups || []) {
    for (const cat of group.categories) {
      const visible = !query || group.label.toLowerCase().includes(query)
        || cat.label.toLowerCase().includes(query) || cat.id.toLowerCase().includes(query)
        || cat.items.some(item => item.toLowerCase().includes(query));
      if (!visible) continue;
      const current = isCatOn(state, cat.id);
      catCfg(state, cat.id).on = action === "invert" ? !current : action === "on";
    }
    groupCfg(state, group.id).on = true;
  }
  writeConfig(node);
  updateSummary(node);
  renderPopup(node);
}

function moveGroup(node, gid, delta) {
  const state = stateOf(node);
  materializeOrder(state);
  if (moveOrdered(state.config.order, state.config.order.indexOf(gid), delta)) {
    writeConfig(node);
    renderPopup(node);
  }
}

function moveCat(node, group, cid, delta) {
  const state = stateOf(node);
  materializeOrder(state);
  const ids = state.config.catOrder[group.id] || [];
  if (moveOrdered(ids, ids.indexOf(cid), delta)) {
    state.config.catOrder[group.id] = ids;
    writeConfig(node);
    renderPopup(node);
  }
}

function buildCatRow(node, group, cat, query, matched) {
  const state = stateOf(node);
  const wrap = make("div");
  const row = make("div", `sh-cat${isCatOn(state, cat.id) ? "" : " sh-off"}`);
  const box = make("input");
  box.type = "checkbox";
  box.checked = isCatOn(state, cat.id);
  box.title = "勾选后这个小类参与生成";
  box.onchange = () => {
    catCfg(state, cat.id).on = box.checked;
    writeConfig(node);
    updateSummary(node);
    renderPopup(node);
  };
  const expanded = Boolean(query && matched.length) || state.expanded.has(cat.id);
  const caret = make("button", "sh-caret-btn", expanded ? "▾" : "▸");
  caret.type = "button";
  caret.title = "展开勾选具体提示词";
  const name = make("span", "sh-cat-name");
  highlight(name, cat.label, query);
  name.title = `${cat.id} · ${cat.count} 条`;
  const toggle = () => {
    if (state.expanded.has(cat.id)) state.expanded.delete(cat.id);
    else state.expanded.add(cat.id);
    renderPopup(node);
  };
  caret.onclick = event => { event.stopPropagation(); toggle(); };
  name.onclick = event => { event.stopPropagation(); toggle(); };
  row.append(box, caret, name, make("span", "sh-cat-count", cat.count),
    button("▲", "上移小类（到顶自动绕到底部）", () => moveCat(node, group, cat.id, -1), "sh-mini"),
    button("▼", "下移小类（到底自动绕回顶部）", () => moveCat(node, group, cat.id, 1), "sh-mini"));
  wrap.append(row);

  if (expanded) {
    const panel = make("div", "sh-items");
    const bar = make("div", "sh-items-bar");
    const label = make("span");
    const rule = make("span", "sh-items-rule", "🎲 每类只出 1 条");
    rule.title = "这个小类永远只贡献 1 条关键词：勾了词条就从勾的里面抽，没勾就从整个小类抽";
    const shown = (query ? matched : cat.items).slice(0, MAX_ITEMS);
    const boxes = [];
    const syncLabel = () => {
      const picks = catCfg(state, cat.id).picks;
      label.textContent = picks.length ? `已勾 ${picks.length} 条` : "未勾 = 整个小类";
    };
    const setPicks = values => {
      catCfg(state, cat.id).picks = values;
      for (const item of boxes) {
        const checked = values.includes(item.dataset.value);
        item.input.checked = checked;
        item.row.classList.toggle("sh-picked", checked);
      }
      syncLabel();
      writeConfig(node);
    };
    bar.append(label, rule,
      button("全选", "勾选当前显示的词条（从中随机抽 1 条）", () => setPicks(shown.slice()), "sh-mini"),
      button("清空", "清除本小类的词条勾选", () => setPicks([]), "sh-mini"));
    const items = make("div", "sh-item-list");
    const currentPicks = catCfg(state, cat.id).picks;
    for (const item of shown) {
      const line = make("label", `sh-item${currentPicks.includes(item) ? " sh-picked" : ""}`);
      const input = make("input");
      input.type = "checkbox";
      input.dataset.value = item;
      input.checked = currentPicks.includes(item);
      const text = make("span");
      highlight(text, item, query);
      input.onchange = () => {
        const picks = catCfg(state, cat.id).picks;
        const index = picks.indexOf(item);
        if (input.checked && index === -1) picks.push(item);
        if (!input.checked && index !== -1) picks.splice(index, 1);
        line.classList.toggle("sh-picked", input.checked);
        syncLabel();
        writeConfig(node);
      };
      line.append(input, text);
      items.append(line);
      boxes.push({ input, row: line, dataset: input.dataset });
    }
    if ((query ? matched.length : cat.items.length) > shown.length) {
      items.append(make("div", "sh-empty", `还有 ${(query ? matched.length : cat.items.length) - shown.length} 条未显示，用 Filter list 缩小范围`));
    }
    syncLabel();
    panel.append(bar, items);
    wrap.append(panel);
  }
  return wrap;
}

function renderPopup(node) {
  const state = stateOf(node);
  const list = state.popupList;
  if (!list) return;
  const scroll = list.scrollTop;
  list.replaceChildren();
  const lib = state.library;
  if (!lib) { list.append(make("div", "sh-empty", "词库读取中…")); return; }

  const query = state.filter.trim().toLowerCase();
  const gmap = groupMap(state);
  let shown = 0;
  for (const gid of currentGroupOrder(state)) {
    const group = gmap.get(gid);
    if (!group) continue;
    const cmap = new Map(group.categories.map(cat => [cat.id, cat]));
    const rows = [];
    for (const cid of currentCatOrder(state, group)) {
      const cat = cmap.get(cid);
      if (!cat) continue;
      const matched = query ? cat.items.filter(item => item.toLowerCase().includes(query)) : [];
      const visible = !query || group.label.toLowerCase().includes(query)
        || cat.label.toLowerCase().includes(query) || cat.id.toLowerCase().includes(query)
        || matched.length > 0;
      if (visible) rows.push({ cat, matched });
    }
    if (!rows.length) continue;
    shown++;
    const box = make("div", `sh-group${isGroupOn(state, gid) ? "" : " sh-off"}`);
    const head = make("div", "sh-group-head");
    const gbox = make("input");
    gbox.type = "checkbox";
    gbox.checked = isGroupOn(state, gid);
    gbox.title = "勾选整个大类";
    gbox.onchange = () => {
      groupCfg(state, gid).on = gbox.checked;
      writeConfig(node);
      updateSummary(node);
      renderPopup(node);
    };
    const caret = make("button", "sh-caret-btn", state.collapsed.has(gid) ? "▸" : "▾");
    caret.type = "button";
    const toggle = () => {
      if (state.collapsed.has(gid)) state.collapsed.delete(gid);
      else state.collapsed.add(gid);
      renderPopup(node);
    };
    caret.onclick = event => { event.stopPropagation(); toggle(); };
    const name = make("span", "sh-group-name");
    highlight(name, group.label, query);
    name.title = gid;
    name.onclick = event => { event.stopPropagation(); toggle(); };
    const random = groupCfg(state, gid).random;
    head.append(caret, gbox, name, make("span", "sh-tag", `${group.categories.length} 个小类`),
      button("🎲", "运行时从本大类已勾选的小类里随机抽 1 个（需打开节点上的「随机」）",
        () => { const cfg = groupCfg(state, gid); cfg.random = !cfg.random; writeConfig(node); renderPopup(node); },
        random ? "sh-mini sh-active" : "sh-mini"),
      button("▲", "上移大类（到顶自动绕到底部）", () => moveGroup(node, gid, -1), "sh-mini"),
      button("▼", "下移大类（到底自动绕回顶部）", () => moveGroup(node, gid, 1), "sh-mini"));
    box.append(head);
    if (!state.collapsed.has(gid)) {
      for (const row of rows) box.append(buildCatRow(node, group, row.cat, query, row.matched));
    }
    list.append(box);
  }
  if (!shown) {
    list.append(make("div", "sh-empty", query
      ? "没有匹配的大类 / 小类 / 提示词"
      : `词库为空。\n请把 TXT 放到：\n${lib.root}\n大类文件夹 / 小类.txt（一个小类一个 TXT）`));
  }
  list.scrollTop = scroll;
}

/* ------------------------------------------------------------ 词库管理弹窗 */

function catRel(cat) {
  // 两级词库：一个 TXT 就是一个小类，rel 就是它相对词库根的路径
  if (cat.rel) return cat.rel;
  if (cat.files?.length) return cat.files[0].rel;
  return cat.group === UNGROUPED ? `${cat.label}.txt` : `${cat.group}/${cat.label}.txt`;
}

function ensureManager() {
  if (mgr) return mgr;
  const wrap = make("div", "sh-mgr");
  wrap.hidden = true;
  wrap.style.display = "none";       // 双保险：作者样式 display:grid 会盖掉 [hidden]
  stopCanvasEvents(wrap);
  const box = make("div", "sh-mgr-box");

  const head = make("div", "sh-mgr-head");
  const path = make("span", "sh-mgr-path", "");
  head.append(make("strong", "", "Sinheo · 词库管理"), path,
              button("✕ 关闭", "关闭（也可按 Esc / 点空白处）", () => closeManager()));

  const create = make("div", "sh-mgr-create");
  const newGroup = make("input", "sh-input");
  newGroup.placeholder = "新大类，如 上衣";
  const groupSel = make("select", "sh-select");
  const newCat = make("input", "sh-input");
  newCat.placeholder = "新小类，如 甜美";
  create.append(make("span", "sh-mgr-hint", "＋大类"), newGroup,
    button("创建", "在 models/Sinheo/prompts 下新建大类文件夹", async () => {
      const name = newGroup.value.trim();
      if (!name) return setMessage("请输入大类名称", true);
      await act("/sinheo/create", { kind: "group", name }, `已创建大类「${name}」`);
      newGroup.value = "";
    }, "sh-primary"));
  create.append(make("span", "sh-mgr-hint", "＋小类"), groupSel, newCat,
    button("创建", "在大类下新建一个 TXT 小类（一个小类 = 一个 TXT）", async () => {
      const name = newCat.value.trim();
      if (!name) return setMessage("请输入小类名称", true);
      await act("/sinheo/create", { kind: "category", group: groupSel.value, name },
                `已创建小类「${name}」`);
      newCat.value = "";
    }, "sh-primary"));

  const main = make("div", "sh-mgr-main");
  const tree = make("div", "sh-mgr-side");
  const editor = make("div", "sh-mgr-editor");
  const title = make("div", "sh-mgr-title", "选择左侧一个小类");
  const hint = make("div", "sh-mgr-hint",
    "一个小类 = 一个 TXT：一行一条提示词，# 开头为注释；保存后节点下次运行自动生效。");
  const textarea = make("textarea", "sh-textarea");
  textarea.spellcheck = false;
  textarea.placeholder = "甜美荷叶边泡泡袖上衣\n蝴蝶结蕾丝短款上衣";
  const editorButtons = make("div", "sh-mgr-create");
  editorButtons.style.cssText = "border:0;padding:0;";
  editorButtons.append(
    button("💾 保存", "保存这个小类 TXT（内容一行一条）", () => void saveCurrentFile(), "sh-primary"),
    button("🗑 删除小类", "删除这个小类 TXT（自动备份）", () => void deleteCurrentFile(), "sh-danger"),
  );
  editor.append(title, hint, textarea, editorButtons);
  main.append(tree, editor);

  const foot = make("div", "sh-mgr-foot");
  const msg = make("span", "sh-mgr-msg", "");
  const setMessage = (text, isError = false) => {
    msg.textContent = text || "";
    msg.classList.toggle("sh-error", Boolean(isError));
  };
  const fileInput = make("input");
  fileInput.type = "file";
  fileInput.accept = ".txt,.zip";
  fileInput.style.display = "none";
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("merge", "1");
    form.append("group", importGroup.value === UNGROUPED || importGroup.value === "__new__"
      ? "" : importGroup.value);
    try {
      const data = await requestJSON("/sinheo/import", { method: "POST", body: form });
      const count = Array.isArray(data.saved) ? data.saved.length : 1;
      setMessage(`已导入 ${count} 个 TXT${data.order ? "（含顺序）" : ""}`);
      await refreshAll(true);
    } catch (error) {
      setMessage(`导入失败：${error.message}`, true);
    }
    fileInput.value = "";
  };
  const importGroup = make("select", "sh-select");
  importGroup.title = "选择导入到哪个大类；「未分组」= 直接放在词库根目录";
  importGroup.onchange = async () => {
    if (importGroup.value !== "__new__") return;
    const name = String(window.prompt?.("新大类名称（导入到这个大类）：", "") || "").trim();
    if (!name) { importGroup.value = UNGROUPED; return; }
    try {
      await requestJSON("/sinheo/create", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "group", name }),
      });
      await refreshAll(true);
      importGroup.value = name;
      setMessage(`已创建大类「${name}」，现在可以导入了`);
    } catch (error) {
      importGroup.value = UNGROUPED;
      setMessage(`创建大类失败：${error.message}`, true);
    }
  };
  foot.append(
    button("📥 导入 TXT/ZIP", "可直接导入「提示词管理.html」导出的 ZIP", () => fileInput.click()),
    make("span", "sh-mgr-hint", "导入到"),
    importGroup,
    button("📤 导出 ZIP", "先勾选要导出的大类 / 小类，再下载", () => void openExport()),
    button("↻ 刷新", "重新扫描词库", async () => { await refreshAll(true); setMessage("已刷新"); }),
    button("💾 设为默认顺序", "把当前菜单顺序存成词库默认顺序，新建节点继承", () => void saveDefaultOrder(), "sh-primary"),
    fileInput, msg,
  );

  box.append(head, create, main, foot);
  wrap.append(box);
  wrap.addEventListener("pointerdown", event => { if (event.target === wrap) closeManager(); });
  document.body.appendChild(wrap);

  mgr = {
    wrap, path, tree, groupSel, importGroup, newGroup, newCat, title,
    textarea, setMessage,
    node: null, library: null, currentCat: null,
  };
  return mgr;
}

function closeManager() {
  if (!mgr) return;
  mgr.wrap.hidden = true;
  mgr.wrap.style.display = "none";
}

function setMessage(text, isError = false) {
  ensureManager().setMessage(text, isError);
}

async function act(path, body, success) {
  try {
    await requestJSON(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setMessage(success);
    await refreshAll(true);
  } catch (error) {
    setMessage(`操作失败：${error.message}`, true);
  }
}

function currentCatObject() {
  return (mgr?.library?.categories || []).find(cat => cat.id === mgr.currentCat) || null;
}

async function saveCurrentFile() {
  const cat = currentCatObject();
  if (!cat) return setMessage("请先选择一个小类", true);
  const rel = catRel(cat);
  try {
    const data = await requestJSON("/sinheo/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rel, content: mgr.textarea.value }),
    });
    setMessage(`已保存 ${data.rel}，共 ${data.count} 条`);
    await refreshAll(true);
  } catch (error) {
    setMessage(`保存失败：${error.message}`, true);
  }
}

async function deleteCurrentFile() {
  const cat = currentCatObject();
  const rel = cat ? catRel(cat) : "";
  if (!rel || !confirm(`确定删除小类「${cat.label}」？\n原 TXT 会备份到 .backup/。`)) return;
  await act("/sinheo/delete", { rel }, `已删除 ${rel}（已备份）`);
  mgr.currentCat = null;
}

async function saveDefaultOrder() {
  const state = states.get(mgr.node);
  if (!state || !mgr.library) return;
  const gmap = new Map(mgr.library.groups.map(group => [group.id, group]));
  const groups = currentGroupOrder(state);
  const categories = {};
  for (const gid of groups) {
    const group = gmap.get(gid);
    if (group) categories[gid] = currentCatOrder(state, group);
  }
  try {
    await requestJSON("/sinheo/order", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups, categories }),
    });
    setMessage("已保存为词库默认顺序");
  } catch (error) {
    setMessage(`保存顺序失败：${error.message}`, true);
  }
}

function managerMoveGroup(gid, delta) {
  const state = states.get(mgr.node);
  if (!state) return;
  materializeOrder(state);
  if (moveOrdered(state.config.order, state.config.order.indexOf(gid), delta)) {
    writeConfig(mgr.node);
    updateSummary(mgr.node);
    renderManagerTree();
  }
}

function managerMoveCat(group, cid, delta) {
  const state = states.get(mgr.node);
  if (!state) return;
  materializeOrder(state);
  const ids = state.config.catOrder[group.id] || [];
  if (moveOrdered(ids, ids.indexOf(cid), delta)) {
    state.config.catOrder[group.id] = ids;
    writeConfig(mgr.node);
    renderManagerTree();
  }
}

function renderManagerTree() {
  if (!mgr?.library) return;
  const state = states.get(mgr.node);
  const gmap = new Map(mgr.library.groups.map(group => [group.id, group]));
  const tree = mgr.tree;
  tree.replaceChildren();
  const groupIds = state ? currentGroupOrder(state) : mgr.library.groups.map(g => g.id);
  for (const gid of groupIds) {
    const group = gmap.get(gid);
    if (!group) continue;
    const cont = make("div", "sh-tree-group");
    const head = make("div", "sh-tree-row sh-group-row");
    head.append(make("span", "sh-t-name", group.label), make("small", "", `${group.categories.length}`));
    if (gid !== UNGROUPED) {
      head.append(
        button("▲", "上移大类（到顶自动绕到底部）", () => managerMoveGroup(gid, -1), "sh-mini"),
        button("▼", "下移大类（到底自动绕回顶部）", () => managerMoveGroup(gid, 1), "sh-mini"),
        button("🗑", "删除整个大类（自动备份）", async () => {
          if (!confirm(`确定删除大类「${group.label}」及里面全部内容？\n会先备份到 .backup/。`)) return;
          await act("/sinheo/delete", { rel: gid }, "已删除（已备份）");
        }, "sh-mini sh-danger"));
    }
    cont.append(head);
    const cats = make("div", "sh-tree-cats");
    const cmap = new Map(group.categories.map(cat => [cat.id, cat]));
    const catIds = state ? currentCatOrder(state, group) : group.categories.map(c => c.id);
    for (const cid of catIds) {
      const cat = cmap.get(cid);
      if (!cat) continue;
      const row = make("div", `sh-tree-row${mgr.currentCat === cid ? " sh-sel" : ""}`);
      row.append(make("span", "sh-t-name", cat.label), make("small", "", `${cat.count} 条`),
        button("▲", "上移小类（到顶自动绕到底部）", () => managerMoveCat(group, cid, -1), "sh-mini"),
        button("▼", "下移小类（到底自动绕回顶部）", () => managerMoveCat(group, cid, 1), "sh-mini"),
        button("🗑", "删除小类（自动备份）", async event => {
          event.stopPropagation();
          if (!confirm(`确定删除小类「${cat.label}」？\n会先备份到 .backup/。`)) return;
          await act("/sinheo/delete", { rel: catRel(cat) },
                    "已删除（已备份）");
          mgr.currentCat = null;
        }, "sh-mini sh-danger"));
      row.onclick = () => {
        mgr.currentCat = cid;
        renderManagerTree();
        renderEditor();
      };
      cats.append(row);
    }
    cont.append(cats);
    tree.append(cont);
  }
}

function renderEditor() {
  if (!mgr) return;
  const cat = currentCatObject();
  mgr.textarea.placeholder = "一行一条提示词，例如：\n甜美荷叶边泡泡袖上衣\n蝴蝶结蕾丝短款上衣";
  if (!cat) {
    mgr.title.textContent = "选择左侧一个小类";
    mgr.textarea.value = "";
    return;
  }
  mgr.title.textContent = `${cat.group} / ${cat.label}  ·  ${cat.count} 条  ·  ${catRel(cat)}`;
  mgr.textarea.value = (cat.items || []).join("\n");
}

function fillSelect(select, data, includeNew) {
  const previous = select.value;
  select.replaceChildren();
  const plain = make("option", "", includeNew ? "未分组" : "未分组（根级 TXT）");
  plain.value = UNGROUPED;
  select.append(plain);
  for (const group of data.groups) {
    if (group.id === UNGROUPED) continue;
    const option = make("option", "", group.label);
    option.value = group.id;
    select.append(option);
  }
  if (includeNew) {
    const add = make("option", "", "＋ 新建大类…");
    add.value = "__new__";
    select.append(add);
  }
  select.value = [...select.children].some(option => option.value === previous)
    ? previous : UNGROUPED;
}

async function refreshManager(force = false) {
  if (!mgr) return;
  try {
    const data = await getLibrary(force);
    mgr.library = data;
    mgr.path.textContent = data.root;
    fillSelect(mgr.groupSel, data, false);
    fillSelect(mgr.importGroup, data, true);
    if (mgr.currentCat && !data.categories.some(cat => cat.id === mgr.currentCat)) {
      mgr.currentCat = null;
    }
    renderManagerTree();
    renderEditor();
  } catch (error) {
    setMessage(`读取失败：${error.message}`, true);
  }
}

async function openManager(node) {
  const dialog = ensureManager();
  dialog.node = node;
  dialog.wrap.hidden = false;
  dialog.wrap.style.display = "";
  await refreshManager(true);
  setMessage(`共 ${dialog.library?.categories?.length || 0} 个小类；▲▼ 到顶/到底会自动绕到另一端`);
}

/* ------------------------------------------------------------ 导出勾选弹窗 */

function setExportMessage(text, isError = false) {
  if (!exporter) return;
  exporter.msg.textContent = text || "";
  exporter.msg.classList.toggle("sh-error", Boolean(isError));
}

function ensureExport() {
  if (exporter) return exporter;
  const wrap = make("div", "sh-export");
  wrap.hidden = true;
  wrap.style.display = "none";
  stopCanvasEvents(wrap);
  const box = make("div", "sh-export-box");

  const head = make("div", "sh-export-head");
  head.append(make("strong", "", "📤 导出词库 · 勾选要导出的部分"),
              button("✕ 关闭", "关闭（Esc）", () => closeExport()));

  const tools = make("div", "sh-export-tools");
  const filter = make("input", "sh-input");
  filter.placeholder = "Filter list";
  filter.title = "搜索大类 / 小类";
  filter.style.width = "190px";
  filter.oninput = () => { exporter.filter = filter.value; renderExportList(); };
  tools.append(
    button("全选", "勾选全部小类", () => exportBulk(true), "sh-mini"),
    button("全不选", "取消全部勾选", () => exportBulk(false), "sh-mini"),
    button("反选", "反转全部勾选", () => exportBulk(null), "sh-mini"),
    filter,
  );

  const list = make("div", "sh-export-list");
  const foot = make("div", "sh-export-foot");
  const info = make("span", "sh-exp-info", "");
  const msg = make("span", "sh-exp-msg", "");
  const download = button("📦 下载 ZIP", "打包勾选的小类", () => void downloadExport(), "sh-primary");
  foot.append(info, msg, button("取消", "关闭", () => closeExport()), download);

  box.append(head, tools, list, foot);
  wrap.append(box);
  wrap.addEventListener("pointerdown", event => { if (event.target === wrap) closeExport(); });
  document.body.appendChild(wrap);
  exporter = {
    wrap, list, info, msg, download, filter: "",
    checked: new Set(), touched: false, library: null,
  };
  return exporter;
}

function closeExport() {
  if (!exporter) return;
  exporter.wrap.hidden = true;
  exporter.wrap.style.display = "none";
}

function exportBulk(action) {
  if (!exporter?.library) return;
  exporter.touched = true;
  const cats = exporter.library.categories || [];
  if (action === true) for (const cat of cats) exporter.checked.add(cat.id);
  else if (action === false) exporter.checked.clear();
  else for (const cat of cats) {
    if (exporter.checked.has(cat.id)) exporter.checked.delete(cat.id);
    else exporter.checked.add(cat.id);
  }
  renderExportList();
}

function renderExportList() {
  if (!exporter?.library) return;
  const list = exporter.list;
  const scroll = list.scrollTop;
  list.replaceChildren();
  const query = exporter.filter.trim().toLowerCase();
  const cats = exporter.library.categories || [];
  let shown = 0;
  for (const group of exporter.library.groups || []) {
    const rows = cats.filter(cat => cat.group === group.id &&
      (!query || group.label.toLowerCase().includes(query)
        || cat.label.toLowerCase().includes(query)));
    if (!rows.length) continue;
    shown += rows.length;
    const box = make("div", "sh-exp-group");
    const head = make("div", "sh-exp-row sh-exp-group-row");
    const gbox = make("input");
    gbox.type = "checkbox";
    gbox.checked = rows.every(cat => exporter.checked.has(cat.id));
    gbox.onchange = () => {
      exporter.touched = true;
      for (const cat of rows) {
        if (gbox.checked) exporter.checked.add(cat.id);
        else exporter.checked.delete(cat.id);
      }
      renderExportList();
    };
    head.append(gbox, make("span", "sh-exp-name", group.label),
                make("span", "sh-exp-count", `${rows.length} 个小类`));
    box.append(head);
    for (const cat of rows) {
      const row = make("div", "sh-exp-row");
      const cbox = make("input");
      cbox.type = "checkbox";
      cbox.checked = exporter.checked.has(cat.id);
      cbox.onchange = () => {
        exporter.touched = true;
        if (cbox.checked) exporter.checked.add(cat.id);
        else exporter.checked.delete(cat.id);
        renderExportList();
      };
      row.append(cbox, make("span", "sh-exp-name", cat.label),
                 make("span", "sh-exp-count", `${cat.count} 条`),
                 make("span", "sh-exp-rel", catRel(cat)));
      box.append(row);
    }
    list.append(box);
  }
  if (!shown) list.append(make("div", "sh-empty", query ? "没有匹配的小类" : "词库为空，没有可导出的内容"));
  list.scrollTop = scroll;
  const count = exporter.checked.size;
  exporter.info.textContent = `已选 ${count} / ${cats.length} 个小类`;
  exporter.download.textContent = `📦 下载 ZIP（${count}）`;
  exporter.download.disabled = count === 0;
}

async function openExport() {
  const dialog = ensureExport();
  dialog.wrap.hidden = false;
  dialog.wrap.style.display = "";
  try {
    dialog.library = await getLibrary(true);
  } catch (error) {
    setExportMessage(`读取词库失败：${error.message}`, true);
    return;
  }
  const ids = new Set(dialog.library.categories.map(cat => cat.id));
  for (const id of [...dialog.checked]) if (!ids.has(id)) dialog.checked.delete(id);
  if (!dialog.touched) for (const id of ids) dialog.checked.add(id);
  dialog.filter = "";
  renderExportList();
  setExportMessage("勾大类 = 勾它下面全部小类；导出只打包勾中的 TXT");
}

async function downloadExport() {
  if (!exporter?.library) return;
  const selection = [...exporter.checked];
  if (!selection.length) return setExportMessage("请至少勾选一个小类", true);
  const btn = exporter.download;
  btn.disabled = true;
  btn.textContent = "打包中…";
  try {
    // 用原生 fetch 绕开 ComfyUI 的 fetchApi 封装，校验 blob 大小，并延迟 60s 才撤销
    // objectURL —— 这两点是之前下载到 0KB 文件的主要原因。
    const url = typeof api.fileURL === "function"
      ? api.fileURL("/sinheo/export") : "/sinheo/export";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selection }),
      cache: "no-store",
    });
    if (response.status === 404 || response.status === 405) {
      throw new Error("服务端还是旧版插件，请重启 ComfyUI 后再导出");
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const blob = await response.blob();
    if (!blob || !blob.size) throw new Error("服务端返回了 0 字节文件，请刷新词库后重试");
    const objectUrl = URL.createObjectURL(blob);
    const anchor = make("a");
    anchor.href = objectUrl;
    anchor.download = "Sinheo_prompts_" +
      new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".zip";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => { anchor.remove(); URL.revokeObjectURL(objectUrl); }, 60000);
    setExportMessage(`已导出 ${selection.length} 个小类（${blob.size} 字节）`);
  } catch (error) {
    setExportMessage(`导出失败：${error.message}`, true);
  } finally {
    renderExportList();
  }
}

/* ------------------------------------------------- 「＋ 添加到」目标勾选弹窗 */

/** 当前要处理的提示词：随机关 = 文本框文字；随机开 = 本次运行产生的随机结果。 */
function currentPromptText(node) {
  return String(stateOf(node).previewEl?.value || "");
}

function setAddMessage(text, isError = false) {
  if (!adder) return;
  adder.msg.textContent = text || "";
  adder.msg.classList.toggle("sh-error", Boolean(isError));
}

function ensureAdder() {
  if (adder) return adder;
  const wrap = make("div", "sh-export sh-add");
  wrap.hidden = true;
  wrap.style.display = "none";
  stopCanvasEvents(wrap);
  const box = make("div", "sh-export-box");

  const head = make("div", "sh-export-head");
  head.append(make("strong", "", "＋ 添加到词库 · 勾选目标小类"),
              button("✕ 关闭", "关闭（Esc）", () => closeAdder()));

  const tools = make("div", "sh-export-tools");
  const filter = make("input", "sh-input");
  filter.placeholder = "Filter list";
  filter.title = "搜索大类 / 小类";
  filter.style.width = "190px";
  filter.oninput = () => { adder.filterText = filter.value; renderAdderList(); };
  tools.append(
    button("全选", "勾选全部小类", () => adderBulk(true), "sh-mini"),
    button("全不选", "取消全部勾选", () => adderBulk(false), "sh-mini"),
    button("反选", "反转全部勾选", () => adderBulk(null), "sh-mini"),
    filter,
  );

  const preview = make("div", "sh-add-preview");
  const list = make("div", "sh-export-list");
  const foot = make("div", "sh-export-foot");
  const info = make("span", "sh-exp-info", "");
  const msg = make("span", "sh-exp-msg", "");
  const only = button("✓ 确定选择", "只记住目标，之后点节点上的「＋ 添加到」再写入",
                      () => confirmAdder(false), "sh-mini");
  const apply = button("＋ 添加到选中（0）", "立即把当前提示词追加到勾选的小类",
                       () => void confirmAdder(true), "sh-primary");
  foot.append(info, msg, button("取消", "关闭", () => closeAdder()), only, apply);

  box.append(head, tools, preview, list, foot);
  wrap.append(box);
  wrap.addEventListener("pointerdown", event => { if (event.target === wrap) closeAdder(); });
  document.body.appendChild(wrap);
  adder = {
    wrap, list, preview, info, msg, only, apply, filter,
    filterText: "", checked: new Set(), library: null, node: null, text: "",
  };
  return adder;
}

function closeAdder() {
  if (!adder) return;
  adder.wrap.hidden = true;
  adder.wrap.style.display = "none";
}

function adderBulk(action) {
  if (!adder?.library) return;
  const rels = (adder.library.categories || []).map(cat => catRel(cat));
  if (action === true) for (const rel of rels) adder.checked.add(rel);
  else if (action === false) adder.checked.clear();
  else for (const rel of rels) {
    if (adder.checked.has(rel)) adder.checked.delete(rel);
    else adder.checked.add(rel);
  }
  renderAdderList();
}

function renderAdderList() {
  if (!adder?.library) return;
  const list = adder.list;
  const scroll = list.scrollTop;
  list.replaceChildren();
  const query = adder.filterText.trim().toLowerCase();
  const cats = adder.library.categories || [];
  let shown = 0;
  for (const group of adder.library.groups || []) {
    const rows = cats.filter(cat => cat.group === group.id &&
      (!query || group.label.toLowerCase().includes(query)
        || cat.label.toLowerCase().includes(query)));
    if (!rows.length) continue;
    shown += rows.length;
    const box = make("div", "sh-exp-group");
    const head = make("div", "sh-exp-row sh-exp-group-row");
    const gbox = make("input");
    gbox.type = "checkbox";
    gbox.checked = rows.every(cat => adder.checked.has(catRel(cat)));
    gbox.onchange = () => {
      for (const cat of rows) {
        if (gbox.checked) adder.checked.add(catRel(cat));
        else adder.checked.delete(catRel(cat));
      }
      renderAdderList();
    };
    head.append(gbox, make("span", "sh-exp-name", group.label),
                make("span", "sh-exp-count", `${rows.length} 个小类`));
    box.append(head);
    for (const cat of rows) {
      const rel = catRel(cat);
      const row = make("div", "sh-exp-row");
      const cbox = make("input");
      cbox.type = "checkbox";
      cbox.checked = adder.checked.has(rel);
      cbox.onchange = () => {
        if (cbox.checked) adder.checked.add(rel);
        else adder.checked.delete(rel);
        renderAdderList();
      };
      row.append(cbox, make("span", "sh-exp-name", cat.label),
                 make("span", "sh-exp-count", `${cat.count} 条`),
                 make("span", "sh-exp-rel", rel));
      box.append(row);
    }
    list.append(box);
  }
  if (!shown) {
    list.append(make("div", "sh-empty", query
      ? "没有匹配的小类" : "词库为空，请先在「⚙ 词库管理」里新建小类"));
  }
  list.scrollTop = scroll;
  const count = adder.checked.size;
  adder.info.textContent = `已选 ${count} / ${cats.length} 个小类`;
  adder.apply.textContent = `＋ 添加到选中（${count}）`;
  adder.apply.disabled = count === 0;
  adder.only.disabled = count === 0;
}

async function openAdder(node, immediate = false) {
  const dialog = ensureAdder();
  dialog.node = node;
  dialog.text = currentPromptText(node);
  if (!dialog.text.trim()) {
    const state = stateOf(node);
    setStatus(node, state.config.randomize
      ? "请先运行一次工作流，产生随机提示词后再添加"
      : "文本框为空：先点「生成」或手写一段提示词再添加", state.addEl);
    flash(state.addEl, "无内容", "＋ 添加到");
    return;
  }
  dialog.wrap.hidden = false;
  dialog.wrap.style.display = "";
  try {
    dialog.library = await getLibrary(true);
  } catch (error) {
    setAddMessage(`读取词库失败：${error.message}`, true);
    return;
  }
  const rels = new Set(dialog.library.categories.map(cat => catRel(cat)));
  for (const rel of [...dialog.checked]) if (!rels.has(rel)) dialog.checked.delete(rel);
  for (const rel of stateOf(node).addTargets) if (rels.has(rel)) dialog.checked.add(rel);
  dialog.filterText = "";
  dialog.filter.value = "";
  const lines = dialog.text.split("\n").map(line => line.trim()).filter(Boolean);
  dialog.preview.textContent = `将添加 ${lines.length} 条：${lines.slice(0, 3).join(" / ")}`
    + (lines.length > 3 ? " …" : "");
  renderAdderList();
  setAddMessage(immediate
    ? "勾选目标后点「＋ 添加到选中」即可写入（重复词条自动跳过）"
    : "勾大类 = 勾它下面全部小类；一行一条，确定后点节点上的「＋ 添加到」");
}

function confirmAdder(doAdd) {
  if (!adder?.node) return;
  const node = adder.node;
  stateOf(node).addTargets = new Set(adder.checked);
  syncControls(node);
  closeAdder();
  if (doAdd) void addCurrent(node);
}

async function addCurrent(node) {
  const state = stateOf(node);
  const text = currentPromptText(node);
  const btn = state.addEl;
  if (!text.trim()) {
    setStatus(node, state.config.randomize
      ? "请先运行一次工作流，产生随机提示词后再添加"
      : "文本框为空：先点「生成」或手写一段提示词再添加", btn);
    flash(btn, "无内容", "＋ 添加到");
    return;
  }
  if (!state.addTargets.size) {
    await openAdder(node, true);
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const data = await requestJSON("/sinheo/append", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rels: [...state.addTargets], text }),
    });
    const count = Number(data.added) || 0;
    setStatus(node, count
      ? `已追加到 ${state.addTargets.size} 个小类（新增 ${count} 条，重复自动跳过）`
      : "这些小类里已经有这段提示词了，没有重复添加", btn);
    flash(btn, count ? "已添加" : "已存在", "＋ 添加到");
    await refreshAll(true);
  } catch (error) {
    const reason = /40[45]/.test(String(error.message))
      ? "服务端还是旧版插件，请重启 ComfyUI 后再添加"
      : error.message;
    setStatus(node, `添加失败：${reason}`, btn);
    flash(btn, "需重启", "＋ 添加到");
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* Esc 关闭本插件的所有弹窗 */
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  let closed = false;
  if (mgr && !mgr.wrap.hidden) { closeManager(); closed = true; }
  if (exporter && !exporter.wrap.hidden) { closeExport(); closed = true; }
  if (adder && !adder.wrap.hidden) { closeAdder(); closed = true; }
  if (closed) event.stopPropagation?.();
});

/* ------------------------------------------------------------------ 注册 */

app.registerExtension({
  name: "Sinheo.TextLoader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = created?.apply(this, arguments);
      const node = this;
      nodes.add(node);
      node.color ??= "#4b6b86";
      stateOf(node);
      buildBody(node);
      applyMode(node);
      void loadInto(node);

      const previousConfigure = node.onConfigure;
      node.onConfigure = function () {
        const output = previousConfigure?.apply(this, arguments);
        const state = stateOf(node);
        state.config = readConfig(node);
        applyMode(node);
        void loadInto(node, true);
        return output;
      };

      const previousExecuted = node.onExecuted;
      node.onExecuted = function (message) {
        const output = previousExecuted?.apply(this, arguments);
        const text = message?.sinheo_text?.[0];
        if (typeof text === "string") {
          const state = stateOf(node);
          state.lastText = text;
          if (state.config.randomize) {
            // 只展示本次随机结果，不写回 manual_text（用户原文要留着）
            state.lastRandomText = text;
            setPreview(node, text || "（本次随机输出为空）", !text);
          }
          // 文本框模式：后端输出的就是文本框内容，不覆盖，避免打断正在编辑的光标
        }
        return output;
      };

      const previousRemoved = node.onRemoved;
      node.onRemoved = function () {
        nodes.delete(node);
        if (popup?.node === node) closePopup();
        return previousRemoved?.apply(this, arguments);
      };
      return result;
    };
  },
});
