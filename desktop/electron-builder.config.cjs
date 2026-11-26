// electron-builder configuration. Built by scripts/build.mjs, which pins
// `version` to the root package.json so the app always matches the npm package
// it ships with.
//
// JavaScript rather than YAML so the hooks below can be functions: hooks given
// as paths are resolved against the "workspace root", which electron-builder
// mistakes for this repository's root (it walks up to the first lock file).
const afterPack = require('./scripts/afterPack.cjs').default;

module.exports = {
  appId: 'dev.opencockpit.desktop',
  productName: 'OpenCockpit',
  copyright: 'Copyright © Robert',

  directories: { output: 'dist' },

  files: ['package.json', 'src/**', '!src/**/*.test.mjs'],

  // The app has no runtime dependencies. Returning false tells electron-builder
  // that node_modules are handled elsewhere, so it neither rebuilds nor
  // collects any. Without it, the repo root above is taken for the workspace
  // and its production dependencies (the whole cockpit server) are packed in —
  // or, on CI where the root is not installed, the build fails looking for them.
  beforeBuild: async () => false,

  // Names here are a contract: bin/cock-app.mjs#assetFor downloads exactly these.
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',

  // No code signing (see bin/cock-app.mjs for how distribution works without
  // it). macOS still gets an ad-hoc signature in scripts/afterPack.cjs: Apple
  // Silicon will not run arm64 code without one, and renaming Electron's bundle
  // breaks the signature it came with.
  afterPack,
  publish: null,

  mac: {
    target: ['zip', 'dmg'],
    category: 'public.app-category.developer-tools',
    icon: 'src/launcher/icon.png',
    identity: null,
    hardenedRuntime: false,
  },

  // Zip only, no NSIS installer: an installer keeps its uninstaller and
  // registry entry inside the install directory, which the self-update swaps
  // wholesale. `cockpit app install` does the Windows integration (Start menu).
  win: {
    target: ['zip'],
    icon: 'src/launcher/icon.png',
  },
};
