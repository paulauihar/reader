// Режим чтения: отрисовка книги, позиция, маркер, перо, комментарии, оглавление, настройки.
import { state, setSetting, setProgress, addAnnotation, updateAnnotation, deleteAnnotation, annotationsOf, subscribe } from './store.js';
import { LEAF_SELECTOR, getPdfjs } from './formats.js';
import { esc, $, $$, h, sheet, toast, tagEditor, confirmSheet, HL_COLORS, PEN_COLORS, excerpt, fmtDate } from './ui.js';

const THEMES = { light: 'Белый', sepia: 'Сепия', gray: 'Серый', dark: 'Тёмный' };
const SVGNS = 'http://www.w3.org/2000/svg';

export class Reader {
  // mode: 'full' — все инструменты; 'read' — только чтение; 'owner' — только просмотр чужих заметок (ownerAnns)
  constructor(host, book, meta, { onBack, mode = 'full', ownerAnns = null }) {
    this.host = host; this.book = book; this.meta = meta; this.onBack = onBack;
    this.mode = mode; this.ownerAnns = ownerAnns;
    this.canAnnotate = mode === 'full';
    this.bookId = meta.id;
    this.tool = null;          // null | 'marker' | 'pen' | 'comment'
    this.eraser = false;
    this.blocks = []; this.blockIndex = new Map();
    this.inkStack = [];
    this.backStack = [];
    this.pdfPages = [];
    this.destroyed = false;
    this.unsub = subscribe((what) => { if (what === 'remote') this.refreshAnnotations(); });
  }

