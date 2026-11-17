# Vendored browser libraries

These files are served to the web page by the relay:

- `marked.umd.js` — marked 18.2.0, MIT License, https://github.com/markedjs/marked
- `purify.min.js` — DOMPurify 3.4.18, MPL-2.0 OR Apache-2.0, https://github.com/cure53/DOMPurify

They are copied from the relay's `node_modules` during development. They are
committed so the relay can serve the page without a build step.
