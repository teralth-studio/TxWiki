'use strict';

const HEADER_LINK_LIMIT = 5;

function normalizeHeaderLink(input, languages) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Object.assign(new Error('El enlace no es válido.'), { status: 400 });
  const { url, external, titles } = input;
  if (typeof url !== 'string' || !url.trim() || url.trim().length > 2048)
    throw Object.assign(new Error('Escribe una URL válida de hasta 2048 caracteres.'), { status: 400 });
  if (typeof external !== 'boolean')
    throw Object.assign(new Error('Indica si el enlace es externo o interno.'), { status: 400 });
  const normalizedUrl = url.trim();
  if (external) {
    let parsed;
    try {
      parsed = new URL(normalizedUrl);
    } catch {
      throw Object.assign(new Error('La URL externa debe comenzar con https:// o http://.'), { status: 400 });
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password)
      throw Object.assign(new Error('La URL externa debe ser HTTP o HTTPS y no puede incluir credenciales.'), {
        status: 400,
      });
  } else if (
    !normalizedUrl.startsWith('/') ||
    normalizedUrl.startsWith('//') ||
    normalizedUrl.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(normalizedUrl)
  ) {
    throw Object.assign(new Error('La URL interna debe ser una ruta local que comience con /.'), { status: 400 });
  }
  if (!titles || typeof titles !== 'object' || Array.isArray(titles))
    throw Object.assign(new Error('Añade un título en al menos un idioma activo.'), { status: 400 });
  const activeLanguages = new Set(languages);
  const normalizedTitles = {};
  for (const [language, title] of Object.entries(titles)) {
    if (!activeLanguages.has(language) || typeof title !== 'string' || title.trim().length > 80)
      throw Object.assign(new Error('Revisa los títulos de los idiomas activos (máximo 80 caracteres).'), {
        status: 400,
      });
    if (title.trim()) normalizedTitles[language] = title.trim();
  }
  if (!Object.keys(normalizedTitles).length)
    throw Object.assign(new Error('Añade un título en al menos un idioma activo.'), { status: 400 });
  return { url: normalizedUrl, external, titles: normalizedTitles };
}

function normalizeHeaderLinks(value, languages) {
  if (!Array.isArray(value) || value.length > HEADER_LINK_LIMIT)
    throw Object.assign(new Error('No se pueden crear más de 5 enlaces.'), { status: 400 });
  const ids = new Set();
  return value.map((link) => {
    if (!link || typeof link.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(link.id) || ids.has(link.id))
      throw Object.assign(new Error('Uno de los enlaces guardados no es válido.'), { status: 400 });
    ids.add(link.id);
    return { id: link.id, ...normalizeHeaderLink(link, languages) };
  });
}

module.exports = { HEADER_LINK_LIMIT, normalizeHeaderLink, normalizeHeaderLinks };
