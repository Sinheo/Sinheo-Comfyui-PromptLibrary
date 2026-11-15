"""
Sinheo · 图库数据层（只依赖标准库 + 可选 Pillow，可脱离 ComfyUI 单测）

目录约定（与词库平级，代码 / 数据依旧分离）：
    ComfyUI/models/Sinheo/gallery/
        library.json     <- 分类 / 分组 / 卡片 / 收藏（纯文本元数据）
        images/          <- 卡片缩略图（最长边 512px 的 JPEG，按 uuid 重命名）
        .backup/         <- 每次保存前的 library.json 快照 + 覆盖导入整库备份

数据结构：
    {
      "version": 1,
      "categories": [{"id": "...", "name": "服饰",
                      "groups": [{"id": "...", "name": "日常"}]}],
      "cards": [{"id": "...", "categoryId": "...", "groupId": "...",
                 "prompt": "...", "image": "images/xxx.png", "favorite": false}],
      "settings": {}
    }

一个卡片 = 一张缩略图 + 一段提示词（没有标题）。点「使用」把提示词写回节点文本框。

为什么图片只存缩略图：
  这个插件的核心是**提示词**，图片只是让人一眼认出「这条提示词大概出什么效果」。
  生成图动辄 2~8 MB 的 PNG，而图库卡片只有 250px 宽；存原图既浪费磁盘，
  又让导出包大到浏览器下载管理器都处理不了。所以所有写入口（上传 / 导入 /
  导出）统一过 thumbnail_bytes()：最长边 512px、JPEG q82、透明区合成白底，
  通常一张 30~80 KB；导出 ZIP 再兜一层，保证包里绝不会混入原图。
  升级前留下的原图不做自动迁移，需要时用户自己删掉 images/ 里的旧文件即可。

为什么用 JSON + 独立图片目录：
  * 元数据很小、可读、无第三方依赖，原子写（tmp + replace）不会写坏；
  * 图片是二进制，塞进 JSON 会膨胀且无法被浏览器直接缓存，所以单独放 images/；
  * 对外分享 / 备份用 export_zip() 打成一个 ZIP（library.json + 引用到的缩略图），
    import_archive() 可合并或覆盖导入，用户只需要管理一个文件。
  数据层是隔离的：以后卡片上万、需要全文检索或多端同步时，把这里换成 SQLite
  即可，前端和节点 API 都不用动。
"""
from __future__ import annotations

import hashlib
import io
import json
import random
import re
import shutil
import time
import uuid
import zipfile
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:                       # 精简版 Python 可能没有 Pillow
    Image, ImageOps = None, None

try:
    from . import sinheo_core as core
except ImportError:                       # 纯 Python 单测直接 import 模块时使用
    import sinheo_core as core

GALLERY_DIRNAME = "gallery"
IMAGES_DIRNAME = "images"
DATA_FILE = "library.json"
BACKUP_DIRNAME = ".backup"
BACKUP_KEEP = 10
SAFE_IMAGE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_CATEGORIES = 100
MAX_GROUPS = 100
MAX_CARDS = 5000

# 缩略图规格：卡片只有 ~250px 宽，512px 足够在 2x 屏上看清「大概是什么效果」
HAS_PIL = Image is not None
THUMB_MAX_EDGE = 512
THUMB_QUALITY = 82
THUMB_MAX_BYTES = 160 * 1024           # 已达标的小 JPEG 不重复有损编码
THUMB_SUFFIX = ".jpg"
JPEG_SUFFIXES = {".jpg", ".jpeg"}


def gallery_root(create: bool = True) -> Path:
    """图库根目录：models/Sinheo/gallery（词库是同级的 prompts）。"""
    core.writable_root()                      # 确保 models/Sinheo 已注册 / 创建
    root = core.writable_root().parent / GALLERY_DIRNAME
    if create:
        (root / IMAGES_DIRNAME).mkdir(parents=True, exist_ok=True)
    return root


def data_file(create: bool = True) -> Path:
    return gallery_root(create) / DATA_FILE


def uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _text(value, limit: int = 200) -> str:
    return str(value if value is not None else "").strip()[:limit]


def normalize(data) -> dict:
    """任何外部输入都先过一遍：补齐字段、去重 id、丢弃越界引用。

    旧版卡片里的 title / settings.showTitle 会被静默丢弃（标题功能已移除），
    因此从旧数据升级不会报错，也不会把废弃字段重新写回磁盘。
    """
    if not isinstance(data, dict):
        data = {}

    categories, cat_ids = [], set()
    raw_cats = data.get("categories")
    for item in (raw_cats if isinstance(raw_cats, list) else [])[:MAX_CATEGORIES]:
        if not isinstance(item, dict):
            continue
        cid = _text(item.get("id"), 80) or uid("cat")
        if cid in cat_ids:
            cid = uid("cat")
        cat_ids.add(cid)
        groups, group_ids = [], set()
        raw_groups = item.get("groups")
        for entry in (raw_groups if isinstance(raw_groups, list) else [])[:MAX_GROUPS]:
            if not isinstance(entry, dict):
                continue
            gid = _text(entry.get("id"), 80) or uid("grp")
            if gid in group_ids:
                gid = uid("grp")
            group_ids.add(gid)
            groups.append({"id": gid, "name": _text(entry.get("name"), 80) or "未命名分组"})
        categories.append({
            "id": cid,
            "name": _text(item.get("name"), 80) or "未命名分类",
            "groups": groups,
        })
    cat_map = {cat["id"]: cat for cat in categories}
    fallback_cat = categories[0]["id"] if categories else ""

    cards, card_ids = [], set()
    raw_cards = data.get("cards")
    for item in (raw_cards if isinstance(raw_cards, list) else [])[:MAX_CARDS]:
        if not isinstance(item, dict):
            continue
        card_id = _text(item.get("id"), 80) or uid("card")
        if card_id in card_ids:
            card_id = uid("card")
        card_ids.add(card_id)

        cat_id = _text(item.get("categoryId"), 80)
        if cat_id not in cat_map:
            cat_id = fallback_cat
        group_id = ""
        if cat_id:
            group_id = _text(item.get("groupId"), 80)
            if group_id not in {g["id"] for g in cat_map[cat_id]["groups"]}:
                group_id = ""

        image = _text(item.get("image"), 200)
        try:
            resolve_image(image)
        except (ValueError, OSError):
            image = ""

        cards.append({
            "id": card_id,
            "categoryId": cat_id,
            "groupId": group_id,
            "prompt": str(item.get("prompt") or "")[:20000],
            "image": image,
            "favorite": bool(item.get("favorite")),
        })

    return {"version": 1, "categories": categories, "cards": cards, "settings": {}}


def _prune_backups(folder: Path):
    files = sorted((p for p in folder.glob("library-*.json") if p.is_file()),
                   key=lambda p: p.name)
    for old in files[:-BACKUP_KEEP]:
        try:
            old.unlink()
        except OSError:
            pass


def load_gallery() -> dict:
    path = data_file()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = normalize({})
        save_gallery(data)
        return data
    # 读的时候只做内存规范化，不回写文件；保存一律走 save_gallery。
    return normalize(raw)


def save_gallery(data) -> dict:
    """原子写 + 写前快照，单文件坏了也能从 .backup 里找回上一版。"""
    cleaned = normalize(data)
    path = data_file()
    if path.is_file():
        backup_dir = gallery_root() / BACKUP_DIRNAME
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = f"library-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}.json"
        try:
            shutil.copy2(path, backup_dir / stamp)
            _prune_backups(backup_dir)
        except OSError:
            pass                              # 备份失败不阻塞正常保存
    tmp = path.with_name(DATA_FILE + ".tmp")
    tmp.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return cleaned


