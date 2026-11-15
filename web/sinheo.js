/*
 * Sinheo-Comfyui-PromptLibrary · 前端扩展
 *
 * 仿 Goohai 图库节点的紧凑版式：两行控件（类型菜单 / 随机开关）+ 管理条
 * + 可编辑文本框 + 底部一行按钮（＋ 添加到图库 / 目标分类 / 生成 / 复制）。
 * 勾选菜单里只有两级：大类 -> 小类，可搜索、可勾选、可每个大类随机、可 ▲▼ 循环排序；
 * 不再展开小类里的具体词条（点小类名称即勾选 / 取消）。
 * 词库只有两级：大类文件夹 / 小类.txt，一个小类就是一个 TXT，每次只贡献 1 条关键词。
 * 随机「关」：只输出文本框里的文字，可手改；「生成」手动抽词、「＋ 添加到图库」把图和词存成卡片。
 * 随机「开」：每次运行按勾选菜单重新随机抽词，文本框只读且内容不参与输出；
 *             「生成」停用，但「复制」可复制本次运行产生的提示词，「＋ 添加到」也能收藏它。
 * 词库数据来自 models/Sinheo/prompts/**；图库数据来自 models/Sinheo/gallery/。
 * 「类型」菜单可切换随机数据源：词库（TXT 词条）/ 图库（卡片提示词）。
 * 抓图只认生成结果：/history 的真实 outputs 优先，type=input 与 LoadImage 节点预览一律排除；
 * 图库导出只保留一条可靠通道：面板填本机目录 → 服务端直接写盘，并记住上次目录；
 * 可选导出范围（整个图库 / 某分类 / 分类下的某分组）。
 * 「只记住目标」开关写进 localStorage，刷新页面后仍生效，再点一次即取消。
 * 浏览器侧通道（系统「另存为」/ <a download>）在内嵌窗口会被下载策略拦截，已从面板移除。
 * 图库图片只作「这条提示词大概出什么效果」的辨认用：上传前先压成 512px JPEG，
 * 服务端 save_image / import_archive / export_zip 还会再兜一层缩略图。
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "SinheoLoadText";
const UNGROUPED = "未分组";

const nodes = new Set();
const states = new WeakMap();
let libraryCache = null;
let pendingLibrary = null;
let popup = null;
let mgr = null;
let exporter = null;
let adder = null;
let galleryDlg = null;
let galleryImportDlg = null;
let galleryDataCache = null;
let pendingGallery = null;

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

/** 图库元数据缓存：勾选菜单、摘要、添加到图库弹窗共用。 */
async function getGalleryData(force = false) {
  if (force) galleryDataCache = null;
  if (galleryDataCache) return galleryDataCache;
  if (pendingGallery) return pendingGallery;
  pendingGallery = (async () => {
    const data = await requestJSON("/sinheo/gallery");
    galleryDataCache = data;
    return data;
  })().finally(() => { pendingGallery = null; });
  return pendingGallery;
}

function invalidateGallery() { galleryDataCache = null; }

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
const EXTERNAL_INPUT = "external_text";
let backendHasExternalInput = false;   // 由 object_info 决定，避免老后端收到未知参数
const EXTERNAL_HINT = "已接入外部文本：运行时直接输出上游节点传入的提示词，运行一次后这里会显示实际内容";

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
    source: "library", galleryCats: [], galleryGroups: [], galleryFav: false,
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
  for (const key of ["galleryCats", "galleryGroups"]) {
    if (!Array.isArray(base[key])) base[key] = [];
  }
  if (!["library", "gallery"].includes(base.source)) base.source = "library";
  // 菜单改成「大类 + 小类」两级后，旧工作流里存的具体词条勾选（picks / mode）
  // 已经没有界面入口，属于会偷偷缩小随机池的隐形状态：读入时静默清掉并写回 widget，
  // 这样后端拿到的 config 与界面一致，且不需要重启 ComfyUI。
  let migrated = false;
  for (const cfg of Object.values(base.cats)) {
    if (!cfg || typeof cfg !== "object") continue;
    if ("picks" in cfg || "mode" in cfg) { delete cfg.picks; delete cfg.mode; migrated = true; }
  }
  if (migrated) {
    const widget = configWidget(node);
    if (widget) widget.value = JSON.stringify(base);
  }
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

const ADD_TARGET_KEY = "sinheo_gallery_add_target";

/** 「只记住目标」偏好：写进 localStorage，刷新页面后仍生效；再点一次开关即取消。
 *  隐私模式 / 内嵌窗口可能禁用 localStorage，读写都要防御。 */
function readAddTarget() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(ADD_TARGET_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && data.categoryId
      ? { categoryId: String(data.categoryId), groupId: String(data.groupId || "") }
      : null;
  } catch (error) { return null; }
}

function writeAddTarget(target) {
  try {
    if (typeof localStorage === "undefined") return;
    if (target) localStorage.setItem(ADD_TARGET_KEY, JSON.stringify(target));
    else localStorage.removeItem(ADD_TARGET_KEY);
  } catch (error) { /* 隐私模式：至少本次会话内仍生效 */ }
}

function stateOf(node) {
  let state = states.get(node);
  if (!state) {
    const remembered = readAddTarget();
    state = {
      config: readConfig(node), library: null, filter: "",
      collapsed: new Set(), lastText: "", lastRandomText: "",
      initialFill: false, textTimer: null, addTargets: new Set(),
      addCategory: remembered?.categoryId || "", addGroup: remembered?.groupId || "",
      galleryCache: null,
      externalLinked: false, lastExternalText: "",
      rootEl: null, triggerEl: null, valueEl: null, randomEl: null,
      barEl: null, previewEl: null, statusEl: null,
      genEl: null, copyEl: null, addEl: null, addTargetEl: null,
      popupList: null,
    };
    states.set(node, state);
  }
  return state;
}

/* ------------------------------------- 外部文本输入（可连线的 STRING 插槽） */

/** 老工作流里的节点可能没有后端新增的 input，这里补一个可见插槽。
 *  仅当 object_info 确认后端已支持 external_text 时才补：
 *  否则连线后会把未知参数提交给旧版 execute，直接报错。 */
function ensureExternalInput(node) {
  if (!backendHasExternalInput) return;
  if (!Array.isArray(node.inputs)) node.inputs = [];
  if (node.inputs.some(slot => slot?.name === EXTERNAL_INPUT)) return;
  try {
    node.addInput?.(EXTERNAL_INPUT, "STRING");
  } catch (error) { /* 前端版本差异：由 nodeDef 自己创建即可 */ }
}

/** 插槽上有连线 = 外部文本接管本节点的输出。 */
function externalLinked(node) {
  const slots = Array.isArray(node?.inputs) ? node.inputs : [];
  const slot = slots.find(item => item?.name === EXTERNAL_INPUT);
  return Boolean(slot && slot.link !== null && slot.link !== undefined);
}

function syncExternalState(node, force = false) {
  const state = stateOf(node);
  const linked = externalLinked(node);
  if (!force && linked === state.externalLinked) return;
  state.externalLinked = linked;
  if (!linked) state.lastExternalText = "";
  applyMode(node);
}

function groupCfg(state, gid) {
  if (!state.config.groups[gid] || typeof state.config.groups[gid] !== "object") {
    state.config.groups[gid] = { on: true, random: false, pick: 1 };
  }
  return state.config.groups[gid];
}

function catCfg(state, cid) {
  if (!state.config.cats[cid] || typeof state.config.cats[cid] !== "object") {
    state.config.cats[cid] = { on: true };
  }
  const cfg = state.config.cats[cid];
  delete cfg.mode;                  // 旧工作流残留的「全部拼接」一律忽略
  delete cfg.picks;                 // 菜单不再展开具体词条，不产生新的词条勾选
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
  const external = externalLinked(node);
  const locked = Boolean(state.config.randomize) || external;
  if (state.genEl) {
    state.genEl.disabled = locked;
    state.genEl.title = external
      ? "已接入外部文本：输出由上游节点决定，「生成」停用；断开连线后恢复"
      : (state.config.randomize
        ? "随机开关已打开：运行时自动抽词，「生成」停用；关掉「随机」后恢复"
        : "按勾选菜单随机抽一批提示词填进文本框，可手动修改（仅随机关闭时可用）");
  }
  // 「复制」在两种模式下都可用：随机模式复制的是本次运行产生的提示词
  if (state.copyEl) {
    state.copyEl.disabled = false;
    state.copyEl.title = external
      ? "复制外部传入的提示词（先运行一次工作流，文本框里就是结果）"
      : (state.config.randomize
        ? "复制本次运行产生的随机提示词（先运行一次工作流，文本框里就是结果）"
        : "复制文本框里的提示词");
  }
  if (state.addEl) {
    state.addEl.disabled = false;
    state.addEl.title = "把当前提示词 + 最近生成的图片存成图库卡片";
  }
  if (state.addTargetEl) {
    state.addTargetEl.textContent = state.addCategory
      ? "🎯 目标已设 ▾" : "🎯 目标分类 ▾";
    state.addTargetEl.classList.toggle("sh-picked-target", Boolean(state.addCategory));
  }
}

function updateSummary(node) {
  const state = stateOf(node);
  if (!state.rootEl) return;
  const lib = state.library;
  const random = Boolean(state.config.randomize);
  // 行内只显示模式标签，不再统计「几个小类 / 几条 / 几张卡片」
  const fromGallery = state.config.source === "gallery";
  const external = externalLinked(node);
  state.valueEl.textContent = external
    ? "🔗 外部文本"
    : (fromGallery
      ? (random ? "🎲 图库随机" : "☑ 图库文本")
      : (random ? "🎲 词库随机" : "☑ 词库文本"));
  state.valueEl.title = external
    ? "左侧外部文本插槽已连线：本节点直接输出上游 STRING，随机开关与类型菜单暂不生效"
    : "打开类型菜单：切换随机数据源（词库 / 图库）、勾选范围、拼接设置";
  state.randomEl.classList.toggle("sh-on", random && !external);
  state.randomEl.title = external
    ? "已接入外部文本：随机开关暂不生效，断开连线后恢复"
    : (random
      ? "随机：开 —— 每次运行从当前数据源重新抽词，文本框内容不参与输出（「生成」停用，「复制」仍可用）"
      : "随机：关 —— 只输出文本框里的提示词，可点「生成」重新抽词");
  state.barEl.textContent = "⚙ 词库管理";
  if (external) {
    setStatus(node, "外部文本模式：直接输出左侧插槽连入的提示词（随机开关 / 类型菜单 / 文本框均不参与输出）");
    return;
  }
  setStatus(node, !lib ? "读取词库中…"
    : fromGallery
      ? (random ? "随机模式 · 每次运行从图库抽提示词"
                : "文本框模式 · 输出当前文本框内容")
      : (random ? "随机模式 · 每次运行自动抽词"
                : "文本框模式 · 输出当前文本框内容"));
}

function applyMode(node) {
  const state = stateOf(node);
  const random = Boolean(state.config.randomize);
  const external = externalLinked(node);
  const widget = manualWidget(node);
  const cfg = configWidget(node);
  // 原生多行框永远隐藏：可编辑文本框由节点面板自己提供
  if (widget) widget.hidden = true;
  if (cfg) cfg.hidden = true;

  const el = state.previewEl;
  if (el) {
    el.readOnly = random || external;
    el.classList.toggle("sh-locked", random || external);
    el.title = external
      ? "已接入外部文本，此处只展示上游传入的内容；断开左侧连线后可手写"
      : (random ? "随机模式只读：这里显示本次运行的随机结果"
                : "随机关闭时，节点只输出这段文本；可直接手动修改");
    if (external) {
      // 外部文本只展示，绝不写回 manual_text widget
      setPreview(node, state.lastExternalText || EXTERNAL_HINT, !state.lastExternalText);
    } else if (random) {
      // 随机模式只「展示」最近一次随机结果，绝不写回 manual_text
      setPreview(node, state.lastRandomText || RANDOM_HINT, !state.lastRandomText);
    } else {
      // 关闭随机后恢复用户自己写的文字
      setPreview(node, typeof widget?.value === "string" ? widget.value : "", false);
    }
  }
  state.rootEl?.classList.toggle("sh-random-on", random && !external);
  state.rootEl?.classList.toggle("sh-external-on", external);
  syncControls(node);
  updateSummary(node);
  node.setDirtyCanvas?.(true, true);
}

