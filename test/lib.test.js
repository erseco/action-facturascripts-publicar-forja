import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCsrfToken,
  parseBuildsTable,
  normalizeVersionForForja,
  CookieJar,
} from '../lib.js';

test('extractCsrfToken reads the hidden input from the whole document', () => {
  const html = `<html><body>
    <form action="/login" method="post">
      <input type="hidden" name="multireqtoken" value="abc123|rEdUuC"/>
      <input name="fsNick"><input name="fsPassword">
    </form>
  </body></html>`;
  assert.equal(extractCsrfToken(html), 'abc123|rEdUuC');
});

test('extractCsrfToken scopes to the requested form id', () => {
  const html = `
    <form id="other"><input name="multireqtoken" value="wrong"></form>
    <form id="f_add_build">
      <input type="hidden" name="multireqtoken" value="right-token|xy"/>
      <input name="zip" type="file">
    </form>`;
  assert.equal(extractCsrfToken(html, 'f_add_build'), 'right-token|xy');
});

test('extractCsrfToken throws when form id is not present', () => {
  const html = `<form id="other"><input name="multireqtoken" value="x"></form>`;
  assert.throws(() => extractCsrfToken(html, 'f_add_build'), /Could not find form/);
});

test('extractCsrfToken throws when the token is missing', () => {
  const html = `<form id="f_add_build"><input name="zip" type="file"></form>`;
  assert.throws(() => extractCsrfToken(html, 'f_add_build'), /multireqtoken/);
});

test('parseBuildsTable extracts id/version pairs', () => {
  const html = `
    <tr data-bs-target="#build3472Modal" class="pointer">
      <td class="text-end">7.1</td>
      <td>Estable</td>
    </tr>
    <tr data-bs-target="#build3261Modal" class="pointer">
      <td class="text-end">7</td>
      <td>Estable</td>
    </tr>`;
  const builds = parseBuildsTable(html);
  assert.deepEqual(builds, [
    { id: '3472', version: '7.1' },
    { id: '3261', version: '7' },
  ]);
});

test('normalizeVersionForForja passes through plain integers and x.y', () => {
  assert.equal(normalizeVersionForForja('7'), '7');
  assert.equal(normalizeVersionForForja('7.1'), '7.1');
  assert.equal(normalizeVersionForForja('v7.1'), '7.1');
});

test('normalizeVersionForForja encodes x.y.z into a monotonic float', () => {
  assert.equal(normalizeVersionForForja('1.2.3'), '1.0203');
  assert.equal(normalizeVersionForForja('v1.2.3'), '1.0203');
  assert.equal(normalizeVersionForForja('2.0.0'), '2.0000');
});

test('CookieJar absorbs Set-Cookie headers and renders Cookie header', () => {
  const jar = new CookieJar();
  jar.absorb(['FSSESSION=abc123; Path=/; HttpOnly', 'extra=1; Path=/']);
  assert.equal(jar.header(), 'FSSESSION=abc123; extra=1');
  jar.absorb(['extra=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
  assert.equal(jar.header(), 'FSSESSION=abc123');
});
