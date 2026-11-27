让手机或另一台电脑通过固定 HTTPS 域名访问你本地运行的 Cockpit。项目、终端和 Agent 进程仍在本机或 Docker 容器里。访问期间，电脑、Cockpit 和 Cloudflare Tunnel 连接器需要保持运行。

## 创建 Cloudflare Tunnel

准备一个已加入 Cloudflare 的域名，选一个专用子域名，例如 `cockpit.example.com`。在 Cloudflare 控制台创建一个由 Cloudflare 管理的 Tunnel，选择 **Cloudflared**。保存控制台给出的连接器令牌，Docker 示例会用到它。

等下面选定的 Cockpit 和连接器都启动，再在 Tunnel 上添加一个 **Published application route**。使用你的子域名，服务类型选 **HTTP**，源站地址填 `127.0.0.1:3457`。浏览器访问的是 Cloudflare 提供的 HTTPS 地址，连接器通过回环访问 Cockpit。两种示例的发布路由相同，每个 Tunnel 选其中一种运行方式。 [Cloudflare 创建 Tunnel 指南](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)

## 在本机直接运行

在要远程使用的项目目录下运行。需要先安装 Cockpit 的话，见 [快速开始](/zh/docs/get-started/quickstart/#安装)。如果已有 Cockpit 占用 3457，先正常停止，再用下面的配置启动。如果已有要沿用的访问令牌，先将它写入 `~/.config/opencockpit/remote-access-token`，权限设为 `600`。

```bash
(
  set -eu
  umask 077
  token_dir="$HOME/.config/opencockpit"
  mkdir -p "$token_dir"
  if [ ! -s "$token_dir/remote-access-token" ]; then
    token=$(openssl rand -hex 32)
    printf '%s\n' "$token" > "$token_dir/remote-access-token"
  fi

  COCKPIT_HOST=127.0.0.1 \
  COCKPIT_TOKEN="$(cat "$token_dir/remote-access-token")" \
  cockpit . --port 3457 --no-open
)
```

在同一台电脑安装 `cloudflared`，然后运行 Cloudflare 控制台为当前系统给出的连接器命令。macOS 可用 `brew install cloudflared`。按控制台提示可将连接器安装成系统服务。 [Cloudflare 安装说明](https://developers.cloudflare.com/tunnel/downloads/)

Cockpit 的监听地址保持为 `127.0.0.1:3457`。路由器无需为 Tunnel 配置端口转发。

## 在 Docker 里运行

需要 Docker 和 `docker compose`。克隆 Cockpit 仓库，进入其中的 [Cloudflare Tunnel 示例](https://github.com/Surething-io/cockpit/tree/main/examples/cloudflare-tunnel)。如果已经克隆过仓库，直接进入其中的 `examples/cloudflare-tunnel`。

```bash
git clone --depth 1 https://github.com/Surething-io/cockpit.git
cd cockpit/examples/cloudflare-tunnel
(umask 077; [ -e .env ] || cp .env.example .env)
openssl rand -hex 32
```

把生成的随机值填入 `.env` 的 `COCKPIT_TOKEN`，再把 Cloudflare 控制台给出的连接器令牌填入 `TUNNEL_TOKEN`。两个值都要填写。`.env` 留在本机，示例已将它排除在 Git 和 Docker 构建上下文之外。

镜像默认安装最新发布的 Cockpit。需要固定版本时，在 `.env` 中设置 `COCKPIT_VERSION`。然后启动两个服务。

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 cockpit cloudflared
```

两个容器共享网络命名空间，连接器通过 `127.0.0.1:3457` 访问 Cockpit，宿主机无需开放端口。命名卷 `cockpit-home` 保存项目目录、`~/.cockpit` 和家目录里的 Agent 凭据，重建容器时会沿用。

要在容器内克隆项目或登录 Agent，可以运行 `docker compose exec cockpit bash`。需要额外的系统工具或 Agent CLI 时，把安装步骤加到 Dockerfile。

## 登录和手机扫码

发布路由后，从另一台设备检查访问。下面的请求未携带 Token，在未启用 Cloudflare Access 时应返回 `401`。如果直接返回 `200`，先暂停公开路由，检查 Cockpit 是否加载了 Token，以及代理是否传递了访客来源头。

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://cockpit.example.com/api/health
```

1. 在电脑浏览器用 `https://cockpit.example.com/?token=你的访问令牌` 首次登录。Cockpit 会写入 Cookie 并清理地址栏。
2. 在桌面工作区打开一个项目，再在项目顶栏点 **在手机上打开**，用手机扫二维码。打开了会话时，手机会直接进入该会话。通过 `localhost` 打开时，二维码入口会隐藏。
3. 在手机上打开聊天。要验证终端 WebSocket，从手机版会话列表点 **桌面版**，再打开桌面工作区的终端。二维码包含共享访问令牌，请按密码保管。

如需在 Token 前加上按邮箱的访问控制，可给同一子域名配置 [Cloudflare Access 自托管应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。手机首次扫码时也要先通过 Access 登录。启用后，未登录的请求可能先被 Access 重定向或拒绝。

## 停止与故障排查

- **显示 502**：检查 Cockpit 是否在运行，以及 Tunnel 的源站是否填的是 `http://127.0.0.1:3457`。Docker 用户还可以检查 `docker compose ps` 和两项服务的日志。
- **想暂时关闭访问**：停止本机 `cloudflared`，或在 Docker 目录运行 `docker compose stop`。项目和会话仍在命名卷里。下次运行 `docker compose up -d` 即可。
- **想更新 Docker 实例**：运行 `docker compose build --pull --no-cache cockpit`，再用 `docker compose up -d --force-recreate` 重建两个容器，确保连接器加入新的网络命名空间。如果固定了 `COCKPIT_VERSION`，构建前先修改 `.env` 里的版本号。沿用原有卷和 `.env` 文件。

如果希望电脑关机后仍能远程使用，见 [服务端部署](/zh/docs/get-started/server-deployment/)。
