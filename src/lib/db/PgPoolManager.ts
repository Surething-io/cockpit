import pg from 'pg';
const { Pool } = pg;
type Pool = InstanceType<typeof Pool>;

interface ManagedPool {
  pool: Pool;
  connectionString: string;
  createdAt: number;
}

class PgPoolManager {
  private pools = new Map<string, ManagedPool>();

  /** Get or create a pool for a given bubble id + connection string */
  async getPool(id: string, connectionString: string): Promise<Pool> {
    const managed = this.pools.get(id);
    if (managed && managed.connectionString === connectionString) {
      return managed.pool;
    }
    if (managed) {
      await managed.pool.end().catch(() => {});
    }
    const pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 60000,
      connectionTimeoutMillis: 10000,
    });
    this.pools.set(id, { pool, connectionString, createdAt: Date.now() });
    return pool;
  }

  /** Disconnect and remove a pool */
  async disconnect(id: string): Promise<void> {
    const managed = this.pools.get(id);
    if (managed) {
      await managed.pool.end().catch(() => {});
      this.pools.delete(id);
    }
  }
}

// Singleton — survives hot module reload in dev via globalThis
const g = globalThis as unknown as { __pgPoolManager?: PgPoolManager };
export const pgPoolManager = g.__pgPoolManager ?? (g.__pgPoolManager = new PgPoolManager());
