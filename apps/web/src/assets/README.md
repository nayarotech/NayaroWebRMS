# assets/

Locally bundled static assets - fonts above all.

The design prototype loads Manrope, IBM Plex Mono and Noto Sans Devanagari from
Google Fonts. That breaks the offline-first requirement and is blocked by the
renderer CSP, so the woff2 files get vendored here when the real UI is built.
