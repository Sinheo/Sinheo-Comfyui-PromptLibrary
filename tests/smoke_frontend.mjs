/*
 * 前端冒烟测试：用极简 DOM 模拟真实执行一遍 sinheo.js 的主要代码路径。
 * 覆盖：节点创建 / 文本框编辑 / 生成 / 复制（含随机模式）/ 随机开关 / 勾选菜单 /
 *       循环排序 / 关闭按钮 / 导入下拉 / 导出勾选弹窗 / 「＋ 添加到图库」弹窗 /
 *       两级词库管理 / 类型数据源选项卡 / 图库导入导出 / 已移除标题与显示标题开关。
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
  replaceWith(item) {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index < 0) return;
    item.parent = this.parent;
    this.parent.children[index] = item;
  }
  contains(el) { if (el === this) return true; return this.children.some(c => c.contains?.(el)); }
  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() { return { left: 100, top: 100, right: 440, bottom: 128, width: 340, height: 28 }; }
  querySelector() { return null; }
  setAttribute() {}
  click() { clickedElements.push(this); this.onclick?.({ stopPropagation() {}, target: this }); }
  focus() { focusedElements.push(this); }
  select() {}
}

/** 浏览器 canvas 缩略图链路的最小桩：解码成 2048x1024，toBlob 产出 512px JPEG。 */
class CanvasEl extends El {
  constructor(tag) { super(tag); this.width = 0; this.height = 0; this.toBlobCalls = []; }
  getContext() { return { fillRect() {}, drawImage() {} }; }
  toBlob(callback, type, quality) {
    this.toBlobCalls.push({ type, quality });
    callback({ size: 12345, type: type || "image/jpeg" });
  }
}
class ImageStub {
  constructor() { this.naturalWidth = 2048; this.naturalHeight = 1024; this._src = ""; }
  set src(value) { this._src = value; this.onload?.(); }  // 同步触发，避免真实定时器
  get src() { return this._src; }
}

const docListeners = {};
const documentStub = {
  createElement: tag => (tag === "canvas" ? new CanvasEl(tag) : new El(tag)),
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
let pickerMode = "available";   // available / unsupported / cancel / denied
let savePathAnswer = "D:\\ComfyUI备份\\";
const pickerCalls = [];         // showSaveFilePicker 的调用参数
const savedWrites = [];         // 写进用户所选文件的内容
const exportToCalls = [];
const windowStub = { innerWidth: 1600, innerHeight: 1000, isSecureContext: true,
                     prompt: message => {
                       const text = String(message || "");
                       if (text.includes("保存位置")) return savePathAnswer;
                       if (text.includes("新分类")) return "测试分类";
                       if (text.includes("新分组")) return "测试分组";
                       if (text.includes("分类新名称")) return "改名分类";
                       if (text.includes("分组新名称")) return "改名分组";
                       return "新导入大类";
                     } };
// 用 getter 模拟「浏览器不支持 File System Access API」：属性消失而不是抛错
Object.defineProperty(windowStub, "showSaveFilePicker", {
  configurable: true,
  get() {
    if (pickerMode === "unsupported") return undefined;
    return async options => {
      pickerCalls.push(options);
      if (pickerMode === "cancel") {
        const error = new Error("user cancelled");
        error.name = "AbortError";
        throw error;
      }
      if (pickerMode === "denied") throw new Error("blocked by iframe");
      return {
        name: "用户选择的图库.zip",
        createWritable: async () => ({
          write: async blob => { savedWrites.push({ blob, suggested: options?.suggestedName }); },
          close: async () => {},
        }),
      };
    };
  },
});
const GENERATED = "浅粉蝴蝶结雪纺上衣, 银灰色";
let copiedText = null;
let generateCalls = 0;
const fetchCalls = [];
const apiCalls = [];
const clickedElements = [];   // 记录 <a>.click()，用于验证导出下载通道
const focusedElements = [];   // 记录 focus()
// localStorage 桩：验证「记住上次导出目录」
const storageData = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true, writable: true,
  value: {
    getItem: key => (storageData.has(key) ? storageData.get(key) : null),
    setItem: (key, value) => storageData.set(key, String(value)),
    removeItem: key => storageData.delete(key),
  },
});
const EXPORT_INFO = {
  filename: "Sinheo_gallery_20261115-184021.zip",
  path: "F:\\AI\\ComfyUI-all\\ComfyUI\\output\\Sinheo\\exports\\Sinheo_gallery_20261115-184021.zip",
  size: 106276,
  download: "/sinheo/gallery/download?name=Sinheo_gallery_20261115-184021.zip",
  view: "/view?filename=Sinheo_gallery_20261115-184021.zip&subfolder=Sinheo%2Fexports&type=output",
};
let emptyApiBlob = false;     // 模拟 fetchApi 读到 0 字节，走浏览器直链兜底
let noBackendImage = false;   // 模拟 ComfyUI 未重启：/sinheo/gallery/latest_image 仍是 404
let onlyHistoryImage = false; // 模拟前端拿不到输出，只有 /history 里那张图能取到
let noExportBlob = false;     // 旧后端：/sinheo/gallery/export_blob 还是 404
let noExportTo = false;       // 旧后端：/sinheo/gallery/export_to 还是 404
let blockAllView = false;     // 模拟 ComfyUI 自带 /view 全部不可用
const INPUT_IMAGE = "LOAD_IMAGE_input_00001.png";   // 加载图像节点的输入原图
const HISTORY_IMAGE = "HISTORY_00001_.png";
const HISTORY = {
  "p1": { outputs: { "9": { images: [
    { filename: HISTORY_IMAGE, subfolder: "", type: "output" },
  ] } } },
};

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

let GALLERY_DATA = {
  version: 1,
  categories: [
    { id: "cat_cloth", name: "服饰", groups: [
      { id: "grp_daily", name: "日常" }, { id: "grp_party", name: "晚宴" },
    ] },
    { id: "cat_style", name: "风格", groups: [{ id: "grp_soft", name: "清新" }] },
  ],
  cards: [
    { id: "card_a", categoryId: "cat_cloth", groupId: "grp_daily",
      title: "学院风套装", prompt: "米白色针织开衫, 格纹百褶裙",
      image: "images/abc.png", favorite: false },
    { id: "card_b", categoryId: "cat_cloth", groupId: "grp_party",
      title: "晚礼服", prompt: "酒红色丝绒长裙, 钻石耳环", image: "", favorite: true },
    { id: "card_c", categoryId: "cat_style", groupId: "grp_soft",
      title: "柔光", prompt: "柔和自然光, 浅景深", image: "", favorite: false },
  ],
  settings: {},
};
// 故意保留旧版 title 字段：验证前端不再渲染标题、后端也会丢弃它

