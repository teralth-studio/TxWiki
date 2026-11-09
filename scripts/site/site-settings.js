const LOCAL_IMAGE = /^\/media\/[A-Za-z0-9_-]{16}\.(?:png|jpg|gif|webp)$/;
const HEX = /^#[0-9a-f]{6}$/i;

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function text(value, max, label) {
  if (typeof value !== 'string' || value.length > max) invalid(`Revisa ${label}.`);
  return value.trim();
}

function webUrl(value, label) {
  const raw = text(value, 2048, label);
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { invalid(`Revisa ${label}.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    invalid(`Revisa ${label}.`);
  return url.href;
}

function normalizeSupportUrl(value) {
  const raw = text(value, 500, 'el contacto de soporte');
  if (!raw) return '';
  if (/^[a-z0-9.!#$%&'*+_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) return raw;
  if (/^\/(?!\/)/.test(raw)) return raw;
  let url;
  try { url = new URL(raw); } catch { invalid('Revisa el contacto de soporte.'); }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password)
    invalid('Revisa el contacto de soporte.');
  return raw;
}

function normalizeSiteOptions(input, oldSite) {
  const result = {};
  if (input.support !== undefined) {
    const support = input.support;
    if (!support || typeof support !== 'object' || Array.isArray(support)) invalid('Revisa el bloque de soporte.');
    if (support.enabled !== undefined && typeof support.enabled !== 'boolean')
      invalid('Revisa si el bloque de soporte está habilitado.');
    const translations = Object.create(null);
    if (!support.translations || typeof support.translations !== 'object' || Array.isArray(support.translations))
      invalid('Revisa las traducciones del bloque de soporte.');
    for (const [locale, item] of Object.entries(support.translations)) {
      if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale) || !item || typeof item !== 'object' || Array.isArray(item))
        invalid('Revisa las traducciones del bloque de soporte.');
      translations[locale] = {
        title: text(item.title, 120, 'el título de soporte'),
        description: text(item.description, 500, 'la descripción de soporte'),
        button: text(item.button, 80, 'el texto del botón'),
      };
    }
    if (Object.keys(translations).length > 100) invalid('Hay demasiadas traducciones de soporte.');
    const color = (value) => {
      if (value === '') return '';
      if (typeof value !== 'string' || !HEX.test(value)) invalid('Revisa los colores de soporte.');
      return value.toLowerCase();
    };
    const background = color(support.background);
    const backgroundEnd = color(support.backgroundEnd);
    const buttonBackground = color(support.buttonBackground);
    const buttonBackgroundEnd = color(support.buttonBackgroundEnd);
    if ((backgroundEnd && !background) || (buttonBackgroundEnd && !buttonBackground))
      invalid('Selecciona el color inicial del degradado.');
    result.support = {
      enabled: support.enabled === undefined ? oldSite.support?.enabled !== false : support.enabled,
      translations,
      background,
      backgroundEnd,
      buttonBackground,
      buttonBackgroundEnd,
    };
  }
  if (input.seo !== undefined) {
    const seo = input.seo;
    if (!seo || typeof seo !== 'object' || Array.isArray(seo) || typeof seo.indexable !== 'boolean')
      invalid('Revisa los ajustes de SEO.');
    const canonicalBase = webUrl(seo.canonicalBase, 'la URL canónica'),
      image = text(seo.socialImage, 2048, 'la imagen para redes sociales');
    if (canonicalBase) {
      const base = new URL(canonicalBase);
      if (base.search || base.hash) invalid('La URL canónica no puede tener parámetros ni fragmentos.');
    }
    if (image && !LOCAL_IMAGE.test(image)) webUrl(image, 'la imagen para redes sociales');
    result.seo = {
      description: text(seo.description, 320, 'la descripción SEO'),
      indexable: seo.indexable,
      socialTitle: text(seo.socialTitle, 120, 'el título para redes sociales'),
      socialDescription: text(seo.socialDescription, 320, 'la descripción para redes sociales'),
      socialImage: image,
      canonicalBase,
    };
  }
  return { support: result.support === undefined ? oldSite.support : result.support, seo: result.seo === undefined ? oldSite.seo : result.seo };
}

module.exports = { normalizeSiteOptions, normalizeSupportUrl };