  // ---------------- Каркас ----------------
  async mount() {
    const s = state.settings;
    this.host.innerHTML = `
      <div class="reader theme-${s.theme} ${this.book.kind === 'pdf' ? 'is-pdf' : 'is-flow'} ${this.canAnnotate ? '' : 'no-tools'}" style="--fs:${s.fontSize}px">
        <div class="r-scroll"><div class="r-content"></div></div>
        <div class="r-ink-overlay"><svg class="live-ink"></svg></div>
        <div class="r-dim" style="opacity:${(100 - s.brightness) / 100 * 0.75}"></div>
        <header class="r-top">
          <button class="icon-btn" data-act="back" aria-label="Назад">${ico('back')}</button>
          <div class="r-title"><div class="t">${esc(this.meta.title)}</div><div class="a">${esc(this.meta.author || '')}</div></div>
          ${this.mode === 'owner' ? '<span class="owner-badge">Заметки автора</span>' : ''}
          <button class="icon-btn" data-act="toc" aria-label="Оглавление">${ico('toc')}</button>
          <button class="icon-btn" data-act="panel" aria-label="Заметки и комментарии">${ico(this.mode === 'read' ? 'list' : 'notes')}</button>
          <button class="icon-btn" data-act="display" aria-label="Фон, яркость, шрифт">${ico('aa')}</button>
        </header>
        <div class="r-selbar">
          ${Object.keys(HL_COLORS).map(c => `<button class="dot hl-${c}" data-hl="${c}" aria-label="Выделить: ${HL_COLORS[c].name}"></button>`).join('')}
          <span class="sep"></span>
          <button class="pill" data-act="sel-comment">${ico('comment')}<span>Комментарий</span></button>
        </div>
        <button class="r-backpill">← Вернуться</button>
        <footer class="r-bottom">
          <div class="r-opts"></div>
          <div class="r-tools">
            <button class="tool" data-tool="marker">${ico('marker')}<span>Маркер</span></button>
            <button class="tool" data-tool="pen">${ico('pen')}<span>Перо</span></button>
            <button class="tool" data-tool="comment">${ico('comment')}<span>Комментарий</span></button>
          </div>
          <div class="r-progress"><div class="bar"><i></i></div><span class="pct">0%</span></div>
        </footer>
      </div>`;
    this.root = $('.reader', this.host);
    this.scroll = $('.r-scroll', this.root);
    this.content = $('.r-content', this.root);
    this.overlay = $('.r-ink-overlay', this.root);
    this.bindChrome();
    if (this.book.kind === 'pdf') await this.renderPdf(); else this.renderFlow();
    this.refreshAnnotations();
    const p = state.progress[this.bookId];
    if (p && p.pos) await this.goTo(p.pos, { instant: true }); else this.scroll.scrollTop = 0;
    this.updateProgress();
    this.showChrome(true);
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => { if (!this.tool) this.showChrome(false); }, 2500);
  }

  destroy() {
    this.destroyed = true;
    this.savePosition();
    this.unsub && this.unsub();
    document.removeEventListener('selectionchange', this._onSel);
    window.removeEventListener('resize', this._onResize);
    this.io && this.io.disconnect();
    try { this.book.dispose && this.book.dispose(); } catch (e) {}
    this.host.innerHTML = '';
  }

  // ---------------- Отрисовка текстовой книги ----------------
  renderFlow() {
    const frag = document.createDocumentFragment();
    this.book.chapters.forEach((body, c) => {
      const sec = document.createElement('section');
      sec.className = 'chap' + (this.book.comic ? ' comic' : '');
      sec.dataset.c = c;
      sec.appendChild(body);
      frag.appendChild(sec);
    });
    this.content.appendChild(frag);
    // назначаем идентификаторы «листовым» блокам — к ним привязываются выделения и рисунки
    for (const sec of $$('section.chap', this.content)) {
      const cands = [...sec.querySelectorAll(LEAF_SELECTOR)];
      const nonLeaf = new Set();
      for (const el of cands) {
        let p = el.parentElement;
        while (p && p !== sec && !nonLeaf.has(p)) { nonLeaf.add(p); p = p.parentElement; }
      }
      let k = 0;
      const c = sec.dataset.c;
      for (const el of cands) if (!nonLeaf.has(el)) { el.dataset.b = `${c}.${k++}`; }
    }
    this.blocks = $$('[data-b]', this.content);
    this.blocks.forEach((b, i) => this.blockIndex.set(b.dataset.b, i));
  }
  textRoot(block) { return this.book.kind === 'pdf' ? block.querySelector('.textLayer') : block; }

  // ---------------- Отрисовка PDF ----------------
  async renderPdf() {
    const pdf = this.book.pdf;
    const p1 = await pdf.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    this.pdfBase = { w: vp.width, h: vp.height };
    for (let i = 0; i < pdf.numPages; i++) {
      const d = document.createElement('div');
      d.className = 'pdf-page'; d.dataset.b = 'p' + i; d.dataset.page = i;
      d.innerHTML = `<div class="pnum">${i + 1}</div>`;
      this.content.appendChild(d);
      this.pdfPages.push({ el: d, w: null, h: null, rendered: false, task: null });
    }
    this.blocks = $$('[data-b]', this.content);
    this.blocks.forEach((b, i) => this.blockIndex.set(b.dataset.b, i));
    this.layoutPdf();
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = +e.target.dataset.page;
        if (e.isIntersecting) this.renderPage(i); else this.unrenderPage(i);
      }
    }, { root: this.scroll, rootMargin: '1200px 0px' });
    this.pdfPages.forEach(p => this.io.observe(p.el));
  }
  pdfWidth() {
    const avail = Math.min(this.scroll.clientWidth - 16, 1000);
    return Math.round(avail * (state.settings.pdfZoom || 1));
  }
  layoutPdf() {
    const W = this.pdfWidth();
    this.content.style.width = (W + 16) + 'px';
    for (const p of this.pdfPages) {
      const w = p.w || this.pdfBase.w, hh = p.h || this.pdfBase.h;
      const scale = W / w;
      p.scale = scale;
      p.el.style.width = W + 'px';
      p.el.style.height = Math.round(hh * scale) + 'px';
      p.el.style.setProperty('--scale-factor', scale);
    }
  }
  async renderPage(i) {
    const p = this.pdfPages[i];
    if (p.rendered || p.task) return;
    const run = (async () => {
      const pdfjs = await getPdfjs();
      const page = await this.book.pdf.getPage(i + 1);
      if (this.destroyed) return;
      const vp1 = page.getViewport({ scale: 1 });
      if (!p.w) {
        p.w = vp1.width; p.h = vp1.height;
        if (Math.abs(p.w / p.h - this.pdfBase.w / this.pdfBase.h) > 0.01) {
          // размер страницы отличается от первой — уточняем, сохраняя позицию
          const pos = this.currentPos();
          this.layoutPdf();
          if (i < (this.firstVisibleIndex() || 0)) this.goTo(pos, { instant: true, silent: true });
        }
      }
      const scale = p.scale;
      const vp = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const maxPx = 5e6;
      const k = Math.min(dpr, Math.sqrt(maxPx / (vp.width * vp.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * k); canvas.height = Math.floor(vp.height * k);
      canvas.className = 'pdf-canvas';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: k !== 1 ? [k, 0, 0, k, 0, 0] : null }).promise;
      if (this.destroyed || !p.task) return;
      const tl = document.createElement('div');
      tl.className = 'textLayer';
      const textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
      await textLayer.render();
      if (this.destroyed || !p.task) return;
      p.el.querySelectorAll('.pdf-canvas,.textLayer').forEach(n => n.remove());
      p.el.prepend(canvas);
      const ink = p.el.querySelector('svg.ink');
      if (ink) p.el.insertBefore(tl, ink); else p.el.appendChild(tl);
      p.rendered = true;
      this.applyMarksInBlock(p.el);
    })().catch(e => console.warn('pdf page', i, e)).finally(() => { p.task = null; });
    p.task = run;
  }
  unrenderPage(i) {
    const p = this.pdfPages[i];
    if (p.task) p.task = null;
    if (!p.rendered) return;
    p.el.querySelectorAll('.pdf-canvas,.textLayer').forEach(n => n.remove());
    p.rendered = false;
  }
  rerenderPdf() {
    const pos = this.currentPos();
    for (let i = 0; i < this.pdfPages.length; i++) this.unrenderPage(i);
    this.layoutPdf();
    this.goTo(pos, { instant: true, silent: true });
    this.io.disconnect();
    this.pdfPages.forEach(p => this.io.observe(p.el));
    this.renderInkAll();
  }

  // ---------------- Позиция ----------------
  firstVisibleIndex() {
    const top = this.scroll.getBoundingClientRect().top + 4;
    let lo = 0, hi = this.blocks.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.blocks[mid].getBoundingClientRect();
      if (r.bottom > top) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    // пропускаем невидимые (нулевые) блоки
    while (ans >= 0 && ans < this.blocks.length - 1 && this.blocks[ans].getBoundingClientRect().height === 0) ans++;
    return ans;
  }
  currentPos() {
    const i = this.firstVisibleIndex();
    if (i < 0) return null;
    const el = this.blocks[i];
    const r = el.getBoundingClientRect();
    const top = this.scroll.getBoundingClientRect().top;
    const f = r.height ? Math.max(0, Math.min(1, (top - r.top) / r.height)) : 0;
    return { b: el.dataset.b, f: +f.toFixed(4) };
  }
  percent() {
    const s = this.scroll;
    const max = s.scrollHeight - s.clientHeight;
    return max > 0 ? Math.round(s.scrollTop / max * 100) : 100;
  }
  savePosition() {
    if (this.destroyed && !this.blocks.length) return;
    const pos = this.currentPos();
    if (pos) setProgress(this.bookId, pos, this.percent());
  }
  updateProgress() {
    const pct = this.percent();
    const bar = $('.r-progress i', this.root);
    if (bar) bar.style.width = pct + '%';
    const t = $('.r-progress .pct', this.root);
    if (t) {
      if (this.book.kind === 'pdf') { const i = this.firstVisibleIndex(); t.textContent = `стр. ${Math.max(1, i + 1)} из ${this.pdfPages.length}`; }
      else t.textContent = pct + '%';
    }
  }
  async goTo(pos, { instant = false, flash = null, silent = false } = {}) {
    if (!pos) return;
    const idx = this.blockIndex.get(pos.b);
    if (idx == null) return;
    const el = this.blocks[idx];
    const top = el.offsetTop + (pos.f || 0) * el.offsetHeight - (pos.offset || 0);
    this.scroll.scrollTo({ top: Math.max(0, top), behavior: instant ? 'auto' : 'smooth' });
    if (this.book.kind === 'pdf') { await this.renderPage(idx); if (this.pdfPages[idx].task) await this.pdfPages[idx].task; }
    if (flash) setTimeout(() => this.flash(flash), instant ? 50 : 400);
    if (!silent) this.updateProgress();
  }
  flash(annId) {
    const els = $$(`[data-a="${annId}"]`, this.content);
    els.forEach(e => { e.classList.remove('flash'); void e.offsetWidth; e.classList.add('flash'); });
  }
  async goToAnnotation(a) {
    if (!a) return;
    const b = a.type === 'ink' ? a.anchor.b : a.anchor.s.b;
    await this.goTo({ b, f: 0, offset: this.scroll.clientHeight * 0.25 }, { instant: true });
    if (this.book.kind === 'pdf' && a.type !== 'ink') {
      // в PDF уточняем позицию по самому выделению, когда страница отрисована
      const m = $(`[data-a="${a.id}"]`, this.content);
      if (m) this.scroll.scrollTop += m.getBoundingClientRect().top - this.scroll.getBoundingClientRect().top - this.scroll.clientHeight * 0.3;
    } else if (a.type !== 'ink') {
      const m = $(`[data-a="${a.id}"]`, this.content);
      if (m) this.scroll.scrollTop += m.getBoundingClientRect().top - this.scroll.getBoundingClientRect().top - this.scroll.clientHeight * 0.3;
    }
    setTimeout(() => this.flash(a.id), 60);
    this.updateProgress();
    this.savePosition();
  }
  scrollToElement(el) {
    const top = el.getBoundingClientRect().top - this.scroll.getBoundingClientRect().top + this.scroll.scrollTop - 16;
    this.scroll.scrollTo({ top, behavior: 'auto' });
  }

  annList(type) {
    if (this.ownerAnns) return this.ownerAnns.filter(a => !a.del && (!type || a.type === type));
    if (this.mode === 'read') return [];
    return annotationsOf(this.bookId, type);
  }
  findAnn(id) { return this.ownerAnns ? this.ownerAnns.find(a => a.id === id) : state.annotations[id]; }

  // ---------------- Выделения (маркер и комментарии) ----------------
  refreshAnnotations() {
    // снимаем все пометки и рисуем заново
    for (const m of $$('mark[data-a]', this.content)) {
      const parent = m.parentNode;
      m.replaceWith(...m.childNodes);
      parent && parent.normalize();
    }
    $$('svg.ink', this.content).forEach(s => s.remove());
    this.marks = this.annList().filter(a => a.type === 'hl' || a.type === 'cm')
      .sort((a, b) => (a.type === 'cm') - (b.type === 'cm'));
    for (const a of this.marks) this.applyMark(a);
    this.renderInkAll();
  }
  applyMarksInBlock(block) {
    const id = block.dataset.b;
    const idx = this.blockIndex.get(id);
    for (const a of this.marks || []) {
      const si = this.blockIndex.get(a.anchor.s.b), ei = this.blockIndex.get(a.anchor.e.b);
      if (si == null || ei == null || idx < si || idx > ei) continue;
      this.wrapInBlock(a, idx, si, ei);
    }
  }
  applyMark(a) {
    const si = this.blockIndex.get(a.anchor.s.b), ei = this.blockIndex.get(a.anchor.e.b);
    if (si == null || ei == null) return;
    for (let i = si; i <= ei; i++) this.wrapInBlock(a, i, si, ei);
  }
  wrapInBlock(a, i, si, ei) {
    const root = this.textRoot(this.blocks[i]);
    if (!root || root.querySelector(`mark[data-a="${a.id}"]`)) return;
    const start = i === si ? a.anchor.s.o : 0;
    const end = i === ei ? a.anchor.e.o : Infinity;
    wrapRange(root, start, end, () => {
      const m = document.createElement('mark');
      m.dataset.a = a.id;
      m.className = a.type === 'hl' ? `hl hl-${a.color || 'yellow'}` : 'cm';
      return m;
    });
  }
  removeMark(id) {
    for (const m of $$(`mark[data-a="${id}"]`, this.content)) {
      const parent = m.parentNode; m.replaceWith(...m.childNodes); parent && parent.normalize();
    }
    this.marks = (this.marks || []).filter(a => a.id !== id);
  }

  // Преобразовать текущее выделение в «якорь» (блок + смещение в символах)
  selectionAnchor(range) {
    if (!range || range.collapsed) return null;
    if (!this.content.contains(range.commonAncestorContainer)) return null;
    const s = this.pointAnchor(range.startContainer, range.startOffset, false);
    const e = this.pointAnchor(range.endContainer, range.endOffset, true);
    if (!s || !e) return null;
    const si = this.blockIndex.get(s.b), ei = this.blockIndex.get(e.b);
    if (si > ei || (si === ei && s.o >= e.o)) return null;
    const sel = window.getSelection();
    const raw = sel && sel.rangeCount && sel.getRangeAt(0) === range ? sel.toString() : range.toString();
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { anchor: { s, e }, text: text.slice(0, 4000) };
  }
  pointAnchor(node, offset, isEnd) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    let block = el && el.closest('[data-b]');
    if (!block || !this.content.contains(block)) {
      // точка вне блока (например, между главами) — берём ближайший блок
      const r = document.createRange(); r.setStart(node, offset);
      const all = this.blocks;
      let lo = 0, hi = all.length - 1, ans = all.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const cmp = r.comparePoint(all[mid], 0);
        if (cmp >= 0) { ans = mid; hi = mid - 1; } else lo = mid + 1;
      }
      if (isEnd) { const b = all[Math.max(0, ans - 1)]; const root = this.textRoot(b); return root ? { b: b.dataset.b, o: root.textContent.length } : null; }
      const b = all[Math.min(all.length - 1, ans)]; return b ? { b: b.dataset.b, o: 0 } : null;
    }
    const root = this.textRoot(block);
    if (!root) return null;
    if (!root.contains(node)) {
      const r = document.createRange(); r.selectNodeContents(root);
      return { b: block.dataset.b, o: r.comparePoint(node, offset) < 0 ? 0 : root.textContent.length };
    }
    const r = document.createRange();
    r.setStart(root, 0); r.setEnd(node, offset);
    return { b: block.dataset.b, o: r.toString().length };
  }

  createHighlight(sel, color) {
    const a = addAnnotation({ bookId: this.bookId, type: 'hl', color, anchor: sel.anchor, text: sel.text });
    this.marks.push(a);
    this.applyMark(a);
    window.getSelection()?.removeAllRanges();
    this.hideSelBar();
    setSetting('hlColor', color);
    return a;
  }

  openCommentEditor(sel, existing = null) {
    const a = existing;
    const s = sheet(`
      <h3>${a ? 'Комментарий' : 'Новый комментарий'}</h3>
      <blockquote class="quote">${esc(excerpt(a ? a.text : sel.text, 300))}</blockquote>
      <textarea class="comment-input" rows="4" placeholder="Ваш комментарий…">${esc(a ? a.comment || '' : '')}</textarea>
      <div class="lbl">Теги</div>
      <div class="tags-box"></div>
      <div class="sheet-actions">
        ${a ? '<button class="btn ghost danger-text" id="del">Удалить</button>' : '<button class="btn ghost" data-close>Отмена</button>'}
        <button class="btn primary" id="save">Сохранить</button>
      </div>`);
    const te = tagEditor($('.tags-box', s.el), a ? a.tags : []);
    const ta = $('textarea', s.el);
    setTimeout(() => ta.focus(), 250);
    $('#save', s.el).onclick = () => {
      const comment = ta.value.trim();
      if (!comment) { toast('Напишите текст комментария'); return; }
      if (a) { updateAnnotation(a.id, { comment, tags: te.get() }); }
      else {
        const n = addAnnotation({ bookId: this.bookId, type: 'cm', anchor: sel.anchor, text: sel.text, comment, tags: te.get() });
        this.marks.push(n); this.applyMark(n);
      }
      window.getSelection()?.removeAllRanges();
      this.hideSelBar();
      s.close();
    };
    const del = $('#del', s.el);
    if (del) del.onclick = async () => { s.close(); if (await confirmSheet('Удалить комментарий?')) { deleteAnnotation(a.id); this.removeMark(a.id); } };
  }

  openHighlightSheet(a) {
    const s = sheet(`
      <h3>Заметка</h3>
      <blockquote class="quote hl-q hl-${a.color}">${esc(excerpt(a.text, 400))}</blockquote>
      <div class="lbl">Цвет</div>
      <div class="color-row">${Object.keys(HL_COLORS).map(c => `<button class="dot hl-${c} ${c === a.color ? 'on' : ''}" data-c="${c}" aria-label="${HL_COLORS[c].name}"></button>`).join('')}</div>
      <div class="lbl">Теги</div>
      <div class="tags-box"></div>
      <div class="sheet-actions">
        <button class="btn ghost danger-text" id="del">Удалить</button>
        <button class="btn ghost" id="cm">${ico('comment')} Комментировать</button>
        <button class="btn primary" id="ok">Готово</button>
      </div>`);
    const te = tagEditor($('.tags-box', s.el), a.tags, tags => updateAnnotation(a.id, { tags }));
    $('.color-row', s.el).onclick = (e) => {
      const b = e.target.closest('[data-c]'); if (!b) return;
      updateAnnotation(a.id, { color: b.dataset.c });
      $$('.color-row .dot', s.el).forEach(d => d.classList.toggle('on', d === b));
      $$(`mark[data-a="${a.id}"]`, this.content).forEach(m => { m.className = `hl hl-${b.dataset.c}`; });
      $('.hl-q', s.el).className = `quote hl-q hl-${b.dataset.c}`;
    };
    $('#ok', s.el).onclick = () => { updateAnnotation(a.id, { tags: te.get() }); s.close(); };
    $('#cm', s.el).onclick = () => { updateAnnotation(a.id, { tags: te.get() }); s.close(); this.openCommentEditor({ anchor: a.anchor, text: a.text }); };
    $('#del', s.el).onclick = () => { s.close(); deleteAnnotation(a.id); this.removeMark(a.id); toast('Заметка удалена'); };
  }

  openViewSheet(a) {
    sheet(`
      <h3>${a.type === 'cm' ? 'Комментарий автора' : 'Заметка автора'}</h3>
      <blockquote class="quote ${a.type === 'hl' ? 'hl-q hl-' + (a.color || 'yellow') : ''}">${esc(excerpt(a.text, 400))}</blockquote>
      ${a.comment ? `<p class="view-comment">${esc(a.comment)}</p>` : ''}
      ${(a.tags || []).length ? `<div class="chips view-tags">${a.tags.map(t => `<span class="chip">#${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="sheet-actions"><button class="btn primary" data-close>Закрыть</button></div>`);
  }

  // ---------------- Перо ----------------
  renderInkAll() {
    $$('svg.ink', this.content).forEach(s => s.remove());
    for (const a of this.annList('ink')) this.renderInk(a);
  }
  inkSvg(block) {
    let svg = block.querySelector(':scope > svg.ink');
    if (!svg) {
      svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'ink');
      svg.setAttribute('viewBox', '0 0 1000 1000');
      svg.setAttribute('preserveAspectRatio', 'none');
      block.appendChild(svg);
    }
    return svg;
  }
  renderInk(a) {
    const idx = this.blockIndex.get(a.anchor.b);
    if (idx == null) return;
    const svg = this.inkSvg(this.blocks[idx]);
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', pointsToPath(a.points.map(([x, y]) => [x * 1000, y * 1000])));
    path.setAttribute('stroke', a.color);
    path.setAttribute('stroke-width', a.width);
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.dataset.a = a.id;
    svg.appendChild(path);
  }
  bindPen() {
    const ov = this.overlay;
    const live = $('svg.live-ink', ov);
    let pts = null, path = null, pid = null;
    const local = (e) => { const r = ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    ov.addEventListener('pointerdown', (e) => {
      if (this.tool !== 'pen') return;
      e.preventDefault();
      ov.setPointerCapture(e.pointerId);
      pid = e.pointerId;
      if (this.eraser) { this.eraseAt(e.clientX, e.clientY); return; }
      pts = [[e.clientX, e.clientY]];
      path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('stroke', state.settings.penColor);
      path.setAttribute('stroke-width', state.settings.penWidth);
      live.appendChild(path);
      const [x, y] = local(e); path.setAttribute('d', `M${x} ${y} L${x + 0.1} ${y + 0.1}`);
    });
    ov.addEventListener('pointermove', (e) => {
      if (this.tool !== 'pen' || e.pointerId !== pid) return;
      if (this.eraser) { if (e.buttons || e.pointerType !== 'mouse') this.eraseAt(e.clientX, e.clientY); return; }
      if (!pts) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs) pts.push([ev.clientX, ev.clientY]);
      const r = ov.getBoundingClientRect();
      path.setAttribute('d', pointsToPath(pts.map(([x, y]) => [x - r.left, y - r.top])));
    });
    const end = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      if (!pts) return;
      const points = pts; pts = null;
      path.remove(); path = null;
      this.commitStroke(points);
    };
    ov.addEventListener('pointerup', end);
    ov.addEventListener('pointercancel', end);
  }
  blockAtPoint(x, y) {
    this.overlay.style.pointerEvents = 'none';
    let el = document.elementFromPoint(x, y);
    this.overlay.style.pointerEvents = '';
    let block = el && el.closest('[data-b]');
    if (block && this.content.contains(block)) return block;
    // точка на полях — ищем ближайший по вертикали блок
    let best = null, bd = Infinity;
    const i0 = Math.max(0, this.firstVisibleIndex() - 2);
    for (let i = i0; i < Math.min(this.blocks.length, i0 + 80); i++) {
      const r = this.blocks[i].getBoundingClientRect();
      if (r.height === 0) continue;
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < bd) { bd = d; best = this.blocks[i]; }
      if (r.top > y + 400) break;
    }
    return best;
  }
  commitStroke(points) {
    if (points.length < 2) points.push([points[0][0] + 0.5, points[0][1] + 0.5]);
    const block = this.blockAtPoint(points[0][0], points[0][1]);
    if (!block) return;
    const r = block.getBoundingClientRect();
    const w = r.width || 1, hh = r.height || 1;
    const simplified = simplify(points, 0.8);
    const norm = simplified.map(([x, y]) => [+((x - r.left) / w).toFixed(4), +((y - r.top) / hh).toFixed(4)]);
    const a = addAnnotation({ bookId: this.bookId, type: 'ink', anchor: { b: block.dataset.b }, points: norm, color: state.settings.penColor, width: state.settings.penWidth });
    this.inkStack.push(a.id);
    this.renderInk(a);
  }
  eraseAt(x, y) {
    for (const path of $$('svg.ink path', this.content)) {
      const svg = path.ownerSVGElement;
      const r = svg.getBoundingClientRect();
      if (x < r.left - 30 || x > r.right + 30) continue;
      const a = state.annotations[path.dataset.a];
      if (!a || a.del) continue;
      const pts = a.points.map(([px, py]) => [r.left + px * r.width, r.top + py * r.height]);
      if (distToPolyline(x, y, pts) < 14) { deleteAnnotation(a.id); path.remove(); }
    }
  }
  undoInk() {
    while (this.inkStack.length) {
      const id = this.inkStack.pop();
      const a = state.annotations[id];
      if (a && !a.del) { deleteAnnotation(id); $$(`svg.ink path[data-a="${id}"]`, this.content).forEach(p => p.remove()); return; }
    }
    toast('Нечего отменять');
  }

  // ---------------- Панели и инструменты ----------------
  bindChrome() {
    const root = this.root;
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'back') return this.onBack();
      if (act === 'panel') return this.openPanel();
      if (act === 'toc') return this.openPanel('toc');
      if (act === 'display') return this.openDisplay();
      if (act === 'sel-comment') { const sel = this.pendingSel(); if (sel) this.openCommentEditor(sel); return; }
      const hl = e.target.closest('.r-selbar [data-hl]');
      if (hl) { const sel = this.pendingSel(); if (sel) this.createHighlight(sel, hl.dataset.hl); return; }
      const tool = e.target.closest('[data-tool]');
      if (tool) return this.setTool(this.tool === tool.dataset.tool ? null : tool.dataset.tool);
    });
    // кнопки панели не должны сбрасывать выделение текста
    $$('.r-selbar button, .r-tools button', root).forEach(b => b.addEventListener('pointerdown', e => e.preventDefault()));
    $('.r-backpill', root).onclick = () => {
      const pos = this.backStack.pop();
      if (pos) this.goTo(pos, { instant: true });
      if (!this.backStack.length) $('.r-backpill', root).classList.remove('show');
    };

    // Нажатия по тексту: ссылки, пометки, показ/скрытие панелей
    this.content.addEventListener('click', (e) => {
      const link = e.target.closest('a.ilink');
      if (link) {
        e.preventDefault();
        this.backStack.push(this.currentPos());
        $('.r-backpill', root).classList.add('show');
        const target = link.dataset.gid && document.getElementById(link.dataset.gid);
        if (target) this.scrollToElement(target);
        else if (link.dataset.gc != null) { const sec = $(`section.chap[data-c="${link.dataset.gc}"]`, this.content); if (sec) this.scrollToElement(sec); }
        return;
      }
      if (e.target.closest('a[href]')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const mark = e.target.closest('mark[data-a]');
      if (mark) {
        // если пометок несколько (вложены) — комментарий важнее
        const cm = e.target.closest('mark.cm');
        const a = this.findAnn((cm || mark).dataset.a);
        if (a && !a.del) {
          if (!this.canAnnotate) { this.openViewSheet(a); return; }
          a.type === 'cm' ? this.openCommentEditor(null, a) : this.openHighlightSheet(a); return;
        }
      }
      if (!this.tool) this.showChrome(!this.root.classList.contains('chrome'));
    });

    let scrollT;
    this.scroll.addEventListener('scroll', () => {
      if (!this.tool && this.root.classList.contains('chrome') && !this._chromeLock) this.showChrome(false);
      clearTimeout(scrollT);
      scrollT = setTimeout(() => { this.updateProgress(); this.savePosition(); }, 350);
    }, { passive: true });

    // Выделение текста
    this._onSel = () => {
      clearTimeout(this.selT);
      this.selT = setTimeout(() => this.onSelectionChange(), 120);
    };
    document.addEventListener('selectionchange', this._onSel);
    const release = () => setTimeout(() => this.onSelectionRelease(), 350);
    this.content.addEventListener('mouseup', release);
    this.content.addEventListener('touchend', release);

    this._onResize = () => {
      clearTimeout(this.rsT);
      this.rsT = setTimeout(() => { if (this.book.kind === 'pdf') this.rerenderPdf(); }, 250);
    };
    window.addEventListener('resize', this._onResize);
    this.bindPen();
  }
  pendingSel() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const a = this.selectionAnchor(sel.getRangeAt(0));
      if (a) return a;
    }
    return this.lastSel || null;
  }
  onSelectionChange() {
    if (!this.canAnnotate) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed && this.content.contains(sel.anchorNode)) {
      const a = this.selectionAnchor(sel.getRangeAt(0));
      if (a) { this.lastSel = a; this.showSelBar(); return; }
    }
    this.lastSel = null;
    this.hideSelBar();
  }
  onSelectionRelease() {
    if (!this.tool || this.tool === 'pen') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const a = this.selectionAnchor(sel.getRangeAt(0));
    if (!a) return;
    const key = JSON.stringify(a.anchor);
    // ждём, пока пользователь перестанет двигать границы выделения
    clearTimeout(this.relT);
    this.relT = setTimeout(() => {
      const s2 = window.getSelection();
      if (!s2 || s2.isCollapsed || !s2.rangeCount) return;
      const b = this.selectionAnchor(s2.getRangeAt(0));
      if (!b || JSON.stringify(b.anchor) !== key) return;
      if (this.tool === 'marker') this.createHighlight(b, state.settings.hlColor);
      else if (this.tool === 'comment') this.openCommentEditor(b);
    }, 450);
  }
  showSelBar() { this.root.classList.add('has-sel'); }
  hideSelBar() { this.root.classList.remove('has-sel'); }
  showChrome(on) {
    this.root.classList.toggle('chrome', on);
    if (on) { this._chromeLock = true; setTimeout(() => { this._chromeLock = false; }, 600); }
  }

  setTool(tool) {
    this.tool = tool;
    this.eraser = false;
    this.root.classList.toggle('pen-mode', tool === 'pen');
    $$('.r-tools .tool', this.root).forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
    this.renderOpts();
    if (tool) this.showChrome(true);
    if (tool === 'marker') toast('Выделите текст — он окрасится маркером');
    if (tool === 'comment') toast('Выделите текст, чтобы прикрепить комментарий');
    if (tool === 'pen') toast('Рисуйте поверх текста. Чтобы листать — выключите перо');
  }
  renderOpts() {
    const o = $('.r-opts', this.root);
    const s = state.settings;
    if (this.tool === 'marker') {
      o.innerHTML = `<div class="opt-row">${Object.keys(HL_COLORS).map(c => `<button class="dot hl-${c} ${c === s.hlColor ? 'on' : ''}" data-c="${c}" aria-label="${HL_COLORS[c].name}"></button>`).join('')}</div>`;
      o.onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { setSetting('hlColor', b.dataset.c); this.renderOpts(); } };
    } else if (this.tool === 'pen') {
      o.innerHTML = `<div class="opt-row">
        ${PEN_COLORS.map(c => `<button class="dot ${!this.eraser && c === s.penColor ? 'on' : ''}" style="background:${c}" data-pc="${c}" aria-label="Цвет пера"></button>`).join('')}
        <span class="sep"></span>
        ${[2, 4, 7].map(w => `<button class="wbtn ${!this.eraser && w === s.penWidth ? 'on' : ''}" data-w="${w}" aria-label="Толщина ${w}"><i style="height:${w}px"></i></button>`).join('')}
        <span class="sep"></span>
        <button class="pill ${this.eraser ? 'on' : ''}" data-er>${ico('eraser')}<span>Ластик</span></button>
        <button class="pill" data-undo>${ico('undo')}</button>
      </div>`;
      o.onclick = (e) => {
        const pc = e.target.closest('[data-pc]'), w = e.target.closest('[data-w]');
        if (pc) { setSetting('penColor', pc.dataset.pc); this.eraser = false; }
        else if (w) { setSetting('penWidth', +w.dataset.w); this.eraser = false; }
        else if (e.target.closest('[data-er]')) this.eraser = !this.eraser;
        else if (e.target.closest('[data-undo]')) this.undoInk();
        this.renderOpts();
      };
    } else if (this.tool === 'comment') {
      o.innerHTML = `<div class="opt-hint">Выделите фрагмент — откроется окно комментария</div>`;
      o.onclick = null;
    } else { o.innerHTML = ''; o.onclick = null; }
  }

  openDisplay() {
    const s = state.settings;
    const isPdf = this.book.kind === 'pdf';
    const sh = sheet(`
      <h3>Отображение</h3>
      <div class="lbl">Фон</div>
      <div class="theme-row">${Object.entries(THEMES).map(([k, v]) => `<button class="theme-swatch sw-${k} ${k === s.theme ? 'on' : ''}" data-th="${k}"><span>Аа</span><small>${v}</small></button>`).join('')}</div>
      <div class="lbl">Яркость</div>
      <div class="slider-row">${ico('sun-small')}<input type="range" min="30" max="100" step="1" value="${s.brightness}" id="br">${ico('sun')}</div>
      <div class="lbl">${isPdf ? 'Масштаб' : 'Размер шрифта'} <b id="fsv">${isPdf ? Math.round(s.pdfZoom * 100) + '%' : s.fontSize}</b></div>
      <div class="slider-row"><button class="btn small" id="fsm">A−</button>
        <input type="range" id="fs" ${isPdf ? `min="0.6" max="3" step="0.1" value="${s.pdfZoom}"` : `min="13" max="34" step="1" value="${s.fontSize}"`}>
        <button class="btn small" id="fsp">A+</button></div>
      <p class="hint">Яркость меняется затемнением страницы: системную яркость экрана веб-приложение изменить не может.</p>
    `, { cls: 'compact' });
    $('.theme-row', sh.el).onclick = (e) => {
      const b = e.target.closest('[data-th]'); if (!b) return;
      setSetting('theme', b.dataset.th);
      this.root.className = this.root.className.replace(/theme-\w+/, 'theme-' + b.dataset.th);
      document.documentElement.dataset.theme = b.dataset.th;
      $$('.theme-swatch', sh.el).forEach(x => x.classList.toggle('on', x === b));
    };
    $('#br', sh.el).oninput = (e) => {
      setSetting('brightness', +e.target.value);
      $('.r-dim', this.root).style.opacity = (100 - e.target.value) / 100 * 0.75;
    };
    const fs = $('#fs', sh.el);
    const apply = (v) => {
      if (isPdf) {
        v = Math.round(Math.max(0.6, Math.min(3, v)) * 10) / 10;
        setSetting('pdfZoom', v); fs.value = v; $('#fsv', sh.el).textContent = Math.round(v * 100) + '%';
        clearTimeout(this.zT); this.zT = setTimeout(() => this.rerenderPdf(), 200);
      } else {
        v = Math.max(13, Math.min(34, Math.round(v)));
        const pos = this.currentPos();
        setSetting('fontSize', v); fs.value = v; $('#fsv', sh.el).textContent = v;
        this.root.style.setProperty('--fs', v + 'px');
        this.goTo(pos, { instant: true });
      }
    };
    fs.oninput = (e) => apply(+e.target.value);
    $('#fsm', sh.el).onclick = () => apply(+fs.value - (isPdf ? 0.1 : 1));
    $('#fsp', sh.el).onclick = () => apply(+fs.value + (isPdf ? 0.1 : 1));
  }

  openPanel(tab = this.mode === 'read' ? 'toc' : 'notes') {
    const sh = sheet(`
      <div class="tabs" role="tablist">
        ${this.mode === 'read' ? '' : '<button data-tab="notes">Заметки</button><button data-tab="comments">Комментарии</button>'}
        <button data-tab="toc">Оглавление</button>
      </div>
      <div class="panel-body"></div>`, { cls: 'tall' });
    const body = $('.panel-body', sh.el);
    const render = (t) => {
      tab = t;
      $$('.tabs button', sh.el).forEach(b => b.classList.toggle('on', b.dataset.tab === t));
      if (t === 'toc') {
        const toc = this.book.toc || [];
        body.innerHTML = toc.length ? `<ul class="toc">${toc.map((x, i) => `<li style="padding-left:${12 + x.level * 16}px" data-i="${i}">${esc(x.label)}</li>`).join('')}</ul>`
          : `<div class="empty-state">В этой книге нет оглавления</div>`;
        return;
      }
      const type = t === 'notes' ? 'hl' : 'cm';
      const items = this.annList(type).sort((a, b) => this.cmpAnchor(a, b));
      body.innerHTML = items.length ? items.map(a => annCard(a, null, { editable: this.canAnnotate })).join('')
        : `<div class="empty-state">${t === 'notes' ? 'Здесь появится всё, что вы выделите маркером' : 'Здесь появятся ваши комментарии'}</div>`;
    };
    $('.tabs', sh.el).onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) render(b.dataset.tab); };
    body.onclick = async (e) => {
      const li = e.target.closest('.toc li');
      if (li) {
        const x = this.book.toc[+li.dataset.i];
        sh.close();
        this.backStack.push(this.currentPos()); $('.r-backpill', this.root).classList.add('show');
        if (this.book.kind === 'pdf') await this.goTo({ b: 'p' + x.page, f: 0 }, { instant: true });
        else {
          const el = (x.id && document.getElementById(x.id)) || $(`section.chap[data-c="${x.c}"]`, this.content);
          if (el) this.scrollToElement(el);
        }
        return;
      }
      const card = e.target.closest('.ann-card');
      if (!card) return;
      const a = this.findAnn(card.dataset.id);
      if (e.target.closest('[data-edit]')) { sh.close(); a.type === 'cm' ? this.openCommentEditor(null, a) : this.openHighlightSheet(a); return; }
      sh.close();
      this.goToAnnotation(a);
    };
    render(tab);
  }
  cmpAnchor(a, b) {
    const ia = this.blockIndex.get(a.anchor.s.b) ?? 1e9, ib = this.blockIndex.get(b.anchor.s.b) ?? 1e9;
    return ia - ib || a.anchor.s.o - b.anchor.s.o;
  }
}

