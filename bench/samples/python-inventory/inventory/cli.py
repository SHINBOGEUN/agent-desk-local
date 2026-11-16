"""Command line entry: python -m inventory.cli <command>."""
import sys

from . import store
from .report import render_line, render_report


def main(argv, path=store.DEFAULT_PATH, out=sys.stdout):
    inventory = store.load(path)
    command = argv[0] if argv else "list"
    if command == "add":
        sku, name, qty, price = argv[1], argv[2], int(argv[3]), int(argv[4])
        inventory.add(sku, name, qty, price)
        store.save(inventory, path)
        print(f"added {sku}", file=out)
    elif command == "list":
        for item in inventory.list():
            print(render_line(item), file=out)
    elif command == "report":
        print(render_report(inventory), file=out)
    elif command == "low":
        for item in inventory.low_stock():
            print(render_line(item), file=out)
    else:
        print(f"unknown command: {command}", file=out)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
