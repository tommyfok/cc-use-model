# cc-use-model

[English](#english) | 中文

交互式选择 Claude Code 的 provider 和 model，自动将配置写入 `~/.claude/settings.json`。

凭据文件自动查找，支持多路径探测，也可通过参数或环境变量指定。

## 环境要求

- Node.js **18+**（见 `package.json` 的 `engines`）

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

每个顶层 key 为一个 provider。每个 provider **二选一**：

- **普通 provider**：提供 `apiUrl` + `apiKey`（均为非空字符串）
- **`env` provider**：提供 `env` 对象（键与非空字符串值）；此时忽略该条目的 `apiUrl` / `apiKey`

| 字段     | 说明                                                                 |
| -------- | -------------------------------------------------------------------- |
| `apiUrl` | 与 `apiKey` 成对使用：Anthropic 兼容 API 地址                         |
| `apiKey` | 与 `apiUrl` 成对使用：令牌                                           |
| `env`    | 可选替代上述二者：键值对象（value 必须为字符串）；把这些键写入 `~/.claude/settings.json` 的 `env` |
| `models` | 可选，字符串数组；无则运行时手动输入 model                           |

## 使用

```bash
# 直接运行（全局安装后）
cc-use-model

# 指定凭据文件
cc-use-model -f /path/to/credentials.json

# 通过环境变量指定
export CC_USE_MODEL_CREDENTIALS=/path/to/credentials.json
cc-use-model

# 查看帮助
cc-use-model -h
```

**凭据查找顺序**（未指定 `-f` 时）：

1. 环境变量 `CC_USE_MODEL_CREDENTIALS` 指向的文件
2. 当前目录 `./credentials.json`
3. 本工具所在目录下的 `credentials.json`（`npm link` 后从任意目录执行都会读到）
4. `~/.config/cc-use-model/credentials.json`

### 子命令 `apply-envs`

根据当前 `~/.claude/settings.json` 中的配置，向标准输出打印 `export VAR='...'` 行，便于在当前 shell 中生效（例如配合 `eval`）。**不读取** `credentials.json`。

```bash
cc-use-model apply-envs
eval "$(cc-use-model apply-envs)"
```

会输出 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`，以及此前由 `env` provider 写入且记录在 `envKey` 中的其它变量。若当前无任何配置，命令会以非零退出码结束。

## 行为说明

- 会**保留** `settings.json` 里除本次写入涉及的字段外的其它顶层字段（如 `skipDangerousModePermissionPrompt`）。
- 每次选定 model 后，除合并 `env` 外，还会将顶层 **`model`** 设为当前选择的 model。
- 使用普通 provider（`apiUrl` / `apiKey`）时：其它 `env` 变量会保留，仅覆盖 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`。
- 使用 `env` provider 时：会覆盖写入 `env` 中提供的键，以及 `ANTHROPIC_MODEL`；并记录 `envKey`（写入过的 env 键列表），用于下次切换到无 `env` 的 provider 时自动清理这些键。
- 选择 **清空配置** 选项时：会删除 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`、顶层 `model`，以及之前通过 `env` provider 写入并由 `envKey` 记录的所有键，恢复到无 API Key 状态。

## 安全

请勿将含真实密钥的 `credentials.json` 提交到 Git；建议加入 `.gitignore`。

## License

MIT

---

# English

Interactively select provider and model for Claude Code, automatically writing configuration to `~/.claude/settings.json`.

Credentials file is auto-discovered across multiple paths, or can be specified via flag or environment variable.

## Requirements

- **Node.js 18+** (see `engines` in `package.json`)

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

Each top-level key is a provider. For each provider, use **one of**:

- **Standard provider**: `apiUrl` + `apiKey` (both non-empty strings)
- **`env` provider**: an `env` object (string keys and non-empty string values); `apiUrl` / `apiKey` on that entry are ignored

| Field    | Description |
| -------- | ----------- |
| `apiUrl` | Used with `apiKey`: Anthropic-compatible API endpoint |
| `apiKey` | Used with `apiUrl`: authentication token |
| `env`    | Alternative to the pair above: key/value object (values must be strings); keys are written into `env` in `~/.claude/settings.json` |
| `models` | Optional string array; if omitted, enter the model name interactively at runtime |

## Usage

```bash
# Run directly (after global install)
cc-use-model

# Specify credentials file
cc-use-model -f /path/to/credentials.json

# Via environment variable
export CC_USE_MODEL_CREDENTIALS=/path/to/credentials.json
cc-use-model

# Help
cc-use-model -h
```

**Credentials lookup order** (when `-f` is not specified):

1. File pointed to by `CC_USE_MODEL_CREDENTIALS`
2. `./credentials.json` in the current working directory
3. `credentials.json` next to the installed tool (useful with `npm link`)
4. `~/.config/cc-use-model/credentials.json`

### Subcommand `apply-envs`

Prints `export VAR='...'` lines to stdout from the current `~/.claude/settings.json`, so you can load them into your shell (e.g. with `eval`). Does **not** read `credentials.json`.

```bash
cc-use-model apply-envs
eval "$(cc-use-model apply-envs)"
```

Outputs `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, and any other variables previously written by an `env` provider and listed in `envKey`. Exits with a non-zero status if nothing is configured.

## Behavior

- Preserves other top-level fields in `settings.json` (e.g. `skipDangerousModePermissionPrompt`) that are not part of this update.
- After you pick a model, sets the top-level **`model`** field to that choice in addition to merging `env`.
- **Standard provider** (`apiUrl` / `apiKey`): keeps other `env` entries; only overwrites `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_MODEL`.
- **`env` provider**: writes the keys from `env` plus `ANTHROPIC_MODEL`; stores `envKey` (list of keys from that provider) so switching back to a standard provider can remove those keys automatically.
- **Clear configuration**: removes `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, top-level `model`, and all keys previously written via `env` providers (as tracked by `envKey`), restoring a no–API-key state.

## Security

Do not commit `credentials.json` with real API keys to Git. Add it to `.gitignore`.

## License

MIT
