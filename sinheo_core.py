"""
Sinheo-Comfyui-PromptLibrary / 词库核心（只依赖标准库，可脱离 ComfyUI 测试）

目录约定（插件与数据彻底分离，只有两级）：
    ComfyUI/custom_nodes/Sinheo-Comfyui-PromptLibrary/          <- 本插件代码
    ComfyUI/models/Sinheo/prompts/                <- 提示词数据，用户可随意用资源管理器改
        <大类>/                                  一级文件夹，例如「上衣」
            <小类>.txt                           一个小类就是一个 TXT，一行一条提示词
        _order.json                               手动排序结果（可选，插件自动生成）

    <小类>.txt                                    根级 TXT 归入虚拟大类「未分组」

旧版「大类/小类文件夹/*.txt」会在首次扫描时自动展平合并成 <大类>/<小类>.txt，
原文件夹整份备份到 .backup/migration-<时间戳>/，不丢词条。
"""
from __future__ import annotations

import io
import json
import random
import re
import shutil
import time
import zipfile
from pathlib import Path

FOLDER_KEY = "sinheo_prompts"
LIB_RELPATH = ("Sinheo", "prompts")
ORDER_FILE = "_order.json"
BACKUP_DIRNAME = ".backup"
UNGROUPED = "未分组"
SKIP_PARTS = {".backup", ".git", "__pycache__", ".svn", "node_modules", ".DS_Store"}
SKIP_FILES = {"readme.txt", "说明.txt", "license.txt", "license", "readme.md"}
ILLEGAL_CHARS = re.compile(r'[<>:"|?*\x00-\x1f]')
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4",
                    "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3",
                    "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"}
NUMBER_PREFIX = re.compile(r"^\d+[\s._-]+")

_migration_done = False


# --------------------------------------------------------------------------- #
# 目录与路径安全
# --------------------------------------------------------------------------- #
def library_roots(create: bool = True):
    """主目录（可写）+ extra_model_paths.yaml 里追加的目录（只读合并）。"""
    import folder_paths  # 延迟导入，方便纯 Python 单测

    main = Path(folder_paths.models_dir).joinpath(*LIB_RELPATH)
    if create:
        try:
            main.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
    try:
        folder_paths.add_model_folder_path(FOLDER_KEY, str(main), is_default=True)
    except TypeError:
        folder_paths.add_model_folder_path(FOLDER_KEY, str(main))
    try:
        extra = folder_paths.get_folder_paths(FOLDER_KEY)
    except Exception:
        extra = []
    roots = []
    for item in list(extra) + [str(main)]:
        path = Path(item)
        if path not in roots:
            roots.append(path)
    return roots


def writable_root() -> Path:
    return library_roots()[0]


def safe_parts(raw, max_parts: int = 2):
    """把用户给的相对路径拆成安全的目录/文件名片段（两级词库最多 2 段）。"""
    if not isinstance(raw, str):
        raise ValueError("路径必须是文本")
    text = raw.strip().replace("\\", "/").strip("/")
    parts = [part.strip() for part in text.split("/") if part.strip()]
    if not parts:
        raise ValueError("名称不能为空")
    if len(parts) > max_parts or len(text) > 240:
        raise ValueError("层级过深或名称过长（只允许 大类/小类.txt）")
    for part in parts:
        if part in (".", "..") or part.startswith("."):
            raise ValueError(f"非法名称：{part}")
        if ILLEGAL_CHARS.search(part) or re.match(r"^[A-Za-z]:", part):
            raise ValueError(f"名称含非法字符：{part}")
        if part.upper().split(".")[0] in WINDOWS_RESERVED:
            raise ValueError(f"系统保留名不能用作名称：{part}")
    return parts


def _under_root(parts) -> Path:
    root = writable_root().resolve()
    path = root.joinpath(*parts).resolve()
    if not path.is_relative_to(root):
        raise ValueError("路径超出词库目录")
    return path


def display_label(name: str) -> str:
    """01_甜美 -> 甜美；数字前缀只用来做初始排序，不显示在界面上。"""
    return NUMBER_PREFIX.sub("", str(name)).strip() or str(name)


def _natural_key(text: str):
    return tuple(int(part) if part.isdigit() else part.lower()
                 for part in re.split(r"(\d+)", str(text)))


