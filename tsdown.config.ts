/**
 * tsdown build for dsh-learn: the Node/ESM host-half lib (lib/index.js) plus
 * one browser client bundle (lib/client.js). The client bundle replicates the
 * official DSH client-bundle preset's closure-factory wrapping
 * (packages/client/tsdown.client.ts `clientConfig()`), since that preset lives
 * in the DSH source workspace and is not published for external plugins to
 * import: the bundle registers itself via
 * `window.__ModuleLoader__.load({ id, factory: (require) => { ...; return
 * module.exports } })`, resolving `react`/`react-dom`/`cordis` through the
 * injected `require` (the browser module table) instead of bundling its own
 * copies.
 */
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/**
 * CSS Modules support: the client bundle is a single flat CJS script loaded
 * via `window.__ModuleLoader__.load(...)` (see below) with no separate
 * asset-serving route, so the generic `@tsdown/css` package (which emits a
 * standalone `.css` file) does not fit. This mirrors dsh-better-sidebar's
 * own `makeCssPlugin` (tsdown.config.ts): compile `*.module.css` to a hashed
 * class map with lightningcss and inject the CSS text as a `<style>` tag at
 * factory execution — no separate asset, no runtime fetch.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-learn-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function cssModulesPlugin(): NonNullable<UserConfig['plugins']> {
  return {
    name: 'dsh-learn-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer === undefined ? source : resolvePath(dirname(importer), source)
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      const tagId = `dsh-learn/${basename(fileId)}`
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
        `  const tag = document.createElement('style');`,
        `  tag.dataset.plugin = 'dsh-learn';`,
        `  tag.dataset.pluginCss = tagId;`,
        `  tag.textContent = css;`,
        `  document.head.appendChild(tag);`,
        `}`,
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

/** Runtime-provided modules the loader module table answers for every bundle
 *  (the official PLATFORM_MODULES entries this plugin actually touches:
 *  react/react-dom/react-dom/client/cordis are always available, ui-primitives
 *  is where `MarkdownText` comes from for the transcript pane, and
 *  react-dom/client is where the mermaid diagram mount uses `createRoot`). */
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
])

const PACKAGE_ID = 'dsh-learn'

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => CLIENT_EXTERNALS.has(specifier),
      alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.has(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    plugins: [cssModulesPlugin()],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: () => `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      // mermaid uses dynamic import() internally for its per-diagram-type
      // renderers; without this, rolldown honors those and fans the single
      // client.js entry out into 180+ separate .cjs files linked by plain
      // relative require() calls that the browser module-loader's injected
      // require (a named-specifier lookup, not a filesystem loader) cannot
      // resolve. One flat file is what the __ModuleLoader__ factory shape
      // requires anyway (dsh-better-sidebar's own chunk builds set this for
      // the same reason — see its tsdown.config.ts `chunkBundle()`).
      codeSplitting: false,
    },
  },
] satisfies UserConfig[]
