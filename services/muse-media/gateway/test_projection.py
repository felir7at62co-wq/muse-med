"""Public-data and download-manifest projection regressions."""

import json
import unittest

from projection import public_url, safe_files, safe_result


class ProjectionTests(unittest.TestCase):
    def test_content_preserves_public_fields_without_private_transport_data(self):
        value = {
            "status": "ok", "task_id": "upstream-task", "download_id": "upstream-download",
            "message": "private-key", "platform": "douyin", "cached": False,
            "data": {
                "content_id": "7660875690212492466", "title": "标题", "description": "内容",
                "web_url": "https://www.douyin.com/video/7660875690212492466?token=signed#section",
                "author": {"uid": "MS4wLjAB-user", "nickname": "作者", "raw": {"cookie": "private-cookie"}},
                "stats": {"play_count": None, "digg_count": 0, "share_count": 12},
                "media": {"video": {"url": "https://cdn.example/video?signature=private-signature"}},
                "raw": {"authorization": "private-key"}, "directory": "/var/lib/private-path",
            },
        }
        projected = safe_result("get_video", value)
        self.assertEqual(projected["data"]["content_id"], "7660875690212492466")
        self.assertEqual(projected["data"]["stats"], {"play_count": None, "digg_count": 0, "share_count": 12})
        self.assertEqual(projected["data"]["web_url"], "https://www.douyin.com/video/7660875690212492466")
        self.assertEqual(projected["data"]["author"], {"uid": "MS4wLjAB-user", "nickname": "作者"})
        wire = json.dumps(projected)
        for forbidden in ("upstream-task", "upstream-download", "private-key", "private-cookie", "private-signature", "private-path", "token=", "media", "raw"):
            self.assertNotIn(forbidden, wire)

    def test_comments_keep_opaque_pagination_and_null_counts(self):
        value = {"status": "ok", "data": {"items": [{"comment_id": "123", "content_id": "456", "parent_id": None, "text": "评论", "digg_count": 0, "reply_count": None, "author": {"uid": "user", "nickname": "昵称"}}], "cursor": "eyJtYXhfY3Vyc29yIjoxfQ==", "has_more": True}}
        projected = safe_result("list_comments", value)
        self.assertEqual(projected["data"]["cursor"], value["data"]["cursor"])
        self.assertTrue(projected["data"]["has_more"])
        self.assertIsNone(projected["data"]["items"][0]["reply_count"])
        self.assertEqual(projected["data"]["items"][0]["text"], "评论")

    def test_history_keeps_measurements_without_arbitrary_messages(self):
        history = safe_result("get_content_history", {"status": "ok", "since": "2026-01-01T00:00:00+00:00", "point_count": 1, "truncated": False, "points": [{"ts": "2026-01-02T00:00:00Z", "play_count": None, "digg_count": 7, "cookie": "secret"}]})
        self.assertEqual(history["points"], [{"ts": "2026-01-02T00:00:00Z", "play_count": None, "digg_count": 7}])

    def test_download_manifest_only_accepts_finished_safe_hash_named_files(self):
        valid = {"name": "video.mp4", "kind": "video", "state": "done", "bytes": 33, "sha256": "AB" * 32, "content_type": "video/mp4", "export_name": "ignored.mp4", "directory": "/private"}
        invalid = [{**valid, "name": "../other.mp4"}, {**valid, "name": "sub/video.mp4"}, {**valid, "name": ".hidden"}, {**valid, "name": "x%2Fvideo.mp4"}, {**valid, "name": "bad.mp4", "sha256": None}, {**valid, "name": "failed.mp4", "state": "failed"}, {**valid, "name": "bool.mp4", "bytes": True}]
        projected = safe_files({"files": [valid, valid, *invalid]})
        self.assertEqual(projected, [{"name": "video.mp4", "kind": "video", "bytes": 33, "sha256": "ab" * 32}])
        download = safe_result("download_media", {"status": "ok", "download_id": "private", "data": {"id": "private", "state": "done", "directory": "/private", "files": [valid]}})
        self.assertEqual(download["data"]["files"], projected)
        self.assertNotIn("private", json.dumps(download))

    def test_link_hosts_and_embedded_signed_links_are_limited(self):
        for url in ("https://douyin.com.evil.test/video/1", "https://douyin.com@evil.test/video/1", "https://www.douyin.com:444/video/1", "http://www.douyin.com/video/1", "https://cdn.example/video.mp4?token=secret", "https://www.douyin.com/\x00"):
            self.assertIsNone(public_url(url), url)
        result = safe_result("get_video", {"data": {"title": "see https://cdn.example/video?signature=secret and https://www.douyin.com/video/1?token=secret"}})
        self.assertEqual(result["data"]["title"], "see [link omitted] and https://www.douyin.com/video/1")

    def test_oversized_values_are_disclosed_and_invalid_types_are_not_coerced(self):
        result = safe_result("list_user_posts", {"data": {"items": [{"title": "x" * 9000, "stats": {"digg_count": True, "play_count": -1, "share_count": "4"}}] * 205, "cursor": "z" * 4100}})
        self.assertTrue(result["projection_truncated"])
        self.assertEqual(len(result["data"]["items"]), 200)
        self.assertEqual(len(result["data"]["items"][0]["title"]), 8192)
        self.assertEqual(result["data"]["items"][0]["stats"], {})
        self.assertNotIn("cursor", result["data"])

    def test_unsupported_tools_and_nonobjects_fail(self):
        for tool, value in (("admin", {}), ("pool_status", {}), ("transcribe_video", {}), ("get_video", [])):
            with self.assertRaises(ValueError):
                safe_result(tool, value)

    def test_deep_nested_public_nodes_stop_before_unbounded_recursion(self):
        value = {"title": "leaf"}
        for _ in range(100):
            value = {"author": value}
        result = safe_result("get_user", {"data": value})
        self.assertTrue(result["projection_truncated"])
        self.assertNotIn("leaf", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
