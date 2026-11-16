import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'inventory/report.py', 'return f"${cents / 100}"', 'return f"${cents // 100}.{cents % 100:02d}"');
}