def resolve_image(rel: str) -> Path:
    """只允许读取 images/ 下的单个文件，杜绝 ../ 穿越。"""
    text = str(rel or "").strip().replace("\\", "/")
    if not text:
        raise ValueError("图片路径为空")
    parts = [part for part in text.split("/") if part]
    if len(parts) != 2 or parts[0] != IMAGES_DIRNAME:
        raise ValueError("非法图片路径")
    if not SAFE_IMAGE_NAME.match(parts[1]) or ".." in parts[1]:
        raise ValueError("非法图片文件名")
    return gallery_root(create=False) / IMAGES_DIRNAME / parts[1]


def thumbnail_bytes(content: bytes, filename: str = "") -> tuple[bytes, str]:
    """把任意图片压成「最长边 512px 的 JPEG 缩略图」，返回 (字节, 新文件名)。

    * 已经是达标的小 JPEG 时原样返回 —— 反复导入 / 导出不会越压越糊；
    * 透明 PNG / 调色板透明图先合成白底，否则 JPEG 会把透明区变黑；
    * GIF 只取第一帧（缩略图不需要动图），EXIF 旋转会被摆正；
    * 压缩后反而更大、图片损坏、或环境没有 Pillow 时原样返回，不阻断保存。
      前端上传前已用 canvas 做过一次缩略，所以降级路径也不会把原图写进磁盘。
    """
    original = Path(str(filename or "image.png")).name
    data = bytes(content or b"")
    if not HAS_PIL or not data:
        return data, original
    suffix = Path(original).suffix.lower()
    try:
        with Image.open(io.BytesIO(data)) as opened:
            opened.load()
            # 尺寸已达标的小 JPEG 一律原样返回：字节上限故意放宽到 4 倍，
            # 否则 512px 的高噪点图会每次导出都被重新编码、越压越糊。
            if (suffix in JPEG_SUFFIXES
                    and max(opened.size) <= THUMB_MAX_EDGE
                    and len(data) <= THUMB_MAX_BYTES * 4):
                return data, original
            frame = ImageOps.exif_transpose(opened)
            resampling = getattr(Image, "Resampling", Image)
            frame.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), resampling.LANCZOS)
            has_alpha = (frame.mode in ("RGBA", "LA")
                         or (frame.mode == "P" and "transparency" in frame.info))
            if has_alpha:
                rgba = frame.convert("RGBA")
                flat = Image.new("RGB", rgba.size, (255, 255, 255))
                flat.paste(rgba, mask=rgba.getchannel("A"))
                frame = flat
            else:
                frame = frame.convert("RGB")
            buffer = io.BytesIO()
            frame.save(buffer, format="JPEG", quality=THUMB_QUALITY,
                       optimize=True, progressive=True)
            out = buffer.getvalue()
            if not out or len(out) >= len(data):
                return data, original          # 极小图：压了反而更大就别动
            stem = (Path(original).stem or "thumb")[:60]
            return out, f"{stem}{THUMB_SUFFIX}"
    except (OSError, ValueError, TypeError, KeyError):
        return data, original                 # 坏图交给前端 onerror 占位处理


def save_image(filename: str, content: bytes) -> str:
    """上传一张图片：先转缩略图再落盘，返回可写进 library.json 的相对路径。"""
    if not isinstance(content, (bytes, bytearray)):
        raise ValueError("图片内容必须是二进制")
    if not content:
        raise ValueError("图片是空的")
    if len(content) > MAX_IMAGE_BYTES:
        raise ValueError(f"图片超过 {MAX_IMAGE_BYTES // 1024 // 1024} MB 上限")
    original = Path(str(filename or "")).name
    if Path(original).suffix.lower() not in IMAGE_EXTS:
        raise ValueError("只支持 png / jpg / jpeg / webp / gif / bmp 图片")
    thumb, name = thumbnail_bytes(bytes(content), original)
    suffix = Path(name).suffix.lower()
    if suffix not in IMAGE_EXTS:
        suffix = Path(original).suffix.lower()
    target = gallery_root() / IMAGES_DIRNAME / (uuid.uuid4().hex + suffix)
    target.write_bytes(thumb)
    return f"{IMAGES_DIRNAME}/{target.name}"


