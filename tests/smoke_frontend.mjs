/*
 * 前端冒烟测试：用极简 DOM 模拟真实执行一遍 sinheo.js 的主要代码路径。
 * 覆盖：节点创建 / 文本框编辑 / 生成 / 复制（含随机模式）/ 随机开关 / 勾选菜单 /
 *       循环排序 / 关闭按钮 / 导入下拉 / 导出勾选弹窗 / 「＋ 添加到」勾选弹窗 /
 *       两级词库管理 / 已移除「随机勾选」与「全部拼接」。
 *
 *   node tests/smoke_frontend.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, "../web/sinheo.js"), "utf8")
  .replace(/^import .*$/gm, "")
  .replace(/import\.meta\.url/g, '"http://local/sinheo.js"');

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.className = "";
    this.dataset = {};
    this.style = { cssText: "" };
    this.textContent = "";
    this.value = "";
    this.placeholder = "";
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.scrollTop = 0;
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(n => this._classes.add(n)),
      remove: (...names) => names.forEach(n => this._classes.delete(n)),
      contains: name => this._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (on) this._classes.add(name); else this._classes.delete(name);
        return on;
      },
    };
  }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  appendChild(item) { this.append(item); return item; }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  contains(el) { if (el === this) return true; return this.children.some(c => c.contains?.(el)); }
  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() { return { left: 100, top: 100, right: 440, bottom: 128, width: 340, height: 28 }; }
  querySelector() { return null; }
  setAttribute() {}
  click() { this.onclick?.({ stopPropagation() {}, target: this }); }
  focus() {}
  select() {}
}

const docListeners = {};
const documentStub = {
  createElement: tag => new El(tag),
  createTextNode: text => ({ textContent: text, parent: null }),
  head: new El("head"),
  body: new El("body"),
  querySelector: () => null,
  addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  removeEventListener(type, fn) {
    docListeners[type] = (docListeners[type] || []).filter(f => f !== fn);
  },
  execCommand: () => true,
};
const windowStub = { innerWidth: 1600, innerHeight: 1000, isSecureContext: true,
                     prompt: () => "新导入大类" };
const GENERATED = "浅粉蝴蝶结雪纺上衣, 银灰色";
let copiedText = null;
let generateCalls = 0;
const fetchCalls = [];
const apiCalls = [];

// 两级词库：大类文件夹 / 小类.txt，一个小类就是一个 TXT
const LIBRARY = {
  root: "/path/to/ComfyUI/models/Sinheo/prompts",
  roots: ["/path/to/ComfyUI/models/Sinheo/prompts"],
  order: { groups: ["上衣"], categories: { "上衣": ["上衣/甜美", "上衣/可爱"] } },
  groups: [
    {
      id: "上衣", label: "上衣", count: 2,
      categories: [
        { id: "上衣/甜美", group: "上衣", label: "甜美", kind: "file",
          rel: "上衣/甜美.txt", count: 3,
          items: ["浅粉蝴蝶结雪纺上衣", "奶油色泡泡袖蕾丝衫", "珍珠扣薄纱罩衫"],
          files: [{ name: "甜美.txt", rel: "上衣/甜美.txt", count: 3,
                    items: ["浅粉蝴蝶结雪纺上衣", "奶油色泡泡袖蕾丝衫", "珍珠扣薄纱罩衫"] }] },
        { id: "上衣/可爱", group: "上衣", label: "可爱", kind: "file",
          rel: "上衣/可爱.txt", count: 2,
          items: ["小熊刺绣连帽卫衣", "奶黄色娃娃领短袖"],
          files: [{ name: "可爱.txt", rel: "上衣/可爱.txt", count: 2,
                    items: ["小熊刺绣连帽卫衣", "奶黄色娃娃领短袖"] }] },
      ],
    },
    {
      id: "发型", label: "发型", count: 1,
      categories: [
        { id: "发型/发色", group: "发型", label: "发色", kind: "file",
          rel: "发型/发色.txt", count: 2,
          items: ["银灰色", "亚麻金"],
          files: [{ name: "发色.txt", rel: "发型/发色.txt", count: 2,
                    items: ["银灰色", "亚麻金"] }] },
      ],
    },
  ],
  total: 7,
};
LIBRARY.categories = LIBRARY.groups.flatMap(g => g.categories);

let extension = null;
const appStub = {
  registerExtension: info => { extension = info; },
  canvas: {},
  graph: { change() {} },
};
const apiStub = {
  fetchApi: async (url, options) => {
    apiCalls.push({ url: String(url), options });
    if (String(url).startsWith("/sinheo/library")) {
      return { ok: true, json: async () => LIBRARY, status: 200, statusText: "OK" };
    }
    if (String(url).startsWith("/sinheo/generate")) {
      generateCalls++;
      const body = JSON.parse(options?.body || "{}");
      return { ok: true, json: async () => ({
        text: body.random ? GENERATED : "齐耳短发, 浅粉蝴蝶结雪纺上衣",
        detail: "明细", empty: false,
      }), status: 200, statusText: "OK" };
    }
    if (String(url).startsWith("/sinheo/append")) {
      return { ok: true, json: async () => ({ added: 2, lines: 1, saved: [] }),
               status: 200, statusText: "OK" };
    }
    return { ok: true, json: async () => ({}), status: 200, statusText: "OK" };
  },
  apiURL: url => url,
};
const fetchStub = async (url, options) => {
  fetchCalls.push({ url, options });
  return { ok: true, status: 200, statusText: "OK", blob: async () => ({ size: 4321 }) };
};
class URLStub extends URL {
  static createObjectURL() { return "blob:sinheo-test"; }
  static revokeObjectURL() {}
}
class FormDataStub { constructor() { this.fields = {}; } append(k, v) { this.fields[k] = v; } }
const navigatorStub = { clipboard: { writeText: async text => { copiedText = text; } } };
const run = new Function(
  "app", "api", "document", "window", "navigator", "setTimeout", "clearTimeout",
  "URL", "FormData", "confirm", "console", "fetch",
  `${SOURCE}\nreturn { extension: null };`);

run(appStub, apiStub, documentStub, windowStub, navigatorStub,
    fn => fn(), () => {}, URLStub, FormDataStub, () => true, console, fetchStub);

if (!extension) throw new Error("扩展没有注册");
console.log("扩展注册 :", extension.name);

async function tick(n = 20) { for (let i = 0; i < n; i++) await Promise.resolve(); }

const nodeType = { prototype: {} };
await extension.beforeRegisterNodeDef(nodeType, { name: "SinheoLoadText" });
if (typeof nodeType.prototype.onNodeCreated !== "function") throw new Error("未挂上 onNodeCreated");

function findAll(el, className, out = []) {
  if (!el || typeof el !== "object") return out;
  if (String(el.className || "").split(/\s+/).includes(className)) out.push(el);
  for (const child of el.children || []) findAll(child, className, out);
  return out;
}

const node = {
  id: 1,
  size: [340, 470],
  widgets: [
    { name: "manual_text", value: "", hidden: false, options: {} },
    { name: "config", value: "{}", hidden: false, options: {} },
  ],
  graph: { change() {} },
  setDirtyCanvas() {},
  setSize(size) { this.size = size; },
  getWidgetOnPos() { return undefined; },
  addDOMWidget(name, type, element, options) {
    this.domRoot = element;
    this.domOptions = options;
    return { name, element, options };
  },
};
const manualWidget = node.widgets.find(w => w.name === "manual_text");
const configWidget = node.widgets.find(w => w.name === "config");
nodeType.prototype.onNodeCreated.call(node);
await tick();
console.log("节点创建 :", node.domRoot?.className, "尺寸", node.size.join("×"));
if (!node.domRoot) throw new Error("没有生成面板 DOM");

// ---- 底部一行四个按钮：＋ 添加到 / 选择小类 / 生成 / 复制（无常驻说明文字） ----
const preview = findAll(node.domRoot, "sh-preview")[0];
if (!preview || preview.tagName !== "TEXTAREA") throw new Error("预览区不是可编辑 textarea");
if (preview.readOnly) throw new Error("随机关闭时文本框不该只读");
if (manualWidget.hidden !== true) throw new Error("原生 manual_text widget 没有隐藏");
if (!preview.value.trim()) throw new Error("新节点没有自动填入初始提示词");
const foot = findAll(node.domRoot, "sh-foot")[0];
const footButtons = foot.children.filter(c => c.tagName === "BUTTON");
if (foot.children.length !== 4) {
  throw new Error(`底部应只有一行 4 个按钮，不应再有说明文字：${foot.children.length} 个子元素`);
}
const statusEl = findAll(node.domRoot, "sh-status")[0];
if (!statusEl || !statusEl.hidden) throw new Error("状态说明文字没有隐藏");
const [addBtn, addTargetBtn, genBtn, copyBtn] = footButtons;
if (footButtons.length !== 4 || !addBtn.textContent.includes("添加到")
    || !addTargetBtn.textContent.includes("选择小类")
    || genBtn.textContent !== "生成" || copyBtn.textContent !== "复制") {
  throw new Error(`底部按钮不对：${footButtons.map(b => b.textContent).join(" / ")}`);
}
if (footButtons.some(b => b._classes.has("sh-mini"))) {
  throw new Error("底部按钮不该再用 mini 尺寸");
}
console.log("底部按钮  :", footButtons.map(b => b.textContent).join(" / "), "（单行，无说明文字）");

preview.value = "我自己改的一句提示词";
preview.oninput();
await tick();
if (manualWidget.value !== "我自己改的一句提示词") throw new Error("手动编辑没有同步到 widget");
genBtn.onclick({ stopPropagation() {} });
await tick();
if (preview.value !== GENERATED) throw new Error("生成结果没有填进文本框");
copiedText = null;
copyBtn.onclick({ stopPropagation() {} });
await tick();
if (copiedText !== GENERATED) throw new Error("随机关闭时复制内容不对");
console.log("文本框    : 编辑 / 生成 / 复制 正常");

// ---- 随机开关：生成停用、复制仍可用且复制本次运行结果 ----
const savedText = manualWidget.value;
const randomRow = findAll(node.domRoot, "sh-random")[0];
randomRow.onclick({ stopPropagation() {} });
if (!preview.readOnly || !genBtn.disabled) throw new Error("随机开启未锁定文本框 / 生成");
if (copyBtn.disabled) throw new Error("随机模式下「复制」不该被停用");
node.onExecuted?.({ sinheo_text: ["这次随机抽到的词"], sinheo_detail: ["明细"] });
if (preview.value !== "这次随机抽到的词" || manualWidget.value !== savedText) {
  throw new Error("随机执行结果异常");
}
copiedText = null;
copyBtn.onclick({ stopPropagation() {} });
await tick();
if (copiedText !== "这次随机抽到的词") {
  throw new Error("随机模式下复制的不是本次运行产生的提示词");
}
console.log("随机模式  : 复制本次运行结果正常，生成仍停用");
randomRow.onclick({ stopPropagation() {} });
if (preview.value !== savedText || preview.readOnly) throw new Error("关掉随机后未恢复原文");
console.log("随机开关  : 锁定 / 显示结果 / 原文保留 正常");

// ---- 勾选菜单 ----
const trigger = findAll(node.domRoot, "sh-trigger")[0];
trigger.onclick({ stopPropagation() {} });
const pop = findAll(documentStub.body, "sh-pop")[0];
if (!pop) throw new Error("勾选菜单没有弹出");
const groupRows = findAll(pop, "sh-group-head");
if (groupRows.length !== LIBRARY.groups.length) throw new Error("大类渲染数量不对");
if (findAll(pop, "sh-cat").length !== LIBRARY.categories.length) throw new Error("小类渲染数量不对");
if (findAll(pop, "sh-mode-row").length) throw new Error("输入（手动）行没有移除");

const tools = findAll(pop, "sh-pop-tools")[0];
const toolButtons = tools.children.filter(c => c.tagName === "BUTTON");
if (toolButtons.some(b => String(b.textContent).includes("随机勾选"))) {
  throw new Error("「🎲 随机勾选」按钮没有移除");
}
toolButtons[1].onclick({ stopPropagation() {} });   // 全不选

// 展开词条：不应再有「全部拼接」下拉，改为每类只出 1 条的静态提示
findAll(pop, "sh-cat-name")[0]?.onclick({ stopPropagation() {} });
const itemsPanel = findAll(pop, "sh-items")[0];
if (!itemsPanel) throw new Error("小类没有展开词条");
if (findAll(itemsPanel, "sh-items-rule").length !== 1) throw new Error("缺少「每类只出 1 条」提示");
if (findAll(itemsPanel, "sh-items-bar")[0].children.some(el => el.tagName === "SELECT")) {
  throw new Error("「全部拼接」下拉没有移除");
}
const itemBox = findAll(itemsPanel, "sh-item")[0]?.children?.[0];
itemBox.checked = true;
itemBox.onchange?.({ stopPropagation() {} });
if (!Object.values(JSON.parse(configWidget.value).cats).some(c => c.picks?.length)) {
  throw new Error("词条勾选没有写进配置");
}
console.log("勾选菜单  : 已移除随机勾选 / 全部拼接，词条勾选正常");

// ---- 循环排序：顶部大类按 ▲ 到底部，再按 ▼ 回到顶部 ----
const firstGroupId = LIBRARY.order.groups[0];
function groupMoveButtons() {
  const head = findAll(pop, "sh-group-head")[0];
  const buttons = head.children.filter(c => c.tagName === "BUTTON");
  return { up: buttons[2], down: buttons[3] };       // caret / 🎲 / ▲ / ▼
}
groupMoveButtons().up.onclick({ stopPropagation() {} });
let order = JSON.parse(configWidget.value).order;
if (order[order.length - 1] !== firstGroupId) {
  throw new Error(`顶部大类按 ▲ 没有绕到底部：${order.join(" > ")}`);
}
groupMoveButtons().down.onclick({ stopPropagation() {} });
order = JSON.parse(configWidget.value).order;
if (order[0] !== firstGroupId) {
  throw new Error(`底部大类按 ▼ 没有绕回顶部：${order.join(" > ")}`);
}
console.log("循环排序  : 顶部 ▲ → 底部、底部 ▼ → 顶部 正常");

const filterInput = findAll(pop, "sh-filter")[0];
filterInput.value = "甜";
filterInput.oninput?.({ stopPropagation() {} });
filterInput.value = "";
filterInput.oninput?.({ stopPropagation() {} });

// ---- 「＋ 添加到」：目标小类勾选弹窗 ----
addBtn.onclick({ stopPropagation() {} });           // 还没有目标 -> 自动弹窗
await tick();
const addDialog = findAll(documentStub.body, "sh-add")[0];
if (!addDialog || addDialog.hidden) throw new Error("「添加到」弹窗没有打开");
const addRows = findAll(addDialog, "sh-exp-row");
if (addRows.length !== LIBRARY.groups.length + LIBRARY.categories.length) {
  throw new Error(`添加到列表行数不对：${addRows.length}`);
}
if (findAll(addDialog, "sh-add-preview")[0]?.textContent.includes("将添加") !== true) {
  throw new Error("添加弹窗没有显示待添加内容预览");
}
const addFoot = findAll(addDialog, "sh-export-foot")[0].children.filter(c => c.tagName === "BUTTON");
const applyBtn = addFoot.find(b => String(b.textContent).includes("添加到选中"));
if (!applyBtn || !applyBtn.disabled) throw new Error("未勾选目标时「添加到选中」应禁用");
const firstAddBox = addRows.find(r => !String(r.className).includes("sh-exp-group-row")).children[0];
firstAddBox.checked = true;
firstAddBox.onchange();
applyBtn.onclick({ stopPropagation() {} });
await tick();
const appendCall = apiCalls.find(c => c.url === "/sinheo/append");
if (!appendCall || appendCall.options?.method !== "POST") {
  throw new Error("没有调用 /sinheo/append");
}
const appendBody = JSON.parse(appendCall.options.body);
if (!appendBody.rels.includes("上衣/甜美.txt") || appendBody.text !== GENERATED) {
  throw new Error(`追加请求内容不对：${JSON.stringify(appendBody)}`);
}
if (!String(addTargetBtn.textContent).includes("已选 1 类")) {
  throw new Error("确定后目标按钮没有显示已选数量");
}
if (!addDialog.hidden) throw new Error("添加完成后弹窗没有关闭");
console.log("＋ 添加到 : 弹窗勾选 → POST /sinheo/append → 记住 1 个目标小类");

// 右边的「选择小类」也能打开同一个弹窗
addTargetBtn.onclick({ stopPropagation() {} });
await tick();
if (addDialog.hidden) throw new Error("「选择小类」按钮打不开弹窗");
const addClose = findAll(addDialog, "sh-export-head")[0].children.find(c => c.tagName === "BUTTON");
addClose.onclick({ stopPropagation() {} });
if (!addDialog.hidden) throw new Error("添加弹窗关闭按钮无效");

// ---- 词库管理弹窗：关闭按钮 / 导入下拉 / 两级编辑 ----
const barMain = findAll(node.domRoot, "sh-bar-main")[0];
barMain.onclick({ stopPropagation() {} });
await tick();
const manager = findAll(documentStub.body, "sh-mgr")[0];
if (!manager || manager.hidden) throw new Error("管理弹窗没有打开");
const closeBtn = findAll(manager, "sh-mgr-head")[0].children.find(c => c.tagName === "BUTTON");
if (!closeBtn || !String(closeBtn.textContent).includes("关闭")) throw new Error("找不到关闭按钮");
closeBtn.onclick({ stopPropagation() {} });
if (!manager.hidden || manager.style.display !== "none") {
  throw new Error("BUG：点关闭按钮后弹窗仍然可见");
}
console.log("关闭按钮  : hidden=true 且 display=none，弹窗已关闭");

barMain.onclick({ stopPropagation() {} });
await tick();
if (manager.hidden) throw new Error("管理弹窗无法重新打开");
const selects = findAll(manager, "sh-select");
if (selects.length !== 2) throw new Error(`应有 2 个下拉（小类大类 / 导入到大类），实际 ${selects.length}`);
const importSelect = selects[1];
const optionValues = importSelect.children.map(o => o.value);
if (!optionValues.includes("未分组") || !optionValues.includes("__new__")
    || !optionValues.includes("上衣")) {
  throw new Error(`导入下拉选项不对：${optionValues.join(" / ")}`);
}
console.log("导入下拉  :", optionValues.join(" / "));

const treeRows = findAll(manager, "sh-tree-row");
if (!treeRows.length) throw new Error("管理弹窗树为空");
const catTreeRow = treeRows.find(row => !String(row.className).includes("sh-group-row"));
catTreeRow?.onclick?.({ stopPropagation() {} });
const editorArea = findAll(manager, "sh-textarea")[0];
if (!editorArea?.value.trim()) throw new Error("选中类目后编辑区为空");
if (findAll(manager, "sh-file-chip").length) throw new Error("仍在显示多 TXT 文件 chips");
const allManagerButtons = [];
for (const row of findAll(manager, "sh-mgr-create")) {
  for (const btn of row.children.filter(c => c.tagName === "BUTTON")) allManagerButtons.push(btn.textContent);
}
if (allManagerButtons.some(t => String(t).includes("＋ TXT"))) throw new Error("「＋ TXT」按钮没有移除");
if (!allManagerButtons.some(t => String(t).includes("删除小类"))) throw new Error("缺少删除小类按钮");
const managerFootButtons = findAll(manager, "sh-mgr-foot")[0].children.filter(c => c.tagName === "BUTTON");
if (managerFootButtons.some(b => String(b.textContent).includes("随机勾选"))) {
  throw new Error("管理弹窗里的「🎲 随机勾选」没有移除");
}
console.log("两级管理  : 一个小类一个 TXT，无 chips / 无 ＋TXT / 无随机勾选");

// ---- 导出勾选弹窗 ----
const exportBtn = managerFootButtons.find(b => String(b.textContent).includes("导出 ZIP"));
if (!exportBtn) throw new Error("找不到导出按钮");
exportBtn.onclick({ stopPropagation() {} });
await tick();
const exportDialog = findAll(documentStub.body, "sh-export")
  .find(el => !String(el.className).includes("sh-add"));
if (!exportDialog || exportDialog.hidden) throw new Error("导出勾选弹窗没有打开");
const expRows = findAll(exportDialog, "sh-exp-row");
if (expRows.length !== LIBRARY.groups.length + LIBRARY.categories.length) {
  throw new Error(`导出列表行数不对：${expRows.length}`);
}
const downloadBtn = findAll(exportDialog, "sh-export-foot")[0].children
  .filter(c => c.tagName === "BUTTON").find(b => String(b.textContent).includes("下载 ZIP"));
if (!downloadBtn || downloadBtn.disabled) throw new Error("下载按钮不可用");
const firstCatBox = expRows
  .find(r => !String(r.className).includes("sh-exp-group-row")).children[0];
firstCatBox.checked = false;
firstCatBox.onchange();
const beforeFetch = fetchCalls.length;
downloadBtn.onclick({ stopPropagation() {} });
await tick();
if (fetchCalls.length <= beforeFetch) throw new Error("下载没有调用原生 fetch");
const lastCall = fetchCalls[fetchCalls.length - 1];
if (String(lastCall.url) !== "/sinheo/export" || lastCall.options?.method !== "POST") {
  throw new Error(`导出请求不对：${lastCall.url} ${lastCall.options?.method}`);
}
const selection = JSON.parse(lastCall.options.body).selection;
if (!Array.isArray(selection) || selection.length !== LIBRARY.categories.length - 1) {
  throw new Error(`导出勾选没有生效：${JSON.stringify(selection)}`);
}
console.log(`导出弹窗  : 默认全选，取消 1 个后 POST selection=${selection.length} 个小类`);
const exportClose = findAll(exportDialog, "sh-export-head")[0].children
  .find(c => c.tagName === "BUTTON");
exportClose.onclick({ stopPropagation() {} });
if (!exportDialog.hidden || exportDialog.style.display !== "none") {
  throw new Error("导出弹窗关闭按钮无效");
}
// Esc 也能关闭管理弹窗
for (const handler of docListeners["keydown"] || []) {
  handler({ key: "Escape", stopPropagation() {} });
}
if (!manager.hidden) throw new Error("Esc 没有关闭管理弹窗");
console.log("弹窗关闭  : 导出弹窗 ✕ / Esc 关闭管理弹窗 正常");

console.log("\n前端冒烟测试通过 ✓");
