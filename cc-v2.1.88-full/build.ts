/**
 * Build decompiled Claude Code v2.1.88 from source map.
 *
 * Strategy:
 * 1. Pre-scan all src/ files for named imports
 * 2. Build with bun, shimming bun:bundle and stubbing missing modules
 * 3. Generate per-stub exports matching what importers expect
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { builtinModules } from 'module'
import { extname, resolve, join } from 'path'

// ── Feature flags ──
// Full-feature build policy: enable every compile-time feature(...) gate found
// in source except a short denylist of clearly non-production/internal toggles.
const EXCLUDED_FEATURES = new Set([
  'ABLATION_BASELINE', // experiment control arm, not a user-facing capability
  'ALLOW_TEST_VERSIONS', // updater/dev test path
  'ANTI_DISTILLATION_CC', // upstream rejects anti_distillation payloads in this local/public path
  'BUDDY', // companion observer path is incomplete in this source drop
  'EXPERIMENTAL_SKILL_SEARCH', // skillSearch runtime modules are missing from this source drop
  'HARD_FAIL', // deliberate fault-injection behavior
  'HISTORY_SNIP', // snip projection runtime is missing from this source drop
  'OVERFLOW_TEST_TOOL', // internal test tool
  'IS_LIBC_GLIBC', // platform marker (must not be globally forced on)
  'IS_LIBC_MUSL', // platform marker (must not be globally forced on)
  'KAIROS', // assistant entrypoints are incomplete in this source drop
  'KAIROS_DREAM', // bundled dream skill is missing from this source drop
  'PROACTIVE', // proactive runtime modules are missing from this source drop
  'REACTIVE_COMPACT', // reactive compact runtime module is missing from this source drop
  'REVIEW_ARTIFACT', // bundled hunter skill is missing from this source drop
  'RUN_SKILL_GENERATOR', // bundled runSkillGenerator skill is missing
  'UDS_INBOX', // UDS inbox runtime is incomplete in this source drop
  'WEB_BROWSER_TOOL', // web browser tool runtime/UI is missing from this source drop
  'WORKFLOW_SCRIPTS', // workflow tool/commands are incomplete in this source drop
])

// ── Build-time macros ──
const MACROS: Record<string, string> = {
  'MACRO.VERSION': '"2.1.88-dev"',
  'MACRO.BUILD_TIME': `"${new Date().toISOString()}"`,
  'MACRO.PACKAGE_URL': '"@anthropic-ai/claude-code"',
  'MACRO.README_URL': '"https://code.claude.com/docs/en/overview"',
  'MACRO.ISSUES_EXPLAINER': '"report the issue at https://github.com/anthropics/claude-code/issues"',
  'MACRO.FEEDBACK_CHANNEL': '"https://github.com/anthropics/claude-code/issues"',
  'MACRO.NATIVE_PACKAGE_URL': '"@anthropic-ai/claude-code"',
  'MACRO.VERSION_CHANGELOG': '""',
}

const STRICT_PARITY = process.env.CC_STRICT_PARITY === '1'
const FEATURE_SHIM_SPECIFIER = '__zenfun_bun_bundle__'
const PROJECT_ROOT = resolve('.')

const stubbedImports = new Map<string, Set<string>>()
const discoveredFeatureFlags = new Set<string>()
function recordStub(specifier: string, importer?: string) {
  if (!stubbedImports.has(specifier)) {
    stubbedImports.set(specifier, new Set())
  }
  if (importer) {
    stubbedImports.get(specifier)!.add(importer)
  }
}

// ── External npm packages to stub ──
// Keep this empty by default. If a private/internal package is unavailable in
// a local environment, add it here temporarily with a runtime fallback.
const STUB_PACKAGES = new Set<string>([
  '@ant/computer-use-input',
  '@ant/computer-use-mcp',
  '@ant/computer-use-swift',
  'audio-capture-napi',
])

// ── Pre-scan: collect all named imports per module specifier ──
console.log('Pre-scanning imports...')
const allImports = new Map<string, Set<string>>()

function scanDir(dir: string) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      scanDir(full)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      const text = readFileSync(full, 'utf-8')
      const featureRe = /feature\(\s*['"]([^'"]+)['"]\s*\)/g
      let fm: RegExpExecArray | null
      while ((fm = featureRe.exec(text)) !== null) {
        discoveredFeatureFlags.add(fm[1])
      }
      // Skip `import type { ... }` — only match value imports
      const re = /import\s+(?!type\s)\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g
      let m
      while ((m = re.exec(text)) !== null) {
        const names = m[1].split(',')
          .map(n => n.trim())
          .filter(n => !n.startsWith('type '))  // skip `type Foo` inline
          .map(n => n.split(/\s+as\s+/)[0].trim())
          .filter(Boolean)
        const mod = m[2]
        if (!allImports.has(mod)) allImports.set(mod, new Set())
        for (const n of names) allImports.get(mod)!.add(n)
      }
      // Also match: import X from '...'
      const defaultRe = /import\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g
      while ((m = defaultRe.exec(text)) !== null) {
        const mod = m[2]
        if (!allImports.has(mod)) allImports.set(mod, new Set())
      }

      // Also match CommonJS-style property access: require("...").Foo
      const requirePropRe = /require\(\s*['"]([^'"]+)['"]\s*\)\.([A-Za-z_$][\w$]*)/g
      while ((m = requirePropRe.exec(text)) !== null) {
        const mod = m[1]
        const prop = m[2]
        if (!allImports.has(mod)) allImports.set(mod, new Set())
        if (prop !== 'default') {
          allImports.get(mod)!.add(prop)
        }
      }
    }
  }
}
scanDir('./src')
console.log(`  Found ${allImports.size} unique module specifiers`)
const enabledFeatureList = [...discoveredFeatureFlags]
  .filter(name => !EXCLUDED_FEATURES.has(name))
  .sort((a, b) => a.localeCompare(b))
const excludedDiscoveredFeatures = [...discoveredFeatureFlags]
  .filter(name => EXCLUDED_FEATURES.has(name))
  .sort((a, b) => a.localeCompare(b))
const ENABLED_FEATURES = new Set(enabledFeatureList)
console.log(
  `  Feature gates: enabled ${enabledFeatureList.length}, excluded ${excludedDiscoveredFeatures.length}`,
)
if (excludedDiscoveredFeatures.length > 0) {
  console.log(`  Excluded features: ${excludedDiscoveredFeatures.join(', ')}`)
}

function generateStub(modulePath: string): string {
  if (modulePath === '@anthropic-ai/sandbox-runtime') {
    return `
      const noop = Object.assign(() => {}, { __esModule: true });
      noop.prototype = {};
      const emptyStore = {
        subscribe: () => () => {},
        getTotalCount: () => 0,
      };
      export const SandboxRuntimeConfigSchema = { parse: (v) => v };
      export class SandboxViolationStore {
        subscribe() { return () => {}; }
        getTotalCount() { return 0; }
      }
      export const SandboxManager = {
        initialize: async () => {},
        updateConfig: () => {},
        reset: async () => {},
        wrapWithSandbox: async (command) => command,
        checkDependencies: () => ({ errors: ['sandbox-runtime unavailable'], warnings: [] }),
        isSupportedPlatform: () => false,
        getFsReadConfig: () => ({ allowOnly: [], denyWithinAllow: [] }),
        getFsWriteConfig: () => ({ allowOnly: [], denyWithinAllow: [] }),
        getNetworkRestrictionConfig: () => ({ allowedDomains: [], deniedDomains: [] }),
        getIgnoreViolations: () => ({}),
        getAllowUnixSockets: () => false,
        getAllowLocalBinding: () => false,
        getEnableWeakerNestedSandbox: () => false,
        getProxyPort: () => undefined,
        getSocksProxyPort: () => undefined,
        getLinuxHttpSocketPath: () => undefined,
        getLinuxSocksSocketPath: () => undefined,
        waitForNetworkInitialization: async () => {},
        getSandboxViolationStore: () => emptyStore,
        annotateStderrWithSandboxFailures: (_command, stderr) => stderr ?? '',
        cleanupAfterCommand: () => {},
      };
      export default { SandboxManager, SandboxRuntimeConfigSchema, SandboxViolationStore };
      export const __esModule = true;
    `
  }

  const names = allImports.get(modulePath) ?? new Set()
  // Also check without .js → .ts mapping
  const alt = modulePath.replace(/\.js$/, '')
  const altNames = allImports.get(alt)
  if (altNames) for (const n of altNames) names.add(n)

  const exports = [...names]
    .filter(n => /^[a-zA-Z_$]/.test(n))
    .map(n => {
      if (/Tool$/.test(n)) {
        return `export const ${n} = { name: ${JSON.stringify(n)}, aliases: [], isEnabled: () => false };`
      }
      // UPPER_CASE names ending in S are likely arrays
      if (/^[A-Z][A-Z_]*S$/.test(n)) return `export const ${n} = [];`
      return `export const ${n} = noop;`
    })
    .join('\n')

  return `
    const noop = Object.assign(() => {}, { __esModule: true });
    noop.prototype = {};
    export default noop;
    export const __esModule = true;
    ${exports}
  `
}

// ── Resolve helpers ──
function canResolveRelative(importer: string, specifier: string): boolean {
  const dir = importer.replace(/\/[^/]+$/, '')
  const candidates = [
    specifier,
    specifier.replace(/\.js$/, '.ts'),
    specifier.replace(/\.js$/, '.tsx'),
    specifier.replace(/\.jsx$/, '.tsx'),
    specifier + '.ts',
    specifier + '.tsx',
    specifier + '/index.ts',
    specifier.replace(/\.js$/, '/index.ts'),
  ]
  return candidates.some(c => existsSync(resolve(dir, c)))
}

function canResolveSrc(specifier: string): boolean {
  const rel = specifier.replace(/^src\//, '')
  const candidates = [
    rel,
    rel.replace(/\.js$/, '.ts'),
    rel.replace(/\.js$/, '.tsx'),
  ]
  return candidates.some(c => existsSync(resolve('./src', c)))
}

function resolveImportFile(importer: string | undefined, specifier: string): string | undefined {
  if (specifier.startsWith('/')) {
    return existsSync(specifier) ? specifier : undefined
  }
  if (specifier.startsWith('src/')) {
    const abs = resolve('./src', specifier.replace(/^src\//, ''))
    return existsSync(abs) ? abs : undefined
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!importer) return undefined
    const dir = importer.replace(/\/[^/]+$/, '')
    const abs = resolve(dir, specifier)
    return existsSync(abs) ? abs : undefined
  }
  return undefined
}

function getLoaderForFile(filePath: string): 'js' | 'jsx' | 'ts' | 'tsx' {
  const extension = extname(filePath)
  switch (extension) {
    case '.tsx':
      return 'tsx'
    case '.ts':
      return 'ts'
    case '.jsx':
      return 'jsx'
    default:
      return 'js'
  }
}

function shouldRewriteProjectSource(filePath: string): boolean {
  if (!filePath.startsWith(PROJECT_ROOT)) return false
  if (filePath.includes('/node_modules/')) return false
  return /\.(c|m)?[jt]sx?$/.test(filePath)
}

function rewriteBundleImport(contents: string): string {
  return contents
    .replaceAll("'bun:bundle'", `'${FEATURE_SHIM_SPECIFIER}'`)
    .replaceAll('"bun:bundle"', `"${FEATURE_SHIM_SPECIFIER}"`)
}

// ── Build ──
console.log('Building...')
for (const staleFile of ['./dist/cli.js', './dist/cli.js.map']) {
  if (existsSync(staleFile)) {
    unlinkSync(staleFile)
  }
}
const EXTERNALS = [
  '@anthropic-ai/tokenizer-*',
  // Bun currently drops the GrowthBook class binding in the bundled output,
  // leaving `new GrowthBook(...)` as an unbound identifier at runtime.
  // Keep it external so Node resolves the real package from node_modules.
  '@growthbook/growthbook',
  '@growthbook/growthbook/*',
  // Keep MCPB runtime external to preserve its prompt stack exactly as shipped.
  // Bun can otherwise mis-bundle @inquirer/prompts re-exports.
  '@anthropic-ai/mcpb',
  '@anthropic-ai/mcpb/*',
  '@inquirer/*',
  // These are intentionally loaded via dynamic import in specific features.
  '@aws-sdk/credential-providers',
  'cli-highlight',
  'cacache',
  'image-processor-napi',
  '@img/sharp-*',
  'fsevents',
  'tree-sitter',
  'tree-sitter-bash',
  '*.node',
  // Bun currently mis-bundles parts of zod v4 internals (e.g. _gte3),
  // so keep zod external for runtime correctness.
  'zod',
  'zod/*',
]

const result = await Bun.build({
  entrypoints: ['./src/entrypoints/cli.tsx'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  sourcemap: 'external',
  minify: false,
  define: MACROS,
  external: EXTERNALS,
  plugins: [
    {
      name: 'cc-build',
      setup(build) {
        // 1. Rewrite project sources so Bun does not intercept bun:bundle as a
        // builtin macro before our feature shim sees it.
        build.onLoad({ filter: /\.(c|m)?[jt]sx?$/ }, args => {
          if (!shouldRewriteProjectSource(args.path)) return undefined
          return {
            contents: rewriteBundleImport(readFileSync(args.path, 'utf-8')),
            loader: getLoaderForFile(args.path),
          }
        })

        // 2. Shim compile-time feature() checks through a virtual module.
        build.onResolve({ filter: /^(__zenfun_bun_bundle__|bun:bundle)$/ }, () => ({
          path: FEATURE_SHIM_SPECIFIER,
          namespace: 'shim',
        }))
        build.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
          contents: `export function feature(name) {
            return ${JSON.stringify([...ENABLED_FEATURES])}.includes(name);
          }`,
          loader: 'js',
        }))

        // 3. Stub missing npm packages
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.path.startsWith('.') || args.path.startsWith('/') || args.path.startsWith('src/')) return undefined
          if (args.path.startsWith('bun:') || args.path === FEATURE_SHIM_SPECIFIER) return undefined
          const pkg = args.path.startsWith('@')
            ? args.path.split('/').slice(0, 2).join('/')
            : args.path.split('/')[0]
          if (STUB_PACKAGES.has(pkg)) {
            recordStub(args.path, args.importer)
            return { path: args.path, namespace: 'stub' }
          }
          return undefined
        })

        // 4. Stub src/ absolute imports
        build.onResolve({ filter: /^src\// }, (args) => {
          if (canResolveSrc(args.path)) return undefined
          recordStub(args.path, args.importer)
          return { path: args.path, namespace: 'stub' }
        })

        // 4c. Resolve plain-text prompt/doc assets as inlined text; only stub
        // if the file is missing from the source drop.
        build.onResolve({ filter: /\.(md|txt)$/ }, (args) => {
          if (args.importer?.includes('node_modules')) return undefined
          const resolved = resolveImportFile(args.importer, args.path)
          if (resolved) {
            return { path: resolved, namespace: 'text-inline' }
          }
          recordStub(args.path, args.importer)
          return { path: args.path, namespace: 'stub-text' }
        })

        // 5. Stub missing relative imports (only in src/)
        build.onResolve({ filter: /^\./ }, (args) => {
          if (!args.importer || args.importer.includes('node_modules')) return undefined
          if (canResolveRelative(args.importer, args.path)) return undefined
          recordStub(args.path, args.importer)
          return { path: args.path, namespace: 'stub' }
        })

        // 6. Plain-text loader / fallback stub
        build.onLoad({ filter: /.*/, namespace: 'text-inline' }, (args) => ({
          contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf-8'))};`,
          loader: 'js',
        }))
        build.onLoad({ filter: /.*/, namespace: 'stub-text' }, () => ({
          contents: 'export default "";',
          loader: 'js',
        }))

        // 7. Stub loader
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: generateStub(args.path),
          loader: 'js',
        }))
      },
    },
  ],
})

