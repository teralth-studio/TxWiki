# Creating themes

TxWiki themes are installed from the administrator's **Themes** section. Upload a
ZIP containing `settings.json` and `theme.css` at its root. The project keeps
`default/` as its built-in project copy; uploaded themes are stored beside it at
runtime.

The editable full-page source is also kept in
`teralth-default-theme-source.zip`. It contains the public HTML shell, the full
stylesheet, and the Default theme settings and CSS. Administrators can download
it from the Themes panel. The source ZIP is for editing the page template; the
Themes installer accepts the CSS-only package format described below.

Example `settings.json`:

```json
{
  "name": "My Theme",
  "version": "1.0.0",
  "author": "Your name",
  "support": "",
  "settings": [
    {
      "name": "Primary Color",
      "type": "color",
      "default": "#b85b42"
    }
  ]
}
```

Supported setting types are `color`, `number`, `text`, `large-text`, `switch`,
`dropdown`, and `multiple-dropdown`. Dropdown settings must include an `options`
array with at least two values.

Put theme styles in `theme.css`. Selectors are scoped to the active theme, and
the server validates CSS before using it. Do not include JavaScript, HTML, or
external asset URLs. Optional images and fonts belong under `assets/`; CSS may
reference them with paths such as `url("assets/logo.webp")`. Supported assets
are PNG, JPEG, GIF, WebP, AVIF, WOFF, WOFF2, TTF, and OTF. An optional
`preview.png` can be included at the ZIP root.

The ZIP must contain files directly at its root, for example:

```text
my-theme.zip
├── settings.json
├── theme.css
├── preview.png          # optional
└── assets/              # optional
    └── logo.webp
```