// ---------------- Помощники ----------------
export function annCard(a, bookTitle, { editable = true } = {}) {
  const tags = (a.tags || []).map(t => `<span class="chip sm">#${esc(t)}</span>`).join('');
  if (a.type === 'cm') {
    return `<div class="ann-card cm-card" data-id="${a.id}" data-book="${esc(a.bookId)}">
      ${bookTitle ? `<div class="ann-book">${esc(bookTitle)}</div>` : ''}
      <div class="ann-quote">«${esc(excerpt(a.text, 180))}»</div>
      <div class="ann-comment">${esc(a.comment)}</div>
      <div class="ann-meta">${tags}<span class="date">${fmtDate(a.created || a.t)}</span>${bookTitle || !editable ? '' : '<button class="link-btn" data-edit>Изменить</button>'}</div>
    </div>`;
  }
  return `<div class="ann-card hl-card" data-id="${a.id}" data-book="${esc(a.bookId)}">
    ${bookTitle ? `<div class="ann-book">${esc(bookTitle)}</div>` : ''}
    <div class="ann-text"><span class="hl-bg hl-${a.color || 'yellow'}">${esc(excerpt(a.text, 300))}</span></div>
    <div class="ann-meta">${tags}<span class="date">${fmtDate(a.created || a.t)}</span>${bookTitle || !editable ? '' : '<button class="link-btn" data-edit>Теги</button>'}</div>
  </div>`;
}

