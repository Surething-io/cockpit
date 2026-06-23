const dev = process.env.COCKPIT_ENV === 'dev';

// Empty stub used to short-circuit Node-only modules from browser bundles.
// `web-tree-sitter` references `fs/promises` inside a `process.versions.node`
// guarded branch that the static analyzer still tries to resolve. Turbopack
// expects a path relative to the project root (the config file's directory);
// absolute filesystem paths are treated as server-relative URLs and rejected.
const EMPTY_STUB = './src/lib/empty-stub.js';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // dev 和 prod 使用不同输出目录，避免 Turbopack 热更新影响 prod
  distDir: dev ? '.next' : '.next-prod',
  // Allow loading dev resources (HMR, /_next/*) through tunnels — needed to test
  // the mobile /m route on a real phone via ngrok. Dev-only; wildcards cover the
  // rotating ngrok hostnames so we don't have to edit this each session.
  ...(dev
    ? {
        allowedDevOrigins: [
          '*.ngrok-free.dev',
          '*.ngrok-free.app',
          '*.ngrok.app',
          '*.ngrok.io',
        ],
      }
    : {}),
  // Workspace packages ship raw .ts/.tsx (their package.json `main` points
  // straight at source). Next.js needs to compile them like local source.
  // See MODULES.md for the modularization layout.
  transpilePackages: [
    '@cockpit/shared-ui',
    '@cockpit/shared-utils',
    '@cockpit/shared-i18n',
    '@cockpit/feature-agent',
    '@cockpit/feature-comments',
    '@cockpit/feature-console',
    '@cockpit/feature-explorer',
    '@cockpit/feature-review',
    '@cockpit/feature-skills',
    '@cockpit/feature-workspace',
  ],
  turbopack: {
    // Stub Node built-ins for the BROWSER bundle only. `web-tree-sitter` ships
    // a Node-detection branch full of `await import("fs/promises" | "module" | ...)`
    // calls that the static analyzer tries to resolve, even though they are
    // unreachable at browser runtime. The `browser` condition keeps server
    // code (which legitimately uses these modules) untouched.
    resolveAlias: Object.fromEntries(
      [
        'fs',
        'fs/promises',
        'path',
        'module',
        'os',
        'crypto',
        'stream',
        'child_process',
        'worker_threads',
        'url',
        'tty',
        'util',
      ].flatMap((m) => [
        [m, { browser: EMPTY_STUB }],
        [`node:${m}`, { browser: EMPTY_STUB }],
      ]),
    ),
  },
  // 这些包不让 webpack 打包，运行时从 node_modules 加载
  // claude-agent-sdk: 内部通过 __dirname 定位 cli.js，打包会把路径硬编码为构建机路径
  // node-pty: 原生模块，不能被 webpack 打包
  // web-tree-sitter: 它的 ESM 包对 Node 环境会做 `await import("module")`
  //   来拿 createRequire。一旦被 webpack 打包，"module" 走 webpack 的 chunk
  //   loader (__webpack_require__.t with mode 19)，对 Node built-in 的
  //   namespace 包装跟原生 ESM 不完全一致，destructure 出来的
  //   createRequire 会是 undefined → "createRequire is not a function"。
  //   作为 external 后，Node 用真正的 ESM 解析器加载，import("module")
  //   命中 node:module 内置，行为正常。
  // @vscode/ripgrep: 1.18+ 把二进制拆到平台子包 (e.g. `@vscode/ripgrep-darwin-arm64`)，
  //   主包 lib/index.js 用 `createRequire(import.meta.url).resolve(...)` 在
  //   "自身所在的 node_modules" 里查找子包。一旦被 webpack 打进 chunk，
  //   `import.meta.url` 变成 chunk URL，base 错位 → 找不到平台子包。
  //   externalize 后由 Node 直接 ESM 加载，import.meta.url 是真实文件路径。
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    'node-pty',
    'web-tree-sitter',
    '@vscode/ripgrep',
    // Pure-JS but Node-only (uses node crypto/https); keep it out of any bundle.
    'web-push',
  ],
  // For webpack (used by `next build --webpack`), use the standard fallback
  // mechanism. `false` = "this module is unavailable, drop the import."
  // Mirror the Turbopack list so the two bundlers behave the same.
  webpack(config, { isServer, webpack }) {
    if (!isServer) {
      const stubs = ['fs', 'fs/promises', 'path', 'module', 'os', 'crypto', 'stream', 'child_process', 'worker_threads', 'url', 'tty', 'util'];
      const fallback = { ...(config.resolve?.fallback ?? {}) };
      for (const m of stubs) {
        fallback[m] = false;
        fallback[`node:${m}`] = false;
      }
      config.resolve = { ...config.resolve, fallback };

      // `web-tree-sitter`'s ESM bundle has a Node-detection branch:
      //
      //   var ENVIRONMENT_IS_NODE = typeof process == "object" &&
      //     process.versions?.node && process.type != "renderer";
      //   if (ENVIRONMENT_IS_NODE) {
      //     const { createRequire } = await import("module");
      //     var require = createRequire(import.meta.url);
      //   }
      //
      // Next.js's webpack browser bundle injects a `process` polyfill that
      // exposes `process.versions.node`, so ENVIRONMENT_IS_NODE evaluates
      // truthy at RUNTIME in the browser — entering the branch, dynamic-
      // importing our `module` stub (which exports `{}`), and crashing on
      // `createRequire(...)` with "createRequire is not a function".
      //
      // Defining `process.versions` to an empty object makes
      // `process.versions.node` AND `process.versions?.node` both
      // evaluate to undefined → ENVIRONMENT_IS_NODE = falsy → if-
      // branch dead-coded out of the browser bundle. (DefinePlugin's
      // handling of `?.` is finicky; overriding the parent expression
      // avoids the question entirely.) `process.type = "renderer"` is
      // a belt-and-suspenders second short-circuit on the same check.
      // Server bundle is untouched (gated on !isServer).
      config.plugins = config.plugins ?? [];
      config.plugins.push(
        new webpack.DefinePlugin({
          'process.versions': '({})',
          'process.type': '"renderer"',
        }),
      );
    }
    return config;
  },
};

export default nextConfig;
