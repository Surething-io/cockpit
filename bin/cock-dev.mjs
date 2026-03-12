#!/usr/bin/env node

// cock-dev: cock 的 dev 模式快捷入口，默认连接 dev server (port 3456)
process.env.COCKPIT_PORT = process.env.COCKPIT_PORT || '3456';
await import('./cock.mjs');
