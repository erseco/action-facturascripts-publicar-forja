import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const DEFAULT_UA =
  'action-facturascripts-publicar-forja/1.0 (+https://github.com/erseco/action-facturascripts-publicar-forja)';

/**
 * Minimal in-memory cookie jar keyed by cookie name.
 * Good enough for the forja: the session lives in a single HttpOnly cookie.
 */
export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  absorb(setCookieHeaders) {
    if (!setCookieHeaders) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const raw of list) {
      const firstPart = raw.split(';', 1)[0];
      const eq = firstPart.indexOf('=');
      if (eq === -1) continue;
      const name = firstPart.slice(0, eq).trim();
      const value = firstPart.slice(eq + 1).trim();
      if (!name) continue;
      if (value === '' || /deleted|expired/i.test(raw)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  header() {
    if (this.cookies.size === 0) return '';
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  names() {
    return Array.from(this.cookies.keys());
  }
}

/**
 * Extract `Set-Cookie` headers from a fetch Response in a way that works on Node 20+.
 * Node exposes `getSetCookie()` on Headers when available.
 */
export function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/**
 * Extract the `multireqtoken` hidden value from an HTML fragment.
 * If `formId` is provided, the search is scoped to that form to avoid
 * picking up tokens from unrelated forms on the same page.
 *
 * @param {string} html
 * @param {string} [formId]
 * @returns {string}
 */
export function extractCsrfToken(html, formId) {
  let scope = html;
  if (formId) {
    const re = new RegExp(
      `<form[^>]*\\bid=["']${formId}["'][\\s\\S]*?<\\/form>`,
      'i'
    );
    const match = html.match(re);
    if (!match) {
      throw new Error(`Could not find form with id="${formId}" in the page.`);
    }
    scope = match[0];
  }
  const tokenMatch = scope.match(
    /name=["']multireqtoken["'][^>]*value=["']([^"']+)["']|value=["']([^"']+)["'][^>]*name=["']multireqtoken["']/i
  );
  if (!tokenMatch) {
    throw new Error('Could not find multireqtoken in the page HTML.');
  }
  return tokenMatch[1] || tokenMatch[2];
}

/**
 * Build the Forja HTTP client, preconfigured with a CookieJar and base URL.
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {CookieJar} options.jar
 * @param {typeof fetch} [options.fetch]
 */
export function createForjaClient({ baseUrl, jar, fetch: fetchImpl = fetch }) {
  const base = baseUrl.replace(/\/+$/, '');

  async function request(path, init = {}) {
    const url = path.startsWith('http') ? path : `${base}${path}`;
    const headers = {
      'User-Agent': DEFAULT_UA,
      Accept: 'text/html,application/xhtml+xml',
      ...(init.headers || {}),
    };
    const cookieHeader = jar.header();
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    const response = await fetchImpl(url, {
      ...init,
      headers,
      redirect: 'manual',
    });

    jar.absorb(getSetCookies(response));

    // Follow 3xx manually to keep cookies sticky across the redirect chain.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        return request(new URL(location, url).toString(), {
          method: 'GET',
          headers: { Accept: headers.Accept },
        });
      }
    }
    return response;
  }

  return { request, jar, baseUrl: base };
}

/**
 * Log into the forja and populate the cookie jar with the session cookie.
 * Throws on failure.
 *
 * @param {ReturnType<typeof createForjaClient>} client
 * @param {{ username: string, password: string }} credentials
 */
export async function loginToForja(client, { username, password }) {
  if (!username || !password) {
    throw new Error('loginToForja requires username and password.');
  }

  const loginPageResponse = await client.request('/MeLogin');
  if (loginPageResponse.status !== 200) {
    throw new Error(`GET /MeLogin failed with status ${loginPageResponse.status}`);
  }
  const loginHtml = await loginPageResponse.text();
  const csrfToken = extractCsrfToken(loginHtml);

  const body = new URLSearchParams({
    multireqtoken: csrfToken,
    action: 'login',
    return: '/',
    email: username,
    passwd: password,
  });

  await client.request('/MeLogin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: client.baseUrl,
      Referer: `${client.baseUrl}/MeLogin`,
    },
    body,
  });

  const sessionCookies = client.jar.names();
  const hasSession =
    sessionCookies.includes('fsIdcontacto') || sessionCookies.includes('fsLogkey');
  if (!hasSession) {
    throw new Error(
      'Login failed: the forja did not issue a session cookie after POST /MeLogin.'
    );
  }

  // Sanity-check by hitting /Me. If it returns 403 or the login form again,
  // the credentials were rejected silently.
  const meResponse = await client.request('/Me');
  if (meResponse.status !== 200) {
    throw new Error(
      `Login verification failed: GET /Me returned status ${meResponse.status}.`
    );
  }
  const meHtml = await meResponse.text();
  if (/name=["']passwd["']/.test(meHtml) && /name=["']email["']/.test(meHtml)) {
    throw new Error('Login failed: /Me still shows the login form.');
  }

  return { cookies: sessionCookies };
}

