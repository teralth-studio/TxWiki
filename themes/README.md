# Theme templates and installed themes

The active **Default** theme is bundled inside the application at
`scripts/default-theme/`. It is never loaded from this folder, so removing or
damaging `/themes` cannot disable the built-in theme.

`default.zip` is the editable, installable starter template. It contains
`settings.json` and `theme.css` at the ZIP root, plus the public HTML and CSS
reference files in `source/public/`. Edit the theme settings and stylesheet,
give the theme a name other than `Default`, then upload the ZIP in the
administrator's Themes section. The uploaded theme is extracted to its own
directory under `/themes`.

The source HTML/CSS files are retained as authoring references. TxWiki continues
to render its bundled application shell; uploaded HTML is never executed or
served. The theme's active appearance comes from its validated, scoped
`theme.css`. Do not add JavaScript, secrets, or remote assets.

Installed theme ZIPs must contain `settings.json` and `theme.css` at the root.
Optional files are `preview.png`, files under `assets/`, and the two public
references under `source/public/`.
