// CheerpJ shows each Java window as a div.cjWindow in the page, positioned at the window's bounds
// in its display (the "screen" Java sees).

/** The CheerpJ window element showing the Java window with these bounds, or null. */
export function findWindow(wx, wy, ww, wh) {
  const wins = [...document.querySelectorAll('.cjWindow')].filter((d) => d.style.display !== 'none');
  const px = (v) => Math.round(parseFloat(v));
  return (
    wins.find((d) => px(d.style.left) === wx && px(d.style.top) === wy && px(d.style.width) === ww && px(d.style.height) === wh) ??
    wins.find((d) => px(d.style.width) === ww && px(d.style.height) === wh) ??
    null
  );
}

/** Marks a file dialog (see orcloud.web.FileWindows), so its title bar keeps CheerpJ's upload button. */
export function markFileWindow(wx, wy, ww, wh, tries = 20) {
  const win = findWindow(wx, wy, ww, wh);
  if (win) win.classList.add('or-files');
  else if (tries > 0) setTimeout(() => markFileWindow(wx, wy, ww, wh, tries - 1), 100);
}
