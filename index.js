import * as core from '@actions/core';
import {
  CookieJar,
  createForjaClient,
  loginToForja,
  publishBuild,
  normalizeVersionForForja,
} from './lib.js';

async function run() {
  try {
    const slug = core.getInput('plugin-slug', { required: true });
    const zipPath = core.getInput('zip-path', { required: true });
    const rawVersion = core.getInput('version', { required: true });
    const username = core.getInput('forja-user', { required: true });
    const password = core.getInput('forja-password', { required: true });
    const baseUrl = core.getInput('forja-url') || 'https://facturascripts.com';
    const dryRun = (core.getInput('dry-run') || '').toLowerCase() === 'true';
    const normalizeVersion =
      (core.getInput('normalize-version') || 'true').toLowerCase() !== 'false';

    core.setSecret(password);

    const version = normalizeVersion
      ? normalizeVersionForForja(rawVersion)
      : rawVersion;

    if (version !== rawVersion) {
      core.info(`Normalized version "${rawVersion}" → "${version}" for forja.`);
    }

    const jar = new CookieJar();
    const client = createForjaClient({ baseUrl, jar });

    core.info(`Logging into ${baseUrl} as ${username}…`);
    await loginToForja(client, { username, password });
    core.info(`Login OK. Session cookies: ${jar.names().join(', ') || '(none visible)'}`);

    core.info(`Publishing ${zipPath} as version ${version} to ${slug}…`);
    const result = await publishBuild(client, {
      slug,
      zipPath,
      version,
      dryRun,
    });

    if (result.dryRun) {
      core.info(
        `Dry run: would POST ${result.url} with ${result.zipBytes} bytes of ${result.zipName}.`
      );
      core.setOutput('build-id', '');
      core.setOutput('build-version', version);
      core.setOutput('build-url', result.url);
      return;
    }

    core.info(`Published build ${result.buildId} (v${result.buildVersion}).`);
    core.setOutput('build-id', result.buildId);
    core.setOutput('build-version', result.buildVersion);
    core.setOutput('build-url', result.buildUrl);
  } catch (error) {
    core.setFailed(`action-facturascripts-publicar-forja failed: ${error.message}`);
  }
}

run();
