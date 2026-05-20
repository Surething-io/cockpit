/**
 * Neo4j pure functions — driver creation + runCypher + Bolt result serialization.
 * Shared by v1 Neo4jManager and v2 Neo4jServiceLive.
 */
import neo4j, { Driver, Integer } from "neo4j-driver"

/**
 * Parse bolt URI (supports bolt://, neo4j://, bolt+s://, neo4j+s://, etc.),
 * then create and verify the driver. Throws on connectivity failure.
 */
export async function createNeo4jDriver(
  connectionString: string
): Promise<Driver> {
  const url = new URL(connectionString)
  const scheme = url.protocol.replace(":", "")
  const host = url.hostname
  const port = url.port || "7687"
  const user = decodeURIComponent(url.username || "neo4j")
  const password = decodeURIComponent(url.password || "")

  const uri = `${scheme}://${host}:${port}`
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password))
  await driver.verifyConnectivity()
  return driver
}

export interface CypherResult {
  records: Array<Record<string, unknown>>
  keys: string[]
  duration: number
  counters: unknown
}

/**
 * Execute cypher with the given driver, serializing all bolt types as JSON-friendly POJOs.
 */
export async function runCypherWithDriver(
  driver: Driver,
  cypher: string,
  params?: Record<string, unknown>
): Promise<CypherResult> {
  const session = driver.session()
  try {
    const start = Date.now()
    const result = await session.run(cypher, params || {})
    const duration = Date.now() - start

    const records = result.records.map((record) => {
      const obj: Record<string, unknown> = {}
      for (const key of record.keys) {
        obj[key as string] = serializeValue(record.get(key as string))
      }
      return obj
    })

    return {
      records,
      keys:
        result.records.length > 0
          ? (result.records[0].keys as string[])
          : [],
      duration,
      counters: result.summary.counters.updates(),
    }
  } finally {
    await session.close()
  }
}

/**
 * Recursively serialize bolt values: Integer → number, Node/Relationship/Path → POJO,
 * plain objects / arrays → deep recursion.
 */
export function serializeValue(val: unknown): unknown {
  if (val === null || val === undefined) return null

  // Neo4j Integer
  if (neo4j.isInt(val)) return (val as Integer).toNumber()

  // Node
  if (
    val &&
    typeof val === "object" &&
    "labels" in val &&
    "properties" in val
  ) {
    const node = val as {
      labels: string[]
      properties: Record<string, unknown>
      identity: unknown
    }
    return {
      _type: "node",
      _id: serializeValue(node.identity),
      _labels: node.labels,
      ...Object.fromEntries(
        Object.entries(node.properties).map(([k, v]) => [k, serializeValue(v)])
      ),
    }
  }

  // Relationship
  if (
    val &&
    typeof val === "object" &&
    "type" in val &&
    "start" in val &&
    "end" in val &&
    "properties" in val
  ) {
    const rel = val as {
      type: string
      start: unknown
      end: unknown
      properties: Record<string, unknown>
      identity: unknown
    }
    return {
      _type: "relationship",
      _id: serializeValue(rel.identity),
      _relType: rel.type,
      _start: serializeValue(rel.start),
      _end: serializeValue(rel.end),
      ...Object.fromEntries(
        Object.entries(rel.properties).map(([k, v]) => [k, serializeValue(v)])
      ),
    }
  }

  // Path
  if (val && typeof val === "object" && "segments" in val) {
    const path = val as {
      segments: Array<{ start: unknown; relationship: unknown; end: unknown }>
    }
    return {
      _type: "path",
      segments: path.segments.map((s) => ({
        start: serializeValue(s.start),
        relationship: serializeValue(s.relationship),
        end: serializeValue(s.end),
      })),
    }
  }

  // Array
  if (Array.isArray(val)) return val.map((v) => serializeValue(v))

  // Plain object
  if (val && typeof val === "object" && val.constructor === Object) {
    return Object.fromEntries(
      Object.entries(val).map(([k, v]) => [k, serializeValue(v)])
    )
  }

  return val
}
