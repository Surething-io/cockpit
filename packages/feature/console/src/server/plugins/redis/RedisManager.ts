import Redis from 'ioredis';

interface ManagedRedis {
  client: Redis;
  connectionString: string;
  createdAt: number;
}

class RedisManager {
  private clients = new Map<string, ManagedRedis>();

  /** Get or create a Redis client for a given bubble id + connection string */
  async getClient(id: string, connectionString: string): Promise<Redis> {
    const managed = this.clients.get(id);
    if (managed && managed.connectionString === connectionString) {
      // Verify the connection is still alive
      if (managed.client.status === 'ready') return managed.client;
      // Connection dropped — clean up and reconnect
      await managed.client.quit().catch(() => {});
    } else if (managed) {
      await managed.client.quit().catch(() => {});
    }

    const client = new Redis(connectionString, {
      lazyConnect: true,
      connectTimeout: 10000,
      maxRetriesPerRequest: 1,
    });
    await client.connect();
    this.clients.set(id, { client, connectionString, createdAt: Date.now() });
    return client;
  }

  /** Disconnect and remove a client */
  async disconnect(id: string): Promise<void> {
    const managed = this.clients.get(id);
    if (managed) {
      await managed.client.quit().catch(() => {});
      this.clients.delete(id);
    }
  }
}

// Singleton — survives hot module reload in dev via globalThis
const g = globalThis as unknown as { __redisManager?: RedisManager };
export const redisManager = g.__redisManager ?? (g.__redisManager = new RedisManager());