def content_type(path: Path) -> str:
    return {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
    }.get(path.suffix.lower(), "application/octet-stream")


# --------------------------------------------------------------------------- #
# 图库随机：让节点「生成」与随机开关都能改用图库卡片
# --------------------------------------------------------------------------- #
def build_prompt(data, config, randomize: bool = False, seed: int = 0,
                 random_seed=None):
    """从图库卡片里抽提示词，返回值与 core.build_prompt 对齐：(prompts, details)。

    config 里与图库有关的字段：
      galleryCats:    ["cat_cloth"]  勾选的分类（空 = 全部分类）
      galleryGroups:  ["grp_daily"]  勾选的分组（优先于分类，空 = 不限分组）
      galleryFav:     true           只从收藏里抽
      count:          一次抽几张卡片（默认 1）
      separator / prefix / suffix / extra：与词库模式共用的拼接设置
    """
    cfg = config if isinstance(config, dict) else {}
    clean = normalize(data)
    cat_map = {cat["id"]: cat for cat in clean["categories"]}
    selected_cats = [str(x) for x in (cfg.get("galleryCats") or [])
                     if isinstance(x, str) and x in cat_map]
    selected_groups = {str(x) for x in (cfg.get("galleryGroups") or [])
                       if isinstance(x, str)}
    fav_only = bool(cfg.get("galleryFav"))

    cards = [card for card in clean["cards"] if str(card.get("prompt") or "").strip()]
    if fav_only:
        cards = [card for card in cards if card["favorite"]]
    if selected_groups:
        cards = [card for card in cards if card["groupId"] in selected_groups]
    elif selected_cats:
        cards = [card for card in cards if card["categoryId"] in selected_cats]

    try:
        count = max(1, min(50, int(cfg.get("count", 1) or 1)))
    except (TypeError, ValueError):
        count = 1
    if not cards:
        return [""], ["图库为空，或当前随机范围内没有带提示词的卡片"]

    if randomize:
        rng = random.Random(random_seed) if random_seed is not None else random.Random()
        picked = (rng.sample(cards, min(count, len(cards)))
                  if count <= len(cards)
                  else [rng.choice(cards) for _ in range(count)])
    else:
        # 非随机模式保持卡片自然顺序，便于新节点初始填充可复现
        picked = cards[:count]

    parts = [card["prompt"].strip() for card in picked]
    extra = str(cfg.get("extra", "") or "").strip()
    if extra:
        parts.append(extra)
    text = core.compose(parts, cfg.get("separator", ", "),
                        cfg.get("prefix", ""), cfg.get("suffix", ""))

    detail_lines = []
    for card in picked:
        cat = cat_map.get(card["categoryId"], {})
        group_name = next((g["name"] for g in cat.get("groups", [])
                           if g["id"] == card["groupId"]), "")
        label = cat.get("name", "未分类") + (f" / {group_name}" if group_name else "")
        snippet = card["prompt"].strip().replace("\n", " ")[:40]
        detail_lines.append(f"{label} → {snippet}")
    return [text], ["\n".join(detail_lines)]