let extension = null;
const appStub = {
  registerExtension: info => { extension = info; },
  canvas: {},
  graph: { change() {} },
  // 模拟上一次工作流生成的图片输出，供「＋ 添加到图库」自动抓图
  nodeOutputs: {
    "9": { images: [{ filename: "ComfyUI_00001_.png", subfolder: "", type: "output" }] },
  },
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
    if (String(url).startsWith("/sinheo/gallery/save")) {
      GALLERY_DATA = JSON.parse(options?.body || "{}");
      return { ok: true, json: async () => GALLERY_DATA, status: 200, statusText: "OK" };
    }
    if (String(url).startsWith("/sinheo/gallery/image")) {
      return { ok: true, json: async () => ({ file: "images/generated.png" }),
               status: 200, statusText: "OK" };
    }
    if (String(url).startsWith("/sinheo/gallery/import")) {
      return { ok: true, json: async () => ({ mode: "merge", cards: 3,
               categories: 2, images: 1, backup: "", total: 3 }),
               status: 200, statusText: "OK" };
    }
    if (String(url).startsWith("/sinheo/gallery/export_dir")) {
      return { ok: true, json: async () => ({
        dir: "F:\\AI\\ComfyUI-all\\ComfyUI\\output\\Sinheo\\exports",
        filename: "Sinheo_gallery_20261115-204622.zip",
      }), status: 200, statusText: "OK" };
    }
    if (String(url).startsWith("/sinheo/gallery/export_blob")) {
      if (noExportBlob) {
        return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
      }
      return { ok: true, status: 200, statusText: "OK",
               json: async () => ({}),
               blob: async () => ({ size: emptyApiBlob ? 0 : EXPORT_INFO.size }) };
    }
    if (String(url).startsWith("/sinheo/gallery/export_to")) {
      exportToCalls.push(JSON.parse(options?.body || "{}"));
      if (noExportTo) {
        return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
      }
      return { ok: true, status: 200, statusText: "OK",
               json: async () => ({ ok: true, path: "D:\\ComfyUI备份\\图库.zip",
                                   filename: "图库.zip", size: EXPORT_INFO.size }) };
    }
    if (String(url).startsWith("/sinheo/gallery/export_info")) {
      return { ok: true, json: async () => EXPORT_INFO, status: 200, statusText: "OK" };
    }
    if (String(url).startsWith("/sinheo/gallery/download")) {
      return { ok: true, status: 200, statusText: "OK",
               json: async () => ({}),
               blob: async () => ({ size: emptyApiBlob ? 0 : EXPORT_INFO.size }) };
    }
    if (String(url).startsWith("/sinheo/gallery/latest_image")) {
      if (noBackendImage) {
        return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
      }
      return { ok: true, status: 200, statusText: "OK",
               headers: { get: () => "LATEST_00001_.png" },
               json: async () => ({}), blob: async () => ({ size: 8192 }) };
    }
    if (String(url).startsWith("/history")) {
      return { ok: true, status: 200, statusText: "OK", json: async () => HISTORY };
    }
    if (String(url).startsWith("/sinheo/gallery")) {
      return { ok: true, json: async () => GALLERY_DATA, status: 200, statusText: "OK" };
    }
    if (String(url).startsWith("/sinheo/rename")) {
      return { ok: true, json: async () => {
        const body = JSON.parse(options?.body || "{}");
        return { kind: String(body.rel).includes("/") ? "category" : "group",
                 old: body.rel, new: body.name, rel: body.name };
      }, status: 200, statusText: "OK" };
    }
    if (String(url).startsWith("/sinheo/delete_batch")) {
      const body = JSON.parse(options?.body || "{}");
      return { ok: true, json: async () => ({ deleted: body.rels || [], missing: [], backup: ".backup/x" }),
               status: 200, statusText: "OK" };
    }
    return { ok: true, json: async () => ({}), status: 200, statusText: "OK" };
  },
  apiURL: url => url,
  fileURL: url => url,
};
let emptyFetchBlob = false;   // 模拟浏览器 fetch 拿到 0 字节响应的情况
const fetchStub = async (url, options) => {
  fetchCalls.push({ url, options });
  const target = String(url);
  const blocked = (noBackendImage && target.startsWith("/sinheo/gallery/latest_image"))
    || (blockAllView && target.startsWith("/view?"))
    || (onlyHistoryImage && target.startsWith("/view?") && !target.includes(HISTORY_IMAGE));
  return {
    ok: !blocked, status: blocked ? 404 : 200,
    statusText: blocked ? "Not Found" : "OK",
    blob: async () => ({ size: blocked || emptyFetchBlob ? 0 : 4321 }),
  };
};
class URLStub extends URL {
  static createObjectURL() { return "blob:sinheo-test"; }
  static revokeObjectURL() {}
}
class FormDataStub {
  constructor() { this.fields = {}; this.filenames = {}; }
  append(k, v, name) {
    this.fields[k] = v;
    if (name !== undefined) this.filenames[k] = String(name);
  }
}
const navigatorStub = { clipboard: { writeText: async text => { copiedText = text; } } };
const run = new Function(
  "app", "api", "document", "window", "navigator", "setTimeout", "clearTimeout",
  "URL", "FormData", "confirm", "console", "fetch", "Image",
  `${SOURCE}\nreturn { extension: null };`);

run(appStub, apiStub, documentStub, windowStub, navigatorStub,
    fn => fn(), () => {}, URLStub, FormDataStub, () => true, console, fetchStub, ImageStub);

if (!extension) throw new Error("扩展没有注册");
console.log("扩展注册 :", extension.name);

async function tick(n = 20) { for (let i = 0; i < n; i++) await Promise.resolve(); }

