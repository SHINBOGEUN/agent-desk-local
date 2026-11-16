import unittest

from inventory.store import Inventory


class StoreTest(unittest.TestCase):
    def test_add_and_get(self):
        inv = Inventory()
        inv.add("A1", "Widget", 3, 250)
        self.assertEqual(inv.get("A1").name, "Widget")

    def test_duplicate_rejected(self):
        inv = Inventory()
        inv.add("A1", "Widget", 3, 250)
        with self.assertRaises(ValueError):
            inv.add("A1", "Other", 1, 100)

    def test_list_sorted_by_sku(self):
        inv = Inventory()
        inv.add("B2", "Bolt", 1, 10)
        inv.add("A1", "Axle", 1, 10)
        self.assertEqual([i.sku for i in inv.list()], ["A1", "B2"])

    def test_low_stock(self):
        inv = Inventory()
        inv.add("A1", "Axle", 2, 10)
        inv.add("B2", "Bolt", 50, 10)
        self.assertEqual([i.sku for i in inv.low_stock()], ["A1"])


if __name__ == "__main__":
    unittest.main()
