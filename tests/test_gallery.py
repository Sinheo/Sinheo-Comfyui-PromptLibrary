"""重命名 / 批量删除 / 图库数据层 的纯 Python 单测（不需要 ComfyUI）。

    python tests/test_gallery.py
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import zipfile
import types
import unittest
from pathlib import Path
from unittest import mock

PLUGIN = Path(__file__).resolve().parents[1]
TMP = Path(tempfile.mkdtemp(prefix="sinheo_gallery_test_"))

fake = types.ModuleType("folder_paths")
fake.models_dir = str(TMP)
fake._folders = {}


def _add(key, path, is_default=False):
    fake._folders.setdefault(key, []).append(str(path))


def _get(key):
    return list(fake._folders.get(key, []))


fake.add_model_folder_path = _add
fake.get_folder_paths = _get
sys.modules["folder_paths"] = fake
sys.path.insert(0, str(PLUGIN))

import sinheo_core as core          # noqa: E402
import sinheo_gallery as gallery    # noqa: E402


class GalleryTests(unittest.TestCase):
    def setUp(self):
        # 每个用例都用独立的 models 目录，避免互相污染
        fake.models_dir = str(Path(tempfile.mkdtemp(prefix="sinheo_case_")))
        fake._folders.clear()

    def write(self, rel, text):
        path = core.writable_root() / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    # ------------------------------------------------------------ 重命名
    def test_rename_category_syncs_order(self):
        self.write("服饰/日常.txt", "米白针织衫\n格纹百褶裙\n")
        core.save_order(["服饰"], {"服饰": ["服饰/日常"]})
        result = core.rename_path("服饰/日常.txt", "通勤")
        self.assertEqual(result["kind"], "category")
        self.assertEqual(result["old"], "服饰/日常")
        self.assertEqual(result["new"], "服饰/通勤")
        self.assertTrue((core.writable_root() / "服饰/通勤.txt").is_file())
        self.assertFalse((core.writable_root() / "服饰/日常.txt").exists())
        cats = core.read_order()["categories"]["服饰"]
        self.assertIn("服饰/通勤", cats)
        self.assertNotIn("服饰/日常", cats)
        self.assertEqual(core.parse_items(
            core.read_text(core.writable_root() / "服饰/通勤.txt")),
            ["米白针织衫", "格纹百褶裙"])

    def test_rename_group_syncs_all_child_ids(self):
        self.write("服饰/日常.txt", "a\n")
        self.write("服饰/晚宴.txt", "b\n")
        core.save_order(["服饰", "发型"],
                        {"服饰": ["服饰/日常", "服饰/晚宴"], "发型": ["发型/发色"]})
        result = core.rename_path("服饰", "服装")
        self.assertEqual(result["kind"], "group")
        self.assertTrue((core.writable_root() / "服装/日常.txt").is_file())
        self.assertFalse((core.writable_root() / "服饰").exists())
        order = core.read_order()
        self.assertIn("服装", order["groups"])
        self.assertNotIn("服饰", order["groups"])
        self.assertEqual(order["categories"]["服装"], ["服装/日常", "服装/晚宴"])
        self.assertEqual(order["categories"]["发型"], ["发型/发色"])

    def test_rename_root_category(self):
        self.write("根级.txt", "masterpiece\n")
        core.save_order([core.UNGROUPED], {core.UNGROUPED: ["根级"]})
        result = core.rename_path("根级.txt", "新根级")
        self.assertEqual(result["old"], "根级")
        self.assertEqual(result["new"], "新根级")
        self.assertTrue((core.writable_root() / "新根级.txt").is_file())
        self.assertEqual(core.read_order()["categories"][core.UNGROUPED], ["新根级"])

    def test_rename_rejects_bad_input(self):
        self.write("服饰/日常.txt", "a\n")
        self.write("服饰/晚宴.txt", "b\n")
        with self.assertRaises(ValueError):
            core.rename_path("服饰/日常.txt", "晚宴")          # 重名
        with self.assertRaises(ValueError):
            core.rename_path("服饰/日常.txt", "../越界")        # 路径穿越
        with self.assertRaises(ValueError):
            core.rename_path("服饰/日常.txt", "a|b")            # 非法字符
        with self.assertRaises(FileNotFoundError):
            core.rename_path("不存在.txt", "新名字")

    # -------------------------------------------------------- 批量删除
    def test_delete_batch_dedup_backup_and_order(self):
        self.write("服饰/日常.txt", "a\n")
        self.write("服饰/晚宴.txt", "b\n")
        self.write("发型/发色.txt", "c\n")
        core.save_order(["服饰", "发型"],
                        {"服饰": ["服饰/日常", "服饰/晚宴"], "发型": ["发型/发色"]})
        result = core.delete_paths(["服饰", "服饰/日常.txt", "发型/发色.txt"])
        # 勾了大类就自动跳过它下面的小类
        self.assertEqual(result["deleted"], ["服饰", "发型/发色.txt"])
        self.assertFalse((core.writable_root() / "服饰").exists())
        self.assertFalse((core.writable_root() / "发型/发色.txt").exists())
        # 全部都进了同一个备份目录
        backup = Path(result["backup"])
        self.assertTrue((backup / "服饰/日常.txt").is_file())
        self.assertTrue((backup / "服饰/晚宴.txt").is_file())
        self.assertTrue((backup / "发型/发色.txt").is_file())
        order = core.read_order()
        self.assertNotIn("服饰", order["groups"])
        self.assertNotIn("服饰", order["categories"])
        self.assertEqual(order["categories"]["发型"], [])

    def test_delete_batch_rejects_empty(self):
        with self.assertRaises(ValueError):
            core.delete_paths([])

    # ------------------------------------------------------------ 图库
    def test_gallery_default_and_roundtrip(self):
        data = gallery.load_gallery()
        self.assertEqual(data["categories"], [])
        self.assertEqual(data["cards"], [])
        self.assertEqual(data["settings"], {})
        self.assertTrue(gallery.data_file().is_file())

        payload = {
            "categories": [
                {"id": "cat1", "name": "服饰", "groups": [
                    {"id": "grp1", "name": "日常"}, {"id": "grp2", "name": "晚宴"}]},
            ],
            "cards": [
                {"id": "c1", "categoryId": "cat1", "groupId": "grp1",
                 "title": "学院风", "prompt": "米白针织衫", "image": "", "favorite": True},
                {"id": "c2", "categoryId": "不存在的分类", "groupId": "乱写的分组",
                 "title": "孤儿卡", "prompt": "x", "image": "../secret.png"},
            ],
            "settings": {"showTitle": False},
        }
        saved = gallery.save_gallery(payload)
        self.assertEqual(len(saved["cards"]), 2)
        # 越界分类归一到第一个分类、非法分组清空、非法图片路径丢弃
        self.assertEqual(saved["cards"][1]["categoryId"], "cat1")
        self.assertEqual(saved["cards"][1]["groupId"], "")
        self.assertEqual(saved["cards"][1]["image"], "")
        self.assertEqual(saved["settings"], {})
        self.assertNotIn("title", saved["cards"][0])   # 标题功能已移除，旧数据自动丢弃
        self.assertTrue(saved["cards"][0]["favorite"])
        self.assertEqual(gallery.load_gallery(), saved)
        self.assertEqual(json.loads(gallery.data_file().read_text(encoding="utf-8")), saved)

    def test_gallery_image_upload_and_path_security(self):
        rel = gallery.save_image("卡片.PNG", b"\x89PNG\r\n\x1a\n" + b"0" * 32)
        self.assertTrue(rel.startswith("images/"))
        self.assertTrue(rel.endswith(".png"))
        self.assertTrue(gallery.resolve_image(rel).is_file())
        self.assertEqual(gallery.content_type(gallery.resolve_image(rel)), "image/png")
        for bad in ("../secret.txt", "images/../../secret.txt", "/etc/passwd", ""):
            with self.assertRaises(ValueError):
                gallery.resolve_image(bad)
        with self.assertRaises(ValueError):
            gallery.save_image("evil.exe", b"MZ")
        with self.assertRaises(ValueError):
            gallery.save_image("big.png", b"x" * (gallery.MAX_IMAGE_BYTES + 1))


    def make_gallery(self):
        rel = gallery.save_image("a.png", b"\x89PNG\r\n\x1a\n" + b"0" * 32)
        payload = {
            "categories": [
                {"id": "cat1", "name": "服饰", "groups": [
                    {"id": "grp1", "name": "日常"}, {"id": "grp2", "name": "晚宴"}]},
                {"id": "cat2", "name": "风格", "groups": [
                    {"id": "grp3", "name": "清新"}]},
            ],
            "cards": [
                {"id": "c1", "categoryId": "cat1", "groupId": "grp1",
                 "prompt": "米白针织衫", "image": rel, "favorite": True},
                {"id": "c2", "categoryId": "cat1", "groupId": "grp2",
                 "prompt": "酒红长裙", "image": "", "favorite": False},
                {"id": "c3", "categoryId": "cat2", "groupId": "grp3",
                 "prompt": "柔光", "image": "", "favorite": False},
            ],
        }
        return gallery.save_gallery(payload), rel

    # ------------------------------------------------- 图库随机 + 导入导出
    def test_build_prompt_gallery(self):
        data, _ = self.make_gallery()
        prompts, details = gallery.build_prompt(data, {"count": 1})
        self.assertEqual(prompts, ["米白针织衫"])
        self.assertIn("服饰", details[0])

        cfg = {"count": 2, "separator": " | ", "prefix": "masterpiece",
               "suffix": "8k"}
        prompts, _ = gallery.build_prompt(data, cfg, randomize=True, random_seed=7)
        self.assertEqual(len(prompts), 1)
        self.assertTrue(prompts[0].startswith("masterpiece | "))
        self.assertTrue(prompts[0].endswith(" | 8k"))

        self.assertEqual(
            gallery.build_prompt(data, {"galleryCats": ["cat2"]})[0], ["柔光"])
        # 分组勾选优先于分类勾选
        self.assertEqual(
            gallery.build_prompt(
                data, {"galleryCats": ["cat2"], "galleryGroups": ["grp2"]})[0],
            ["酒红长裙"])
        self.assertEqual(
            gallery.build_prompt(data, {"galleryFav": True})[0], ["米白针织衫"])
        prompts, details = gallery.build_prompt({}, {})
        self.assertEqual(prompts, [""])
        self.assertIn("图库为空", details[0])

    def test_export_import_zip_roundtrip(self):
        data, rel = self.make_gallery()
        blob = gallery.export_zip()
        self.assertTrue(zipfile.is_zipfile(io.BytesIO(blob)))
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            self.assertIn("library.json", archive.namelist())
            self.assertIn(rel, archive.namelist())

        result = gallery.import_archive(blob, "gallery.zip", merge=False)
        self.assertEqual(result["mode"], "replace")
        self.assertEqual(result["cards"], 3)
        self.assertEqual(result["images"], 1)
        self.assertTrue(Path(result["backup"]).is_dir())
        loaded = gallery.load_gallery()
        self.assertEqual(len(loaded["cards"]), 3)
        self.assertNotIn("title", loaded["cards"][0])
        self.assertTrue(gallery.resolve_image(loaded["cards"][0]["image"]).is_file())

    def test_export_zip_scope_category_and_group(self):
        """导出面板可以按分类 / 分组打包，子集包仍能被导入还原。"""
        _, rel = self.make_gallery()

        def read(blob):
            with zipfile.ZipFile(io.BytesIO(blob)) as archive:
                meta = json.loads(archive.read("library.json").decode("utf-8"))
                return meta, archive.namelist(), archive.read("README.txt").decode("utf-8")

        whole, names, _ = read(gallery.export_zip())
        self.assertEqual(len(whole["cards"]), 3)
        self.assertIn(rel, names)

        by_cat, names, readme = read(gallery.export_zip(category_id="cat1"))
        self.assertEqual([c["id"] for c in by_cat["categories"]], ["cat1"])
        self.assertEqual([c["id"] for c in by_cat["cards"]], ["c1", "c2"])
        self.assertIn(rel, names)
        self.assertIn("服饰", readme)

        by_group, names, readme = read(gallery.export_zip(group_id="grp2"))
        self.assertEqual([c["id"] for c in by_group["categories"]], ["cat1"])
        self.assertEqual([g["id"] for g in by_group["categories"][0]["groups"]], ["grp2"])
        self.assertEqual([c["id"] for c in by_group["cards"]], ["c2"])
        self.assertNotIn(rel, names)      # 别的组引用的图片不该打进来
        self.assertIn("服饰 / 晚宴", readme)

        result = gallery.import_archive(
            gallery.export_zip(category_id="cat1", group_id="grp1"),
            "scope.zip", merge=False)
        self.assertEqual(result["cards"], 1)
        loaded = gallery.load_gallery()
        self.assertEqual(loaded["categories"][0]["id"], "cat1")
        self.assertEqual(loaded["cards"][0]["groupId"], "grp1")

    def test_export_zip_scope_rejects_unknown_ids(self):
        self.make_gallery()
        with self.assertRaises(ValueError):
            gallery.export_zip(category_id="nope")
        with self.assertRaises(ValueError):
            gallery.export_zip(category_id="cat1", group_id="nope")
        with self.assertRaises(ValueError):
            gallery.export_zip(group_id="nope")

    def test_import_merge_dedups_ids(self):
        self.make_gallery()
        result = gallery.import_archive(gallery.export_zip(), "gallery.zip", merge=True)
        self.assertEqual(result["mode"], "merge")
        self.assertEqual(result["total"], 6)
        loaded = gallery.load_gallery()
        ids = [card["id"] for card in loaded["cards"]]
        self.assertEqual(len(ids), len(set(ids)))
        cat_ids = [cat["id"] for cat in loaded["categories"]]
        self.assertEqual(len(cat_ids), len(set(cat_ids)))
        self.assertEqual(len(loaded["categories"]), 4)

    def test_import_json_and_rejects_bad_archive(self):
        result = gallery.import_archive(
            json.dumps({"cards": [{"id": "j1", "prompt": "纯文本卡片"}]}).encode("utf-8"),
            "library.json", merge=False)
        self.assertEqual(result["cards"], 1)
        self.assertEqual(gallery.load_gallery()["cards"][0]["prompt"], "纯文本卡片")
        for bad, name in ((b"", "x.zip"), (b"not a zip", "x.zip"), (b"{bad json", "x.json")):
            with self.assertRaises(ValueError):
                gallery.import_archive(bad, name)

    def test_import_skips_path_traversal(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("library.json", json.dumps({"cards": []}))
            archive.writestr("images/../../evil.png", b"MZ")
        gallery.import_archive(buffer.getvalue(), "evil.zip", merge=False)
        self.assertFalse((gallery.gallery_root() / "evil.png").is_file())

    def test_save_gallery_keeps_backup(self):
        gallery.save_gallery({"cards": [{"id": "a", "prompt": "第一版"}]})
        gallery.save_gallery({"cards": [{"id": "a", "prompt": "第二版"}]})
        backups = sorted((gallery.gallery_root() / gallery.BACKUP_DIRNAME)
                         .glob("library-*.json"))
        self.assertTrue(backups)
        self.assertIn("第一版", backups[0].read_text(encoding="utf-8"))
        self.assertEqual(gallery.load_gallery()["cards"][0]["prompt"], "第二版")

    def test_gallery_legacy_title_dropped(self):
        saved = gallery.save_gallery({
            "cards": [{"id": "old", "title": "旧标题", "prompt": "提示词",
                       "image": "", "favorite": False}],
            "settings": {"showTitle": False},
        })
        self.assertNotIn("title", saved["cards"][0])
        self.assertEqual(saved["settings"], {})
        self.assertEqual(gallery.load_gallery()["cards"][0]["prompt"], "提示词")


# --------------------------------------------------------------------------- #
# 缩略图：图库只存「能认出提示词效果」的 512px JPEG
# 系统 Python 可能没有 Pillow，真实压缩用例自动跳过；用 ComfyUI 自带 Python
# (F:/AI/ComfyUI-all/python/python.exe) 跑才会全部执行。
# --------------------------------------------------------------------------- #
PIL_SKIP = unittest.skipUnless(gallery.HAS_PIL, "当前解释器没有 Pillow")


class ThumbnailTests(unittest.TestCase):
    def setUp(self):
        fake.models_dir = str(Path(tempfile.mkdtemp(prefix="sinheo_thumb_")))
        fake._folders.clear()

    @staticmethod
    def big_png(width=1200, height=900):
        """噪点图：PNG 会有几 MB，缩成 512px JPEG 后只剩一两百 KB。"""
        from PIL import Image
        image = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()

    def put_history_image(self, name, content):
        """模拟升级前已经落在磁盘上的大图（绕过 save_image）。"""
        folder = gallery.gallery_root() / gallery.IMAGES_DIRNAME
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(content)
        return f"{gallery.IMAGES_DIRNAME}/{name}"

    def card_data(self, *images):
        return {
            "categories": [{"id": "cat", "name": "分类", "groups": []}],
            "cards": [{"id": f"card_{i}", "categoryId": "cat", "groupId": "",
                       "prompt": f"提示词 {i}", "image": rel, "favorite": False}
                      for i, rel in enumerate(images)],
        }

    # 不依赖 Pillow 的降级路径 ------------------------------------------------
    def test_thumbnail_without_pillow_returns_original(self):
        raw = b"not-an-image"
        with mock.patch.object(gallery, "HAS_PIL", False):
            out, name = gallery.thumbnail_bytes(raw, "x.png")
        self.assertEqual(out, raw)
        self.assertEqual(name, "x.png")

    # 需要真实 Pillow --------------------------------------------------------
    @PIL_SKIP
    def test_save_image_writes_512px_jpeg(self):
        from PIL import Image
        raw = self.big_png()
        rel = gallery.save_image("ComfyUI_00001_.png", raw)
        self.assertTrue(rel.endswith(".jpg"), rel)
        path = gallery.resolve_image(rel)
        self.assertLess(path.stat().st_size, len(raw) // 5)
        with Image.open(path) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertLessEqual(max(image.size), gallery.THUMB_MAX_EDGE)
            self.assertAlmostEqual(image.size[0] / image.size[1], 1200 / 900, delta=0.01)

    @PIL_SKIP
    def test_thumbnail_is_idempotent_and_safe_on_broken_bytes(self):
        raw = self.big_png()
        thumb, name = gallery.thumbnail_bytes(raw, "a.png")
        again, name2 = gallery.thumbnail_bytes(thumb, name)
        self.assertEqual(again, thumb)          # 不重复有损编码
        self.assertEqual(name2, name)
        broken = b"\x89PNG\r\n\x1a\n broken"
        self.assertEqual(gallery.thumbnail_bytes(broken, "b.png"), (broken, "b.png"))

    @PIL_SKIP
    def test_thumbnail_flattens_transparency_to_white(self):
        from PIL import Image
        noise = Image.frombytes("RGB", (900, 600), os.urandom(900 * 600 * 3)).convert("RGBA")
        noise.putalpha(0)                       # 全透明：不铺白底的话 JPEG 会变黑
        buffer = io.BytesIO()
        noise.save(buffer, format="PNG")
        out, name = gallery.thumbnail_bytes(buffer.getvalue(), "alpha.png")
        self.assertTrue(name.endswith(".jpg"), name)
        with Image.open(io.BytesIO(out)) as image:
            self.assertEqual(image.getpixel((10, 10)), (255, 255, 255))

    @PIL_SKIP
    def test_export_zip_never_contains_original_images(self):
        from PIL import Image
        raw = self.big_png()
        rel = self.put_history_image("history_big.png", raw)
        gallery.save_gallery(self.card_data(rel))
        payload = gallery.export_zip()
        self.assertLess(len(payload), len(raw) // 5)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            images = [n for n in archive.namelist() if n.startswith("images/")]
            self.assertEqual(len(images), 1)
            self.assertTrue(images[0].endswith(".jpg"), images)
            meta = json.loads(archive.read("library.json").decode("utf-8"))
            self.assertEqual(meta["cards"][0]["image"], images[0])
            blob = archive.read(images[0])
            self.assertLess(len(blob), len(raw) // 5)
            with Image.open(io.BytesIO(blob)) as image:
                self.assertLessEqual(max(image.size), gallery.THUMB_MAX_EDGE)

    @PIL_SKIP
    def test_import_archive_compresses_incoming_images(self):
        from PIL import Image
        raw = self.big_png()
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("library.json", json.dumps({
                "categories": [],
                "cards": [{"id": "c", "categoryId": "", "groupId": "",
                           "prompt": "p", "image": "images/big.png", "favorite": False}],
            }))
            archive.writestr("images/big.png", raw)
        result = gallery.import_archive(buffer.getvalue(), "old.zip", merge=True)
        self.assertEqual(result["images"], 1)
        card = gallery.load_gallery()["cards"][0]
        self.assertTrue(card["image"].endswith(".jpg"), card["image"])
        path = gallery.resolve_image(card["image"])
        self.assertLess(path.stat().st_size, len(raw) // 5)
        with Image.open(path) as image:
            self.assertLessEqual(max(image.size), gallery.THUMB_MAX_EDGE)

    @PIL_SKIP
    def test_thumbnails_are_never_reencoded_twice(self):
        """反复导出 / 导入不会越压越糊：已经达标的小 JPEG 原样返回。"""
        from PIL import Image
        raw = self.big_png(1000, 800)
        rel = self.put_history_image("once.png", raw)
        gallery.save_gallery(self.card_data(rel))
        with zipfile.ZipFile(io.BytesIO(gallery.export_zip())) as archive:
            name = [n for n in archive.namelist() if n.startswith("images/")][0]
            blob = archive.read(name)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("library.json", json.dumps({
                "categories": [], "cards": [{"id": "c", "prompt": "p",
                                             "image": name, "favorite": False}],
            }))
            archive.writestr(name, blob)
        gallery.import_archive(buffer.getvalue(), "again.zip", merge=False)
        imported = gallery.resolve_image(gallery.load_gallery()["cards"][0]["image"])
        self.assertEqual(imported.read_bytes(), blob)   # 字节完全一致，没有二次有损编码
        with Image.open(imported) as image:
            self.assertLessEqual(max(image.size), gallery.THUMB_MAX_EDGE)


if __name__ == "__main__":
    unittest.main(verbosity=2)
