import unittest

from inventory.report import format_price, render_report
from inventory.store import Inventory


class PriceFormat(unittest.TestCase):
    def test_always_two_decimals(self):
        self.assertEqual(format_price(1000), "$10.00")
        self.assertEqual(format_price(50), "$0.50")
        self.assertEqual(format_price(5), "$0.05")
        self.assertEqual(format_price(0), "$0.00")
        self.assertEqual(format_price(1999), "$19.99")
        self.assertEqual(format_price(1005), "$10.05")

    def test_report_uses_it(self):
        inv = Inventory()
        inv.add("A1", "Widget", 2, 500)
        text = render_report(inv)
        self.assertIn("$5.00", text)
        self.assertIn("TOTAL $10.00", text)


if __name__ == "__main__":
    unittest.main()
