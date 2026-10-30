// ==========================================================================
// pwa-early.js — classic (non-module) script, loaded in <head> BEFORE any module.
//
// Browsers fire `beforeinstallprompt` once, as soon as the page is installable — often before the app's
// module graph (Firebase etc.) has finished loading. This ~20-line listener keeps that event so
// js/pwa-install.js can use it whenever it starts. It is the ONLY place the native events are listened to
// while this file is present (pwa-install.js adds its own listeners only if this script is missing),
// so there are never duplicate listeners or duplicate prompts.
//
//   window.__tvePwaEarly = { event, installed }     events: "tve:bip" (prompt retained) · "tve:installed"
//
// preventDefault() is what lets us show our own install popup instead of the browser's mini-bar;
// the real install prompt is still shown by the browser, when the visitor presses "Install App".
// ==========================================================================
(function () {
  "use strict";
  if (window.__tvePwaEarly) return;
  var early = (window.__tvePwaEarly = { event: null, installed: false });

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    early.event = e;
    window.dispatchEvent(new Event("tve:bip"));
  });

  window.addEventListener("appinstalled", function () {
    early.event = null;
    early.installed = true;
    window.dispatchEvent(new Event("tve:installed"));
  });
})();