/** 「生成」按钮：手动随机抽一批词填进文本框（仅在随机关闭时可用）。 */
async function generateInto(node, btn) {
  const state = stateOf(node);
  if (state.config.randomize || externalLinked(node)) return;
  const label = "生成";
  btn.disabled = true;
  btn.textContent = "生成中…";
  try {
    if (state.config.source !== "gallery") {
      if (!state.library) await loadInto(node, true);
      if (!state.library) {
        setStatus(node, "词库读取失败，点词库管理里的 ↻ 重试", btn);
        flash(btn, "词库不可用", label);
        return;
      }
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
    const emptyHint = state.config.source === "gallery"
      ? "图库为空或当前范围没有卡片，请在类型菜单里调整，或先添加卡片"
      : "词库为空或没勾任何小类，请在类型菜单里勾几项";
    setStatus(node, text
      ? "已随机生成，可直接改文字；运行时按改动后的内容输出"
      : emptyHint, btn);
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
  trigger.title = "打开类型菜单：切换随机数据源（词库 / 图库）、勾选范围、拼接设置";
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
  const galleryBtn = make("button", "sh-bar-gallery", "🖼 图库管理");
  galleryBtn.type = "button";
  galleryBtn.title = "打开图库：按分类 / 分组浏览图片卡片，点「使用」把提示词写进上方文本框";
  galleryBtn.onclick = event => { event.stopPropagation(); void openGallery(node); };
  const refresh = make("button", "sh-bar-gear", "↻");
  refresh.type = "button";
  refresh.title = "重新扫描 models/Sinheo/prompts";
  refresh.onclick = event => { event.stopPropagation(); void refreshAll(true); };
  bar.append(barMain, galleryBtn, refresh);

  const preview = make("textarea", "sh-preview sh-placeholder");
  preview.spellcheck = false;
  preview.wrap = "soft";
  preview.placeholder = PREVIEW_HINT;
  preview.title = "随机关闭时，节点只输出这段文本；可直接手动修改";
  preview.oninput = () => {
    if (state.config.randomize || externalLinked(node)) return;   // 随机 / 外部文本只读
    setText(node, preview.value);
    commitText(node);
  };
  preview.onchange = () => commitText(node);

  // 底部只留一行按钮：＋ 添加到图库 / 🎯 目标分类 / 生成 / 复制
  const foot = make("div", "sh-foot");
  const status = make("span", "sh-status", "");
  status.hidden = true;                  // 仅作内部状态记录，不参与布局
  const add = button("＋ 添加到图库", "把当前提示词 + 最近生成的图片存成图库卡片",
                     () => void addCurrent(node));
  const addTarget = button(state.addCategory ? "🎯 目标已设 ▾" : "🎯 目标分类 ▾",
                           "选择图库卡片的保存位置（分类 / 分组）",
                           () => openAdder(node, false));
  addTarget.classList.toggle("sh-picked-target", Boolean(state.addCategory));
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
    barEl: barMain, galleryBtn, previewEl: preview, statusEl: status,
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
    const [library, galleryData] = await Promise.all([
      getLibrary(force), getGalleryData(force).catch(() => null),
    ]);
    state.library = library;
    if (galleryData) state.galleryCache = galleryData;
    state.config = readConfig(node);
    applyMode(node);
    void ensureInitialText(node);
  } catch (error) {
    setPreview(node, `读取词库失败：${error.message}`, true);
  }
}

async function refreshAll(force = true) {
  if (force) { libraryCache = null; invalidateGallery(); }
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

  // 随机数据源选项卡：词库（TXT 词条）/ 图库（卡片提示词）
  const sourceTabs = make("div", "sh-source-tabs");
  sourceTabs.append(
    button("📚 词库", "从词库 TXT 词条里随机抽词",
      () => setRandomSource(node, "library"), "sh-source-tab"),
    button("🖼 图库", "从图库卡片的提示词里随机抽取",
      () => setRandomSource(node, "gallery"), "sh-source-tab"),
  );

  const head = make("div", "sh-pop-head");
  const filter = make("input", "sh-filter");
  filter.type = "text";
  filter.placeholder = "Filter list";
  filter.title = "搜索大类 / 小类名称（也会匹配小类里的提示词内容）";
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
    button("↻ 刷新", "重新读取词库 / 图库", () => void refreshAll(true), "sh-mini"),
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
  const hint = make("div", "sh-hint", "每个小类每次随机出 1 条；输出顺序 = 上方菜单顺序，用 ▲▼ 调整；改完勾选点节点上的「生成」才会更新文本框。");
  hint.style.cssText = "margin-top:5px;color:#8d97a8;font-size:10px;";
  foot.append(details, hint);

  el.append(sourceTabs, head, tools, list, foot);
  document.body.appendChild(el);
  positionPopup(el, anchor);

  const onDoc = event => {
    if (!el.contains(event.target) && !anchor.contains(event.target)) closePopup();
  };
  const onKey = event => { if (event.key === "Escape") closePopup(); };
  document.addEventListener("pointerdown", onDoc, true);
  document.addEventListener("keydown", onKey, true);
  popup = { el, node, onDoc, onKey, sourceTabs };
  state.popupList = list;
  renderPopup(node);
}

function bulkSet(node, action) {
  const state = stateOf(node);
  if (state.config.source === "gallery") return galleryBulkSet(node, action);
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

/** 词库菜单只有两级：大类（sh-group-head）+ 小类（sh-cat）。
 *  小类不再展开具体提示词，点名称等价于点勾选框，勾选后整个小类参与随机。 */
function buildCatRow(node, group, cat, query) {
  const state = stateOf(node);
  const row = make("div", `sh-cat${isCatOn(state, cat.id) ? "" : " sh-off"}`);
  const box = make("input");
  box.type = "checkbox";
  box.checked = isCatOn(state, cat.id);
  box.title = "勾选后这个小类参与生成（每次从整个小类随机出 1 条）";
  const setOn = checked => {
    catCfg(state, cat.id).on = checked;
    box.checked = checked;
    writeConfig(node);
    updateSummary(node);
    renderPopup(node);
  };
  box.onchange = () => setOn(box.checked);
  const name = make("span", "sh-cat-name");
  highlight(name, cat.label, query);
  name.title = `${cat.id} · ${cat.count} 条 · 点击可勾选 / 取消`;
  name.onclick = event => { event.stopPropagation(); setOn(!isCatOn(state, cat.id)); };
  row.append(box, name, make("span", "sh-cat-count", cat.count),
    button("▲", "上移小类（到顶自动绕到底部）", () => moveCat(node, group, cat.id, -1), "sh-mini"),
    button("▼", "下移小类（到底自动绕回顶部）", () => moveCat(node, group, cat.id, 1), "sh-mini"));
  return row;
}

function renderPopup(node) {
  const state = stateOf(node);
  const list = state.popupList;
  if (!list) return;
  renderSourceTabs(node);
  if (state.config.source === "gallery") return renderGalleryPopup(node);
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
      if (visible) rows.push(cat);
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
      // 小类整组右移，左侧留一条层级引导线，和图库数据源的分类 / 分组一样一眼可分
      const cats = make("div", "sh-cats");
      for (const cat of rows) cats.append(buildCatRow(node, group, cat, query));
      box.append(cats);
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

/* --------------------------------------------- 类型菜单：随机数据源切换 */

function setRandomSource(node, source) {
  const state = stateOf(node);
  if (state.config.source === source) return;
  state.config.source = source;
  writeConfig(node);
  updateSummary(node);
  renderPopup(node);
}

function renderSourceTabs(node) {
  const state = stateOf(node);
  const tabs = popup?.sourceTabs;
  if (!tabs) return;
  const keys = ["library", "gallery"];
  // 真实浏览器里 element.children 是 HTMLCollection，没有 forEach。
  // 这里必须用 Array.from 转换，否则会抛 TypeError 并把整个 renderPopup 中断，
  // 表现为「类型」菜单里的词库列表一片空白（测试 mock 的 children 是数组，不会暴露）。
  for (const [index, tab] of Array.from(tabs.children).entries()) {
    tab.classList.toggle("sh-active", keys[index] === state.config.source);
  }
}

function gallerySelected(state, key, id) {
  return (state.config[key] || []).includes(id);
}

function galleryToggle(state, key, id, on) {
  const list = state.config[key] || (state.config[key] = []);
  const index = list.indexOf(id);
  if (on && index === -1) list.push(id);
  if (!on && index !== -1) list.splice(index, 1);
}

function galleryBulkSet(node, action) {
  const state = stateOf(node);
  const cats = state.galleryCache?.categories || [];
  const before = new Set(state.config.galleryCats || []);
  const next = [];
  if (action === "on") next.push(...cats.map(cat => cat.id));
  else if (action === "invert") {
    for (const cat of cats) if (!before.has(cat.id)) next.push(cat.id);
  }
  state.config.galleryCats = next;
  state.config.galleryGroups = [];
  writeConfig(node);
  updateSummary(node);
  renderPopup(node);
}

/** 图库数据源下的类型菜单：分类 / 分组勾选 + 仅收藏开关。 */
function renderGalleryPopup(node) {
  const state = stateOf(node);
  const list = state.popupList;
  const scroll = list.scrollTop;
  list.replaceChildren();
  const data = state.galleryCache;
  if (!data) { list.append(make("div", "sh-empty", "图库读取中…")); return; }
  const query = state.filter.trim().toLowerCase();
  const cats = data.categories || [];
  const cards = data.cards || [];

  const favRow = make("label", "sh-gallery-pop-row sh-gallery-pop-fav");
  const favBox = make("input");
  favBox.type = "checkbox";
  favBox.checked = Boolean(state.config.galleryFav);
  favBox.onchange = () => {
    state.config.galleryFav = favBox.checked;
    writeConfig(node);
    updateSummary(node);
  };
  favRow.append(favBox, make("span", "", "♥ 只从收藏里随机"));
  list.append(favRow);

  let shown = 0;
  for (const cat of cats) {
    const catCards = cards.filter(card => card.categoryId === cat.id);
    const groups = cat.groups || [];
    const match = !query || String(cat.name).toLowerCase().includes(query)
      || groups.some(group => String(group.name).toLowerCase().includes(query))
      || catCards.some(card => String(card.prompt || "").toLowerCase().includes(query));
    if (!match) continue;
    shown++;
    const box = make("div", "sh-gallery-pop-cat");
    const row = make("label", "sh-gallery-pop-row");
    const cbox = make("input");
    cbox.type = "checkbox";
    cbox.checked = gallerySelected(state, "galleryCats", cat.id);
    cbox.onchange = () => {
      galleryToggle(state, "galleryCats", cat.id, cbox.checked);
      writeConfig(node);
      renderPopup(node);
    };
    row.append(cbox, make("span", "sh-gallery-pop-name", cat.name),
               make("span", "sh-tag", `${catCards.length} 张`));
    box.append(row);
    for (const group of groups) {
      const groupCards = catCards.filter(card => card.groupId === group.id);
      if (query && !String(group.name).toLowerCase().includes(query)
          && !groupCards.some(card => String(card.prompt || "").toLowerCase().includes(query))) continue;
      const grow = make("label", "sh-gallery-pop-row sh-gallery-pop-group");
      const gbox = make("input");
      gbox.type = "checkbox";
      gbox.checked = gallerySelected(state, "galleryGroups", group.id);
      gbox.onchange = () => {
        galleryToggle(state, "galleryGroups", group.id, gbox.checked);
        writeConfig(node);
        renderPopup(node);
      };
      grow.append(gbox, make("span", "sh-gallery-pop-name", group.name),
                  make("span", "sh-tag", `${groupCards.length} 张`));
      box.append(grow);
    }
    list.append(box);
  }
  if (!shown) {
    list.append(make("div", "sh-empty", query
      ? "没有匹配的图库分类"
      : "图库还是空的，先点「🖼 图库管理」创建卡片"));
  }
  list.append(make("div", "sh-hint",
    "不勾任何分类 = 全部卡片；勾分组 = 只从这些分组抽；「条数」= 一次抽几张，分隔符 / 前后缀在下面设置。"));
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

  const bulk = make("div", "sh-mgr-bulk");
  const bulkAll = make("input");
  bulkAll.type = "checkbox";
  bulkAll.title = "全选 / 全不选所有大类与小类";
  bulkAll.onchange = () => managerBulk(bulkAll.checked ? "all" : "none");
  const bulkInfo = make("span", "sh-mgr-bulk-info", "已选 0 项");
  bulk.append(
    bulkAll,
    make("span", "sh-mgr-hint", "批量勾选"),
    button("反选", "反转当前勾选", () => managerBulk("invert"), "sh-mini"),
    bulkInfo,
    make("span", "sh-mgr-hint", "勾选左侧大类 / 小类后，点右侧「批量删除选中」"),
  );

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
  const batchDeleteBtn = button("🗑 批量删除选中（0）",
    "删除左侧勾选的全部大类 / 小类（删除前自动备份到 .backup/）",
    () => void batchDelete(), "sh-danger");
  batchDeleteBtn.disabled = true;
  editorButtons.append(
    button("💾 保存", "保存这个小类 TXT（内容一行一条）", () => void saveCurrentFile(), "sh-primary"),
    batchDeleteBtn,
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

  box.append(head, create, bulk, main, foot);
  wrap.append(box);
  wrap.addEventListener("pointerdown", event => { if (event.target === wrap) closeManager(); });
  document.body.appendChild(wrap);

  mgr = {
    wrap, path, tree, groupSel, importGroup, newGroup, newCat, title,
    textarea, setMessage,
    node: null, library: null, currentCat: null,
    checked: new Set(), bulkAll, bulkInfo, batchDeleteBtn,
    renaming: null, renamingValue: "",
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

/* ------------------------------ 批量勾选删除 ------------------------------ */

function managerAllRels() {
  const rels = [];
  for (const group of mgr?.library?.groups || []) {
    if (group.id !== UNGROUPED) rels.push(group.id);
    for (const cat of group.categories) rels.push(catRel(cat));
  }
  return rels;
}

function updateBulkUI() {
  if (!mgr) return;
  const all = managerAllRels();
  const selected = all.filter(rel => mgr.checked.has(rel)).length;
  if (mgr.bulkAll) {
    mgr.bulkAll.checked = all.length > 0 && selected === all.length;
    mgr.bulkAll.indeterminate = selected > 0 && selected < all.length;
  }
  const count = mgr.checked.size;
  if (mgr.bulkInfo) mgr.bulkInfo.textContent = `已选 ${count} 项`;
  if (mgr.batchDeleteBtn) {
    mgr.batchDeleteBtn.textContent = `🗑 批量删除选中（${count}）`;
    mgr.batchDeleteBtn.disabled = count === 0;
  }
}

function managerBulk(action) {
  if (!mgr) return;
  const all = managerAllRels();
  if (action === "all") for (const rel of all) mgr.checked.add(rel);
  else if (action === "none") mgr.checked.clear();
  else {
    const next = new Set();
    for (const rel of all) if (!mgr.checked.has(rel)) next.add(rel);
    mgr.checked = next;
  }
  renderManagerTree();
  updateBulkUI();
}

function makeManagerCheck(rels) {
  const box = make("input", "sh-tree-check");
  box.type = "checkbox";
  box.title = "勾选后可批量删除（勾大类 = 连它下面的小类一起勾）";
  box.checked = rels.every(rel => mgr.checked.has(rel));
  box.onclick = event => event.stopPropagation();
  box.onchange = () => {
    for (const rel of rels) {
      if (box.checked) mgr.checked.add(rel);
      else mgr.checked.delete(rel);
    }
    renderManagerTree();
    updateBulkUI();
  };
  return box;
}

async function batchDelete() {
  if (!mgr) return;
  const rels = [...mgr.checked];
  if (!rels.length) return setMessage("请先勾选要删除的大类 / 小类", true);
  if (!confirm(`确定删除选中的 ${rels.length} 项吗？\n原文件会备份到 .backup/。`)) return;
  try {
    const data = await requestJSON("/sinheo/delete_batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rels }),
    });
    const count = Array.isArray(data.deleted) ? data.deleted.length : rels.length;
    mgr.checked.clear();
    mgr.currentCat = null;
    setMessage(`已删除 ${count} 项（已备份到 .backup/）`);
    await refreshAll(true);
  } catch (error) {
    setMessage(`批量删除失败：${error.message}`, true);
  }
}

/* -------------------------------- 重命名 -------------------------------- */

function startRename(key, kind, rel, label) {
  if (!mgr) return;
  mgr.renaming = { key, kind, rel, label };
  mgr.renamingValue = label;
  renderManagerTree();
}

function renameEditor() {
  const box = make("span", "sh-rename-box");
  const input = make("input", "sh-input sh-rename-input");
  input.value = mgr.renamingValue;
  input.title = "输入新名称，回车或点 ✓ 保存；Esc 取消";
  input.onclick = event => event.stopPropagation();
  input.oninput = () => { mgr.renamingValue = input.value; };
  input.onkeydown = event => {
    event.stopPropagation?.();
    if (event.key === "Enter") void commitRename();
    else if (event.key === "Escape") { mgr.renaming = null; renderManagerTree(); }
  };
  box.append(input,
    button("✓", "保存新名称", () => void commitRename(), "sh-mini sh-primary"),
    button("✕", "取消重命名", () => { mgr.renaming = null; renderManagerTree(); }, "sh-mini"));
  setTimeout(() => { try { input.focus?.(); } catch (error) { /* 旧版 DOM */ } }, 0);
  return box;
}

/** 重命名会改 id；把画布上所有节点 config 里的旧 id 一起迁过去，避免勾选状态丢失。 */
function migrateRenameInConfig(kind, oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  const renameKeys = (obj, mapper) => {
    if (!obj || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      const next = mapper(key);
      if (next !== key) { obj[next] = obj[key]; delete obj[key]; }
    }
  };
  const replaceList = list => {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      if (typeof list[i] !== "string") continue;
      if (list[i] === oldId) list[i] = newId;
      else if (kind === "group" && list[i].startsWith(oldId + "/")) {
        list[i] = newId + list[i].slice(oldId.length);
      }
    }
  };
  const groupMapper = key => key === oldId ? newId : key;
  const catMapper = kind === "group"
    ? key => key.startsWith(oldId + "/") ? newId + key.slice(oldId.length) : key
    : groupMapper;
  for (const node of nodes) {
    const state = states.get(node);
    if (!state?.config) continue;
    const cfg = state.config;
    if (kind === "group") replaceList(cfg.order);
    renameKeys(cfg.catOrder, groupMapper);
    for (const list of Object.values(cfg.catOrder || {})) replaceList(list);
    renameKeys(cfg.groups, groupMapper);
    renameKeys(cfg.cats, catMapper);
    writeConfig(node);
    updateSummary(node);
  }
}

async function commitRename() {
  const target = mgr?.renaming;
  if (!target) return;
  mgr.renaming = null;
  const name = String(mgr.renamingValue || "").trim();
  if (!name || name === target.label) { renderManagerTree(); return; }
  try {
    const data = await requestJSON("/sinheo/rename", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rel: target.rel, name }),
    });
    migrateRenameInConfig(data.kind, data.old, data.new);
    setMessage(`已重命名为「${name}」`);
    await refreshAll(true);
  } catch (error) {
    setMessage(`重命名失败：${error.message}`, true);
    renderManagerTree();
  }
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
    const realGroup = gid !== UNGROUPED;
    const groupKey = `g:${gid}`;
    if (realGroup) {
      head.append(makeManagerCheck([gid, ...group.categories.map(cat => catRel(cat))]));
    }
    if (mgr.renaming?.key === groupKey) {
      head.append(renameEditor());
    } else {
      head.append(make("span", "sh-t-name", group.label),
                  make("small", "", `${group.categories.length}`));
    }
    head.append(
      button("▲", "上移大类（到顶自动绕到底部）",
        event => { event.stopPropagation(); managerMoveGroup(gid, -1); }, "sh-mini"),
      button("▼", "下移大类（到底自动绕回顶部）",
        event => { event.stopPropagation(); managerMoveGroup(gid, 1); }, "sh-mini"),
    );
    if (realGroup) {
      head.append(button("✎", "重命名这个大类",
        event => { event.stopPropagation(); startRename(groupKey, "group", gid, group.label); },
        "sh-mini"));
    }
    cont.append(head);

    const cats = make("div", "sh-tree-cats");
    const cmap = new Map(group.categories.map(cat => [cat.id, cat]));
    const catIds = state ? currentCatOrder(state, group) : group.categories.map(c => c.id);
    for (const cid of catIds) {
      const cat = cmap.get(cid);
      if (!cat) continue;
      const rel = catRel(cat);
      const catKey = `c:${cid}`;
      const row = make("div", `sh-tree-row${mgr.currentCat === cid ? " sh-sel" : ""}`);
      row.append(makeManagerCheck([rel]));
      if (mgr.renaming?.key === catKey) {
        row.append(renameEditor());
      } else {
        row.append(make("span", "sh-t-name", cat.label), make("small", "", `${cat.count} 条`));
      }
      row.append(
        button("▲", "上移小类（到顶自动绕到底部）",
          event => { event.stopPropagation(); managerMoveCat(group, cid, -1); }, "sh-mini"),
        button("▼", "下移小类（到底自动绕回顶部）",
          event => { event.stopPropagation(); managerMoveCat(group, cid, 1); }, "sh-mini"),
        button("✎", "重命名这个小类",
          event => { event.stopPropagation(); startRename(catKey, "category", rel, cat.label); },
          "sh-mini"),
      );
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
  updateBulkUI();
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
    const rels = new Set(managerAllRels());
    for (const rel of [...mgr.checked]) if (!rels.has(rel)) mgr.checked.delete(rel);
    mgr.renaming = null;
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

/* ------------------------------------------------------------ 图库管理弹窗 */

const GALLERY_ALL = "__all__";
const GALLERY_FAV = "__fav__";

function galleryUID(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function galleryImageURL(file) {
  if (!file) return "";
  // 与「导出 ZIP」一致用 fileURL：图片是静态资源，走不带 /api 前缀的路由，
  // 不会被前端的 API 认证层拦住（ComfyUI 两种前缀的路由都会注册）。
  const base = typeof api.fileURL === "function"
    ? api.fileURL("/sinheo/gallery/image") : "/sinheo/gallery/image";
  return `${base}?file=${encodeURIComponent(file)}`;
}

function setGalleryMessage(text, isError = false) {
  if (!galleryDlg) return;
  galleryDlg.msg.textContent = text || "";
  galleryDlg.msg.classList.toggle("sh-error", Boolean(isError));
}

function ensureGallery() {
  if (galleryDlg) return galleryDlg;
  const wrap = make("div", "sh-gallery");
  wrap.hidden = true;
  wrap.style.display = "none";
  stopCanvasEvents(wrap);
  const box = make("div", "sh-gallery-box");

  // 顶部：标题（左） / 留白 / 编辑·导入·导出·关闭（右侧一组，编辑紧挨导入左边）
  const head = make("div", "sh-gallery-head");
  const editBtn = button("✎ 编辑", "创建 / 修改 / 增减分类、分组与卡片",
    () => toggleGalleryEdit(), "sh-mini sh-primary");
  const center = make("div", "sh-gallery-head-center");
  const actions = make("div", "sh-gallery-head-actions");
  const importBtn = button("⬆ 导入", "导入图库包（ZIP / JSON），可合并或覆盖",
    () => openGalleryImport(), "sh-mini");
  const exportBtn = button("⬇ 导出", "打开导出面板，自己填保存位置，由服务端直接写盘（不经浏览器下载）",
    () => void openGalleryExport(), "sh-mini");
  actions.append(editBtn, importBtn, exportBtn);
  head.append(make("strong", "", "Sinheo · 图库管理"), center, actions,
              button("✕ 关闭", "关闭（Esc / 点空白处）", () => closeGallery(), "sh-mini"));

  // 编辑工具条：分类 / 分组的增删改 + 新增卡片
  const editBar = make("div", "sh-gallery-editbar");
  editBar.hidden = true;
  editBar.style.display = "none";
  const catSelect = make("select", "sh-select");
  const groupSelect = make("select", "sh-select");
  catSelect.title = "编辑作用的分类";
  groupSelect.title = "编辑作用的分组";
  catSelect.onchange = () => { galleryDlg.editCatId = catSelect.value; renderEditGroups(); };
  groupSelect.onchange = () => { galleryDlg.editGroupId = groupSelect.value; };
  editBar.append(
    make("span", "sh-gallery-edit-label", "分类"), catSelect,
    button("＋", "新建分类", () => void editCategory(null), "sh-mini"),
    button("✎", "重命名当前分类", () => void editCategory("rename"), "sh-mini"),
    button("🗑", "删除当前分类（含它的分组与卡片）", () => void deleteCategory(), "sh-mini sh-danger"),
    make("span", "sh-gallery-edit-label", "分组"), groupSelect,
    button("＋", "在当前分类下新建分组", () => void editGroup(null), "sh-mini"),
    button("✎", "重命名当前分组", () => void editGroup("rename"), "sh-mini"),
    button("🗑", "删除当前分组", () => void deleteGroup(), "sh-mini sh-danger"),
    button("＋ 新增卡片", "新建一张「图片 + 提示词」卡片", () => openCardEditor(null), "sh-mini sh-primary"),
  );

  // 搜索：按提示词匹配所有图片卡片
  const search = make("div", "sh-gallery-search");
  const searchInput = make("input", "sh-input sh-gallery-search-input");
  searchInput.type = "text";
  searchInput.placeholder = "搜索提示词…";
  searchInput.title = "按卡片提示词搜索";
  searchInput.oninput = () => { galleryDlg.query = searchInput.value; renderGalleryCards(); };
  const clearSearch = button("✕", "清空搜索", () => {
    searchInput.value = ""; galleryDlg.query = ""; renderGalleryCards();
  }, "sh-mini");
  const layoutBtn = button("▦ 整齐", "切换图库卡片布局：整齐网格 / 原比例瀑布",
    () => toggleGalleryLayout(), "sh-mini sh-layout-btn");
  search.append(make("span", "sh-gallery-search-icon", "🔍"), searchInput, clearSearch, layoutBtn);

  const tabs = make("div", "sh-gallery-tabs");

  const main = make("div", "sh-gallery-main");
  const side = make("div", "sh-gallery-side");
  const sideTitle = make("div", "sh-gallery-side-title", "分组");
  const sideList = make("div", "sh-gallery-side-list");
  side.append(sideTitle, sideList);
  const cards = make("div", "sh-gallery-cards");
  main.append(side, cards);

  const foot = make("div", "sh-gallery-foot");
  const count = make("span", "sh-gallery-count", "");
  const msg = make("span", "sh-gallery-msg", "");
  foot.append(count, msg);

  const cardEditor = make("div", "sh-gallery-card-editor");
  cardEditor.hidden = true;
  cardEditor.style.display = "none";
  const importPanel = make("div", "sh-gallery-import");
  importPanel.hidden = true;
  importPanel.style.display = "none";
  const exportPanel = make("div", "sh-gallery-import sh-gallery-export-root");
  exportPanel.hidden = true;
  exportPanel.style.display = "none";

  box.append(head, editBar, search, tabs, main, foot, cardEditor, importPanel, exportPanel);
  wrap.append(box);
  wrap.addEventListener("pointerdown", event => { if (event.target === wrap) closeGallery(); });
  document.body.appendChild(wrap);

  galleryDlg = {
    wrap, box, editBtn, editBar, catSelect, groupSelect,
    searchInput, tabs, side, sideTitle, sideList, cards, count, msg, cardEditor,
    importPanel, exportPanel, importBtn, exportBtn, layoutBtn,
    layout: readGalleryLayout(),
    node: null, data: null, query: "", tab: GALLERY_ALL, groupId: "",
    editing: false, editCatId: "", editGroupId: "", cardDraft: null,
  };
  syncLayoutBtn();
  return galleryDlg;
}

/* 布局偏好：隐私模式 / 内嵌窗口可能禁用 localStorage，读写都要防御。 */
function readGalleryLayout() {
  try {
    const saved = typeof localStorage !== "undefined"
      ? localStorage.getItem("sinheo_gallery_layout") : "";
    return saved === "flow" ? "flow" : "grid";
  } catch (error) { return "grid"; }
}

function saveGalleryLayout(value) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("sinheo_gallery_layout", value);
    }
  } catch (error) { /* 忽略 */ }
}

function syncLayoutBtn() {
  const dlg = galleryDlg;
  if (!dlg?.layoutBtn) return;
  const flow = dlg.layout === "flow";
  dlg.layoutBtn.textContent = flow ? "▤ 原比例" : "▦ 整齐";
  dlg.layoutBtn.title = flow
    ? "当前：原比例瀑布流。点一下切成统一整齐网格"
    : "当前：统一整齐网格（图片完整显示）。点一下切成原比例瀑布流";
}

function toggleGalleryLayout() {
  const dlg = galleryDlg;
  if (!dlg) return;
  dlg.layout = dlg.layout === "flow" ? "grid" : "flow";
  saveGalleryLayout(dlg.layout);
  syncLayoutBtn();
  renderGalleryCards();
  setGalleryMessage(dlg.layout === "flow"
    ? "布局：原比例瀑布流（按图片真实比例紧密排列）"
    : "布局：整齐网格（图片完整显示、统一格子）");
}

function closeCardEditor() {
  if (!galleryDlg) return;
  galleryDlg.cardEditor.hidden = true;
  galleryDlg.cardEditor.style.display = "none";
  galleryDlg.cardDraft = null;
}

function closeGallery() {
  if (!galleryDlg) return;
  closeCardEditor();
  closeGalleryImport();
  closeGalleryExport();
  galleryDlg.wrap.hidden = true;
  galleryDlg.wrap.style.display = "none";
}

async function openGallery(node) {
  const dlg = ensureGallery();
  dlg.node = node;
  dlg.wrap.hidden = false;
  dlg.wrap.style.display = "";
  dlg.query = "";
  dlg.searchInput.value = "";
  await loadGalleryData();
}

async function loadGalleryData() {
  try {
    const data = await requestJSON("/sinheo/gallery");
    if (!galleryDlg || galleryDlg.wrap.hidden) return;
    galleryDlg.data = data;
    if (galleryDlg.tab !== GALLERY_ALL && galleryDlg.tab !== GALLERY_FAV
        && !data.categories.some(cat => cat.id === galleryDlg.tab)) {
      galleryDlg.tab = GALLERY_ALL;
    }
    if (galleryDlg.groupId && !data.categories.some(
      cat => cat.groups.some(group => group.id === galleryDlg.groupId))) {
      galleryDlg.groupId = "";
    }
    renderGallery();
    setGalleryMessage("点卡片下方「使用」把提示词写进节点文本框；点 ♥ 加入收藏");
  } catch (error) {
    setGalleryMessage(`读取图库失败：${error.message}`, true);
  }
}

async function saveGalleryData(success) {
  try {
    const data = await requestJSON("/sinheo/gallery/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(galleryDlg.data),
    });
    galleryDlg.data = data;
    invalidateGallery();
    for (const node of nodes) {
      stateOf(node).galleryCache = data;
      updateSummary(node);
    }
    renderGallery();
    if (success) setGalleryMessage(success);
  } catch (error) {
    setGalleryMessage(`保存失败：${error.message}`, true);
  }
}

