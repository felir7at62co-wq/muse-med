"""The rendered shared-host locations serve only Jingliu's media folders under /jingliu/fwp/media/."""
import importlib.util
import re
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("nginx_locations", Path(__file__).with_name("shared-host") / "nginx_locations.py")
nginx_locations = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(nginx_locations)


class JingliuMediaLocation(unittest.TestCase):
    def setUp(self):
        rendered = nginx_locations.render()
        self.block = rendered.split("location ^~ /jingliu/fwp/media/ {", 1)[1].split("\n}\n", 1)[0]
        self.allowed = re.compile(re.search(r'if \(\$uri !~ "([^"]+)"\) \{ return 404; \}', self.block).group(1))

    def test_media_folders_pass_and_data_files_do_not(self):
        for path in ("generated/a.png", "uploads/b.mp4", "character-references/c.webp", "exports/jianying/d.zip"):
            self.assertTrue(self.allowed.search("/jingliu/fwp/media/" + path), path)
        for path in ("jingliu.db", "jingliu.db-wal", "backups/jingliu_1.db", "muse-login.sqlite3", "generatedx/a.png"):
            self.assertIsNone(self.allowed.search("/jingliu/fwp/media/" + path), path)

    def test_dot_names_are_refused_and_media_needs_the_jingliu_sign_in(self):
        self.assertIn('if ($uri ~ "/\\.") { return 404; }', self.block)
        self.assertIn("auth_request /_muse_wb_auth_jingliu;", self.block)
        self.assertIn("proxy_pass http://127.0.0.1:19743/;", self.block)


if __name__ == "__main__":
    unittest.main()
