# action-facturascripts-publicar-forja

GitHub Action que sube un ZIP de plugin como nuevo *build* en la [forja de FacturaScripts](https://facturascripts.com/forja) tras una *release*, con opción de promover automáticamente el build a `stable`, `beta` o `0` (no disponible).

## Qué hace

1. Inicia sesión en `https://facturascripts.com` haciendo `POST /MeLogin` con `email` y `passwd`.
2. Pide la pestaña admin del plugin y extrae un `multireqtoken` fresco del formulario `#f_add_build`.
3. Sube el ZIP como `multipart/form-data` con `action=add-build`.
4. Parsea la respuesta para confirmar que aparece una nueva fila de build y expone su id como `output`.
5. Opcionalmente re-abre el modal de edición del build nuevo y hace un segundo `POST action=edit-build` para fijar su estado (`stable` / `beta` / `0`), preservando `min_php`, `min_core` y `max_core`.

La forja guarda la versión con `floatval`, así que los tags semver tipo `1.2.3` se codifican por defecto en un *float* monótonamente creciente (`1.0203`). Pasa `normalize-version: false` si prefieres enviar el tag literal.

## Entradas

| Entrada | Obligatorio | Por defecto | Descripción |
|---|:---:|---|---|
| `plugin-slug` | ✓ | — | Slug del plugin en la forja en minúsculas (ej. `quickcreate`, `aiscan`). |
| `zip-path` | ✓ | — | Ruta local al ZIP generado por el paso anterior del release. |
| `version` | ✓ | — | Versión del build. Se acepta entero, `x.y`, `x.y.z` o `vX.Y.Z`. |
| `forja-user` | ✓ | — | **Email** con el que entras en facturascripts.com. Usa un secret. |
| `forja-password` | ✓ | — | Contraseña de la forja. Usa un secret. |
| `forja-url` | — | `https://facturascripts.com` | URL base de la forja. |
| `normalize-version` | — | `true` | Si es `true`, semver `x.y.z` se codifica como *float* compatible con la forja. Ponlo a `false` para enviar el tag tal cual. |
| `status` | — | *(vacío)* | Estado final del build nuevo. Uno de `stable`, `beta`, `0`. Si lo dejas vacío, la forja mantiene el estado por defecto (normalmente `beta`). |
| `dry-run` | — | `false` | Si es `true`, hace login y obtiene el CSRF pero no envía el POST de subida. |

## Salidas

| Salida | Descripción |
|---|---|
| `build-id` | Id del nuevo build en la forja. |
| `build-version` | Versión almacenada en la forja (tras normalización). |
| `build-url` | URL al admin del plugin, ancla al modal del build nuevo. |
| `build-status` | Estado final del build si se pasó `status`; vacío si no. |

## Uso

Añade un paso al final de tu workflow de release, después de crear la release en GitHub:

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

      - name: Preparar zip
        id: zip
        run: |
          VERSION=${GITHUB_REF_NAME#v}
          echo "VERSION=$VERSION" >> $GITHUB_OUTPUT
          sed -i "s/^version.*/version = $VERSION/" facturascripts.ini
          git add facturascripts.ini
          git -c user.email=ci@example.com -c user.name=ci commit -m "ci: $VERSION" || true
          git archive --format=zip --prefix=QuickCreate/ HEAD -o QuickCreate-$VERSION.zip

      - uses: softprops/action-gh-release@v2
        with:
          files: QuickCreate-${{ steps.zip.outputs.VERSION }}.zip

      - name: Publicar en la forja
        uses: erseco/action-facturascripts-publicar-forja@v1
        with:
          plugin-slug: quickcreate
          zip-path: QuickCreate-${{ steps.zip.outputs.VERSION }}.zip
          version: ${{ steps.zip.outputs.VERSION }}
          status: stable
          forja-user: ${{ secrets.FS_FORJA_USER }}
          forja-password: ${{ secrets.FS_FORJA_PASSWORD }}
```

### Secrets necesarios

En cada repo de plugin (o a nivel de organización si tienes varios):

- `FS_FORJA_USER` — el **email** con el que inicias sesión en facturascripts.com.
- `FS_FORJA_PASSWORD` — la contraseña de la forja.

```bash
gh secret set FS_FORJA_USER --repo erseco/facturascripts-plugin-quickcreate
gh secret set FS_FORJA_PASSWORD --repo erseco/facturascripts-plugin-quickcreate
```

## Requisitos del ZIP

La forja valida el archivo en el servidor. Los tres campos siguientes deben coincidir **exactamente** (sensible a mayúsculas/minúsculas):

1. La carpeta raíz dentro del ZIP (ej. `QuickCreate/`).
2. El valor del campo `name` en `facturascripts.ini` (ej. `name = 'QuickCreate'`).
3. El nombre con el que el plugin está registrado en la forja.

Para la mayoría de plugins ese nombre coincide con el *slug* de la URL (en minúsculas), pero no siempre — el plugin `test` está registrado como `test` con carpeta `test/` y `name = 'test'`.

Si la subida falla con `El nombre de la carpeta del zip debe ser X, en lugar de Y` o `Encontrado name = X en el archivo facturascripts.ini, pero se esperaba name = Y`, ajusta los tres campos al valor que te indica el mensaje.

## Desarrollo

```bash
npm install
npm test          # tests unitarios (sin red)
npm run build     # bundle a dist/index.cjs
```

### Prueba end-to-end en local

Crea un `.env` (nunca lo commitees):

```
FS_FORJA_USER=tu_email@example.com
FS_FORJA_PASSWORD=tu_password
```

Y lanza:

```bash
# Sin subir (dry run): login + CSRF + construcción del request
node scripts/dry-run.js test ./test-0.2.zip 0.2

# Subida real
node scripts/dry-run.js test ./test-0.2.zip 0.2 --send

# Subida real + promoción a estable
node scripts/dry-run.js test ./test-0.2.zip 0.2 --send --status=stable
```

## Notas de ingeniería inversa

Capturado en `https://facturascripts.com` el 2026-04-15 y verificado subiendo los builds 3474 y 3475 a `https://facturascripts.com/plugins/test`.

**Login** — `POST /MeLogin`, `application/x-www-form-urlencoded`

- `multireqtoken` — token CSRF obtenido de un `GET /MeLogin` previo.
- `action=login`
- `return=/`
- `email` — el email del usuario (no el `fsNick` del core vanilla).
- `passwd`

Un login correcto devuelve dos cookies `HttpOnly`: `fsIdcontacto` y `fsLogkey`, ambas necesarias para las llamadas posteriores.

**Subida de build** — `POST /plugins/{slug}`, `multipart/form-data`, formulario `#f_add_build`

- `multireqtoken` — CSRF del `GET /plugins/{slug}?activetab=admin`, extraído del bloque del formulario `#f_add_build`.
- `action=add-build`
- `activetab=admin`
- `version` — numérico, se almacena con `floatval` en PHP.
- `zip` — el archivo del plugin (máx 99 MB) cumpliendo las reglas de layout de arriba.

**Promoción del build** — `POST /plugins/{slug}`, `application/x-www-form-urlencoded`

- `multireqtoken` — CSRF del modal `#build{id}Modal` en `/plugins/{slug}?activetab=admin`.
- `action=edit-build`
- `activetab=admin`
- `id_build` — id del build a editar.
- `status` — `stable`, `beta` o `0`.
- `min_php`, `min_core`, `max_core` — deben reenviarse (el endpoint no hace update parcial). La action los lee del modal actual antes de enviar la promoción.

## Licencia

MIT
