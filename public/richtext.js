/*
 * Small rich-text helper shared by the admin dashboard (editor) and the kiosk
 * (display). No dependencies.
 *
 *   RichText.sanitize(html)   -> safe HTML (whitelisted tags + styles only)
 *   RichText.legacyToHtml(t)  -> converts the older plain format (blank-line
 *                                paragraphs, **bold**) to HTML
 *   RichText.attach(textarea) -> replaces a <textarea> with a formatting
 *                                editor; returns { getValue, setValue }
 *
 * Whatever the editor produces is passed through sanitize() before it is
 * saved, the server filters it again, and the kiosk filters it once more
 * before showing it.
 */
(function () {
  const FONTS = [
    ['Arial', 'Arial, Helvetica, sans-serif'],
    ['Georgia', 'Georgia, serif'],
    ['Times New Roman', "'Times New Roman', Times, serif"],
    ['Verdana', 'Verdana, Geneva, sans-serif'],
    ['Trebuchet MS', "'Trebuchet MS', sans-serif"],
    ['Tahoma', 'Tahoma, Geneva, sans-serif'],
    ['Courier New', "'Courier New', monospace"],
  ];
  const FONT_STACK = {};
  FONTS.forEach(([name, stack]) => { FONT_STACK[name.toLowerCase()] = stack; });
  const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40];
  const FONT_SIZE_ATTR_PX = { 1: 10, 2: 13, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 };
  const SIZE_KEYWORD_PX = { 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
  const ALLOWED = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'SPAN', 'DIV', 'BLOCKQUOTE']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'TITLE', 'HEAD']);

  function cleanColor(v) {
    v = String(v || '').trim();
    if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)) return v;
    const m = v.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i);
    if (m) return 'rgb(' + Math.min(255, +m[1]) + ', ' + Math.min(255, +m[2]) + ', ' + Math.min(255, +m[3]) + ')';
    return '';
  }
  function cleanFamily(v) {
    const first = String(v || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
    return FONT_STACK[first] || '';
  }
  function cleanSize(v) {
    v = String(v || '').trim().toLowerCase();
    if (SIZE_KEYWORD_PX[v]) return SIZE_KEYWORD_PX[v] + 'px';
    const m = v.match(/^(\d+(?:\.\d+)?)px$/);
    if (m) { const n = Math.round(+m[1]); if (n >= 8 && n <= 96) return n + 'px'; }
    return '';
  }
  function cleanStyle(text) {
    const out = [];
    String(text || '').split(';').forEach((decl) => {
      const i = decl.indexOf(':');
      if (i < 0) return;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim();
      let c = '';
      if (prop === 'color') { c = cleanColor(val); if (c) out.push('color: ' + c); }
      else if (prop === 'font-size') { c = cleanSize(val); if (c) out.push('font-size: ' + c); }
      else if (prop === 'font-family') { c = cleanFamily(val); if (c) out.push('font-family: ' + c); }
      else if (prop === 'text-align' && /^(left|center|right|justify)$/i.test(val)) out.push('text-align: ' + val.toLowerCase());
      else if (prop === 'font-weight' && /^(bold|700|800|900)$/i.test(val)) out.push('font-weight: bold');
      else if (prop === 'font-style' && /^italic$/i.test(val)) out.push('font-style: italic');
      else if (prop === 'text-decoration' && /^underline$/i.test(val)) out.push('text-decoration: underline');
    });
    return out.join('; ');
  }

  function copyInto(src, dest) {
    src.childNodes.forEach((n) => {
      if (n.nodeType === 3) { dest.appendChild(document.createTextNode(n.nodeValue)); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (DROP.has(tag)) return;
      if (tag === 'FONT') {
        const span = document.createElement('span');
        const parts = [];
        const face = cleanFamily(n.getAttribute('face')); if (face) parts.push('font-family: ' + face);
        const col = cleanColor(n.getAttribute('color')); if (col) parts.push('color: ' + col);
        const sz = FONT_SIZE_ATTR_PX[n.getAttribute('size')]; if (sz) parts.push('font-size: ' + sz + 'px');
        const st = cleanStyle(n.getAttribute('style')); if (st) parts.push(st);
        if (parts.length) span.setAttribute('style', parts.join('; '));
        copyInto(n, span);
        dest.appendChild(span);
        return;
      }
      if (ALLOWED.has(tag)) {
        const el = document.createElement(tag.toLowerCase());
        const st = cleanStyle(n.getAttribute('style'));
        if (st) el.setAttribute('style', st);
        if (tag !== 'BR') copyInto(n, el);
        dest.appendChild(el);
        return;
      }
      copyInto(n, dest); // unknown tag: keep its contents, drop the tag
    });
  }

  function sanitize(html) {
    const doc = new DOMParser().parseFromString('<!doctype html><body>' + String(html || ''), 'text/html');
    const out = document.createElement('div');
    copyInto(doc.body, out);
    return out.innerHTML;
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function looksLikeHtml(t) { return /<\/?[a-z][^>]*>/i.test(String(t || '')); }
  function legacyToHtml(t) {
    return String(t || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
      .map((p) => '<p>' + esc(p).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>') + '</p>').join('');
  }
  function isEmptyHtml(html) {
    return !String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '');
  }

  // ---- editor ---------------------------------------------------------
  let cssAdded = false;
  function addCss() {
    if (cssAdded) return; cssAdded = true;
    const st = document.createElement('style');
    st.textContent = `
.rte { width: 100%; border: 1px solid var(--border, #444); border-radius: 10px; overflow: hidden; background: var(--panel, #121b2e); }
.rte-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border, #444); }
.rte-btn { min-width: 36px; height: 36px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--border, #444); background: var(--panel-2, #16213a); color: var(--text, #fff); font: inherit; font-size: 14px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.rte-btn:hover { border-color: var(--accent, #2f6fed); }
.rte-sel { height: 36px; border-radius: 8px; border: 1px solid var(--border, #444); background: var(--panel-2, #16213a); color: var(--text, #fff); font: inherit; font-size: 14px; padding: 0 6px; }
.rte-color { width: 40px; height: 36px; padding: 2px; border-radius: 8px; border: 1px solid var(--border, #444); background: var(--panel-2, #16213a); cursor: pointer; }
.rte-sep { width: 1px; height: 24px; background: var(--border, #444); margin: 0 2px; }
.rte-area { min-height: 240px; max-height: 480px; overflow-y: auto; padding: 14px 16px; background: #ffffff; color: #16232e; font-size: 17px; line-height: 1.55; outline: none; resize: vertical; }
.rte-area:focus { box-shadow: inset 0 0 0 2px var(--accent, #2f6fed); }
.rte-area p, .rte-area div { margin: 0 0 12px; }
.rte-area ul, .rte-area ol { margin: 0 0 12px; padding-left: 28px; }
.rte-area blockquote { margin: 0 0 0 32px; padding: 0; border: 0; }
.rte-hint { font-size: 12px; color: var(--sub, #9fb0cc); padding: 6px 10px; border-top: 1px solid var(--border, #444); }
`;
    document.head.appendChild(st);
  }

  function attach(textarea) {
    if (textarea._rte) return textarea._rte;
    addCss();
    const wrap = document.createElement('div'); wrap.className = 'rte';
    const bar = document.createElement('div'); bar.className = 'rte-bar'; bar.setAttribute('role', 'toolbar');
    const area = document.createElement('div'); area.className = 'rte-area'; area.contentEditable = 'true'; area.setAttribute('role', 'textbox'); area.setAttribute('aria-multiline', 'true');
    if (textarea.id) area.setAttribute('aria-label', (document.querySelector('label[for="' + textarea.id + '"]') || {}).textContent || 'Text');
    const hint = document.createElement('div'); hint.className = 'rte-hint'; hint.textContent = 'Tab indents the line or list item, Shift+Tab moves it back.';
    wrap.append(bar, area, hint);
    textarea.style.display = 'none';
    textarea.parentNode.insertBefore(wrap, textarea);

    let saved = null;
    document.addEventListener('selectionchange', () => {
      const s = window.getSelection();
      if (s.rangeCount && area.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange();
    });
    function restore() {
      area.focus();
      if (saved) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(saved); }
    }
    function sync() { textarea.value = isEmptyHtml(area.innerHTML) ? '' : sanitize(area.innerHTML); }
    function exec(cmd, val) { restore(); document.execCommand(cmd, false, val); sync(); }
    function fontsToSpans(sizePx) {
      const made = [];
      area.querySelectorAll('font').forEach((f) => {
        const span = document.createElement('span');
        const parts = [];
        if (f.getAttribute('face')) { const s = cleanFamily(f.getAttribute('face')); if (s) parts.push('font-family: ' + s); }
        if (f.getAttribute('color')) { const c = cleanColor(f.getAttribute('color')); if (c) parts.push('color: ' + c); }
        if (f.getAttribute('size')) {
          const px = f.getAttribute('size') === '7' && sizePx ? sizePx : FONT_SIZE_ATTR_PX[f.getAttribute('size')];
          if (px) parts.push('font-size: ' + px + 'px');
        }
        if (parts.length) span.setAttribute('style', parts.join('; '));
        while (f.firstChild) span.appendChild(f.firstChild);
        f.parentNode.replaceChild(span, f);
        made.push(span);
        // an inner size would override the one just chosen
        if (sizePx && f.getAttribute('size') === '7') span.querySelectorAll('[style*="font-size"]').forEach((i) => { i.style.fontSize = ''; if (!i.getAttribute('style')) i.removeAttribute('style'); });
      });
      // The replaced nodes broke the saved selection; select what was just changed so the next
      // button (font, size, colour, bold...) still applies to the same text.
      if (made.length) {
        const r = document.createRange();
        r.setStartBefore(made[0]); r.setEndAfter(made[made.length - 1]);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        saved = r.cloneRange();
      }
    }

    function button(label, title, onClick, html) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'rte-btn'; b.title = title; b.setAttribute('aria-label', title);
      if (html) b.innerHTML = html; else b.textContent = label;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
      b.addEventListener('click', onClick);
      bar.appendChild(b);
      return b;
    }
    function sep() { const s = document.createElement('span'); s.className = 'rte-sep'; bar.appendChild(s); }

    const fontSel = document.createElement('select'); fontSel.className = 'rte-sel'; fontSel.setAttribute('aria-label', 'Font');
    fontSel.innerHTML = '<option value="">Font</option>' + FONTS.map((f) => '<option value="' + f[0] + '" style="font-family:' + f[1].replace(/"/g, '') + '">' + f[0] + '</option>').join('');
    fontSel.addEventListener('change', () => { if (fontSel.value) { exec('fontName', fontSel.value); fontsToSpans(); sync(); } fontSel.value = ''; });
    const sizeSel = document.createElement('select'); sizeSel.className = 'rte-sel'; sizeSel.setAttribute('aria-label', 'Text size');
    sizeSel.innerHTML = '<option value="">Size</option>' + SIZES.map((n) => '<option value="' + n + '">' + n + '</option>').join('');
    sizeSel.addEventListener('change', () => { const n = +sizeSel.value; if (n) { exec('fontSize', '7'); fontsToSpans(n); sync(); } sizeSel.value = ''; });
    bar.append(fontSel, sizeSel);
    sep();
    button('B', 'Bold', () => exec('bold')).style.fontWeight = '800';
    button('I', 'Italic', () => exec('italic')).style.fontStyle = 'italic';
    button('U', 'Underline', () => exec('underline')).style.textDecoration = 'underline';
    const color = document.createElement('input'); color.type = 'color'; color.className = 'rte-color'; color.value = '#16232e'; color.title = 'Text colour'; color.setAttribute('aria-label', 'Text colour');
    color.addEventListener('input', () => { exec('foreColor', color.value); fontsToSpans(); sync(); });
    bar.appendChild(color);
    sep();
    button('', 'Bulleted list', () => exec('insertUnorderedList'), '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="4" cy="6" r="1.3"/><circle cx="4" cy="12" r="1.3"/><circle cx="4" cy="18" r="1.3"/><path d="M9 6h12M9 12h12M9 18h12"/></svg>');
    button('1.', 'Numbered list', () => exec('insertOrderedList'));
    button('', 'Indent', () => exec('indent'), '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M11 12h10M11 18h10M3 9l4 3-4 3z"/></svg>');
    button('', 'Outdent', () => exec('outdent'), '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M11 12h10M11 18h10M7 9l-4 3 4 3z"/></svg>');
    sep();
    button('Clear', 'Clear formatting', () => exec('removeFormat'));

    area.addEventListener('input', sync);
    area.addEventListener('blur', sync);
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand(e.shiftKey ? 'outdent' : 'indent'); sync(); }
    });
    area.addEventListener('paste', (e) => {
      e.preventDefault();
      const cd = e.clipboardData;
      const html = cd && cd.getData('text/html');
      const text = cd && cd.getData('text/plain');
      document.execCommand('insertHTML', false, html ? sanitize(html) : legacyToHtml(text || ''));
      sync();
    });

    const api = {
      getValue() { sync(); return textarea.value; },
      setValue(v) {
        v = String(v || '');
        area.innerHTML = v ? (looksLikeHtml(v) ? sanitize(v) : legacyToHtml(v)) : '';
        sync();
      },
    };
    textarea._rte = api;
    api.setValue(textarea.value);
    return api;
  }

  window.RichText = { sanitize, legacyToHtml, looksLikeHtml, isEmptyHtml, attach };
})();