function textNodesOf(root) {
  const out = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.parentElement && n.parentElement.closest('svg') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let n; while ((n = w.nextNode())) out.push(n);
  return out;
}
function wrapRange(root, start, end, make) {
  const jobs = [];
  let pos = 0;
  for (const node of textNodesOf(root)) {
    const len = node.nodeValue.length;
    const ns = pos, ne = pos + len;
    pos = ne;
    if (ne <= start) continue;
    if (ns >= end) break;
    const s = Math.max(0, start - ns), e = Math.min(len, end - ns);
    if (e > s) jobs.push([node, s, e]);
  }
  for (const [node, s, e] of jobs) {
    let target = node;
    if (s > 0) target = target.splitText(s);
    if (e - s < target.nodeValue.length) target.splitText(e - s);
    const m = make();
    target.parentNode.insertBefore(m, target);
    m.appendChild(target);
  }
}
function pointsToPath(pts) {
  if (!pts.length) return '';
  if (pts.length < 3) return `M${pts[0][0]} ${pts[0][1]} ` + pts.slice(1).map(p => `L${p[0]} ${p[1]}`).join(' ');
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const l = pts[pts.length - 1];
  return d + ` L${l[0].toFixed(1)} ${l[1].toFixed(1)}`;
}
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = out[out.length - 1];
    if (Math.hypot(pts[i][0] - p[0], pts[i][1] - p[1]) >= tol) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function distToPolyline(x, y, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1] || a;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)));
  }
  return best;
}

