// public/responsive.js
// EcoSync — responsive behaviour layer.
//
// This file is PURELY ADDITIVE. It does not modify, wrap or override any
// existing behaviour in app.js or ecosyncAI.js: it only attaches its own
// listeners (addEventListener supports any number of independent listeners on
// the same element) and reads/writes presentation-only state. Panel
// navigation, API polling, chart data, the scheduler, the scenario simulator
// and the AI assistant all continue to run exactly as before.
//
// Responsibilities:
//   1. Mobile navigation drawer (open/close, backdrop, ESC, focus, scroll lock)
//   2. aria-current mirroring for the existing .navbtn active state
//   3. A --app-vh custom property tracking the real visual viewport height
//   4. Scroll locking + focus return for the AI chat overlay
//   5. Re-laying out charts when the drawer or a panel changes the width

(function () {
  'use strict';

  var MOBILE_NAV_QUERY = window.matchMedia('(max-width: 900px)');

  var sidebar = document.getElementById('sidebar');
  var backdrop = document.getElementById('nav-backdrop');
  var toggle = document.getElementById('nav-toggle');
  var aiOverlay = document.getElementById('ai-chat-overlay');
  var aiFab = document.getElementById('ai-fab');

  // ----------------------------------------------------------------
  // Scroll lock — reference counted, because the nav drawer and the AI
  // chat can both want it and must not clobber one another's release.
  // ----------------------------------------------------------------
  var scrollLocks = 0;
  function lockScroll() {
    scrollLocks++;
    document.body.classList.add('no-scroll');
  }
  function unlockScroll() {
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) document.body.classList.remove('no-scroll');
  }

  // ----------------------------------------------------------------
  // 1. Mobile navigation drawer
  // ----------------------------------------------------------------
  var navOpen = false;

  function openNav() {
    if (navOpen || !sidebar) return;
    navOpen = true;
    sidebar.classList.add('open');
    if (backdrop) backdrop.classList.add('open');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    lockScroll();
    // Move focus into the drawer so keyboard and screen-reader users land
    // where the menu actually is.
    var first = sidebar.querySelector('.navbtn');
    if (first) first.focus({ preventScroll: true });
  }

  function closeNav(returnFocus) {
    if (!navOpen || !sidebar) return;
    navOpen = false;
    sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      if (returnFocus) toggle.focus({ preventScroll: true });
    }
    unlockScroll();
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      if (navOpen) closeNav(true); else openNav();
    });
  }
  if (backdrop) {
    // Tapping anywhere outside the drawer closes it.
    backdrop.addEventListener('click', function () { closeNav(false); });
  }

  // Tapping a navigation item closes the drawer. This listener is separate
  // from app.js's own click handler on the same buttons, so the existing
  // data-panel switching logic is entirely untouched.
  document.querySelectorAll('.navbtn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (MOBILE_NAV_QUERY.matches) closeNav(false);
      syncNavAria();
      // The panel that just became visible may contain a canvas that was
      // never measurable while hidden — give it a chance to size itself.
      requestAnimationFrame(reflowCharts);
    });
  });

  // ESC closes the drawer. Registered on document so it works wherever focus
  // currently sits; the AI chat has its own independent ESC handler and the
  // two do not conflict (each only acts when its own surface is open).
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && navOpen) closeNav(true);
  });

  // Simple focus containment: Tab from the last item in the drawer wraps to
  // the first, so keyboard focus cannot wander behind the backdrop.
  if (sidebar) {
    sidebar.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || !navOpen) return;
      var items = sidebar.querySelectorAll('.navbtn');
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  // Rotating a phone into landscape, or resizing a desktop window past the
  // breakpoint, must not leave a half-open drawer or a locked page body.
  function onBreakpointChange(e) {
    if (!e.matches) closeNav(false);
  }
  if (typeof MOBILE_NAV_QUERY.addEventListener === 'function') {
    MOBILE_NAV_QUERY.addEventListener('change', onBreakpointChange);
  } else if (typeof MOBILE_NAV_QUERY.addListener === 'function') {
    MOBILE_NAV_QUERY.addListener(onBreakpointChange); // older Safari
  }

  // ----------------------------------------------------------------
  // 2. aria-current mirrors the existing .active class
  // ----------------------------------------------------------------
  function syncNavAria() {
    document.querySelectorAll('.navbtn').forEach(function (btn) {
      if (btn.classList.contains('active')) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
  }
  syncNavAria();

  // ----------------------------------------------------------------
  // 3. --app-vh: the real visible height, for the AI chat sheet
  // ----------------------------------------------------------------
  // 100vh on mobile Safari/Chrome measures the viewport as if the browser
  // chrome were hidden, and it does not shrink when the software keyboard
  // opens. dvh fixes this in modern browsers and is the CSS default here;
  // this keeps a matching custom property up to date for the rest.
  var vhFrame = 0;
  function setAppVh() {
    if (vhFrame) return;
    vhFrame = requestAnimationFrame(function () {
      vhFrame = 0;
      var vv = window.visualViewport;
      var h = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty('--app-vh', h + 'px');
    });
  }
  setAppVh();
  window.addEventListener('resize', setAppVh, { passive: true });
  window.addEventListener('orientationchange', setAppVh, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setAppVh, { passive: true });
  }

  // ----------------------------------------------------------------
  // 4. AI chat overlay: scroll lock + focus return
  // ----------------------------------------------------------------
  // ecosyncAI.js owns opening and closing the chat (it toggles the .open
  // class). Rather than re-implementing or patching any of that, this watches
  // the class attribute and layers the scroll lock on top — so the chat's own
  // open/close/ESC/backdrop behaviour stays exactly as written.
  if (aiOverlay && typeof MutationObserver !== 'undefined') {
    var aiWasOpen = aiOverlay.classList.contains('open');
    var lastFocused = null;

    new MutationObserver(function () {
      var isOpen = aiOverlay.classList.contains('open');
      if (isOpen === aiWasOpen) return;
      aiWasOpen = isOpen;

      if (isOpen) {
        lastFocused = document.activeElement;
        lockScroll();
        // The drawer and the chat should never be open at the same time.
        if (navOpen) closeNav(false);
        if (aiFab) aiFab.setAttribute('aria-expanded', 'true');
      } else {
        unlockScroll();
        if (aiFab) aiFab.setAttribute('aria-expanded', 'false');
        if (lastFocused && typeof lastFocused.focus === 'function') {
          lastFocused.focus({ preventScroll: true });
        }
        lastFocused = null;
      }
    }).observe(aiOverlay, { attributes: true, attributeFilter: ['class'] });
  }

  // ----------------------------------------------------------------
  // 5. Chart reflow
  // ----------------------------------------------------------------
  // minichart.js already redraws on window resize and observes its own
  // container, but a canvas inside a hidden .panel has a client width of 0 and
  // cannot measure itself. Nudging it once the panel becomes visible covers
  // that case. Dispatching the resize event is enough — no chart internals
  // are touched from here.
  function reflowCharts() {
    window.dispatchEvent(new Event('resize'));
  }
})();
