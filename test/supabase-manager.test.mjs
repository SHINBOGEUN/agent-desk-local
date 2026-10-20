import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SupabaseManager } from '../lib/supabase-manager.mjs';

test('Supabase connection secrets stay private and migrations require a matching fresh preview', async t => {
  const testRoot = path.resolve('.runtime', 'tests'); fs.mkdirSync(testRoot, { recursive:true });
  const root = fs.mkdtempSync(path.join(testRoot, 'agent-desk-supabase-'));
  assert.ok(path.resolve(root).startsWith(testRoot + path.sep));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const projectPath = path.join(root, 'project');
  const dataDirectory = path.join(root, 'agent-desk-data');
  const migrationName = '202610180001_group_notification_read_state.sql';
  fs.mkdirSync(path.join(projectPath, 'supabase', 'migrations'), { recursive:true });
  fs.writeFileSync(path.join(projectPath, 'supabase', 'migrations', migrationName), 'select 1;');
  fs.mkdirSync(path.join(dataDirectory, 'tools', 'supabase-cli', 'node_modules', '.bin'), { recursive:true });
  fs.writeFileSync(path.join(dataDirectory, 'tools', 'supabase-cli', 'node_modules', '.bin', 'supabase.cmd'), '');
  const calls = [];
  const manager = new SupabaseManager({
    dataDirectory, projects:() => [{ id:'local-app', path:projectPath }], platform:'win32',
    encrypt:async value => `encrypted:${Buffer.from(value).toString('base64')}`, decrypt:async value => Buffer.from(value.replace(/^encrypted:/, ''), 'base64').toString('utf8'),
    run:async (_command, _args, options) => {
      const args = JSON.parse(options.env.AGENT_DESK_SUPABASE_ARGS || '[]'); calls.push({ args, options });
      if (args.includes('init')) { fs.mkdirSync(path.join(options.cwd, 'supabase'), { recursive:true }); fs.writeFileSync(path.join(options.cwd, 'supabase', 'config.toml'), 'project_id = "local"'); return { code:0, stdout:'initialized', stderr:'' }; }
      if (args.includes('link')) { fs.mkdirSync(path.join(options.cwd, 'supabase', '.temp'), { recursive:true }); fs.writeFileSync(path.join(options.cwd, 'supabase', '.temp', 'project-ref'), 'abcdefghijklmnopqrst'); return { code:0, stdout:'linked', stderr:'' }; }
      if (args.includes('--dry-run')) return { code:0, stdout:`Would push ${migrationName.split('_')[0]}`, stderr:'' };
      if (args.includes('push')) return { code:0, stdout:'Finished supabase db push.', stderr:'' };
      return { code:1, stdout:'', stderr:'unexpected command' };
    },
  });

  const configured = await manager.configure({ projectId:'local-app', projectRef:'abcdefghijklmnopqrst', accessToken:'a'.repeat(40), databasePassword:'db-secret' });
  assert.equal(configured.hasAccessToken, true);
  assert.equal(configured.hasDatabasePassword, true);
  assert.equal(JSON.stringify(configured).includes('db-secret'), false);
  assert.equal(fs.readFileSync(manager.secretFile, 'utf8').includes('db-secret'), false);

  await assert.rejects(manager.preview('local-app', 'wrongprojectref000000'), /연결 ref: abcdefghijklmnopqrst/);
  assert.equal(calls.length, 0, 'a mismatched expected ref must stop before CLI or remote access');
  const preview = await manager.preview('local-app');
  assert.equal(preview.canApply, true);
  assert.deepEqual(preview.pending.map(item => item.name), [migrationName]);
  const result = await manager.apply('local-app', preview.previewId);
  assert.equal(result.applied, true);
  assert.ok(calls.some(call => call.args.includes('--dry-run')));
  assert.ok(calls.some(call => call.args.includes('push') && !call.args.includes('--dry-run')));
  await assert.rejects(manager.apply('local-app', preview.previewId), /미리보기가 만료됐습니다/);
});

test('Supabase apply rejects a migration changed after preview', async t => {
  const testRoot = path.resolve('.runtime', 'tests'); fs.mkdirSync(testRoot, { recursive:true });
  const root = fs.mkdtempSync(path.join(testRoot, 'agent-desk-supabase-stale-'));
  assert.ok(path.resolve(root).startsWith(testRoot + path.sep));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const projectPath = path.join(root, 'project'), dataDirectory = path.join(root, 'data');
  const migrationName = '202610180001_notification_read.sql';
  fs.mkdirSync(path.join(projectPath, 'supabase', 'migrations'), { recursive:true });
  fs.writeFileSync(path.join(projectPath, 'supabase', 'migrations', migrationName), 'select 1;');
  fs.mkdirSync(path.join(dataDirectory, 'tools', 'supabase-cli', 'node_modules', '.bin'), { recursive:true });
  fs.writeFileSync(path.join(dataDirectory, 'tools', 'supabase-cli', 'node_modules', '.bin', 'supabase.cmd'), '');
  const manager = new SupabaseManager({ dataDirectory, projects:() => [{ id:'p', path:projectPath }], platform:'win32', encrypt:async v => `encrypted:${Buffer.from(v).toString('base64')}`, decrypt:async v => Buffer.from(v.replace(/^encrypted:/, ''), 'base64').toString('utf8'), run:async (_cmd,_args,opts) => {
    const args = JSON.parse(opts.env.AGENT_DESK_SUPABASE_ARGS || '[]');
    if (args.includes('init')) { fs.mkdirSync(path.join(opts.cwd,'supabase'),{ recursive:true }); fs.writeFileSync(path.join(opts.cwd,'supabase','config.toml'),''); return { code:0,stdout:'',stderr:'' }; }
    if (args.includes('link')) { fs.mkdirSync(path.join(opts.cwd,'supabase','.temp'),{ recursive:true }); fs.writeFileSync(path.join(opts.cwd,'supabase','.temp','project-ref'),'abcdefghijklmnopqrst'); return { code:0,stdout:'',stderr:'' }; }
    if (args.includes('--dry-run')) return { code:0,stdout:`Would push ${migrationName.split('_')[0]}`,stderr:'' };
    return { code:0,stdout:'',stderr:'' };
  } });
  await manager.configure({ projectId:'p', projectRef:'abcdefghijklmnopqrst', accessToken:'a'.repeat(40) });
  const preview = await manager.preview('p');
  fs.writeFileSync(path.join(projectPath, 'supabase', 'migrations', migrationName), 'drop table users;');
  await assert.rejects(manager.apply('p', preview.previewId), /프로젝트 또는 원격 마이그레이션 상태가 바뀌었습니다/);
});
