import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'inventory/store.py', '    def low_stock(', `    def search(self, query):
        needle = query.strip().lower()
        if not needle:
            return []
        return [item for item in self.list() if needle in item.sku.lower() or needle in item.name.lower()]

    def low_stock(`);
  edit(directory, 'inventory/cli.py', '    elif command == "low":', `    elif command == "search":
        for item in inventory.search(argv[1] if len(argv) > 1 else ""):
            print(render_line(item), file=out)
    elif command == "low":`);
}
