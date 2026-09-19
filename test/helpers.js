'use strict';
/**
 * 测试辅助：为每个测试文件创建独立的临时数据目录与随机端口，
 * 避免测试污染真实的 data/ 目录与 3000 端口。
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

function makeTempDataDir() {
  const dir = path.join(os.tmpdir(), 'school-test-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 每个测试文件都需要独占一个数据目录。
 *
 * 服务端通过环境变量 SCHOOL_DATA_DIR 决定数据目录（模块加载时读取），
 * 这在默认的 `node --test` 进程隔离模式下是安全的：每个测试文件一个进程。
 * 但若用 `--experimental-test-isolation=none` 让多个测试文件共享同一进程，
 * 各文件的 before() 会先后改写这个环境变量，导致后续断言出现难以理解的失败
 * （例如「口令发生了变化」）。这里在每次使用前校验目录归属，把那种
 * 难以定位的失败变成一条明确、可操作的错误信息。
 */
function ensureIsolated(mod, dir, base) {
  const actual = path.resolve(mod.paths.DATA_DIR);
  if (actual !== path.resolve(dir)) {
    throw new Error(
      '测试数据目录已被其他测试文件改写。\n' +
      '  期望: ' + path.resolve(dir) + '\n' +
      '  实际: ' + actual + '\n' +
      '原因通常是使用了 --experimental-test-isolation=none（多测试文件共享进程）。\n' +
      '请使用默认的进程隔离模式运行：node --test test/'
    );
  }
  return base;
}

/** 同一进程内只允许启动一套测试服务（server.js 是单实例模块） */
let serverStartedInThisProcess = false;

async function startTestServer() {
  if (serverStartedInThisProcess) {
    throw new Error(
      '检测到多个测试文件共享同一进程：server.js 是单实例模块，无法同时承载两套测试服务。\n' +
      '这通常是因为使用了 --experimental-test-isolation=none。\n' +
      '请使用默认的进程隔离模式运行测试：node --test test/'
    );
  }
  serverStartedInThisProcess = true;

  const dir = makeTempDataDir();
  // 必须在 require server.js 之前设置，因为模块在加载时读取该变量
  process.env.SCHOOL_DATA_DIR = dir;
  const mod = require('../server.js');
  const port = await mod.startServer(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const check = () => ensureIsolated(mod, dir, base);
  return {
    mod, dir, port, base, check,
    async get(p) {
      check();
      const res = await fetch(base + p);
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async send(method, p, body, headers) {
      check();
      const res = await fetch(base + p, {
        method,
        headers: headers || { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    token(id) {
      check();
      const a = mod.state.activities.find((x) => x.id === id);
      if (!a) throw new Error('测试活动不存在: ' + id);
      return a.editToken;
    },
    activity(id) {
      check();
      return mod.state.activities.find((x) => x.id === id);
    },
  };
}

async function stopTestServer(mod) {
  await new Promise((r) => mod.server.close(r));
}

/** 1x1 透明 PNG（真实可解的图片，用于验证魔数校验） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');
/** ZIP 容器（docx/pptx 的真实文件头） */
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0)]);
const UTF8_TEXT = Buffer.from('中文文本，UTF-8 编码。\n', 'utf8');
/** “你好” 的 GBK 字节 */
const GBK_TEXT = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);

async function upload(ctx, id, filename, buffer, token) {
  ctx.check();
  const fd = new FormData();
  fd.append('file', new Blob([buffer]), filename);
  const res = await fetch(
    `${ctx.base}/api/activities/${id}/files?token=${encodeURIComponent(token || ctx.token(id))}`,
    { method: 'POST', body: fd }
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(bytes);
  w.close();
  return Buffer.from(await new Response(cs.readable).arrayBuffer());
}

/**
 * 合成一个 ZIP 容器（method=8），用于在测试中构造 docx / pptx。
 * 注：CRC32 写 0——读取端（public/ooxml.js）不校验 CRC，仅解析目录与解压。
 */
async function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const comp = await deflateRaw(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** 合成一个最小 .docx（含一段正文与一个表格行） */
async function makeDocx(bodyXml) {
  const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    (bodyXml || '<w:p><w:r><w:t>测试文档</w:t></w:r></w:p>') +
    '</w:body></w:document>';
  return makeZip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': xml,
  });
}

/** 合成一个最小 .pptx（两页） */
async function makePptx(slideTexts) {
  const files = { '[Content_Types].xml': '<Types/>' };
  (slideTexts || ['第一页标题', '第二页内容']).forEach((t, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree>' +
      `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>` +
      '</p:spTree></p:cSld></p:sld>';
  });
  return makeZip(files);
}

module.exports = {
  makeTempDataDir, startTestServer, stopTestServer, upload,
  makeZip, makeDocx, makePptx, deflateRaw,
  PNG, PDF, ZIP, UTF8_TEXT, GBK_TEXT,
  REPO: path.join(__dirname, '..'),
};
