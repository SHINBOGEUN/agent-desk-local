import io
import os
import tempfile
import unittest

from inventory import cli
from inventory.report import render_report
from inventory.store import Inventory


class ReportTest(unittest.TestCase):
    def test_report_lists_items_and_total(self):
        inv = Inventory()
        inv.add("A1", "Widget", 2, 125)
        text = render_report(inv)
        self.assertIn("A1", text)
        self.assertIn("TOTAL", text)

    def test_cli_add_and_list(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "inv.json")
            cli.main(["add", "A1", "Widget", "2", "125"], path=path, out=io.StringIO())
            out = io.StringIO()
            cli.main(["list"], path=path, out=out)
            self.assertIn("Widget", out.getvalue())


if __name__ == "__main__":
    unittest.main()
