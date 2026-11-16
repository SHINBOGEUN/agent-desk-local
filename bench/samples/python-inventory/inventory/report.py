"""Text rendering helpers."""


def format_price(cents):
    return f"${cents / 100}"


def render_line(item):
    return f"{item.sku}  {item.name}  x{item.qty}  {format_price(item.price_cents)}"


def render_report(inventory):
    lines = [render_line(item) for item in inventory.list()]
    lines.append(f"TOTAL {format_price(inventory.total_value_cents())}")
    return "\n".join(lines)
