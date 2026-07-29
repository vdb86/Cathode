// SPDX-License-Identifier: GPL-3.0-or-later
// Spatial navigation for the TV UI - our own geometry-based engine, vanilla,
// no framework and no build step.
//
// Within the content area, focus moves to the nearest focusable element in
// the pressed direction, scored from each element's on-screen rectangle
// (getBoundingClientRect): primary-axis distance + a cross-axis misalignment
// penalty, with a perpendicular-overlap gate so vertical moves stay in a
// column and horizontal moves stay in a row. This handles the flat grid, the
// ragged last row, and the shelf rows with one algorithm, and extends to
// future screens (settings, transport bar, on-screen keyboard) by marking
// their items `.card`/`.focusable`.
//
// The rail <-> content transition is kept as an explicit rule rather than
// pure geometry: the rail is a short list pinned top-left, so a card lower in
// the viewport has no rail item at its height to "aim" at. Right from the
// rail enters the content; left from the content's left edge returns to the
// rail. Simple and bulletproof.
//
// We evaluated Norigin's spatial-navigation library instead of growing this,
// but it is React-only and would force a build step + a full renderer rewrite
// (see MEMORY, session 19). Public API is unchanged from the old index-based
// nav, so app.js needs no changes.

const Nav = (function () {
  let contentMode = 'grid';   // 'grid' | 'shelves' - which content container is live
  let focusedEl = null;
  let lastRailEl = null;      // remember the rail choice across content trips
  let lastContentEl = null;   // remember the content item we left, to restore on Right
  let lastApplyAt = 0;

  const q = (s) => Array.from(document.querySelectorAll(s));
  const railEls = () => q('.rail-item');
  const contentBox = () => document.getElementById(contentMode === 'shelves' ? 'shelves' : 'grid');
  const contentCards = () => Array.from(contentBox().querySelectorAll('.card, .focusable'));

  const isRail = (el) => !!(el && el.classList && el.classList.contains('rail-item'));
  const rect = (el) => el.getBoundingClientRect();
  const visible = (r) => r.width > 0 || r.height > 0;

  function clearFocus() {
    q('.rail-item.focused, .card.focused, .focusable.focused').forEach((el) => el.classList.remove('focused'));
    if (window.CardScroll) window.CardScroll.clear(); // stop any focused-title marquee
  }

  function scrollTo(el) {
    // Held-direction auto-repeat outruns smooth-scroll animations; snap
    // instantly during rapid movement, animate only single presses.
    // 'instant' (not 'auto') is required - 'auto' defers to CSS
    // scroll-behavior and gets smoothed again.
    const now = performance.now();
    const behavior = now - lastApplyAt < 250 ? 'instant' : 'smooth';
    lastApplyAt = now;
    const opts = { block: 'center', behavior };
    if (el.closest && el.closest('.shelf-strip')) opts.inline = 'center'; // track the row horizontally
    el.scrollIntoView(opts);
  }

  function focusEl(el) {
    if (!el) return;
    clearFocus();
    focusedEl = el;
    if (isRail(el)) lastRailEl = el;
    else lastContentEl = el;
    el.classList.add('focused');
    scrollTo(el);
    if (!isRail(el) && window.CardScroll) window.CardScroll.onFocus(el); // card-title autoscroll
  }

  function defaultEl() {
    return document.querySelector('.rail-item[data-section="home"]') || railEls()[0] || null;
  }

  function apply() {
    if (!focusedEl || !focusedEl.isConnected || !visible(rect(focusedEl))) {
      focusEl(defaultEl());
      return;
    }
    clearFocus();
    focusedEl.classList.add('focused');
    scrollTo(focusedEl);
    if (!isRail(focusedEl) && window.CardScroll) window.CardScroll.onFocus(focusedEl);
  }

  // Nearest element in `pool` in direction `dir`, scored by primary-axis
  // distance + cross-axis misalignment. `overlapAxis` ('x'|'y'), when given,
  // requires the candidate to overlap the source on that axis - keeps
  // vertical moves in a column and horizontal moves in a row.
  function pickBest(from, dir, pool, overlapAxis) {
    const fr = rect(from);
    const cx = fr.left + fr.width / 2;
    const cy = fr.top + fr.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of pool) {
      if (el === from) continue;
      const r = rect(el);
      if (!visible(r)) continue;
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height / 2;
      const dx = ex - cx, dy = ey - cy;
      let primary, cross;
      if (dir === 'left')       { if (dx >= -1) continue; primary = -dx; cross = Math.abs(dy); }
      else if (dir === 'right') { if (dx <= 1)  continue; primary =  dx; cross = Math.abs(dy); }
      else if (dir === 'up')    { if (dy >= -1) continue; primary = -dy; cross = Math.abs(dx); }
      else                      { if (dy <= 1)  continue; primary =  dy; cross = Math.abs(dx); }
      if (overlapAxis === 'x' && !(r.left < fr.right && fr.left < r.right)) continue;
      if (overlapAxis === 'y' && !(r.top < fr.bottom && fr.top < r.bottom)) continue;
      const score = primary + cross * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  // Enter the content area from the rail. Two behaviours:
  //  'nearest' (arrow Right) -> the card geometrically closest to the rail
  //            selection, so nudging Right off the rail lands on a nearby item
  //            (used when the user drifts onto the rail and wants back).
  //  'first'  (Enter/select on a section) -> the first (top-left) item, so
  //            opening a section starts you at the top of its list.
  function enterContent(mode) {
    const cards = contentCards();
    if (!cards.length) return;
    if (mode === 'nearest') {
      // Right arrow from the rail: go back to the exact item we were on before
      // stepping onto the rail, if it's still in the current content; otherwise
      // the geometrically nearest item; otherwise the first.
      if (lastContentEl && lastContentEl.isConnected && visible(rect(lastContentEl)) && cards.indexOf(lastContentEl) !== -1) {
        focusEl(lastContentEl);
        return;
      }
      if (focusedEl && isRail(focusedEl)) { focusEl(pickBest(focusedEl, 'right', cards) || cards[0]); return; }
    }
    focusEl(cards[0]);
  }

  // Jump focus to the first (top-left) content item -- used by app.js after a
  // rail section is selected (Enter), so selecting a menu item moves the
  // selector into the list rather than leaving it on the rail.
  function enterFirst() {
    const cards = contentCards();
    if (cards.length) focusEl(cards[0]);
  }

  // Focus a specific content element (used by app.js to restore focus, e.g. to
  // the playlist card you came back from). Ignores non-content elements.
  function focusElement(el) {
    if (el && el.classList && (el.classList.contains('card') || el.classList.contains('focusable'))) focusEl(el);
  }

  function move(dir) {
    if (!focusedEl || !focusedEl.isConnected) { apply(); return; }

    if (isRail(focusedEl)) {
      if (dir === 'up' || dir === 'down') {
        let target = pickBest(focusedEl, dir, railEls());
        if (!target) {
          // Wrap around at the ends: Up on the first item -> last, Down on the
          // last -> first. railEls() is in top-to-bottom DOM order.
          const rails = railEls().filter((el) => visible(rect(el)));
          if (rails.length) target = (dir === 'down') ? rails[0] : rails[rails.length - 1];
        }
        if (target) focusEl(target);
      } else if (dir === 'right') {
        enterContent('nearest');
      }
      // left on the rail: nothing
      return;
    }

    // in content
    const cards = contentCards();
    if (dir === 'left') {
      const target = pickBest(focusedEl, 'left', cards, 'y');
      if (target) focusEl(target);
      else enterRailNearest(); // at the content's left edge → the rail item nearest by height
      return;
    }
    const overlapAxis = (dir === 'up' || dir === 'down') ? 'x' : 'y';
    const target = pickBest(focusedEl, dir, cards, overlapAxis);
    if (target) focusEl(target);
    // no target = screen edge in that direction; stay put
  }

  function current() { return focusedEl; }

  function focusRail() {
    focusEl((lastRailEl && lastRailEl.isConnected) ? lastRailEl : defaultEl());
  }

  // Left arrow off the content's left edge: land on the VISIBLE rail item whose
  // vertical centre is nearest the current item (spatial), rather than the last
  // rail item used. (Back/ESC still restores the last rail item via focusRail.)
  function enterRailNearest() {
    const rails = railEls().filter((el) => visible(rect(el)));
    if (!rails.length) return focusRail();
    const from = focusedEl;
    if (!from || !from.isConnected) return focusEl(rails[0]);
    const fy = rect(from).top + rect(from).height / 2;
    let best = rails[0], bestD = Infinity;
    for (const el of rails) {
      const r = rect(el);
      const d = Math.abs((r.top + r.height / 2) - fy);
      if (d < bestD) { bestD = d; best = el; }
    }
    focusEl(best);
  }

  function setLayout(mode) { contentMode = (mode === 'shelves') ? 'shelves' : 'grid'; }

  // New feed rendered: if focus was in the content area, drop it onto the
  // first card of the fresh content; if it was on the rail, leave it there.
  function resetContent() {
    if (isRail(focusedEl)) return;
    focusedEl = contentCards()[0] || null;
  }

  // Load-more heuristic: is the selector near the end of the loaded content?
  function nearEnd() {
    if (isRail(focusedEl) || !focusedEl) return false;
    if (contentMode === 'grid') {
      const cards = contentCards();
      const idx = cards.indexOf(focusedEl);
      return idx >= 0 && idx >= cards.length - 12; // ~3 rows from the bottom
    }
    // shelves: fire when focus is within the last few rows, so the next
    // batch starts fetching before the user reaches the very bottom.
    const rows = Array.from(document.querySelectorAll('#shelves .shelf'));
    const row = focusedEl.closest && focusedEl.closest('.shelf');
    const ri = row ? rows.indexOf(row) : -1;
    return ri >= 0 && ri >= rows.length - 3;
  }

  // True when focus is the LAST card of its shelf row (right edge of a
  // category strip) -- the cue for horizontal within-row load-more.
  function atRowEnd() {
    if (contentMode !== 'shelves' || !focusedEl) return false;
    const strip = focusedEl.closest && focusedEl.closest('.shelf-strip');
    if (!strip) return false;
    const cards = Array.from(strip.querySelectorAll('.card'));
    return cards.length > 0 && cards[cards.length - 1] === focusedEl;
  }

  return {
    move, apply, current, focusRail, setLayout, resetContent, nearEnd, atRowEnd, enterFirst, focusElement,
    get zone() { return isRail(focusedEl) ? 'rail' : contentMode; },
    get mode() { return contentMode; }
  };
})();
