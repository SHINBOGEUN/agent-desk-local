// Used by reference solutions (solution.mjs) to prove each hidden test is solvable.
import fs from 'node:fs';
import path from 'node:path';

export function edit(directory, file, from, to) {
  const target = path.join(directory, file);
  const contents = fs.readFileSync(target, 'utf8');
  if (!contents.includes(from)) throw new Error(`reference solution anchor not found in ${file}: ${from.slice(0, 60)}`);
  fs.writeFileSync(target, contents.replace(from, to));
}

export function append(directory, file, text) {
  fs.appendFileSync(path.join(directory, file), text);
}
