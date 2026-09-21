// ==========================================================================
// router.js — Hash-based SPA router
// #/home, #/exam?course=xxx, #/exam?id=xxx, #/results, #/login, #/signup
// ==========================================================================
export function parseHash(hash = window.location.hash) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const qIdx = raw.indexOf("?");
  const path = (qIdx === -1 ? raw : raw.slice(0, qIdx)).replace(/^\//, "");
  const search = qIdx === -1 ? "" : raw.slice(qIdx);
  return { route: path || "home", params: new URLSearchParams(search) };
}

export class Router {
  // `onNavigate` runs before every route render — the place for app-wide
  // "we are leaving whatever was on screen" housekeeping.
  constructor(routes, container, { onNavigate } = {}) {
    this._routes = routes;
    this._container = container;
    this._onNavigateHook = onNavigate || null;
    this._current = null;
    this._onHashChange = this._onHashChange.bind(this);
  }
  start() {
    window.addEventListener("hashchange", this._onHashChange);
    this._render();
  }
  _onHashChange() { this._render(); }
  async _render() {
    if (this._onNavigateHook) {
      try { this._onNavigateHook(); } catch (err) { console.error("onNavigate hook failed:", err); }
    }
    const { route, params } = parseHash();
    const handler = this._routes[route] || this._routes["404"] || null;
    const hash = window.location.hash;
    const navigationChanged = hash !== this._current;
    this._current = hash;
    if (handler) {
      await handler(params, this._container);
      if (navigationChanged) window.scrollTo(0, 0);
    }
  }
}

export function navigate(hash) {
  window.location.hash = hash.startsWith("#") ? hash : `#${hash}`;
}

/* Re-run the current route from scratch. Plain navigate() to the hash we are
   already on does nothing (the browser fires no hashchange for an identical
   hash) — which is exactly why "আবার দিন" on the result screen used to be a
   dead button: the result screen lives at the very same #/exam?id=… URL the
   exam was started from. */
export function reloadRoute() {
  window.scrollTo(0, 0);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
