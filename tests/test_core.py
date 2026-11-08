"""sinheo_core 纯 Python 单元测试（不需要 ComfyUI）。

    python tests/test_core.py
"""
from __future__ import annotations

import io
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
TMP = Path(tempfile.mkdtemp(prefix="sinheo_core_test_"))

# 用假的 folder_paths 顶替 ComfyUI 的路径服务，让核心逻辑可以独立运行
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

import sinheo_core as core  # noqa: E402


def write(rel, text):
    path = core.writable_root() / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class CoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 两级词库：大类文件夹 / 小类.txt
        write("上衣/甜美.txt", "# 注释\n粉色蝴蝶结上衣\n蕾丝泡泡袖上衣\n粉色蝴蝶结上衣\n")
        write("上衣/可爱.txt", "小熊刺绣卫衣\n娃娃领毛衣\n")
        write("上衣/酷酷的.txt", "黑色皮夹克\n机车铆钉外套\n")
        write("01_头发/短发.txt", "齐耳短发\n羊毛卷短发\n")
        write("根级.txt", "masterpiece\n")
        (core.writable_root() / "空大类").mkdir(parents=True, exist_ok=True)

    def test_scan_two_level(self):
        lib = core.scan_library()
        groups = {g["id"]: g for g in lib["groups"]}
        self.assertIn("上衣", groups)
        self.assertIn("01_头发", groups)
        self.assertIn("空大类", groups)
        self.assertIn(core.UNGROUPED, groups)
        cats = {c["id"]: c for c in lib["categories"]}
        self.assertEqual(cats["上衣/甜美"]["count"], 2)  # 去重
        self.assertEqual(cats["上衣/甜美"]["kind"], "file")
        self.assertEqual(cats["上衣/甜美"]["rel"], "上衣/甜美.txt")
        self.assertEqual(len(cats["上衣/甜美"]["files"]), 1)  # 一个小类只有一个 TXT
        self.assertEqual(cats["01_头发/短发"]["kind"], "file")
        self.assertEqual(groups["01_头发"]["label"], "头发")  # 数字前缀不显示
        self.assertEqual(lib["total"], 2 + 2 + 2 + 2 + 1)

    def test_migrate_legacy_layout(self):
        """旧的「大类/小类文件夹/多个 TXT」自动展平成一个 TXT，并整份备份。"""
        write("旧结构/甜美/提示词.txt", "甲\n乙\n")
        write("旧结构/甜美/更多.txt", "丙\n甲\n")
        result = core.migrate_legacy_layout()
        self.assertEqual(result["merged"], 1)
        self.assertTrue(result["backup"])
        target = core.writable_root() / "旧结构" / "甜美.txt"
        self.assertTrue(target.is_file())
        self.assertEqual(core.parse_items(core.read_text(target)), ["甲", "乙", "丙"])
        self.assertFalse((core.writable_root() / "旧结构" / "甜美").exists())
        self.assertTrue(any(Path(result["backup"]).rglob("提示词.txt")))
        # 幂等：再跑一次不再产生迁移
        self.assertEqual(core.migrate_legacy_layout()["merged"], 0)
        core.delete_path("旧结构")

    def test_parse_items_and_compose(self):
        self.assertEqual(core.parse_items(" a\n# hi\na\n\n b "), ["a", "b"])
        self.assertEqual(core.compose(["a", "b"], ", ", "pre", "suf"), "pre, a, b, suf")
        self.assertEqual(core.compose([], ", ", "", ""), "")

    def test_order_file(self):
        core.save_order(["上衣", "01_头发"], {"上衣": ["上衣/酷酷的", "上衣/甜美"]})
        lib = core.scan_library()
        self.assertEqual(lib["groups"][0]["id"], "上衣")
        self.assertEqual([c["id"] for c in lib["groups"][0]["categories"]][:2],
                         ["上衣/酷酷的", "上衣/甜美"])
        self.assertEqual(core.read_order()["groups"], ["上衣", "01_头发"])
        core.save_order([], {})  # 还原，避免影响其它用例

    def test_build_prompt_follows_menu_order(self):
        lib = core.scan_library()
        cfg = {
            "order": ["01_头发", "上衣"],
            "catOrder": {"上衣": ["上衣/酷酷的", "上衣/甜美", "上衣/可爱"]},
            "groups": {}, "cats": {},
            "separator": ", ", "prefix": "", "suffix": "", "count": 1,
        }
        prompts, details = core.build_prompt(lib, cfg, randomize=False)
        # 每个小类只出 1 条，顺序完全跟随菜单
        self.assertEqual(prompts[0], "齐耳短发, 黑色皮夹克, 粉色蝴蝶结上衣, 小熊刺绣卫衣, masterpiece")
        self.assertIn("头发 / 短发", details[0])

    def test_library_default_order_without_config_order(self):
        core.save_order(["上衣", "01_头发"], {"上衣": ["上衣/酷酷的", "上衣/甜美"]})
        try:
            prompts, _ = core.build_prompt(core.scan_library(),
                                           {"separator": ", ", "count": 1},
                                           randomize=False)
            self.assertTrue(prompts[0].startswith("黑色皮夹克, 粉色蝴蝶结上衣"))
            self.assertIn("齐耳短发", prompts[0])
        finally:
            core.save_order([], {})

    def test_manual_order_override_and_no_join_all(self):
        """「全部拼接」已移除：即使旧配置里带 mode=all，也只出 1 条。"""
        lib = core.scan_library()
        cfg = {
            "order": ["上衣"], "catOrder": {"上衣": ["上衣/甜美"]},
            "groups": {"01_头发": {"on": False}, core.UNGROUPED: {"on": False}},
            "cats": {"上衣/甜美": {"on": True, "mode": "all", "picks": []},
                     "上衣/可爱": {"on": False}, "上衣/酷酷的": {"on": False}},
            "separator": " | ", "count": 1,
        }
        prompts, _ = core.build_prompt(lib, cfg, randomize=False)
        self.assertEqual(prompts[0], "粉色蝴蝶结上衣")

    def test_picks_and_count(self):
        lib = core.scan_library()
        cfg = {"order": ["上衣"], "catOrder": {"上衣": ["上衣/甜美"]},
               "groups": {}, "cats": {"上衣/甜美": {"on": True,
                                                   "picks": ["蕾丝泡泡袖上衣"]}},
               "separator": ", ", "count": 3}
        prompts, _ = core.build_prompt(lib, cfg, randomize=False)
        self.assertEqual(len(prompts), 3)
        self.assertTrue(all(p.startswith("蕾丝泡泡袖上衣") for p in prompts))

        # 勾了多条词条时随机也只抽其中 1 条
        cfg["cats"]["上衣/甜美"]["picks"] = ["粉色蝴蝶结上衣", "蕾丝泡泡袖上衣"]
        cfg["count"] = 1
        prompts, details = core.build_prompt(lib, cfg, randomize=True, random_seed=7)
        hit_sweet = [w for w in ("粉色蝴蝶结上衣", "蕾丝泡泡袖上衣") if w in prompts[0]]
        self.assertEqual(len(hit_sweet), 1, "勾了多条词条时也只能抽 1 条")
        self.assertEqual(len([line for line in details[0].splitlines() if "甜美" in line]), 1)

    def test_random_group_pick(self):
        lib = core.scan_library()
        cfg = {"order": ["上衣"], "catOrder": {},
               "groups": {"上衣": {"on": True, "random": True, "pick": 1},
                          "01_头发": {"on": False}, core.UNGROUPED: {"on": False}},
               "cats": {}, "separator": ", ", "count": 1}
        prompts, details = core.build_prompt(lib, cfg, randomize=True, random_seed=7)
        # 只应出现「甜美 / 可爱 / 酷酷的」其中一组
        self.assertEqual(len([line for line in details[0].splitlines() if line]), 1)
        self.assertTrue(any(word in prompts[0] for word in
                            ("粉色蝴蝶结上衣", "蕾丝泡泡袖上衣",
                             "小熊刺绣卫衣", "娃娃领毛衣", "黑色皮夹克", "机车铆钉外套")))

    def test_random_only_from_checked(self):
        """随机只在「已勾选的小类」里抽词，没勾的大类/小类完全不参与。"""
        lib = core.scan_library()
        cfg = {
            "order": ["上衣", "01_头发", core.UNGROUPED],
            "catOrder": {"上衣": ["上衣/甜美"]},
            "groups": {"01_头发": {"on": False}, core.UNGROUPED: {"on": False}},
            "cats": {"上衣/甜美": {"on": True, "picks": []},
                     "上衣/可爱": {"on": False}, "上衣/酷酷的": {"on": False}},
            "separator": ", ", "count": 1,
        }
        for seed in range(30):
            prompts, details = core.build_prompt(lib, cfg, randomize=True, random_seed=seed)
            self.assertIn(prompts[0], ("粉色蝴蝶结上衣", "蕾丝泡泡袖上衣"))
            for forbidden in ("齐耳短发", "masterpiece", "小熊刺绣卫衣", "黑色皮夹克"):
                self.assertNotIn(forbidden, prompts[0])
            self.assertEqual(len(details[0].splitlines()), 1)

    def test_append_items(self):
        """「＋ 添加到」：只追加、保留注释、去重、支持 cat.id / cat.rel。"""
        write("收藏/甜美.txt", "# 说明注释\n已有词")   # 故意不留末尾换行
        write("收藏/可爱.txt", "小熊\n")
        try:
            result = core.append_items(["收藏/甜美", "收藏/可爱.txt"],
                                       "新词甲\n新词乙\n已有词\n新词甲\n# 注释行")
            self.assertEqual(result["lines"], 3)
            self.assertEqual(result["added"], 5)           # 甜美 +2 / 可爱 +3
            text = core.read_text(core.writable_root() / "收藏/甜美.txt").replace("\r\n", "\n")
            self.assertTrue(text.startswith("# 说明注释\n已有词\n"))
            self.assertEqual(core.parse_items(text), ["已有词", "新词甲", "新词乙"])
            self.assertEqual(core.append_items(["收藏/甜美.txt"], "新词甲\n")["added"], 0)
            with self.assertRaises(ValueError):
                core.append_items([], "x")
            with self.assertRaises(ValueError):
                core.append_items(["收藏/甜美.txt"], "  \n# 只有注释\n")
            with self.assertRaises(ValueError):
                core.append_items(["../越界.txt"], "x")
        finally:
            core.delete_path("收藏")

    def test_path_security(self):
        for bad in ("", "../evil", "a/../../b", "C:/windows", "a\\..\\b",
                    "a:bc", "CON", ".hidden", "a/" * 6, "a/b/c"):
            with self.assertRaises(ValueError, msg=bad):
                core.safe_parts(bad)
        self.assertEqual(core.safe_parts("/absolute"), ["absolute"])
        with self.assertRaises(ValueError):
            core.save_file("../evil.txt", "x")
        with self.assertRaises(ValueError):
            core.save_file("大类/小类/多余.txt", "x")
        with self.assertRaises(ValueError):
            core.delete_path("..")

    def test_save_delete_backup(self):
        result = core.save_file("测试/保存.txt", "甲\n乙\n甲\n")
        self.assertEqual(result["count"], 2)
        self.assertTrue((core.writable_root() / result["rel"]).is_file())
        core.save_file("测试/保存.txt", "丙\n", merge=True)
        self.assertEqual(core.parse_items(
            core.read_text(core.writable_root() / result["rel"])), ["甲", "乙", "丙"])
        deleted = core.delete_path(result["rel"])
        self.assertTrue(Path(deleted["backup"]).is_file())
        self.assertFalse((core.writable_root() / result["rel"]).exists())

    def test_create_group_category(self):
        core.create_group("新建大类")
        created = core.create_category("新建大类", "新建小类")
        self.assertEqual(created["rel"], "新建大类/新建小类.txt")
        self.assertTrue((core.writable_root() / created["rel"]).is_file())
        plain = core.create_category(core.UNGROUPED, "根级小类")
        self.assertEqual(plain["rel"], "根级小类.txt")
        lib = core.scan_library()
        self.assertTrue(any(c["id"] == "新建大类/新建小类" for c in lib["categories"]))
        core.delete_path("新建大类")
        core.delete_path("根级小类.txt")

    def test_flatten_target(self):
        self.assertEqual(core._flatten_target(["头发.txt"], ""), "头发.txt")
        self.assertEqual(core._flatten_target(["头发.txt"], "HTML导入"), "HTML导入/头发.txt")
        self.assertEqual(core._flatten_target(["服饰", "上衣.txt"], ""), "服饰/上衣.txt")
        self.assertEqual(core._flatten_target(["服饰", "上衣.txt"], "我的大类"), "我的大类/上衣.txt")
        self.assertEqual(core._flatten_target(["上衣", "甜美", "提示词.txt"], ""), "上衣/甜美.txt")
        self.assertEqual(core._flatten_target(["上衣", "甜美", "更多.txt"], "我的大类"),
                         "我的大类/甜美.txt")

    def test_zip_roundtrip_export_selection_and_import(self):
        core.save_order(["上衣"], {"上衣": ["上衣/甜美"]})
        data = core.export_zip()
        self.assertTrue(data.startswith(b"PK"))
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertIn("上衣/甜美.txt", archive.namelist())
            self.assertIn(core.ORDER_FILE, archive.namelist())

        # 只导出勾中的一个小类
        one = core.export_zip(["上衣/甜美"])
        with zipfile.ZipFile(io.BytesIO(one)) as archive:
            names = [n for n in archive.namelist() if n.endswith(".txt")
                     and n not in ("README.txt", core.ORDER_FILE)]
            self.assertEqual(names, ["上衣/甜美.txt"])
        # 勾大类 = 该大类下所有小类
        by_group = core.export_zip(["01_头发"])
        with zipfile.ZipFile(io.BytesIO(by_group)) as archive:
            self.assertIn("01_头发/短发.txt", archive.namelist())
            self.assertNotIn("上衣/甜美.txt", archive.namelist())
        with self.assertRaises(ValueError):
            core.export_zip(["不存在的小类"])

        before = core.scan_library()["total"]
        result = core.import_zip(data, merge=True)
        self.assertTrue(result["order"])
        self.assertEqual(core.scan_library()["total"], before)  # 合并去重，不重复计数

        # 扁平 ZIP（HTML 页面导出）+ 三级 ZIP 都展平成两级
        flat = io.BytesIO()
        with zipfile.ZipFile(flat, "w") as archive:
            archive.writestr("头发.txt", "长发\n卷发\n")
            archive.writestr("README.txt", "忽略我")
            archive.writestr("上衣/甜美/提示词.txt", "珍珠雪纺衬衫\n")
        core.import_zip(flat.getvalue(), merge=True, group="HTML导入")
        cats = {c["id"]: c for c in core.scan_library()["categories"]}
        self.assertIn("HTML导入/头发", cats)
        self.assertEqual(cats["HTML导入/头发"]["items"], ["长发", "卷发"])
        self.assertIn("HTML导入/甜美", cats)
        self.assertIn("珍珠雪纺衬衫", cats["HTML导入/甜美"]["items"])
        core.delete_path("HTML导入")
        core.save_order([], {})

    def test_config_parsing(self):
        self.assertEqual(core.parse_config("not json"), {})
        self.assertEqual(core.parse_config("[]"), {})
        self.assertEqual(core.parse_config('{"a":1}'), {"a": 1})


if __name__ == "__main__":
    unittest.main(verbosity=2)
