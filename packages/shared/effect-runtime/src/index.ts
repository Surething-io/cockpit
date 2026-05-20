// @cockpit/effect-runtime — browser-safe entry
//
// Server code (handler / API routes / wsServer / etc.) must import AppRuntime / handler
// from @cockpit/effect-runtime/server. Browser components can only pull BrowserRuntime /
// BrowserLayer from this module.
export * from "./runtime"
