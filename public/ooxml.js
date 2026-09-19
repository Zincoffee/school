/**
 * ooxml.js —— 零依赖的 docx / pptx 文本提取
 *
 * 为什么不用 mammoth：本项目要求"零 npm 依赖、可离线运行"。docx/pptx 本质是 ZIP + XML，
 * 浏览器与 Node 都内置了 DecompressionStream('deflate-raw')，因此可以自己解压并抽取文本，
 * 无需引入任何第三方库。
 *
 * 取舍：只提取文字，不保留版式（字体、颜色、表格边框会丢失）。
 * 若日后需要更保真的渲染，可把 mammoth.browser.min.js 放入 public/vendor/ 并在
 * public/app.js 的 docx 分支里优先使用它——本模块可作为其缺失时的兜底。
 *
 * 该文件同时可在浏览器（全局 OOXML）与 Node（module.exports）中加载，
 * 以便在 node:test 中直接对真实文档做测试。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OOXML = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIG_EOCD = 0x06054b50; // 中央目录结束记录
  const SIG_CEN = 0x02014b50;  // 中央目录条目
  const SIG_LOC = 0x04034b50;  // 本地文件头

  const MAX_TEXT = 20000;      // 单次预览的文本上限，防止超大文档卡住页面
  const MAX_ENTRY = 20 * 1024 * 1024; // 单个条目解压上限，防 zip bomb

  function toU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    throw new Error('需要 Uint8Array 或 ArrayBuffer');
  }
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  function findEOCD(buf) {
    // EOCD 位于文件末尾，注释最长 65535 字节
    const lower = Math.max(0, buf.length - 65558);
    for (let i = buf.length - 22; i >= lower; i--) {
      if (u32(buf, i) === SIG_EOCD) return i;
    }
    return -1;
  }

  /** 解析中央目录，返回 [{ name, method, compSize, uncompSize, localOffset }] */
  function centralDirectory(buf) {
    const eocd = findEOCD(buf);
    if (eocd < 0) throw new Error('不是有效的 ZIP 容器（未找到中央目录）');
    const count = u16(buf, eocd + 10);
    let p = u32(buf, eocd + 16);
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || u32(buf, p) !== SIG_CEN) break;
      const method = u16(buf, p + 10);
      const compSize = u32(buf, p + 20);
      const uncompSize = u32(buf, p + 24);
      const nameLen = u16(buf, p + 28);
      const extraLen = u16(buf, p + 30);
      const commentLen = u16(buf, p + 32);
      const localOffset = u32(buf, p + 42);
      const name = new TextDecoder('utf-8').decode(buf.subarray(p + 46, p + 46 + nameLen));
      entries.push({ name, method, compSize, uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const ab = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(ab);
  }

  /** 读取并解压单个条目 */
  async function readEntry(buf, entry) {
    const p = entry.localOffset;
    if (u32(buf, p) !== SIG_LOC) throw new Error('本地文件头签名不符：' + entry.name);
    const nameLen = u16(buf, p + 26);
    const extraLen = u16(buf, p + 28);
    const start = p + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + entry.compSize);
    let out;
    if (entry.method === 0) out = new Uint8Array(raw);
    else if (entry.method === 8) out = await inflateRaw(raw);
    else throw new Error('不支持的压缩方式（' + entry.method + '）：' + entry.name);
    if (out.length > MAX_ENTRY) throw new Error('条目解压后过大：' + entry.name);
    return out;
  }

  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /**
   * OOXML 片段转纯文本。
   * 同时兼容 WordprocessingML（w:）与 DrawingML（a:）的段落标记，
   * 因此 docx 与 pptx 共用同一套规则。
   */
  function xmlToText(xml) {
    let s = xml
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<a:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<[^>]*>/g, '');
    s = decodeEntities(s);
    const out = [];
    for (let line of s.split('\n')) {
      line = line.replace(/[ \t]+$/, '').replace(/^[ \t]+/, '');
      if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue; // 折叠连续空行
      out.push(line);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  }

  function limit(text, note) {
    if (text.length <= MAX_TEXT) return { text, truncated: false };
    return { text: text.slice(0, MAX_TEXT) + '\n\n…（内容过长，已截断）', truncated: true };
  }

  /** 提取 .docx 正文，返回 { text, truncated } */
  async function docxToText(bytes) {
    const buf = toU8(bytes);
    const entries = centralDirectory(buf);
    const doc = entries.find((e) => e.name === 'word/document.xml');
    if (!doc) throw new Error('未找到 word/document.xml，可能不是 .docx 文件');
    const xml = new TextDecoder('utf-8').decode(await readEntry(buf, doc));
    return limit(xmlToText(xml));
  }

  function slideNo(name) {
    const m = /slide(\d+)\.xml$/.exec(name);
    return m ? Number(m[1]) : 0;
  }

  /** 提取 .pptx 每页文字，返回 [{ slide, text }] */
  async function pptxSlides(bytes) {
    const buf = toU8(bytes);
    const entries = centralDirectory(buf);
    const slides = entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .sort((a, b) => slideNo(a.name) - slideNo(b.name));
    if (!slides.length) throw new Error('未找到幻灯片内容，可能不是 .pptx 文件');
    const out = [];
    let total = 0;
    for (const s of slides) {
      const xml = new TextDecoder('utf-8').decode(await readEntry(buf, s));
      const text = xmlToText(xml);
      total += text.length;
      out.push({ slide: slideNo(s.name), text });
      if (total > MAX_TEXT) break;
    }
    return out;
  }

  return {
    MAX_TEXT,
    centralDirectory,
    readEntry,
    xmlToText,
    docxToText,
    pptxSlides,
  };
});