const nodeType = { prototype: {} };
await extension.beforeRegisterNodeDef(nodeType, {
  name: "SinheoLoadText",
  // 模拟重启后 ComfyUI 的 object_info：后端已声明可选的 external_text
  input: { optional: { external_text: ["STRING", { forceInput: true }] } },
});
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
  inputs: [],
  addInput(name, type) { this.inputs.push({ name, type, link: null }); },
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
if (!node.inputs.some(slot => slot.name === "external_text" && slot.type === "STRING")) {
  throw new Error("节点没有补上 external_text STRING 输入插槽");
}
// 界面不再显示「N 个小类 / M 条 / N 张卡片」这类数量统计
const barText = String(findAll(node.domRoot, "sh-bar-main")[0]?.textContent || "");
if (barText !== "⚙ 词库管理") {
  throw new Error(`词库管理按钮仍在显示数量统计：${barText}`);
}
const valueText = String(findAll(node.domRoot, "sh-row-value")[0]?.textContent || "");
if (/\d+\s*(个小类|条|张)/.test(valueText)) {
  throw new Error(`模式标签仍在显示数量统计：${valueText}`);
}

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
if (footButtons.length !== 4 || !addBtn.textContent.includes("添加到图库")
    || !addTargetBtn.textContent.includes("目标分类")
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

// 词库菜单只显示「大类 / 小类」两级：小类整组右移，不再展开具体提示词
const catRows = findAll(pop, "sh-cat");
if (findAll(pop, "sh-cats").length !== LIBRARY.groups.length) {
  throw new Error("小类没有被装进右移的层级容器");
}
if (findAll(pop, "sh-items").length || findAll(pop, "sh-item").length
    || findAll(pop, "sh-items-rule").length || findAll(pop, "sh-item-list").length) {
  throw new Error("词库菜单仍在展示小类内的具体提示词");
}
if (catRows[0].children.some(c => String(c.className).includes("sh-caret-btn"))) {
  throw new Error("小类行仍带展开三角");
}
// 点小类名称 = 勾选 / 取消，且不会冒出第三级词条面板
const firstName = findAll(pop, "sh-cat-name")[0];
// 菜单按自然顺序排，第一行不一定对应 LIBRARY 里的第一条：从行 title 里取真实 cat id
const clickedId = String(firstName.title).split(" · ")[0];
const beforeOn = JSON.parse(configWidget.value).cats?.[clickedId]?.on;
firstName.onclick({ stopPropagation() {} });
if (JSON.parse(configWidget.value).cats?.[clickedId]?.on === beforeOn) {
  throw new Error("点小类名称没有切换勾选状态");
}
if (findAll(pop, "sh-items").length || findAll(pop, "sh-item").length) {
  throw new Error("点小类名称后又展开了提示词面板");
}
if (Object.values(JSON.parse(configWidget.value).cats).some(c => "picks" in c || "mode" in c)) {
  throw new Error("配置里仍写入了词条级 picks / mode");
}
console.log("两级菜单  : 大类 + 小类（右移层级容器），无词条展开 / 无随机勾选 / 无全部拼接");

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

// ---- 类型菜单：词库 / 图库 数据源选项卡 ----
const sourceTabs = findAll(pop, "sh-source-tabs")[0];
if (!sourceTabs || sourceTabs.children.length !== 2) {
  throw new Error("类型菜单缺少数据源选项卡");
}
const [libraryTab, galleryTab] = sourceTabs.children;
if (!String(libraryTab.textContent).includes("词库")
    || !String(galleryTab.textContent).includes("图库")) {
  throw new Error("数据源选项卡文案不对");
}
galleryTab.onclick({ stopPropagation() {} });
if (JSON.parse(configWidget.value).source !== "gallery") {
  throw new Error("切到图库后没有写入 config.source");
}
if (findAll(pop, "sh-gallery-pop-cat").length !== GALLERY_DATA.categories.length) {
  throw new Error("图库数据源没有列出所有分类");
}
if (!findAll(pop, "sh-gallery-pop-fav").length) {
  throw new Error("图库数据源缺少「只从收藏里随机」开关");
}
const sourceCatRow = findAll(pop, "sh-gallery-pop-cat")[0].children
  .find(c => String(c.className).includes("sh-gallery-pop-row"));
const sourceCatBox = sourceCatRow.children[0];
sourceCatBox.checked = true;
sourceCatBox.onchange();
if (!JSON.parse(configWidget.value).galleryCats.includes("cat_cloth")) {
  throw new Error("图库分类勾选没有写进配置");
}
libraryTab.onclick({ stopPropagation() {} });
if (JSON.parse(configWidget.value).source !== "library"
    || findAll(pop, "sh-group-head").length !== LIBRARY.groups.length) {
  throw new Error("切回词库数据源失败");
}
console.log("数据源    : 词库 / 图库选项卡切换，图库分类/分组/收藏范围写入 config");

// 回归：真实浏览器里 element.children 是 HTMLCollection，没有 forEach。
// 之前 tabs.children.forEach(...) 会抛 TypeError 并中断整个 renderPopup，
// 表现为「类型」菜单里词库列表一片空白（mock 的 children 是数组时不会暴露）。
const realTabChildren = sourceTabs.children;
const htmlCollectionLike = {
  0: libraryTab, 1: galleryTab, length: 2,
  [Symbol.iterator]: function* () { yield libraryTab; yield galleryTab; },
};
sourceTabs.children = htmlCollectionLike;
galleryTab.onclick({ stopPropagation() {} });
libraryTab.onclick({ stopPropagation() {} });
const groupHeads = findAll(pop, "sh-group-head").length;
sourceTabs.children = realTabChildren;
if (groupHeads !== LIBRARY.groups.length) {
  throw new Error("HTMLCollection 环境下类型菜单的词库列表没有渲染");
}
console.log("DOM 兼容  : children 无 forEach 时词库列表仍完整渲染");

// ---- 「＋ 添加到图库」：自动抓图 + 当前提示词 + 选分类/分组 ----
addBtn.onclick({ stopPropagation() {} });           // 还没设默认目标 -> 打开弹窗
await tick();
const addDialog = findAll(documentStub.body, "sh-add")[0];
if (!addDialog || addDialog.hidden) throw new Error("「添加到图库」弹窗没有打开");
if (!findAll(addDialog, "sh-export-head")[0].children
    .some(c => String(c.textContent).includes("添加到图库"))) {
  throw new Error("添加弹窗标题没有改成图库");
}
if (!findAll(addDialog, "sh-add-image-preview").length
    || !findAll(addDialog, "sh-add-prompt").length
    || !findAll(addDialog, "sh-add-target-row").length) {
  throw new Error("添加弹窗缺少图片预览 / 提示词 / 分类分组");
}
const addPrompt = findAll(addDialog, "sh-add-prompt")[0];
if (addPrompt.value !== GENERATED) throw new Error("添加弹窗没有带入当前提示词");
if (!apiCalls.some(c => c.url.startsWith("/history"))) {
  throw new Error("添加弹窗自动抓图没有读服务端 /history 的真实生成输出");
}
if (!findAll(addDialog, "sh-add-image-preview")[0].children.some(c => c.tagName === "IMG")) {
  throw new Error("抓到生成图后没有在弹窗里显示预览");
}
if (String(findAll(addDialog, "sh-exp-info")[0].textContent).trim()) {
  throw new Error("添加弹窗底部还在显示分类 / 卡片数量统计");
}
const addCatSelect = findAll(addDialog, "sh-add-target-row")[0].children
  .filter(c => c.tagName === "SELECT")[0];
if (addCatSelect.children.length !== GALLERY_DATA.categories.length) {
  throw new Error("添加弹窗的分类下拉数量不对");
}
addCatSelect.value = "cat_style";                 // 存到「风格」，不影响后面「服饰」计数
addCatSelect.onchange();
const addFootButtons = findAll(addDialog, "sh-export-foot")[0].children
  .filter(c => c.tagName === "BUTTON");
const rememberBtn = addFootButtons.find(b => String(b.textContent).includes("只记住目标"));
if (!rememberBtn) throw new Error("缺少「只记住目标」按钮");
rememberBtn.onclick({ stopPropagation() {} });
if (!String(addTargetBtn.textContent).includes("目标已设")) {
  throw new Error("记住目标后按钮文案没有更新");
}
if (addDialog.hidden) throw new Error("切换「只记住目标」不该关闭弹窗，要能再点一次取消");
const rememberedTarget = JSON.parse(storageData.get("sinheo_gallery_add_target") || "null");
if (!rememberedTarget || rememberedTarget.categoryId !== "cat_style") {
  throw new Error("记住的目标没有写进 localStorage（刷新页面会丢）");
}
if (!String(rememberBtn.textContent).includes("✓")) {
  throw new Error("开关开启后按钮没有显示勾选状态");
}
console.log("添加弹窗  : 自动抓图 + 带入提示词 + 选分类分组 + 记住目标（可再点取消）");

// ---- 「↻ 抓取最近生成图」：只认生成图，绝不抓「加载图像」的输入原图 ----
const grabBtn = findAll(addDialog, "sh-add-image-tools")[0].children
  .find(c => c.tagName === "BUTTON" && String(c.textContent).includes("抓取"));
if (!grabBtn) throw new Error("找不到「抓取最近生成图」按钮");

// 1) 画布上有 LoadImage 节点 + nodeOutputs 里同时有 input / output，
//    必须把 input 原图完全排除，且优先读服务端 /history 的真实执行输出。
appStub.nodeOutputs = {
  "3": { images: [{ filename: INPUT_IMAGE, subfolder: "", type: "input" }] },
  "9": { images: [{ filename: "ComfyUI_00001_.png", subfolder: "", type: "output" }] },
};
appStub.graph._nodes = [
  { type: "LoadImage", imgs: [
    { src: `/view?filename=${INPUT_IMAGE}&subfolder=&type=input` },
  ] },
];
noBackendImage = true;
fetchCalls.length = 0;
apiCalls.length = 0;
grabBtn.onclick({ stopPropagation() {} });
await tick(80);
const allGrabURLs = [...apiCalls.map(c => c.url), ...fetchCalls.map(c => String(c.url))];
if (allGrabURLs.some(url => url.includes(INPUT_IMAGE))) {
  throw new Error("抓图把「加载图像」的 input 原图当成生成图了");
}
if (!apiCalls.some(c => c.url.startsWith("/history"))) {
  throw new Error("抓图没有优先读服务端 /history 的真实执行输出");
}
if (!fetchCalls.some(c => String(c.url).startsWith("/view?"))) {
  throw new Error("没有回退到 ComfyUI 自带 /view");
}
if (String(findAll(addDialog, "sh-exp-msg")[0].textContent).includes("失败")) {
  throw new Error("过滤掉 input 图后仍然报抓取失败");
}
console.log("抓图过滤  : /history 优先，LoadImage 的 input 原图被完全排除");

// 2) 前端没有输出记录（刚刷新页面）：只靠服务端 /history 也应抓到图
appStub.nodeOutputs = {};
appStub.graph._nodes = [];
onlyHistoryImage = true;
fetchCalls.length = 0;
apiCalls.length = 0;
grabBtn.onclick({ stopPropagation() {} });
await tick(80);
if (!apiCalls.some(c => c.url.startsWith("/history"))) {
  throw new Error("app.nodeOutputs 为空时没有读 /history");
}
if (!fetchCalls.some(c => String(c.url).includes(HISTORY_IMAGE))) {
  throw new Error("/history 里的生成图没有被抓取");
}
console.log("抓图兜底  : /history 输出可用，无 nodeOutputs 也能抓到图");

// 3) /view 全挂时，后端磁盘兜底仍要拿到生成图（参数里不能有 input 图）
onlyHistoryImage = false;
noBackendImage = false;
blockAllView = true;
fetchCalls.length = 0;
apiCalls.length = 0;
grabBtn.onclick({ stopPropagation() {} });
await tick(80);
const diskCall = apiCalls.find(c => c.url.startsWith("/sinheo/gallery/latest_image"));
if (!diskCall) throw new Error("所有 /view 失败时没有走后端磁盘兜底");
if (diskCall.url.includes(INPUT_IMAGE) || diskCall.url.includes("type=input")) {
  throw new Error("磁盘兜底的参数里混进了 input 加载图");
}
if (String(findAll(addDialog, "sh-exp-msg")[0].textContent).includes("失败")) {
  throw new Error("后端磁盘兜底仍然报抓取失败");
}
blockAllView = false;
appStub.nodeOutputs = {
  "9": { images: [{ filename: "ComfyUI_00001_.png", subfolder: "", type: "output" }] },
};
console.log("磁盘兜底  : /view 全挂 → /sinheo/gallery/latest_image 命中生成图");

// 「🎯 目标分类」也能打开同一个弹窗
addTargetBtn.onclick({ stopPropagation() {} });
await tick();
if (addDialog.hidden) throw new Error("「目标分类」按钮打不开弹窗");
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
if (!allManagerButtons.some(t => String(t).includes("批量删除"))) throw new Error("缺少批量删除按钮");
const managerFootButtons = findAll(manager, "sh-mgr-foot")[0].children.filter(c => c.tagName === "BUTTON");
if (managerFootButtons.some(b => String(b.textContent).includes("随机勾选"))) {
  throw new Error("管理弹窗里的「🎲 随机勾选」没有移除");
}

// 每一行（大类 + 小类）都要有重命名入口
const treeButtons = findAll(manager, "sh-tree-row")
  .flatMap(row => row.children.filter(c => c.tagName === "BUTTON"));
const renameButtons = treeButtons.filter(b => String(b.textContent) === "✎");
if (renameButtons.length !== LIBRARY.groups.length + LIBRARY.categories.length) {
  throw new Error(`重命名按钮数量不对：${renameButtons.length}`);
}

// 全选 -> 批量删除按钮计数 -> POST /sinheo/delete_batch
const bulkBar = findAll(manager, "sh-mgr-bulk")[0];
if (!bulkBar) throw new Error("缺少批量勾选工具条");
const bulkAllBox = bulkBar.children.find(c => c.tagName === "INPUT");
if (!bulkAllBox) throw new Error("缺少全选勾选框");
bulkAllBox.checked = true;
bulkAllBox.onchange();
const editorButtons = findAll(manager, "sh-mgr-create")
  .flatMap(row => row.children.filter(c => c.tagName === "BUTTON"));
const batchBtn = editorButtons.find(b => String(b.textContent).includes("批量删除"));
const expectRels = LIBRARY.groups.length + LIBRARY.categories.length;
if (!batchBtn || batchBtn.disabled || !String(batchBtn.textContent).includes(`（${expectRels}）`)) {
  throw new Error(`全选后批量删除按钮状态不对：${batchBtn?.textContent}`);
}
batchBtn.onclick({ stopPropagation() {} });
await tick();
const batchCall = apiCalls.find(c => c.url === "/sinheo/delete_batch");
if (!batchCall || JSON.parse(batchCall.options.body).rels.length !== expectRels) {
  throw new Error("批量删除没有按勾选发起请求");
}
console.log(`批量删除  : 全选 ${expectRels} 项 → POST /sinheo/delete_batch`);

// 重命名大类：点 ✎ → 行内输入 → ✓ → POST /sinheo/rename
const renameBtn = findAll(manager, "sh-tree-row")
  .flatMap(row => row.children.filter(c => c.tagName === "BUTTON"))
  .find(b => String(b.textContent) === "✎");
renameBtn.onclick({ stopPropagation() {} });
const renameBox = findAll(manager, "sh-rename-box")[0];
if (!renameBox) throw new Error("点 ✎ 后没有出现行内重命名输入框");
const renameInput = renameBox.children.find(c => c.tagName === "INPUT");
renameInput.value = "上装";
renameInput.oninput();
const renameOk = renameBox.children.find(c => c.tagName === "BUTTON" && String(c.textContent) === "✓");
renameOk.onclick({ stopPropagation() {} });
await tick();
const renameCall = apiCalls.find(c => c.url === "/sinheo/rename");
if (!renameCall) throw new Error("重命名没有发起 /sinheo/rename 请求");
const renameBody = JSON.parse(renameCall.options.body);
if (renameBody.rel !== "上衣" || renameBody.name !== "上装") {
  throw new Error(`重命名请求内容不对：${JSON.stringify(renameBody)}`);
}
console.log("重命名    : 大类 / 小类都有 ✎ 行内编辑，POST /sinheo/rename");

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

// ---- 图库管理 ----
const buttonsIn = root => {
  const out = [];
  const walk = el => {
    if (!el || typeof el !== "object") return;
    if (el.tagName === "BUTTON") out.push(el);
    for (const child of el.children || []) walk(child);
  };
  walk(root);
  return out;
};

const galleryBtn = findAll(node.domRoot, "sh-bar-gallery")[0];
if (!galleryBtn || !String(galleryBtn.textContent).includes("图库管理")) {
  throw new Error("节点上缺少「图库管理」入口");
}
galleryBtn.onclick({ stopPropagation() {} });
await tick();
const galleryDialog = findAll(documentStub.body, "sh-gallery")[0];
if (!galleryDialog || galleryDialog.hidden) throw new Error("图库弹窗没有打开");
const galleryHead = findAll(galleryDialog, "sh-gallery-head")[0];
if (!galleryHead.children.some(c => String(c.textContent).includes("Sinheo · 图库管理"))) {
  throw new Error("图库标题不对");
}
const headButtons = buttonsIn(galleryHead);
const editBtn = headButtons.find(b => String(b.textContent).includes("编辑"));
const galleryImportBtn = headButtons.find(b => String(b.textContent).includes("导入"));
const galleryExportBtn = headButtons.find(b => String(b.textContent).includes("导出"));
if (!editBtn || !galleryImportBtn || !galleryExportBtn) {
  throw new Error("图库顶部缺少编辑 / 导入 / 导出按钮");
}
// 「编辑」移到「导入」左边，顶部中间不再放按钮
const galleryActions = findAll(galleryHead, "sh-gallery-head-actions")[0];
if (!galleryActions || galleryActions.children.indexOf(editBtn) === -1
    || galleryActions.children.indexOf(editBtn) >= galleryActions.children.indexOf(galleryImportBtn)) {
  throw new Error("「编辑」没有移到「导入」左边");
}
if (findAll(galleryHead, "sh-gallery-head-center")[0]?.children.length) {
  throw new Error("「编辑」还留在顶部中间");
}
console.log("顶部按钮  : 编辑 → 导入 → 导出 → 关闭，编辑紧挨导入左边");

// 词库管理 / 图库管理：两个弹窗同宽，节点上两个按钮也等宽
const CSS_TEXT = fs.readFileSync(path.join(HERE, "../web/sinheo.css"), "utf8");
const cssBlock = selector =>
  CSS_TEXT.match(new RegExp("\\" + selector + "\\s*\\{[^}]*\\}"))?.[0] || "";
if (!/--sh-panel-width:\s*min\(1180px, 96vw\)/.test(CSS_TEXT)
    || !cssBlock(".sh-mgr-box").includes("var(--sh-panel-width)")
    || !cssBlock(".sh-gallery-box").includes("var(--sh-panel-width)")) {
  throw new Error("词库管理 / 图库管理弹窗宽度没有统一");
}
if (!cssBlock(".sh-bar-main").includes("flex: 1 1 0")
    || !cssBlock(".sh-bar-gallery").includes("flex: 1 1 0")) {
  throw new Error("节点上两个管理按钮没有等宽");
}
console.log("宽度统一  : 两个弹窗共用宽度变量，节点两个按钮等宽");
if (findAll(galleryDialog, "sh-gallery-switch").length) {
  throw new Error("「显示标题」开关没有移除");
}
if (findAll(galleryDialog, "sh-gallery-card-title").length) {
  throw new Error("卡片标题没有移除");
}

let tabs = findAll(galleryDialog, "sh-gallery-tab");
if (tabs.length !== 1 + GALLERY_DATA.categories.length + 1) {
  throw new Error(`分类标签数量不对：${tabs.length}`);
}
if (findAll(galleryDialog, "sh-gallery-card").length !== GALLERY_DATA.cards.length) {
  throw new Error("初始卡片数量不对");
}
if (!findAll(galleryDialog, "sh-gallery-card-img")[0]?.src.includes("abc.png")) {
  throw new Error("图片卡片没有生成正确的图片 URL");
}
// 卡片布局：图片直接铺满卡片，按钮条叠在图片上，不再有 media 容器上下分层
const firstCard = findAll(galleryDialog, "sh-gallery-card")[0];
if (findAll(firstCard, "sh-gallery-card-media").length) {
  throw new Error("卡片仍在用旧的上下分层 media 容器");
}
if (!firstCard.children.some(c => String(c.className).includes("sh-gallery-card-img"))) {
  throw new Error("图片没有直接铺满卡片");
}
const firstActions = findAll(firstCard, "sh-gallery-card-actions")[0];
if (!firstCard.children.includes(firstActions)) {
  throw new Error("按钮条没有直接叠在图片上");
}
if (!findAll(firstCard, "sh-gallery-card-prompt").length) {
  throw new Error("卡片提示词浮层丢失");
}
const actionLabels = firstActions.children
  .filter(c => c.tagName === "BUTTON").map(c => String(c.textContent));
if (!["使用", "复制", "♥"].every(label => actionLabels.includes(label))) {
  throw new Error(`卡片按钮应为 使用 / 复制 / 爱心，实际 ${actionLabels.join(" / ")}`);
}
console.log("卡片布局  : 图片完整铺满 + 按钮条浮在图片上 + 使用/复制/收藏 三按钮");

// 不同尺寸图片：默认统一整齐网格，可切换原比例瀑布流，坏图显示占位
const cardsBox = findAll(galleryDialog, "sh-gallery-cards")[0];
if (!cardsBox?.classList.contains("sh-layout-grid")) {
  throw new Error("图库默认不是统一整齐网格");
}
const layoutBtn = findAll(galleryDialog, "sh-layout-btn")[0];
if (!layoutBtn) throw new Error("缺少布局切换按钮");
layoutBtn.onclick({ stopPropagation() {} });
if (!cardsBox.classList.contains("sh-layout-flow")
    || cardsBox.classList.contains("sh-layout-grid")) {
  throw new Error("没有切到原比例瀑布流");
}
layoutBtn.onclick({ stopPropagation() {} });
if (!cardsBox.classList.contains("sh-layout-grid")) {
  throw new Error("没有切回整齐网格");
}
const brokenImg = findAll(galleryDialog, "sh-gallery-card-img")[0];
if (typeof brokenImg?.onerror !== "function") {
  throw new Error("图片没有加载失败占位处理");
}
brokenImg.onerror();
if (!findAll(galleryDialog, "sh-gallery-card-placeholder").length) {
  throw new Error("图片加载失败没有显示占位");
}
layoutBtn.onclick({ stopPropagation() {} });
layoutBtn.onclick({ stopPropagation() {} });   // 重新渲染，恢复卡片
console.log("图库布局  : 默认整齐网格 / 可切原比例瀑布 / 坏图显示占位");

// 点「复制」-> 该卡片提示词进剪贴板（不关闭图库）
copiedText = null;
const cardCopyBtn = firstActions.children.find(c => c.tagName === "BUTTON" && String(c.textContent) === "复制");
cardCopyBtn.onclick({ stopPropagation() {} });
await tick();
if (copiedText !== GALLERY_DATA.cards[0].prompt) {
  throw new Error("复制按钮没有把该卡片提示词写进剪贴板");
}
console.log("复制卡片  : 提示词已写入剪贴板");

// 点「使用」-> 提示词写进节点文本框（并同步隐藏的 manual_text widget）
const useBtn = firstActions.children.find(c => c.tagName === "BUTTON" && String(c.textContent) === "使用");
if (!useBtn) throw new Error("卡片缺少「使用」按钮");
useBtn.onclick({ stopPropagation() {} });
await tick();
if (preview.value !== GALLERY_DATA.cards[0].prompt
    || manualWidget.value !== GALLERY_DATA.cards[0].prompt) {
  throw new Error("点「使用」没有把提示词写进节点文本框");
}
if (!galleryDialog.hidden) throw new Error("点「使用」后图库没有关闭");
console.log("使用卡片  : 提示词已写进节点文本框并同步 widget");

galleryBtn.onclick({ stopPropagation() {} });
await tick();
if (galleryDialog.hidden) throw new Error("图库无法重新打开");

// 收藏（爱心）
const heart = findAll(findAll(galleryDialog, "sh-gallery-card")[0], "sh-gallery-card-actions")[0]
  .children.find(c => c.tagName === "BUTTON" && String(c.textContent) === "♥");
if (!heart) throw new Error("卡片缺少收藏爱心按钮");
heart.onclick({ stopPropagation() {} });
await tick();
const gallerySaveCall = apiCalls.filter(c => c.url === "/sinheo/gallery/save").pop();
if (!gallerySaveCall
    || JSON.parse(gallerySaveCall.options.body).cards.find(c => c.id === "card_a").favorite !== true) {
  throw new Error("收藏没有写入图库数据");
}
console.log("收藏卡片  : 切换 favorite → POST /sinheo/gallery/save");

// 搜索只按提示词（标题功能已移除）
const searchInput = findAll(galleryDialog, "sh-gallery-search-input")[0];
if (!String(searchInput.placeholder).includes("提示词")) {
  throw new Error("搜索框文案没有改成只搜提示词");
}
searchInput.value = "针织";
searchInput.oninput();
if (findAll(galleryDialog, "sh-gallery-card").length !== 1) throw new Error("按提示词搜索不对");
searchInput.value = "丝绒";
searchInput.oninput();
if (findAll(galleryDialog, "sh-gallery-card").length !== 1) throw new Error("第二条提示词搜索不对");
searchInput.value = "柔光";                 // 旧数据里它只是标题，不应再匹配
searchInput.oninput();
if (findAll(galleryDialog, "sh-gallery-card").length !== 0) throw new Error("标题仍参与了搜索");
searchInput.value = "";
searchInput.oninput();

// 分类标签 + 左侧小组过滤
tabs = findAll(galleryDialog, "sh-gallery-tab");
const clothTab = tabs.find(t => String(t.textContent) === "服饰");
clothTab.onclick({ stopPropagation() {} });
if (findAll(galleryDialog, "sh-gallery-card").length !== 2) throw new Error("选分类后卡片数不对");
const sideItems = findAll(galleryDialog, "sh-gallery-side-item");
if (sideItems.length !== 3) throw new Error(`「服饰」下应有 全部 / 日常 / 晚宴，实际 ${sideItems.length}`);
const daily = sideItems.find(item => String(item.children[0]?.textContent) === "日常");
daily.onclick({ stopPropagation() {} });
if (findAll(galleryDialog, "sh-gallery-card").length !== 1) throw new Error("点左侧分组后没有只显示该组卡片");
const favTab = findAll(galleryDialog, "sh-gallery-tab")
  .find(t => String(t.textContent).includes("收藏"));
favTab.onclick({ stopPropagation() {} });
const favCount = GALLERY_DATA.cards.filter(c => c.favorite).length;
if (findAll(galleryDialog, "sh-gallery-card").length !== favCount) throw new Error("收藏栏数量不对");
console.log("分类/分组 : 分类标签 → 该分类全部卡片；左侧分组 → 只显示该组；收藏栏正常");

// ---- 导出：10 MB 的图库包不能再交给浏览器下载管理器 ----
// 词库包只有 1 KB 一次读完所以一直正常；图库包 10 MB 走 blob: URL 会在
// 后台读取时被中断，Edge 报「无法从网站上提取文件」。现在主路径是服务端写盘。
const galleryMsg = () => String(findAll(galleryDialog, "sh-gallery-msg")[0]?.textContent || "");
const exportPanel = () => findAll(galleryDialog, "sh-gallery-export-root")[0];
const panelMsg = () => String(findAll(exportPanel(), "sh-gallery-msg")[0]?.textContent || "");
const exportFootButtons = () => findAll(exportPanel(), "sh-gallery-import-foot")[0]?.children || [];
const exportBtnByText = text => exportFootButtons()
  .find(b => b.tagName === "BUTTON" && String(b.textContent).includes(text));

fetchCalls.length = 0;
apiCalls.length = 0;
clickedElements.length = 0;
pickerCalls.length = 0;
savedWrites.length = 0;
pickerMode = "available";
galleryExportBtn.onclick({ stopPropagation() {} });
await tick(60);
if (!exportPanel() || exportPanel().hidden) throw new Error("导出面板没有打开");
if (!apiCalls.some(c => c.url === "/sinheo/gallery/export_dir")) {
  throw new Error("面板没有向后端取默认保存目录");
}
if (apiCalls.some(c => /export_blob|export_info|export_to|gallery\/download/.test(c.url))) {
  throw new Error("点导出不该自动打包或下载（这正是 10 MB 包失败的原因）");
}
if (pickerCalls.length) throw new Error("点导出不该自动弹「另存为」");
if (clickedElements.some(el => el.tagName === "A")) throw new Error("点导出不该触发浏览器下载");
const exportInputs = findAll(exportPanel(), "sh-gallery-export-input");
if (exportInputs.length !== 2 || !String(exportInputs[0].value).endsWith(".zip")) {
  throw new Error("导出面板缺少文件名 / 保存位置输入");
}
if (!String(exportInputs[1].value).includes("exports")) {
  throw new Error("保存位置没有预填默认目录");
}
console.log("导出面板  : 点导出只打开面板，不自动打包 / 下载 / 弹另存为");

// 面板只保留「取消 / 保存到该位置」：浏览器侧通道在这个环境里一律被拦
const footBtns = [...exportFootButtons()].filter(b => b.tagName === "BUTTON");
if (footBtns.length !== 2 || !footBtns.some(b => String(b.textContent).includes("保存到该位置"))) {
  throw new Error(`导出面板按钮数量不对：${footBtns.map(b => b.textContent).join(" / ")}`);
}
if (footBtns.some(b => /另存为|浏览器下载/.test(String(b.textContent)))) {
  throw new Error("被浏览器拦截的通道不该再出现在面板上");
}
console.log("通道精简  : 只剩「取消 / 保存到该位置」，没有另存为与浏览器下载");

// 主路径：填任意本机路径 → 后端直接写盘，全程不产生 blob: URL
const saveBtn = exportBtnByText("保存到该位置");
if (!saveBtn) throw new Error("缺少「保存到该位置」按钮");
exportInputs[1].value = "D:\\我的图库备份\\";
exportInputs[0].value = "我的图库.zip";
exportToCalls.length = 0;
apiCalls.length = 0;
clickedElements.length = 0;
saveBtn.onclick({ stopPropagation() {} });
await tick(60);
const exportToCall = apiCalls.find(c => c.url === "/sinheo/gallery/export_to");
if (!exportToCall) throw new Error("没有走服务端写盘主路径");
const exportToBody = JSON.parse(exportToCall.options.body);
if (!String(exportToBody.path).includes("我的图库备份") || exportToBody.overwrite !== true) {
  throw new Error("用户填的路径 / 覆盖选项没有传给后端");
}
if (clickedElements.some(el => el.tagName === "A")) {
  throw new Error("写盘主路径不该再触发浏览器下载");
}
if (fetchCalls.length) {
  throw new Error("导出不该使用裸 fetch（会绕过 ComfyUI 认证头）");
}
if (!panelMsg().includes("D:\\ComfyUI备份\\图库.zip") || !galleryMsg().includes("已导出")) {
  throw new Error("写盘成功后没有显示实际保存位置");
}
console.log("ZIP 导出   : 面板填路径 → 服务端直接写盘，完全不经过浏览器下载管理器");

const rememberedDir = storageData.get("sinheo_gallery_export_dir") || "";
if (!rememberedDir || /\.zip$/i.test(rememberedDir) || rememberedDir !== "D:\\ComfyUI备份") {
  throw new Error(`保存后记住的不是目录：${rememberedDir}`);
}
console.log("目录记忆  : 只记文件夹（不是 ZIP 路径），并写入 localStorage");

// 导出范围：分类 / 分组下拉联动，选中的范围随写盘请求提交
const scopeSelects = findAll(exportPanel(), "sh-gallery-export-select");
if (scopeSelects.length !== 2) throw new Error("导出面板缺少分类 / 分组范围下拉");
if (String(scopeSelects[0].children[0]?.textContent) !== "整个图库") {
  throw new Error("分类下拉默认不是「整个图库」");
}
scopeSelects[0].value = "cat_cloth";
scopeSelects[0].onchange();
if (![...scopeSelects[1].children].some(o => o.value === "grp_daily")) {
  throw new Error("切换分类后分组下拉没有跟着更新");
}
scopeSelects[1].value = "grp_daily";
apiCalls.length = 0;
exportBtnByText("保存到该位置").onclick({ stopPropagation() {} });
await tick(60);
const scopedCall = apiCalls.find(c => c.url === "/sinheo/gallery/export_to");
if (!scopedCall) throw new Error("范围导出没有走服务端写盘");
const scopedBody = JSON.parse(scopedCall.options.body);
if (scopedBody.category !== "cat_cloth" || scopedBody.group !== "grp_daily") {
  throw new Error("分类 / 分组范围没有传给后端");
}
if (!panelMsg().includes("服饰 / 日常")) {
  throw new Error("导出成功消息没有显示所选范围");
}
console.log("导出范围  : 分类 / 分组下拉联动，范围随写盘请求一起提交");

// 两条被浏览器拦截的通道已从面板移除，导出过程不该再碰任何下载路由
if (apiCalls.some(c => /export_blob|export_info|gallery\/download/.test(c.url))) {
  throw new Error("服务端写盘不该再调用浏览器下载相关路由");
}
console.log("通道精简  : 不再有另存为 / 浏览器下载，导出只走服务端写盘");

// 旧版后端：export_to 404 → 明确提示重启，不静默回退到会失败的下载
pickerMode = "unsupported";
noExportTo = true;
saveBtn.onclick({ stopPropagation() {} });
await tick(60);
if (!panelMsg().includes("重启 ComfyUI")) {
  throw new Error("旧后端没有给出可操作的提示");
}
noExportTo = false;
console.log("旧版后端  : 明确提示重启，不静默回退到失败的浏览器下载");

if (clickedElements.some(el => el.tagName === "A")) {
  throw new Error("导出不该再触发任何 <a download> / 浏览器下载");
}
pickerMode = "available";   // 词库导出仍可能用系统「另存为」
console.log("无浏览器下载: 全程不产生 A 标签点击 / blob: URL");

galleryImportBtn.onclick({ stopPropagation() {} });
const importPanel = findAll(galleryDialog, "sh-gallery-import")[0];
if (!importPanel || importPanel.hidden) throw new Error("导入面板没有打开");
const importFile = importPanel.children[0].children
  .find(c => c.tagName === "INPUT" && c.type === "file");
if (!importFile) throw new Error("导入面板缺少文件选择");
importFile.files = [{ name: "library.zip" }];
const importButtons = buttonsIn(importPanel);
const mergeImport = importButtons.find(b => String(b.textContent).includes("合并导入"));
const replaceImport = importButtons.find(b => String(b.textContent).includes("覆盖导入"));
if (!mergeImport || !replaceImport) throw new Error("缺少合并 / 覆盖导入按钮");
mergeImport.onclick({ stopPropagation() {} });
await tick();
const importCall = apiCalls.find(c => c.url === "/sinheo/gallery/import");
if (!importCall) throw new Error("没有调用 /sinheo/gallery/import");
if (importCall.options.body.fields?.mode !== "merge") {
  throw new Error("导入模式没有传给后端");
}
if (!importPanel.hidden) throw new Error("导入完成后面板没有关闭");
console.log("导入导出  : ZIP 导出 + 合并/覆盖导入面板 → POST /sinheo/gallery/import");

// 编辑模式：新建分类 / 分组 / 卡片
editBtn.onclick({ stopPropagation() {} });
const editBar = findAll(galleryDialog, "sh-gallery-editbar")[0];
if (editBar.hidden) throw new Error("点「编辑」后编辑工具条没有出现");
if (!findAll(galleryDialog, "sh-gallery-card-edit-tools").length) {
  throw new Error("编辑模式缺少卡片右上角的编辑/删除工具");
}
const editActionCount = findAll(galleryDialog, "sh-gallery-card-actions")[0]
  .children.filter(c => c.tagName === "BUTTON").length;
if (editActionCount !== 3) {
  throw new Error(`编辑模式底部按钮条应保持 3 个按钮，实际 ${editActionCount}`);
}
const plusButtons = buttonsIn(editBar).filter(b => String(b.textContent) === "＋");
if (plusButtons.length !== 2) throw new Error("分类 / 分组的新建按钮数量不对");
plusButtons[0].onclick({ stopPropagation() {} });
await tick();
if (!GALLERY_DATA.categories.some(c => c.name === "测试分类")) throw new Error("新建分类失败");
plusButtons[1].onclick({ stopPropagation() {} });
await tick();
const createdCat = GALLERY_DATA.categories.find(c => c.name === "测试分类");
if (!createdCat?.groups.some(g => g.name === "测试分组")) throw new Error("新建分组失败");
const addCardBtn = buttonsIn(editBar).find(b => String(b.textContent).includes("新增卡片"));
if (!addCardBtn) throw new Error("缺少「新增卡片」按钮");
addCardBtn.onclick({ stopPropagation() {} });
const cardEditor = findAll(galleryDialog, "sh-gallery-card-editor")[0];
if (cardEditor.hidden) throw new Error("卡片编辑弹层没有打开");
const fieldInputs = findAll(cardEditor, "sh-gallery-field-input");
if (fieldInputs.length !== 1) throw new Error("卡片编辑应只剩提示词输入框");
fieldInputs[0].value = "测试提示词";
fieldInputs[0].oninput();
const saveCardBtn = buttonsIn(findAll(cardEditor, "sh-gallery-card-panel-foot")[0])
  .find(b => String(b.textContent).includes("保存卡片"));
saveCardBtn.onclick({ stopPropagation() {} });
await tick();
const newCard = GALLERY_DATA.cards.find(c => c.prompt === "测试提示词");
if (!newCard) throw new Error("新增卡片没有保存");
if (Object.prototype.hasOwnProperty.call(newCard, "title")) {
  throw new Error("新增卡片仍带标题字段");
}
console.log("编辑模式  : 增减分类 / 分组 / 卡片（图片 + 提示词，无标题）正常");

// Esc 关闭图库
for (const handler of docListeners["keydown"] || []) {
  handler({ key: "Escape", stopPropagation() {} });
}
if (!galleryDialog.hidden) throw new Error("Esc 没有关闭图库弹窗");
console.log("图库关闭  : Esc 正常");

// 已记住目标分类后，点「＋ 添加到图库」应一键抓图 + 静默存卡片
const beforeCards = GALLERY_DATA.cards.length;
apiCalls.length = 0;
addBtn.onclick({ stopPropagation() {} });
await tick(60);
const uploadCall = apiCalls.find(c => c.url === "/sinheo/gallery/image");
const saveCall = apiCalls.find(c => c.url === "/sinheo/gallery/save");
if (!uploadCall || !saveCall) {
  throw new Error("一键添加没有上传图片 / 保存卡片");
}
// 上传前必须先在浏览器里压成 512px JPEG：文件名后缀变了、body 也换成缩略 blob
const uploadedName = uploadCall.options.body.filenames?.file || "";
if (!uploadedName.endsWith(".jpg")) {
  throw new Error(`上传前没有压成缩略图：${uploadedName}`);
}
const uploadedBlob = uploadCall.options.body.fields.file;
if (uploadedBlob?.type !== "image/jpeg" || uploadedBlob?.size !== 12345) {
  throw new Error("上传的不是 canvas 生成的缩略 JPEG");
}
const savedCards = JSON.parse(saveCall.options.body).cards;
if (savedCards.length !== beforeCards + 1) {
  throw new Error("一键添加没有追加一张新卡片");
}
const added = savedCards[savedCards.length - 1];
if (added.categoryId !== "cat_style" || added.image !== "images/generated.png") {
  throw new Error("一键添加的分类 / 图片不对");
}
if (added.prompt !== preview.value) {
  throw new Error("一键添加没有带上当前提示词");
}
if (Object.prototype.hasOwnProperty.call(added, "title")) {
  throw new Error("一键添加的卡片仍带标题字段");
}
console.log("一键添加  : 已记目标 → 抓最近生成图 → 上传 → 追加卡片（无标题）");

// ---- 外部文本输入：连线后直接透传上游 STRING，断开后恢复 ----
const extSlot = node.inputs.find(slot => slot.name === "external_text");
const extValueEl = findAll(node.domRoot, "sh-row-value")[0];
extSlot.link = 42;
node.onConnectionsChange(0, 0, true);
await tick();
if (!preview.readOnly || !String(extValueEl.textContent).includes("外部文本")) {
  throw new Error("接上外部文本后节点没有切换到外部模式");
}
if (!genBtn.disabled) throw new Error("外部文本模式下「生成」按钮应停用");
node.onExecuted({ sinheo_text: ["外部传入的提示词"] });
if (preview.value !== "外部传入的提示词") {
  throw new Error("外部文本执行结果没有显示在文本框");
}
if (manualWidget.value === "外部传入的提示词") {
  throw new Error("外部文本不该写回 manual_text widget");
}
extSlot.link = null;
node.onConnectionsChange(0, 0, false);
await tick();
if (preview.readOnly) throw new Error("断开外部文本后文本框仍只读");
if (String(extValueEl.textContent).includes("外部文本")
    || !/词库|图库|随机/.test(String(extValueEl.textContent))) {
  throw new Error("断开外部文本后摘要没有恢复");
}
console.log("外部文本  : 连线 → 只读展示 / 摘要切换 / 执行结果透传，断开后恢复");

// ---- 旧工作流：菜单已无词条层，config 里残留的 picks / mode 必须静默清掉 ----
const legacyConfig = {
  cats: { "上衣/甜美": { on: true, picks: ["浅粉蝴蝶结雪纺上衣"], mode: "all" } },
  groups: { 上衣: { on: true } },
};
const legacyNode = {
  id: 2, size: [340, 470], inputs: [],
  addInput(name, type) { this.inputs.push({ name, type, link: null }); },
  widgets: [
    { name: "manual_text", value: "", hidden: false, options: {} },
    { name: "config", value: JSON.stringify(legacyConfig), hidden: false, options: {} },
  ],
  graph: { change() {} }, setDirtyCanvas() {}, setSize() {},
  getWidgetOnPos() { return undefined; },
  addDOMWidget(name, type, element, options) {
    this.domRoot = element; this.domOptions = options;
    return { name, element, options };
  },
};
nodeType.prototype.onNodeCreated.call(legacyNode);
await tick();
const migrated = JSON.parse(legacyNode.widgets[1].value);
const migratedCat = migrated.cats["上衣/甜美"];
if (!migratedCat || "picks" in migratedCat || "mode" in migratedCat || migratedCat.on !== true) {
  throw new Error("旧工作流残留的 picks / mode 没有被清理");
}
console.log("旧配置迁移: picks / mode 静默清除，勾选状态保留");

// ---- 记住的目录跨面板重开 / 页面刷新都能填回 ----
apiCalls.length = 0;
galleryExportBtn.onclick({ stopPropagation() {} });
await tick(60);
const reopenedInputs = findAll(exportPanel(), "sh-gallery-export-input");
const reopenedDir = String(reopenedInputs[1].value);
if (!reopenedDir || /\.zip$/i.test(reopenedDir)) {
  throw new Error(`重开面板后没有填回目录：${reopenedDir}`);
}
if (apiCalls.some(c => c.url === "/sinheo/gallery/export_dir")) {
  throw new Error("已经记住目录就不该再问后端要默认目录");
}
console.log("目录记忆  : 重开面板自动填回上次目录，刷新页面也保留");

// ---- 自动文件名：本地时间 + 毫秒、每次导出刷新；手改名字保留 ----
pickerMode = "available";
galleryExportBtn.onclick({ stopPropagation() {} });
await tick(60);
const freshInputs = findAll(exportPanel(), "sh-gallery-export-input");
const autoName = String(freshInputs[0].value);
if (!/^Sinheo_gallery_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}(?:-\d+)?\.zip$/.test(autoName)) {
  throw new Error(`自动文件名不是本地时间格式：${autoName}`);
}
const localNow = new Date();
const localPad = (n, w = 2) => String(n).padStart(w, "0");
const localDate = `${localNow.getFullYear()}-${localPad(localNow.getMonth() + 1)}-${localPad(localNow.getDate())}`;
if (!autoName.includes(localDate)) throw new Error("文件名还在用 UTC 日期");
const autoNames = [];
for (let i = 0; i < 2; i += 1) {
  apiCalls.length = 0;
  exportBtnByText("保存到该位置").onclick({ stopPropagation() {} });
  await tick(60);
  const call = apiCalls.find(c => c.url === "/sinheo/gallery/export_to");
  if (!call) throw new Error("自动文件名测试没有走服务端写盘");
  autoNames.push(JSON.parse(call.options.body).filename);
}
if (!autoNames[0] || autoNames[0] === autoNames[1] || autoNames[0] === autoName) {
  throw new Error(`每次导出没有刷新成新的文件名：面板=${autoName} / 第一次=${autoNames[0]} / 第二次=${autoNames[1]}`);
}
delete freshInputs[0].dataset.autoName;       // 模拟用户手改 + input 事件
freshInputs[0].value = "我的固定备份.zip";
apiCalls.length = 0;
exportBtnByText("保存到该位置").onclick({ stopPropagation() {} });
await tick(60);
const manualCall = apiCalls.find(c => c.url === "/sinheo/gallery/export_to");
if (JSON.parse(manualCall.options.body).filename !== "我的固定备份.zip") {
  throw new Error("手动改过的文件名被自动刷新覆盖了");
}
console.log("导出文件名: 本地时间 + 毫秒，每次导出刷新，手改名字保留");

