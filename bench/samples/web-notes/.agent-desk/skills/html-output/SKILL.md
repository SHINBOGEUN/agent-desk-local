---
name: html-output
description: Escapes note text before it is put into an HTML string and keeps rendering in src/render.mjs. Use when you write or change code that builds HTML from note data (titles, any user text). Do not use for changes to note logic in src/notes.mjs that produce no HTML.
---

# HTML output in web-notes

Why: `src/main.js` puts the result of `renderNotes` into `innerHTML`. Any note title that reaches the string unescaped runs as HTML in the user's browser, so one forgotten escape is a script-injection bug.

- Build HTML only in `src/render.mjs`.
- Escape every piece of note data with the five replacements `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&#39;`, and replace `&` first so nothing is escaped twice.
- Attribute values (`data-id`, `class`) come only from numbers or fixed strings, never from raw user text.
- Add a test in `test/render.test.mjs` for any new HTML you produce.
