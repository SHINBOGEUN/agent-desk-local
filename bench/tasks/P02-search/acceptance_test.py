import io
import os
import tempfile
import unittest

from inventory import cli
from inventory.store import Inventory


def sample():
    inv = Inventory()
    inv.add("B2", "Bolt", 10, 100)
    inv.add("A1", "Axle Widget", 3, 250)
    inv.add("C3", "widget clamp", 7, 75)
    return inv


class Search(unittest.TestCase):
    def test_matches_name_case_insensitive_sorted(self):
        self.assertEqual([i.sku for i in sample().search("WIDGET")], ["A1", "C3"])

    def test_matches_sku(self):
        self.assertEqual([i.sku for i in sample().search("b2")], ["B2"])

    def test_blank_query_is_empty(self):
        self.assertEqual(sample().search(""), [])
        self.assertEqual(sample().search("   "), [])

    def test_no_match(self):
        self.assertEqual(sample().search("zzz"), [])

    def test_cli_search(self):
        from inventory import store
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "inv.json")
            store.save(sample(), path)
            out = io.StringIO()
            cli.main(["search", "widget"], path=path, out=out)
            lines = out.getvalue().strip().splitlines()
            self.assertEqual(len(lines), 2)
            self.assertTrue(lines[0].startswith("A1"))
            self.assertTrue(lines[1].startswith("C3"))
            listed = io.StringIO()
            cli.main(["list"], path=path, out=listed)
            self.assertIn(lines[0], listed.getvalue())


if __name__ == "__main__":
    unittest.main()
