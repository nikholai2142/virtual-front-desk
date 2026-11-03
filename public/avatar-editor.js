/**
 * Avatar picker/customizer modal for the agent dashboard. Renders into
 * #avatar-card. Tabs: Presets · Customize · Photo · Initial. The draft is
 * only sent to the server (via the onSave callback) when the agent hits Save.
 *
 *   VFDAvatarEditor.open({ spec, name, onSave(spec) })
 *   VFDAvatarEditor.saved() / .failed(message)   — called by agent.js with the server's reply
 */
(function () {
  const A = window.VFDAvatar;
  const O = A.OPTIONS;
  const modal = document.getElementById('avatar-modal');
  const card = document.getElementById('avatar-card');

  let draft = null;
  let tab = 'presets';
  let sub = 'hair';
  let name = '';
  let onSave = null;
  let saving = false;
  let message = '';
  let messageIsError = false;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  /** The draft as an editable 'custom' spec (expanding a preset; starting fresh from initial/photo). */
  function asCustom() {
    const r = A.resolve(draft);
    return clone(r.type === 'custom' ? r : A.DEFAULT_CUSTOM);
  }

  const pill = (k, label, on, attrs) =>
    `<button type="button" class="av-pill" data-k="${k}" ${attrs} aria-pressed="${on}">${esc(label)}</button>`;
  const swatch = (k, color, label, on, attrs) =>
    `<button type="button" class="av-swatch" data-k="${k}" ${attrs} aria-label="${esc(label)}" aria-pressed="${on}" style="background:${color};"></button>`;
  const field = (f, v, extra) => `data-act="set" data-f="${f}" data-v="${esc(v)}"${extra || ''}`;

  function pillRow(title, f, list, cur) {
    return `<div class="av-group-label">${title}</div><div class="av-row">`
      + list.map(([v, l]) => pill(`${f}-${v}`, l, cur === v, field(f, v))).join('') + '</div>';
  }
  function swatchRow(title, f, list, cur, note) {
    return `<div class="av-group-label">${title}</div><div class="av-row av-row-sw">`
      + list.map((it) => swatch(`${f}-${it[0]}`, it[0], it[it.length - 1], cur === it[0], field(f, it[0]))).join('') + '</div>'
      + (note ? `<p class="av-note">${note}</p>` : '');
  }

  function customPanel() {
    const c = asCustom();
    const subs = [['hair', 'Hair'], ['face', 'Face'], ['gear', 'Gear'], ['outfit', 'Outfit']];
    const tabs = `<div class="av-subtabs" role="tablist" aria-label="Avatar parts">`
      + subs.map(([id, l]) => `<button type="button" role="tab" class="av-subtab" data-k="sub-${id}" data-act="sub" data-v="${id}" aria-selected="${sub === id}">${l}</button>`).join('') + '</div>';
    let body = '';
    if (sub === 'hair') {
      body = pillRow('Hair style', 'hair', O.HAIR_LABELS, c.hair) + swatchRow('Hair colour', 'hairColor', O.HAIR_COLORS, c.hairColor);
    } else if (sub === 'face') {
      body = `<div class="av-group-label">Skin tone</div><div class="av-row av-row-sw">`
        + O.SKINS.map((s, i) => swatch(`skin-${i}`, s[0], s[2], c.skin === i, field('skin', i))).join('') + '</div>'
        + pillRow('Facial hair', 'facial', O.FACIALS, c.facial) + '<p class="av-note">Facial hair uses your hair colour.</p>';
    } else if (sub === 'gear') {
      const colored = A.COLORED_HEADS.includes(c.head);
      body = pillRow('Eyewear', 'eye', O.EYES, c.eye)
        + pillRow('Headgear', 'head', O.HEADS.basic, c.head)
        + pillRow('Cultural', 'head', O.HEADS.cultural, c.head)
        + pillRow('Festive', 'head', O.HEADS.festive, c.head)
        + (colored ? swatchRow('Headgear colour', 'headColor', O.HEAD_PAL, c.headColor) : '');
    } else {
      body = swatchRow('Shirt colour', 'shirt', O.PAL, c.shirt) + swatchRow('Background', 'bg', O.PAL, c.bg);
    }
    return `<div class="av-custom-actions"><button type="button" class="btn-small" data-act="randomize" data-k="randomize">Randomize</button>`
      + `<button type="button" class="btn-small" data-act="reset" data-k="reset">Reset</button></div>${tabs}<div class="av-body">${body}</div>`;
  }

  function presetsPanel() {
    return '<div class="av-group-label">Choose one</div><div class="av-presets">'
      + A.PRESETS.map((p) => {
        const on = draft.type === 'preset' && draft.id === p.id;
        return `<button type="button" class="av-tile" data-k="preset-${p.id}" data-act="preset" data-v="${p.id}" aria-label="${esc(p.label)}" aria-pressed="${on}">`
          + A.html(p.spec, { size: 72, animate: false, name }) + '</button>';
      }).join('') + '</div>'
      + '<p class="av-note">Want something different? Use the Customize tab to change the hair, headgear and more.</p>';
  }

  function photoPanel() {
    return '<div class="av-group-label">Your photo</div>'
      + '<p class="av-note">Pick a photo of your face. It is cropped to a circle and shrunk before it is saved.</p>'
      + '<div class="av-row"><button type="button" class="btn-small" data-act="upload" data-k="upload">Choose a photo…</button></div>'
      + '<input id="avatar-file" type="file" accept="image/jpeg,image/png,image/webp" hidden />';
  }

  function initialPanel() {
    const cur = draft.type === 'initial' ? draft.bg : null;
    return swatchRow('Background colour', 'initialBg', O.PAL, cur)
      .replace(/data-act="set" data-f="initialBg"/g, 'data-act="initial"')
      + `<p class="av-note">Shows the first letter of your name${name ? ` (“${esc(name.trim().charAt(0).toUpperCase())}”)` : ''}.</p>`;
  }

  function render() {
    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null;
    const tabs = [['presets', 'Presets'], ['custom', 'Customize'], ['photo', 'Photo'], ['initial', 'Initial']];
    const panel = tab === 'presets' ? presetsPanel() : tab === 'custom' ? customPanel() : tab === 'photo' ? photoPanel() : initialPanel();
    card.innerHTML = `
      <h2 id="avatar-title">Your avatar</h2>
      <p class="sub">Guests see this on the kiosk whenever your camera is off or you don't have one.</p>
      <div class="av-layout">
        <div class="av-preview">
          <div class="av-preview-ring">${A.html(draft, { size: 180, talking: true, name })}</div>
          <span class="av-preview-label">Preview</span>
        </div>
        <div class="av-main">
          <div class="av-tabs" role="tablist" aria-label="Avatar source">
            ${tabs.map(([id, l]) => `<button type="button" role="tab" class="av-tab" data-k="tab-${id}" data-act="tab" data-v="${id}" aria-selected="${tab === id}">${l}</button>`).join('')}
          </div>
          <div class="av-panel">${panel}</div>
        </div>
      </div>
      <p id="avatar-message" class="${messageIsError ? 'error' : 'hint'} ${message ? '' : 'hidden'}">${esc(message)}</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-act="save" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save avatar'}</button>
      </div>`;
    if (focusKey) {
      const el = card.querySelector(`[data-k="${CSS.escape(focusKey)}"]`);
      if (el) el.focus();
    }
  }

  function setCustom(patch) {
    draft = Object.assign(asCustom(), patch);
    message = '';
    render();
  }

  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const S = 256;
        const cv = document.createElement('canvas');
        cv.width = S; cv.height = S;
        const side = Math.min(img.width, img.height);
        cv.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
        draft = { type: 'photo', data: cv.toDataURL('image/jpeg', 0.82) };
        message = '';
        render();
      };
      img.onerror = () => { message = "That file couldn't be read as an image."; messageIsError = true; render(); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  card.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || saving) return;
    const v = btn.dataset.v;
    switch (btn.dataset.act) {
      case 'tab':
        tab = v;
        if (v === 'custom' && draft.type !== 'custom') draft = asCustom();
        message = '';
        render();
        break;
      case 'sub': sub = v; render(); break;
      case 'preset': draft = { type: 'preset', id: v }; message = ''; render(); break;
      case 'set': setCustom({ [btn.dataset.f]: btn.dataset.f === 'skin' ? Number(v) : v }); break;
      case 'initial': draft = { type: 'initial', bg: v }; message = ''; render(); break;
      case 'randomize':
        setCustom({
          hair: pick(O.HAIR_LABELS)[0], hairColor: pick(O.HAIR_COLORS)[0], skin: Math.floor(Math.random() * O.SKINS.length),
          eye: pick(O.EYES)[0], head: pick([].concat(O.HEADS.basic, O.HEADS.cultural, O.HEADS.festive))[0], headColor: pick(O.HEAD_PAL)[0],
          facial: pick(O.FACIALS)[0], shirt: pick(O.PAL)[0], bg: pick(O.PAL)[0],
        });
        break;
      case 'reset': draft = clone(A.DEFAULT_CUSTOM); render(); break;
      case 'upload': { const f = card.querySelector('#avatar-file'); if (f) f.click(); break; }
      case 'cancel': close(); break;
      case 'save':
        saving = true; message = ''; render();
        if (onSave) onSave(clone(draft));
        break;
    }
  });
  card.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'avatar-file') handleFile(e.target.files && e.target.files[0]);
  });
  modal.addEventListener('click', (e) => { if (e.target === modal && !saving) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden') && !saving) close(); });

  function open(opts) {
    name = opts.name || '';
    onSave = opts.onSave;
    const spec = opts.spec || A.DEFAULT_SPEC;
    draft = clone(spec);
    tab = spec.type === 'custom' ? 'custom' : spec.type === 'photo' ? 'photo' : spec.type === 'initial' ? 'initial' : 'presets';
    sub = 'hair';
    saving = false; message = ''; messageIsError = false;
    modal.classList.remove('hidden');
    render();
    const first = card.querySelector('[aria-selected="true"], [aria-pressed="true"]') || card.querySelector('button');
    if (first) first.focus();
  }
  function close() { modal.classList.add('hidden'); saving = false; }

  window.VFDAvatarEditor = {
    open, close,
    saved() { close(); },
    failed(msg) { saving = false; message = msg || "Couldn't save your avatar. Please try again."; messageIsError = true; render(); },
  };
})();
