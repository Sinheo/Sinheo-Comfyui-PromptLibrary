"""「抓取最近生成图」服务端逻辑单测（纯 Python mock，不需要 ComfyUI）。

覆盖：路由注册（含默认目录 / 不落盘导出 / 按路径导出）、filename/subfolder/type 精确解析、
      拒绝 type=input 的「加载图像」原图、目录穿越与非图片拒绝、
      只扫 output 取 mtime 最新（不碰 temp / input）、handler 返回 FileResponse / 404。

    python tests/test_latest_image.py
"""
from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
TMP = Path(tempfile.mkdtemp(prefix="sinheo_latest_test_"))

# ---- mock ComfyUI 依赖，让插件 __init__.py 能在纯 Python 里加载 ----
fp = types.ModuleType("folder_paths")
fp.models_dir = str(TMP)
fp._folders = {}
fp.add_model_folder_path = lambda *a, **k: None
fp.get_folder_paths = lambda key: list(fp._folders.get(key, []))
fp._roots = {}
fp.get_output_directory = lambda: str(fp._roots["output"])
fp.get_temp_directory = lambda: str(fp._roots["temp"])
fp.get_directory_by_type = lambda kind: str(fp._roots.get(kind) or fp._roots["output"])
fp.annotated_filepath = lambda name: (name, None)   # 本用例不涉及 [output] 注解
# sinheo_core 是「延迟 import folder_paths」，会取 sys.modules 里的当前对象。
# 这里只在加载插件的瞬间替换，加载完立刻还给其它测试文件，避免污染它们的临时目录。
_PREVIOUS_FOLDER_PATHS = sys.modules.get("folder_paths")
sys.modules["folder_paths"] = fp


class RouteTableDef:
    def __init__(self):
        self.entries = []

    def _reg(self, method, path):
        def deco(fn):
            self.entries.append((method, path, fn.__name__))
            return fn
        return deco

    def get(self, path):
        return self._reg("GET", path)

    def post(self, path):
        return self._reg("POST", path)


web = types.ModuleType("aiohttp.web")
web.RouteTableDef = RouteTableDef
web.json_response = lambda data, **kw: data
web.Response = lambda *a, **k: ("Response", a, k)
web.FileResponse = lambda *a, **k: ("FileResponse", a, k)
aiohttp = types.ModuleType("aiohttp")
aiohttp.web = web
sys.modules["aiohttp"] = aiohttp
sys.modules["aiohttp.web"] = web


class PromptServer:
    instance = types.SimpleNamespace(routes=RouteTableDef())


server = types.ModuleType("server")
server.PromptServer = PromptServer
sys.modules["server"] = server

IO = types.SimpleNamespace(
    ComfyNode=type("ComfyNode", (), {}),
    NodeOutput=lambda *a, **k: {"args": a, "kwargs": k},
    Schema=lambda *a, **k: None,
    String=types.SimpleNamespace(Input=lambda *a, **k: None,
                                 Output=lambda *a, **k: None),
)
comfy_api = types.ModuleType("comfy_api")
comfy_api.__path__ = []
latest = types.ModuleType("comfy_api.latest")
latest.IO = IO
latest.ComfyExtension = type("ComfyExtension", (), {})
sys.modules["comfy_api"] = comfy_api
sys.modules["comfy_api.latest"] = latest

pkg = types.ModuleType("sinheo_latest_plugin")
pkg.__path__ = [str(PLUGIN)]
sys.modules["sinheo_latest_plugin"] = pkg
spec = importlib.util.spec_from_file_location(
    "sinheo_latest_plugin.__init__", PLUGIN / "__init__.py")
mod = importlib.util.module_from_spec(spec)
sys.modules["sinheo_latest_plugin.__init__"] = mod
spec.loader.exec_module(mod)
if _PREVIOUS_FOLDER_PATHS is None:
    del sys.modules["folder_paths"]
else:
    sys.modules["folder_paths"] = _PREVIOUS_FOLDER_PATHS


class _Request:
    """最小 aiohttp request 桩：query 与异步 json()。"""

    def __init__(self, query=None, body=None):
        self.query = query or {}
        self._body = body if body is not None else {}

    async def json(self):
        return self._body


class LatestImageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="sinheo_latest_case_"))
        self.output = self.tmp / "output"
        self.temp = self.tmp / "temp"
        self.input = self.tmp / "input"
        for folder in (self.output, self.temp, self.input):
            folder.mkdir(parents=True, exist_ok=True)
        fp._roots = {"output": self.output, "temp": self.temp, "input": self.input}
        fp.models_dir = str(self.tmp)

    def write(self, rel, folder="output", age=0):
        path = fp._roots[folder] / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fake-png")
        if age:
            stamp = path.stat().st_mtime - age
            os.utime(path, (stamp, stamp))
        return path

    def test_route_registered(self):
        self.assertIn(("GET", "/sinheo/gallery/latest_image"),
                      {(m, p) for m, p, _ in PromptServer.instance.routes.entries})

    def test_resolve_exact_and_subfolder(self):
        a = self.write("a.png")
        b = self.write("sub/b.png")
        self.assertEqual(mod._resolve_requested_image("a.png", "", "output"), a.resolve())
        self.assertEqual(mod._resolve_requested_image("b.png", "sub", "output"), b.resolve())
        self.assertEqual(mod._resolve_requested_image("a.png", "", "weird"), a.resolve())

    def test_reject_traversal_and_non_images(self):
        self.write("a.png")
        for filename, subfolder in (("", ""), ("../../evil.png", ""),
                                    ("a.png", "../.."), ("/etc/passwd.png", ""),
                                    ("a.txt", ""), ("blake3:abcdef", ""),
                                    ("missing.png", "")):
            self.assertIsNone(
                mod._resolve_requested_image(filename, subfolder, "output"),
                f"非法参数没有被拒绝：{filename!r} / {subfolder!r}")

    def test_resolve_rejects_input_type(self):
        """LoadImage 的输入原图绝不能被当成「最近生成图」返回。"""
        self.write("loaded.png", folder="input")
        self.assertIsNone(mod._resolve_requested_image("loaded.png", "", "input"))
        self.assertIsNone(mod._resolve_requested_image("loaded.png", "", "INPUT"))

    def test_latest_scan_uses_mtime_and_skips_plugin_exports(self):
        self.write("old.png", age=300)
        newest = self.write("sub/new.png")                 # 最新的正常生成图
        self.write("Sinheo/exports/preview.png")          # 插件自己的目录，必须跳过
        self.write("temp.png", folder="temp", age=120)     # temp 不参与扫描
        self.assertEqual(mod._latest_image_on_disk(), newest)

    def test_latest_scan_ignores_temp_and_input(self):
        """temp / input 里只有上传或加载的原图时，磁盘兜底应返回 None。"""
        self.write("preview.png", folder="temp")
        self.write("loaded.png", folder="input")
        self.assertIsNone(mod._latest_image_on_disk())

    def test_export_routes_registered(self):
        routes = {(m, p) for m, p, _ in PromptServer.instance.routes.entries}
        self.assertIn(("GET", "/sinheo/gallery/export_dir"), routes)
        self.assertIn(("GET", "/sinheo/gallery/export_blob"), routes)
        self.assertIn(("POST", "/sinheo/gallery/export_to"), routes)

    def test_export_dir_returns_absolute_path_without_building_zip(self):
        """面板打开时只取默认目录，不该先生成一个 10 MB 的 ZIP。"""
        reply = asyncio.run(mod.api_gallery_export_dir(_Request()))
        self.assertTrue(Path(reply["dir"]).is_absolute())
        self.assertTrue(reply["filename"].endswith(".zip"))
        exports = Path(reply["dir"])
        self.assertFalse(any(exports.glob("*.zip")))

    def test_export_blob_does_not_write_to_output(self):
        """新导出通道直接返回 ZIP 二进制，不在 output 目录落盘。"""
        reply = asyncio.run(mod.api_gallery_export_blob(_Request()))
        self.assertEqual(reply[0], "Response")
        payload = reply[2]["body"]
        self.assertTrue(payload.startswith(b"PK"))
        exports = self.output / "Sinheo" / "exports"
        self.assertFalse(exports.is_dir() and any(exports.glob("*.zip")))

    def test_export_to_writes_user_chosen_path(self):
        """内嵌窗口无「另存为」时，按用户填的绝对路径写盘且不覆盖旧文件。"""
        folder = self.tmp / "备份"
        reply = asyncio.run(mod.api_gallery_export_to(
            _Request(body={"path": str(folder), "filename": "图库.zip"})))
        target = Path(reply["path"])
        self.assertEqual(target.name, "图库.zip")
        self.assertTrue(target.is_file() and zipfile.is_zipfile(target))
        self.assertNotIn("error", reply)
        again = asyncio.run(mod.api_gallery_export_to(
            _Request(body={"path": str(target), "filename": "图库.zip"})))
        self.assertIn("error", again)                      # 默认防误覆盖
        # 用户在面板里明确保存到同一个位置时允许覆盖
        forced = asyncio.run(mod.api_gallery_export_to(
            _Request(body={"path": str(target), "filename": "图库.zip",
                           "overwrite": True})))
        self.assertNotIn("error", forced)
        self.assertTrue(zipfile.is_zipfile(target))
        relative = asyncio.run(mod.api_gallery_export_to(
            _Request(body={"path": "不是绝对路径.zip"})))
        self.assertIn("error", relative)

    def test_export_to_passes_scope_to_zip(self):
        """面板选的分类 / 分组要交给 export_zip；无效范围给出可读错误。"""
        folder = self.tmp / "范围备份"
        bad = asyncio.run(mod.api_gallery_export_to(
            _Request(body={"path": str(folder), "filename": "范围.zip",
                           "category": "不存在的分类"})))
        self.assertIn("error", bad)
        self.assertIn("分类", str(bad["error"]))
        self.assertFalse(any(folder.glob("*.zip")))   # 失败时不应留下空包

    def test_handler_returns_file_response_and_404(self):
        self.write("shot.png")
        request = types.SimpleNamespace(
            query={"filename": "shot.png", "subfolder": "", "type": "output"})
        reply = asyncio.run(mod.api_gallery_latest_image(request))
        self.assertEqual(reply[0], "FileResponse")
        self.assertEqual(reply[2]["headers"]["X-Sinheo-Image"], "shot.png")

        # 磁盘上完全没有图时给出可操作的 404，而不是 500
        for folder in (self.output, self.temp, self.input):
            for path in folder.rglob("*"):
                if path.is_file():
                    path.unlink()
        empty = types.SimpleNamespace(query={})
        reply = asyncio.run(mod.api_gallery_latest_image(empty))
        self.assertIn("error", reply)
        self.assertIn("运行一次工作流", reply["error"])


if __name__ == "__main__":
    unittest.main()
