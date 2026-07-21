// @cockpit/feature-console (server) — server-side bridges, managers, and
// terminal orchestration. Consumed by:
//   - src/lib/wsServer.ts (WebSocket server-side hub)
//   - src/app/api/{db,mysql,neo4j,redis,jupyter,terminal,...}/route.ts handlers

// ============================================
// Plugin server-side managers
// ============================================
// Pg / MySQL / Redis / Neo4j no longer use module-level singletons — connection
// state is owned by the corresponding `Layer.scoped` and the db/* routes consume
// the PgService / MySQLService / RedisService / Neo4jService Tags directly.
export * from './plugins/browser/BrowserBridge';
export * from './plugins/jupyter/JupyterKernelManager';
// Neo4j pure helpers (driver creation + cypher serialization) — consumed by effect/neo4jLive.ts.
export * from './plugins/neo4j/neo4jCore';

// ============================================
// Terminal
// ============================================
export * from './terminal/TerminalBridge';
export * from './terminal/RunningCommandRegistry';
export * from './terminal/writeStdin';
export * from './terminal/outputQuery';

// Bubble-titles helper (used by /api/connection/list to join titles
// into the unified bubble listing). The route handlers live in
// ./api/terminal/bubble-order.ts and are mounted via src/app/api/...
export { readBubbleTitles } from './api/terminal/bubble-order';

// Services config — legacy `string[]` → `{name, command}[]` upgrade, consumed
// by src/app/api/services/config/route.ts.
export { normalizeCustomCommands, type CustomCommand } from './api/services-config';
