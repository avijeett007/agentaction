/* AgentAction — agentaction.online
 *
 * Progressive enhancement only. The page is authored in its finished state
 * (the request open on the phone), so it reads with this file blocked.
 * Nothing here is loaded from a third party, stored, or sent anywhere.
 */
(function () {
  'use strict';

  var reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;

  /* ---- a hairline under the top bar once the page has moved ------------- */
  var topbar = document.querySelector('.topbar');
  if (topbar) {
    var mark = function () { topbar.classList.toggle('is-stuck', window.scrollY > 8); };
    mark();
    window.addEventListener('scroll', mark, { passive: true });
  }

  /* ---- the hero demo: the real request screen, which you can answer ----- */
  var demo = document.getElementById('demo');
  if (demo) {
    var phone = demo.querySelector('.phone');
    var notif = demo.querySelector('.notif');
    var outcome = demo.querySelector('.app__outcome');
    var windows = demo.querySelector('.app__windows');
    var again = demo.querySelector('.demo__again');
    var timers = [];

    // The app's own words (app/screens/RequestScreen.tsx).
    var OUTCOME = {
      approved: 'Approved. The action is running now.',
      denied: 'Denied. Nothing will run.'
    };

    var later = function (fn, ms) { timers.push(window.setTimeout(fn, ms)); };
    var clear = function () { timers.forEach(window.clearTimeout); timers = []; };
    var set = function (state) { demo.setAttribute('data-state', state); };
    var replay = function (el, cls) {
      if (!el || reduced) return;
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
    };

    var open = function () {
      clear();
      set('open');
      if (windows) windows.hidden = true;
    };

    var start = function () {
      clear();
      if (again) again.hidden = true;
      if (windows) windows.hidden = true;
      outcome.textContent = '';
      if (reduced) { open(); return; }
      set('quiet');
      later(function () { set('lock'); replay(notif, 'is-arrive'); replay(phone, 'is-buzz'); }, 1100);
      later(open, 3600);
    };

    var decide = function (state, text) {
      clear();
      outcome.textContent = text;
      set(state);
      if (again) again.hidden = false;
    };

    demo.addEventListener('click', function (event) {
      var target = event.target.closest('button');
      if (!target || !demo.contains(target)) return;
      if (target === notif) { open(); return; }
      if (target === again) { start(); return; }
      var choice = target.getAttribute('data-decide');
      if (choice === 'approved') decide('approved', OUTCOME.approved);
      else if (choice === 'denied') decide('denied', OUTCOME.denied);
      else if (choice === 'longer' && windows) { windows.hidden = !windows.hidden; target.setAttribute('aria-expanded', String(!windows.hidden)); }
      var span = target.getAttribute('data-window');
      if (span) {
        var win = demo.querySelector('.chat__win');
        if (win) win.textContent = span;
        decide('window', 'Approved, and allowed for ' + span + '.');
      }
    });

    // Play the arrival once, when the demo is first on screen.
    if ('IntersectionObserver' in window) {
      var seen = false;
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && !seen) { seen = true; start(); io.disconnect(); }
        });
      }, { threshold: 0.4 });
      io.observe(demo);
    }
  }
})();