function renderGallery() {
  if (!galleryDlg?.data) return;
  renderGalleryTabs();
  renderGallerySide();
  renderGalleryCards();
  renderEditSelects();
}

function renderGalleryTabs() {
  const dlg = galleryDlg;
  const tabs = dlg.tabs;
  tabs.replaceChildren();
  const addTab = (id, label) => {
    const el = button(label, `查看：${label}`, () => {
      dlg.tab = id;
      dlg.groupId = "";
      renderGalleryTabs();
      renderGallerySide();
      renderGalleryCards();
    }, dlg.tab === id ? "sh-gallery-tab sh-active" : "sh-gallery-tab");
    tabs.append(el);
  };
  addTab(GALLERY_ALL, "全部");
  for (const cat of dlg.data.categories) addTab(cat.id, cat.name);
  addTab(GALLERY_FAV, "♥ 收藏");
}

function renderGallerySide() {
  const dlg = galleryDlg;
  const list = dlg.sideList;
  list.replaceChildren();
  const groups = [];
  if (dlg.tab === GALLERY_ALL || dlg.tab === GALLERY_FAV) {
    for (const cat of dlg.data.categories) {
      for (const group of cat.groups) groups.push({ id: group.id, name: group.name, cat: cat.name });
    }
  } else {
    const cat = dlg.data.categories.find(item => item.id === dlg.tab);
    for (const group of cat?.groups || []) groups.push({ id: group.id, name: group.name, cat: "" });
  }
  const addItem = (id, label, sub) => {
    const el = make("div", `sh-gallery-side-item${dlg.groupId === id ? " sh-active" : ""}`);
    el.append(make("span", "", label));
    if (sub) el.append(make("small", "", sub));
    el.onclick = () => {
      dlg.groupId = id;
      renderGallerySide();
      renderGalleryCards();
    };
    list.append(el);
  };
  addItem("", "全部");
  for (const group of groups) addItem(group.id, group.name, group.cat);
  if (!groups.length) {
    list.append(make("div", "sh-gallery-side-empty", "还没有分组\n点右上角「编辑」创建"));
  }
  dlg.sideTitle.textContent = dlg.tab === GALLERY_FAV ? "收藏 · 分组"
    : dlg.tab === GALLERY_ALL ? "分组（全部分类）" : "分组";
}

