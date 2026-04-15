# action-facturascripts-publicar-forja

GitHub Action that uploads a plugin ZIP as a new build on the [FacturaScripts forja](https://facturascripts.com/forja) after a release.

## What it does

1. Logs into `https://facturascripts.com` with `fsNick` + `fsPassword`.
2. Fetches the admin tab of the plugin page to grab a fresh `multireqtoken` CSRF token from the `#f_add_build` form.
3. Posts the plugin ZIP as `multipart/form-data` with `action=add-build`.
4. Parses the response to confirm that a new build row was added and exposes its id as an output.

The forja stores the build version as a numeric value (`floatval`), so semver tags such as `1.2.3` are transparently encoded as a monotonic float (e.g. `1.0203`) before upload. Pass `normalize-version: false` to send the tag verbatim.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `plugin-slug` | ✅ | — | Plugin slug on the forja (lowercase). E.g. `quickcreate`, `aiscan`. |
| `zip-path` | ✅ | — | Local path to the ZIP produced by the release job. |
| `version` | ✅ | — | Version for the build. Integer, `x.y`, `x.y.z` or `vX.Y.Z` accepted. |
| `forja-user` | ✅ | — | Forja login nick. Use a GitHub secret. |
| `forja-password` | ✅ | — | Forja password. Use a GitHub secret. |
| `forja-url` | ❌ | `https://facturascripts.com` | Base URL of the forja. |
| `normalize-version` | ❌ | `true` | Encode semver into a forja-compatible float. Set to `false` to send the tag as-is. |
| `dry-run` | ❌ | `false` | Log in, resolve the CSRF token and build the request but do not post it. |

## Outputs

| Output | Description |
|---|---|
| `build-id` | Id of the new build row on the forja. |
| `build-version` | Version stored on the forja (post-normalization). |
| `build-url` | Plugin admin URL anchored to the new build modal. |

## Usage

Add a step after your existing release job:

```yaml
name: Release

on:
  push:
    tags:
      - '[0-9]*'
      - 'v[0-9]*'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Build plugin zip
        id: zip
        run: |
          VERSION=${GITHUB_REF_NAME#v}
          echo "VERSION=$VERSION" >> $GITHUB_OUTPUT
          sed -i "s/^version.*/version = $VERSION/" facturascripts.ini
          git archive --format=zip --prefix=QuickCreate/ HEAD -o QuickCreate-$VERSION.zip

      - uses: softprops/action-gh-release@v2
        with:
          files: QuickCreate-${{ steps.zip.outputs.VERSION }}.zip

      - name: Publish to FacturaScripts forja
        uses: erseco/action-facturascripts-publicar-forja@v1
        with:
          plugin-slug: quickcreate
          zip-path: QuickCreate-${{ steps.zip.outputs.VERSION }}.zip
          version: ${{ steps.zip.outputs.VERSION }}
          forja-user: ${{ secrets.FS_FORJA_USER }}
          forja-password: ${{ secrets.FS_FORJA_PASSWORD }}
```

### Required secrets

Set on each plugin repo (or at the organization level to share across plugins):

- `FS_FORJA_USER` — your forja login nick
- `FS_FORJA_PASSWORD` — your forja password

```bash
gh secret set FS_FORJA_USER --repo erseco/facturascripts-plugin-quickcreate
gh secret set FS_FORJA_PASSWORD --repo erseco/facturascripts-plugin-quickcreate
```

## Development

```bash
npm install
npm test          # unit tests (no network)
npm run build     # bundle to dist/index.cjs
```

### Local end-to-end dry-run

Create a `.env` (never commit it):

```
FS_FORJA_USER=your_nick
FS_FORJA_PASSWORD=your_password
```

Then:

```bash
node scripts/dry-run.js quickcreate ./QuickCreate-7.1.zip 7.1         # dry run, no upload
node scripts/dry-run.js quickcreate ./QuickCreate-7.1.zip 7.1 --send  # actual upload
```

## ZIP layout requirements

The forja validates the uploaded archive server-side. All of the following
must match the plugin's registered name, **case-sensitive**:

1. The top-level folder inside the ZIP (e.g. `QuickCreate/`).
2. The `name` field inside `facturascripts.ini`
   (e.g. `name = 'QuickCreate'`).
3. The plugin name stored on the forja when the plugin was first
   registered.

For most plugins that name is the same string as the URL slug lowercased
(`quickcreate` for `QuickCreate`), but not always — the `test` plugin is
registered as `test` with folder `test/` and `name = 'test'`.

If the upload fails with `El nombre de la carpeta del zip debe ser X, en
lugar de Y` or `Encontrado name = X en el archivo facturascripts.ini, pero
se esperaba name = Y`, align all three fields to match the expected value
reported in the error message.

## Reverse engineering notes

Captured from `https://facturascripts.com/plugins/quickcreate?activetab=admin`
on 2026-04-15, verified end-to-end by publishing build `3474` to
`https://facturascripts.com/plugins/test`.

**Login** — `POST /MeLogin`, `application/x-www-form-urlencoded`
- `multireqtoken` — CSRF token from a prior `GET /MeLogin`
- `action=login`
- `return=/`
- `email` — the user's email (not the internal `fsNick`)
- `passwd`

Successful login issues two `HttpOnly` cookies: `fsIdcontacto` and
`fsLogkey`. Both are required for subsequent requests.

**Publish** — `POST /plugins/{slug}`, `multipart/form-data`, form id
`f_add_build`
- `multireqtoken` — CSRF token from `GET /plugins/{slug}?activetab=admin`,
  scoped to the `#f_add_build` form
- `action=add-build`
- `activetab=admin`
- `version` — numeric, stored via PHP `floatval`
- `zip` — the plugin archive (max 99 MB), must satisfy the layout rules
  above

## License

MIT
