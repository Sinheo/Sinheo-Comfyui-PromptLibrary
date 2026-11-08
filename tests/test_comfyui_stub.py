"""在 ComfyUI 自带 Python 里做一次「不启动服务」的真实环境自检。

    PYTHONPATH="/path/to/ComfyUI" python tests/test_comfyui_stub.py

用假的 server.PromptServer 接住路由装饰器，验证：节点能被新版 IO API 注册、
API 路由齐全、词库扫描、「随机 关=文本框 / 随机 开=从已勾选小类重新抽词」、
生成接口、「＋ 添加到」追加接口、按勾选导出 ZIP、旧目录迁移接口。

注意：自检在临时目录里铺一份示例词库，并把 folder_paths.models_dir 指过去，
全程不读写用户真实的 models/Sinheo/prompts（避免污染或误判空词库）。
"""
from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import math
import shutil
import sys
import tempfile
import types
import zipfile
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
REGISTERED = []


class FakeRoutes:
    def _register(self, method, path):
        def decorator(handler):
            REGISTERED.append((method, path, handler))
            return handler
        return decorator

    def get(self, path):
        return self._register("GET", path)

    def post(self, path):
        return self._register("POST", path)


class FakeRequest:
    """给 POST 路由用：提供 await request.json()。"""

    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


def install_fake_server():
    module = types.ModuleType("server")
    module.PromptServer = type(
        "PromptServer", (),
        {"instance": types.SimpleNamespace(routes=FakeRoutes())})
    sys.modules["server"] = module


def prepare_temp_library():
    """把路径服务指向临时目录，并铺一份两级示例词库。"""
    import folder_paths

    temp = Path(tempfile.mkdtemp(prefix="sinheo_selfcheck_"))
    folder_paths.models_dir = str(temp)
    root = temp / "Sinheo" / "prompts"
    (root / "上衣").mkdir(parents=True)
    (root / "发型").mkdir(parents=True)
    (root / "上衣" / "甜美.txt").write_text(
        "# 注释\n粉色蝴蝶结上衣\n蕾丝泡泡袖上衣\n", encoding="utf-8")
    (root / "上衣" / "可爱.txt").write_text(
        "小熊刺绣卫衣\n娃娃领毛衣\n", encoding="utf-8")
    (root / "发型" / "短发.txt").write_text(
        "齐耳短发\n羊毛卷短发\n", encoding="utf-8")
    return temp, root


