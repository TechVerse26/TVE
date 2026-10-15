/*!
 * median-bridge.js — Tech Verse Exam (TVE) · native app helper
 * ------------------------------------------------------------------
 * Median অ্যাপের ভেতরে চললে native feature চালু করে।
 * সাধারণ browser-এ সব function নিরাপদে no-op — কোনো error হয় না।
 *
 * কোথায় বসাবে (প্রতিটি পেজে, অন্য স্ক্রিপ্টের আগে):
 *   <script src="/js/median-bridge.js"></script>
 *
 * ব্যবহার:
 *   TVNative.examStart();              // পরীক্ষা শুরু: স্ক্রিন জেগে থাকবে
 *   TVNative.examEnd();                // সাবমিট/শেষ: স্ক্রিন স্বাভাবিক
 *   TVNative.onResume(syncTimer);      // ব্যাকগ্রাউন্ড থেকে ফিরলে টাইমার ঠিক করো
 *   TVNative.share({ text, url });     // native share sheet
 *   TVNative.haptic('notificationSuccess');
 *   TVNative.statusBar();              // status bar = পেজের theme-color
 *   TVNative.push.enable();            // নোটিফিকেশন পারমিশন চাও
 *   TVNative.push.identify(user.uid);  // Firebase uid ↔ OneSignal ডিভাইস
 *   TVNative.push.logout();            // সাইন আউটে
 *   TVNative.push.tags({ course: 'hsc-physics' });
 *
 * Firebase Auth-এর সাথে:
 *   onAuthStateChanged(auth, function (user) {
 *     if (user) TVNative.push.identify(user.uid); else TVNative.push.logout();
 *   });
 *
 * নোট:
 * - নিজের `median_library_ready` ফাংশন থাকলে সেটার ভেতরে TVNative.init() কল করো।
 * - Haptics প্লাগইন premium; না থাকলে haptic() কিছুই করবে না।
 * - push.enable() তখনই দরকার যখন App Studio-তে OneSignal
 *   "Automatic Registration" বন্ধ করা আছে।
 */
