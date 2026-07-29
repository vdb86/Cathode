// SPDX-License-Identifier: GPL-3.0-or-later
// Gamepad + keyboard -> app events.
// Polls the Gamepad API and listens to the keyboard, dispatching 'tvinput'
// CustomEvents:
//   detail.action in up | down | left | right | select | back | play | ff | rw | longpress
// Standard mapping (Xbox): 0=A 1=B 2=X 3=Y 4=LB 5=RB 6=LT 7=RT 8=View 9=Menu
// 12-15 = dpad up/down/left/right. Axes 0/1 = left stick.
//
// Input remapping (Settings > Controls): the button->action and key->action
// tables are DATA, loaded from ui_settings.json (padBinds / keyBinds) and
// merged over the defaults below. Each action can hold MULTIPLE buttons/keys.
// window.TVInput exposes the current binds + a capture API the Controls
// settings UI uses to rebind. Only the OK button stays FIXED and NOT
// rebindable: its tap=select / hold=longpress (gamepad button 0 / keyboard
// Enter). The analog stick always drives up/down/left/right regardless of the
// button binds. 'longpress' opens the video context menu and 'fullscreen'
// (default keyboard F11 / controller View) toggles fullscreen; both ARE
// rebindable, separate from the fixed OK-hold.

(function () {
  const REPEAT_DELAY = 400;  // ms before auto-repeat on held direction
  const REPEAT_RATE = 120;   // ms between repeats
  const AXIS_THRESHOLD = 0.6;
  const LONGPRESS = 500;     // ms hold on A/OK to open the context menu

  // Rebindable actions. OK/select stays fixed (button 0 / Enter). 'longpress'
  // (context menu) is exposed here so it can be bound to a dedicated button/key;
  // the OK-hold gesture that also opens it stays fixed and is not listed.
  const REBINDABLE = ['up', 'down', 'left', 'right', 'back', 'play', 'longpress', 'rw', 'ff', 'fullscreen'];
  const ACTION_LABELS = {
    up: 'Up', down: 'Down', left: 'Left', right: 'Right', back: 'Back',
    play: 'Play / Pause', longpress: 'Context menu', rw: 'Rewind', ff: 'Fast-forward',
    fullscreen: 'Fullscreen'
  };

  // Default button-index -> action and key -> action tables. Values are arrays
  // so an action can be triggered by several buttons/keys.
  const PAD_DEFAULTS = {
    up: [12], down: [13], left: [14], right: [15],
    back: [1], play: [2, 9], longpress: [3], rw: [4, 6], ff: [5, 7], fullscreen: [8]
  };
  const KEY_DEFAULTS = {
    up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
    back: ['Escape', 'Backspace'], play: [' '], longpress: ['c'], rw: [','], ff: ['.'], fullscreen: ['F11']
  };

  // Human-readable controller button names (Xbox layout) for the bind UI.
  const PAD_NAMES = {
    0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
    8: 'View', 9: 'Menu', 10: 'LS', 11: 'RS', 12: 'D-Up', 13: 'D-Down',
    14: 'D-Left', 15: 'D-Right', 16: 'Guide'
  };

  let padBinds = clone(PAD_DEFAULTS);
  let keyBinds = clone(KEY_DEFAULTS);
  let keyToAction = {};      // reverse lookup, rebuilt from keyBinds
  let capture = null;        // active bind capture: { device:'pad'|'key', cb, base? }

  const state = {}; // action -> { pressed, since, lastRepeat }

  function clone(o) { const r = {}; for (const k in o) r[k] = o[k].slice(); return r; }

  function mergeBinds(defaults, saved) {
    const out = {};
    for (const a in defaults) {
      out[a] = (saved && Array.isArray(saved[a])) ? saved[a].slice() : defaults[a].slice();
    }
    return out;
  }

  function rebuildKeyLookup() {
    keyToAction = {};
    for (const a in keyBinds) for (const k of keyBinds[a]) keyToAction[k] = a;
  }

  async function loadBinds() {
    try {
      const ui = (window.tv && window.tv.getUiSettings) ? (await window.tv.getUiSettings()) || {} : {};
      padBinds = mergeBinds(PAD_DEFAULTS, ui.padBinds);
      keyBinds = mergeBinds(KEY_DEFAULTS, ui.keyBinds);
    } catch { padBinds = clone(PAD_DEFAULTS); keyBinds = clone(KEY_DEFAULTS); }
    rebuildKeyLookup();
  }

  function prettyKey(k) {
    const map = { ' ': 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' };
    if (map[k]) return map[k];
    return (k && k.length === 1) ? k.toUpperCase() : k;
  }

  function fire(action) {
    window.dispatchEvent(new CustomEvent('tvinput', { detail: { action } }));
  }

  function handle(action, pressed, now) {
    const s = state[action] || (state[action] = { pressed: false, since: 0, lastRepeat: 0 });
    const repeatable = ['up', 'down', 'left', 'right', 'ff', 'rw'].includes(action);

    if (pressed && !s.pressed) {
      s.pressed = true;
      s.since = now;
      s.lastRepeat = now;
      fire(action);
    } else if (pressed && s.pressed && repeatable) {
      if (now - s.since > REPEAT_DELAY && now - s.lastRepeat > REPEAT_RATE) {
        s.lastRepeat = now;
        fire(action);
      }
    } else if (!pressed && s.pressed) {
      s.pressed = false;
    }
  }

  // A / OK button: a short tap fires 'select'; holding past LONGPRESS fires
  // 'longpress' (opens the video context menu) and suppresses the tap. FIXED.
  const sel = { pressed: false, since: 0, longFired: false };
  function trackSelect(pressed, now) {
    if (pressed && !sel.pressed) { sel.pressed = true; sel.since = now; sel.longFired = false; }
    else if (pressed && sel.pressed && !sel.longFired && now - sel.since > LONGPRESS) { sel.longFired = true; fire('longpress'); }
    else if (!pressed && sel.pressed) { sel.pressed = false; if (!sel.longFired) fire('select'); }
  }

  // While a bind capture is active, watch for the first FRESH button press and
  // report its index. Button 0 (A) is ignored (it opened the popup / is the
  // fixed OK). Button 1 (B) cancels. A button counts as "fresh" only after it
  // has been seen released, so the A press that opened the popup can't leak in.
  function handlePadCapture(pad, b) {
    if (!capture.base) capture.base = pad.buttons.map((x) => !!(x && x.pressed));
    for (let i = 0; i < pad.buttons.length; i++) {
      const p = b(i);
      if (!p) { capture.base[i] = false; continue; }
      if (capture.base[i]) continue;      // still held from before -> not fresh
      if (i === 0) { capture.base[i] = true; continue; } // ignore A (fixed OK)
      const cb = capture.cb; capture = null;
      if (i === 1) return cb(null);        // B cancels
      return cb(i);
    }
  }

  function poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const now = performance.now();

    for (const pad of pads) {
      if (!pad || !pad.connected) continue;

      const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);

      // While capturing, watch the pad but suppress all normal dispatch so the
      // settings selector doesn't move under the capture popup.
      if (capture) {
        if (capture.device === 'pad') handlePadCapture(pad, b);
        break;
      }

      // Analog stick always drives the four directions.
      const axis = {
        up: pad.axes[1] < -AXIS_THRESHOLD,
        down: pad.axes[1] > AXIS_THRESHOLD,
        left: pad.axes[0] < -AXIS_THRESHOLD,
        right: pad.axes[0] > AXIS_THRESHOLD
      };

      for (const action of REBINDABLE) {
        const idxs = padBinds[action] || [];
        const pressed = idxs.some((i) => b(i)) || !!axis[action];
        handle(action, pressed, now);
      }

      trackSelect(b(0), now); // A: tap = select, hold = longpress (FIXED)

      break; // first connected pad wins
    }

    requestAnimationFrame(poll);
  }

  window.addEventListener('gamepadconnected', (e) => {
    console.log('Gamepad connected:', e.gamepad.id);
  });

  loadBinds();
  requestAnimationFrame(poll);

  // Keyboard fallback so the app is fully usable without a controller.
  let enterHeld = false, enterLong = false, enterTimer = null;
  const NAV_IN_INPUT = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  window.addEventListener('keydown', (e) => {
    // Bind capture (Settings > Controls): swallow normal dispatch. Escape always
    // cancels (even a controller-bind capture, so a keyboard user with no pad
    // connected can back out). For a KEY capture, grab the raw key; Enter is
    // reserved (fixed OK) so it can't be bound.
    if (capture) {
      e.preventDefault();
      if (e.key === 'Escape') { const cb = capture.cb; capture = null; return cb(null); }
      if (capture.device === 'key') {
        if (e.repeat) return;
        if (e.key === 'Enter') return; // reserved
        const cb = capture.cb; capture = null;
        return cb(e.key);
      }
      return; // pad capture: swallow other keys
    }

    // While typing in the search box: Escape cancels, Enter presses the
    // highlighted on-screen key (same as the controller's A / OK -- navigate to
    // the 'Search' key to run the query), and the arrow keys move the on-screen
    // keyboard selection. Letter/Backspace keys fall through to edit the field
    // directly, so a physical keyboard can also just type. (These stay fixed so
    // rebinding directions to letters never breaks typing in the field.)
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      if (e.key === 'Escape') { fire('back'); return; }
      if (e.key === 'Enter') { e.preventDefault(); fire('select'); return; }
      if (NAV_IN_INPUT[e.key]) { e.preventDefault(); fire(NAV_IN_INPUT[e.key]); return; }
      return;
    }
    // Enter (outside a text field): tap = select, hold >LONGPRESS = longpress
    // (opens the context menu) -- mirrors the controller's A button. Fire on
    // keyup to distinguish tap from hold; ignore OS auto-repeat. FIXED.
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      if (!enterHeld) {
        enterHeld = true; enterLong = false;
        enterTimer = setTimeout(() => { enterLong = true; fire('longpress'); }, LONGPRESS);
      }
      return;
    }
    // Everything (incl. fullscreen = F11 and the context menu = 'c') now routes
    // through the rebindable key table.
    const action = keyToAction[e.key];
    if (action) {
      e.preventDefault();
      fire(action);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Enter') return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return; // input Enter handled on keydown
    clearTimeout(enterTimer);
    if (enterHeld && !enterLong) fire('select');
    enterHeld = false; enterLong = false;
  });

  // ---- public API for the Controls settings screen ----
  window.TVInput = {
    reload: () => loadBinds(),   // re-read binds (e.g. after an account switch repoints ui_settings)
    rebindable: () => REBINDABLE.slice(),
    actionLabel: (a) => ACTION_LABELS[a] || a,
    labelForPad: (action) => {
      const idxs = padBinds[action] || [];
      return idxs.length ? idxs.map((i) => PAD_NAMES[i] || ('Btn ' + i)).join(' / ') : 'Unset';
    },
    labelForKey: (action) => {
      const ks = keyBinds[action] || [];
      return ks.length ? ks.map(prettyKey).join(' / ') : 'Unset';
    },
    // Start listening for the next raw press on `device` ('pad'|'key').
    // cb(value) with a button index / key string, or cb(null) if cancelled.
    captureNext: (device, cb) => { capture = { device, cb, base: null }; },
    cancelCapture: () => { if (capture) { const cb = capture.cb; capture = null; cb(null); } },
    // Toggle a single binding on/off for an action (multiple allowed). Pressing
    // an input already bound to this action REMOVES it; otherwise it is ADDED
    // and removed from any OTHER action (one input drives one action). Persists
    // the whole map.
    setBind: (device, action, value) => {
      const map = device === 'pad' ? padBinds : keyBinds;
      const list = (map[action] || []).slice();
      const at = list.indexOf(value);
      if (at >= 0) {
        list.splice(at, 1);                 // toggle off
      } else {
        list.push(value);                   // add
        for (const a in map) if (a !== action) map[a] = map[a].filter((v) => v !== value);
      }
      map[action] = list;
      if (device === 'key') rebuildKeyLookup();
      if (window.tv && window.tv.setUiSettings) {
        window.tv.setUiSettings(device === 'pad' ? { padBinds } : { keyBinds }).catch(() => {});
      }
    },
    // Reset ONE action (this device only) back to its default binding(s).
    resetAction: (device, action) => {
      const defs = device === 'pad' ? PAD_DEFAULTS : KEY_DEFAULTS;
      const map = device === 'pad' ? padBinds : keyBinds;
      map[action] = (defs[action] || []).slice();
      if (device === 'key') rebuildKeyLookup();
      if (window.tv && window.tv.setUiSettings) {
        window.tv.setUiSettings(device === 'pad' ? { padBinds } : { keyBinds }).catch(() => {});
      }
    },
    resetDefaults: () => {
      padBinds = clone(PAD_DEFAULTS);
      keyBinds = clone(KEY_DEFAULTS);
      rebuildKeyLookup();
      if (window.tv && window.tv.setUiSettings) window.tv.setUiSettings({ padBinds, keyBinds }).catch(() => {});
    }
  };
})();
