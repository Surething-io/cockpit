#!/usr/bin/env node

// cock-dev: dev mode shortcut for cock, connects to dev server (port 3456) by default
process.env.COCKPIT_ENV = 'dev';
process.env.COCKPIT_PORT = process.env.COCKPIT_PORT || '3456';
await import('./cock.mjs');
