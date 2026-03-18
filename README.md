# Claude Manager CLI

从**当前工作目录**的 `credentials.json` 交互选择（也可用 `-f` 指定路径） **provider** 与 **model**，并合并写入 `~/.claude/settings.json` 的 `env`（`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`）。

## 安装

```bash
cd ClaudeManager
npm install
```

## 凭据格式 `credentials.json`

复制示例并填写：

```bash
cp credentials.json.example credentials.json
```

每个顶层 key 为一个 provider，结构：

| 字段 | 说明 |
|------|------|
| `apiUrl` | 必填，Anthropic 兼容 API 地址 |
| `apiKey` | 必填，令牌 |
| `models` | 可选，字符串数组；无则运行时手动输入 model |

## 使用

```bash
npm start
# 或
npx node bin/cli.mjs
# 全局链接后
npm link
claude-manager
```

指定凭据文件：

```bash
node bin/cli.mjs -f /path/to/credentials.json
```

## 行为说明

- 会**保留** `settings.json` 里除上述三个 env 以外的字段（如 `skipDangerousModePermissionPrompt`）。
- 其它 `env` 变量会保留，仅覆盖这三个键。

## 安全

请勿将含真实密钥的 `credentials.json` 提交到 Git；建议加入 `.gitignore`。
