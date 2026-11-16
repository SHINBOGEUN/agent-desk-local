"""In-memory inventory with JSON persistence."""
import json
import os
from dataclasses import dataclass, asdict

DEFAULT_PATH = "inventory.json"
LOW_STOCK_THRESHOLD = 8


@dataclass
class Item:
    sku: str
    name: str
    qty: int
    price_cents: int


class Inventory:
    def __init__(self):
        self.items = {}

    def add(self, sku, name, qty, price_cents):
        if sku in self.items:
            raise ValueError(f"duplicate sku: {sku}")
        if qty < 0 or price_cents < 0:
            raise ValueError("qty and price must not be negative")
        self.items[sku] = Item(sku, name, qty, price_cents)
        return self.items[sku]

    def get(self, sku):
        return self.items.get(sku)

    def remove(self, sku):
        if sku not in self.items:
            raise KeyError(sku)
        del self.items[sku]

    def list(self):
        return sorted(self.items.values(), key=lambda item: item.sku)

    def low_stock(self, threshold=LOW_STOCK_THRESHOLD):
        return [item for item in self.list() if item.qty < threshold]

    def total_value_cents(self):
        return sum(item.qty * item.price_cents for item in self.items.values())


def load(path=DEFAULT_PATH):
    inventory = Inventory()
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            for raw in json.load(handle):
                inventory.items[raw["sku"]] = Item(**raw)
    return inventory


def save(inventory, path=DEFAULT_PATH):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump([asdict(item) for item in inventory.list()], handle, indent=2)
