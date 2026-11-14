# Rocket in Cloud logo

- `logo-original.png`: the logo as designed (800 × 800, on white).
- `logo-512.png`: the mark alone, cropped square, on a transparent background (navy #1E3A8A, the
  trajectory arc blue #3B82F6). Use it on light backgrounds, and as the app's logo on Base44.
- `logo-dark-512.png`: the same for dark backgrounds (the cloud and rocket light, #E8EEFB).

The site's copies (`logo.png`, `logo-dark.png`, `favicon.png` on a white rounded tile,
`apple-touch-icon.png` on white) are in `web/public`, `server/public`, `frontdoor/public` and
`docs/assets`. Pages show `logo-dark.png` in dark mode (`<picture>` with `prefers-color-scheme`).