function visibleCards() {
  const dlg = galleryDlg;
  let cards = [...(dlg.data.cards || [])];
  if (dlg.tab === GALLERY_FAV) cards = cards.filter(card => card.favorite);
  else if (dlg.tab !== GALLERY_ALL) cards = cards.filter(card => card.categoryId === dlg.tab);
  if (dlg.groupId) cards = cards.filter(card => card.groupId === dlg.groupId);
  const query = dlg.query.trim().toLowerCase();
  if (query) {
    cards = cards.filter(card => String(card.prompt || "").toLowerCase().includes(query));
  }
  return cards;
}

function renderGalleryCards() {
  const dlg = galleryDlg;
  if (!dlg?.data) return;
  const grid = dlg.cards;
  const flow = dlg.layout === "flow";
  grid.classList.toggle("sh-layout-grid", !flow);
  grid.classList.toggle("sh-layout-flow", flow);
  grid.replaceChildren();
  const cards = visibleCards();
  if (dlg.editing) {
    const add = make("div", "sh-gallery-card sh-gallery-add");
    add.append(make("div", "sh-gallery-add-plus", "＋"), make("span", "", "新增卡片"));
    add.title = "新建一张「图片 + 提示词」卡片";
    add.onclick = () => openCardEditor(null);
    grid.append(add);
  }
  for (const card of cards) grid.append(buildGalleryCard(card));
  if (!cards.length && !dlg.editing) {
    grid.append(make("div", "sh-gallery-empty",
      dlg.data.cards?.length
        ? "没有匹配的卡片，换个关键词或分类试试"
        : "图库还是空的。点右上角「编辑」→ 新建分类 / 分组 / 卡片。"));
  }
  dlg.count.textContent = `显示 ${cards.length} 张 / 共 ${dlg.data.cards?.length || 0} 张`;
}

function buildGalleryCard(card) {
  const dlg = galleryDlg;
  const el = make("div", "sh-gallery-card");
  const prompt = String(card.prompt || "");
  // 整张卡片就是一张完整图片；提示词与按钮都浮在图片上，不再上下分层。
  el.title = prompt || "卡片图片";
  if (card.image) {
    const img = make("img", "sh-gallery-card-img");
    img.src = galleryImageURL(card.image);
    img.alt = prompt || "卡片图片";
    img.loading = "lazy";
    // 图片文件丢失 / 路径失效时给出统一占位，不再出现空白卡片
    img.onerror = () => img.replaceWith(
      make("div", "sh-gallery-card-placeholder", "🖼 图片加载失败"));
    el.append(img);
  } else {
    // 没有图片的卡片也占一个整齐格子，显示提示词而不是纯空白
    const short = prompt.length > 90 ? `${prompt.slice(0, 90)}…` : prompt;
    el.append(make("div", "sh-gallery-card-placeholder",
      prompt ? `🖼 无图片\n${short}` : "🖼 无图片"));
  }
  if (prompt) {
    el.append(make("div", "sh-gallery-card-prompt",
      prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt));
  }
  const actions = make("div", "sh-gallery-card-actions");
  const copyBtn = button("复制", "复制这张卡片的提示词到剪贴板",
    () => void copyGalleryCard(card, copyBtn), "sh-mini");
  actions.append(
    button("使用", "把这张卡片的提示词写进节点文本框",
      () => useGalleryCard(card), "sh-mini sh-primary"),
    copyBtn,
    button("♥", card.favorite ? "取消收藏" : "加入收藏",
      () => void toggleFavorite(card.id),
      `sh-mini sh-gallery-fav${card.favorite ? " sh-faved" : ""}`),
  );
  if (dlg.editing) {
    // 编辑工具放右上角，避免底部按钮条在窄卡片里挤成一团
    const tools = make("div", "sh-gallery-card-edit-tools");
    tools.append(
      button("✎", "编辑这张卡片", () => openCardEditor(card), "sh-mini"),
      button("🗑", "删除这张卡片", () => void deleteCard(card), "sh-mini sh-danger"),
    );
    el.append(tools);
  }
  el.append(actions);
  return el;
}

/** 复制单张卡片的提示词；按钮短暂显示结果，底部状态栏给出完整反馈。 */
async function copyGalleryCard(card, btn) {
  const ok = await copyText(String(card.prompt || ""));
  if (btn) flash(btn, ok ? "✓ 已复制" : "复制失败", "复制");
  setGalleryMessage(ok
    ? "已复制这张卡片的提示词到剪贴板"
    : "复制失败：请检查浏览器剪贴板权限", !ok);
}

async function toggleFavorite(cardId) {
  const card = galleryDlg.data.cards.find(item => item.id === cardId);
  if (!card) return;
  card.favorite = !card.favorite;
  await saveGalleryData(card.favorite ? "已加入收藏" : "已取消收藏");
}

