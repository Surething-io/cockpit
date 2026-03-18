# Cockpit

One seat. One AI. Everything under control.

## Quick Start

```bash
cd /path/to/cockpit
npm install
npm run dev         # Start dev server on http://localhost:3456
```

## Production

```bash
npm run setup       # Build + npm link (registers `cock` command)
cock                # Start server on http://localhost:3457
cock -h             # Show help
cock -v             # Show version
```

## CLI

```bash
cock browser --help       # 浏览器自动化
cock terminal --help      # 终端自动化
```

## Development

```bash
npm run build       # Build for production
npm run setup       # Build + npm link (registers cock / cock-dev)
npm run lint        # Run ESLint
```

开发时子命令连接 dev server（port 3456）：
```bash
cock-dev browser abcd snapshot
cock-dev terminal abcd output
```
