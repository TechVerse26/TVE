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
  constructor(routes, container) {
    this._routes = routes;
    this._container = container;
    this._current = null;
    this._onHashChange = this._onHashChange.bind(this);
  }
  start() {
    window.addEventListener("hashchange", this._onHashChange);
    this._render();
  }
  _onHashChange() { this._render(); }
  async _render() {
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