function useGalleryCard(card) {
  const node = galleryDlg?.node;
  if (!node) return;
  const state = stateOf(node);
  // 随机模式下文本框只读且不参与输出，先切回文本框模式，保证「使用」真的生效
  if (state.config.randomize) {
    state.config.randomize = false;
    writeConfig(node);
    applyMode(node);
  }
  setText(node, card.prompt || "");
  commitText(node);
  setStatus(node, "已使用图库卡片的提示词", state.galleryBtn);
  closeGallery();
  if (state.galleryBtn) flash(state.galleryBtn, "✓ 已使用", "🖼 图库管理");
}

function toggleGalleryEdit() {
  const dlg = galleryDlg;
  dlg.editing = !dlg.editing;
  dlg.editBtn.textContent = dlg.editing ? "✓ 完成编辑" : "✎ 编辑";
  dlg.editBar.hidden = !dlg.editing;
  dlg.editBar.style.display = dlg.editing ? "" : "none";
  if (!dlg.editing) closeCardEditor();
  renderEditSelects();
  renderGalleryCards();
}

function renderEditSelects() {
  const dlg = galleryDlg;
  if (!dlg?.data) return;
  const cats = dlg.data.categories || [];
  if (!cats.some(cat => cat.id === dlg.editCatId)) dlg.editCatId = cats[0]?.id || "";
  dlg.catSelect.replaceChildren();
  if (!cats.length) {
    const empty = make("option", "", "（暂无分类）");
    empty.value = "";
    dlg.catSelect.append(empty);
  }
  for (const cat of cats) {
    const option = make("option", "", cat.name);
    option.value = cat.id;
    dlg.catSelect.append(option);
  }
  dlg.catSelect.value = dlg.editCatId;
  renderEditGroups();
}

function renderEditGroups() {
  const dlg = galleryDlg;
  const cat = (dlg.data.categories || []).find(item => item.id === dlg.editCatId);
  const groups = cat?.groups || [];
  if (!groups.some(group => group.id === dlg.editGroupId)) dlg.editGroupId = "";
  dlg.groupSelect.replaceChildren();
  const none = make("option", "", "（不分组）");
  none.value = "";
  dlg.groupSelect.append(none);
  for (const group of groups) {
    const option = make("option", "", group.name);
    option.value = group.id;
    dlg.groupSelect.append(option);
  }
  dlg.groupSelect.value = dlg.editGroupId;
}

async function editCategory(mode) {
  const dlg = galleryDlg;
  const cats = dlg.data.categories;
  if (mode === "rename") {
    const cat = cats.find(item => item.id === dlg.editCatId);
    if (!cat) return setGalleryMessage("请先新建一个分类", true);
    const name = String(window.prompt?.("分类新名称：", cat.name) || "").trim();
    if (!name || name === cat.name) return;
    cat.name = name;
  } else {
    const name = String(window.prompt?.("新分类名称：", "") || "").trim();
    if (!name) return;
    const id = galleryUID("cat");
    cats.push({ id, name, groups: [] });
    dlg.editCatId = id;
  }
  renderEditSelects();
  await saveGalleryData("分类已更新");
}

async function deleteCategory() {
  const dlg = galleryDlg;
  const cat = dlg.data.categories.find(item => item.id === dlg.editCatId);
  if (!cat) return setGalleryMessage("没有可删除的分类", true);
  const related = dlg.data.cards.filter(card => card.categoryId === cat.id).length;
  if (!confirm(`删除分类「${cat.name}」？\n它的分组和 ${related} 张卡片也会一起删除。`)) return;
  dlg.data.categories = dlg.data.categories.filter(item => item.id !== cat.id);
  dlg.data.cards = dlg.data.cards.filter(card => card.categoryId !== cat.id);
  dlg.editCatId = "";
  if (dlg.tab === cat.id) dlg.tab = GALLERY_ALL;
  if (dlg.groupId) dlg.groupId = "";
  renderEditSelects();
  await saveGalleryData("分类已删除");
}

async function editGroup(mode) {
  const dlg = galleryDlg;
  const cat = dlg.data.categories.find(item => item.id === dlg.editCatId);
  if (!cat) return setGalleryMessage("请先新建一个分类", true);
  if (mode === "rename") {
    const group = cat.groups.find(item => item.id === dlg.editGroupId);
    if (!group) return setGalleryMessage("请先选中或新建一个分组", true);
    const name = String(window.prompt?.("分组新名称：", group.name) || "").trim();
    if (!name || name === group.name) return;
    group.name = name;
  } else {
    const name = String(window.prompt?.("新分组名称（例如 日常 / 晚宴 / 职业）：", "") || "").trim();
    if (!name) return;
    const id = galleryUID("grp");
    cat.groups.push({ id, name });
    dlg.editGroupId = id;
  }
  renderEditGroups();
  await saveGalleryData("分组已更新");
}

async function deleteGroup() {
  const dlg = galleryDlg;
  const cat = dlg.data.categories.find(item => item.id === dlg.editCatId);
  const group = cat?.groups.find(item => item.id === dlg.editGroupId);
  if (!group) return setGalleryMessage("请先选中一个分组", true);
  if (!confirm(`删除分组「${group.name}」？\n该分组下的卡片会变成「不分组」，不会被删除。`)) return;
  cat.groups = cat.groups.filter(item => item.id !== group.id);
  for (const card of dlg.data.cards) if (card.groupId === group.id) card.groupId = "";
  dlg.editGroupId = "";
  if (dlg.groupId === group.id) dlg.groupId = "";
  renderEditGroups();
  await saveGalleryData("分组已删除");
}

async function deleteCard(card) {
  if (!confirm("删除这张卡片？")) return;
  galleryDlg.data.cards = galleryDlg.data.cards.filter(item => item.id !== card.id);
  await saveGalleryData("卡片已删除");
}

function openCardEditor(card) {
  const dlg = galleryDlg;
  const editor = dlg.cardEditor;
  editor.replaceChildren();
  const draft = card ? { ...card } : {
    id: galleryUID("card"),
    categoryId: dlg.editCatId || dlg.data.categories[0]?.id || "",
    groupId: dlg.editGroupId || "",
    prompt: "", image: "", favorite: false,
  };
  dlg.cardDraft = draft;

  const panel = make("div", "sh-gallery-card-panel");
  const panelHead = make("div", "sh-gallery-card-panel-head");
  panelHead.append(make("strong", "", card ? "编辑卡片" : "新增卡片"),
                   button("✕", "关闭", () => closeCardEditor(), "sh-mini"));

  const promptArea = make("textarea", "sh-textarea sh-gallery-field-input");
  promptArea.placeholder = "这张卡片对应的提示词…";
  promptArea.value = draft.prompt || "";
  promptArea.oninput = () => { draft.prompt = promptArea.value; };

  const catSel = make("select", "sh-select");
  for (const cat of dlg.data.categories) {
    const option = make("option", "", cat.name);
    option.value = cat.id;
    catSel.append(option);
  }
  catSel.value = draft.categoryId;
  const grpSel = make("select", "sh-select");
  const fillGroups = () => {
    grpSel.replaceChildren();
    const none = make("option", "", "（不分组）");
    none.value = "";
    grpSel.append(none);
    const cat = dlg.data.categories.find(item => item.id === catSel.value);
    for (const group of cat?.groups || []) {
      const option = make("option", "", group.name);
      option.value = group.id;
      grpSel.append(option);
    }
    if (![...grpSel.children].some(option => option.value === draft.groupId)) draft.groupId = "";
    grpSel.value = draft.groupId;
  };
  catSel.onchange = () => { draft.categoryId = catSel.value; fillGroups(); };
  grpSel.onchange = () => { draft.groupId = grpSel.value; };
  fillGroups();
  const selects = make("div", "sh-gallery-card-row");
  selects.append(catSel, grpSel);

  const preview = make("div", "sh-gallery-card-image-preview");
  const renderPreview = () => {
    preview.replaceChildren();
    if (draft.image) {
      const img = make("img");
      img.src = galleryImageURL(draft.image);
      preview.append(img);
    } else {
      preview.append(make("span", "sh-gallery-hint", "暂无图片"));
    }
  };
  renderPreview();
  const fileInput = make("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/webp,image/gif,image/bmp";
  fileInput.title = "选择一张本地图片上传";
  fileInput.onchange = () => void uploadCardImage(fileInput, draft, renderPreview);
  const removeImg = button("移除图片", "移除这张卡片的图片", () => {
    draft.image = "";
    renderPreview();
  }, "sh-mini");
  const imageRow = make("div", "sh-gallery-card-image-row");
  imageRow.append(preview, fileInput, removeImg);

  const panelFoot = make("div", "sh-gallery-card-panel-foot");
  const hint = make("span", "sh-gallery-msg", "");
  panelFoot.append(hint,
    button("取消", "放弃修改", () => closeCardEditor(), "sh-mini"),
    button("💾 保存卡片", "保存这张卡片", () => void saveCardDraft(hint), "sh-mini sh-primary"));

  panel.append(panelHead,
    make("label", "sh-gallery-field", "提示词"), promptArea,
    make("label", "sh-gallery-field", "分类 / 分组"), selects,
    make("label", "sh-gallery-field", "图片"), imageRow,
    panelFoot);
  editor.append(panel);
  editor.hidden = false;
  editor.style.display = "";
}

/* ---- 缩略图：图库只存「能认出效果」的小图 -------------------------------
 * 生成图常是 2~8 MB 的 PNG，而图库卡片只有 250px 宽。上传前先在浏览器里压成
 * 最长边 512px 的 JPEG（透明区铺白底），既省上传带宽，也让「存进去的就是缩略图」
 * 不依赖后端有没有 Pillow；服务端 save_image() 会再兜一层，任一环境不可用都降级。
 * 已是达标小 JPEG 时不重复编码，避免反复导入 / 导出越压越糊。 */
const THUMB_MAX_EDGE = 512;
const THUMB_QUALITY = 0.82;
const THUMB_MAX_BYTES = 160 * 1024;

async function makeThumbnail(blob, name) {
  const originalName = String(name || "image.png");
  if (!blob || typeof document === "undefined" || typeof Image === "undefined"
      || typeof URL?.createObjectURL !== "function") return { blob, name: originalName };
  let objectUrl = "";
  try {
    objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    const loaded = new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("图片解码失败"));
    });
    img.src = objectUrl;
    await loaded;
    const w = Number(img.naturalWidth) || 0;
    const h = Number(img.naturalHeight) || 0;
    if (!w || !h) return { blob, name: originalName };
    // 尺寸已达标的小 JPEG 不重复编码（字节上限放宽到 4 倍，防止噪点图被反复压糊）
    const isSmallJpeg = /\.jpe?g$/i.test(originalName)
      && Number(blob.size) <= THUMB_MAX_BYTES * 4 && Math.max(w, h) <= THUMB_MAX_EDGE;
    if (isSmallJpeg) return { blob, name: originalName };
    const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return { blob, name: originalName };
    ctx.fillStyle = "#ffffff";                 // 透明 PNG 合成白底，避免 JPEG 变黑
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await new Promise(resolve => {
      try { canvas.toBlob(resolve, "image/jpeg", THUMB_QUALITY); }
      catch (error) { resolve(null); }
    });
    if (!out || !out.size) return { blob, name: originalName };
    const stem = originalName.replace(/\.[^.]+$/, "") || "thumb";
    return { blob: out, name: `${stem.slice(0, 60)}.jpg` };
  } catch (error) {
    return { blob, name: originalName };       // 交给服务端 Pillow 或原样落盘
  } finally {
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch (error) { /* 忽略 */ }
    }
  }
}

/** 两个上传入口（添加到图库 / 卡片编辑器换图）都走这里，保证写入必是缩略图。 */
async function uploadGalleryImage(blob, name) {
  const thumb = await makeThumbnail(blob, name || "image.png");
  const form = new FormData();
  form.append("file", thumb.blob, thumb.name);
  const data = await requestJSON("/sinheo/gallery/image", { method: "POST", body: form });
  return data.file || "";
}

async function uploadCardImage(fileInput, draft, renderPreview) {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    draft.image = await uploadGalleryImage(file, file.name || "image.png");
    renderPreview();
    setGalleryMessage("缩略图已上传（512px JPEG），记得点「保存卡片」");
  } catch (error) {
    setGalleryMessage(`图片上传失败：${error.message}`, true);
  }
}

async function saveCardDraft(hint) {
  const dlg = galleryDlg;
  const draft = dlg.cardDraft;
  if (!draft) return;
  if (!draft.categoryId) {
    hint.textContent = "请先在「编辑」里创建一个分类";
    return;
  }
  const clean = {
    id: draft.id,
    categoryId: draft.categoryId,
    groupId: draft.groupId || "",
    prompt: String(draft.prompt || ""),
    image: draft.image || "",
    favorite: Boolean(draft.favorite),
  };
  const index = dlg.data.cards.findIndex(card => card.id === draft.id);
  if (index >= 0) dlg.data.cards[index] = clean;
  else dlg.data.cards.push(clean);
  closeCardEditor();
  await saveGalleryData("卡片已保存");
}

