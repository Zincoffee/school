'use strict';
/**
 * 数据持久化测试：原子写、写串行化（并发不丢更新）、变更记录只追加。
 *
 * 单进程仍可能并发处理请求（例如组织者同时保存字段又上传附件），
 * 若不串行化读-改-写，就会出现「后写的覆盖先写的」这类静默丢数据。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestServer, stopTestServer, upload, PNG } = require('./helpers');

let ctx;
before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx.mod); });

test('初始化由种子数据生成运行时数据文件', async () => {
  const { ACTIVITIES_FILE, HISTORY_FILE } = ctx.mod.paths;
  assert.ok(fs.existsSync(ACTIVITIES_FILE), '未生成 activities.json');
  assert.ok(fs.existsSync(HISTORY_FILE), '未生成 history.json');
  const state = JSON.parse(fs.readFileSync(ACTIVITIES_FILE, 'utf8'));
  assert.equal(state.activities.length, 26);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.term, '2026 秋季学期');
  for (const a of state.activities) {
    assert.match(a.editToken, /^[0-9a-f]{24}$/, `${a.id} 的口令格式不正确`);
  }
});

test('并发补充不同字段不丢更新', async () => {
  const token = ctx.token('18');
  const patch = {
    location: '实验楼 A402',
    quota: '限 30 人',
    cost: '免费',
    outcome: '第二课堂学分 0.5',
    audience: '全校学生',
  };
  // 五个请求同时发出，字段互不重叠——串行化失效时会互相覆盖
  const results = await Promise.all(Object.entries(patch).map(([k, v]) =>
    ctx.send('PUT', `/api/activities/18?token=${token}`, { [k]: v })
  ));
  for (const r of results) {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed.length, 1, '每个请求应只改一个字段');
  }
  const d = await ctx.get('/api/activities/18');
  for (const [k, v] of Object.entries(patch)) {
    assert.equal(d.body.activity.fields[k], v, `字段 ${k} 丢失（并发写未串行化）`);
  }
  // 落盘数据同样完整
  const onDisk = JSON.parse(fs.readFileSync(ctx.mod.paths.ACTIVITIES_FILE, 'utf8'));
  const act = onDisk.activities.find((a) => a.id === '18');
  for (const [k, v] of Object.entries(patch)) {
    assert.equal(act.fields[k], v, `磁盘上的字段 ${k} 丢失`);
  }
});

test('并发「字段修改 + 附件上传」均被保留', async () => {
  const token = ctx.token('19');
  await Promise.all([
    ctx.send('PUT', `/api/activities/19?token=${token}`, { location: '明德楼 B203' }),
    upload(ctx, '19', '并发.png', PNG, token),
    ctx.send('PUT', `/api/activities/19?token=${token}`, { quota: '座位有限' }),
  ]);
  const d = await ctx.get('/api/activities/19');
  assert.equal(d.body.activity.fields.location, '明德楼 B203');
  assert.equal(d.body.activity.fields.quota, '座位有限');
  assert.equal(d.body.files.length, 1, '上传的附件丢失');
  assert.equal(ctx.mod._internal.listFiles('19').length, 1);
});

test('变更记录只追加，不修改也不删除', async () => {
  const token = ctx.token('16');
  const before = (await ctx.get('/api/activities/16')).body.history.length;
  await ctx.send('PUT', `/api/activities/16?token=${token}`, { quota: '限 40 人' });
  await ctx.send('PUT', `/api/activities/16?token=${token}`, { quota: '限 50 人' });
  const after = (await ctx.get('/api/activities/16')).body.history;
  assert.equal(after.length, before + 2, '变更记录应逐条追加');
  const quotalog = after.filter((h) => h.field === 'quota');
  assert.equal(quotalog.length, 2);
  // 两条记录都保留了各自的原值，可完整回溯
  const values = quotalog.map((h) => [h.oldValue, h.newValue]).sort();
  assert.deepEqual(values, [[null, '限 40 人'], ['限 40 人', '限 50 人']].sort());
});

test('写入过程不残留 .tmp 临时文件', async () => {
  const token = ctx.token('21');
  await ctx.send('PUT', `/api/activities/21?token=${token}`, { location: '外国语学院 101' });
  const { DATA_DIR } = ctx.mod.paths;
  const leftovers = fs.readdirSync(DATA_DIR).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '存在未清理的临时文件');
});

test('数据文件始终是合法 JSON（原子写不会写出半截内容）', async () => {
  const token = ctx.token('22');
  await Promise.all([
    ctx.send('PUT', `/api/activities/22?token=${token}`, { location: '场地 A' }),
    ctx.send('PUT', `/api/activities/22?token=${token}`, { quota: '6—8 人' }),
    upload(ctx, '22', 'a.png', PNG, token),
  ]);
  for (const f of [ctx.mod.paths.ACTIVITIES_FILE, ctx.mod.paths.HISTORY_FILE]) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotThrow(() => JSON.parse(text), `${path.basename(f)} 不是合法 JSON`);
    assert.ok(text.trim().endsWith('}'));
  }
});

test('补充口令在重启后保持不变（从磁盘重新加载）', async () => {
  const before = ctx.token('23');
  const serverPath = require.resolve('../server.js');
  delete require.cache[serverPath];
  // 重新加载模块 = 模拟重启：口令必须从 activities.json 读回，而不是重新生成
  const fresh = require('../server.js');
  await fresh.loadState();
  const again = fresh.state.activities.find((a) => a.id === '23').editToken;
  assert.equal(again, before, '重启后口令发生了变化，组织者手中的链接会失效');
});

test('缺失口令时会在加载阶段补生成', async () => {
  const { ACTIVITIES_FILE } = ctx.mod.paths;
  const state = JSON.parse(fs.readFileSync(ACTIVITIES_FILE, 'utf8'));
  const target = state.activities.find((a) => a.id === '25');
  const original = target.editToken;
  target.editToken = '';
  fs.writeFileSync(ACTIVITIES_FILE, JSON.stringify(state, null, 2), 'utf8');

  const serverPath = require.resolve('../server.js');
  delete require.cache[serverPath];
  const fresh = require('../server.js');
  await fresh.loadState();
  const regenerated = fresh.state.activities.find((a) => a.id === '25').editToken;
  assert.match(regenerated, /^[0-9a-f]{24}$/, '未补生成口令');
  assert.notEqual(regenerated, original);

  // 还原，避免影响同文件内后续测试
  const restored = JSON.parse(fs.readFileSync(ACTIVITIES_FILE, 'utf8'));
  restored.activities.find((a) => a.id === '25').editToken = original;
  fs.writeFileSync(ACTIVITIES_FILE, JSON.stringify(restored, null, 2), 'utf8');
  fresh.state.activities.find((a) => a.id === '25').editToken = original;
});

test('写接口对同一口令有频率限制', async () => {
  const token = ctx.token('24');
  const results = [];
  for (let i = 0; i < 35; i++) {
    results.push(await ctx.send('PUT', `/api/activities/24?token=${token}`, { cost: '第 ' + i + ' 次' }));
  }
  assert.ok(results.some((r) => r.status === 429), '未触发频率限制');
  assert.ok(results.some((r) => r.status === 200), '限制过于严格，正常请求也被拒');
});
