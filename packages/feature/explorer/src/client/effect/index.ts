// @cockpit/feature-explorer client Effect wrappers — barrel
//
// Note: these three clients are also re-exported through the top-level
// `feature-explorer` `client/index.ts` (for cross-feature reuse from workspace /
// agent / comments).
export * from "./gitClient"
export * from "./filesClient"
export * from "./lspClient"