def load_package():
    spec = importlib.util.spec_from_file_location(
        "sinheo_integration", PLUGIN / "__init__.py",
        submodule_search_locations=[str(PLUGIN)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = package
    spec.loader.exec_module(package)
    return package


async def check_endpoints(handlers, package, root):
    response = await handlers[("GET", "/sinheo/library")](None)
    data = json.loads(response.text)
    print(f"  词库目录 : {data['root']}（临时自检目录）")
    print(f"  大类 {len(data['groups'])} 个 / 小类 {len(data['categories'])} 个 / 提示词 {data['total']} 条")
    assert len(data["groups"]) == 2 and len(data["categories"]) == 3
    assert data["total"] == 6
    assert all(c.get("kind") == "file" for c in data["categories"]), "词库应全部是两级 TXT"

    export = await handlers[("GET", "/sinheo/export")](None)
    print(f"  导出 ZIP(全部) : {len(export.body)} 字节")
    assert export.body.startswith(b"PK")

    # 按勾选导出：只打包指定的一个小类
    cat = data["categories"][0]
    selected = await handlers[("POST", "/sinheo/export")](
        FakeRequest({"selection": [cat["id"]]}))
    assert selected.body.startswith(b"PK")
    with zipfile.ZipFile(io.BytesIO(selected.body)) as archive:
        assert cat["rel"] in archive.namelist(), f"勾选导出缺少 {cat['rel']}"
    print(f"  导出 ZIP(勾选) : {cat['rel']} / {len(selected.body)} 字节")

    migrated = await handlers[("POST", "/sinheo/migrate")](None)
    print(f"  目录迁移 : {json.loads(migrated.text)['merged']} 个旧小类文件夹需展平")

    # 「生成」接口：random=false 确定性填充，random=true 随机抽词
    generated = json.loads((await handlers[("POST", "/sinheo/generate")](
        FakeRequest({"config": {}, "random": False}))).text)
    assert isinstance(generated["text"], str) and generated["text"].strip()
    print(f"  生成接口(确定) : {generated['text'][:80]!r}")
    generated_rnd = json.loads((await handlers[("POST", "/sinheo/generate")](
        FakeRequest({"config": {}, "random": True}))).text)
    assert isinstance(generated_rnd["text"], str) and generated_rnd["text"].strip()
    print(f"  生成接口(随机) : {generated_rnd['text'][:80]!r}")

    # 「＋ 添加到」：只追加、去重，保留原注释
    rel = "上衣/甜美.txt"
    before = root / rel
    original = before.read_text(encoding="utf-8")
    first = json.loads((await handlers[("POST", "/sinheo/append")](
        FakeRequest({"rels": [rel], "text": "自检词条甲\n自检词条乙\n自检词条甲"}))).text)
    assert first["added"] == 2, first
    second = json.loads((await handlers[("POST", "/sinheo/append")](
        FakeRequest({"rels": [rel], "text": "自检词条甲"}))).text)
    assert second["added"] == 0, second
    after = before.read_text(encoding="utf-8")
    assert after.startswith(original.rstrip("\n")), "追加破坏了原有内容"
    assert "自检词条甲" in after and after.count("自检词条甲") == 1
    print(f"  添加到接口 : 新增 {first['added']} 条，重复添加 {second['added']} 条，注释保留")

    # 随机「关」：只输出文本框内容，忽略词库
    textbox = package.SinheoLoadText.execute(
        json.dumps({"randomize": False}), "只输出这一句，别的都不要")
    assert textbox.args[0] == "只输出这一句，别的都不要"
    assert "文本框模式" in textbox.args[1]
    assert textbox.ui["sinheo_text"][0] == textbox.args[0]
    print(f"  文本框模式 : {textbox.args[0]!r}")

    # 随机「开」：文本框内容被忽略，按词库重新抽词（每个小类只 1 条）
    rnd = package.SinheoLoadText.execute(
        json.dumps({"randomize": True, "count": 1}), "这句必须被忽略")
    assert "这句必须被忽略" not in rnd.args[0]
    assert rnd.args[0].strip()
    assert rnd.ui["sinheo_text"][0] == rnd.args[0]
    print(f"  随机模式 : {rnd.args[0][:100]!r}")

    # 随机只在已勾选的小类里抽：关掉「发型」大类和「上衣/可爱」小类后，
    # 结果只能来自「上衣/甜美」，且绝不出现发型词。
    scoped = json.dumps({
        "randomize": True, "count": 1, "order": ["上衣", "发型"],
        "catOrder": {"上衣": ["上衣/甜美", "上衣/可爱"]},
        "groups": {"发型": {"on": False}},
        "cats": {"上衣/可爱": {"on": False}},
        "separator": ", ",
    })
    for _ in range(20):
        out = package.SinheoLoadText.execute(scoped, "")
        assert any(word in out.args[0] for word in
                   ("粉色蝴蝶结上衣", "蕾丝泡泡袖上衣", "自检词条甲", "自检词条乙"))
        assert "齐耳短发" not in out.args[0] and "羊毛卷短发" not in out.args[0]
        assert "小熊刺绣卫衣" not in out.args[0]
    print("  随机范围 : 只在已勾选小类里抽 1 条，未勾选的大类/小类不参与")

    assert math.isnan(package.SinheoLoadText.fingerprint_inputs(
        json.dumps({"randomize": True}), ""))
    fixed = package.SinheoLoadText.fingerprint_inputs(
        json.dumps({"randomize": False}), "同一段文字")
    assert fixed == package.SinheoLoadText.fingerprint_inputs(
        json.dumps({"randomize": False}), "同一段文字")
    assert fixed != package.SinheoLoadText.fingerprint_inputs(
        json.dumps({"randomize": False}), "改过的文字")
    print("  缓存指纹 : 随机=NaN（每次重抽）；文本框=内容哈希（改字才重跑）")


async def main():
    install_fake_server()
    temp, root = prepare_temp_library()
    try:
        package = load_package()
        extension = await package.comfy_entrypoint()
        node_classes = await extension.get_node_list()
        print("节点注册 :", [cls.define_schema().node_id for cls in node_classes])
        assert [cls.define_schema().node_id for cls in node_classes] == ["SinheoLoadText"]
        schema = node_classes[0].define_schema()
        assert schema.display_name == "Sinheo 加载文本"
        assert [i.id for i in schema.inputs] == ["manual_text", "config"]
        assert len(schema.outputs) == 2

        routes = {(method, path): handler for method, path, handler in REGISTERED}
        print("API 路由 :", [f"{m} {p}" for m, p in routes])
        assert len(REGISTERED) == 11, f"应有 11 个路由，实际 {len(REGISTERED)}"
        await check_endpoints(routes, package, root)
        print("\nComfyUI 真实环境自检通过 ✓")
    finally:
        shutil.rmtree(temp, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
