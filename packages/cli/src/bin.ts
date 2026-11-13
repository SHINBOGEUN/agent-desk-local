import { CodexRuntime } from '#runtime-codex';
import { main, terminalAsk } from './main.ts';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

const code = await main(process.argv.slice(2), {
  env: process.env,
  platform: process.platform,
  cwd: process.cwd(),
  out: text => void process.stdout.write(text),
  err: text => void process.stderr.write(text),
  ...(process.stdin.isTTY ? { ask: terminalAsk(process.stdin, process.stdout) } : {}),
  createRuntime: (kind, command) => {
    if (kind === 'fake') throw new Error('the fake runtime is for tests only');
    return new CodexRuntime(command ? { command } : {});
  },
  signal: controller.signal,
});
process.exit(code);
