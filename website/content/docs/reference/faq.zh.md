人们常碰到的 Cockpit 问题和怎么解决。按症状组织。

## Cockpit 启动不了

**`Error: listen EADDRINUSE: address already in use :::3457`**

另一个进程在用 3457 端口。要么：

- 停那个进程，或
- 让 Cockpit 用别的端口起：

```bash
cockpit --port 4000
```

**`Error: command not found: cockpit`**

npm 全局 bin 目录不在你的 `PATH` 上。找 npm 把全局 bin 放在哪(`npm bin -g` 在 npm 7+ 已经**移除**了,用下面这条):

```bash
npm config get prefix
```

输出比如 `/usr/local`,那么全局 bin 就在 `/usr/local/bin`(homebrew nvm 等情况会不同)。把那个目录加到你 shell profile(`~/.zshrc`、`~/.bashrc` 等)的 `PATH` 里。

**`Error: Node version is too old`**

Cockpit 需要 Node.js 20 或更新。`node -v` 检查。升级 Node，然后重装 Cockpit。

## Claude 不工作

**第一条消息发出去就报"未登录"**

Cockpit 不管 Claude 登录 —— 它用 `claude` CLI 自己的登录态。在终端跑一次 `claude` 完成登录，然后 Cockpit 里重试。

**昨天还行，今天说我没登录**

Claude session token 过期。再跑一次 `claude` 刷新。

**想在一个 tab 用工作账号、另一个 tab 用个人账号**

Claude 2 就为这个 —— 见 [引擎 → Claude](/zh/docs/agent/engines/#claude)。

## 气泡行为异常

**浏览器气泡显示空白页**

最常见是网站拒绝被 iframe 嵌入。装 [Chrome 扩展](/zh/docs/console/chrome-extension/#安装与自动重载)一般就好。

**浏览器气泡是登出状态**

同一个答案 —— 装 Chrome 扩展。不装的话气泡不跟你正常 Chrome 共享 cookie。

**数据库气泡连不上**

检查连接字符串格式（见各数据库页：[PostgreSQL](/zh/docs/console/databases/#postgresql) / [MySQL](/zh/docs/console/databases/#mysql) / [Redis](/zh/docs/console/databases/#redis) / [Neo4j](/zh/docs/console/databases/#neo4j)）。密码里特殊字符 URL-encode（`@` → `%40`、`:` → `%3A` 等）。

**Ollama 气泡找不到模型**

你还没拉过。终端里：

```bash
ollama pull llama3.1
```

然后再创建 Ollama tab —— 模型选择器现在该列出它了。

## 文件与代码

**`Cmd+P` 没反应**

确认 Cockpit 窗口聚焦（不是你的编辑器）。如果你在 Notes 模态或设置里，`Cmd+P` 被劫持到别处；先关模态。

**保存文件(`Cmd+S`)没反应**

代码查看器默认只读。点工具栏上的 **Edit** 按钮切到编辑模式,然后 `Cmd+S` 才生效 —— 点文件内容区**不会**切换模式,要用按钮。

**Blame 视图对某些文件没数据**

文件太新（还没提交）或你不在 Git 仓库里。

## 设置与数据

**API key 存哪？**

在你机器上，靠 OS 文件权限保护 —— 和 SSH key 或 `~/.aws/credentials` 是一个模型。一切都在本地完成。

**我把设置弄坏了，怎么重置到默认？**

退出 Cockpit，然后：

```bash
rm -rf ~/.cockpit
```

下次启动会用默认值重建文件夹。要重新粘 API key。

**怎么把一切迁移到新机器？**

把 `~/.cockpit` 文件夹从旧机器拷到新机器（USB / scp / rsync 都行），在新机器上装 Cockpit，会话 / 钉住 tab / 定时任务 / API key 都跟着过来。

## 升级

**`cockpit update` 报 `EACCES`**

全局 npm install 需要 root 权限。要么：

```bash
sudo npm install -g @surething/cockpit@latest
```

要么一次性修好 npm 权限以后不用 sudo（搜 "npm EACCES fix"）。

**我想回滚到之前的版本**

```bash
npm install -g @surething/cockpit@<旧版本>
```

版本列表在 [npmjs.com/package/@surething/cockpit](https://www.npmjs.com/package/@surething/cockpit)。

## 性能

**大仓库上 Cockpit 感觉卡**

打开大项目（10k+ 文件）后头几秒是慢的 —— Cockpit 在给 Code Map 和 CodeGraph 建索引。后续操作快。一直慢的话提 issue 附仓库大小细节。

**浏览器气泡吃内存**

每个浏览器气泡是浏览器里的一个 **iframe**(不是单独的 Chrome tab,即便装了扩展也一样)。开 10 个气泡就是同一个 Cockpit 页面里 10 个 iframe 的开销。关掉不在用的气泡;[休眠机制](/zh/docs/console/browser/#气泡生命周期)会在气泡不可见 5 分钟后自动卸载 iframe 省内存,主动唤醒重新加载。

## 我的问题不在这

- **GitHub issue tracker**: [github.com/Surething-io/cockpit/issues](https://github.com/Surething-io/cockpit/issues)
- **特定功能问题**: 先查这个文档站对应页 —— 左侧栏覆盖了每个功能。

## 下一步

- [快速开始](/zh/docs/get-started/quickstart/) —— 安装、升级、卸载