export function ico(name) {
  const p = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    toc: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 5.5h1.5v2M4 11h2l-2 2h2M4 17h2v2H4"/>',
    notes: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 11h7M9 15h7"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    aa: '<path d="M3 18l5-12 5 12M5 14h6"/><path d="M14 18l3.5-8 3.5 8M15.2 15.5h4.6"/>',
    marker: '<path d="M14.5 4.5l5 5L10 19H5v-5z"/><path d="M4 21h16" />',
    pen: '<path d="M4 20c4-1 6-3 7-6M13 4l7 7-8 8-3-1-3-3-1-3z"/>',
    comment: '<path d="M4 5h16v11H9l-5 4z"/>',
    eraser: '<path d="M8 20h12M4.5 15.5l9-9 6 6-7 7H8z"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    'sun-small': '<circle cx="12" cy="12" r="3"/>',
    sync: '<path d="M20 11a8 8 0 00-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0014.3 4.9L20 16M20 20v-4h-4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
    book: '<path d="M4 4.5A2.5 2.5 0 016.5 2H20v17H6.5A2.5 2.5 0 004 21.5z"/><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/>',
    tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L3 13V3h10l7.6 7.6a2 2 0 010 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    stack: '<rect x="4" y="4" width="7" height="16" rx="1"/><rect x="13" y="4" width="7" height="16" rx="1"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
  }[name] || '';
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
