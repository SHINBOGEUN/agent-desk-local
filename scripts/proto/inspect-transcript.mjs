// Prints what happened around MCP tool calls in a P1 transcript.
//   node scripts/proto/inspect-transcript.mjs <path to transcript.jsonl>
import fs from 'node:fs';
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/proto/inspect-transcript.mjs <transcript.jsonl>'); process.exit(2); }
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
let turn = 0;
for (const message of lines) {
  if (message.method === 'turn/started') turn++;
  if (turn !== 1) continue;
  const item = message.params?.item;
  const interesting = message.dir === 'in' && (
    /^item\/(started|completed)$/.test(message.method || '') && item
    || /mcp|error|warning/i.test(message.method || '')
    || (message.id !== undefined && message.method));
  if (!interesting) continue;
  const text = JSON.stringify(item ? { method: message.method, type: item.type, status: item.status, tool: item.tool, server: item.server, error: item.error, result: item.result, text: item.text } : message);
  console.log(text.slice(0, 900));
}