def ordered_ids(keys, preferred):
    """按手动顺序排；没排到的按文件名自然序追加在后面。"""
    available = set(keys)
    seen, head = set(), []
    for key in preferred or []:
        if key in available and key not in seen:
            seen.add(key)
            head.append(key)
    tail = sorted((k for k in keys if k not in seen), key=_natural_key)
    return head + tail


# --------------------------------------------------------------------------- #
# 文本读写
# --------------------------------------------------------------------------- #
def read_text(path: Path) -> str:
    data = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def parse_items(text):
    """一行一条；忽略空行与 # 注释；保持顺序去重。"""
    items, seen = [], set()
    for line in str(text).splitlines():
        line = line.strip().strip("\ufeff")
        if not line or line.startswith("#") or line in seen:
            continue
        seen.add(line)
        items.append(line)
    return items


def write_items(path: Path, items) -> int:
    cleaned = parse_items("\n".join(str(x) for x in items))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text("\n".join(cleaned) + ("\n" if cleaned else ""), encoding="utf-8")
    tmp.replace(path)
    return len(cleaned)


def read_order():
    path = writable_root() / ORDER_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"groups": [], "categories": {}}
    if not isinstance(data, dict):
        return {"groups": [], "categories": {}}
    groups = [g for g in data.get("groups", []) if isinstance(g, str)][:300]
    raw_cats = data.get("categories", {})
    cats = {}
    if isinstance(raw_cats, dict):
        for key, values in raw_cats.items():
            if isinstance(key, str) and isinstance(values, list):
                cats[key] = [v for v in values if isinstance(v, str)][:500]
    return {"groups": groups, "categories": cats}