/* ---------------------------------------------------- 图库导入 / 导出 */

function closeGalleryImport() {
  if (!galleryDlg) return;
  galleryDlg.importPanel.hidden = true;
  galleryDlg.importPanel.style.display = "none";
}

function openGalleryImport() {
  const dlg = galleryDlg;
  if (!dlg) return;
  closeCardEditor();
  closeGalleryExport();
  const panel = dlg.importPanel;
  panel.replaceChildren();
  const box = make("div", "sh-gallery-import-panel");
  const head = make("div", "sh-gallery-import-head");
  head.append(make("strong", "", "导入图库"),
              button("✕", "关闭", () => closeGalleryImport(), "sh-mini"));
  box.append(head, make("div", "sh-gallery-import-hint",
    "选择本插件导出的 .zip（library.json + images/），或单个 .json 元数据文件。"));
  const fileInput = make("input");
  fileInput.type = "file";
  fileInput.accept = ".zip,.json,application/zip,application/json";
  fileInput.title = "选择图库包";
  const hint = make("span", "sh-gallery-msg", "还没选择文件");
  const foot = make("div", "sh-gallery-import-foot");
  foot.append(hint,
    button("取消", "关闭", () => closeGalleryImport(), "sh-mini"),
    button("合并导入", "保留现有数据，id 冲突的自动换新 id",
      () => void submitGalleryImport("merge"), "sh-mini sh-primary"),
    button("覆盖导入", "先整库备份，再用导入包替换现有图库",
      () => void submitGalleryImport("replace"), "sh-mini sh-danger"));
  box.append(fileInput, make("div", "sh-gallery-import-note",
    "覆盖导入会先把整个 gallery 目录备份到 .backup/replace-*，可手动找回。"), foot);
  panel.append(box);
  dlg.importFile = fileInput;
  dlg.importHint = hint;
  panel.hidden = false;
  panel.style.display = "";
}

async function submitGalleryImport(mode) {
  const dlg = galleryDlg;
  const file = dlg?.importFile?.files?.[0];
  if (!file) {
    dlg.importHint.textContent = "请先选择一个 .zip 或 .json 文件";
    return;
  }
  dlg.importHint.textContent = mode === "replace" ? "正在覆盖导入并备份…" : "正在合并导入…";
  try {
    const form = new FormData();
    form.append("file", file, file.name || "library.zip");
    form.append("mode", mode);
    const data = await requestJSON("/sinheo/gallery/import", { method: "POST", body: form });
    closeGalleryImport();
    invalidateGallery();
    await loadGalleryData();
    setGalleryMessage(`已${mode === "replace" ? "覆盖" : "合并"}导入：`
      + `${data.cards} 张卡片 / ${data.categories} 个分类 / ${data.images} 张图片`
      + (data.backup ? "（原图库已备份）" : ""));
    await refreshAll(true);
  } catch (error) {
    dlg.importHint.textContent = `导入失败：${error.message}`;
  }
}

/* ---- 导出到「自己选的位置」 ------------------------------------------------
 * 更正之前的归因：把「无法从网站上提取文件」说成 10 MB 大包太大是不准确的，
 * 实测小包同样失败。真正共性根因是「由网页发起的下载」本身 —— blob: URL、
 * <a download>、attachment 直链，在这个 Edge / 启动器内嵌窗口环境里会被下载
 * 管理器一律拦下，与文件大小无关（10 MB 只是让旧链路更容易失败）；
 * 系统「另存为」(showSaveFilePicker) 同样要浏览器授权，所以点了也没反应。
 *
 * 因此图库导出面板只留一条通道：填本机目录 → POST /export_to 由服务端直接写盘，
 * 并把上次用的目录记住（localStorage + 会话变量），下次打开自动填回。
 * 词库导出仍保留原来的 picker / anchor 通道（行为不变）。
 * 后端的 export_blob / export_info / download 路由仅为兼容保留，面板不再调用。 */
/** 用本机本地时间命名，精确到毫秒。
 *  旧版用 toISOString() 得到 UTC（比北京时间慢 8 小时），而且只在打开面板时算一次，
 *  之后每次导出都复用同一个值 + 覆盖写盘，所以磁盘上永远只有一个「固定名字」的 ZIP。 */
let lastZipStamp = "";
let zipStampSeq = 0;

function zipSuggestedName(prefix) {
  const d = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
    + `-${pad(d.getMilliseconds(), 3)}`;
  // 同一毫秒内连点两次导出也要拿到不同名字（否则会被同名覆盖）
  zipStampSeq = base === lastZipStamp ? zipStampSeq + 1 : 1;
  lastZipStamp = base;
  return `${prefix}_${base}${zipStampSeq > 1 ? `-${zipStampSeq}` : ""}.zip`;
}

function readableSize(size) {
  const bytes = Number(size || 0);
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 现仅词库导出使用。必须在点击的同步调用栈里调用，否则浏览器拒绝弹保存框。
 *  返回 { handle } / { cancel: true } / { error: 具体原因 }。
 *  File System Access API 只在「顶层窗口 + 安全上下文」可用：绘世启动器的内嵌窗口、
 *  iframe、http://局域网IP:8188 这类地址都会让接口消失或抛 SecurityError。
 *  旧版把所有非取消异常吞成 null，只留一行小字，看起来就是「点保存没反应」。 */
async function pickZipSaveTarget(suggestedName) {
  if (typeof window?.showSaveFilePicker !== "function") {
    return { error: "当前浏览器 / 内嵌窗口没有开放系统保存框接口"
      + "（需要 Chrome/Edge 顶层窗口 + https 或 127.0.0.1 安全上下文）" };
  }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: "ZIP 压缩包", accept: { "application/zip": [".zip"] } }],
    });
    return { handle };
  } catch (error) {
    if (error?.name === "AbortError") return { cancel: true };
    if (error?.name === "SecurityError") {
      return { error: "页面被嵌在内嵌窗口 / iframe，或不是安全上下文，浏览器禁止弹保存框" };
    }
    if (error?.name === "NotAllowedError") {
      return { error: "浏览器拒绝了保存框（内嵌窗口缺少文件权限，或等待过久失去用户手势）" };
    }
    return { error: `${error?.name || "Error"}：${error?.message || "未知原因"}` };
  }
}

async function writeZipToHandle(handle, blob) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return handle.name || "";
}

function downloadZipViaAnchor(blob, filename, directURL) {
  const anchor = make("a");
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  if (blob && blob.size) {
    const objectUrl = URL.createObjectURL(blob);
    anchor.href = objectUrl;
    anchor.rel = "noopener";
    anchor.click();
    setTimeout(() => { anchor.remove(); URL.revokeObjectURL(objectUrl); }, 120000);
  } else if (directURL) {
    anchor.href = typeof api.fileURL === "function" ? api.fileURL(directURL) : directURL;
    anchor.rel = "noopener";
    anchor.click();
    setTimeout(() => anchor.remove(), 30000);
  } else {
    anchor.remove();
    return false;
  }
  return true;
}

function setPanelMsg(el, text, isError = false) {
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("sh-error", Boolean(isError));
  el.title = "";
  if (el.style) el.style.cursor = "";
  el.onclick = null;
}

function closeGalleryExport() {
  const dlg = galleryDlg;
  if (!dlg?.exportPanel) return;
  dlg.exportPanel.hidden = true;
  dlg.exportPanel.style.display = "none";
}

let lastExportDir = "";
const EXPORT_DIR_KEY = "sinheo_gallery_export_dir";

/** 目录偏好：隐私模式 / 内嵌窗口可能禁用 localStorage，读写都要防御。 */
function readExportDir() {
  try {
    return typeof localStorage !== "undefined"
      ? (localStorage.getItem(EXPORT_DIR_KEY) || "") : "";
  } catch (error) { return ""; }
}

function saveExportDir(dir) {
  if (!dir) return;
  lastExportDir = dir;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(EXPORT_DIR_KEY, dir);
  } catch (error) { /* 隐私模式：至少本次会话内还记着 */ }
}

/** 后端返回的是完整 .zip 路径；记住的必须是「目录」，
 *  否则下次打开面板会把某个 ZIP 文件当成保存位置（旧版就是这么错的）。 */
function exportDirOf(path) {
  const raw = String(path || "").trim().replace(/[\\/]+$/, "");
  if (!raw) return "";
  if (!/\.zip$/i.test(raw)) return raw;
  const cut = Math.max(raw.lastIndexOf("\\"), raw.lastIndexOf("/"));
  return cut > 0 ? raw.slice(0, cut) : "";
}

/** 每次真正导出前刷新自动文件名；用户手改过名字就一直尊重他填的。 */
function autoExportName(input) {
  if (!input) return "";
  const current = String(input.value || "").trim();
  if (input.dataset?.autoName && current === input.dataset.autoName) {
    const next = zipSuggestedName("Sinheo_gallery");
    input.value = next;
    input.dataset.autoName = next;
  } else if (input.dataset) {
    delete input.dataset.autoName;   // 手改过：后续不再自动刷新
  }
  return String(input.value || "").trim();
}

function exportScopeLabel(categories, categoryId, groupId) {
  const cat = (categories || []).find(item => item.id === categoryId);
  if (!cat) return "";
  const group = (cat.groups || []).find(item => item.id === groupId);
  return group ? `${cat.name} / ${group.name}` : cat.name;
}

/** 点「⬇ 导出」：只打开面板，不做任何打包 / 下载，避免自动触发失败链路。 */
async function openGalleryExport() {
  const dlg = ensureGallery();
  closeCardEditor();
  closeGalleryImport();
  closeGalleryExport();
  const panel = dlg.exportPanel;
  panel.replaceChildren();

  const box = make("div", "sh-gallery-import-panel sh-gallery-export-panel");
  const head = make("div", "sh-gallery-import-head");
  head.append(make("strong", "", "⬇ 导出图库 · 自己选保存位置"),
              button("✕", "关闭", () => closeGalleryExport(), "sh-mini"));
  // 导出范围下拉的数据来自图库元数据；取不到时仍可导出整个图库
  let exportCats = [];
  try {
    const gallery = await getGalleryData();
    exportCats = Array.isArray(gallery?.categories) ? gallery.categories : [];
  } catch (error) { /* 旧后端 / 网络异常：只提供「整个图库」 */ }

  const nameRow = make("div", "sh-gallery-export-row");
  const nameInput = make("input", "sh-input sh-gallery-export-input");
  nameInput.value = zipSuggestedName("Sinheo_gallery");
  nameInput.dataset.autoName = nameInput.value;   // 记录自动名，手改过就不再刷新
  nameInput.title = "导出文件名（.zip）：每次导出自动刷新为本地时间；手动改过就一直用你填的名字";
  nameInput.addEventListener("input", () => { delete nameInput.dataset.autoName; });
  nameRow.append(make("span", "sh-gallery-export-label", "文件名"), nameInput);

  const pathRow = make("div", "sh-gallery-export-row");
  const pathInput = make("input", "sh-input sh-gallery-export-input");
  pathInput.value = readExportDir() || lastExportDir || "";
  pathInput.placeholder = "例如 F:\\Desktop  或  F:\\Desktop\\图库.zip";
  pathInput.title = "本机绝对路径：填文件夹就用上面的文件名，填 .zip 全路径就用它；目录会被记住";
  pathRow.append(make("span", "sh-gallery-export-label", "保存到"), pathInput);

  // 导出范围：默认整个图库；选分类 = 只导该分类，选分组 = 只导该分类下的这组
  const scopeRow = make("div", "sh-gallery-export-row");
  const catSelect = make("select", "sh-input sh-gallery-export-select");
  catSelect.title = "只导出这个分类（默认整个图库）";
  const allCats = make("option", "", "整个图库");
  allCats.value = "";
  catSelect.append(allCats);
  for (const cat of exportCats) {
    const option = make("option", "", cat.name);
    option.value = cat.id;
    catSelect.append(option);
  }
  const groupSelect = make("select", "sh-input sh-gallery-export-select");
  groupSelect.title = "只导出该分类下的某个分组（默认全部分组）";
  const fillExportGroups = () => {
    groupSelect.replaceChildren();
    const all = make("option", "", "全部分组");
    all.value = "";
    groupSelect.append(all);
    const cat = exportCats.find(item => item.id === catSelect.value);
    for (const group of cat?.groups || []) {
      const option = make("option", "", group.name);
      option.value = group.id;
      groupSelect.append(option);
    }
    groupSelect.value = "";
  };
  catSelect.onchange = () => fillExportGroups();
  fillExportGroups();
  scopeRow.append(make("span", "sh-gallery-export-label", "分类"), catSelect,
                  make("span", "sh-gallery-export-label", "分组"), groupSelect);

  const msg = make("div", "sh-gallery-msg", "");
  const foot = make("div", "sh-gallery-import-foot");
  // 只保留服务端写盘：另存为 / 浏览器下载在这个浏览器环境里一律被拦，留着只会误导
  foot.append(msg,
    button("取消", "关闭", () => closeGalleryExport(), "sh-mini"),
    button("💾 保存到该位置", "由服务端把 ZIP 直接写进你填的目录（不依赖浏览器下载 / 系统保存框）",
      () => void submitGalleryExportTo(pathInput.value, autoExportName(nameInput), msg, {
        category: catSelect.value, group: groupSelect.value,
        label: exportScopeLabel(exportCats, catSelect.value, groupSelect.value),
      }),
      "sh-mini sh-primary"));

  box.append(head, nameRow, pathRow, scopeRow, foot);
  panel.append(box);
  dlg.exportPathInput = pathInput;
  dlg.exportNameInput = nameInput;
  dlg.exportMsg = msg;
  panel.hidden = false;
  panel.style.display = "";

  // 只有在没有任何记住的目录时，才预填 ComfyUI 的 output/Sinheo/exports 默认目录
  if (!pathInput.value) {
    try {
      const data = await requestJSON("/sinheo/gallery/export_dir");
      if (data?.dir) {
        lastExportDir = data.dir;
        pathInput.value = lastExportDir;
      }
    } catch (error) { /* 旧版插件：用户自己填路径即可 */ }
  }
}

