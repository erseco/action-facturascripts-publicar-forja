import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCsrfToken,
  parseBuildsTable,
  validateForjaVersion,
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

test('validateForjaVersion accepts integers and single-decimal numbers', () => {
  assert.equal(validateForjaVersion('7'), '7');
  assert.equal(validateForjaVersion('7.1'), '7.1');
  assert.equal(validateForjaVersion('v7.1'), '7.1');
  assert.equal(validateForjaVersion('100'), '100');
});

test('validateForjaVersion rejects triple-dot and pre-release formats', () => {
  assert.throws(() => validateForjaVersion('1.2.3'), /not a valid FacturaScripts version/);
  assert.throws(() => validateForjaVersion('1.0-beta'), /not a valid FacturaScripts version/);
  assert.throws(() => validateForjaVersion('abc'), /not a valid FacturaScripts version/);
  assert.throws(() => validateForjaVersion('1.'), /not a valid FacturaScripts version/);
});

test('CookieJar absorbs Set-Cookie headers and renders Cookie header', () => {
  const jar = new CookieJar();
  jar.absorb(['FSSESSION=abc123; Path=/; HttpOnly', 'extra=1; Path=/']);
  assert.equal(jar.header(), 'FSSESSION=abc123; extra=1');
  jar.absorb(['extra=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
  assert.equal(jar.header(), 'FSSESSION=abc123');
});