/**
 * Fetch the admin tab for a plugin page and return the CSRF token scoped to
 * the `f_add_build` form. Also returns the list of existing builds parsed
 * from the page, which is useful for validation.
 *
 * @param {ReturnType<typeof createForjaClient>} client
 * @param {string} slug
 */
export async function getAdminFormToken(client, slug) {
  const cleanSlug = slug.trim().toLowerCase();
  if (!cleanSlug) throw new Error('plugin slug is required');
  const response = await client.request(
    `/plugins/${encodeURIComponent(cleanSlug)}?activetab=admin`
  );
  if (response.status !== 200) {
    throw new Error(
      `GET /plugins/${cleanSlug}?activetab=admin failed with status ${response.status}`
    );
  }
  const html = await response.text();
  if (!/id=["']f_add_build["']/.test(html)) {
    throw new Error(
      `The add-build form is not present on /plugins/${cleanSlug}. ` +
        'Check that the authenticated user owns the plugin.'
    );
  }
  const csrfToken = extractCsrfToken(html, 'f_add_build');
  const builds = parseBuildsTable(html);
  return { csrfToken, html, builds };
}

/**
 * Parse the builds table into [{ id, version }]. Best-effort; any shape
 * change on the forja side degrades gracefully to an empty list.
 *
 * @param {string} html
 */
export function parseBuildsTable(html) {
  const builds = [];
  const re = /data-bs-target=["']#build(\d+)Modal["'][\s\S]*?<td class=["']text-end["']>\s*([\d.]+)\s*<\/td>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    builds.push({ id: match[1], version: match[2] });
  }
  return builds;
}

/**
 * Upload a plugin ZIP as a new build.
 *
 * @param {ReturnType<typeof createForjaClient>} client
 * @param {object} params
 * @param {string} params.slug
 * @param {string} params.zipPath
 * @param {string | number} params.version
 * @param {string} [params.csrfToken] - if omitted, fetched automatically
 * @param {boolean} [params.dryRun] - if true, return the request plan without sending
 */
export async function publishBuild(client, params) {
  const slug = params.slug.trim().toLowerCase();
  const zipPath = params.zipPath;
  const version = String(params.version);

  const zipBytes = await readFile(zipPath);
  const zipName = basename(zipPath);

  let csrfToken = params.csrfToken;
  let buildsBefore = [];
  if (!csrfToken) {
    const admin = await getAdminFormToken(client, slug);
    csrfToken = admin.csrfToken;
    buildsBefore = admin.builds;
  }

  const formData = new FormData();
  formData.append('multireqtoken', csrfToken);
  formData.append('action', 'add-build');
  formData.append('activetab', 'admin');
  formData.append('version', version);
  formData.append(
    'zip',
    new Blob([zipBytes], { type: 'application/zip' }),
    zipName
  );

  if (params.dryRun) {
    return {
      dryRun: true,
      url: `${client.baseUrl}/plugins/${encodeURIComponent(slug)}`,
      csrfToken,
      version,
      zipName,
      zipBytes: zipBytes.length,
      buildsBefore,
    };
  }

  const response = await client.request(
    `/plugins/${encodeURIComponent(slug)}`,
    {
      method: 'POST',
      body: formData,
    }
  );
  const html = await response.text();
  const buildsAfter = parseBuildsTable(html);
  const newBuild = buildsAfter.find(
    (b) => !buildsBefore.some((x) => x.id === b.id)
  );

  if (!newBuild) {
    const alerts = Array.from(html.matchAll(/alert-[\w-]+[\s\S]*?<\/div>/g))
      .map((m) => m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 5);
    const detail = alerts.length
      ? ` Forja messages: ${alerts.join(' | ')}`
      : '';
    throw new Error(
      `Upload finished with status ${response.status} but no new build row was detected.${detail}`
    );
  }

  return {
    buildId: newBuild.id,
    buildVersion: newBuild.version,
    buildUrl: `${client.baseUrl}/plugins/${encodeURIComponent(slug)}#build${newBuild.id}Modal`,
  };
}

/**
 * Extract the per-build edit modal fields for a given build id from the
 * admin page HTML. Returns an object with the current multireqtoken,
 * status, min_php, min_core and max_core values so they can be re-submitted
 * unchanged when promoting a build to a new state.
 *
 * @param {string} html
 * @param {string} buildId
 */
export function parseBuildEditModal(html, buildId) {
  const modalRe = new RegExp(
    `id=["']build${buildId}Modal["'][\\s\\S]*?id_build["']\\s+value=["']${buildId}["'][\\s\\S]*?<div class=["']modal-footer`,
    'i'
  );
  const match = html.match(modalRe);
  if (!match) {
    throw new Error(`Could not find edit modal for build id ${buildId}.`);
  }
  const modal = match[0];

  const tokenMatch = modal.match(
    /name=["']multireqtoken["']\s+value=["']([^"']+)["']/
  );
  if (!tokenMatch) {
    throw new Error(`No multireqtoken in edit modal for build ${buildId}.`);
  }

  // The status is a <select> with `selected` on the current option.
  const statusMatch = modal.match(
    /name=["']status["'][\s\S]*?<option[^>]*value=["']([^"']+)["'][^>]*selected/i
  );
  const status = statusMatch ? statusMatch[1] : '';

  function number(name) {
    const m = modal.match(
      new RegExp(`name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i')
    );
    return m ? m[1] : '';
  }

  return {
    multireqtoken: tokenMatch[1],
    status,
    min_php: number('min_php'),
    min_core: number('min_core'),
    max_core: number('max_core'),
  };
}

/**
 * Promote a build to a new state on the forja (stable/beta/disabled).
 *
 * @param {ReturnType<typeof createForjaClient>} client
 * @param {object} params
 * @param {string} params.slug
 * @param {string} params.buildId
 * @param {'stable' | 'beta' | '0'} params.status
 * @param {object} [params.overrides] - optional overrides for min_php, min_core, max_core
 */
export async function updateBuildStatus(client, params) {
  const slug = params.slug.trim().toLowerCase();
  const { buildId, status, overrides = {} } = params;
  if (!['stable', 'beta', '0'].includes(status)) {
    throw new Error(
      `Invalid status "${status}". Expected one of stable, beta, 0.`
    );
  }

  const adminResponse = await client.request(
    `/plugins/${encodeURIComponent(slug)}?activetab=admin`
  );
  if (adminResponse.status !== 200) {
    throw new Error(
      `GET /plugins/${slug}?activetab=admin failed with status ${adminResponse.status}`
    );
  }
  const html = await adminResponse.text();
  const current = parseBuildEditModal(html, buildId);

  const body = new URLSearchParams({
    multireqtoken: current.multireqtoken,
    action: 'edit-build',
    activetab: 'admin',
    id_build: buildId,
    status,
    min_php: overrides.min_php ?? current.min_php,
    min_core: overrides.min_core ?? current.min_core,
    max_core: overrides.max_core ?? current.max_core,
  });

  const response = await client.request(
    `/plugins/${encodeURIComponent(slug)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }
  );
  const resultHtml = await response.text();

  // Verify: reload the modal state and check status is what we requested.
  const reload = await client.request(
    `/plugins/${encodeURIComponent(slug)}?activetab=admin`
  );
  const reloadedHtml = await reload.text();
  const reloaded = parseBuildEditModal(reloadedHtml, buildId);
  if (reloaded.status !== status) {
    const alerts = Array.from(resultHtml.matchAll(/alert-[\w-]+[\s\S]*?<\/div>/g))
      .map((m) => m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      .slice(0, 3);
    throw new Error(
      `Build ${buildId} status did not update to "${status}" (still "${reloaded.status}"). ${
        alerts.length ? 'Forja: ' + alerts.join(' | ') : ''
      }`
    );
  }

  return { buildId, status: reloaded.status, previous: current };
}

/**
 * Normalize a semver-ish version string so the forja (which stores a float)
 * does not reject it. The forja `version` input is type="number" so we
 * send the numeric portion that floatval() would keep, but we keep the
 * display version for logs.
 *
 * @param {string} version
 */
export function normalizeVersionForForja(version) {
  const raw = String(version).trim().replace(/^v/i, '');
  if (/^\d+(\.\d+)?$/.test(raw)) return raw;
  const parts = raw.split('.');
  const major = Number(parts[0] || '0');
  const minor = Number(parts[1] || '0');
  const patch = Number(parts[2] || '0');
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    throw new Error(`Cannot parse version "${version}" as numeric.`);
  }
  return `${major}.${String(minor).padStart(2, '0')}${String(patch).padStart(2, '0')}`;
}
