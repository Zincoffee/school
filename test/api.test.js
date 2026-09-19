'use strict';
/**
 * 接口测试：6 个接口的正常与异常路径。
 *
 * 其中最重要的一条断言是「任何 GET 响应都不得包含 editToken」——
 * 一旦泄露，任何人打开列表接口即可拿到全部 26 个补充口令。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer } = require('./helpers');

let ctx;
before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx.mod); });

test('GET /api/activities 返回卡片数据并默认过滤已结束', async () => {
  const r = await ctx.get('/api/activities');
  assert.equal(r.status, 200);
  assert.equal(r.body.term, '2026 秋季学期');
  // 26 条中 2 条为合并条目（09、20），默认再排除已结束/已截止
  assert.ok(r.body.total > 0 && r.body.total <= 24, `总数异常: ${r.body.total}`);
  for (const it of r.body.items) {
    assert.ok(it.id && it.name);
    assert.ok(it.status, '缺少状态');
    assert.ok(it.fields, '缺少字段');
    assert.ok(!it.merged, '合并条目不应出现在列表里');
  }
});

test('列表默认排除已结束与报名已截止，includeClosed 可调出', async () => {
  const open = await ctx.get('/api/activities');
  const all = await ctx.get('/api/activities?includeClosed=1');
  assert.equal(all.body.total, 24, '不含合并条目时应有 24 条');
  assert.ok(open.body.total < all.body.total, '默认过滤未生效');
  const statuses = new Set(all.body.items.map((i) => i.status));
  assert.ok(!open.body.items.some((i) => i.status === '已结束'));
  assert.ok(!open.body.items.some((i) => i.status === '报名已截止'));
  assert.ok(statuses.has('已结束') || statuses.has('报名已截止'), '数据中应存在已结束或已截止条目');
});

test('列表支持关键词与筛选参数', async () => {
  const byQ = await ctx.get('/api/activities?q=' + encodeURIComponent('Git'));
  assert.ok(byQ.body.total >= 1, '关键词搜索应有结果');
  const byThreshold = await ctx.get('/api/activities?threshold=' + encodeURIComponent('零基础'));
  for (const it of byThreshold.body.items) {
    assert.match(it.fields.threshold || '', /零基础|不限基础/);
  }
  const byStatus = await ctx.get('/api/activities?status=' + encodeURIComponent('无需报名'));
  for (const it of byStatus.body.items) assert.equal(it.status, '无需报名');
});

test('列表与详情响应均不包含 editToken', async () => {
  const list = await fetch(ctx.base + '/api/activities');
  const listText = await list.text();
  assert.ok(!listText.includes('editToken'), '列表接口泄露了 editToken');

  const detail = await fetch(ctx.base + '/api/activities/01');
  const detailText = await detail.text();
  assert.ok(!detailText.includes('editToken'), '详情接口泄露了 editToken');

  // 遍历全部活动详情，确保没有任何一条泄露
  const all = await ctx.get('/api/activities?includeClosed=1');
  for (const it of all.body.items) {
    const res = await fetch(ctx.base + '/api/activities/' + it.id);
    const text = await res.text();
    assert.ok(!text.includes('editToken'), `活动 ${it.id} 的详情泄露了 editToken`);
  }
});

test('GET /api/activities/:id 返回字段、附件、变更记录与合并来源', async () => {
  const r = await ctx.get('/api/activities/01');
  assert.equal(r.status, 200);
  assert.equal(r.body.activity.id, '01');
  assert.ok(r.body.activity.fields);
  assert.ok(Array.isArray(r.body.files));
  assert.deepEqual(r.body.mergedFrom, ['09'], '01 应合并补充通知 09');
  assert.ok(r.body.history.length > 0, '01 应有来自补充通知的变更记录');
  for (const h of r.body.history) {
    assert.ok(h.fieldLabel, '变更记录缺少可读字段名');
    assert.ok(h.changedAt);
  }
});

test('合并条目被回填：01 的地点来自补充通知 09', async () => {
  const r = await ctx.get('/api/activities/01');
  assert.equal(r.body.activity.fields.location, '实验楼 A402');
  assert.equal(r.body.activity.fields.location_status, '明确');
});

test('变更记录中不含「不变」这类空操作', async () => {
  const all = await ctx.get('/api/activities?includeClosed=1');
  for (const it of all.body.items) {
    const d = await ctx.get('/api/activities/' + it.id);
    for (const h of d.body.history) {
      assert.notEqual(h.newValue, '不变', `活动 ${it.id} 存在无意义的「不变」记录`);
      assert.notEqual(h.oldValue, h.newValue, `活动 ${it.id} 存在原值与新值相同的记录`);
    }
  }
});

test('GET /api/activities/:id 对不存在的编号返回 404', async () => {
  const r = await ctx.get('/api/activities/99');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'not_found');
});

test('口令校验：错误口令 403，正确口令通过', async () => {
  const bad = await ctx.get('/api/activities/01/verify?token=deadbeef');
  assert.equal(bad.status, 403);
  assert.equal(bad.body.error, 'invalid_token');

  const noToken = await ctx.get('/api/activities/01/verify');
  assert.equal(noToken.status, 403);

  const good = await ctx.get('/api/activities/01/verify?token=' + ctx.token('01'));
  assert.equal(good.status, 200);
  assert.equal(good.body.ok, true);
});

test('PUT 无口令或错口令返回 403 且不修改数据', async () => {
  const before = (await ctx.get('/api/activities/02')).body.activity.fields.location;
  const r = await ctx.send('PUT', '/api/activities/02', { location: '被篡改的地点' });
  assert.equal(r.status, 403);
  const after = (await ctx.get('/api/activities/02')).body.activity.fields.location;
  assert.equal(after, before, '无口令的请求不应修改数据');
});

test('PUT 正确口令可修改字段并写入变更记录', async () => {
  const token = ctx.token('02');
  const r = await ctx.send('PUT', `/api/activities/02?token=${token}`,
    { location: '计算机学院教学楼 305', reason: '补充房间号' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed, ['location']);
  assert.ok(r.body.updatedAt);

  const d = await ctx.get('/api/activities/02');
  assert.equal(d.body.activity.fields.location, '计算机学院教学楼 305');
  const rec = d.body.history.find((h) => h.field === 'location');
  assert.ok(rec, '缺少变更记录');
  assert.equal(rec.newValue, '计算机学院教学楼 305');
  assert.equal(rec.reason, '补充房间号');
  assert.equal(rec.source, 'organizer');
});

test('PUT 忽略不可编辑字段，且空字符串等价于清空', async () => {
  const token = ctx.token('05');
  const r = await ctx.send('PUT', `/api/activities/05?token=${token}`,
    { id: '99', name: '改名尝试', editToken: 'x', location: '' });
  assert.equal(r.status, 200);
  assert.ok(!r.body.changed.includes('id'), 'id 不应可编辑');
  assert.ok(!r.body.changed.includes('name'), 'name 不应可编辑');
  const d = await ctx.get('/api/activities/05');
  assert.equal(d.body.activity.id, '05', 'id 被改动了');
  assert.equal(d.body.activity.fields.location, null, '空字符串应清空为 null');
});

test('PUT 请求体非法时返回 400', async () => {
  const token = ctx.token('06');
  const bad = await ctx.send('PUT', `/api/activities/06?token=${token}`, '{不是 JSON');
  assert.equal(bad.status, 400);
  const arr = await ctx.send('PUT', `/api/activities/06?token=${token}`, '[1,2,3]');
  assert.equal(arr.status, 400);
});

test('静态资源：首页可达且引用了前端脚本', async () => {
  const res = await fetch(ctx.base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /校园活动与机会平台/);
  assert.match(html, /\/app\.js/);
  for (const p of ['/app.js', '/ooxml.js', '/style.css', '/activity.html', '/edit.html']) {
    const r = await fetch(ctx.base + p);
    assert.equal(r.status, 200, `${p} 不可达`);
  }
});

test('静态资源阻断路径穿越', async () => {
  for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/../design/activities.seed.json']) {
    const res = await fetch(ctx.base + p);
    assert.notEqual(res.status, 200, `${p} 不应可访问`);
  }
});

test('未知接口返回 404 JSON', async () => {
  const r = await ctx.get('/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'not_found');
});