if (!result.success) {
  console.error('Build failed:')
  for (const msg of result.logs) {
    console.error(msg)
  }
  process.exit(1)
} else {
  console.log(`\nBuild succeeded: ${result.outputs.length} output(s)`)
  for (const out of result.outputs) {
    console.log(`  ${out.path} (${(out.size / 1024 / 1024).toFixed(1)} MB)`)
  }

  // ── Post-build: patch missing bundler symbols ──
  // bun's bundler drops some default re-exports (lodash-es, execa internals).
  // We detect undefined `defaultN` references and inject shims.
  console.log('\nPost-build patching...')
  const cliPath = './dist/cli.js'
  let code = readFileSync(cliPath, 'utf-8')

  // Find all defaultN references that are never defined
  const usedDefaults = new Set(code.match(/\bdefault\d+\b/g) ?? [])
  const definedPattern = /(?:var|const|let|function)\s+(default\d+)\b/g
  const definedDefaults = new Set<string>()
  let dm
  while ((dm = definedPattern.exec(code)) !== null) {
    definedDefaults.add(dm[1])
  }
  // Also check assignment targets: `default123 =` at start of line or after semicolon
  const assignPattern = /(?:^|[;{])\s*(default\d+)\s*=/gm
  while ((dm = assignPattern.exec(code)) !== null) {
    definedDefaults.add(dm[1])
  }

  const firstNewline = code.indexOf('\n')
  let modified = false
  let patchedSymbolCount = 0

  if (
    code.includes('MaxBufferError') &&
    !/\b(class|var|const|let)\s+MaxBufferError\b/.test(code)
  ) {
    const maxBufferShim = `class MaxBufferError extends Error {
  constructor(message = "Max buffer exceeded") {
    super(message);
    this.name = "MaxBufferError";
  }
}
`
    code = code.slice(0, firstNewline + 1) + maxBufferShim + code.slice(firstNewline + 1)
    modified = true
    patchedSymbolCount += 1
    console.log('  Injected MaxBufferError shim')
  }

  const missing = [...usedDefaults].filter(d => !definedDefaults.has(d))
  if (missing.length > 0) {
    console.log(`  Found ${missing.length} undefined symbols: ${missing.join(', ')}`)

    // Identify each by context
    const patches: string[] = []
    let needsPromptHelpers = false
    const classifyPromptShim = (sym: string): 'input' | 'confirm' | 'select' | null => {
      const pattern = new RegExp(`${sym}\\(\\{`, 'g')
      let hasAny = false
      let hasSelect = false
      let confirmScore = 0
      let inputScore = 0
      let m: RegExpExecArray | null
      while ((m = pattern.exec(code)) !== null) {
        hasAny = true
        const callCtx = code.slice(m.index, m.index + 260)
        if (callCtx.includes('choices:')) hasSelect = true
        if (callCtx.includes('default: true') || callCtx.includes('default: false')) confirmScore += 2
        if (callCtx.includes('validate:')) inputScore += 2
        if (callCtx.includes('default: "') || callCtx.includes("default: '")) inputScore += 1
      }
      if (!hasAny) return null
      if (hasSelect) return 'select'
      if (confirmScore > inputScore) return 'confirm'
      return 'input'
    }
    for (const sym of missing) {
      // Find first usage context
      const idx = code.indexOf(sym + '(')
      if (idx === -1) {
        // Used as a value, not called — likely a comparison function
        const valIdx = code.indexOf(sym)
        if (valIdx !== -1) {
          const ctx = code.slice(Math.max(0, valIdx - 50), valIdx + sym.length + 50)
          if (ctx.includes('isEqual') || ctx.includes('Config')) {
            patches.push(`const ${sym} = (a, b) => JSON.stringify(a) === JSON.stringify(b); // isEqual shim`)
          } else {
            patches.push(`const ${sym} = (...args) => args[0]; // unknown passthrough shim`)
          }
        }
        continue
      }
      const ctx = code.slice(Math.max(0, idx - 100), idx + sym.length + 100)

      // Bun can drop @inquirer/prompts bindings in bundled @anthropic-ai/mcpb.
      // Map missing symbols back to interactive prompt helpers.
      const promptShim = classifyPromptShim(sym)
      if (promptShim === 'select') {
        patches.push(`const ${sym} = __zenfunPromptSelect; // inquirer select shim`)
        needsPromptHelpers = true
      } else if (promptShim === 'confirm') {
        patches.push(`const ${sym} = __zenfunPromptConfirm; // inquirer confirm shim`)
        needsPromptHelpers = true
      } else if (promptShim === 'input') {
        patches.push(`const ${sym} = __zenfunPromptInput; // inquirer input shim`)
        needsPromptHelpers = true
      } else
      if (ctx.includes('memoize') || ctx.includes('getGrowthBook') || ctx.includes('checkDependencies') || ctx.includes('getPrompt')) {
        patches.push(`const ${sym} = (fn) => { let r, c = false; return (...a) => { if (!c) { r = fn(...a); c = true; } return r; }; }; // memoize shim`)
      } else if (ctx.includes('getStream') || ctx.includes('Buffer') || ctx.includes('iterable')) {
        patches.push(`const ${sym} = async (iterable, opts) => { const chunks = []; for await (const c of iterable) chunks.push(typeof c === 'string' ? Buffer.from(c) : c); return Buffer.concat(chunks); }; // getStreamAsBuffer shim`)
      } else if (ctx.includes('isEqual') || ctx.includes('Config')) {
        patches.push(`const ${sym} = (a, b) => JSON.stringify(a) === JSON.stringify(b); // isEqual shim`)
      } else {
        patches.push(`const ${sym} = (...args) => args[0]; // unknown shim`)
        console.log(`  WARNING: Could not identify ${sym}, context: ${ctx.slice(0, 80)}...`)
      }
    }

    if (needsPromptHelpers) {
      patches.unshift(
        `const __zenfunPromptInput = async ({ message = "", default: defaultValue = "", validate } = {}) => {
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const suffix = defaultValue !== undefined && String(defaultValue).length > 0 ? " (" + defaultValue + ")" : "";
      const answer = await rl.question(message + suffix + " ");
      const value = answer === "" && defaultValue !== undefined ? String(defaultValue) : answer;
      if (!validate) return value;
      const result = await validate(value);
      if (result === true || result === undefined) return value;
      if (typeof result === "string" && result.length > 0) stdout.write(result + "\\n");
    }
  } finally {
    rl.close();
  }
};
const __zenfunPromptConfirm = async ({ message = "", default: defaultValue = false } = {}) => {
  const hint = defaultValue ? "Y/n" : "y/N";
  const raw = await __zenfunPromptInput({ message: message + " [" + hint + "]", default: defaultValue ? "y" : "n" });
  return /^y(es)?$/i.test(String(raw).trim());
};
const __zenfunPromptSelect = async ({ message = "", choices = [], default: defaultValue } = {}) => {
  if (!Array.isArray(choices) || choices.length === 0) return defaultValue;
  const items = choices.map((choice, index) => {
    const name = choice && typeof choice === "object" && "name" in choice ? choice.name : String(choice);
    return String(index + 1) + ") " + String(name);
  }).join("\\n");
  const defaultIndex = choices.findIndex(choice => (choice && typeof choice === "object" && "value" in choice ? choice.value : choice) === defaultValue);
  const defaultPick = defaultIndex >= 0 ? String(defaultIndex + 1) : "1";
  const raw = await __zenfunPromptInput({ message: message + "\\n" + items + "\\nChoose", default: defaultPick });
  const picked = Number.parseInt(String(raw), 10);
  const safeIndex = Number.isFinite(picked) && picked >= 1 && picked <= choices.length ? picked - 1 : defaultIndex >= 0 ? defaultIndex : 0;
  const selected = choices[safeIndex];
  return selected && typeof selected === "object" && "value" in selected ? selected.value : selected;
};`
      )
    }

    // Inject after the first import line
    code = code.slice(0, firstNewline + 1) + patches.join('\n') + '\n' + code.slice(firstNewline + 1)
    patchedSymbolCount = patches.length
    modified = true
  } else {
    console.log('  No missing symbols found')
  }

  // Also patch missing zod `util` namespace bindings.
  // Bun may emit `util.normalizeParams(...)` or `utilN.normalizeParams(...)`
  // without preserving the corresponding namespace import.
  const utilMatch = code.match(/\b(util\d*)\.normalizeParams\b/)
  if (utilMatch && !new RegExp(`(?:var|const|let)\\s+${utilMatch[1]}\\s*=`).test(code)) {
    const utilBinding = utilMatch[1]
    // Read the actual zod v4 util module and inline it as a namespace object
    const zodUtilSrc = readFileSync('./node_modules/zod/v4/core/util.js', 'utf-8')
    const exportedNames = [...zodUtilSrc.matchAll(/export\s+(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g)]
      .map(m => m[1])
    const zodUtilBody = zodUtilSrc
      .replace(/export\s+function\s+/g, 'function ')
      .replace(/export\s+const\s+/g, 'const ')
      .replace(/export\s+class\s+/g, 'class ')
    const zodUtilShim = `var ${utilBinding} = (() => {\n${zodUtilBody}\nreturn { ${exportedNames.join(', ')} };\n})();`
    code = code.slice(0, firstNewline + 1) + zodUtilShim + '\n' + code.slice(firstNewline + 1)
    modified = true
    console.log(`  Injected zod v4 util namespace as ${utilBinding}`)
  }

  // Force process.exit after main completes (event loop cleanup)
  const mainWrapped = 'const __forceExitWhenDone = process.argv.includes("-p") || process.argv.includes("--print");'
  if (!code.includes(mainWrapped)) {
    const replaced = code.replace(
      /main2\(\);(\s*\/\/#)/,
      'const __forceExitWhenDone = process.argv.includes("-p") || process.argv.includes("--print"); main2().then(() => { if (__forceExitWhenDone) process.exit(0); }).catch(e => { console.error(e); process.exit(1); });$1'
    )
    if (replaced !== code) {
      code = replaced
      modified = true
    }
    console.log('  Added process.exit to main2()')
  }

  if (modified) {
    writeFileSync(cliPath, code)
    if (patchedSymbolCount > 0) {
      console.log(`  Patched ${patchedSymbolCount} symbols`)
    } else {
      console.log('  Applied post-build runtime patches')
    }
  }

  // ── Build parity report ──
  const builtins = new Set([
    ...builtinModules,
    ...builtinModules.map(m => m.startsWith('node:') ? m.slice(5) : `node:${m}`),
  ])
  const staticRuntimeImports = [...code.matchAll(/^import\s+.*?\s+from\s+"([^"]+)";$/gm)].map(m => m[1])
  const dynamicRuntimeImports = [...code.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map(m => m[1])
  const runtimeImports = [...new Set([...staticRuntimeImports, ...dynamicRuntimeImports])]
  const runtimeExternalImports = [...new Set(runtimeImports.filter(spec => !builtins.has(spec)))]
  const externalMatchers = EXTERNALS.map(pattern =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  )
  const expectedRuntimeExternalImports = runtimeExternalImports.filter(spec =>
    externalMatchers.some(re => re.test(spec))
  )
  const unexpectedRuntimeExternalImports = runtimeExternalImports.filter(spec =>
    !externalMatchers.some(re => re.test(spec))
  )
  const stubEntries = [...stubbedImports.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([specifier, importers]) => ({
      specifier,
      importers: [...importers].sort(),
    }))

  const parityReport = {
    strictParity: STRICT_PARITY,
    timestamp: new Date().toISOString(),
    stubbedModuleCount: stubEntries.length,
    runtimeExternalImportCount: runtimeExternalImports.length,
    expectedRuntimeExternalImportCount: expectedRuntimeExternalImports.length,
    unexpectedRuntimeExternalImportCount: unexpectedRuntimeExternalImports.length,
    configuredExternals: EXTERNALS,
    stubbedModules: stubEntries,
    runtimeExternalImports,
    expectedRuntimeExternalImports,
    unexpectedRuntimeExternalImports,
  }

  writeFileSync('./dist/parity-report.json', JSON.stringify(parityReport, null, 2))
  console.log(`  Wrote parity report: ./dist/parity-report.json`)
  if (stubEntries.length > 0) {
    console.log(`  Stubbed modules: ${stubEntries.length}`)
  }
  if (runtimeExternalImports.length > 0) {
    console.log(`  Runtime external imports: ${runtimeExternalImports.length} (${unexpectedRuntimeExternalImports.length} unexpected)`)
  }

  if (STRICT_PARITY && (stubEntries.length > 0 || unexpectedRuntimeExternalImports.length > 0)) {
    console.error('\nSTRICT_PARITY failed:')
    if (stubEntries.length > 0) {
      console.error(`- stubbed modules: ${stubEntries.length}`)
    }
    if (unexpectedRuntimeExternalImports.length > 0) {
      console.error(`- unexpected runtime external imports: ${unexpectedRuntimeExternalImports.length}`)
    }
    process.exit(2)
  }
}
