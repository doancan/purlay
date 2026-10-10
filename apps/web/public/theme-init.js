/*
 * Sets the theme before the first paint, so a person who chose light never sees
 * a dark frame first.
 *
 * It is a file and not an inline script on purpose: a content security policy
 * that forbids inline script (#112) would refuse it, and weakening the policy for
 * the sake of a colour is the wrong trade. It is not a module because modules are
 * deferred, and this has to run before the body is painted.
 *
 * The key repeats `THEME_KEY` in src/theme/theme.ts; src/theme/theme.test.ts
 * fails if the two differ, and runs this file to check that it does what the
 * store would. Written in the oldest syntax on purpose: if it throws, the page
 * still has the `data-theme` index.html starts with.
 */
(function () {
  try {
    var stored = window.localStorage.getItem('purlay.theme');
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored === 'light' || stored === 'dark' ? stored : dark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (error) {
    // Keep the default in index.html.
  }
})();
