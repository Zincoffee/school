/**
 * app.js —— 前端共享逻辑（无框架、无构建）
 *
 * 安全约定：所有来自服务端或文档的文本一律经 esc() 转义后写入，
 * 只有 Markdown 与 docx 提取出的内容会生成 HTML，且 Markdown 渲染器
 * 先转义再套用规则、不支持内联 HTML，链接只放行 http/https。
 *
 * 与 ooxml.js 一样采用「浏览器挂全局 / Node 可 require」的写法，
 * 使转义与编码探测这类安全相关逻辑可以脱离浏览器直接做单元测试。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.App = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const UNKNOWN = '未注明';

  // ---------------------------------------------------------------- 基础

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 值 → 显示文本；空值统一显示为「未注明」，不显示为空白 */
  function known(v) {
    if (v == null) return { text: UNKNOWN, unknown: true };
    const s = String(v).trim();
    if (!s || s === UNKNOWN) return { text: UNKNOWN, unknown: true };
    return { text: s, unknown: false };
  }

  function val(v) {
    const k = known(v);
    return k.unknown
      ? '<span class="unknown">' + UNKNOWN + '</span>'
      : esc(k.text);
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON（如静态资源） */ }
    if (!res.ok) {
      const msg = (data && data.message) || ('请求失败（HTTP ' + res.status + '）');
      const err = new Error(msg);
      err.status = res.status;
      err.code = data && data.error;
      throw err;
    }
    return data;
  }

  /** 中文文本编码探测：UTF-8 严格模式失败则回退 GBK */
  function decodeText(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      try { return new TextDecoder('gbk').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
    }
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const STATUS_CLASS = {
    '报名中': 'open',
    '无需报名': 'free',
    '长期': 'long',
    '地点待定': 'pending',
    '报名已截止': 'closed',
    '已结束': 'closed',
  };

  function badge(status) {
    const cls = STATUS_CLASS[status] || 'closed';
    return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
  }

  // ---------------------------------------------------------------- Markdown

  /**
   * 极简 Markdown 渲染器。先整体转义，因此内联 HTML 不会生效（防 XSS）。
   * 支持：标题、粗体、斜体、行内代码、代码块、无序列表、引用、链接、表格分隔线忽略。
   */
  function markdown(src) {
    const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    // 1) 先摘出代码块，避免其内容被后续规则改写
    const blocks = [];
    let s = text.replace(/```([\s\S]*?)```/g, (_, code) => {
      blocks.push(code.replace(/^\n/, ''));
      return '\u0000CODE' + (blocks.length - 1) + '\u0000';
    });
    // 2) 转义
    s = esc(s);
    // 3) 行内规则
    s = s
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    // 4) 逐行组装块级结构
    const out = [];
    let list = false;
    const closeList = () => { if (list) { out.push('</ul>'); list = false; } };
    for (const rawLine of s.split('\n')) {
      const line = rawLine.trim();
      if (/^\u0000CODE\d+\u0000$/.test(line)) { closeList(); out.push('<pre>' + esc(blocks[Number(line.replace(/\D/g, ''))]) + '</pre>'); continue; }
      if (!line) { closeList(); continue; }
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) { closeList(); const n = h[1].length; out.push('<h' + n + '>' + h[2] + '</h' + n + '>'); continue; }
      if (/^&gt;\s?/.test(line)) { closeList(); out.push('<blockquote>' + line.replace(/^&gt;\s?/, '') + '</blockquote>'); continue; }
      if (/^[-*+]\s+/.test(line)) {
        if (!list) { out.push('<ul>'); list = true; }
        out.push('<li>' + line.replace(/^[-*+]\s+/, '') + '</li>');
        continue;
      }
      if (/^(?:-{3,}|\*{3,})$/.test(line)) { closeList(); out.push('<hr>'); continue; }
      closeList();
      out.push('<p>' + line + '</p>');
    }
    closeList();
    return out.join('\n');
  }

  // ---------------------------------------------------------------- 附件预览

  const KIND = {
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
    '.pdf': 'pdf', '.txt': 'text', '.md': 'markdown', '.docx': 'docx', '.pptx': 'pptx',
  };

  function kindOf(file) {
    return KIND[(file.ext || '').toLowerCase()] || 'other';
  }

  async function fetchBytes(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('读取失败（HTTP ' + res.status + '）');
    return new Uint8Array(await res.arrayBuffer());
  }

  function note(html) {
    return '<div class="preview-note">' + html + '</div>';
  }

  /** 在容器内渲染附件预览。返回提示信息（若有）。 */
  async function previewFile(file, box) {
    const kind = kindOf(file);
    const url = file.url;
    box.innerHTML = note('正在生成预览…');
    try {
      if (kind === 'image') {
        box.innerHTML = '<img src="' + esc(url) + '" alt="' + esc(file.name) + '">';
        return '';
      }
      if (kind === 'pdf') {
        // 使用 Edge 内置 PDF 阅读器，无需 PDF.js
        box.innerHTML = '<iframe src="' + esc(url) + '" title="' + esc(file.name) + '"></iframe>';
        return '';
      }
      if (kind === 'text') {
        const bytes = await fetchBytes(url);
        box.innerHTML = '<pre>' + esc(decodeText(bytes)) + '</pre>';
        return '';
      }
      if (kind === 'markdown') {
        const bytes = await fetchBytes(url);
        box.innerHTML = '<div class="md">' + markdown(decodeText(bytes)) + '</div>';
        return '';
      }
      if (kind === 'docx') {
        const bytes = await fetchBytes(url);
        const r = await globalThis.OOXML.docxToText(bytes);
        box.innerHTML = '<pre>' + esc(r.text) + '</pre>';
        return '已提取文档文字，版式（字体、颜色、表格边框）不会保留。';
      }
      if (kind === 'pptx') {
        const bytes = await fetchBytes(url);
        const slides = await globalThis.OOXML.pptxSlides(bytes);
        const html = slides.map((s) =>
          '<h3>第 ' + s.slide + ' 页</h3><pre>' + esc(s.text || '（本页无文字）') + '</pre>'
        ).join('');
        box.innerHTML = '<div class="slides">' + html + '</div>';
        return 'PPT 无法在浏览器中保留版式，以上为逐页文字提取。若需看原始版式，请下载文件或向组织者索取 PDF 版本。';
      }
      box.innerHTML = note('该格式暂不支持在线预览，请下载查看。');
      return '';
    } catch (e) {
      box.innerHTML = note('预览失败：' + esc(e.message) + '　<a href="' + esc(url) + '" download>下载文件</a>');
      return '';
    }
  }

  // ---------------------------------------------------------------- 字段渲染

  /** 详情页的字段行 */
  function fieldRow(label, valueHtml) {
    return '<dt>' + esc(label) + '</dt><dd>' + valueHtml + '</dd>';
  }

  const DETAIL_FIELDS = [
    ['要求', (f) => combine([f.requirement, f.threshold, f.commitment])],
    ['面向人群', (f) => val(f.audience)],
    ['地点', (f) => val(f.location)],
    ['时间', (f) => val(f.schedule)],
    ['报名截止', (f) => val(f.deadline)],
    ['报名方式', (f) => val(f.signup_mode)],
    ['名额', (f) => val(f.quota)],
    ['费用', (f) => val(f.cost)],
    ['收获', (f) => val(f.outcome)],
  ];

  function combine(parts) {
    const list = parts.map((p) => known(p)).filter((k) => !k.unknown).map((k) => esc(k.text));
    return list.length ? list.join('　·　') : '<span class="unknown">' + UNKNOWN + '</span>';
  }

  function renderFields(f) {
    return DETAIL_FIELDS.map(([label, get]) => fieldRow(label, get(f))).join('');
  }

  return {
    UNKNOWN, esc, known, val, api, decodeText, fmtSize, fmtWhen,
    badge, markdown, kindOf, previewFile, renderFields, fieldRow, combine, STATUS_CLASS,
  };
});
