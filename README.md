# cc-use-model

[English](#english) | 中文

交互式选择 Claude Code 的 provider 和 model，自动将配置写入 `~/.claude/settings.json`。

凭据文件自动查找，支持多路径探测，也可通过参数或环境变量指定。

## 安装

```bash
# 全局安装
npm install -g cc-use-model

# 或使用 npx（无需安装）
npx cc-use-model
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
# 直接运行（全局安装后）
cc-use-model

# 指定凭据文件
cc-use-model -f /path/to/credentials.json

# 通过环境变量指定
export CC_USE_MODEL_CREDENTIALS=/path/to/credentials.json
cc-use-model
```

**凭据查找顺序**（未指定 `-f` 时）：

1. 环境变量 `CC_USE_MODEL_CREDENTIALS` 指向的文件
2. 当前目录 `./credentials.json`
3. 本工具所在目录下的 `credentials.json`（`npm link` 后从任意目录执行都会读到）
4. `~/.config/cc-use-model/credentials.json`

## 行为说明

- 会**保留** `settings.json` 里除上述三个 env 以外的字段（如 `skipDangerousModePermissionPrompt`）。
- 其它 `env` 变量会保留，仅覆盖这三个键。

## 安全

请勿将含真实密钥的 `credentials.json` 提交到 Git；建议加入 `.gitignore`。

## License

MIT

---

# English

Interactively select provider and model for Claude Code, automatically writing configuration to `~/.claude/settings.json`.

Credentials file is auto-discovered across multiple paths, or can be specified via flag or environment variable.

## Installation

```bash
# Global install
npm install -g cc-use-model

# Or use npx (no installation needed)
npx cc-use-model
```

## Credentials Format `credentials.json`

Copy the example and fill in:

```bash
cp credentials.json.example credentials.json
```

Each top-level key is a provider with the following structure:

| Field    | Description                                    |
| -------- | ---------------------------------------------- |
| `apiUrl` | Required, Anthropic-compatible API endpoint     |
| `apiKey` | Required, authentication token                  |
| `models` | Optional, string array; if omitted, input model manually at runtime |

## Usage

```bash
# Run directly (after global install)
cc-use-model

# Specify credentials file
cc-use-model -f /path/to/credentials.json

# Via environment variable
export CC_USE_MODEL_CREDENTIALS=/path/to/credentials.json
cc-use-model
```

**Credentials lookup order** (when `-f` not specified):

1. File pointed by `CC_USE_MODEL_CREDENTIALS` environment variable
2. `./credentials.json` in current directory
3. `credentials.json` in the tool's directory
4. `~/.config/cc-use-model/credentials.json`

## Behavior

- Preserves all existing fields in `settings.json` (e.g., `skipDangerousModePermissionPrompt`)
- Preserves other `env` variables, only overwrites `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_MODEL`

## Security

Do not commit `credentials.json` with real API keys to Git. Add it to `.gitignore`.

## License

MIT
