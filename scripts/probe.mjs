import { CodexClient } from '../lib/codex.mjs';
const client = new CodexClient();
try {
  await client.connect();
  const account = await client.request('account/read', { refreshToken: false });
  const catalog = await client.request('model/list', { limit: 100 });
  console.log(JSON.stringify({ connected: true, signedIn: !!account.account, accountType: account.account?.type, models: catalog.data?.map(m => ({ id: m.id, model: m.model, isDefault: m.isDefault, effort: m.defaultReasoningEffort, efforts: m.supportedReasoningEfforts })) }, null, 2));
} catch (error) { console.error(error.message, client.stderr); process.exitCode = 1; }
finally { client.close(); }
