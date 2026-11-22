// Разбор форматов книг. Все «текстовые» форматы превращаются в единый HTML,
// PDF открывается отдельно через pdf.js.

const XLINK = 'http://www.w3.org/1999/xlink';
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'dl', 'dt', 'dd', 'caption']);
const MAP_TO_DIV = new Set(['section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'center', 'address', 'body', 'hgroup', 'details', 'summary']);
const INLINE_TAGS = new Set(['a', 'em', 'i', 'strong', 'b', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'small', 'big', 'span', 'code', 'cite', 'q', 'abbr', 'mark', 'br', 'img', 'kbd', 'var', 'dfn', 'samp', 'time', 'ruby', 'rt', 'rp', 'wbr']);
const MAP_INLINE = { font: 'span', tt: 'code', acronym: 'abbr', label: 'span' };
const DROP = new Set(['script', 'style', 'link', 'meta', 'head', 'title', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'noscript', 'audio', 'video', 'canvas', 'template', 'math']);
export const LEAF_SELECTOR = 'p,div,h1,h2,h3,h4,h5,h6,li,blockquote,pre,dt,dd,figcaption,td,th,caption';

let JSZipP = null;
async function getJSZip() {
  if (window.JSZip) return window.JSZip;
  if (!JSZipP) JSZipP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('../lib/jszip.min.js', import.meta.url).href;
    s.onload = () => res(window.JSZip); s.onerror = () => rej(new Error('Не загрузилась библиотека ZIP'));
    document.head.appendChild(s);
  });
  return JSZipP;
}
let pdfjsP = null;
export async function getPdfjs() {
  if (!pdfjsP) pdfjsP = import('../lib/pdf.min.mjs').then(m => {
    m.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.mjs', import.meta.url).href;
    return m;
  });
  return pdfjsP;
}
let mammothP = null;
async function getMammoth() {
  if (window.mammoth) return window.mammoth;
  if (!mammothP) mammothP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('../lib/mammoth.browser.min.js', import.meta.url).href;
    s.onload = () => res(window.mammoth); s.onerror = () => rej(new Error('Не загрузилась библиотека DOCX'));
    document.head.appendChild(s);
  });
  return mammothP;
}

