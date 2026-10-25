/* Desktop shell status page — verifies the preload bridge end-to-end.
 * No frameworks, no network: strict CSP (see shell.html). */
(function () {
  'use strict';

  function set(id, text, cls) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (cls) el.classList.add(cls);
  }

  function main() {
    var bridge = window.pixelforge;
    if (!bridge) {
      set('st-bridge', 'unavailable', 'bad');
      set('hint', 'window.pixelforge is undefined — preload did not run. Check sandbox/contextIsolation config.');
      return;
    }
    set('st-bridge', 'connected (v' + String(bridge.bridgeVersion) + ')', 'ok');

    bridge
      .ping()
      .then(function (pong) {
        set('st-ping', pong, 'ok');
      })
      .catch(function (err) {
        set('st-ping', 'failed: ' + String(err), 'bad');
      });

    bridge.app
      .getInfo()
      .then(function (info) {
        set('st-version', info.version + (info.isDev ? ' (dev)' : ''));
        set('st-electron', info.electron + ' / chrome ' + info.chrome);
        set('st-platform', info.platform + ' · ' + info.locale);
      })
      .catch(function (err) {
        set('st-version', 'failed: ' + String(err), 'bad');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
