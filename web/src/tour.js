// The tour: the signed-out home page (index.html's #landing, started by dashboard.js) and the
// feature pages (features/*.html, started by tour-page.js). Sign-in buttons, and sections that
// fade in as they scroll into view.
import './tour.css';
import { signIn } from './base44.js';

/** Sets up the tour's page: sign-in buttons, and sections that appear as they scroll into view. */
export function setupTour() {
  for (const b of document.querySelectorAll('[data-signin]')) {
    // Back to the home page after signing in: the dashboard.
    b.addEventListener('click', () => signIn(new URL('/', location.href).toString()));
  }
  reveal();
}

/** For someone already signed in: the sign-in buttons open the app instead. */
export function markSignedIn() {
  for (const b of document.querySelectorAll('[data-signin]')) {
    const open = document.createElement('a');
    open.className = b.className;
    open.href = '/';
    open.textContent = b.dataset.signedIn ?? 'Open your designs';
    b.replaceWith(open);
  }
}

function reveal() {
  const items = document.querySelectorAll('.t-reveal');
  if (!items.length || !('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('t-js');
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      seen.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  for (const el of items) seen.observe(el);
}
