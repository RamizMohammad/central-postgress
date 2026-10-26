/* Applies the saved theme before first paint (separate file: the CSP forbids inline scripts). */
(function () {
  try {
    var t = JSON.parse(localStorage.getItem('cp:theme') || '"auto"');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the system theme */ }
})();