/** 主路径：服务端写盘，全程不产生 blob: URL，也不碰浏览器下载管理器。 */
async function submitGalleryExportTo(rawPath, filename, msgEl, scope) {
  const target = String(rawPath || "").trim();
  if (!target) { setPanelMsg(msgEl, "请先填写保存位置（本机绝对路径）", true); return; }
  setPanelMsg(msgEl, "正在打包并写入…");
  try {
    const response = await api.fetchApi("/sinheo/gallery/export_to", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: target, filename: String(filename || ""), overwrite: true,
        category: scope?.category || "", group: scope?.group || "",
      }),
    });
    let data = {};
    try { data = await response.json(); } catch (error) { /* 忽略非 JSON 响应 */ }
    if (!response.ok) {
      const hint = /40[045]/.test(String(response.status))
        ? "服务端还是旧版插件，请重启 ComfyUI 后才能保存到指定位置"
        : (data.error || `${response.status} ${response.statusText}`);
      throw new Error(hint);
    }
    saveExportDir(exportDirOf(data.path || target));
    const label = scope?.label ? ` · ${scope.label}` : "";
    const text = `已导出 ${readableSize(data.size)}${label} → ${data.path}`;
    setPanelMsg(msgEl, text);
    enablePathCopy(msgEl, data.path, text);
    setGalleryMessage(text);
    enablePathCopy(galleryDlg?.msg, data.path, text);
    galleryDlg.lastExport = data;
  } catch (error) {
    setPanelMsg(msgEl, `保存失败：${error.message}`, true);
  }
}

function enablePathCopy(el, path, message) {
  if (!el || !path) return;
  el.title = `点击复制完整路径：${path}`;
  el.style.cursor = "pointer";
  el.onclick = () => void copyText(path).then(ok => {
    if (ok) flash(el, "✓ 已复制路径", message);
  });
}

/** 兼容旧调用：现在点「导出」只打开面板，不会自动触发浏览器下载。 */
function downloadGalleryExport() {
  return openGalleryExport();
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
  const suggested = zipSuggestedName("Sinheo_prompts");
  // 与图库导出一致：先弹系统「另存为」；词库包只有 ~1 KB，不支持时回退浏览器下载
  const picked = await pickZipSaveTarget(suggested);
  if (picked.cancel) { setExportMessage("已取消保存"); return; }
  const handle = picked.handle || null;
  if (picked.error) setExportMessage(`系统「另存为」不可用（${picked.error}），将交给浏览器下载`);
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
    if (handle) {
      const savedName = await writeZipToHandle(handle, blob);
      setExportMessage(`已导出 ${selection.length} 个小类 → ${savedName || suggested}（你选的保存位置）`);
    } else {
      downloadZipViaAnchor(blob, suggested);
      setExportMessage(`已导出 ${selection.length} 个小类（${blob.size} 字节）`);
    }
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
  head.append(make("strong", "", "＋ 添加到图库 · 生成的图 + 使用的提示词"),
              button("✕ 关闭", "关闭（Esc）", () => closeAdder()));

  const body = make("div", "sh-add-body");

  const imageRow = make("div", "sh-add-image-row");
  const imagePreview = make("div", "sh-add-image-preview");
  const imageTools = make("div", "sh-add-image-tools");
  const pickFile = make("input");
  pickFile.type = "file";
  pickFile.accept = "image/png,image/jpeg,image/webp,image/gif,image/bmp";
  pickFile.title = "手动选一张本地图片";
  pickFile.onchange = () => void loadAdderFile(pickFile);
  imageTools.append(
    make("span", "sh-add-image-label", "图片 · 自动存 512px 缩略图"),
    button("↻ 抓取最近生成图", "从本次工作流输出里取最后一张图",
      () => void fetchLatestImage(true), "sh-mini"),
    pickFile,
    button("移除图片", "不保存图片，只存提示词", () => {
      adder.imageFile = ""; adder.imageBlob = null; renderAdderImage();
    }, "sh-mini"),
  );
  imageRow.append(imagePreview, imageTools);
  body.append(imageRow);

  const promptArea = make("textarea", "sh-textarea sh-add-prompt");
  promptArea.placeholder = "这张卡片使用的提示词…";
  promptArea.oninput = () => { adder.text = promptArea.value; };
  body.append(make("label", "sh-add-label", "提示词"), promptArea);

  const targetRow = make("div", "sh-add-target-row");
  const catSelect = make("select", "sh-select");
  catSelect.title = "保存到哪个图库分类";
  catSelect.onchange = () => renderAdderGroups();
  const groupSelect = make("select", "sh-select");
  groupSelect.title = "保存到该分类下的哪个分组";
  groupSelect.onchange = () => { adder.groupId = groupSelect.value; };
  targetRow.append(make("span", "sh-add-label", "分类"), catSelect,
                   make("span", "sh-add-label", "分组"), groupSelect);
  body.append(targetRow);

  const foot = make("div", "sh-export-foot");
  const info = make("span", "sh-exp-info", "");
  const msg = make("span", "sh-exp-msg", "");
  const only = button("○ 只记住目标", "记住当前分类 / 分组，刷新页面后仍生效；再点一次取消",
                      () => toggleRememberTarget(), "sh-mini");
  const apply = button("💾 保存到图库", "把图片 + 提示词存成一张图库卡片",
                       () => void confirmAdder(true), "sh-primary");
  foot.append(info, msg, button("取消", "关闭", () => closeAdder()), only, apply);

  box.append(head, body, foot);
  wrap.append(box);
  wrap.addEventListener("pointerdown", event => { if (event.target === wrap) closeAdder(); });
  document.body.appendChild(wrap);
  adder = {
    wrap, info, msg, only, apply, catSelect, groupSelect,
    promptArea, imagePreview, imageTools, pickFile,
    node: null, data: null, text: "", imageFile: "", imageBlob: null,
    imageName: "", objectUrl: "", groupId: "",
  };
  return adder;
}

function closeAdder() {
  if (!adder) return;
  adder.wrap.hidden = true;
  adder.wrap.style.display = "none";
}

function renderAdderImage() {
  const dlg = adder;
  if (!dlg) return;
  if (dlg.objectUrl) {
    try { URL.revokeObjectURL(dlg.objectUrl); } catch (error) { /* 忽略 */ }
    dlg.objectUrl = "";
  }
  dlg.imagePreview.replaceChildren();
  let src = "";
  if (dlg.imageFile) src = galleryImageURL(dlg.imageFile);
  else if (dlg.imageBlob) {
    try {
      dlg.objectUrl = URL.createObjectURL(dlg.imageBlob);
      src = dlg.objectUrl;
    } catch (error) { src = ""; }
  }
  if (src) {
    const img = make("img");
    img.src = src;
    img.alt = "待保存的图片";
    dlg.imagePreview.append(img);
  } else {
    dlg.imagePreview.append(make("span", "sh-gallery-hint",
      "没抓到生成图，可手动选一张本地图片"));
  }
}

/** 「生成图」和「加载图」的分界：ComfyUI 把 LoadImage 的预览挂在 type=input 上，
 *  只有 output（SaveImage）/ temp（PreviewImage）才是工作流跑出来的结果。 */
function isGeneratedImageType(value) {
  const type = String(value || "output").toLowerCase();
  return type === "output" || type === "temp";
}

/** 收集工作流产出的图片描述，最新的排前面（去重）。
 *  新版 ComfyUI 前端把执行结果分散在 app.nodeOutputs / nodePreviewImages /
 *  画布节点的 images、imgs 里，key 也不再是纯节点 id。画布上「加载图像」节点
 *  的预览也在这些数组里，所以这里同时做两道过滤：type=input 一律丢弃、
 *  LoadImage 系节点整节点跳过，避免把输入原图当成生成图抓进图库。 */