// ---------- Общие помощники ----------
function resolvePath(base, rel) {
  if (!rel) return base;
  try { rel = decodeURIComponent(rel); } catch (e) {}
  if (rel.startsWith('/')) return rel.slice(1);
  const parts = base.split('/'); parts.pop();
  for (const p of rel.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.' && p !== '') parts.push(p);
  }
  return parts.join('/');
}
function parseMarkup(text, preferXml = true) {
  const p = new DOMParser();
  if (preferXml) {
    const d = p.parseFromString(text, 'application/xhtml+xml');
    if (!d.querySelector('parsererror')) return d;
  }
  return p.parseFromString(text, 'text/html');
}
function decodeText(buf) {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder('ascii').decode(bytes.slice(0, 300));
  const m = head.match(/encoding=["']([\w-]+)["']/i);
  if (m) { try { return new TextDecoder(m[1].toLowerCase()).decode(bytes); } catch (e) {} }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (e) { return new TextDecoder('windows-1251').decode(bytes); }
}
const hasText = n => /\S/.test(n.textContent || '');
const safeId = s => String(s).replace(/[^\w\-.:]/g, '_');

// Санитизация: строим чистый HTML из исходного документа книги
// ctx: { c, resolveImg(src) -> url|null, resolveHref(href) -> {c, id}|{ext:url}|null }
export function sanitize(root, ctx) {
  const out = document.createElement('div');
  out.className = 'ch-body';
  for (const ch of [...root.childNodes]) { const n = conv(ch, ctx); if (n) out.appendChild(n); }
  wrapStray(out);
  return out;
}
function conv(node, ctx) {
  if (node.nodeType === 3) return document.createTextNode(node.nodeValue);
  if (node.nodeType !== 1) return null;
  let tag = (node.localName || node.nodeName).toLowerCase();
  if (DROP.has(tag)) return null;
  if (tag === 'svg') {
    const im = node.querySelector('image');
    if (!im) return null;
    const src = ctx.resolveImg(im.getAttributeNS(XLINK, 'href') || im.getAttribute('href') || im.getAttribute('xlink:href'));
    if (!src) return null;
    const img = document.createElement('img'); img.src = src; img.alt = '';
    return img;
  }
  let outTag;
  if (BLOCK_TAGS.has(tag)) outTag = tag;
  else if (MAP_TO_DIV.has(tag)) outTag = 'div';
  else if (INLINE_TAGS.has(tag)) outTag = tag;
  else if (MAP_INLINE[tag]) outTag = MAP_INLINE[tag];
  else outTag = node.querySelector && [...node.querySelectorAll('*')].some(e => BLOCK_TAGS.has(e.localName) || MAP_TO_DIV.has(e.localName)) ? 'div' : 'span';

  if (outTag === 'img') {
    const src = ctx.resolveImg(node.getAttribute('src') || node.getAttributeNS(XLINK, 'href'));
    if (!src) return null;
    const img = document.createElement('img'); img.src = src; img.alt = node.getAttribute('alt') || ''; img.loading = 'lazy';
    return img;
  }
  const el = document.createElement(outTag);
  const id = node.getAttribute('id') || node.getAttribute('name');
  if (id) el.id = `a${ctx.c}-${safeId(id)}`;
  const style = (node.getAttribute('style') || '') + ' ' + (node.getAttribute('class') || '') + ' ' + (node.getAttribute('align') || '');
  if (/text-align:\s*center|\bcenter\b|centr/i.test(style)) el.classList.add('ac');
  else if (/text-align:\s*right|\bright\b/i.test(style)) el.classList.add('ar');
  if (outTag === 'td' || outTag === 'th') {
    for (const a of ['colspan', 'rowspan']) if (node.getAttribute(a)) el.setAttribute(a, node.getAttribute(a));
  }
  if (outTag === 'a') {
    const href = node.getAttribute('href') || node.getAttributeNS(XLINK, 'href');
    if (href) {
      const r = ctx.resolveHref(href);
      if (r && r.ext) { el.href = r.ext; el.target = '_blank'; el.rel = 'noopener'; }
      else if (r) { el.href = '#'; el.dataset.gc = r.c; if (r.id) el.dataset.gid = r.id; el.className = 'ilink'; }
    }
  }
  for (const ch of [...node.childNodes]) { const n = conv(ch, ctx); if (n) el.appendChild(n); }
  if (outTag === 'span' && !el.attributes.length) {
    const f = document.createDocumentFragment();
    while (el.firstChild) f.appendChild(el.firstChild);
    return f;
  }
  return el;
}
const isBlockEl = n => n.nodeType === 1 && (BLOCK_TAGS.has(n.localName));
// Текст, оказавшийся вне абзацев рядом с блоками, оборачиваем в абзац — так у каждого куска текста есть «свой» блок.
function wrapStray(el) {
  for (const ch of [...el.children]) wrapStray(ch);
  const kids = [...el.childNodes];
  if (!kids.some(isBlockEl) || ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre'].includes(el.localName)) return;
  let run = [];
  const flush = () => {
    if (run.length && run.some(n => (n.nodeType === 3 && /\S/.test(n.nodeValue)) || (n.nodeType === 1 && (hasText(n) || n.querySelector?.('img') || n.localName === 'img')))) {
      const p = document.createElement('p'); p.className = 'w';
      run[0].parentNode.insertBefore(p, run[0]);
      for (const n of run) p.appendChild(n);
    } else for (const n of run) if (n.nodeType === 3) n.remove();
    run = [];
  };
  for (const n of kids) { if (isBlockEl(n)) flush(); else run.push(n); }
  flush();
}

export async function resizeImage(blob, maxW = 320) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxW / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
  } catch (e) {
    return await new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.naturalWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale) || 1; c.height = Math.round(img.naturalHeight * scale) || 1;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(resolve, 'image/jpeg', 0.82);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
}
const mimeOf = p => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' })[p.split('.').pop().toLowerCase()] || 'application/octet-stream';

// ======================= EPUB =======================
async function epubPackage(blob) {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(blob);
  const findFile = (path) => zip.file(path) || zip.file(Object.keys(zip.files).find(k => k.toLowerCase() === path.toLowerCase()) || '\0');
  const container = await zip.file('META-INF/container.xml').async('string');
  const opfPath = new DOMParser().parseFromString(container, 'application/xml').querySelector('rootfile').getAttribute('full-path');
  const opf = new DOMParser().parseFromString(await findFile(opfPath).async('string'), 'application/xml');
  const manifest = {};
  for (const it of opf.querySelectorAll('manifest > item')) {
    manifest[it.getAttribute('id')] = { href: resolvePath(opfPath, it.getAttribute('href')), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' };
  }
  const meta = (name) => opf.getElementsByTagNameNS('*', name)[0]?.textContent?.trim() || '';
  let coverItem = Object.values(manifest).find(m => m.props.includes('cover-image'));
  if (!coverItem) {
    const cid = [...opf.querySelectorAll('metadata > meta, meta')].find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
    if (cid && manifest[cid]) coverItem = manifest[cid];
  }
  if (!coverItem) coverItem = Object.entries(manifest).find(([id, m]) => /cover/i.test(id + m.href) && m.type.startsWith('image/'))?.[1];
  return { zip, findFile, opf, opfPath, manifest, title: meta('title'), author: meta('creator'), coverItem };
}

async function openEpub(blob) {
  const pkg = await epubPackage(blob);
  const { opf, manifest, findFile } = pkg;
  const spine = [...opf.querySelectorAll('spine > itemref')].map(r => manifest[r.getAttribute('idref')]).filter(Boolean)
    .filter(m => /html|xml/.test(m.type) || /\.x?html?$/i.test(m.href));
  const pathIndex = {};
  spine.forEach((m, i) => { pathIndex[m.href.toLowerCase()] = i; });
  const imgCache = {};
  const urls = [];
  const loadImg = async (path) => {
    if (path in imgCache) return imgCache[path];
    const f = findFile(path);
    if (!f) return imgCache[path] = null;
    const url = URL.createObjectURL(new Blob([await f.async('uint8array')], { type: mimeOf(path) }));
    urls.push(url);
    return imgCache[path] = url;
  };
  const chapters = [];
  for (let i = 0; i < spine.length; i++) {
    const f = findFile(spine[i].href);
    if (!f) { chapters.push(document.createElement('div')); continue; }
    const doc = parseMarkup(await f.async('string'));
    const body = doc.body || doc.querySelector('body') || doc.documentElement;
    // заранее подгружаем картинки главы
    const srcs = [...body.querySelectorAll('img')].map(e => e.getAttribute('src'))
      .concat([...body.querySelectorAll('image')].map(e => e.getAttributeNS(XLINK, 'href') || e.getAttribute('href')));
    const map = {};
    for (const s of srcs) if (s) { const p = resolvePath(spine[i].href, s.split('#')[0]); map[s] = await loadImg(p); }
    chapters.push(sanitize(body, {
      c: i,
      resolveImg: s => s ? map[s] || null : null,
      resolveHref: (href) => {
        if (/^[a-z]+:/i.test(href)) return /^https?:|^mailto:/i.test(href) ? { ext: href } : null;
        const [p, id] = href.split('#');
        const target = p ? resolvePath(spine[i].href, p).toLowerCase() : spine[i].href.toLowerCase();
        const c = pathIndex[target];
        if (c == null) return null;
        return { c, id: id ? `a${c}-${safeId(decodeURIComponent(id))}` : null };
      },
    }));
  }
  // Оглавление
  let toc = [];
  const navItem = Object.values(manifest).find(m => m.props.includes('nav'));
  const tocLink = (base, href) => {
    const [p, id] = (href || '').split('#');
    const c = pathIndex[resolvePath(base, p).toLowerCase()];
    return c == null ? null : { c, id: id ? `a${c}-${safeId(decodeURIComponent(id))}` : null };
  };
  if (navItem && findFile(navItem.href)) {
    const nav = parseMarkup(await findFile(navItem.href).async('string'));
    const tocNav = [...nav.querySelectorAll('nav')].find(n => (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '').includes('toc')) || nav.querySelector('nav');
    if (tocNav) for (const a of tocNav.querySelectorAll('a')) {
      const t = tocLink(navItem.href, a.getAttribute('href'));
      let level = 0, p = a.parentElement;
      while (p && p !== tocNav) { if (p.localName === 'ol' || p.localName === 'ul') level++; p = p.parentElement; }
      if (t) toc.push({ label: a.textContent.trim().replace(/\s+/g, ' '), level: Math.max(0, level - 1), ...t });
    }
  }
  if (!toc.length) {
    const ncx = Object.values(manifest).find(m => m.type === 'application/x-dtbncx+xml');
    if (ncx && findFile(ncx.href)) {
      const x = new DOMParser().parseFromString(await findFile(ncx.href).async('string'), 'application/xml');
      for (const np of x.querySelectorAll('navPoint')) {
        let level = 0, p = np.parentElement;
        while (p && p.localName === 'navPoint') { level++; p = p.parentElement; }
        const t = tocLink(ncx.href, np.querySelector('content')?.getAttribute('src'));
        if (t) toc.push({ label: np.querySelector('navLabel')?.textContent.trim().replace(/\s+/g, ' ') || '—', level, ...t });
      }
    }
  }
  return { kind: 'flow', title: pkg.title, author: pkg.author, chapters, toc, dispose: () => urls.forEach(u => URL.revokeObjectURL(u)) };
}
async function infoEpub(blob) {
  const pkg = await epubPackage(blob);
  let cover = null;
  if (pkg.coverItem) {
    const f = pkg.findFile(pkg.coverItem.href);
    if (f) cover = new Blob([await f.async('uint8array')], { type: mimeOf(pkg.coverItem.href) });
  }
  return { title: pkg.title, author: pkg.author, cover };
}

// ======================= FB2 =======================
async function fb2Doc(blob, zipped) {
  let buf;
  if (zipped) {
    const JSZip = await getJSZip();
    const zip = await JSZip.loadAsync(blob);
    const name = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.fb2')) || Object.keys(zip.files)[0];
    buf = await zip.file(name).async('arraybuffer');
  } else buf = await blob.arrayBuffer();
  const text = decodeText(buf);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) {
    // некоторые FB2 содержат ошибки разметки — пробуем как HTML
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}
function fb2Meta(doc) {
  const ti = doc.querySelector('description title-info') || doc.querySelector('title-info');
  const title = ti?.querySelector('book-title')?.textContent.trim() || '';
  const a = ti?.querySelector('author');
  const author = a ? [a.querySelector('first-name')?.textContent, a.querySelector('last-name')?.textContent].filter(Boolean).join(' ').trim() : '';
  return { title, author, ti };
}
function fb2Binary(doc, href, urls) {
  if (!href) return null;
  const id = href.replace(/^#/, '');
  const bin = [...doc.querySelectorAll('binary')].find(b => b.getAttribute('id') === id);
  if (!bin) return null;
  try {
    const raw = atob(bin.textContent.replace(/\s+/g, ''));
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    const b = new Blob([arr], { type: bin.getAttribute('content-type') || 'image/jpeg' });
    if (!urls) return b;
    const u = URL.createObjectURL(b); urls.push(u); return u;
  } catch (e) { return null; }
}
const fbHref = el => el.getAttributeNS(XLINK, 'href') || el.getAttribute('l:href') || el.getAttribute('xlink:href') || el.getAttribute('href');

async function openFb2(blob, zipped) {
  const doc = await fb2Doc(blob, zipped);
  const { title, author } = fb2Meta(doc);
  const urls = [];
  const imgCache = {};
  const img = (href) => href in imgCache ? imgCache[href] : (imgCache[href] = fb2Binary(doc, href, urls));
  const idMap = {};
  const pendingLinks = [];
  const toc = [];

  function conv(node, c, depth) {
    if (node.nodeType === 3) return document.createTextNode(node.nodeValue);
    if (node.nodeType !== 1) return null;
    const tag = node.localName.toLowerCase();
    let el;
    const kids = (e, d = depth) => { for (const ch of [...node.childNodes]) { const n = conv(ch, c, d); if (n) e.appendChild(n); } return e; };
    switch (tag) {
      case 'section': el = kids(document.createElement('div'), depth + 1); el.className = 'sec'; break;
      case 'title': {
        el = document.createElement('h' + Math.min(6, depth + 1)); el.className = 'fb-title';
        const ps = [...node.children].filter(x => x.localName === 'p');
        if (ps.length) ps.forEach((p, i) => { if (i) el.appendChild(document.createElement('br')); for (const ch of [...p.childNodes]) { const n = conv(ch, c, depth); if (n) el.appendChild(n); } });
        else kids(el);
        if (depth <= 2) { el.id = `a${c}-t${toc.length}`; toc.push({ label: node.textContent.trim().replace(/\s+/g, ' '), level: Math.max(0, depth - 1), c, id: el.id }); }
        break;
      }
      case 'subtitle': el = kids(document.createElement('h5')); break;
      case 'p': el = kids(document.createElement('p')); break;
      case 'empty-line': el = document.createElement('p'); el.className = 'empty'; el.innerHTML = '&nbsp;'; break;
      case 'epigraph': el = kids(document.createElement('blockquote')); el.className = 'epi'; break;
      case 'cite': el = kids(document.createElement('blockquote')); break;
      case 'annotation': el = kids(document.createElement('blockquote')); el.className = 'epi'; break;
      case 'poem': el = kids(document.createElement('div')); el.className = 'poem'; break;
      case 'stanza': el = kids(document.createElement('div')); el.className = 'stanza'; break;
      case 'v': el = kids(document.createElement('p')); el.className = 'v'; break;
      case 'text-author': el = kids(document.createElement('p')); el.className = 'author'; break;
      case 'emphasis': el = kids(document.createElement('em')); break;
      case 'strong': el = kids(document.createElement('strong')); break;
      case 'strikethrough': el = kids(document.createElement('s')); break;
      case 'sub': case 'sup': case 'code': el = kids(document.createElement(tag)); break;
      case 'style': el = kids(document.createElement('span')); break;
      case 'table': case 'tr': case 'td': case 'th': el = kids(document.createElement(tag)); break;
      case 'image': {
        const u = img(fbHref(node));
        if (!u) return null;
        const im = document.createElement('img'); im.src = u; im.alt = '';
        const parent = node.parentNode?.localName;
        if (parent === 'section' || parent === 'body') { el = document.createElement('p'); el.className = 'ac img'; el.appendChild(im); }
        else el = im;
        break;
      }
      case 'a': {
        el = kids(document.createElement('a'));
        const href = fbHref(node) || '';
        if (href.startsWith('#')) { el.href = '#'; el.className = 'ilink' + (node.getAttribute('type') === 'note' ? ' note' : ''); pendingLinks.push([el, href.slice(1)]); }
        else if (/^https?:/i.test(href)) { el.href = href; el.target = '_blank'; el.rel = 'noopener'; }
        break;
      }
      default: el = kids(document.createElement('span'));
    }
    const id = node.getAttribute && node.getAttribute('id');
    if (id && el.nodeType === 1) { el.id = `a${c}-${safeId(id)}`; idMap[id] = { c, id: el.id }; }
    return el;
  }

  const bodies = [...doc.querySelectorAll('body')];
  const main = bodies.find(b => !b.getAttribute('name')) || bodies[0];
  const chapters = [];
  const makeChapter = (nodes, depth = 1) => {
    const c = chapters.length;
    const wrap = document.createElement('div'); wrap.className = 'ch-body';
    for (const n of nodes) { const e = conv(n, c, depth); if (e) wrap.appendChild(e); }
    wrapStray(wrap);
    chapters.push(wrap);
  };
  if (main) {
    const kids = [...main.children];
    const sections = kids.filter(k => k.localName === 'section');
    const pre = kids.filter(k => k.localName !== 'section');
    if (sections.length > 1) {
      if (pre.some(hasText) || pre.some(k => k.localName === 'image')) makeChapter(pre, 0);
      for (const s of sections) makeChapter([s], 0);
    } else makeChapter(kids, 0);
  }
  for (const b of bodies) if (b !== main) {
    const c = chapters.length;
    makeChapter([...b.children], 0);
    toc.push({ label: b.getAttribute('name') === 'notes' ? 'Примечания' : (b.getAttribute('name') || 'Приложение'), level: 0, c, id: null });
  }
  for (const [el, id] of pendingLinks) {
    const t = idMap[id];
    if (t) { el.dataset.gc = t.c; el.dataset.gid = t.id; }
  }
  toc.sort((a, b) => a.c - b.c);
  return { kind: 'flow', title, author, chapters, toc, dispose: () => urls.forEach(u => URL.revokeObjectURL(u)) };
}
async function infoFb2(blob, zipped) {
  const doc = await fb2Doc(blob, zipped);
  const { title, author, ti } = fb2Meta(doc);
  const im = ti?.querySelector('coverpage image');
  const cover = im ? fb2Binary(doc, fbHref(im)) : null;
  return { title, author, cover };
}

// ======================= TXT =======================
async function openTxt(blob) {
  const text = decodeText(await blob.arrayBuffer()).replace(/\r\n?/g, '\n');
  const paras = /\n[ \t]*\n/.test(text) ? text.split(/\n[ \t]*\n+/).map(p => p.replace(/\n/g, ' ')) : text.split('\n');
  const heading = /^\s*(глава|часть|chapter|part|rozdział|część|пролог|эпилог|prologue|epilogue)(?=[\s.:]|$).{0,60}$/iu;
  const chapters = [];
  const toc = [];
  let cur = null, count = 0;
  const start = () => { cur = document.createElement('div'); cur.className = 'ch-body'; chapters.push(cur); count = 0; };
  start();
  for (const raw of paras) {
    const p = raw.trim();
    if (!p) continue;
    const isH = heading.test(p) && p.length < 80;
    if ((isH && count > 0) || count >= 200) start();
    const el = document.createElement(isH ? 'h2' : 'p');
    el.textContent = p;
    if (isH) toc.push({ label: p, level: 0, c: chapters.length - 1, id: null });
    cur.appendChild(el); count++;
  }
  return { kind: 'flow', title: '', author: '', chapters, toc, dispose: () => {} };
}

// ======================= DOCX =======================
async function openDocx(blob) {
  const mammoth = await getMammoth();
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
  const doc = new DOMParser().parseFromString(`<body>${value}</body>`, 'text/html');
  const nodes = [...doc.body.childNodes];
  const groups = [[]];
  const toc = [];
  for (const n of nodes) {
    if (n.nodeType === 1 && n.localName === 'h1' && groups[groups.length - 1].length) groups.push([]);
    groups[groups.length - 1].push(n);
  }
  const chapters = groups.map((g, c) => {
    const holder = doc.createElement('div'); g.forEach(n => holder.appendChild(n));
    for (const h of holder.querySelectorAll('h1,h2')) toc.push({ label: h.textContent.trim(), level: h.localName === 'h1' ? 0 : 1, c, id: null });
    return sanitize(holder, { c, resolveImg: s => s || null, resolveHref: h => /^https?:/i.test(h) ? { ext: h } : null });
  });
  return { kind: 'flow', title: '', author: '', chapters, toc, dispose: () => {} };
}

// ======================= MOBI / AZW3 =======================
async function mobiBook(blob) {
  const [{ MOBI }, fflate] = await Promise.all([import('../lib/mobi.js'), import('../lib/fflate.js')]);
  return await new MOBI({ unzlib: fflate.unzlibSync }).open(blob);
}
async function openMobi(blob) {
  const book = await mobiBook(blob);
  const secs = book.sections.map((s, i) => ({ s, i })).filter(x => x.s.load && x.s.linear !== 'no');
  const indexMap = {};
  secs.forEach((x, c) => { indexMap[x.i] = c; });
  const hrefCache = new Map();
  const resolveAsync = async (href) => {
    if (hrefCache.has(href)) return hrefCache.get(href);
    let out = null;
    try {
      const r = await book.resolveHref(href);
      const c = r && indexMap[r.index];
      if (c != null) { const m = String(href).match(/filepos:0*(\d+)/); out = { c, id: m ? `a${c}-filepos${m[1]}` : null }; }
    } catch (e) {}
    hrefCache.set(href, out);
    return out;
  };
  const chapters = [];
  for (let c = 0; c < secs.length; c++) {
    let r = await secs[c].s.load();
    let doc;
    if (typeof r === 'string') doc = parseMarkup(await (await fetch(r)).text());
    else if (r && r.nodeType === 9) doc = r;
    else doc = await secs[c].s.createDocument();
    const body = doc.body || doc.querySelector('body') || doc.documentElement;
    for (const a of body.querySelectorAll('a[href]')) { const hr = a.getAttribute('href'); if (!/^https?:/i.test(hr)) await resolveAsync(hr); }
    chapters.push(sanitize(body, {
      c,
      resolveImg: s => s && /^(blob:|data:)/.test(s) ? s : null,
      resolveHref: h => /^https?:/i.test(h) ? { ext: h } : (hrefCache.get(h) || null),
    }));
  }
  const toc = [];
  const walk = async (items, level) => { for (const it of items || []) { const t = await resolveAsync(it.href); if (t) toc.push({ label: it.label, level, ...t }); await walk(it.subitems, level + 1); } };
  await walk(book.toc, 0);
  const m = book.metadata || {};
  return { kind: 'flow', title: m.title || '', author: [].concat(m.author || []).join(', '), chapters, toc, dispose: () => {} };
}
async function infoMobi(blob) {
  const book = await mobiBook(blob);
  const m = book.metadata || {};
  let cover = null;
  try { cover = await book.getCover(); } catch (e) {}
  return { title: m.title || '', author: [].concat(m.author || []).join(', '), cover };
}

// ======================= CBZ (комиксы) =======================
async function cbzImages(blob) {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(blob);
  const names = Object.keys(zip.files).filter(n => /\.(jpe?g|png|gif|webp)$/i.test(n) && !n.startsWith('__MACOSX'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { zip, names };
}
async function openCbz(blob) {
  const { zip, names } = await cbzImages(blob);
  const urls = [];
  const chapters = [];
  for (const n of names) {
    const u = URL.createObjectURL(new Blob([await zip.file(n).async('uint8array')], { type: mimeOf(n) }));
    urls.push(u);
    const d = document.createElement('div'); d.className = 'ch-body comic';
    const p = document.createElement('p'); p.className = 'img ac';
    const im = document.createElement('img'); im.src = u; im.alt = ''; im.loading = 'lazy';
    p.appendChild(im); d.appendChild(p); chapters.push(d);
  }
  return { kind: 'flow', comic: true, title: '', author: '', chapters, toc: [], dispose: () => urls.forEach(u => URL.revokeObjectURL(u)) };
}

// ======================= PDF =======================
async function openPdf(blob) {
  const pdfjs = await getPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
  let title = '', author = '';
  try { const md = await pdf.getMetadata(); title = md.info?.Title || ''; author = md.info?.Author || ''; } catch (e) {}
  const toc = [];
  try {
    const outline = await pdf.getOutline();
    const walk = async (items, level) => {
      for (const it of items || []) {
        let page = null;
        try {
          const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest;
          if (dest && dest[0]) page = await pdf.getPageIndex(dest[0]);
        } catch (e) {}
        if (page != null) toc.push({ label: it.title, level, page });
        await walk(it.items, level + 1);
      }
    };
    await walk(outline, 0);
  } catch (e) {}
  return { kind: 'pdf', pdf, title, author, toc, dispose: () => pdf.destroy() };
}
async function infoPdf(blob) {
  const pdfjs = await getPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
  let title = '', author = '';
  try { const md = await pdf.getMetadata(); title = md.info?.Title || ''; author = md.info?.Author || ''; } catch (e) {}
  const page = await pdf.getPage(1);
  const vp0 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 320 / vp0.width });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const cover = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
  pdf.destroy();
  return { title, author, cover };
}

// ======================= Точки входа =======================
export async function openBook(blob, format) {
  switch (format) {
    case 'epub': return openEpub(blob);
    case 'fb2': return openFb2(blob, false);
    case 'fb2.zip': return openFb2(blob, true);
    case 'txt': return openTxt(blob);
    case 'docx': return openDocx(blob);
    case 'mobi': case 'azw3': case 'azw': case 'prc': return openMobi(blob);
    case 'cbz': return openCbz(blob);
    case 'pdf': return openPdf(blob);
    case 'djvu': throw new Error('Формат DjVu пока не поддерживается. Его можно сконвертировать в PDF (например, на djvu2pdf.com) и положить на Диск.');
    default: throw new Error('Неизвестный формат');
  }
}
// Метаданные и обложка (для превью в библиотеке)
export async function bookInfo(blob, format) {
  let info = { title: '', author: '', cover: null };
  try {
    switch (format) {
      case 'epub': info = await infoEpub(blob); break;
      case 'fb2': info = await infoFb2(blob, false); break;
      case 'fb2.zip': info = await infoFb2(blob, true); break;
      case 'pdf': info = await infoPdf(blob); break;
      case 'mobi': case 'azw3': case 'azw': case 'prc': info = await infoMobi(blob); break;
      case 'cbz': { const { zip, names } = await cbzImages(blob); if (names[0]) info.cover = new Blob([await zip.file(names[0]).async('uint8array')], { type: mimeOf(names[0]) }); break; }
    }
  } catch (e) { console.warn('cover', e); }
  if (info.cover) info.cover = await resizeImage(info.cover);
  return info;
}
