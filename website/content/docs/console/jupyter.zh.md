Jupyter 气泡在 Cockpit 里打开一个 `.ipynb` notebook,让你编辑 cell、执行、看输出 —— 包括图片和富 HTML —— 不用单开 Jupyter Lab 窗口。**Cockpit 自带 Python 内核管理**:你不用单独跑 `jupyter lab`,气泡背后会自己拉起 Python 桥接进程跑你的 cell。

打开方式:打任何以 `.ipynb` 结尾的路径(注意大小写敏感,后缀必须小写):

```text
analysis.ipynb
~/notebooks/explore.ipynb
./reports/2026-Q1.ipynb
```

相对路径相对于当前 Cockpit 项目的工作目录解析。

## 你看到什么

notebook 从上到下渲染为一列 cell:

- **代码 cell** —— 可编辑的源码区 + 下方输出区。执行后输出(文本、图片、HTML、错误堆栈)出现在下面。**只支持 Python**,语法高亮也只对 Python。
- **Markdown cell** —— 按 Markdown 渲染。
- **Raw cell** —— 原样显示。

每个代码 cell 旁边有执行编号(`[1]`);跑中时显示 `[*]`。

## 单 cell 操作

双击 cell 进入编辑;每个 cell 旁边的工具栏:

- **▶ 运行** —— 跑当前 cell。`Shift+Enter` 也行。
- **类型切换** —— 在 code / markdown / raw 之间转。
- **↑ / ↓ 移动** —— 上移 / 下移 cell。
- **✕ 删除** —— 删掉当前 cell。

## 气泡级别操作

气泡头部:

- **▶ Run All** —— 依次跑所有代码 cell。
- **■ Stop** —— 给当前正在跑的 cell 发中断,kernel 不挂、把当前 cell 停掉。
- **↻ Restart** —— kernel 挂了或想清干净时用。
- **Cmd+S 保存** —— 把 notebook 写回磁盘(执行编号、cell 顺序、输出全保留)。
- **内核状态徽章** —— `idle` / `busy` / `starting` / `error` / `dead` / `disconnected`,kernel 挂了在这看。

## 背后:Cockpit 怎么跑 kernel

气泡不依赖 `jupyter lab` —— Cockpit **自己拉起内核**。具体:

- 第一次跑 cell 时,Cockpit `spawn` 一个 Python 桥接进程(`jupyter_bridge.py`),用你系统的 `python3`(找不到就退回 `python`)。
- 桥接脚本走 `jupyter_client` 跟 IPython kernel 通信 —— 所以你需要 Python 环境里装好 `ipykernel`(它会顺带带上 `jupyter_client`):

```bash
pip install ipykernel
```

- 不需要再手动跑 `jupyter lab` 或 `jupyter notebook`。
- kernel **闲置 10 分钟自动关停**;下次跑 cell 再起。

如果想用项目里的 venv,正常 `source venv/bin/activate` 再启动 Cockpit 就行(Cockpit 找到的 `python3` 就是 venv 里的)。

## 它不是什么

Jupyter 气泡是**轻量级的 notebook 查看 + 执行器**,不是完整的 Jupyter Lab 替代品。**你能得到**:

- Cell 编辑、执行、增删、移动、类型切换
- 输出渲染(文本、图片、HTML)
- Run All / Stop / Restart / Save

**你拿不到**:

- 多种内核类型(只跑 Python)
- 变量检查器 / 调试面板
- 拖拽重排(用 ↑ / ↓ 按钮代替)
- Jupyter 扩展 / 主题

要那些就照常跑 Jupyter Lab。气泡给的是常见场景:"打开这个 notebook、跑几个 cell、看输出"。

## 常见问题

- **内核状态 "error" 或 "dead"** —— Python 环境缺包(通常是 `ipykernel` 没装)。按上面的 `pip install ipykernel`。
- **找不到 Python** —— 系统 PATH 里没有 `python3` 也没有 `python`。安装 Python 3。
- **Cell 永远 `[*]`** —— 点 **■ Stop** 中断;还不行就 **↻ Restart**。
- **代码用了自定义 venv 的包** —— 启 Cockpit 之前先 activate venv,让它找到的 Python 是 venv 里的。
- **关掉气泡时 kernel 没了** —— 是设计:kernel 闲置 10 分钟自动停。重开气泡跑 cell 会自动重起。

## 下一步

- [命令输入](/zh/docs/console/input-bar/) —— 还有什么触发什么
- [终端气泡](/zh/docs/console/terminal/) —— 不用 notebook 交互式跑 `python`
