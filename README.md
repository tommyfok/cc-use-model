# cc-use-model

交互选择 provider/model；凭据文件会自动查找（不必先 `cd` 到项目目录），也可用 `-f` 或环境变量指定。 **provider** 与 **model**，并合并写入 `~/.claude/settings.json` 的 `env`（`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`）。

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

| 字段     | 说明                                       |
| -------- | ------------------------------------------ |
| `apiUrl` | 必填，Anthropic 兼容 API 地址              |
| `apiKey` | 必填，令牌                                 |
| `models` | 可选，字符串数组；无则运行时手动输入 model |

## 使用

```bash
npm start
# 或
npx node bin/cli.mjs
# 全局链接后
npm link
cc-use-model
```

**凭据查找顺序**（未写 `-f` 时）：

1. 环境变量 `CC_USE_MODEL_CREDENTIALS` 指向的文件
2. 当前目录 `./credentials.json`
3. **本工具所在目录**下的 `credentials.json`（`npm link` 后从任意目录执行都会读到项目里的凭据）
4. `~/.config/cc-use-model/credentials.json`

```bash
cc-use-model -f /path/to/credentials.json
export CC_USE_MODEL_CREDENTIALS=/path/to/credentials.json && cc-use-model
```

## 行为说明

- 会**保留** `settings.json` 里除上述三个 env 以外的字段（如 `skipDangerousModePermissionPrompt`）。
- 其它 `env` 变量会保留，仅覆盖这三个键。

## 安全

请勿将含真实密钥的 `credentials.json` 提交到 Git；建议加入 `.gitignore`。
