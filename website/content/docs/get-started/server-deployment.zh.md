在 Ubuntu 服务器上安装 OpenCockpit，用 systemd 开机自启，再通过 SSH 隧道、内网或 HTTPS 域名访问。项目文件、终端和 Agent 进程都在服务器上运行。

## 安装

准备 Ubuntu、[Node.js 22.19.0 或更新版本](https://nodejs.org/en/download)、npm、Git 和 OpenSSL。把 Node 和 npm 安装在系统级路径，确保 systemd 的服务账户也能运行它们。

```bash
sudo node -v
sudo npm install -g @surething/cockpit
command -v cockpit
cockpit -v
```

创建专用账户和工作目录。示例使用 `/home/opencockpit/projects`。

```bash
id -u opencockpit >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash opencockpit
sudo -u opencockpit -H mkdir -p /home/opencockpit/projects
sudo -u opencockpit -H node -v
```

在这个账户下完成所用 Agent 的登录或配置，并把项目放在该账户可访问的目录。会话、设置和凭据默认保存在 `/home/opencockpit/.cockpit`。共享 Token 的持有者可以使用该账户的终端并访问同一套项目和会话。 [AI 引擎](/zh/docs/agent/engines/)

## 配置 systemd

创建仅管理员可读的环境文件。下面的命令只在文件不存在时生成 Token。

```bash
sudo install -d -m 0750 /etc/opencockpit
sudo sh -ec '
  umask 077
  if [ ! -e /etc/opencockpit/access.env ]; then
    token=$(openssl rand -hex 32)
    printf "COCKPIT_TOKEN=%s\n" "$token" > /etc/opencockpit/access.env
  fi
'
```

用 `sudoedit /etc/systemd/system/opencockpit.service` 创建服务文件。把 `ExecStart` 里的路径替换成 `command -v cockpit` 返回的系统级绝对路径。

```ini
[Unit]
Description=OpenCockpit
After=network-online.target
Wants=network-online.target

[Service]
User=opencockpit
WorkingDirectory=/home/opencockpit/projects
Environment=COCKPIT_HOST=127.0.0.1
EnvironmentFile=/etc/opencockpit/access.env
ExecStart=/usr/local/bin/cockpit --port 3457 --no-open
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

启动服务并检查本机健康端点。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now opencockpit
sudo systemctl status opencockpit
curl -fsS http://127.0.0.1:3457/api/health
```

用 `sudo journalctl -u opencockpit -n 100 --no-pager` 查看服务日志。

## 私有访问

如果只需要从自己的电脑访问，在电脑上建立 SSH 隧道，然后打开 `http://localhost:3457`。保持 SSH 连接打开。

```bash
ssh -N -L 127.0.0.1:3457:127.0.0.1:3457 admin@server.example.com
```

把用户名和主机名替换成你的 SSH 登录地址。这个入口由 SSH 登录授权，Cockpit 收到的是本机回环请求。如果只通过内网或 VPN 提供浏览器访问，可在该网络内设置 HTTPS 反代，并把访问范围限制在内网或 VPN。

## 公网 HTTPS

Cockpit 继续监听 `127.0.0.1:3457`。把域名的 A 记录指向服务器，有可用的公网 IPv6 时也可配置 AAAA 记录。允许公网访问反代的 TCP 80 和 443，保持 3457 为本机端口。

下面用 [Caddy 的 Ubuntu 软件包](https://caddyserver.com/docs/install#debian-ubuntu-raspbian) 举例。安装后，在 `/etc/caddy/Caddyfile` 加入站点，把示例域名换成自己的域名。

```caddyfile
cockpit.example.com {
    reverse_proxy 127.0.0.1:3457
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

当域名和端口可达时，Caddy 会自动签发并续期证书，转发 WebSocket，并设置转发头。 [Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https) · [Caddy 反代](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

使用现有 HAProxy、Nginx 或其他反代时，保留原始 `Host`，转发 WebSocket，设置 `X-Forwarded-Proto: https`，并用经过验证的来源地址覆盖 `X-Forwarded-For`，或把连接来源追加到末尾。和 Cockpit 同机的反代由回环连接自动识别。异机或多层反代按需配置可信代理地址。 [可信代理与 Host 校验](/zh/docs/reference/cli/#共享令牌访问网关)

从另一台设备验证 HTTPS 入口。下面的无凭据请求应返回 `401`。随后在管理员终端读取 `/etc/opencockpit/access.env` 里的 Token，首次在浏览器打开 `https://cockpit.example.com/?token=你的令牌`。验证通过后，Cockpit 会写入登录 Cookie，并从地址栏移除 Token。若启用了反代访问日志，避免记录 `token` 查询参数、Cookie 和认证头。

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://cockpit.example.com/api/health
```

同一来源 IP 连续输错 5 次会被封禁 10 分钟，封禁期间返回 `429`，HTTP 和 WebSocket 共用计数。检查登录后能打开页面，再打开一个会话或终端确认实时连接正常。

## 手机访问

1. 在电脑上用手机也能访问的域名或内网地址打开 Cockpit。
2. 点桌面顶栏的二维码图标 **在手机上打开**。手机扫码后进入 `/m`，如果电脑当前有打开的会话，手机会直接进入该会话。
3. 如果在手机上切到了桌面版，窄屏时可用右下角的 **手机版** 按钮切回去。

通过 `localhost` 或其他回环地址打开时，扫码入口会隐藏。较旧版本也可以在手机浏览器直接打开可达地址下的 `/m`。开启 Token 后，二维码包含共享访问令牌，首次扫码即可登录。请把二维码当作密码保管。

## 升级与回滚

先用 `cockpit -v` 记下原版本，备份服务账户的 `~/.cockpit`。系统服务通过 systemd 停止和启动，npm 使用与首次安装相同的全局路径。

```bash
sudo systemctl stop opencockpit
sudo npm install -g @surething/cockpit@latest && sudo systemctl start opencockpit
```

升级后检查 `systemctl status`、本机健康端点和外部 HTTPS 登录。需要回滚时，将下面的 `PREVIOUS_VERSION` 替换成之前记下的版本。

```bash
sudo systemctl stop opencockpit
sudo npm install -g @surething/cockpit@PREVIOUS_VERSION && sudo systemctl start opencockpit
```

遇到启动或访问错误，可按状态码排查。 [常见问题与排查](/zh/docs/reference/faq/)
