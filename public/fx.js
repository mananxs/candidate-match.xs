/* fx.js: motion and pointer effects for every CandidateMatch page.
   Vanilla JS, no dependencies, no build step.

   Rules this file follows:
   - It only READS what app.js / admin.js / landing.js render and ADDS animation on top.
   - It never changes data, state, routes or API calls. Delete this file and the app still works, just without motion.
   - Everything respects "prefers-reduced-motion".

   Sections: 1 helpers, 2 pointer spotlight + tilt, 3 reveal + count-up, 4 workspace pages, 5 sidebar indicator, 6 scroll reveals (landing). */
(() => {
  window.__fx = true;   // tells index.html that fx.js loaded (its 3s safety timer checks this)
  const root = document.documentElement;
  const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 1. helpers ---------- */
  const token = name => getComputedStyle(root).getPropertyValue(name).trim();
  const SPRING = token('--spring') || 'cubic-bezier(.34,1.45,.64,1)';   // same spring curve the CSS uses
  const EASE = token('--ease-out') || 'cubic-bezier(.22,1,.36,1)';

  // Web Animations API wrapper: falls back to a plain easing if the browser rejects the spring curve.
  function play(el, frames, options) {
    if (REDUCE || !el || !el.animate) return null;
    try { return el.animate(frames, options); } catch (e) { /* try again below */ }
    try { return el.animate(frames, { ...options, easing: 'ease-out' }); } catch (e) { return null; }
  }

  /* ---------- 2. pointer spotlight + 3D tilt ----------
     CSS reads --mx / --my (pointer position inside the element) and --rx / --ry (tilt).
     One delegated listener serves every card on the page, including cards that app.js re-creates. */
  const SPOT = '.card, .res, .stat, .tile, .step, .hero, .auth';
  const TILT = '.stat, .tile';
  let frame = 0;
  let lastTilted = null;

  const resetTilt = el => { if (el) { el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); } };

  document.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || !e.target.closest) return;
    const inner = e.target.closest(SPOT);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      // walk up so a card inside a card (Settings) keeps both spotlights alive
      for (let el = inner; el; el = el.parentElement && el.parentElement.closest(SPOT)) {
        const r = el.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        el.style.setProperty('--mx', x + 'px');
        el.style.setProperty('--my', y + 'px');
        if (!REDUCE && el.matches(TILT)) {
          el.style.setProperty('--ry', ((x / r.width) - 0.5) * 8 + 'deg');
          el.style.setProperty('--rx', ((y / r.height) - 0.5) * -8 + 'deg');
          if (lastTilted && lastTilted !== el) resetTilt(lastTilted);
          lastTilted = el;
        }
      }
      if (!inner) { resetTilt(lastTilted); lastTilted = null; }
    });
  }, { passive: true });
  root.addEventListener('mouseleave', () => resetTilt(lastTilted));

  /* ---------- 3. reveal + count-up ---------- */
  // Staggered spring entrance. Elements are visible by default; the animation just starts them from "hidden".
  function reveal(items, { step = 55, y = 18, base = 0 } = {}) {
    items.forEach((el, i) => play(el,
      [{ opacity: 0, transform: `translateY(${y}px) scale(.98)` }, { opacity: 1, transform: 'none' }],
      { duration: 650, delay: base + Math.min(i, 14) * step, easing: SPRING, fill: 'backwards' }));
  }

  function countUp(el) {
    const end = Number(el.textContent);
    if (REDUCE || !Number.isFinite(end) || end <= 0) return;
    const t0 = performance.now(), D = 900;
    const tick = now => {
      const p = Math.min((now - t0) / D, 1);
      el.textContent = p < 1 ? Math.round(end * (1 - Math.pow(1 - p, 3))) : end;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Score ring + bar fill from zero for a result card.
  function fillScore(card) {
    const ring = card.querySelector('.ring');
    if (ring) play(ring, [{ '--p': 0 }, { '--p': parseFloat(ring.style.getPropertyValue('--p')) || 0 }], { duration: 1100, delay: 150, easing: EASE, fill: 'backwards' });
    const bar = card.querySelector('.bar i');
    if (bar && bar.style.width) play(bar, [{ width: '0%' }, { width: bar.style.width }], { duration: 1000, delay: 250, easing: EASE, fill: 'backwards' });
  }

  /* ---------- 4. workspace + admin pages (app.js and admin.js re-render #main with innerHTML) ----------
     We animate when the PAGE changes, not on every re-render (busy spinners, checkbox clicks, ...).
     A page is identified by the active sidebar item plus the h1 text. New result cards also animate once. */
  function watchPages(main) {
    let lastPage = '';
    const seenResults = new Set();
    const resultKey = card => ['.name', '.pct', '.meta'].map(s => (card.querySelector(s) || {}).textContent).join('|');

    new MutationObserver(() => {
      const h1 = main.querySelector('h1');
      if (!h1) return;                                              // skeleton still showing
      const navOn = document.querySelector('#nav a[data-nav].on');
      const page = (navOn ? navOn.dataset.nav : '') + '|' + h1.textContent;
      const isNewPage = page !== lastPage;
      lastPage = page;

      const results = [...main.querySelectorAll('.res')];
      const freshResults = results.filter(c => !seenResults.has(resultKey(c)));
      results.forEach(c => seenResults.add(resultKey(c)));

      if (isNewPage) {
        const blocks = [];
        [...main.children].forEach(c => (c.classList.contains('stats') ? blocks.push(...c.children) : blocks.push(c)));
        reveal(blocks);
        main.querySelectorAll('.stat div').forEach(countUp);
        const rows = [...main.querySelectorAll('tbody tr')].filter(r => r.querySelector('td'));
        reveal(rows, { step: 22, y: 8, base: 280 });
        results.forEach(fillScore);
      } else if (freshResults.length) {
        reveal(freshResults, { step: 80 });
        freshResults.forEach(fillScore);
      }
    }).observe(main, { childList: true });
  }

  /* ---------- 5. sidebar indicator: one glowing bar that springs between items ---------- */
  function watchNav(nav) {
    let previousY = null;
    const place = () => {
      const links = nav.querySelector('.navlinks');
      const active = links && links.querySelector('a.on');
      if (!active || links.querySelector('.ind')) return;
      const bar = document.createElement('i');
      bar.className = 'ind';
      links.appendChild(bar);
      const y = active.offsetTop + (active.offsetHeight - 24) / 2;
      bar.style.transform = `translateY(${y}px)`;
      if (previousY !== null && previousY !== y) {
        play(bar, [{ transform: `translateY(${previousY}px) scaleY(1.7)` }, { transform: `translateY(${y}px) scaleY(1)` }], { duration: 560, easing: SPRING });
      }
      previousY = y;
    };
    new MutationObserver(place).observe(nav, { childList: true });
    place();
  }

  /* ---------- 6. scroll-triggered reveals (landing page): add data-rv to anything that should enter on scroll ---------- */
  function watchScroll() {
    const items = [...document.querySelectorAll('[data-rv]')];
    if (!items.length || REDUCE || !('IntersectionObserver' in window)) return;
    root.classList.add('fx');                                       // CSS hides [data-rv] only when JS is running
    const io = new IntersectionObserver(entries => {
      entries.filter(e => e.isIntersecting).forEach((e, i) => {
        io.unobserve(e.target);
        e.target.classList.add('in');
        reveal([e.target], { base: i * 80, y: 24 });
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    items.forEach(el => io.observe(el));
  }

  /* ---------- boot ---------- */
  const main = document.getElementById('main');
  const nav = document.getElementById('nav');
  if (main) watchPages(main);
  if (nav) watchNav(nav);
  watchScroll();
})();
