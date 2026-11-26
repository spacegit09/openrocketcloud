// For browser tests through Vite's dev server: Vite reloads a page when a file the page uses is
// written while the test runs. scripts/prebuild.mjs rewrites web/src/lib/*.js, unchanged or not,
// so building alongside a test does it. A page with unsaved changes (the motor designer, the
// logbook) then asks "Leave site?". In a headless browser nobody answers, so the page waits for
// ever, which looked like a calculation that had stalled (2026-11-26). Here the page is kept, and
// the test says what happened; leaving a page with page.goto is still answered "leave".
export function guardDevReloads(page, name) {
  let leaving = false;
  const goto = page.goto.bind(page);
  page.goto = async (...args) => {
    leaving = true;
    try {
      return await goto(...args);
    } finally {
      leaving = false;
    }
  };
  page.on('dialog', (d) => {
    if (d.type() !== 'beforeunload') return;
    if (leaving) return d.accept().catch(() => {});
    console.warn(`${name}: Vite asked to reload the page (a file it uses was written during the test, as scripts/prebuild.mjs does); kept the page. Run the test with nothing else writing to web/src.`);
    return d.dismiss().catch(() => {});
  });
}
