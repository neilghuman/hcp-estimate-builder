(function () {
  var storageKey = 'scopefoundry-theme-mode';
  var legacyKey = 'scopefoundry-theme';
  var mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function getSystemTheme() {
    return mediaQuery.matches ? 'dark' : 'light';
  }

  function normalizeMode(value) {
    if (value === 'light' || value === 'dark' || value === 'auto') return value;
    return 'auto';
  }

  function getMode() {
    try {
      var mode = localStorage.getItem(storageKey);
      if (!mode) {
        // Migrate old 2-state preference if present.
        var legacy = localStorage.getItem(legacyKey);
        mode = normalizeMode(legacy);
      }
      return normalizeMode(mode);
    } catch (_) {
      return 'auto';
    }
  }

  function resolveTheme(mode) {
    return mode === 'auto' ? getSystemTheme() : mode;
  }

  function applyMode(mode, persist) {
    var resolved = resolveTheme(mode);
    document.documentElement.setAttribute('data-theme-mode', mode);
    document.documentElement.setAttribute('data-theme', resolved);
    if (persist !== false) {
      try {
        localStorage.setItem(storageKey, mode);
      } catch (_) {
        // ignore storage failures in locked-down browser modes
      }
    }
    updateButton(mode);
  }

  function nextMode(mode) {
    if (mode === 'auto') return 'dark';
    if (mode === 'dark') return 'light';
    return 'auto';
  }

  function updateButton(mode) {
    var btn = document.getElementById('btnTheme');
    if (!btn) return;
    if (mode === 'auto') {
      btn.textContent = '🖥 Auto';
      btn.setAttribute('aria-label', 'Theme mode auto. Click for dark mode');
      return;
    }
    if (mode === 'dark') {
      btn.textContent = '🌙 Dark';
      btn.setAttribute('aria-label', 'Theme mode dark. Click for light mode');
      return;
    }
    btn.textContent = '☀ Light';
    btn.setAttribute('aria-label', 'Theme mode light. Click for auto mode');
  }

  function onSystemThemeChanged() {
    var mode = getMode();
    if (mode === 'auto') {
      applyMode('auto', false);
    }
  }

  function wireSystemThemeListener() {
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onSystemThemeChanged);
      return;
    }
    if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(onSystemThemeChanged);
    }
  }

  function init() {
    var mode = getMode();
    applyMode(mode);
    wireSystemThemeListener();

    var btn = document.getElementById('btnTheme');
    if (btn) {
      btn.addEventListener('click', function () {
        var current = document.documentElement.getAttribute('data-theme-mode') || 'auto';
        var next = nextMode(current);
        applyMode(next);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
