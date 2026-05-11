// @cockpit/feature-console (server) — server-side bridges, managers, and
// terminal orchestration. Consumed by:
//   - src/lib/wsServer.ts (WebSocket server-side hub)
//   - src/app/api/{db,mysql,neo4j,redis,jupyter,terminal,...}/route.ts handlers

// ============================================
// Plugin server-side managers
// ============================================
export * from './plugins/browser/BrowserBridge';
export * from './plugins/database/PgPoolManager';
export * from './plugins/jupyter/JupyterKernelManager';
export * from './plugins/mysql/MySQLPoolManager';
export * from './plugins/neo4j/Neo4jManager';
export * from './plugins/redis/RedisManager';

// ============================================
// Terminal
// ============================================
export * from './terminal/TerminalBridge';
export * from './terminal/RunningCommandRegistry';