def save_order(groups, categories):
    """保存「词库默认顺序」，新建节点会以它作为初始顺序。"""
    clean_groups = []
    for name in groups or []:
        if isinstance(name, str) and name.strip():
            clean_groups.append(name.strip()[:120])
    clean_cats = {}
    for group, values in (categories or {}).items():
        if not isinstance(group, str) or not isinstance(values, list):
            continue
        clean_cats[group.strip()[:120]] = [str(v).strip()[:200] for v in values if isinstance(v, str)]
    data = {"groups": clean_groups[:300], "categories": clean_cats}
    path = writable_root() / ORDER_FILE
    tmp = path.with_name(ORDER_FILE + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return data


# --------------------------------------------------------------------------- #
# 旧三级目录 -> 两级 TXT（自动、幂等、带备份）
# --------------------------------------------------------------------------- #
def migrate_legacy_layout():
    """把 <大类>/<小类文件夹>/*.txt 合并成 <大类>/<小类>.txt。

    原小类文件夹整份复制到 .backup/migration-<时间戳>/ 后删除，词条一条不丢。
    只读目录（extra_model_paths）不改动。
    """
    root = writable_root().resolve()
    result = {"moved": [], "merged": 0, "backup": ""}
    if not root.is_dir():
        return result
    legacy = {}
    for path in sorted(root.rglob("*.txt")):
        relative = path.relative_to(root)
        parts = relative.parts
        if len(parts) < 3:
            continue
        if any(p in SKIP_PARTS or p.startswith(".") for p in parts):
            continue
        if parts[-1].lower() in SKIP_FILES or parts[-1] == ORDER_FILE:
            continue
        legacy.setdefault((parts[0], parts[1]), []).append(path)
    if not legacy:
        return result

    backup_root = root / BACKUP_DIRNAME / ("migration-" + time.strftime("%Y%m%d-%H%M%S"))
    result["backup"] = str(backup_root)
    for (gid, catname), paths in legacy.items():
        try:
            items = []
            for path in sorted(paths, key=lambda p: _natural_key(p.name)):
                items.extend(parse_items(read_text(path)))
            target = root / gid / (catname + ".txt")
            if target.is_file():
                items = parse_items(read_text(target)) + items
            write_items(target, items)
            folder = root / gid / catname
            if folder.is_dir():
                backup = backup_root / gid / catname
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(folder, backup, dirs_exist_ok=True)
                shutil.rmtree(folder)
            result["moved"].append(f"{gid}/{catname} → {gid}/{catname}.txt")
        except OSError:
            continue
    result["merged"] = len(result["moved"])
    return result


def _ensure_migrated():
    global _migration_done
    if _migration_done:
        return
    _migration_done = True
    try:
        migrate_legacy_layout()
    except Exception:
        pass  # 迁移失败不能影响节点正常工作


# --------------------------------------------------------------------------- #
# 扫描（文件夹即大类，TXT 即小类）
# --------------------------------------------------------------------------- #
def scan_library():
    _ensure_migrated()
    roots = library_roots()
    main = roots[0].resolve()
    groups = {}

    def ensure_group(gid):
        if gid not in groups:
            groups[gid] = {"id": gid, "label": display_label(gid), "categories": {}}
        return groups[gid]

    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            relative = path.relative_to(root)
            parts = relative.parts
            if not parts or any(p in SKIP_PARTS or p.startswith(".") for p in parts):
                continue
            editable = path.resolve().is_relative_to(main)
            if path.is_dir():
                if len(parts) == 1:
                    ensure_group(parts[0])
                # 更深的目录交由 migrate_legacy_layout 展平
                continue
            if len(parts) > 2:
                continue
            if path.suffix.lower() != ".txt" or parts[-1].lower() in SKIP_FILES:
                continue
            if parts[-1] == ORDER_FILE:
                continue
            stem = path.stem
            if len(parts) == 1:
                gid, cid = UNGROUPED, stem
            else:
                gid, cid = parts[0], parts[0] + "/" + stem
            group = ensure_group(gid)
            rel = relative.as_posix()
            cat = group["categories"].get(cid)
            if cat is None:
                cat = {"id": cid, "group": gid, "label": display_label(stem),
                       "kind": "file", "rel": rel, "files": [], "items": [],
                       "count": 0, "editable": editable}
                group["categories"][cid] = cat
            items = parse_items(read_text(path))
            cat["files"].append({"name": parts[-1], "rel": rel,
                                 "count": len(items), "items": items})
            cat["editable"] = cat["editable"] and editable

    order = read_order()
    result_groups, flat = [], []
    for gid in ordered_ids(list(groups.keys()), order["groups"]):
        group = groups[gid]
        cat_map = group["categories"]
        categories = []
        for cid in ordered_ids(list(cat_map.keys()), order["categories"].get(gid, [])):
            cat = cat_map[cid]
            merged = parse_items("\n".join(item for f in cat["files"] for item in f["items"]))
            cat["items"] = merged
            cat["count"] = len(merged)
            cat["files"].sort(key=lambda f: _natural_key(f["name"]))
            categories.append(cat)
            flat.append(cat)
        group["categories"] = categories
        group["count"] = len(categories)
        result_groups.append(group)

    return {"root": str(roots[0]), "roots": [str(r) for r in roots],
            "groups": result_groups, "categories": flat,
            "total": sum(c["count"] for c in flat), "order": order}


def library_stamp():
    """词库文件指纹：非随机模式下，改了 txt 也会让节点重新执行。"""
    import hashlib

    digest = hashlib.sha256()
    for root in library_roots(create=False):
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.txt")):
            relative = path.relative_to(root)
            if any(p in SKIP_PARTS or p.startswith(".") for p in relative.parts):
                continue
            try:
                stat = path.stat()
                digest.update(f"{relative.as_posix()}|{stat.st_mtime_ns}|{stat.st_size};".encode("utf-8"))
            except OSError:
                continue
    return digest.hexdigest()


# --------------------------------------------------------------------------- #
# 编辑词库
# --------------------------------------------------------------------------- #
def save_file(rel: str, content: str, merge: bool = False):
    """保存一个小类 TXT（路径相对词库根：大类/小类.txt，或 小类.txt）。"""
    if not isinstance(content, str):
        raise ValueError("内容必须是文本")
    parts = safe_parts(rel, max_parts=2)
    if not parts[-1].lower().endswith(".txt"):
        parts[-1] += ".txt"
    safe_parts("/".join(parts), max_parts=2)
    path = _under_root(parts)
    if path.is_dir():
        raise ValueError("该路径是文件夹，请指定 TXT 文件名")
    items = parse_items(content)
    if merge and path.is_file():
        items = parse_items("\n".join(parse_items(read_text(path)) + items))
    count = write_items(path, items)
    return {"rel": "/".join(parts), "count": count}


def create_group(name: str):
    parts = safe_parts(name, max_parts=1)
    path = _under_root(parts)
    if path.exists() and not path.is_dir():
        raise ValueError("同名 TXT 已存在")
    path.mkdir(parents=True, exist_ok=True)
    return {"rel": parts[0]}


def create_category(group: str, name: str):
    """新建小类 = 新建一个 TXT；未分组则建根级 TXT。"""
    gparts = safe_parts(group, max_parts=1)
    nparts = safe_parts(name, max_parts=1)
    filename = nparts[0] if nparts[0].lower().endswith(".txt") else nparts[0] + ".txt"
    rel = filename if gparts[0] == UNGROUPED else f"{gparts[0]}/{filename}"
    path = _under_root(safe_parts(rel, max_parts=2))
    if path.exists():
        return {"rel": rel, "exists": True}
    write_items(path, [])
    return {"rel": rel}


def append_items(rels, text):
    """把一段提示词按「一行一条」追加到若干个小类 TXT 末尾（节点「＋ 添加到」）。

    与 save_file 不同：这里只追加、不重写，原文件里的 # 注释、原有顺序全部保留；
    已存在的词条自动跳过。rels 里可以传 cat.id（上衣/甜美）或 cat.rel（上衣/甜美.txt）。
    """
    if not isinstance(rels, (list, tuple)) or not rels:
        raise ValueError("请至少勾选一个小类")
    lines = parse_items(text)
    if not lines:
        raise ValueError("当前提示词为空，没有可添加的内容")
    saved, total = [], 0
    for raw in rels[:50]:
        parts = safe_parts(str(raw), max_parts=2)
        if not parts[-1].lower().endswith(".txt"):
            parts[-1] += ".txt"
        safe_parts("/".join(parts), max_parts=2)
        path = _under_root(parts)
        if path.is_dir():
            raise ValueError(f"目标路径是文件夹，不是 TXT：{'/'.join(parts)}")
        original = read_text(path) if path.is_file() else ""
        existing = set(parse_items(original))
        fresh = [line for line in lines if line not in existing]
        if fresh:
            path.parent.mkdir(parents=True, exist_ok=True)
            # 跟原文件保持同一种行尾（Windows 记事本常是 CRLF），避免混用
            newline = "\r\n" if "\r\n" in original else "\n"
            needs_newline = bool(original) and not original.endswith(("\n", "\r"))
            with path.open("a", encoding="utf-8", newline="") as handle:
                if needs_newline:
                    handle.write(newline)
                handle.write(newline.join(fresh) + newline)
        saved.append({"rel": "/".join(parts), "added": len(fresh),
                      "count": len(existing) + len(fresh)})
        total += len(fresh)
    return {"saved": saved, "added": total, "lines": len(lines)}


def delete_path(rel: str):
    """删除小类 TXT 或整个大类文件夹；删除前整份备份到 .backup/<时间戳>/。"""
    parts = safe_parts(rel, max_parts=2)
    path = _under_root(parts)
    if not path.exists():
        raise FileNotFoundError(f"不存在：{rel}")
    backup = (writable_root() / BACKUP_DIRNAME /
              time.strftime("%Y%m%d-%H%M%S")).joinpath(*parts)
    backup.parent.mkdir(parents=True, exist_ok=True)
    if path.is_dir():
        shutil.copytree(path, backup, dirs_exist_ok=True)
        shutil.rmtree(path)
    else:
        shutil.copy2(path, backup)
        path.unlink()
    return {"rel": "/".join(parts), "backup": str(backup)}


# --------------------------------------------------------------------------- #
# 生成提示词（顺序严格跟随勾选菜单；每个小类只出 1 条）
# --------------------------------------------------------------------------- #
def compose(parts, separator, prefix, suffix):
    separator = separator if separator is not None else ", "
    cleaned = [str(p).strip() for p in parts if p and str(p).strip()]
    body = separator.join(cleaned)
    pre = str(prefix or "").strip().rstrip(" ,，、")
    suf = str(suffix or "").strip().lstrip(" ,，、")
    segments = [segment for segment in (pre, body, suf) if segment]
    return separator.join(segments)


def _mapping(value):
    return value if isinstance(value, dict) else {}


def parse_config(raw):
    """节点 config 是 JSON 字符串；坏数据一律当成空配置，不让工作流报错。"""
    if isinstance(raw, dict):
        return raw
    if not raw or not isinstance(raw, str):
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def build_prompt(library, config, randomize: bool = False, seed: int = 0,
                 random_seed=None):
    """
    config = {
      order:    ["上衣", "头发"],                     大类顺序
      catOrder: {"上衣": ["上衣/甜美", "上衣/可爱"]}, 小类顺序
      groups:   {"上衣": {"on": true, "random": true, "pick": 1}},
      cats:     {"上衣/甜美": {"on": true, "picks": []}},
      separator/prefix/suffix/extra/count
    }
    每个参与的小类只出 1 条提示词：picks 勾了就从勾的里面抽，否则从整个小类抽。
    randomize=False 时按库顺序取第一条，可复现。
    """
    cfg = _mapping(config)
    if randomize:
        rng = random.Random(random_seed) if random_seed is not None else random.Random()
    else:
        rng = random.Random(int(seed or 0))
    separator = str(cfg.get("separator", ", ") if cfg.get("separator", ", ") is not None else ", ")
    prefix = str(cfg.get("prefix", "") or "")
    suffix = str(cfg.get("suffix", "") or "")
    extra = str(cfg.get("extra", "") or "").strip()
    try:
        count = max(1, min(50, int(cfg.get("count", 1) or 1)))
    except (TypeError, ValueError):
        count = 1
    groups_cfg = _mapping(cfg.get("groups"))
    cats_cfg = _mapping(cfg.get("cats"))
    cat_order = _mapping(cfg.get("catOrder"))

    groups = library.get("groups", []) if isinstance(library, dict) else library
    group_map = {g["id"]: g for g in groups}
    # 没有显式顺序时，直接沿用 scan_library 已经排好的顺序（_order.json / 数字前缀）
    preferred_groups = cfg.get("order", [])
    ordered_groups = (ordered_ids(list(group_map.keys()), preferred_groups)
                      if preferred_groups else list(group_map.keys()))

    prompts, details = [], []
    for round_index in range(count):
        parts, picked = [], []
        for gid in ordered_groups:
            group = group_map[gid]
            gcfg = _mapping(groups_cfg.get(gid))
            if gcfg.get("on") is False:
                continue
            cat_map = {c["id"]: c for c in group["categories"]}
            preferred_cats = cat_order.get(gid, [])
            cat_ids = (ordered_ids(list(cat_map.keys()), preferred_cats)
                       if preferred_cats else list(cat_map.keys()))
            active = [cid for cid in cat_ids
                      if _mapping(cats_cfg.get(cid)).get("on", True) is not False
                      and cat_map[cid]["count"] > 0]
            if not active:
                continue
            if randomize and bool(gcfg.get("random")) and len(active) > 1:
                try:
                    pick = max(1, min(len(active), int(gcfg.get("pick", 1) or 1)))
                except (TypeError, ValueError):
                    pick = 1
                active = sorted(rng.sample(active, pick), key=active.index)
            for cid in active:
                cat = cat_map[cid]
                ccfg = _mapping(cats_cfg.get(cid))
                all_items = list(cat["items"])
                picks = [p for p in (ccfg.get("picks") or []) if isinstance(p, str) and p in all_items]
                pool = picks or all_items
                if not pool:
                    continue
                chosen = rng.choice(pool) if randomize else pool[0]
                parts.append(chosen)
                picked.append(f"{group['label']} / {cat['label']} → {chosen}")
        if extra:
            parts.append(extra)
        prompts.append(compose(parts, separator, prefix, suffix))
        header = f"#{round_index + 1} " if count > 1 else ""
        details.append(header + ("\n".join(picked) if picked else "（未勾选任何小类，或词库为空）"))
    return prompts, details


# --------------------------------------------------------------------------- #
# 导入 / 导出（兼容「提示词管理.html」导出的 ZIP）
# --------------------------------------------------------------------------- #
def export_zip(selection=None):
    """打包词库。selection 为大类 id / 小类 id 列表；None 或空 = 全部。"""
    library = scan_library()
    allowed = None
    if selection:
        if isinstance(selection, str):
            selection = [selection]
        if isinstance(selection, (list, tuple, set)):
            allowed = {str(x) for x in selection}
    if allowed is not None:
        cats = [c for c in library["categories"]
                if c["id"] in allowed or c["group"] in allowed]
        if not cats:
            raise ValueError("没有勾选任何要导出的小类")
    else:
        cats = list(library["categories"])

    order = library["order"]
    if allowed is not None:
        gids = {c["group"] for c in cats}
        selected_ids = {c["id"] for c in cats}
        order = {
            "groups": [g for g in order.get("groups", []) if g in gids],
            "categories": {k: [c for c in v if c in selected_ids]
                           for k, v in order.get("categories", {}).items() if k in gids},
        }

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for cat in cats:
            for file in cat["files"]:
                archive.writestr(file["rel"],
                                 ("\n".join(file["items"]) + "\n").encode("utf-8"))
        archive.writestr(ORDER_FILE, (json.dumps(order, ensure_ascii=False,
                                                 indent=2) + "\n").encode("utf-8"))
        archive.writestr("README.txt", (
            "Sinheo 提示词库导出\n"
            "目录：大类/小类.txt，一个 TXT 就是一个小类，一行一条提示词。\n"
            "解压回 ComfyUI/models/Sinheo/prompts/ 即可。\n"
            "该 ZIP 也能被「提示词管理.html」的 TXT 导入使用。\n"
        ).encode("utf-8"))
    return buffer.getvalue()


def _decode(content: bytes) -> str:
    try:
        return content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return content.decode("gb18030", errors="replace")


def _group_prefix(group: str) -> str:
    if not group or not str(group).strip() or str(group).strip() == UNGROUPED:
        return ""
    return safe_parts(group, max_parts=1)[0]


def _flatten_target(raw_parts, prefix: str) -> str:
    """把 ZIP / TXT 里的路径统一规范成「大类/小类.txt」，最多两层。

    一级  头发.txt                    -> 头发.txt / <prefix>/头发.txt
    二级  服饰/上衣.txt               -> 服饰/上衣.txt / <prefix>/上衣.txt
    三级  上衣/甜美/提示词.txt         -> 上衣/甜美.txt / <prefix>/甜美.txt
    """
    cleaned = [p for p in raw_parts if p and p not in (".", "..")]
    if not cleaned:
        raise ValueError("空路径")
    stem = Path(cleaned[-1]).stem or cleaned[-1]
    if len(cleaned) >= 3:
        # 旧三级结构：小类名取倒数第二层文件夹，多个 TXT 由 merge 合并
        stem = cleaned[-2]
        group = prefix or cleaned[0]
    elif len(cleaned) == 2:
        group = prefix or cleaned[0]
    else:
        group = prefix
    filename = stem if stem.lower().endswith(".txt") else stem + ".txt"
    rel = f"{group}/{filename}" if group else filename
    return "/".join(safe_parts(rel, max_parts=2))


def import_text(filename: str, content: bytes, merge: bool = True, group: str = ""):
    name = Path(str(filename)).name
    if not name.lower().endswith(".txt"):
        raise ValueError("只支持 .txt 文件")
    rel = _flatten_target([name], _group_prefix(group))
    return save_file(rel, _decode(content), merge=merge)


def import_zip(content: bytes, merge: bool = True, group: str = ""):
    saved, skipped, order_saved = [], [], False
    prefix = _group_prefix(group)
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        for member in archive.infolist():
            name = member.filename.replace("\\", "/")
            raw_parts = [p for p in name.split("/") if p]
            if member.is_dir() or not raw_parts:
                skipped.append(name)
                continue
            if any(p in (".", "..") or p.startswith(".") or p == "__MACOSX" for p in raw_parts):
                skipped.append(name)
                continue
            if raw_parts[-1].lower() in SKIP_FILES:
                skipped.append(name)
                continue
            if raw_parts[-1].lower() == ORDER_FILE.lower() and len(raw_parts) == 1:
                try:
                    data = json.loads(_decode(archive.read(member)))
                    save_order(data.get("groups", []), data.get("categories", {}))
                    order_saved = True
                except (ValueError, TypeError, OSError):
                    skipped.append(name)
                continue
            if not name.lower().endswith(".txt"):
                skipped.append(name)
                continue
            try:
                rel = _flatten_target(raw_parts, prefix)
                saved.append(save_file(rel, _decode(archive.read(member)), merge=merge))
            except (ValueError, OSError, zipfile.BadZipFile):
                skipped.append(name)
    return {"saved": saved, "skipped": skipped, "order": order_saved}
