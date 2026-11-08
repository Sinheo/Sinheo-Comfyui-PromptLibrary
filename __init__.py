"""
Sinheo-Comfyui-PromptLibrary —— 属于 Sinheo 的文字提示词加载节点。

插件代码：ComfyUI/custom_nodes/Sinheo-Comfyui-PromptLibrary/
提示词数据：ComfyUI/models/Sinheo/prompts/  （大类/小类.txt，一个小类一个 TXT）

节点 Sinheo 加载文本：
  * 随机「关」：只输出节点文本框里的提示词（可手改；点「生成」手动随机抽一批填进文本框）
  * 随机「开」：每次运行按「勾选菜单」重新随机抽词，文本框内容不参与输出
  * 大类上的 🎲 可让它每次随机抽一个小类；「生成」仅随机「关」时可用，
    「复制」随时可用（随机模式下复制的是本次运行产生的提示词）；
  * 「＋ 添加到」把当前提示词按行追加到勾选的小类 TXT，不覆盖原有内容。
"""
from __future__ import annotations

import hashlib
import json
import time
import zipfile

from aiohttp import web
from comfy_api.latest import IO, ComfyExtension
from server import PromptServer

from . import sinheo_core as core

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
            description="随机关闭时只输出节点文本框里的提示词（可点「生成」随机抽词并手动修改）；"
                        "随机开启时每次运行自动重新抽词，文本框不参与输出。",
            search_aliases=["Sinheo", "提示词", "prompt", "词库"],
            inputs=[
                IO.String.Input(
                    "manual_text", display_name="文本框", default="", multiline=True,
                    socketless=True,
                    tooltip="节点面板下方文本框的内容，由前端维护；随机关闭时原样输出。",
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
    def fingerprint_inputs(cls, config, manual_text):
        cfg = core.parse_config(config)
        if cfg.get("randomize"):
            # 每次排队都重新随机抽词
            return float("nan")
        # 随机关闭：输出只取决于文本框内容与配置，改词库 TXT 不会导致无谓重跑
        payload = f"{config or ''}|{manual_text or ''}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    @classmethod
    def execute(cls, config, manual_text):
        cfg = core.parse_config(config)
        if not cfg.get("randomize"):
            # 文本框模式：完全按用户看到（并可能手改过）的文字输出
            text = str(manual_text or "")
            detail = "文本框模式：只输出节点文本框里的提示词（随机开关关闭；点「生成」可重新随机抽词）"
            return IO.NodeOutput(text, detail,
                                 ui={"sinheo_text": [text], "sinheo_detail": [detail]})

        # 随机模式：忽略文本框，按勾选菜单重新抽词
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


def _zip_response(data: bytes):
    filename = "Sinheo_prompts_" + time.strftime("%Y%m%d-%H%M%S") + ".zip"
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
