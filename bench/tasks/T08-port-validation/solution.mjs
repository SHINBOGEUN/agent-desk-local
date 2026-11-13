import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/config.mjs', '  return {\n    port: Number(env.PORT || 3100),',
    "  const port = env.PORT === undefined || env.PORT === '' ? 3100 : Number(env.PORT);\n  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535');\n  return {\n    port,");
}
