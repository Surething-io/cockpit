Cockpit's Console panel auto-detects database connection strings and opens a **database bubble** — a built-in client with a schema browser, a data browser, and a query window, scoped to that one database. No more flipping out to `psql` / `mysql` / DataGrip / RedisInsight just to peek at a row.

Cockpit recognises four database flavours today:

| Database | Trigger connection string | Anchor |
|---|---|---|
| [PostgreSQL](#postgresql) | `postgresql://…` or `postgres://…` | `#postgresql` |
| [MySQL](#mysql) | `mysql://…` | `#mysql` |
| [Redis](#redis) | `redis://…` | `#redis` |
| [Neo4j](#neo4j) | `neo4j://…` or `bolt://…` | `#neo4j` |

The Console input bar parses the URI on paste and opens the right bubble automatically — see [Command Input](/en/docs/console/input-bar/) for the full set of triggers.

## PostgreSQL

A PostgreSQL bubble gives you a connection, a schema browser, and a query window — no need to leave Cockpit for quick lookups.

Open one by pasting a connection string into the Console input bar:

```text
postgresql://user:password@localhost:5432/mydb
```

`postgres://...` also works.

### Layout

The bubble has a schema browser on the left and **three tabs** on the right:

- **Left sidebar: schema tree** — schemas → tables and views → columns. Filter box at the top; click a table to select it.
- **Right "Structure" tab** — the structure of the selected table: columns (type, nullability, default), primary key (🔑 marker), foreign keys (target table / column), indexes (type, fields). **This is where PK/FK/indexes live, not in the schema tree itself.**
- **Right "Data" tab** — the table data, paginated (**50 rows per page** by default).
- **Right "SQL" tab** — query window. Type SQL, press `Cmd/Ctrl+Enter` or click Run, results render as a table below.

### What the Data tab can do

- **Click a column header** to sort ascending / descending.
- **Filter** per column with familiar operators: `=`, `!=`, `>`, `<`, `>=`, `<=`, `LIKE`, `NOT LIKE`, `IN`, `IS NULL`, `IS NOT NULL`.
- **Hover** a cell to see the full content (useful when a long value is truncated; 350ms delay before the tooltip appears).
- **Inline edit** — double-click a cell to change a value, save or cancel.
- **Add new row** — form to insert.
- **Multi-select + delete** — tick rows and confirm.
- **Export** — copy or download selected rows or the whole table as CSV / JSON.
- **Query timing** — shown next to the result count as `xx ms`.

### Common issues

- **Connection refused** — the database isn't reachable from your machine. Check the host / port, your VPN if you need one, and `pg_hba.conf` if it's your own server.
- **Password authentication failed** — wrong credentials in the connection string, or the user doesn't have permission to connect from your IP. URL-encode special characters in the password (`@` → `%40`, etc.).
- **Long queries hang** — Cockpit doesn't auto-cancel long queries. Close the bubble to kill the connection, or run `SELECT pg_cancel_backend(pid)` from another bubble.

## MySQL

The MySQL bubble is **structurally near-identical** to the [PostgreSQL bubble](#postgresql): same left-hand schema tree, same Structure / Data / SQL three tabs, same pagination (50 rows/page), same sorting and filtering, same inline editing and export.

Open one by pasting a connection string:

```text
mysql://user:password@localhost:3306/mydb
```

### Implementation differences from PostgreSQL

Behaviour is the same on the surface; SQL dialect details differ under the hood (mostly invisible to you):

- Identifiers quoted with backticks `` ` `` instead of `"`.
- Row counting uses `COUNT(*) AS cnt`, not PostgreSQL's `::int` cast.
- Deletion uses `DELETE … LIMIT 1`, not PostgreSQL's `ctid` subquery.

### Common issues

- **`Access denied`** — wrong credentials, or the user can't connect from your IP. Check `mysql.user` host grants on the server. URL-encode special characters in the password.
- **`Unknown database`** — the database name in the connection string doesn't exist on the server.
- **TLS handshake failures** — follows standard URI parameters for TLS configuration; if you're connecting to a managed service that requires TLS, check the provider's docs for the right query string.

## Redis

A Redis bubble gives you a key browser, an INFO viewer, and a CLI tab for raw commands. Open one by pasting a connection string:

```text
redis://localhost:6379
redis://:password@host:6379/2
rediss://host:6380       # TLS
```

The URI follows the standard `redis://[:password@]host:port[/db]` form. Use `rediss://` (extra `s`) for TLS. The bubble's title bar shows Redis version, key count, and memory usage.

The bubble has **three tabs** across the top:

### 1. Data tab (key browser)

The default view. You get a list of keys with a filter at the top that takes a Redis pattern (`*`, `?`, `[abc]`). When the database has many keys, a **Load more** button at the bottom pages through them. Click a key to see its value.

Each key shows:

- **Type badge** — `STRING`, `HASH`, `LIST`, `SET`, `ZSET`, `STREAM` — coloured so you can scan a list quickly.
- **Value preview** — the value for `STRING`, the field/value pairs for `HASH`, the items for `LIST` / `SET` / `ZSET`, etc.
- **TTL** — formatted as seconds, minutes, or hours (`60s`, `2m30s`, `1h5m`).

Long values are truncated in the preview; hover or click in for the full content.

### 2. Info tab

Shows the output of the `INFO` command, parsed into sections — replication, memory, connected clients, replication state, and so on. Handy for quick triage without switching to the CLI.

### 3. CLI tab

A raw Redis command line. Supports space-separated arguments and quoted strings. Type any command and hit Enter:

```text
INFO replication
DBSIZE
SCAN 0 MATCH user:* COUNT 100
```

Results are formatted nicely — arrays come back as numbered lists, integers as integers, `(nil)` as `(nil)`.

### Common issues

- **`WRONGPASS`** — password missing or wrong. Include it in the URI: `redis://:yourpassword@host:port`.
- **Connection timeout** — Redis isn't reachable from your machine. Check the host / port; if it's a managed service, verify it allows connections from your IP.
- **`ERR DB index is out of range`** — the `/db` portion of the URI references a database number that doesn't exist (Redis defaults to 16 databases, numbered 0–15).

## Neo4j

A Neo4j bubble lets you explore a graph database — browse the schema, run Cypher queries, and **see results as an actual interactive graph**, not just rows of records.

Open one by pasting a connection string. Neo4j supports four URI schemes; pick whichever your server documentation tells you to use:

```text
neo4j://localhost:7687
neo4j+s://yourdb.databases.neo4j.io       # TLS
bolt://localhost:7687
bolt+s://yourdb.databases.neo4j.io        # TLS
```

The `+s` variants enable TLS. `neo4j://` is the modern scheme (routing-aware); `bolt://` is the older direct-connection scheme.

The bubble has **three tabs**.

### 1. Schema

A read-only overview of the database structure (counts refresh after queries run):

- **Labels** — every node label and how many nodes have it. **Click a label** to fire a query that pulls nodes of that type.
- **Relationship types** — every relationship type and its count. **Click a type** to pull relationships of that kind.
- **Property keys** — all property names used anywhere (listed, not clickable).
- **Indexes** — name, type, fields, state.
- **Constraints** — uniqueness and other constraints.

Use this when you sit down to a database for the first time and need to know what's in it.

### 2. Cypher

A query window. Press `Cmd/Ctrl+Enter` to run:

```cypher
MATCH (p:Person)-[:KNOWS]->(friend)
WHERE p.name = 'Alice'
RETURN p, friend
```

Results render as a table at the bottom — one row per record, with columns for each returned variable.

### 3. Graph

When your Cypher returns nodes and relationships, switch to this tab to see them as an **interactive force-directed graph**:

- Nodes are circles, coloured by label.
- Relationships are arrows, labelled with their type (e.g. `KNOWS`).
- Drag nodes around; the layout settles itself. Node positions scale proportionally when the bubble is resized.
- Click anything to see its properties.

If your query only returns scalar values (e.g. `RETURN count(*)`), the Graph tab is empty — use the Cypher tab's table view instead.

### Common issues

- **`Unauthorized`** — wrong credentials in the URI. Format: `neo4j://user:password@host:7687`.
- **`Connection refused`** — Neo4j isn't running or isn't reachable. Default Bolt port is `7687` (separate from the HTTP `7474` you might see in browser docs).
- **Slow queries on big graphs** — add `LIMIT` while exploring. The Graph tab tries to render everything you return; a 100k-node result will lock up the layout.
