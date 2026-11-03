/**
 * Agent avatars — shared by the agent dashboard (picker/customizer) and the
 * kiosk (the branded call card guests see when an agent's camera is off).
 *
 * An avatar is a small JSON "spec" saved on the agent's record:
 *   { type: 'preset', id: 'a1' }                       one of the 8 presets
 *   { type: 'custom', hair, hairColor, skin, eye, head, headColor, facial, shirt, bg }
 *   { type: 'initial', bg }                            first letter of their name
 *   { type: 'photo', data: 'data:image/jpeg;base64,…' } a small uploaded photo
 * server.js validates specs against the same option lists (sanitizeAvatar) —
 * keep the two in sync when adding an option.
 *
 * VFDAvatar.html(spec, { size, animate, talking, name }) returns markup.
 */
(function () {
  const NONE = 'M0 0';
  const circ = (x, y, r) => `M${x - r} ${y} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 -${2 * r} 0 Z`;
  const DOME = 'M66 90 C65 62 80 47 100 47 C120 47 135 62 134 90';

  const HAIR = {
    short: { front: DOME + ' C133 76 124 66 100 66 C76 66 67 76 66 90 Z', back: NONE },
    swept: { front: 'M66 90 C64 58 80 42 104 42 C124 42 138 56 134 76 C134 80 133 84 132 86 C126 68 106 62 92 65 C78 68 70 76 66 90 Z', back: NONE },
    long: { front: DOME + ' C133 78 124 68 100 68 C76 68 67 78 66 90 Z', back: 'M64 92 C60 52 140 52 136 92 L142 162 L58 162 Z' },
    curly: { front: [[72, 64, 14], [88, 52, 15], [110, 50, 15], [128, 62, 14], [66, 82, 10], [134, 82, 10], [100, 56, 16]].map((t) => circ(...t)).join(' '), back: NONE },
    bun: { front: DOME + ' C133 76 124 66 100 66 C76 66 67 76 66 90 Z', back: circ(100, 38, 13) },
    buzz: { front: 'M67 90 C66 62 80 50 100 50 C120 50 134 62 133 90 C131 76 124 68 100 68 C76 68 69 76 67 90 Z', back: NONE },
    bald: { front: NONE, back: NONE },
  };
  const HAIR_LABELS = [['short', 'Short'], ['swept', 'Swept'], ['long', 'Long'], ['curly', 'Curly'], ['bun', 'Bun'], ['buzz', 'Buzz cut'], ['bald', 'Bald']];
  const SKINS = [
    ['#f6d0b5', '#e7b698', 'Skin tone 1, lightest'], ['#f6b49e', '#e99d85', 'Skin tone 2'], ['#e3a27f', '#d9946f', 'Skin tone 3'],
    ['#c98563', '#b87253', 'Skin tone 4'], ['#a86a4c', '#935a3f', 'Skin tone 5'], ['#8f5a3f', '#7a4a33', 'Skin tone 6, deepest'],
  ];
  const HAIR_COLORS = [
    ['#111111', 'Black'], ['#4a2c14', 'Dark brown'], ['#8a5a2b', 'Light brown'], ['#d9a441', 'Blonde'],
    ['#c4472f', 'Red'], ['#8a8f99', 'Grey'], ['#6c72ff', 'Periwinkle'], ['#ff8fb1', 'Pink'],
  ];
  const PAL = [
    ['#ffab15', 'Orange'], ['#6c72ff', 'Periwinkle'], ['#ffffff', 'White'], ['#35c6a8', 'Teal'],
    ['#ff8fb1', 'Pink'], ['#1f2547', 'Navy'], ['#e879e0', 'Magenta'], ['#e5484d', 'Red'],
  ];
  const HEAD_PAL = [
    ['#111111', 'Black'], ['#1f2547', 'Navy'], ['#ffffff', 'White'], ['#7a1f2b', 'Maroon'], ['#35c6a8', 'Teal'],
    ['#ff8fb1', 'Pink'], ['#ffab15', 'Orange'], ['#6c72ff', 'Periwinkle'], ['#2e7d4f', 'Green'],
  ];
  const EYES = [['none', 'None'], ['round', 'Round'], ['square', 'Square'], ['shades', 'Sunglasses']];
  const HEADS = {
    basic: [['none', 'None'], ['headset', 'Headset'], ['cap', 'Cap'], ['beanie', 'Beanie']],
    cultural: [['songkok', 'Songkok'], ['hijab', 'Hijab']],
    festive: [['santa', 'Santa hat'], ['antlers', 'Reindeer antlers'], ['party', 'Party hat']],
  };
  const FACIALS = [['none', 'None'], ['stache', 'Mustache'], ['beard', 'Beard']];
  const COLORED_HEADS = ['cap', 'beanie', 'songkok', 'hijab']; // headgear that takes the headColor swatch

  const custom = (bg, shirt, skin, hairColor, hair, head, eye, facial) =>
    ({ type: 'custom', hair, hairColor, skin, eye, head, headColor: '#111111', facial, shirt, bg });
  const PRESETS = [
    { id: 'a1', label: 'Avatar 1', spec: custom('#6c72ff', '#ffab15', 2, '#111111', 'short', 'headset', 'none', 'none') },
    { id: 'a2', label: 'Avatar 2', spec: custom('#ffab15', '#ffffff', 3, '#111111', 'long', 'none', 'none', 'none') },
    { id: 'a3', label: 'Avatar 3', spec: custom('#ffffff', '#6c72ff', 1, '#111111', 'curly', 'headset', 'round', 'none') },
    { id: 'a4', label: 'Avatar 4', spec: custom('#35c6a8', '#1f2547', 5, '#111111', 'swept', 'none', 'round', 'none') },
    { id: 'a5', label: 'Avatar 5', spec: custom('#ff8fb1', '#ffffff', 0, '#5a3217', 'bun', 'headset', 'none', 'none') },
    { id: 'a6', label: 'Avatar 6', spec: custom('#6c72ff', '#ffffff', 2, '#111111', 'bald', 'none', 'round', 'stache') },
    { id: 'a7', label: 'Avatar 7', spec: custom('#ffffff', '#e879e0', 4, '#111111', 'curly', 'headset', 'none', 'none') },
    { id: 'a8', label: 'Avatar 8', spec: custom('#ffab15', '#6c72ff', 1, '#4a2c14', 'long', 'none', 'round', 'none') },
  ];
  const DEFAULT_SPEC = { type: 'initial', bg: '#6c72ff' };
  const DEFAULT_CUSTOM = PRESETS[0].spec;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const darken = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.round(v * 0.78).toString(16).padStart(2, '0');
    return '#' + f(n >> 16) + f((n >> 8) & 255) + f(n & 255);
  };
  const isHex = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);

  // Injected once so both pages get the animation without a separate stylesheet.
  function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById('vfd-avatar-css')) return;
    const st = document.createElement('style');
    st.id = 'vfd-avatar-css';
    st.textContent = `
.vfd-av { display: block; border-radius: 50%; flex-shrink: 0; object-fit: cover; }
@keyframes vfd-av-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
@keyframes vfd-av-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(.1); } }
@keyframes vfd-av-talk { 0%, 100% { transform: scaleY(.3); } 30% { transform: scaleY(1); } 60% { transform: scaleY(.5); } 80% { transform: scaleY(.85); } }
.vfd-av.vfd-anim .av-head { animation: vfd-av-bob 3.2s ease-in-out infinite; transform-origin: 100px 150px; }
.vfd-av.vfd-anim .av-eye { transform-box: fill-box; transform-origin: center; animation: vfd-av-blink 4.2s infinite; }
.vfd-av.vfd-anim .av-mouth-talk { transform-box: fill-box; transform-origin: 50% 0; animation: vfd-av-talk .75s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .vfd-av .av-head, .vfd-av .av-eye, .vfd-av .av-mouth-talk { animation: none !important; } }`;
    document.head.appendChild(st);
  }

  /** A preset spec expands to its custom equivalent; anything unusable falls back to the default. */
  function resolve(spec) {
    if (spec && spec.type === 'preset') {
      const p = PRESETS.find((x) => x.id === spec.id);
      return p ? p.spec : DEFAULT_SPEC;
    }
    return spec && spec.type ? spec : DEFAULT_SPEC;
  }

  function customSvg(c, size, cls, talking, label) {
    const sk = SKINS[c.skin] || SKINS[2];
    const hair = HAIR[c.hair] || HAIR.short;
    const hc = isHex(c.hairColor) ? c.hairColor : '#111111';
    const headColor = isHex(c.headColor) ? c.headColor : '#111111';
    const headDark = darken(headColor);
    const shirt = isHex(c.shirt) ? c.shirt : '#ffab15';
    const bg = isHex(c.bg) ? c.bg : '#6c72ff';
    const head = c.head, eye = c.eye, facial = c.facial;
    const hijab = head === 'hijab';
    const hairBack = hijab ? '' : `<path d="${hair.back}" fill="${hc}"/>`;
    const hairFront = hijab ? '' : `<path d="${hair.front}" fill="${hc}"/>`;
    const hijabStatic = hijab
      ? `<path d="M58 112 C58 146 24 152 -6 204 L206 204 C176 152 142 146 142 112 Z" fill="${headColor}"/><path d="M72 140 C80 158 104 162 126 150" stroke="${headDark}" stroke-width="3" fill="none" stroke-linecap="round"/>`
      : '';
    const opening = 'M71 88 C71 72 83 62 100 62 C117 62 129 72 129 88 C129 110 119 131 100 131 C81 131 71 110 71 88 Z';
    const gear = {
      headset: `<path d="M67 90 C62 40 138 40 133 90" stroke="#ffffff" stroke-width="4" fill="none" stroke-linecap="round"/><rect x="59" y="82" width="11" height="22" rx="5.5" fill="#ffffff" stroke="#1f2547" stroke-width="2"/><rect x="130" y="82" width="11" height="22" rx="5.5" fill="#ffffff" stroke="#1f2547" stroke-width="2"/><path d="M64 102 C64 122 80 126 92 120" stroke="#ffffff" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="94" cy="120" r="4" fill="#ffffff" stroke="#1f2547" stroke-width="2"/>`,
      cap: `<path d="M67 74 C64 38 136 38 133 74 Z" fill="${headColor}"/><path d="M62 72 L138 72 C152 72 157 77 157 80 C140 77 100 77 62 77 Z" fill="${headDark}"/>`,
      beanie: `<path d="M66 68 C62 22 138 22 134 68 Z" fill="${headColor}"/><rect x="64" y="62" width="72" height="14" rx="7" fill="${headDark}"/>`,
      songkok: `<path d="M69 72 L72 46 L128 46 L131 72 C115 76 85 76 69 72 Z" fill="${headColor}"/><path d="M72 46 L128 46" stroke="${headDark}" stroke-width="3" stroke-linecap="round"/>`,
      hijab: `<path fill-rule="evenodd" d="M56 104 C54 52 76 36 100 36 C124 36 146 52 144 104 C144 124 142 138 142 146 L58 146 C58 138 56 124 56 104 Z ${opening}" fill="${headColor}"/><path d="${opening}" fill="none" stroke="${headDark}" stroke-width="2"/>`,
      santa: `<path d="M112 28 C132 22 150 34 152 56" stroke="#e5484d" stroke-width="14" fill="none" stroke-linecap="round"/><path d="M67 68 C67 40 92 26 112 28 C128 30 140 44 133 68 Z" fill="#e5484d"/><circle cx="152" cy="58" r="8" fill="#ffffff"/><rect x="63" y="62" width="74" height="14" rx="7" fill="#ffffff"/>`,
      antlers: `<path d="M84 54 C76 44 72 34 70 22 M76 42 C70 40 64 36 60 30 M116 54 C124 44 128 34 130 22 M124 42 C130 40 136 36 140 30" stroke="#8a5a2b" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
      party: `<path d="M78 62 L100 6 L122 62 Z" fill="#6c72ff"/><path d="M87 50 L112 38 M92 34 L107 27" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/><circle cx="100" cy="6" r="6" fill="#ffab15"/>`,
    };
    const eyewear = {
      round: `<circle cx="87" cy="92" r="10" fill="none" stroke="#3b2a22" stroke-width="2"/><circle cx="113" cy="92" r="10" fill="none" stroke="#3b2a22" stroke-width="2"/><path d="M97 92 L103 92" stroke="#3b2a22" stroke-width="2"/>`,
      square: `<rect x="76" y="83" width="22" height="17" rx="3" fill="none" stroke="#3b2a22" stroke-width="2"/><rect x="102" y="83" width="22" height="17" rx="3" fill="none" stroke="#3b2a22" stroke-width="2"/><path d="M98 90 L102 90" stroke="#3b2a22" stroke-width="2"/>`,
      shades: `<rect x="75" y="83" width="23" height="16" rx="6" fill="#111111"/><rect x="102" y="83" width="23" height="16" rx="6" fill="#111111"/><path d="M98 88 L102 88" stroke="#111111" stroke-width="2.5"/><path d="M79 87 L85 87" stroke="#ffffff" stroke-width="2" stroke-linecap="round" opacity=".4"/><path d="M106 87 L112 87" stroke="#ffffff" stroke-width="2" stroke-linecap="round" opacity=".4"/>`,
    };
    const beard = facial === 'beard' ? `<path d="M69 100 C70 128 88 140 100 140 C112 140 130 128 131 100 C124 114 112 118 100 118 C88 118 76 114 69 100 Z" fill="${hc}"/>` : '';
    const stache = facial === 'stache' ? `<path d="M89 105 C94 100 100 103 100 103 C100 103 106 100 111 105 C106 109 100 106 100 106 C100 106 94 109 89 105 Z" fill="${hc}"/>` : '';
    const mouth = talking
      ? '<path class="av-mouth-talk" d="M93 111 Q100 123 107 111 Z" fill="#8a2f2f"/>'
      : '<path d="M94 112 Q100 117 106 112" stroke="#111111" stroke-width="2.5" fill="none" stroke-linecap="round"/>';
    // Headset/cap/etc. that sit ON the hair draw after the face; the headset band is
    // drawn before brows so brows stay readable, everything else after the mouth.
    const front = head === 'headset' ? gear.headset : '';
    const top = head && head !== 'headset' && head !== 'none' ? gear[head] || '' : '';
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 200 200" role="img" aria-label="${esc(label)}">`
      + `<circle cx="100" cy="100" r="100" fill="${bg}"/>${hairBack}`
      + `<path d="M88 118 L88 168 L112 168 L112 118 Z" fill="${sk[1]}"/>`
      + `<path d="M12 200 L12 193 C12 163 52 151 88 149 C94 159 106 159 112 149 C148 151 188 163 188 193 L188 200 Z" fill="${shirt}"/>${hijabStatic}`
      + `<g class="av-head"><path d="M87 126 C91 143 109 143 113 126 Z" fill="#111111"/>`
      + `<circle cx="68" cy="94" r="6.5" fill="${sk[1]}"/><circle cx="132" cy="94" r="6.5" fill="${sk[1]}"/>`
      + `<path d="M69 86 C69 64 82 53 100 53 C118 53 131 64 131 86 C131 106 120 130 100 131 C80 130 69 106 69 86 Z" fill="${sk[0]}"/>`
      + `${beard}${hairFront}${front}`
      + `<path d="M79 82 Q87 78 95 82" stroke="${hc}" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M105 82 Q113 78 121 82" stroke="${hc}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`
      + `<circle class="av-eye" cx="87" cy="92" r="3" fill="#111111"/><circle class="av-eye" cx="113" cy="92" r="3" fill="#111111"/>${eyewear[eye] || ''}`
      + `<path d="M99 99 Q100 104 103 102" stroke="${sk[1]}" stroke-width="2" fill="none" stroke-linecap="round"/>${stache}${mouth}${top}</g></svg>`;
  }

  /** Markup for an avatar. opts: size (px, default 96), animate (default true), talking (default false), name (for 'initial'). */
  function html(spec, opts) {
    ensureStyles();
    const o = opts || {};
    const size = o.size || 96;
    const s = resolve(spec);
    const name = o.name || '';
    const label = o.label || (name ? `${name}'s avatar` : 'Avatar');
    const cls = 'vfd-av' + (o.animate === false ? '' : ' vfd-anim');
    if (s.type === 'photo' && typeof s.data === 'string' && s.data.startsWith('data:image/')) {
      return `<img class="vfd-av" width="${size}" height="${size}" src="${esc(s.data)}" alt="${esc(label)}">`;
    }
    if (s.type === 'initial') {
      const bg = isHex(s.bg) ? s.bg : '#6c72ff';
      const letter = esc((name.trim().charAt(0) || '?').toUpperCase());
      return `<svg class="vfd-av" width="${size}" height="${size}" viewBox="0 0 200 200" role="img" aria-label="${esc(label)}"><circle cx="100" cy="100" r="100" fill="${bg}"/><text x="100" y="100" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="96" font-weight="800" fill="${bg.toLowerCase() === '#ffffff' ? '#1f2547' : '#ffffff'}">${letter}</text></svg>`;
    }
    if (s.type === 'custom') return customSvg(s, size, cls, !!o.talking, label);
    return html(DEFAULT_SPEC, o);
  }

  window.VFDAvatar = {
    html, resolve, PRESETS, DEFAULT_SPEC, DEFAULT_CUSTOM, COLORED_HEADS,
    OPTIONS: { HAIR_LABELS, HAIR_COLORS, SKINS, PAL, HEAD_PAL, EYES, HEADS, FACIALS },
  };
})();
