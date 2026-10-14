/* Measurement Lab deck engine.
   Load BEFORE the MathJax script (both with defer) so the MathJax config below is in place. */
window.MathJax = {
  tex: { inlineMath: [['\\(', '\\)']], displayMath: [['$$', '$$'], ['\\[', '\\]']], tags: 'none' },
  svg: { fontCache: 'global' },
  options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'canvas', 'svg'] }
};

(function () {
  'use strict';
  const Deck = (window.Deck = window.Deck || {});
  const hooks = {};      // slideId -> {setup, redraw, done}
  const loops = {};      // slideId -> [fn]
  let slides = [], cur = 0, rafId = 0, lastT = 0;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  /* ---------- colours ---------- */
  const NAMES = ['acc', 'blu', 'ink', 'muted', 'grn', 'red', 'ylw', 'rule', 'grid', 'paper', 'panel', 'acc-soft', 'blu-soft', 'grn-soft', 'red-soft', 'ylw-soft'];
  Deck.color = function (c) {
    if (!c) return getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
    if (NAMES.indexOf(c) >= 0) return getComputedStyle(document.documentElement).getPropertyValue('--' + c).trim();
    return c;
  };
  Deck.alpha = function (c, a) {
    const hex = Deck.color(c).replace('#', '');
    if (hex.length !== 6) return Deck.color(c);
    const n = parseInt(hex, 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  };
  Deck.font = function (px, mono) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(mono ? '--f-mono' : '--f-body');
    return px + 'px ' + v;
  };

  /* ---------- canvas plotting ---------- */
  function niceStep(span, target) {
    const raw = span / target, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
  }
  function fmtTick(v, step) {
    if (Math.abs(v) < step * 1e-6) return '0';
    const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    const s = v.toFixed(Math.min(d, 6));
    return s;
  }
  function fmtLog(v) {
    const e = Math.round(Math.log10(v));
    if (e >= -2 && e <= 4) return String(+v.toPrecision(3));
    return '1e' + e;
  }
  Deck.sizeCanvas = function (cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.max(240, cv.clientWidth || cv.parentNode.clientWidth || 600);
    let h = +(cv.dataset.h || 300);
    if (w < 520) h = Math.round(h * Math.max(0.7, w / 620));
    cv.style.height = h + 'px';
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, W: w, H: h };
  };
  /* Deck.plot(canvas, opts) -> {ctx, X, Y, invX, invY, W, H, box}
     opts: x:[min,max], y:[min,max], logx, logy, xlabel, ylabel, title,
     series:[{f, pts, color, width, dash, n, fill, label}], hlines/vlines:[{y|x, color, dash, label}],
     points:[{x,y,color,r,label}], pad:{l,r,t,b}, noGrid */
  Deck.plot = function (cv, o) {
    const { ctx, W, H } = Deck.sizeCanvas(cv);
    const pad = Object.assign({ l: 58, r: 18, t: o.title ? 28 : 14, b: o.xlabel ? 46 : 30 }, o.pad || {});
    const x0 = pad.l, x1 = W - pad.r, y0 = pad.t, y1 = H - pad.b;
    const lx = !!o.logx, ly = !!o.logy;
    const tx = v => lx ? Math.log10(v) : v, ty = v => ly ? Math.log10(v) : v;
    const xa = tx(o.x[0]), xb = tx(o.x[1]), ya = ty(o.y[0]), yb = ty(o.y[1]);
    const X = v => x0 + (tx(v) - xa) / (xb - xa) * (x1 - x0);
    const Y = v => y1 - (ty(v) - ya) / (yb - ya) * (y1 - y0);
    const invX = px => { const t = xa + (px - x0) / (x1 - x0) * (xb - xa); return lx ? Math.pow(10, t) : t; };
    const invY = py => { const t = ya + (y1 - py) / (y1 - y0) * (yb - ya); return ly ? Math.pow(10, t) : t; };
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = Deck.color('paper'); ctx.fillRect(0, 0, W, H);
    // grid + ticks
    ctx.font = Deck.font(11, true); ctx.lineWidth = 1;
    const gridC = Deck.color('rule'), txtC = Deck.color('muted');
    function xTicks() {
      if (o.xticks) return o.xticks;
      if (lx) { const a = []; for (let e = Math.ceil(xa - 1e-9); e <= xb + 1e-9; e++) a.push(Math.pow(10, e)); return a; }
      const st = niceStep(o.x[1] - o.x[0], W < 520 ? 4 : 7), a = [];
      for (let v = Math.ceil(o.x[0] / st - 1e-9) * st; v <= o.x[1] + st * 1e-6; v += st) a.push(+v.toFixed(10));
      a.step = st; return a;
    }
    function yTicks() {
      if (o.yticks) return o.yticks;
      if (ly) { const a = []; for (let e = Math.ceil(ya - 1e-9); e <= yb + 1e-9; e++) a.push(Math.pow(10, e)); return a; }
      const st = niceStep(o.y[1] - o.y[0], 5), a = [];
      for (let v = Math.ceil(o.y[0] / st - 1e-9) * st; v <= o.y[1] + st * 1e-6; v += st) a.push(+v.toFixed(10));
      a.step = st; return a;
    }
    const xt = xTicks(), yt = yTicks();
    ctx.strokeStyle = gridC; ctx.fillStyle = txtC;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    xt.forEach(v => {
      const p = X(v); if (p < x0 - 1 || p > x1 + 1) return;
      if (!o.noGrid) { ctx.globalAlpha = .6; ctx.beginPath(); ctx.moveTo(p, y0); ctx.lineTo(p, y1); ctx.stroke(); ctx.globalAlpha = 1; }
      ctx.fillText(lx ? fmtLog(v) : (o.xfmt ? o.xfmt(v) : fmtTick(v, xt.step || 1)), p, y1 + 6);
    });
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    yt.forEach(v => {
      const p = Y(v); if (p < y0 - 1 || p > y1 + 1) return;
      if (!o.noGrid) { ctx.globalAlpha = .6; ctx.beginPath(); ctx.moveTo(x0, p); ctx.lineTo(x1, p); ctx.stroke(); ctx.globalAlpha = 1; }
      ctx.fillText(ly ? fmtLog(v) : (o.yfmt ? o.yfmt(v) : fmtTick(v, yt.step || 1)), x0 - 6, p);
    });
    // axes box
    ctx.strokeStyle = Deck.color('muted'); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); ctx.lineTo(x1, y1); ctx.stroke();
    // labels
    ctx.fillStyle = Deck.color('ink'); ctx.font = Deck.font(12.5);
    if (o.xlabel) { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(o.xlabel, (x0 + x1) / 2, H - 4); }
    if (o.ylabel) { ctx.save(); ctx.translate(13, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(o.ylabel, 0, 0); ctx.restore(); }
    if (o.title) { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = Deck.font(12.5); ctx.fillText(o.title, x0, 6); }
    // clip plotting area
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0 - 2, x1 - x0, y1 - y0 + 4); ctx.clip();
    (o.bands || []).forEach(b => {
      ctx.fillStyle = Deck.alpha(b.color || 'acc', b.alpha || .12);
      if (b.y0 !== undefined) ctx.fillRect(x0, Y(b.y1), x1 - x0, Y(b.y0) - Y(b.y1));
      else ctx.fillRect(X(b.x0), y0, X(b.x1) - X(b.x0), y1 - y0);
    });
    function guide(isH, l) {
      ctx.strokeStyle = Deck.color(l.color || 'muted'); ctx.lineWidth = l.width || 1.3; ctx.setLineDash(l.dash || [5, 4]);
      ctx.beginPath();
      if (isH) { ctx.moveTo(x0, Y(l.y)); ctx.lineTo(x1, Y(l.y)); } else { ctx.moveTo(X(l.x), y0); ctx.lineTo(X(l.x), y1); }
      ctx.stroke(); ctx.setLineDash([]);
      if (l.label) {
        ctx.fillStyle = Deck.color(l.color || 'muted'); ctx.font = Deck.font(11, true);
        if (isH) { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(l.label, x1 - 4, Y(l.y) - 3); }
        else { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(l.label, X(l.x) + 4, y0 + 2); }
      }
    }
    (o.hlines || []).forEach(l => guide(true, l));
    (o.vlines || []).forEach(l => guide(false, l));
    (o.series || []).forEach(s => {
      let pts = s.pts;
      if (!pts && s.f) {
        const n = s.n || 500; pts = [];
        for (let i = 0; i <= n; i++) {
          const xv = lx ? Math.pow(10, xa + (xb - xa) * i / n) : o.x[0] + (o.x[1] - o.x[0]) * i / n;
          pts.push([xv, s.f(xv)]);
        }
      }
      if (!pts || !pts.length) return;
      ctx.strokeStyle = Deck.color(s.color || 'acc'); ctx.lineWidth = s.width || 2.4; ctx.setLineDash(s.dash || []);
      ctx.lineJoin = 'round';
      if (s.bars) {
        ctx.fillStyle = Deck.alpha(s.color || 'blu', s.alpha || .55);
        const bw = s.bw || ((pts.length > 1 ? (pts[1][0] - pts[0][0]) : 1));
        pts.forEach(p => { const a = X(p[0] - bw / 2), b = X(p[0] + bw / 2); ctx.fillRect(a + 1, Y(p[1]), b - a - 2, Y(o.y[0] < 0 ? 0 : o.y[0]) - Y(p[1])); });
        return;
      }
      if (s.stem) {
        pts.forEach(p => { ctx.beginPath(); ctx.moveTo(X(p[0]), Y(0)); ctx.lineTo(X(p[0]), Y(p[1])); ctx.stroke(); ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 3.2, 0, 7); ctx.fillStyle = Deck.color(s.color || 'acc'); ctx.fill(); });
        return;
      }
      if (!s.dotsOnly) {
        ctx.beginPath(); let pen = false;
        pts.forEach(p => {
          const ok = isFinite(p[1]) && !(ly && p[1] <= 0);
          if (!ok) { pen = false; return; }
          const px = X(p[0]), py = Y(p[1]);
          if (!pen) { ctx.moveTo(px, py); pen = true; } else if (s.steps) { ctx.lineTo(px, ctx._lastY || py); ctx.lineTo(px, py); } else ctx.lineTo(px, py);
          ctx._lastY = py;
        });
        ctx.stroke();
        if (s.fill) { ctx.lineTo(X(pts[pts.length - 1][0]), Y(o.y[0])); ctx.lineTo(X(pts[0][0]), Y(o.y[0])); ctx.closePath(); ctx.fillStyle = Deck.alpha(s.color || 'acc', .12); ctx.fill(); }
      }
      if (s.dots || s.dotsOnly) { ctx.fillStyle = Deck.color(s.color || 'acc'); pts.forEach(p => { ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), s.r || 3, 0, 7); ctx.fill(); }); }
      ctx.setLineDash([]);
    });
    (o.points || []).forEach(p => {
      ctx.fillStyle = Deck.color(p.color || 'acc');
      ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), p.r || 5, 0, 7); ctx.fill();
      if (p.label) { ctx.font = Deck.font(11.5, true); ctx.textAlign = p.align || 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(p.label, X(p.x) + (p.align === 'right' ? -8 : 8), Y(p.y) - 6); }
    });
    ctx.restore();
    return { ctx, X, Y, invX, invY, W, H, box: { x0, x1, y0, y1 } };
  };

  /* ---------- controls ---------- */
  // Deck.controls(root, onChange): every input/select with data-key; outputs output[data-for=key]
  // data-fmt="2" -> decimals, data-unit=" s", data-scale="log" maps slider 0..1000 to log range data-min..data-max
  Deck.controls = function (root, onChange) {
    if (typeof root === 'string') root = document.getElementById(root);
    const inputs = Array.from(root.querySelectorAll('[data-key]'));
    function val(el) {
      if (el.type === 'checkbox') return el.checked;
      if (el.tagName === 'SELECT') return isNaN(+el.value) ? el.value : +el.value;
      if (el.dataset.scale === 'log') {
        const a = Math.log10(+el.dataset.min), b = Math.log10(+el.dataset.max);
        return Math.pow(10, a + (b - a) * (+el.value) / (+el.max || 1000));
      }
      return +el.value;
    }
    function get() {
      const v = {};
      inputs.forEach(el => { v[el.dataset.key] = val(el); });
      return v;
    }
    function show() {
      inputs.forEach(el => {
        const out = root.querySelector('output[data-for="' + el.dataset.key + '"]');
        if (!out) return;
        const v = val(el);
        if (typeof v === 'number') {
          const d = el.dataset.fmt !== undefined ? +el.dataset.fmt : 2;
          out.textContent = (d === -1 ? +v.toPrecision(3) : v.toFixed(d)) + (el.dataset.unit || '');
        } else out.textContent = String(v);
      });
    }
    inputs.forEach(el => el.addEventListener('input', () => { show(); onChange && onChange(get()); }));
    show();
    return get;
  };

  /* ---------- slide hooks ---------- */
  // Deck.onShow(id, setup): setup(sectionEl) runs once when slide first shown; may return redraw()
  Deck.onShow = function (id, setup) { hooks[id] = { setup, redraw: null, done: false }; };
  // Deck.loop(id, fn(dt, t)): runs every animation frame while the slide is active
  Deck.loop = function (id, fn) { (loops[id] = loops[id] || []).push(fn); };
  Deck.redraw = function () { const s = slides[cur]; if (!s) return; const h = hooks[s.id]; if (h && h.redraw) h.redraw(); };

  function runHook(s) {
    const h = hooks[s.id]; if (!h) return;
    if (!h.done) { h.done = true; try { const r = h.setup(s); if (typeof r === 'function') { h.redraw = r; r(); } } catch (e) { console.error(e); } }
    else if (h.redraw) h.redraw();
  }
  function tick(t) {
    const s = slides[cur];
    const fns = s && loops[s.id];
    if (fns && fns.length) {
      const dt = lastT ? Math.min(.05, (t - lastT) / 1000) : 0; lastT = t;
      fns.forEach(f => { try { f(dt, t / 1000); } catch (e) { console.error(e); } });
      rafId = requestAnimationFrame(tick);
    } else { rafId = 0; lastT = 0; }
  }

  /* ---------- navigation ---------- */
  function go(i, fromHash) {
    i = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((s, k) => s.classList.toggle('active', k === i));
    cur = i;
    slides[i].scrollTop = 0;
    const n = slides.length;
    document.querySelector('.count').textContent = String(i + 1).padStart(2, '0') + ' / ' + String(n).padStart(2, '0');
    document.querySelector('.progress i').style.width = ((i + 1) / n * 100) + '%';
    document.getElementById('prevBtn').disabled = i === 0;
    document.getElementById('nextBtn').disabled = i === n - 1;
    if (!fromHash) { try { history.replaceState(null, '', '#s' + (i + 1)); } catch (e) {} }
    store.set('deck:' + location.pathname, String(i));
    runHook(slides[i]);
    if (!rafId) { lastT = 0; rafId = requestAnimationFrame(tick); }
  }
  Deck.go = go;
  Deck.next = () => go(cur + 1);
  Deck.prev = () => go(cur - 1);

  function buildChrome() {
    const meta = window.DECK || {};
    const home = meta.home || 'index.html';
    const top = document.createElement('header');
    top.className = 'topbar';
    top.innerHTML = '<a class="home" href="' + home + '">&larr; All sessions</a><span class="dtitle"></span><span class="count"></span>' +
      '<button class="btn" id="ovBtn" type="button" title="All slides (O)">Slides</button>';
    top.querySelector('.dtitle').textContent = (meta.num ? String(meta.num).padStart(2, '0') + '  ' : '') + (meta.title || document.title);
    const prog = document.createElement('div'); prog.className = 'progress'; prog.innerHTML = '<i></i>';
    const nav = document.createElement('footer'); nav.className = 'navbar';
    nav.innerHTML = '<button class="btn" id="prevBtn" type="button">&larr; Back</button>' +
      '<span class="hint">&larr; &rarr; keys or swipe &middot; O for slide list</span>' +
      '<button class="btn primary" id="nextBtn" type="button">Next &rarr;</button>';
    const ov = document.createElement('div'); ov.className = 'overview'; ov.hidden = true;
    ov.innerHTML = '<div class="ov-inner"><div class="row" style="justify-content:space-between"><h2>Slides</h2><button class="btn" id="ovClose" type="button">Close</button></div><ol></ol></div>';
    document.body.prepend(top, prog);
    document.body.append(nav, ov);
    const ol = ov.querySelector('ol');
    slides.forEach((s, k) => {
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button';
      const h = s.querySelector('h1,h2');
      b.innerHTML = '<span>' + String(k + 1).padStart(2, '0') + '</span><div></div>';
      b.querySelector('div').textContent = s.dataset.title || (h ? h.textContent : 'Slide ' + (k + 1));
      b.addEventListener('click', () => { ov.hidden = true; go(k); });
      li.appendChild(b); ol.appendChild(li);
    });
    function toggleOv() {
      ov.hidden = !ov.hidden;
      ol.querySelectorAll('button').forEach((b, k) => b.classList.toggle('cur', k === cur));
      if (!ov.hidden) { const c = ol.querySelector('.cur'); c && c.focus(); }
    }
    document.getElementById('ovBtn').addEventListener('click', toggleOv);
    document.getElementById('ovClose').addEventListener('click', toggleOv);
    document.getElementById('prevBtn').addEventListener('click', Deck.prev);
    document.getElementById('nextBtn').addEventListener('click', Deck.next);
    document.addEventListener('keydown', e => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'o' || e.key === 'O') { toggleOv(); e.preventDefault(); return; }
      if (e.key === 'Escape' && !ov.hidden) { toggleOv(); return; }
      if (!ov.hidden) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { Deck.next(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { Deck.prev(); e.preventDefault(); }
      else if (e.key === 'Home') { go(0); e.preventDefault(); }
      else if (e.key === 'End') { go(slides.length - 1); e.preventDefault(); }
    });
    // swipe
    let sx = 0, sy = 0, st = 0, ok = false;
    const stage = document.querySelector('.stage');
    stage.addEventListener('touchstart', e => {
      const t = e.target;
      ok = !(t.closest && t.closest('canvas,input,select,.tbl,.eq,button'));
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    }, { passive: true });
    stage.addEventListener('touchend', e => {
      if (!ok) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - st < 700) dx < 0 ? Deck.next() : Deck.prev();
    }, { passive: true });
  }

  /* ---------- widgets ---------- */
  function initSteps() {
    document.querySelectorAll('ol.steps').forEach(ol => {
      const items = Array.from(ol.children);
      if (items.length < 2 || ol.dataset.open !== undefined) return;
      items.forEach((li, k) => { if (k > 0) li.classList.add('hidden'); });
      const bar = document.createElement('div'); bar.className = 'steps-ctl';
      bar.innerHTML = '<button class="btn primary" type="button">Show next step</button><button class="btn" type="button">Show all</button>';
      const [nx, all] = bar.querySelectorAll('button');
      function upd() { const left = ol.querySelectorAll('li.hidden').length; nx.disabled = !left; all.disabled = !left; nx.textContent = left ? 'Show next step (' + left + ' left)' : 'All steps shown'; }
      nx.addEventListener('click', () => { const h = ol.querySelector('li.hidden'); if (h) h.classList.remove('hidden'); upd(); });
      all.addEventListener('click', () => { ol.querySelectorAll('li.hidden').forEach(l => l.classList.remove('hidden')); upd(); });
      ol.after(bar); upd();
    });
  }
  function initReveals() {
    document.querySelectorAll('.reveal-box').forEach(box => {
      let b = box.querySelector(':scope > .reveal-btn');
      if (!b) { b = document.createElement('button'); b.className = 'btn reveal-btn'; b.type = 'button'; b.textContent = box.dataset.label || 'Reveal answer'; box.insertBefore(b, box.querySelector('.answer')); }
      const label = b.textContent;
      b.addEventListener('click', () => { box.classList.toggle('open'); b.textContent = box.classList.contains('open') ? 'Hide' : label; });
    });
  }
  function initQuizzes() {
    document.querySelectorAll('.quiz').forEach(q => {
      const correct = +q.dataset.correct;
      const opts = Array.from(q.querySelectorAll('.opt'));
      let fb = q.querySelector('.fb');
      if (!fb) { fb = document.createElement('div'); fb.className = 'fb'; q.appendChild(fb); }
      opts.forEach((o, k) => {
        o.type = 'button';
        o.addEventListener('click', () => {
          const right = k === correct;
          o.classList.add(right ? 'right' : 'wrong');
          fb.className = 'fb show ' + (right ? 'ok' : 'no');
          const why = o.dataset.why || (right ? q.dataset.explain : '') || '';
          fb.innerHTML = '<b>' + (right ? 'Correct.' : 'Not quite. Try another option.') + '</b>';
          if (why) { const s = document.createElement('span'); s.innerHTML = why; fb.appendChild(s); }
          if (right) { opts.forEach(x => x.disabled = true); }
          if (window.MathJax && MathJax.typesetPromise) MathJax.typesetPromise([fb]).catch(() => {});
        });
      });
    });
  }

  function init() {
    const main = document.querySelector('main.deck') || document.body;
    slides = Array.from(main.querySelectorAll(':scope > section.slide'));
    const stage = document.createElement('div'); stage.className = 'stage';
    main.parentNode.insertBefore(stage, main);
    slides.forEach((s, k) => {
      if (!s.id) s.id = 's' + (k + 1) + '-auto';
      if (!s.querySelector(':scope > .inner')) {
        const inner = document.createElement('div'); inner.className = 'inner';
        while (s.firstChild) inner.appendChild(s.firstChild);
        s.appendChild(inner);
      }
      stage.appendChild(s);
    });
    main.remove();
    buildChrome();
    initSteps(); initReveals(); initQuizzes();
    let start = 0;
    const m = /^#s(\d+)$/.exec(location.hash);
    if (m) start = +m[1] - 1;
    else { const saved = +store.get('deck:' + location.pathname); if (saved > 0 && saved < slides.length) start = saved; }
    go(start, true);
    window.addEventListener('hashchange', () => { const m2 = /^#s(\d+)$/.exec(location.hash); if (m2 && +m2[1] - 1 !== cur) go(+m2[1] - 1, true); });
    let rz = 0;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(Deck.redraw, 120); });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', () => setTimeout(Deck.redraw, 30));
    new MutationObserver(() => setTimeout(Deck.redraw, 30)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => Deck.redraw());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
