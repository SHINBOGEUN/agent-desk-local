export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3100),
    dataFile: env.DATA_FILE || 'data/todos.json',
  };
}