(function (w, d) {
  'use strict';

  var UA = (w.navigator && w.navigator.userAgent) || '';
  var isApp = !!w.median || /median|gonative|Tech Verse/i.test(UA);
  var isAndroid = isApp && /MedianAndroid|GoNativeAndroid|Android/i.test(UA);
  var isIOS = isApp && /MedianIOS|GoNativeIOS|iPhone|iPad|iPod/i.test(UA);

  // CSS-এ ব্যবহার করা যাবে: html.is-app, html.is-android, html.is-ios
  if (isApp && d.documentElement) {
    d.documentElement.classList.add('is-app');
    if (isAndroid) d.documentElement.classList.add('is-android');
    if (isIOS) d.documentElement.classList.add('is-ios');
  }

  /* ---------- bridge ready queue ---------- */
  var queue = [];
  var ready = false;
  var examOn = false;

  function call(fn) {
    try { return fn(w.median); } catch (e) { /* plugin নেই বা bridge error — উপেক্ষা */ }
  }
  function run(fn) {
    if (!isApp) return;
    if (ready) call(fn); else queue.push(fn);
  }
  function init() {
    if (ready) return;
    ready = true;
    while (queue.length) call(queue.shift());
    TV.statusBar();
  }

  var prevReady = w.median_library_ready;
  w.median_library_ready = function () {
    try { if (typeof prevReady === 'function') prevReady(); } catch (e) {}
    init();
  };

  /* ---------- status bar helpers ---------- */
  function themeHex() {
    var m = d.querySelector('meta[name="theme-color"]');
    var c = ((m && m.getAttribute('content')) || '#14151E').trim().replace('#', '');
    return /^[0-9a-f]{6}$/i.test(c) ? c : '14151E';
  }
  function isDarkHex(hex) {
    var r = parseInt(hex.substr(0, 2), 16);
    var g = parseInt(hex.substr(2, 2), 16);
    var b = parseInt(hex.substr(4, 2), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
  }

  /* ---------- app-resume (ব্যাকগ্রাউন্ড থেকে ফেরা) ---------- */
  var resumeFns = [];
  var lastResume = 0;
  function fireResume() {
    var now = Date.now();
    if (now - lastResume < 800) return; // double-fire এড়াতে
    lastResume = now;
    for (var i = 0; i < resumeFns.length; i++) {
      try { resumeFns[i](); } catch (e) {}
    }
  }
  var prevResumed = w.median_app_resumed;
  w.median_app_resumed = function () {
    try { if (typeof prevResumed === 'function') prevResumed(); } catch (e) {}
    fireResume();
  };
  d.addEventListener('visibilitychange', function () {
    if (!d.hidden) fireResume();
  });

  /* ---------- public API ---------- */
  var TV = {
    isApp: isApp,
    isAndroid: isAndroid,
    isIOS: isIOS,
    init: init,

    // Median-এ style 'dark' = সাদা আইকন (গাঢ় ব্যাকগ্রাউন্ডের জন্য)
    statusBar: function (opts) {
      opts = opts || {};
      var hex = (opts.color || themeHex()).replace('#', '');
      var style = opts.style || (isDarkHex(hex) ? 'dark' : 'light');
      run(function (m) {
        m.statusbar.set({ style: style, color: hex, overlay: !!opts.overlay });
      });
    },

    examStart: function () {
      examOn = true;
      run(function (m) {
        if (m.screen && m.screen.keepScreenOn) m.screen.keepScreenOn();
        else if (m.android && m.android.screen && m.android.screen.keepScreenOn) m.android.screen.keepScreenOn();
      });
    },

    examEnd: function () {
      examOn = false;
      run(function (m) {
        if (m.screen && m.screen.keepScreenNormal) m.screen.keepScreenNormal();
        else if (m.android && m.android.screen && m.android.screen.keepScreenNormal) m.android.screen.keepScreenNormal();
      });
    },

    // style: impactLight | impactMedium | impactHeavy |
    //        notificationSuccess | notificationWarning | notificationError
    haptic: function (style) {
      run(function (m) {
        if (m.haptics && m.haptics.trigger) m.haptics.trigger({ style: style || 'impactLight' });
      });
    },

    share: function (opts) {
      opts = opts || {};
      var url = opts.url || w.location.href;
      var text = opts.text || '';
      var yes = function () { return true; };
      var no = function () { return false; };
      if (isApp && w.median && w.median.share && w.median.share.sharePage) {
        w.median.share.sharePage({ url: url, text: text });
        return Promise.resolve(true);
      }
      if (w.navigator.share) {
        return w.navigator.share({ title: opts.title, text: text, url: url }).then(yes, no);
      }
      if (w.navigator.clipboard && w.navigator.clipboard.writeText) {
        return w.navigator.clipboard.writeText((text ? text + ' ' : '') + url).then(yes, no);
      }
      return Promise.resolve(false);
    },

    reload: function () {
      if (isApp && w.median && w.median.webview && w.median.webview.reload) w.median.webview.reload();
      else w.location.reload();
    },

    onResume: function (fn) {
      if (typeof fn === 'function') resumeFns.push(fn);
    },

    onNetwork: function (fn) {
      if (typeof fn !== 'function') return;
      w.addEventListener('online', function () { fn(true); });
      w.addEventListener('offline', function () { fn(false); });
    },

    push: {
      enable: function () {
        run(function (m) { m.onesignal.register(); });
      },
      identify: function (uid) {
        if (!uid) return;
        run(function (m) { m.onesignal.login(String(uid)); });
      },
      logout: function () {
        run(function (m) { m.onesignal.logout(); });
      },
      tags: function (obj) {
        if (!obj) return;
        var t = {};
        for (var k in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, k)) t[k] = String(obj[k]);
        }
        run(function (m) { m.onesignal.tags.setTags({ tags: t }); });
      }
    }
  };

  // পেজ ছেড়ে গেলে স্ক্রিন-অন বন্ধ (ব্যাটারি বাঁচাতে)
  w.addEventListener('pagehide', function () {
    if (examOn) TV.examEnd();
  });

  w.TVNative = TV;

  // library আগেই লোড হয়ে থাকলে এখনই চালু করো
  if (isApp && w.median) init();
})(window, document);
