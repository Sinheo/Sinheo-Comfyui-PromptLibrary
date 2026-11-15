"""
Sinheo-Comfyui-PromptLibrary —— 属于 Sinheo 的文字提示词加载节点。

插件代码：ComfyUI/custom_nodes/Sinheo-Comfyui-PromptLibrary/
提示词数据：ComfyUI/models/Sinheo/prompts/  （大类/小类.txt，一个小类一个 TXT）

节点 Sinheo 加载文本：
  * 随机「关」：只输出节点文本框里的提示词（可手改；点「生成」手动随机抽一批填进文本框）
  * 随机「开」：每次运行按「勾选菜单」重新随机抽词，文本框内容不参与输出
  * 大类上的 🎲 可让它每次随机抽一个小类；「生成」仅随机「关」时可用，
    「复制」随时可用（随机模式下复制的是本次运行产生的提示词）；
  * 「＋ 添加到图库」把当前提示词 + 最近生成的图片存成图库卡片（图片只存 512px 缩略图）：
  *    「抓取最近生成图」以服务端 /history 的真实 outputs 为主，只认 output / temp，
  *    绝不把 LoadImage 的 type=input 原图当成生成图；后端磁盘兜底也只扫 output。
  *    上传 / 导入 / 导出统一走缩略图（最长边 512px、JPEG q82），磁盘上只会是缩略图；
  *    导出在面板里填本机目录，由 /export_to 直接写盘，并把目录记住；
  *    可选按分类 / 分组只打包子集（library.json 与 images/ 一起裁剪）；
  *    由网页发起的下载（blob: / <a download> / attachment 直链）与系统「另存为」
  *    在当前 Edge / 内嵌窗口环境里都会被拦下，与文件大小无关，已从图库面板移除；
  *    export_blob / export_info / download 路由仅作兼容保留。
  * 「类型」菜单可切换随机数据源：词库（TXT 词条）/ 图库（卡片提示词）。
  * 可选输入 external_text：接入任意文本节点的 STRING 输出，直接当作提示词输出，
    优先级高于随机开关与节点自带文本框。
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import zipfile
from pathlib import Path
from urllib.parse import quote

import folder_paths
from aiohttp import web
from comfy_api.latest import IO, ComfyExtension
from server import PromptServer

from . import sinheo_core as core
from . import sinheo_gallery as gallery

WEB_DIRECTORY = "./web"
__all__ = ["WEB_DIRECTORY", "comfy_entrypoint"]

routes = PromptServer.instance.routes


# --------------------------------------------------------------------------- #
# 节点
# --------------------------------------------------------------------------- #
class SinheoLoadText(IO.ComfyNode):
    """紧凑的文字版图库选择器：勾选 -> 拼接 -> STRING。"""

    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SinheoLoadText",
            display_name="Sinheo 加载文本",
            category="Sinheo/文本",
            description="可接入其它文本节点的 STRING 输出（external_text），连线后直接把该文本当作提示词输出；"
                        "未接外部文本时，随机关闭只输出节点文本框、随机开启按词库 / 图库自动抽词。",
            search_aliases=["Sinheo", "提示词", "prompt", "词库", "text", "字符串"],
            inputs=[
                IO.String.Input(
                    "external_text", display_name="外部文本", optional=True,
                    force_input=True, socketless=False,
                    tooltip="接入任意文本节点的 STRING 输出；连线后直接输出这段提示词，"
                            "忽略随机开关、类型菜单和节点文本框。",
                ),
                IO.String.Input(
                    "manual_text", display_name="文本框", default="", multiline=True,
                    socketless=True,
                    tooltip="节点面板下方文本框的内容，由前端维护；未接外部文本且随机关闭时原样输出。",
                ),
                IO.String.Input(
                    "config", display_name="配置", default="{}", socketless=True,
                    extra_dict={"hidden": True},
                    tooltip="由节点面板自动维护：勾选、随机、顺序、分隔符等。",
                ),
            ],
            outputs=[
                IO.String.Output(display_name="prompt"),
                IO.String.Output(display_name="detail"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, config, manual_text, external_text=None):
        # 外部文本接入后，输出只取决于上游文本；必须纳入指纹，否则改上游不会重跑
        if external_text is not None and str(external_text) != "":
            return hashlib.sha256(("external|" + str(external_text)).encode("utf-8")).hexdigest()
        cfg = core.parse_config(config)
        if cfg.get("randomize"):
            # 每次排队都重新随机抽词
            return float("nan")
        # 随机关闭：输出只取决于文本框内容与配置，改词库 TXT 不会导致无谓重跑
        payload = f"{config or ''}|{manual_text or ''}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    @classmethod
    def execute(cls, config, manual_text, external_text=None):
        # 外部文本优先级最高：接了上游文本节点就完全当普通文本透传
        if external_text is not None and str(external_text) != "":
            text = str(external_text)
            detail = "外部文本输入：直接输出连线传入的提示词（随机开关、类型菜单、节点文本框均已忽略）"
            return IO.NodeOutput(text, detail,
                                 ui={"sinheo_text": [text], "sinheo_detail": [detail]})
        cfg = core.parse_config(config)
        if not cfg.get("randomize"):
            # 文本框模式：完全按用户看到（并可能手改过）的文字输出
            text = str(manual_text or "")
            detail = "文本框模式：只输出节点文本框里的提示词（随机开关关闭；点「生成」可重新随机抽词）"
            return IO.NodeOutput(text, detail,
                                 ui={"sinheo_text": [text], "sinheo_detail": [detail]})

        # 随机模式：忽略文本框，按「类型」里选中的数据源重新抽词
        if str(cfg.get("source") or "library") == "gallery":
            prompts, details = gallery.build_prompt(
                gallery.load_gallery(), cfg, randomize=True)
            text = "\n\n".join(prompts)
            detail = "\n\n".join(details)
            return IO.NodeOutput(text, detail,
                                 ui={"sinheo_text": [text], "sinheo_detail": [detail]})
        library = core.scan_library()
        prompts, details = core.build_prompt(library, cfg, randomize=True)
        text = "\n\n".join(prompts)
        detail = "\n\n".join(details)
        if not library["categories"]:
            detail = (f"词库为空：请把 TXT 放到 {library['root']} 下，"
                      "大类文件夹 / 小类.txt（一行一条）。")
        return IO.NodeOutput(text, detail,
                             ui={"sinheo_text": [text], "sinheo_detail": [detail]})


class SinheoExtension(ComfyExtension):
    async def get_node_list(self):
        return [SinheoLoadText]


async def comfy_entrypoint():
    return SinheoExtension()


# --------------------------------------------------------------------------- #
# HTTP API（前端面板 / 管理弹窗）
# --------------------------------------------------------------------------- #
# 导出包：先落盘，再用 FileResponse 提供下载（支持 Range / HEAD / 条件请求）。
# 浏览器下载管理器对 Range 请求很敏感，web.Response(body=bytes) 会忽略 Range，
# 容易报「无法从网站上提取文件」；FileResponse 由 aiohttp 原生处理。
EXPORT_NAME_RE = re.compile(r"^Sinheo_gallery_\d{8}-\d{6}(?:-\d+)?\.zip$")


def _export_dir() -> Path:
    folder = Path(folder_paths.get_output_directory()) / "Sinheo" / "exports"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _write_gallery_export() -> dict:
    """生成 ZIP 并保存到 ComfyUI/output/Sinheo/exports/，返回下载元信息。"""
    payload = gallery.export_zip()
    folder = _export_dir()
    stem = "Sinheo_gallery_" + time.strftime("%Y%m%d-%H%M%S")
    target = folder / f"{stem}.zip"
    index = 1
    while target.exists():
        target = folder / f"{stem}-{index}.zip"
        index += 1
    target.write_bytes(payload)
    name = target.name
    return {
        "filename": name,
        "path": str(target),
        "size": len(payload),
        "download": "/sinheo/gallery/download?name=" + quote(name),
        "view": "/view?filename=" + quote(name)
                 + "&subfolder=Sinheo%2Fexports&type=output",
    }


def _resolve_export(name: str) -> Path:
    if not EXPORT_NAME_RE.fullmatch(name or ""):
        raise ValueError("非法的导出文件名")
    path = _export_dir() / name
    if not path.is_file():
        raise FileNotFoundError("导出文件不存在，请重新点「导出」")
    return path


def _zip_file_response(path: Path):
    return web.FileResponse(path, headers={
        "Content-Type": "application/zip",
        "Content-Disposition": f'attachment; filename="{path.name}"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    })


def _json(data, status=200):
    return web.json_response(
        data, status=status,
        dumps=lambda obj: json.dumps(obj, ensure_ascii=False),
    )


def _error(exc, status=400):
    return _json({"error": str(exc)}, status=status)


@routes.get("/sinheo/library")
async def api_library(request):
    try:
        return _json(core.scan_library())
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/generate")
async def api_generate(request):
    """节点「生成」按钮：{config, random} -> {text, detail}。

    random=true 每次重新随机抽词；random=false 按菜单顺序取第一条（新节点初始填充用）。
    只负责生成文本，不改动文本框 widget，由前端决定是否写回。
    """
    try:
        body = await request.json()
        cfg = core.parse_config(body.get("config") or {})
        randomize = bool(body.get("random", True))
        try:
            seed = int(cfg.get("seed", 0) or 0)
        except (TypeError, ValueError):
            seed = 0
        if str(cfg.get("source") or "library") == "gallery":
            prompts, details = gallery.build_prompt(
                gallery.load_gallery(), cfg, randomize=randomize, seed=seed)
            return _json({"text": "\n\n".join(prompts),
                          "detail": "\n\n".join(details),
                          "empty": not prompts or not prompts[0].strip()})
        library = core.scan_library()
        prompts, details = core.build_prompt(library, cfg, randomize=randomize, seed=seed)
        return _json({"text": "\n\n".join(prompts), "detail": "\n\n".join(details),
                      "empty": not library["categories"]})
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/save")
async def api_save(request):
    """保存一个小类 TXT：{rel: "上衣/甜美.txt", content, merge}"""
    try:
        body = await request.json()
        return _json(core.save_file(body.get("rel", ""), body.get("content", ""),
                                   merge=bool(body.get("merge", False))))
    except (ValueError, OSError, FileExistsError) as exc:
        return _error(exc)
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/create")
async def api_create(request):
    """新建大类 / 小类（小类就是一个 TXT）。"""
    try:
        body = await request.json()
        kind = body.get("kind", "")
        if kind == "group":
            return _json(core.create_group(body.get("name", "")))
        if kind == "category":
            return _json(core.create_category(body.get("group", ""), body.get("name", "")))
        raise ValueError("未知的创建类型")
    except (ValueError, OSError, FileExistsError) as exc:
        return _error(exc)
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/append")
async def api_append(request):
    """节点「＋ 添加到」：{rels: ["上衣/甜美.txt"], text} -> 追加词条（去重、不覆盖）。"""
    try:
        body = await request.json()
        return _json(core.append_items(body.get("rels", []), body.get("text", "")))
    except (ValueError, OSError, FileExistsError) as exc:
        return _error(exc)
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/delete")
async def api_delete(request):
    """删除文件/文件夹，删除前自动备份到 .backup。"""
    try:
        body = await request.json()
        return _json(core.delete_path(body.get("rel", "")))
    except (ValueError, FileNotFoundError, OSError) as exc:
        return _error(exc)
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/order")
async def api_order(request):
    """把勾选菜单里的手动顺序存成词库默认顺序（新建节点继承）。"""
    try:
        body = await request.json()
        return _json(core.save_order(body.get("groups", []), body.get("categories", {})))
    except (ValueError, OSError) as exc:
        return _error(exc)
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/import")
async def api_import(request):
    """导入 TXT / ZIP；可指定导入到某个大类。"""
    try:
        form = await request.post()
        field = form.get("file")
        if field is None or not hasattr(field, "file"):
            raise ValueError("没有收到文件")
        name = getattr(field, "filename", "") or "import.txt"
        content = field.file.read()
        merge = str(form.get("merge", "1")) not in ("0", "false", "False")
        group = str(form.get("group", "") or "")
        if name.lower().endswith(".zip"):
            return _json(core.import_zip(content, merge=merge, group=group))
        return _json(core.import_text(name, content, merge=merge, group=group))
    except (ValueError, OSError, zipfile.BadZipFile) as exc:
        return _error(exc)
    except Exception as exc:
        return _error(exc, 500)


def _zip_response(data: bytes, prefix="Sinheo_prompts_"):
    filename = prefix + time.strftime("%Y%m%d-%H%M%S") + ".zip"
    return web.Response(
        body=data,
        content_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(data)),
            "Cache-Control": "no-store",
        },
    )


@routes.get("/sinheo/export")
async def api_export_all(request):
    """兼容旧调用：导出整个词库。"""
    try:
        return _zip_response(core.export_zip())
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/export")
async def api_export_selection(request):
    """按导出弹窗里勾选的大类 / 小类打包：{selection: ["上衣", "发型/发色"]}。"""
    try:
        try:
            body = await request.json()
        except Exception:
            body = {}
        selection = body.get("selection") if isinstance(body, dict) else None
        return _zip_response(core.export_zip(selection))
    except ValueError as exc:
        return _error(exc)
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/migrate")
async def api_migrate(request):
    """手动把旧版「大类/小类文件夹/*.txt」展平成「大类/小类.txt」（带备份）。"""
    try:
        return _json(core.migrate_legacy_layout())
    except Exception as exc:
        return _error(exc, 500)


# --------------------------------------------------------------------------- #
# 词库：重命名 / 批量删除
# --------------------------------------------------------------------------- #
@routes.post("/sinheo/rename")
async def api_rename(request):
    """重命名大类或小类：{rel: "服饰" | "服饰/日常.txt", name: "新名字"}。"""
    try:
        body = await request.json()
        return _json(core.rename_path(body.get("rel", ""), body.get("name", "")))
    except (ValueError, OSError, FileNotFoundError, FileExistsError) as exc:
        return _error(exc)
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/delete_batch")
async def api_delete_batch(request):
    """批量删除：{rels: ["服饰", "发型/发色.txt"]}，统一备份、自动去重。"""
    try:
        body = await request.json()
        return _json(core.delete_paths(body.get("rels", [])))
    except (ValueError, OSError, FileNotFoundError) as exc:
        return _error(exc)
    except Exception as exc:
        return _error(exc, 500)


# --------------------------------------------------------------------------- #
# 图库：分类 / 分组 / 卡片 / 图片
# --------------------------------------------------------------------------- #
@routes.get("/sinheo/gallery")
async def api_gallery_get(request):
    try:
        return _json(gallery.load_gallery())
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/gallery/save")
async def api_gallery_save(request):
    """整体保存图库数据（编辑分类 / 卡片 / 收藏 / 显示设置后调用）。"""
    try:
        body = await request.json()
        return _json(gallery.save_gallery(body))
    except (ValueError, OSError) as exc:
        return _error(exc)
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/gallery/image")
async def api_gallery_image_upload(request):
    """上传卡片图片（multipart: file），返回 {"file": "images/xxx.png"}。"""
    try:
        form = await request.post()
        field = form.get("file")
        if field is None or not hasattr(field, "file"):
            raise ValueError("没有收到图片文件")
        name = getattr(field, "filename", "") or "image.png"
        rel = gallery.save_image(name, field.file.read())
        return _json({"file": rel})
    except (ValueError, OSError) as exc:
        return _error(exc)
    except Exception as exc:
        return _error(exc, 500)


@routes.get("/sinheo/gallery/image")
async def api_gallery_image_get(request):
    """读取卡片缩略图：/sinheo/gallery/image?file=images/xxx.jpg"""
    try:
        path = gallery.resolve_image(request.query.get("file", ""))
        if not path.is_file():
            raise FileNotFoundError("图片不存在")
        return web.FileResponse(
            path,
            headers={"Cache-Control": "no-cache", "Content-Type": gallery.content_type(path)},
        )
    except (ValueError, OSError, FileNotFoundError) as exc:
        return _error(exc, 404)
    except Exception as exc:
        return _error(exc, 500)


# --------------------------------------------------------------------------- #
# 最近生成图：不依赖前端 app.nodeOutputs 的结构，服务端直接按磁盘找
# --------------------------------------------------------------------------- #
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"}


def _resolve_requested_image(filename: str, subfolder: str, image_type: str) -> Path | None:
    """把前端传来的 filename/subfolder/type 解析成本地图片；任何异常都返回 None。

    ComfyUI 1.5x 的执行结果里 filename 可能是普通文件名，也可能带 [output] 注解；
    blake3: 开头的 asset hash 交给前端的 /view 处理，这里不解析。
    """
    filename = str(filename or "")
    if not filename or filename.startswith("blake3:"):
        return None
    # type=input 是「加载图像」节点的输入原图，绝对不能当成最近生成图返回
    if str(image_type or "").lower() == "input":
        return None
    try:
        filename, output_dir = folder_paths.annotated_filepath(filename)
    except Exception:
        output_dir = None
    if not filename or filename.startswith("/") or ".." in filename:
        return None
    name = Path(filename.replace("\\", "/")).name
    if not name or Path(name).suffix.lower() not in IMAGE_SUFFIXES:
        return None
    if output_dir is None:
        # 只放行工作流产出目录：output（SaveImage）/ temp（PreviewImage）
        if image_type not in ("output", "temp"):
            image_type = "output"
        output_dir = folder_paths.get_directory_by_type(image_type)
    if not output_dir:
        return None
    root = Path(output_dir).resolve()
    sub = str(subfolder or "").replace("\\", "/")
    target = (root / sub / name).resolve() if sub else (root / name).resolve()
    # 防目录穿越：解析后的文件必须还在该类型目录里
    if not target.is_relative_to(root) or not target.is_file():
        return None
    return target


def _iter_image_files(root: Path):
    """递归列出目录下的图片（跳过插件自己的 Sinheo 导出目录）。"""
    if not root.is_dir():
        return
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        try:
            rel = path.relative_to(root)
            if rel.parts and rel.parts[0] == "Sinheo":
                continue
            yield path.stat().st_mtime, path
        except (OSError, ValueError):
            continue


def _latest_image_on_disk() -> Path | None:
    """只扫描 output（含子目录），取修改时间最新的那张图。

    刻意不扫 temp / input：ComfyUI 会把上传、加载的原图和各种预览副本放进
    temp，扫了就会把「加载图像」的输入图误当成最近生成图。temp 类型的真实
    预览图由前端从 /history 拿到 filename 后，走 _resolve_requested_image 精确解析。
    即使刷新过页面、app.nodeOutputs 为空，磁盘上的生成图仍在。
    """
    fn = getattr(folder_paths, "get_output_directory", None)
    if fn is None:
        return None
    try:
        root = Path(fn())
    except Exception:
        return None
    best = None
    for mtime, path in _iter_image_files(root):
        if best is None or mtime > best[0]:
            best = (mtime, path)
    return best[1] if best else None


@routes.get("/sinheo/gallery/latest_image")
async def api_gallery_latest_image(request):
    """返回最近一次生成的图片：先按参数精确找，找不到就扫磁盘取最新的一张。"""
    query = request.query
    path = _resolve_requested_image(
        query.get("filename", ""), query.get("subfolder", ""),
        query.get("type", "output"))
    if path is None:
        path = _latest_image_on_disk()
    if path is None or not path.is_file():
        return _error("没找到最近生成的图片：请先运行一次工作流，或点「选择文件」手动选一张本地图片", 404)
    return web.FileResponse(path, headers={
        "Content-Type": gallery.content_type(path),
        "Cache-Control": "no-store",
        "X-Sinheo-Image": quote(path.name),
        "X-Content-Type-Options": "nosniff",
    })


@routes.get("/sinheo/gallery/export_dir")
async def api_gallery_export_dir(request):
    """给导出面板预填一个本机绝对路径，用户可以改成任意位置。

    只返回路径，不打包 ZIP：面板打开时不应该先花时间生成一个 10 MB 的包。
    """
    return _json({
        "dir": str(_export_dir()),
        "filename": "Sinheo_gallery_" + time.strftime("%Y%m%d-%H%M%S") + ".zip",
    })


@routes.get("/sinheo/gallery/export_blob")
async def api_gallery_export_blob(request):
    """把 ZIP 直接作为二进制返回，不在服务端 output 目录落盘。

    兼容旧前端保留：当前图库导出面板已改走 /export_to 写盘，不再调用本路由。
    旧版落盘链路（/export_info → /download）同样只是兼容保留。
    """
    try:
        payload = gallery.export_zip()
        name = "Sinheo_gallery_" + time.strftime("%Y%m%d-%H%M%S") + ".zip"
        return web.Response(body=payload, headers={
            "Content-Type": "application/zip",
            "Content-Disposition": f'attachment; filename="{name}"',
            "Content-Length": str(len(payload)),
            "Cache-Control": "no-store",
            "X-Sinheo-Filename": quote(name),
            "X-Content-Type-Options": "nosniff",
        })
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/gallery/export_to")
async def api_gallery_export_to(request):
    """按用户填写的本机绝对路径把 ZIP 写盘（图库导出唯一主路径）。"""
    try:
        body = await request.json()
    except Exception:
        return _error("请求不是合法 JSON", 400)
    body = body or {}
    raw = str(body.get("path") or "").strip().strip('"')
    suggested = str(body.get("filename") or "").strip()
    # 导出范围：空 = 整个图库；也可只导某个分类，或该分类下的某个分组
    category = str(body.get("category") or "").strip()
    group = str(body.get("group") or "").strip()
    # 用户在面板里明确选了同一个文件 / 文件夹时允许覆盖；不传则保持旧的防误覆盖行为
    overwrite = bool(body.get("overwrite"))
    if not raw:
        return _error("请先填写保存位置", 400)
    target = Path(raw)
    if not target.is_absolute():
        return _error("请填写绝对路径，例如 D:\\ComfyUI备份\\", 400)
    try:
        default_name = Path(suggested).name if suggested else ""
        if not default_name.lower().endswith(".zip"):
            default_name = ""
        if target.is_dir() or not target.suffix:
            # 填的是文件夹：自动补一个不会覆盖旧包的 zip 文件名
            target.mkdir(parents=True, exist_ok=True)
            target = target / (default_name or
                               "Sinheo_gallery_" + time.strftime("%Y%m%d-%H%M%S") + ".zip")
        elif target.suffix.lower() != ".zip":
            return _error("保存位置必须是文件夹，或以 .zip 结尾的文件名", 400)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and not overwrite:
            return _error(f"文件已存在，请换一个名字：{target}", 400)
        payload = gallery.export_zip(category_id=category, group_id=group)
        target.write_bytes(payload)
    except ValueError as exc:
        return _error(str(exc), 400)
    except OSError as exc:
        return _error(f"写入失败：{exc}", 400)
    return _json({"ok": True, "filename": target.name,
                  "path": str(target), "size": len(payload)})


@routes.get("/sinheo/gallery/export")
async def api_gallery_export(request):
    """兼容入口：地址栏直接打开也能下载（落盘 + FileResponse）。"""
    try:
        info = _write_gallery_export()
        return _zip_file_response(Path(info["path"]))
    except Exception as exc:
        return _error(exc, 500)


@routes.get("/sinheo/gallery/export_info")
async def api_gallery_export_info(request):
    """生成导出包并返回 {filename, path, size, download, view}，不返回二进制。"""
    try:
        return _json(_write_gallery_export())
    except Exception as exc:
        return _error(exc, 500)


@routes.get("/sinheo/gallery/download")
async def api_gallery_download(request):
    """下载已生成的导出包：/sinheo/gallery/download?name=Sinheo_gallery_xxx.zip"""
    try:
        return _zip_file_response(_resolve_export(request.query.get("name", "")))
    except (ValueError, FileNotFoundError, OSError) as exc:
        return _error(exc, 404)
    except Exception as exc:
        return _error(exc, 500)


@routes.post("/sinheo/gallery/import")
async def api_gallery_import(request):
    """导入图库（multipart: file + mode=merge|replace）。"""
    try:
        form = await request.post()
        field = form.get("file")
        if field is None or not hasattr(field, "file"):
            raise ValueError("没有收到图库文件")
        name = getattr(field, "filename", "") or "library.zip"
        merge = str(form.get("mode", "merge")) != "replace"
        return _json(gallery.import_archive(field.file.read(), name, merge=merge))
    except (ValueError, OSError, zipfile.BadZipFile) as exc:
        return _error(exc)
    except Exception as exc:
        return _error(exc, 500)
