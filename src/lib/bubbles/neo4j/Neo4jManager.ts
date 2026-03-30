import neo4j, { Driver, Integer } from 'neo4j-driver';

interface ManagedNeo4j {
  driver: Driver;
  connectionString: string;
  createdAt: number;
}

class Neo4jManager {
  private drivers = new Map<string, ManagedNeo4j>();

  async getDriver(id: string, connectionString: string): Promise<Driver> {
    const existing = this.drivers.get(id);
    if (existing) {
      if (existing.connectionString === connectionString) return existing.driver;
      // Connection string changed, disconnect old
      await this.disconnect(id);
    }

    // Parse URI: bolt://user:pass@host:port
    const url = new URL(connectionString);
    const scheme = url.protocol.replace(':', ''); // bolt, neo4j, bolt+s, etc.
    const host = url.hostname;
    const port = url.port || '7687';
    const user = decodeURIComponent(url.username || 'neo4j');
    const password = decodeURIComponent(url.password || '');

    const uri = `${scheme}://${host}:${port}`;
    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

    // Verify connectivity
    await driver.verifyConnectivity();

    this.drivers.set(id, { driver, connectionString, createdAt: Date.now() });
    return driver;
  }

  async disconnect(id: string): Promise<void> {
    const managed = this.drivers.get(id);
    if (managed) {
      await managed.driver.close().catch(() => {});
      this.drivers.delete(id);
    }
  }

  async runCypher(id: string, connectionString: string, cypher: string, params?: Record<string, unknown>) {
    const driver = await this.getDriver(id, connectionString);
    const session = driver.session();
    try {
      const start = Date.now();
      const result = await session.run(cypher, params || {});
      const duration = Date.now() - start;

      const records = result.records.map(record => {
        const obj: Record<string, unknown> = {};
        for (const key of record.keys) {
          obj[key as string] = this.serializeValue(record.get(key as string));
        }
        return obj;
      });

      return {
        records,
        keys: result.records.length > 0 ? result.records[0].keys : [],
        duration,
        counters: result.summary.counters.updates(),
      };
    } finally {
      await session.close();
    }
  }

  private serializeValue(val: unknown): unknown {
    if (val === null || val === undefined) return null;

    // Neo4j Integer
    if (neo4j.isInt(val)) return (val as Integer).toNumber();

    // Node
    if (val && typeof val === 'object' && 'labels' in val && 'properties' in val) {
      const node = val as { labels: string[]; properties: Record<string, unknown>; identity: unknown };
      return {
        _type: 'node',
        _id: this.serializeValue(node.identity),
        _labels: node.labels,
        ...Object.fromEntries(
          Object.entries(node.properties).map(([k, v]) => [k, this.serializeValue(v)])
        ),
      };
    }

    // Relationship
    if (val && typeof val === 'object' && 'type' in val && 'start' in val && 'end' in val && 'properties' in val) {
      const rel = val as { type: string; start: unknown; end: unknown; properties: Record<string, unknown>; identity: unknown };
      return {
        _type: 'relationship',
        _id: this.serializeValue(rel.identity),
        _relType: rel.type,
        _start: this.serializeValue(rel.start),
        _end: this.serializeValue(rel.end),
        ...Object.fromEntries(
          Object.entries(rel.properties).map(([k, v]) => [k, this.serializeValue(v)])
        ),
      };
    }

    // Path
    if (val && typeof val === 'object' && 'segments' in val) {
      const path = val as { segments: Array<{ start: unknown; relationship: unknown; end: unknown }> };
      return {
        _type: 'path',
        segments: path.segments.map(s => ({
          start: this.serializeValue(s.start),
          relationship: this.serializeValue(s.relationship),
          end: this.serializeValue(s.end),
        })),
      };
    }

    // Array
    if (Array.isArray(val)) return val.map(v => this.serializeValue(v));

    // Plain object
    if (val && typeof val === 'object' && val.constructor === Object) {
      return Object.fromEntries(
        Object.entries(val).map(([k, v]) => [k, this.serializeValue(v)])
      );
    }

    return val;
  }
}

// Singleton (survives hot reload)
const g = globalThis as unknown as { __neo4jManager?: Neo4jManager };
export const neo4jManager = g.__neo4jManager ?? (g.__neo4jManager = new Neo4jManager());
