Cockpit Console 面板会自动识别数据库连接串,开一个**数据库气泡** —— 内置客户端,带表结构浏览 + 数据浏览 + 查询窗口,只针对那一个数据库。不用为了瞄一眼数据再去开 `psql` / `mysql` / DataGrip / RedisInsight。

Cockpit 目前支持四种数据库:

| 数据库 | 连接串前缀 | Anchor |
|---|---|---|
| [PostgreSQL](#postgresql) | `postgresql://…` 或 `postgres://…` | `#postgresql` |
| [MySQL](#mysql) | `mysql://…` | `#mysql` |
| [Redis](#redis) | `redis://…` | `#redis` |
| [Neo4j](#neo4j) | `neo4j://…` 或 `bolt://…` | `#neo4j` |

Console 输入栏在你粘贴 URI 时自动解析并开对应气泡 —— 完整识别规则见 [命令输入](/zh/docs/console/input-bar/)。

## PostgreSQL

PostgreSQL 气泡给你一个连接、一个 schema 浏览器、一个查询窗口 —— 临时查数不用离开 Cockpit。

打开方式:把连接字符串粘到 Console 输入栏:

```text
postgresql://user:password@localhost:5432/mydb
```

`postgres://...` 也能用。

### 布局

气泡左侧是 schema 浏览器,右侧是**三个 tab**:

- **左侧栏:schema 树** —— schema → 表和视图 → 列。顶部有过滤框,点任意表选中。
- **右侧 Structure tab** —— 显示当前选中表的结构:列(含类型、可空、默认值)、主键(🔑 标记)、外键(目标表 / 列)、索引(类型、字段)。**这才是看 PK / FK / 索引的地方,不是点 schema 树本身。**
- **右侧 Data tab** —— 表数据浏览器,分页展示(默认 **每页 50 行**)。
- **右侧 SQL tab** —— 查询窗口,打 SQL,`Cmd/Ctrl+Enter` 或点 Run,结果在下方表格里。

### Data tab 能做什么

- **点列头排序** —— 升序 / 降序切换。
- **过滤** —— 列上设过滤器,操作符:`=`、`!=`、`>`、`<`、`>=`、`<=`、`LIKE`、`NOT LIKE`、`IN`、`IS NULL`、`IS NOT NULL`。
- **悬停**单元格看完整内容(长值截断时有用,延迟 350ms 弹 tooltip)。
- **行内编辑** —— 双击单元格改值,保存 / 取消。
- **新增行** —— 表单填字段后插入。
- **多选 + 删除** —— 勾选若干行,确认后删除。
- **导出** —— 选中行或整表,复制 / 下载为 CSV / JSON。
- **查询耗时** —— 结果数旁边显示 `xx ms`。

### 常见问题

- **Connection refused** —— 数据库从你机器访问不到。检查 host / port、是不是要 VPN、自己的服务器看 `pg_hba.conf`。
- **Password authentication failed** —— 凭据错了,或这个用户没权限从你 IP 连。密码里的特殊字符要 URL-encode(`@` → `%40` 等)。
- **长查询挂着** —— Cockpit 不会自动取消长查询。关掉气泡杀连接,或在另一个气泡里跑 `SELECT pg_cancel_backend(pid)`。

## MySQL

MySQL 气泡和 [PostgreSQL 气泡](#postgresql)结构上**几乎一样**:相同的左侧 schema 树、相同的 Structure / Data / SQL 三 tab、相同的分页(50 行/页)、相同的排序过滤、相同的行内编辑和导出。

打开方式:

```text
mysql://user:password@localhost:3306/mydb
```

### 跟 PostgreSQL 的实现差异

行为表层一致,SQL dialect 上有差异(对用户基本透明):

- 标识符引用用反引号 `` ` `` 而不是 `"`。
- 行计数走 `COUNT(*) AS cnt`,不是 PostgreSQL 的 `::int` 强转。
- 删除走 `DELETE … LIMIT 1`,不是 PostgreSQL 的 `ctid` 子查询。

### 常见问题

- **`Access denied`** —— 凭据错了,或这个用户不能从你 IP 连。检查服务器的 `mysql.user` host 授权。密码里特殊字符 URL-encode。
- **`Unknown database`** —— 连接字符串里的数据库名在服务器上不存在。
- **TLS 握手失败** —— 按标准 URI 参数处理 TLS;连托管服务且要 TLS 时,对照服务商文档拼正确的 query string。

## Redis

Redis 气泡给你一个 key 浏览器、一个 INFO 输出查看器、一个跑原始命令的 CLI tab。打开方式:

```text
redis://localhost:6379
redis://:password@host:6379/2
rediss://host:6380       # TLS
```

URI 遵循标准 `redis://[:password@]host:port[/db]` 形式。要 TLS 用 `rediss://`(多个 `s`)。气泡标题栏显示 Redis 版本、key 数、内存占用。

气泡顶部有**三个 tab**:

### 1. Data tab(key 浏览器)

默认视图。一份 key 列表,顶部过滤框接受 Redis pattern(`*`、`?`、`[abc]`)。Key 数多时底部有 **Load more** 按钮分页。点 key 看值。

每个 key 显示:

- **类型徽章** —— `STRING` / `HASH` / `LIST` / `SET` / `ZSET` / `STREAM`,颜色区分方便扫一眼。
- **值预览** —— `STRING` 是值本身,`HASH` 是 field/value 对,`LIST` / `SET` / `ZSET` 是元素列表。
- **TTL** —— 格式化为秒、分或小时(`60s`、`2m30s`、`1h5m` 等)。

长值在预览里被截断;悬停或点进去看完整内容。

### 2. Info tab

显示 `INFO` 命令的输出,按 section 解析展示 —— 复制率、内存、客户端连接、复制状态等。临时排查很方便,不用切到 CLI 跑。

### 3. CLI tab

原始 Redis 命令行。支持空格分隔参数和带引号字符串。打任意命令回车:

```text
INFO replication
DBSIZE
SCAN 0 MATCH user:* COUNT 100
```

结果格式化得很好 —— 数组返回成编号列表,整数就是整数,`(nil)` 就是 `(nil)`。

### 常见问题

- **`WRONGPASS`** —— 密码缺了或错了。在 URI 里带上:`redis://:你的密码@host:port`。
- **连接超时** —— Redis 从你机器访问不到。检查 host / port;托管服务确认它允许你 IP 连。
- **`ERR DB index is out of range`** —— URI 里的 `/db` 部分引用了不存在的数据库编号(Redis 默认 16 个库,编号 0–15)。

## Neo4j

Neo4j 气泡让你浏览图数据库 —— 看 schema、跑 Cypher、并且**把结果显示为真正可交互的图**,不是一排排记录。

打开方式:Neo4j 支持 4 种 URI scheme,按你服务文档说的用:

```text
neo4j://localhost:7687
neo4j+s://yourdb.databases.neo4j.io       # TLS
bolt://localhost:7687
bolt+s://yourdb.databases.neo4j.io        # TLS
```

`+s` 版本启用 TLS。`neo4j://` 是新 scheme(routing 感知);`bolt://` 是老的直连 scheme。

气泡顶部有 **3 个 tab**。

### 1. Schema

数据库结构的总览(每项数字会在你跑查询后更新):

- **Labels** —— 所有 node label 和各自的节点数。**点击 label 直接跑一条查询拉出该类节点。**
- **Relationship types** —— 所有关系类型和各自的数量。**点击关系类型拉出该类关系。**
- **Property keys** —— 任何地方用到的所有属性名(列出,不可点击)。
- **Indexes** —— 名字、类型、字段、状态。
- **Constraints** —— 唯一性等约束。

第一次接触一个库、想知道里面有什么时用这个。

### 2. Cypher

查询窗口。`Cmd/Ctrl+Enter` 跑查询:

```cypher
MATCH (p:Person)-[:KNOWS]->(friend)
WHERE p.name = 'Alice'
RETURN p, friend
```

结果在底下渲染为表格 —— 每条记录一行,每个返回变量一列。

### 3. Graph

Cypher 返回 node 和 relationship 时,切到这个 tab 把它们看成**力导向交互图**:

- 节点是圆圈,按 label 着色。
- 关系是箭头,带类型缩写(比如 `KNOWS`)。
- 拖动节点;布局自己稳定。窗口缩放后节点位置按比例保留。
- 点任何东西看它的属性。

如果你的查询只返回标量(比如 `RETURN count(*)`),Graph tab 是空的 —— 用 Cypher tab 的表格视图。

### 常见问题

- **`Unauthorized`** —— URI 里凭据错了。格式:`neo4j://user:password@host:7687`。
- **`Connection refused`** —— Neo4j 没跑或访问不到。默认 Bolt 端口是 `7687`(跟你在浏览器文档里看到的 `7474` HTTP 端口不一样)。
- **大图上慢查询** —— 探索时加 `LIMIT`。Graph tab 会试图渲染所有你返回的东西;10 万节点的结果会把布局卡死。
