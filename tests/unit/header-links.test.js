'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HEADER_LINK_LIMIT, normalizeHeaderLink, normalizeHeaderLinks } = require('../../scripts/header-links');

const languages = ['en', 'es'];
const validLink = {
  id: '00000000-0000-4000-8000-000000000001',
  url: '/guide/start?from=header',
  external: false,
  titles: { en: 'Guide', es: 'Guía' },
};

test('header links accept local routes and HTTP(S) URLs with active-language titles', () => {
  assert.deepEqual(normalizeHeaderLink(validLink, languages), {
    url: validLink.url,
    external: false,
    titles: validLink.titles,
  });
  assert.equal(
    normalizeHeaderLink({ ...validLink, url: 'https://example.test/docs', external: true }, languages).external,
    true,
  );
  assert.equal(
    normalizeHeaderLink({ ...validLink, url: 'http://example.test/docs', external: true }, languages).url,
    'http://example.test/docs',
  );
});

test('header links reject unsafe URL schemes, off-site local paths, and URL credentials', () => {
  for (const [url, external] of [
    ['javascript:alert(1)', true],
    ['ftp://example.test', true],
    ['https://user:pass@example.test', true],
    ['//example.test/path', false],
    ['/\\example.test', false],
    ['relative/path', false],
  ]) {
    assert.throws(
      () => normalizeHeaderLink({ ...validLink, url, external }, languages),
      (error) => error.status === 400,
      `${url} should be rejected`,
    );
  }
});

test('header links require a non-empty translated title for an active language', () => {
  for (const titles of [{}, { fr: 'Guide' }, { en: ' ' }, { en: 'x'.repeat(81) }]) {
    assert.throws(
      () => normalizeHeaderLink({ ...validLink, titles }, languages),
      (error) => error.status === 400,
    );
  }
});

test('stored links enforce unique UUIDs and the five-link maximum', () => {
  assert.equal(HEADER_LINK_LIMIT, 5);
  assert.equal(normalizeHeaderLinks([validLink], languages).length, 1);
  assert.throws(
    () => normalizeHeaderLinks([validLink, validLink], languages),
    (error) => error.status === 400,
  );
  assert.throws(
    () =>
      normalizeHeaderLinks(
        Array.from({ length: HEADER_LINK_LIMIT + 1 }, (_, index) => ({
          ...validLink,
          id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        })),
        languages,
      ),
    (error) => error.status === 400,
  );
});
