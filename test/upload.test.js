'use strict';
/**
 * 上传与文件类型校验测试。
 *
 * 重点：仅校验扩展名不足以防攻击，因此服务端做 magic number 校验——
 * 本文件验证「改扩展名的伪装文件」会被拒绝，这是方案里明确的安全要求。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestServer, stopTestServer, upload, makeDocx, makePptx, PNG, PDF, ZIP, UTF8_TEXT } = require('./helpers');

let ctx;
before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx.mod); });

test('接受合法 PNG 并能通过 /files 读回', async () => {
  const r = await upload(ctx, '02', '场地示意.png', PNG);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.accepted, ['场地示意.png']);
  const files = r.body.files;
  assert.equal(files.length, 1);
  assert.equal(files[0].type, 'image/png');

  const res = await fetch(ctx.base + files[0].url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const back = Buffer.from(await res.arrayBuffer());
  assert.ok(back.equals(PNG), '读回的内容与原文件不一致');
});

test('接受合法 PDF 与 txt', async () => {
  const a = await upload(ctx, '05', '报名须知.pdf', PDF);
  assert.equal(a.status, 200);
  const b = await upload(ctx, '05', '须知.txt', UTF8_TEXT);
  assert.equal(b.status, 200);
});

test('接受 docx / pptx（ZIP 容器）', async () => {
  const docx = await makeDocx();
  const pptx = await makePptx();
  const a = await upload(ctx, '06', '宣讲.docx', docx);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await upload(ctx, '06', '宣讲.pptx', pptx);
  assert.equal(b.status, 200, JSON.stringify(b.body));
});

test('拒绝「改扩展名」的伪装文件：ZIP 内容命名为 .png', async () => {
  const r = await upload(ctx, '07', '假图片.png', ZIP);
  assert.equal(r.status, 415);
  assert.equal(r.body.error, 'unsupported_type');
  assert.match(r.body.message, /文件内容与扩展名/);
});

test('拒绝可执行文件与不在白名单的扩展名', async () => {
  for (const [name, buf] of [
    ['virus.exe', Buffer.from('MZ\x90\x00', 'binary')],
    ['script.js', Buffer.from('alert(1)', 'utf8')],
    ['macro.docm', ZIP],
    ['macro.pptm', ZIP],
    ['old.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0])],
    ['slides.pdf.exe', ZIP],
  ]) {
    const r = await upload(ctx, '08', name, buf);
    assert.equal(r.status, 415, `${name} 应被拒绝，实际 ${r.status}`);
    assert.equal(r.body.error, 'unsupported_type');
  }
});

test('拒绝把文本内容伪装成图片', async () => {
  const r = await upload(ctx, '09', '假图片.jpg', Buffer.from('这不是 JPEG', 'utf8'));
  assert.equal(r.status, 415);
});

test('拒绝空文件', async () => {
  const r = await upload(ctx, '10', 'empty.txt', Buffer.alloc(0));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_request');
});

test('超过 20MB 返回 413', async () => {
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(21 * 1024 * 1024)]);
  const r = await upload(ctx, '11', 'huge.png', big);
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'too_large');
});

test('单活动附件数量上限 10 个', async () => {
  const results = [];
  for (let i = 0; i < 10; i++) results.push(await upload(ctx, '12', `f${i}.png`, PNG));
  for (const r of results) assert.equal(r.status, 200);
  const over = await upload(ctx, '12', 'f11.png', PNG);
  assert.equal(over.status, 400);
  assert.equal(over.body.error, 'too_many_files');
  assert.equal(ctx.mod._internal.listFiles('12').length, 10);
});

test('文件名被安全化：去掉路径成分与控制字符', async () => {
  const r = await upload(ctx, '13', '../../etc/passwd.png', PNG);
  assert.equal(r.status, 200);
  const name = r.body.accepted[0];
  assert.ok(!name.includes('/'), `文件名仍含路径分隔符: ${name}`);
  assert.ok(!name.includes('..'), `文件名仍含 ..: ${name}`);
  const dir = path.join(ctx.mod.paths.UPLOAD_DIR, '13');
  const onDisk = fs.readdirSync(dir);
  assert.equal(onDisk.length, 1);
  assert.ok(fs.existsSync(path.join(dir, onDisk[0])));
});

test('同名文件自动追加序号，不覆盖已有文件', async () => {
  await upload(ctx, '14', '同名.png', PNG);
  await upload(ctx, '14', '同名.png', PNG);
  const names = ctx.mod._internal.listFiles('14').map((f) => f.name).sort();
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
});

test('上传无口令或不存在的活动会被拒绝', async () => {
  const bad = await upload(ctx, '15', 'a.png', PNG, 'wrongtoken');
  assert.equal(bad.status, 403);
  const missing = await fetch(`${ctx.base}/api/activities/99/files?token=x`, {
    method: 'POST', body: new FormData(),
  });
  assert.equal(missing.status, 404);
});

test('附件读取接口阻断路径穿越', async () => {
  await upload(ctx, '16', 'ok.png', PNG);
  for (const p of [
    '/files/16/..%2f..%2fserver.js',
    '/files/16/%2e%2e%2f%2e%2e%2fserver.js',
    '/files/16/../../../server.js',
    '/files/99/ok.png',
    '/files/16/not-exists.png',
  ]) {
    const res = await fetch(ctx.base + p);
    assert.notEqual(res.status, 200, `${p} 不应可读`);
  }
});

test('附件编号非两位数格式时拒绝', async () => {
  const res = await fetch(ctx.base + '/files/abc/ok.png');
  assert.equal(res.status, 404);
});

test('上传会在变更记录中留痕', async () => {
  await upload(ctx, '17', '资料.pdf', PDF);
  const d = await ctx.get('/api/activities/17');
  const rec = d.body.history.find((h) => h.field === 'files');
  assert.ok(rec, '上传未写入变更记录');
  assert.equal(rec.source, 'organizer');
  assert.match(rec.newValue, /资料\.pdf/);
});