function latestImageDescriptors() {
  const list = [];
  const push = raw => {
    if (!raw || typeof raw !== "object") return;
    const filename = String(raw.filename || "");
    // blake3: 是新版 ComfyUI 的 asset hash，只能交给 /view 解析，不当普通文件名
    if (!filename || filename.startsWith("blake3:")) return;
    if (filename.includes("filename=")) { fromURL(filename, true); return; }
    if (!isGeneratedImageType(raw.type)) return;      // 丢掉 type=input 的加载图
    list.push({
      filename,
      subfolder: String(raw.subfolder || ""),
      type: String(raw.type || "output"),
    });
  };
  const fromURL = (value, implicitOutputOK) => {
    if (typeof value !== "string" || !value.includes("filename=")) return;
    try {
      const params = new URLSearchParams(value.split("?")[1] || "");
      const filename = params.get("filename");
      const type = params.get("type") || "";
      // 画布预览图的 src 若不写 type，无法判断是不是 LoadImage，宁可不要
      if (!type && !implicitOutputOK) return;
      if (!filename || !isGeneratedImageType(type)) return;
      list.push({ filename, subfolder: params.get("subfolder") || "",
                  type: type || "output" });
    } catch (error) { /* 忽略非法 URL */ }
  };
  const collect = (holder, fromCanvasPreview = false) => {
    if (Array.isArray(holder)) {
      for (const image of [...holder].reverse()) {
        if (typeof image === "string") fromURL(image, !fromCanvasPreview);
        else {
          push(image);
          // litegraph 的预览图是 Image 对象，只有 src 里带 /view?filename=...
          if (image && typeof image === "object" && typeof image.src === "string") {
            fromURL(image.src, false);
          }
        }
      }
      return;
    }
    if (!holder || typeof holder !== "object") return;
    for (const key of Object.keys(holder).reverse()) {
      const value = holder[key];
      if (Array.isArray(value)) collect(value, fromCanvasPreview);
      else if (value && typeof value === "object") collect(value.images, fromCanvasPreview);
    }
  };
  collect(app?.nodeOutputs);
  collect(app?.nodePreviewImages);
  const graphNodes = app?.graph?._nodes || [];
  for (const node of [...graphNodes].reverse()) {
    const kind = String(node?.type || node?.comfyClass || "");
    // 加载图像 / 加载遮罩等输入节点：画布上的预览就是原图，绝不能当生成结果
    if (/loadimage|load_image|image.*load/i.test(kind)) continue;
    collect(node?.images);
    collect(node?.imgs, true);
  }
  const seen = new Set();
  return list.filter(item => {
    const key = `${item.type}|${item.subfolder}|${item.filename}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function imageViewRoute(desc) {
  const params = new URLSearchParams({
    filename: desc.filename,
    subfolder: desc.subfolder || "",
    type: desc.type || "output",
  });
  return `/view?${params.toString()}`;
}

/** 服务端 /history 的 outputs 只记录真正产出图片的节点（SaveImage / PreviewImage），
 *  LoadImage 是输入节点不会出现在里面 —— 所以它是「最近生成图」最可靠的来源，
 *  而且刷新页面后依然在，不受前端输出结构变化影响。 */
async function historyImageDescriptors() {
  try {
    const response = await api.fetchApi("/history?max_items=1");
    if (!response?.ok) return [];
    const data = await response.json();
    const out = [];
    for (const item of Object.values(data || {})) {
      for (const output of Object.values(item?.outputs || {})) {
        for (const image of [...(output?.images || [])].reverse()) {
          const filename = String(image?.filename || "");
          const type = String(image?.type || "output");
          if (!filename || filename.startsWith("blake3:")) continue;
          if (!isGeneratedImageType(type)) continue;   // 再防一手 input
          out.push({ filename, subfolder: String(image.subfolder || ""), type });
        }
      }
    }
    return out;
  } catch (error) { return []; }
}

async function readImageBlob(response) {
  if (!response?.ok || typeof response.blob !== "function") return null;
  const blob = await response.blob();
  if (!blob || !blob.size) return null;
  let name = "";
  try { name = response.headers?.get?.("X-Sinheo-Image") || ""; }
  catch (error) { /* 忽略 */ }
  return { blob, name };
}

/** 依次尝试每条地址：先走 api.fetchApi（自动补 /api 前缀 + 认证头），
 *  再走裸 fetch 的静态 /view（兼容旧版 ComfyUI）。 */
async function tryImageChannels(routes) {
  for (const route of routes) {
    try {
      const hit = await readImageBlob(await api.fetchApi(route, { cache: "no-store" }));
      if (hit) return { ...hit, route };
    } catch (error) { /* 换下一条通道 */ }
    try {
      const url = typeof api.fileURL === "function" ? api.fileURL(route) : route;
      const hit = await readImageBlob(await fetch(url, { cache: "no-store" }));
      if (hit) return { ...hit, route };
    } catch (error) { /* 换下一条通道 */ }
  }
  return null;
}

async function fetchLatestImage(manual = false) {
  const dlg = adder;
  if (!dlg) return;
  // 1) 服务端 /history 的真实执行输出：只可能是 SaveImage / PreviewImage 的产出，
  //    绝不会是「加载图像」节点的输入原图，因此排在最前面。
  const fromHistory = await historyImageDescriptors();
  // 2) 前端当前会话的输出（已过滤 type=input 与 LoadImage 节点预览）
  const descriptors = latestImageDescriptors();
  const viewRoutes = [...new Set([...fromHistory, ...descriptors]
    .map(imageViewRoute))].slice(0, 8);
  let hit = await tryImageChannels(viewRoutes);
  // 3) 插件后端兜底：按参数精确找，找不到就只扫 output 目录取最新生成图。
  //    这里刻意不扫 temp / input，避免把上传或加载的原图当成生成图。
  if (!hit) {
    const first = fromHistory[0] || descriptors[0];
    const query = first
      ? "?" + new URLSearchParams({
          filename: first.filename,
          subfolder: first.subfolder,
          type: first.type,
        }).toString()
      : "";
    hit = await tryImageChannels(["/sinheo/gallery/latest_image" + query]);
  }
  if (!hit) {
    setAddMessage(manual
      ? "没抓到生成图：请先运行一次工作流，或点「选择文件」手动选一张本地图片；"
        + "若刚更新过插件，请重启 ComfyUI 后再试"
      : "没抓到生成图，可点「选择文件」手动选一张本地图片", manual);
    return;
  }
  let name = hit.name;
  if (!name) {
    try { name = new URLSearchParams(hit.route.split("?")[1] || "").get("filename") || ""; }
    catch (error) { name = ""; }
  }
  dlg.imageBlob = hit.blob;
  dlg.imageName = name || "generated.png";
  dlg.imageFile = "";
  renderAdderImage();
  setAddMessage("已抓到最近生成的图片，选好分类后点「保存到图库」");
}

async function loadAdderFile(input) {
  const file = input.files?.[0];
  if (!file || !adder) return;
  adder.imageBlob = file;
  adder.imageName = file.name || "image.png";
  adder.imageFile = "";
  renderAdderImage();
  setAddMessage("已选择本地图片，选好分类后点「保存到图库」");
}

function renderAdderGroups() {
  const dlg = adder;
  if (!dlg?.data) return;
  const cat = (dlg.data.categories || []).find(item => item.id === dlg.catSelect.value);
  dlg.groupSelect.replaceChildren();
  const none = make("option", "", "（不分组）");
  none.value = "";
  dlg.groupSelect.append(none);
  for (const group of cat?.groups || []) {
    const option = make("option", "", group.name);
    option.value = group.id;
    dlg.groupSelect.append(option);
  }
  dlg.groupSelect.value = [...dlg.groupSelect.children].some(o => o.value === dlg.groupId)
    ? dlg.groupId : "";
  dlg.groupId = dlg.groupSelect.value;
}

/** 上传图片（如有）+ 追加一张卡片到 library.json。 */
async function saveAdderCard(node, categoryId, groupId, text, blob, imageName) {
  const state = stateOf(node);
  const btn = state.addEl;
  if (!categoryId) {
    setStatus(node, "请先选一个图库分类", btn);
    return;
  }
  if (btn) btn.disabled = true;
  try {
    let image = "";
    if (blob) image = await uploadGalleryImage(blob, imageName || "generated.png");
    const data = await getGalleryData(true);
    const card = {
      id: galleryUID("card"),
      categoryId, groupId: groupId || "",
      prompt: String(text || ""),
      image, favorite: false,
    };
    const payload = {
      version: 1,
      categories: data.categories || [],
      cards: [...(data.cards || []), card],
      settings: {},
    };
    await requestJSON("/sinheo/gallery/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    invalidateGallery();
    setStatus(node, image
      ? "已把生成的图片 + 使用的提示词存进图库"
      : "已把提示词存进图库（没抓到图片）", btn);
    flash(btn, "✓ 已保存", "＋ 添加到图库");
    await refreshAll(true);
  } catch (error) {
    const reason = /40[45]/.test(String(error.message))
      ? "服务端还是旧版插件，请重启 ComfyUI 后再添加" : error.message;
    setStatus(node, `添加失败：${reason}`, btn);
    flash(btn, "需重启", "＋ 添加到图库");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function openAdder(node, immediate = false) {
  const dlg = ensureAdder();
  dlg.node = node;
  dlg.text = currentPromptText(node);
  dlg.wrap.hidden = false;
  dlg.wrap.style.display = "";
  dlg.imageBlob = null;
  dlg.imageFile = "";
  dlg.imageName = "";
  dlg.promptArea.value = dlg.text;
  try {
    dlg.data = await getGalleryData(true);
  } catch (error) {
    setAddMessage(`读取图库失败：${error.message}`, true);
    dlg.data = { categories: [], cards: [] };
  }
  const state = stateOf(node);
  const cats = dlg.data.categories || [];
  dlg.catSelect.replaceChildren();
  if (!cats.length) {
    const empty = make("option", "", "（暂无分类，请先在图库管理里创建）");
    empty.value = "";
    dlg.catSelect.append(empty);
  }
  for (const cat of cats) {
    const option = make("option", "", cat.name);
    option.value = cat.id;
    dlg.catSelect.append(option);
  }
  const wanted = state.addCategory || cats[0]?.id || "";
  dlg.catSelect.value = cats.some(cat => cat.id === wanted) ? wanted : (cats[0]?.id || "");
  dlg.groupId = state.addGroup || "";
  renderAdderGroups();
  dlg.apply.disabled = !cats.length;
  dlg.only.disabled = !cats.length;
  renderRememberButton();   // 反映「已记住 / 未记住」，让用户能再点一次取消
  // 不再常驻显示「几个分类 / 几张卡片」这类数量统计，底部只留操作反馈与按钮
  dlg.info.textContent = "";
  setAddMessage(immediate
    ? "选好分类后点「保存到图库」"
    : "会自动抓取最近一次生成的图片；也可手动选图");
  renderAdderImage();
  await fetchLatestImage(false);
}

/** 刷新「只记住目标」按钮的外观，让它能反映当前是否记住。 */
function renderRememberButton() {
  if (!adder?.only) return;
  const on = Boolean(readAddTarget());
  adder.only.textContent = on ? "✓ 只记住目标" : "○ 只记住目标";
  adder.only.title = on
    ? "已记住的目标刷新页面后仍生效；再点一次取消记住"
    : "记住当前分类 / 分组，刷新页面后仍生效；再点一次取消";
  adder.only.classList.toggle("sh-toggle-on", on);
}

/** 再点一次即取消：偏好只由这个开关管理，点「保存到图库」不会隐式记住。 */
function toggleRememberTarget() {
  const dlg = adder;
  if (!dlg?.node) return;
  const state = stateOf(dlg.node);
  if (readAddTarget()) {
    writeAddTarget(null);
    state.addCategory = "";
    state.addGroup = "";
    setAddMessage("已取消记住目标，下次点「＋ 添加到图库」会重新弹窗");
  } else {
    const categoryId = dlg.catSelect.value;
    if (!categoryId) { setAddMessage("请先在图库管理里创建分类", true); return; }
    const groupId = dlg.groupSelect.value || "";
    writeAddTarget({ categoryId, groupId });
    state.addCategory = categoryId;
    state.addGroup = groupId;
    const cat = (dlg.data?.categories || []).find(item => item.id === categoryId);
    const group = (cat?.groups || []).find(item => item.id === groupId);
    const label = group ? `${cat.name} / ${group.name}` : (cat?.name || categoryId);
    setAddMessage(`已记住目标：${label}（刷新页面后仍生效；再点一次可取消）`);
  }
  syncControls(dlg.node);
  renderRememberButton();
}

function confirmAdder(doAdd) {
  const dlg = adder;
  if (!dlg?.node) return;
  const node = dlg.node;
  const categoryId = dlg.catSelect.value;
  const groupId = dlg.groupSelect.value;
  dlg.text = dlg.promptArea.value;
  if (!doAdd) return;               // 兼容旧调用：记住目标已交给独立开关
  if (readAddTarget()) {
    // 开关开启时同步更新目标（用户可能刚改了分类 / 分组）；未开启则不隐式记住
    writeAddTarget({ categoryId, groupId });
    const state = stateOf(node);
    state.addCategory = categoryId;
    state.addGroup = groupId;
    syncControls(node);
  }
  closeAdder();
  void saveAdderCard(node, categoryId, groupId,
                     dlg.text, dlg.imageBlob, dlg.imageName);
}

/** 节点上的「＋ 添加到图库」：没设目标就开弹窗，设过目标就一键静默保存。 */
async function addCurrent(node) {
  const remembered = readAddTarget();
  const dlg = ensureAdder();
  if (remembered?.categoryId) {
    dlg.node = node;
    dlg.text = currentPromptText(node);
    dlg.imageBlob = null;
    dlg.imageFile = "";
    dlg.imageName = "";
    closeAdder();
    await fetchLatestImage(false);
    await saveAdderCard(node, remembered.categoryId, remembered.groupId,
                        dlg.text, dlg.imageBlob, dlg.imageName);
    return;
  }
  await openAdder(node, true);
}

/* Esc 关闭本插件的所有弹窗 */
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  let closed = false;
  if (galleryDlg && !galleryDlg.wrap.hidden) {
    if (!galleryDlg.importPanel.hidden) closeGalleryImport();
    else if (!galleryDlg.cardEditor.hidden) closeCardEditor();
    else { closeGallery(); closed = true; }
  }
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
    const spec = nodeData?.input || {};
    backendHasExternalInput = Boolean(
      spec?.optional?.external_text || spec?.required?.external_text
      || (Array.isArray(nodeData?.inputs)
          && nodeData.inputs.some(item => item?.name === EXTERNAL_INPUT)));
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = created?.apply(this, arguments);
      const node = this;
      nodes.add(node);
      node.color ??= "#4b6b86";
      stateOf(node);
      buildBody(node);
      // 后端新增了可选的 external_text STRING 输入：老工作流里的节点在这里补上插槽
      ensureExternalInput(node);
      syncExternalState(node, true);          // force=true 时一定会走一次 applyMode
      void loadInto(node);

      const previousConfigure = node.onConfigure;
      node.onConfigure = function () {
        const output = previousConfigure?.apply(this, arguments);
        const state = stateOf(node);
        state.config = readConfig(node);
        ensureExternalInput(node);            // 载入旧工作流时补齐新插槽
        syncExternalState(node, true);
        void loadInto(node, true);
        return output;
      };

      const previousConnections = node.onConnectionsChange;
      node.onConnectionsChange = function () {
        const output = previousConnections?.apply(this, arguments);
        // 插上 / 拔掉外部文本连线时，立即切换文本框的展示与只读状态
        syncExternalState(node);
        return output;
      };

      const previousExecuted = node.onExecuted;
      node.onExecuted = function (message) {
        const output = previousExecuted?.apply(this, arguments);
        const text = message?.sinheo_text?.[0];
        if (typeof text === "string") {
          const state = stateOf(node);
          state.lastText = text;
          if (externalLinked(node)) {
            // 外部文本：把实际输出展示在文本框里（只读），绝不写回 manual_text
            state.lastExternalText = text;
            setPreview(node, text || "（外部文本为空）", !text);
          } else if (state.config.randomize) {
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
