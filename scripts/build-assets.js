const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const copy = (source, destination) => {
  const target = path.join(root, destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, 'node_modules', source), target);
};
copy('@fortawesome/fontawesome-free/css/all.min.css', 'public/vendor/fontawesome/css/all.min.css');
for (const file of ['fa-brands-400.woff2', 'fa-regular-400.woff2', 'fa-solid-900.woff2', 'fa-v4compatibility.woff2']) {
  copy(`@fortawesome/fontawesome-free/webfonts/${file}`, `public/vendor/fontawesome/webfonts/${file}`);
}
copy('@fortawesome/fontawesome-free/LICENSE.txt', 'public/vendor/fontawesome/LICENSE.txt');
copy('sweetalert2/dist/sweetalert2.all.min.js', 'public/vendor/sweetalert/sweetalert2.all.min.js');
copy('sweetalert2/dist/sweetalert2.min.css', 'public/vendor/sweetalert/sweetalert2.min.css');
copy('sweetalert2/LICENSE', 'public/vendor/sweetalert/LICENSE');
copy('@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2', 'public/assets/fonts/dm-sans-latin-wght-normal.woff2');
copy('@fontsource-variable/dm-sans/files/dm-sans-latin-wght-italic.woff2', 'public/assets/fonts/dm-sans-latin-wght-italic.woff2');
copy('@fontsource-variable/dm-sans/LICENSE', 'public/assets/fonts/LICENSE-DM-Sans');
copy('@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2', 'public/assets/fonts/manrope-latin-wght-normal.woff2');
copy('@fontsource-variable/manrope/LICENSE', 'public/assets/fonts/LICENSE-Manrope');
require('./theme-source-package').writeThemeSourceArchive(root).catch((error) => {
  console.error('Could not build the editable Default theme source ZIP:', error.code || 'THEME_SOURCE_BUILD_FAILED');
  process.exitCode = 1;
});
