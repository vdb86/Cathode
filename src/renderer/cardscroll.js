// SPDX-License-Identifier: GPL-3.0-or-later
// Card title autoscroll (Interface > Card text autoscroll). When on, card
// titles are single-line (CSS: body.card-autoscroll); on focus, if the title
// overflows its box, scroll it end-to-end and back on a loop. nav.js calls
// window.CardScroll.onFocus()/clear() as focus moves between cards.
// Extracted from app.js (renderer ES-module split, s93). Imported for its side
// effect (the window.CardScroll assignment) by app.js.

const CardScroll = (function () {
  let raf = 0, cur = null;
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (cur) { cur.scrollLeft = 0; cur = null; }
  }
  function onFocus(card) {
    stop();
    if (!document.body.classList.contains('card-autoscroll')) return;
    const t = card && card.querySelector('.title');
    if (!t) return;
    const overflow = t.scrollWidth - t.clientWidth;
    if (overflow <= 4) return; // fits -- nothing to scroll
    cur = t;
    const speed = 40;   // px per second
    const pause = 1200; // ms hold at each end
    const dur = (overflow / speed) * 1000;
    const start = performance.now();
    function frame(now) {
      if (cur !== t) return; // focus moved away
      const cycle = 2 * pause + 2 * dur;
      const p = (now - start) % cycle;
      let x;
      if (p < pause) x = 0;
      else if (p < pause + dur) x = ((p - pause) / dur) * overflow;
      else if (p < 2 * pause + dur) x = overflow;
      else x = overflow - ((p - 2 * pause - dur) / dur) * overflow;
      t.scrollLeft = x;
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
  }
  return { onFocus, clear: stop };
})();

window.CardScroll = CardScroll;