# --------------------------------------------------------------------------- #
# 导入 / 导出：一个 ZIP 带走 library.json + 引用到的图片
# --------------------------------------------------------------------------- #
def export_zip(category_id: str = "", group_id: str = "") -> bytes:
    """打包整个图库，或只打包某个分类 / 某个分类下的分组。

    子集包里的 library.json 只保留筛选后的分类 / 分组 / 卡片，图片也只带这些卡片
    引用到的文件，因此可以直接用「⬆ 导入」合并或覆盖还原，不会出现孤立引用。
    打包时再过一次 thumbnail_bytes()：即使磁盘上还留着升级前的原图，导出包里也
    一定是缩略图；这一步只在内存里改引用，不改动本机文件。
    """
    data = load_gallery()
    category_id, group_id = str(category_id or "").strip(), str(group_id or "").strip()
    scope = "整个图库"
    if category_id or group_id:
        categories = data["categories"]
        if group_id and not category_id:
            # 只给了组：反查它属于哪个分类，避免导出别的分类下的同 id 组
            category_id = next(
                (cat["id"] for cat in categories
                 if any(g["id"] == group_id for g in cat["groups"])), "")
        if not category_id:
            raise ValueError("所选分组不存在，请刷新图库后重试")
        picked = next((cat for cat in categories if cat["id"] == category_id), None)
        if picked is None:
            raise ValueError("所选分类不存在，请刷新图库后重试")
        scope = picked["name"]
        groups = picked["groups"]
        if group_id:
            groups = [g for g in groups if g["id"] == group_id]
            if not groups:
                raise ValueError("所选分组不存在，请刷新图库后重试")
            scope += " / " + groups[0]["name"]
        data = dict(data,
                    categories=[dict(picked, groups=groups)],
                    cards=[card for card in data["cards"]
                           if card["categoryId"] == category_id
                           and (not group_id or card["groupId"] == group_id)])
    # 先处理图片再写 library.json：若某张历史大图在本包里被换成了 .jpg，
    # JSON 里的 image 字段必须同步指向包内的新文件名，否则导入后引用悬空。
    remap = {}
    payloads = []
    used = sorted({card["image"] for card in data["cards"] if card["image"]})
    for rel in used:
        try:
            path = resolve_image(rel)
            if not path.is_file():
                continue
            raw = path.read_bytes()
        except (ValueError, OSError):
            continue
        thumb, name = thumbnail_bytes(raw, path.name)
        if thumb == raw:
            payloads.append((rel, path))         # 已是缩略图：直接按原路径写文件
            continue
        # 基于原相对路径生成稳定名字，避免两个不同目录的同名图互相覆盖
        digest = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]
        out_rel = f"{IMAGES_DIRNAME}/{digest}{Path(name).suffix.lower()}"
        remap[rel] = out_rel
        payloads.append((out_rel, thumb))

    if remap:
        for card in data["cards"]:
            if card.get("image") in remap:
                card["image"] = remap[card["image"]]

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(DATA_FILE,
                         (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        for rel, blob in payloads:
            if isinstance(blob, Path):
                archive.write(blob, rel)
            else:
                archive.writestr(rel, blob)
        archive.writestr("README.txt", (
            "Sinheo 图库导出\n"
            f"导出范围：{scope}\n"
            "library.json = 分类 / 分组 / 卡片 / 收藏（纯文本元数据）\n"
            f"images/ = 卡片引用的缩略图（最长边 {THUMB_MAX_EDGE}px 的 JPEG，只用于辨认效果）\n"
            "在图库管理里点「⬆ 导入」选择本 ZIP，可合并导入或覆盖导入（覆盖前自动备份）。\n"
        ).encode("utf-8"))
    return buffer.getvalue()


def _read_archive(content, filename: str = ""):
    """返回 (元数据 dict, {images/原名: bytes})；只认安全文件名。"""
    if not isinstance(content, (bytes, bytearray)) or not content:
        raise ValueError("导入文件是空的")
    raw_bytes = bytes(content)
    stripped = raw_bytes.lstrip()
    name = str(filename or "").lower()

    if name.endswith(".json") or stripped.startswith(b"{"):
        try:
            return json.loads(stripped.decode("utf-8-sig")), {}
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValueError(f"JSON 解析失败：{exc}") from exc

    if not zipfile.is_zipfile(io.BytesIO(raw_bytes)):
        raise ValueError("只支持 .zip 图库包或 .json 元数据文件")

    raw, images = None, {}
    total = 0
    with zipfile.ZipFile(io.BytesIO(raw_bytes)) as archive:
        for info in archive.infolist():
            parts = [p for p in info.filename.replace("\\", "/").split("/")
                     if p and p not in (".", "..")]
            if not parts or parts[0].startswith("__"):
                continue
            safe = "/".join(parts)
            if safe == DATA_FILE or (len(parts) == 1
                                     and parts[0].lower().endswith(".json")):
                if raw is None:
                    try:
                        raw = json.loads(archive.read(info).decode("utf-8-sig"))
                    except (UnicodeDecodeError, ValueError) as exc:
                        raise ValueError(f"包里的 library.json 解析失败：{exc}") from exc
                continue
            if (len(parts) == 2 and parts[0] == IMAGES_DIRNAME
                    and SAFE_IMAGE_NAME.match(parts[1]) and ".." not in parts[1]
                    and Path(parts[1]).suffix.lower() in IMAGE_EXTS
                    and info.file_size <= MAX_IMAGE_BYTES
                    and total + info.file_size <= MAX_ARCHIVE_BYTES):
                blob = archive.read(info)
                images[parts[1]] = blob
                total += len(blob)
    if raw is None:
        raise ValueError("ZIP 里找不到 library.json")
    return raw, images


def backup_gallery(label: str = "replace") -> str:
    """覆盖导入前整库备份（含图片），排除 .backup 自身避免递归。"""
    root = gallery_root()
    target = (root / BACKUP_DIRNAME /
              f"{label}-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(root, target, ignore=shutil.ignore_patterns(BACKUP_DIRNAME))
    return str(target)


def import_archive(content, filename: str = "", merge: bool = True) -> dict:
    """导入图库包。merge=True 合并（id 冲突自动换新），False 覆盖（先整库备份）。

    ZIP 里的图片会先转成缩略图、再用新的随机名落盘，既避免覆盖本机同名图片，
    也不会因为导入了别人包含原图的旧包又把磁盘撑大。
    """
    raw, images = _read_archive(content, filename)

    image_map = {}
    if images:
        folder = gallery_root() / IMAGES_DIRNAME
        folder.mkdir(parents=True, exist_ok=True)
        for original, blob in images.items():
            thumb, name = thumbnail_bytes(blob, original)
            suffix = Path(name).suffix.lower()
            if suffix not in IMAGE_EXTS:
                suffix = Path(original).suffix.lower()
            new_name = uuid.uuid4().hex + suffix
            (folder / new_name).write_bytes(thumb)
            image_map[f"{IMAGES_DIRNAME}/{original}"] = f"{IMAGES_DIRNAME}/{new_name}"

    if isinstance(raw, dict) and isinstance(raw.get("cards"), list):
        for card in raw["cards"]:
            if isinstance(card, dict) and card.get("image") in image_map:
                card["image"] = image_map[card["image"]]
    incoming = normalize(raw)

    backup = ""
    if merge:
        base = load_gallery()
        cat_map, group_map = {}, {}
        existing_groups = {g["id"] for cat in base["categories"] for g in cat["groups"]}
        existing_cats = {cat["id"] for cat in base["categories"]}
        for cat in incoming["categories"]:
            old_cat = cat["id"]
            if old_cat in existing_cats:
                cat["id"] = uid("cat")
            cat_map[old_cat] = cat["id"]
            for group in cat["groups"]:
                old_group = group["id"]
                if old_group in existing_groups:
                    group["id"] = uid("grp")
                group_map[old_group] = group["id"]
        existing_cards = {card["id"] for card in base["cards"]}
        for card in incoming["cards"]:
            if card["id"] in existing_cards:
                card["id"] = uid("card")
            if card["categoryId"] in cat_map:
                card["categoryId"] = cat_map[card["categoryId"]]
            if card["groupId"] in group_map:
                card["groupId"] = group_map[card["groupId"]]
            base["cards"].append(card)
        base["categories"].extend(incoming["categories"])
        saved = save_gallery(base)
    else:
        backup = backup_gallery()
        saved = save_gallery(incoming)

    return {
        "mode": "merge" if merge else "replace",
        "categories": len(incoming["categories"]),
        "cards": len(incoming["cards"]),
        "images": len(image_map),
        "backup": backup,
        "total": len(saved["cards"]),
    }
