// filepath: vite.config.js
// ---------------------------------------------------------------------------
// Vite en modo librería (multi-entry). Produce exactamente 2 archivos:
//
//   dist/lumo-api.js   -> Cascarón cliente (window.LumoApi) SIN secretos.
//   dist/sw.js         -> Service Worker empaquetado CON las credenciales
//                         y la URL de Supabase, gracias a `define` las
//                         constantes quedan inyectadas como strings literales.
// ---------------------------------------------------------------------------

import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

// Defaults SOLO para valores no sensibles. Las credenciales de Supabase
// (URL + clave) son OBLIGATORIAS desde .env: si faltan el build falla
// ruidosamente. Esto evita dejar secretos de fallback hardcodeados en
// el repositorio.
const DEFAULT_FICTIONAL_DOMAIN = 'api.lumocolombia.com.co';
const DEFAULT_GRAPHQL_PATH     = '/graphql/v1';
const DEFAULT_CORS_ORIGIN      = '*';

export default defineConfig(({ mode }) => {
  // Carga TODAS las variables del .env (sin importar prefijo) para
  // tener control total desde el archivo de entorno.
  const env = loadEnv(mode, projectRoot, '');

  // Fail-fast: nunca construimos el bundle sin credenciales explícitas.
  if (!env.SUPABASE_URL) {
    throw new Error(
      '[lumo] Falta SUPABASE_URL en .env. ' +
      'Copia .env.example a .env y rellena las variables.'
    );
  }
  if (!env.SUPABASE_ANON_KEY) {
    throw new Error(
      '[lumo] Falta SUPABASE_ANON_KEY en .env. ' +
      'Copia .env.example a .env y rellena las variables.'
    );
  }

  const SUPABASE_URL              = env.SUPABASE_URL;
  const SUPABASE_ANON_KEY         = env.SUPABASE_ANON_KEY;
  const FICTIONAL_DOMAIN          = env.FICTIONAL_DOMAIN || DEFAULT_FICTIONAL_DOMAIN;
  const SUPABASE_GRAPHQL_ENDPOINT = `${SUPABASE_URL}${env.GRAPHQL_PATH || DEFAULT_GRAPHQL_PATH}`;
  const GATEWAY_CORS_ORIGIN       = env.GATEWAY_CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN;

  return {
    // Sustituciones a nivel AST (Rollup). Reemplazan los IDENTIFICADORES
    // exactamente por las cadenas literales en cada módulo importado por
    // el SW. Importante: estas claves NUNCA aparecen en `lumo-api.js`.
    define: {
      __SUPABASE_URL__:              JSON.stringify(SUPABASE_URL),
      __SUPABASE_ANON_KEY__:         JSON.stringify(SUPABASE_ANON_KEY),
      __FICTIONAL_DOMAIN__:          JSON.stringify(FICTIONAL_DOMAIN),
      __SUPABASE_GRAPHQL_ENDPOINT__: JSON.stringify(SUPABASE_GRAPHQL_ENDPOINT),
      __GATEWAY_CORS_ORIGIN__:       JSON.stringify(GATEWAY_CORS_ORIGIN)
    },
    build: {
      target: 'es2020',
      outDir: 'dist',
      emptyOutDir: true,
      minify: false, // false para inspección inicial; cambia a 'esbuild' en prod.
      sourcemap: false,
      cssCodeSplit: false,
      reportCompressedSize: false,
      lib: {
        entry: {
          'lumo-api': resolve(projectRoot, 'src/client/lumo-api.js'),
          sw: resolve(projectRoot, 'src/sw/sw.js')
        },
        formats: ['es'],
        fileName: (format, entryName) => `${entryName}.js`
      },
      rollupOptions: {
        // Cada entry (`lumo-api` y `sw`) es independiente — no comparten
        // módulos ni usan import() dinámico — así que Rollup produce un
        // único archivo por entry sin necesidad de inlineDynamicImports
        // (esa opción es incompatible con múltiples inputs en Rollup).
        output: {
          entryFileNames: (chunk) => `${chunk.name}.js`,
          chunkFileNames: '[name].js',
          assetFileNames: '[name][extname]',
          manualChunks: (id) => {
            // Seguridad adicional: si algún plugin intenta crear un
            // chunk compartido, lo asignamos al `sw` para garantizar
            // que `lumo-api.js` quede 100% limpio.
            // Normalizamos separadores para que el matcher funcione
            // tanto en Windows (`\`) como en POSIX (`/`).
            const norm = String(id).replaceAll('\\', '/');
            if (norm.includes('/src/client/')) return 'lumo-api';
            if (norm.includes('/src/sw/'))     return 'sw';
            return null;
          }
        }
      }
    },
    server: {
      port: 5173,
      headers: {
        // Permite que sw.js controle rutas por encima de su carpeta.
        'Service-Worker-Allowed': '/'
      }
    },
    plugins: [
      // -------------------------------------------------------------------------
      // Plugin `lumo-html-to-dist` (solo build):
      // Copia `src/website/index.html` a `dist/index.html` para que el bundle
      // sirva como entrega autocontenida. `lumo-api.js` y `sw.js` ya viven en
      // `dist/` gracias al `outDir` por defecto; no hace falta tocarlos.
      // La fuente sigue viviendo en `src/` y la raíz del proyecto permanece
      // limpia de artefactos.
      // -------------------------------------------------------------------------
      {
        name: 'lumo-html-to-dist',
        apply: 'build',
        closeBundle() {
          const distDir    = resolve(projectRoot, 'dist');
          const websiteHtml = resolve(projectRoot, 'src/website/index.html');

          if (existsSync(websiteHtml)) {
            const html = readFileSync(websiteHtml, 'utf8');
            writeFileSync(resolve(distDir, 'index.html'), html, 'utf8');
          } else {
            console.warn(
              '[lumo-html-to-dist] No se encontró src/website/index.html; ' +
              'se omite la copia del HTML.'
            );
          }
        }
      },

      // -------------------------------------------------------------------------
      // Plugin `lumo-virtual-html` (solo dev server):
      // Sirve `src/website/index.html` en memoria desde `GET /` sin crear
      // un archivo en la raíz. Para `./lumo-api.js` y `./sw.js` delega en
      // `server.transformRequest`, de modo que Vite aplica su pipeline.
      // El reemplazo de credenciales se hace en una segunda fase del plugin
      // (`transform`) para garantizar que los identificadores `__SUPABASE_URL__`,
      // etc., queden sustituidos también en dev (Vite 5 no aplica `define` de
      // forma consistente sobre los módulos servidos bajo demanda).
      // -------------------------------------------------------------------------
      {
        name: 'lumo-virtual-html',
        apply: 'serve',

        // 2ª fase: sustitución de `define` sobre cualquier módulo cuyo path
        // absoluto pertenezca a la rama SW (`src/sw/*` Y `src/config/*`,
        // ya que las credenciales se inyectan en `src/config/constants.js`).
        // Garantiza que las credenciales viajen embebidas SOLO en la rama
        // del Service Worker.
        transform(code, id) {
          const root       = projectRoot.replaceAll('\\', '/');
          const inSwBranch =
            id.includes(`${root}/src/sw/`) ||
            id.includes(`${root}/src/config/constants.js`);
          if (!inSwBranch) return null;
          let out = code;
          out = out.replaceAll('__SUPABASE_URL__',              JSON.stringify(SUPABASE_URL));
          out = out.replaceAll('__SUPABASE_ANON_KEY__',         JSON.stringify(SUPABASE_ANON_KEY));
          out = out.replaceAll('__FICTIONAL_DOMAIN__',          JSON.stringify(FICTIONAL_DOMAIN));
          out = out.replaceAll('__SUPABASE_GRAPHQL_ENDPOINT__', JSON.stringify(SUPABASE_GRAPHQL_ENDPOINT));
          out = out.replaceAll('__GATEWAY_CORS_ORIGIN__',       JSON.stringify(GATEWAY_CORS_ORIGIN));
          return { code: out, map: null };
        },

        configureServer(server) {
          const websiteHtmlPath = resolve(projectRoot, 'src/website/index.html');
          const libSources = {
            '/lumo-api.js': resolve(projectRoot, 'src/client/lumo-api.js'),
            '/sw.js':       resolve(projectRoot, 'src/sw/sw.js'),
          };

          server.middlewares.use(async (req, res, next) => {
            const rawUrl = req.url || '/';
            const url    = rawUrl.split('?')[0];

            // HTML entry virtual.
            if (url === '/' || url === '/index.html') {
              try {
                const html = readFileSync(websiteHtmlPath, 'utf8');
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
                res.end(html);
              } catch (err) {
                res.statusCode = 500;
                res.end(`lumo-virtual-html: ${err.message}`);
              }
              return;
            }

            // Libs: reescritura virtual hacia los fuentes reales.
            const absSource = libSources[url];
            if (absSource) {
              try {
                const result = await server.transformRequest(absSource);
                if (!result) {
                  res.statusCode = 404;
                  res.end(`lumo-virtual-html: transform vacío para ${url}`);
                  return;
                }
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
                res.end(result.code);
              } catch (err) {
                res.statusCode = 500;
                res.end(`lumo-virtual-html: ${err.message}`);
              }
              return;
            }

            next();
          });
        }
      }
    ]
  };
});