// ---- 「只记住目标」刷新页面后保持，再点一次取消 ----
const refreshedNode = {
  id: 3, size: [340, 470], inputs: [],
  addInput(name, type) { this.inputs.push({ name, type, link: null }); },
  widgets: [
    { name: "manual_text", value: "", hidden: false, options: {} },
    { name: "config", value: "{}", hidden: false, options: {} },
  ],
  graph: { change() {} }, setDirtyCanvas() {}, setSize() {},
  getWidgetOnPos() { return undefined; },
  addDOMWidget(name, type, element, options) {
    this.domRoot = element; this.domOptions = options;
    return { name, element, options };
  },
};
nodeType.prototype.onNodeCreated.call(refreshedNode);
await tick();
if (!storageData.has("sinheo_gallery_add_target")) {
  throw new Error("记住目标在测试过程中被意外清除");
}
const refreshedFoot = findAll(refreshedNode.domRoot, "sh-foot")[0]?.children || [];
if (![...refreshedFoot].some(b => String(b.textContent).includes("目标已设"))) {
  throw new Error("刷新后新节点没有从 localStorage 恢复记住的目标");
}
console.log("刷新保持  : 新节点自动恢复「目标已设」，偏好来自 localStorage");
rememberBtn.onclick({ stopPropagation() {} });
if (storageData.has("sinheo_gallery_add_target")) {
  throw new Error("再点一次开关没有取消记住目标");
}
if (String(addTargetBtn.textContent).includes("目标已设")) {
  throw new Error("取消后节点按钮仍显示目标已设");
}
if (!String(rememberBtn.textContent).includes("○")) {
  throw new Error("取消后开关按钮没有回到未选中状态");
}
console.log("取消记住  : 再点一次即取消，localStorage 与节点状态同步清除");

// ---- 图库管理头部的按钮组：只留 编辑 / 导入 / 导出，不再有「压缩」 ----
const actionButtons = buttonsIn(findAll(galleryDialog, "sh-gallery-head-actions")[0]);
if (actionButtons.length !== 3) {
  throw new Error(`图库头部按钮数量不对：${actionButtons.map(b => b.textContent).join(" / ")}`);
}
if (actionButtons.some(b => /压缩/.test(String(b.textContent)))) {
  throw new Error("「压缩」按钮应已移除");
}
if (apiCalls.some(c => /gallery\/(optimize)/.test(c.url))) {
  throw new Error("前端不该再调用 /sinheo/gallery/optimize");
}
console.log("缩略图    : 上传前 canvas 压成 512px JPEG；头部只留 编辑 / 导入 / 导出，无压缩按钮");

console.log("\n前端冒烟测试通过 ✓");
