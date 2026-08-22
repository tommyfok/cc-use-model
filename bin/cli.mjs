#!/usr/bin/env node
/**
 * 读取 credentials.json，交互选择 provider / model，更新 ~/.claude/settings.json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { select, input, confirm } from '@inquirer/prompts';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const BACKUP_PATH = path.join(os.homedir(), '.config', 'cc-use-model', 'claude-native-credentials.backup.json');
const LINUX_CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

/** 读取本机原生 Claude 凭据（mac=Keychain / linux=文件）。读不到返回 null。 */
function readNativeClaudeCredential() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', os.userInfo().username, '-w'],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      ).toString().trim();
      return out || null;
    }
    if (process.platform === 'linux') {
      if (fs.existsSync(LINUX_CRED_PATH)) {
        return fs.readFileSync(LINUX_CRED_PATH, 'utf8');
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 写回本机原生 Claude 凭据。返回是否成功。 */
function writeNativeClaudeCredential(payload) {
  try {
    if (process.platform === 'darwin') {
      execFileSync(
        'security',
        ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', os.userInfo().username, '-w', payload],
        { stdio: 'ignore' }
      );
      return true;
    }
    if (process.platform === 'linux') {
      fs.mkdirSync(path.dirname(LINUX_CRED_PATH), { recursive: true });
      fs.writeFileSync(LINUX_CRED_PATH, payload, { encoding: 'utf8', mode: 0o600 });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 读取现有备份（无则返回 null）。 */
function readBackup() {
  if (!fs.existsSync(BACKUP_PATH)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/** 在切换到第三方 provider 之前自动备份原生凭据，以及切换前的 settings.model。 */
function backupNativeCredentialIfNeeded() {
  if (process.platform === 'win32') return;
  const current = readNativeClaudeCredential();

  // 只在当前还不是第三方状态时捕获 settings.model，避免把第三方 model 当作原值覆盖备份
  const inNativeState = !hasThirdPartyConfigToClear();
  let originalModel = null;
  if (inNativeState) {
    const settings = loadOrInitSettings(settingsPathClaude());
    if (typeof settings.model === 'string' && settings.model.trim()) {
      originalModel = settings.model;
    }
  }

  const existing = readBackup();
  // native 态：以当前 settings.model 为准（含"未设置"），不回退到旧备份，避免复活已被用户清除的旧 model；
  // 第三方→第三方：originalModel 必为 null，保留已存的备份值
  const mergedOriginalModel = inNativeState
    ? originalModel
    : (existing && typeof existing.originalModel === 'string' ? existing.originalModel : null);
  const existingPayload = existing && typeof existing.payload === 'string' ? existing.payload : null;
  const existingOriginalModel = existing && typeof existing.originalModel === 'string' ? existing.originalModel : null;
  const mergedPayload = current || existingPayload;

  if (!mergedPayload && !mergedOriginalModel) return;
  if (existingPayload === (mergedPayload || null) && existingOriginalModel === mergedOriginalModel) return;

  try {
    fs.mkdirSync(path.dirname(BACKUP_PATH), { recursive: true });
    const body = JSON.stringify(
      {
        platform: process.platform,
        backedUpAt: new Date().toISOString(),
        payload: mergedPayload || null,
        originalModel: mergedOriginalModel || null,
      },
      null,
      2
    );
    fs.writeFileSync(BACKUP_PATH, body + '\n', { encoding: 'utf8', mode: 0o600 });
    // mode 选项仅在创建时生效；对已存在的文件显式收紧权限，避免旧版本/外部工具留下 0o644 的凭据备份
    try { fs.chmodSync(BACKUP_PATH, 0o600); } catch {}
    const what = [];
    if (mergedPayload) what.push(current ? '登录凭据' : '已有登录凭据备份');
    if (mergedOriginalModel) what.push(`model="${mergedOriginalModel}"`);
    console.log(`已备份原生 Claude ${what.join(' + ')} 到: ${BACKUP_PATH}`);
  } catch (e) {
    console.error(`备份原生 Claude 凭据失败: ${e.message}`);
  }
}

/** 从备份恢复 settings.model（如有），返回恢复的 model 或 null。 */
function restoreModelFromBackup() {
  if (process.platform === 'win32') return null;
  const backup = readBackup();
  if (!backup || typeof backup.originalModel !== 'string' || !backup.originalModel.trim()) return null;
  const settingsPath = settingsPathClaude();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const settings = loadOrInitSettings(settingsPath);
  settings.model = backup.originalModel;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return backup.originalModel;
}

/** 在清空第三方配置后自动恢复原生凭据。 */
function restoreNativeCredentialIfNeeded() {
  if (process.platform === 'win32') return;
  const backup = readBackup();
  if (!backup) return;

  // 恢复登录凭据：若写失败则中止后续 model 恢复，避免 settings 与 keychain/凭据文件状态错位
  if (typeof backup.payload === 'string' && backup.payload) {
    const current = readNativeClaudeCredential();
    if (current !== backup.payload) {
      const ok = writeNativeClaudeCredential(backup.payload);
      if (ok) {
        console.log('已恢复原生 Claude 凭据（来自备份）');
      } else {
        console.error(`恢复原生 Claude 凭据失败，备份仍保留: ${BACKUP_PATH}`);
        return;
      }
    }
  }

  // 恢复 settings.model
  const restoredModel = restoreModelFromBackup();
  if (restoredModel) {
    console.log(`已恢复原 model: ${restoredModel}`);
  }

  // 恢复成功后删除备份，避免下一轮 backup 复活已废弃的 originalModel/payload
  try { fs.unlinkSync(BACKUP_PATH); } catch {}
}

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { file: null, command: null, shell: null, value: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f' || a === '--file') {
      args.file = argv[++i];
    } else if (a === '--shell') {
      args.shell = argv[++i];
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a === 'apply-envs') {
      args.command = 'apply-envs';
    } else if (a === 'restore-login') {
      args.command = 'restore-login';
    } else if (a === 'toggle-bypass' || a === 'toggle-bypass-permissions' || a === 'toggle-skip-permissions') {
      args.command = 'toggle-bypass';
      // 可选下一个参数：on/off/true/false 显式设定，否则切换
      const next = argv[i + 1];
      if (next && /^(on|off|true|false|enable|disable)$/i.test(next)) {
        args.value = next.toLowerCase();
        i++;
      }
    }
  }
  return args;
}

function printHelp() {
  console.log(`
用法: cc-use-model [命令] [选项]

命令:
  apply-envs                       输出当前配置的环境变量语句，供当前 shell 执行
  restore-login                    从备份恢复原生 Claude 登录凭据（Keychain / .credentials.json）
  toggle-bypass [on|off]           切换 ~/.claude/settings.json 中的
                                   permissions.defaultMode = "bypassPermissions"
                                   （等价于 --dangerously-skip-permissions）。
                                   不带参数时为切换，带 on/off 时显式开关。

选项:
  -f, --file <path>     凭据文件路径（见下方默认查找顺序）
      --shell <type>    指定 shell 类型：bash / zsh / powershell / cmd
                        （默认自动检测）
  -h, --help            显示帮助

  未指定 -f 时依次尝试:
    1) 环境变量 CC_USE_MODEL_CREDENTIALS
    2) 当前目录 ./credentials.json
    3) 本工具安装目录下的 credentials.json（npm link 时即项目根）
    4) ~/.config/cc-use-model/credentials.json

示例:
  cc-use-model                           交互选择 provider/model 并写入配置
  eval \$(cc-use-model apply-envs)          bash/zsh: 设置环境变量
  cc-use-model apply-envs | Invoke-Expression  PowerShell: 设置环境变量
  cc-use-model apply-envs --shell cmd     cmd: 输出 set 语句
  cc-use-model toggle-bypass              切换 bypassPermissions 开关
  cc-use-model toggle-bypass on           显式开启 bypassPermissions
  cc-use-model toggle-bypass off          显式关闭 bypassPermissions

会交互选择 provider 与 model，并合并写入 ~/.claude/settings.json 中的 env：
  ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL
`);
}

function loadCredentials(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('credentials.json 根节点必须是对象，且每个 key 为一个 provider');
  }
  const providers = Object.entries(data).filter(([, v]) => {
    if (!v || typeof v !== 'object') return false;
    const hasApi =
      typeof v.apiUrl === 'string' && v.apiUrl.trim() && typeof v.apiKey === 'string' && v.apiKey.trim();
    const hasEnv =
      v.env &&
      typeof v.env === 'object' &&
      !Array.isArray(v.env) &&
      Object.entries(v.env).every(([k, val]) => typeof k === 'string' && k && typeof val === 'string');
    return Boolean(hasApi || hasEnv);
  });
  if (providers.length === 0) {
    throw new Error('未找到有效 provider：每项需包含 apiUrl+apiKey（字符串）或 env（对象，value 为字符串）');
  }
  return Object.fromEntries(providers);
}

function loadOrInitSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return { env: {} };
  }
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return typeof s === 'object' && s !== null ? s : { env: {} };
  } catch {
    return { env: {} };
  }
}

function settingsPathClaude() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** 读取当前 settings 中 permissions.defaultMode 是否为 bypassPermissions */
function isBypassPermissionsEnabled() {
  const s = loadOrInitSettings(settingsPathClaude());
  return Boolean(s && s.permissions && s.permissions.defaultMode === 'bypassPermissions');
}

/**
 * 切换或显式设置 permissions.defaultMode = "bypassPermissions"。
 * desired: true=开启，false=关闭，null/undefined=切换。
 * 返回切换后的最终状态（true/false）。
 */
function setBypassPermissions(desired) {
  const claudeDir = path.join(os.homedir(), '.claude');
  const settingsPath = settingsPathClaude();
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  const settings = loadOrInitSettings(settingsPath);
  const current = Boolean(settings.permissions && settings.permissions.defaultMode === 'bypassPermissions');
  const next = typeof desired === 'boolean' ? desired : !current;

  if (next) {
    const permissions = settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions)
      ? settings.permissions
      : {};
    permissions.defaultMode = 'bypassPermissions';
    settings.permissions = permissions;
  } else if (settings.permissions && typeof settings.permissions === 'object') {
    // 关闭时仅清掉 bypassPermissions 这一种 mode，保留 permissions 下的其它字段
    if (settings.permissions.defaultMode === 'bypassPermissions') {
      delete settings.permissions.defaultMode;
    }
    // 若 permissions 对象因此变空，则整体移除，避免污染配置
    if (Object.keys(settings.permissions).length === 0) {
      delete settings.permissions;
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return next;
}

/** 与 provider 的 apiUrl 比较时统一格式 */
function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/+$/, '');
}

/** 当前 ~/.claude/settings.json 中的 baseUrl、model */
function getCurrentClaudeSelection() {
  const s = loadOrInitSettings(settingsPathClaude());
  const env = s.env && typeof s.env === 'object' ? s.env : {};
  const envKey = s.envKey;
  return {
    baseUrl: env.ANTHROPIC_BASE_URL,
    model: typeof env.ANTHROPIC_MODEL === 'string' ? env.ANTHROPIC_MODEL.trim() : '',
    envKey:
      Array.isArray(envKey) && envKey.every((k) => typeof k === 'string' && k.trim())
        ? envKey.map((k) => String(k).trim())
        : null,
  };
}

/** 匹配的项保持原相对顺序，整体排到最前 */
function orderCurrentFirst(items, isCurrent) {
  const head = [];
  const tail = [];
  for (const item of items) {
    (isCurrent(item) ? head : tail).push(item);
  }
  return [...head, ...tail];
}

function resolveCredentialsPathAuto() {
  const candidates = [];
  const envPath = process.env.CC_USE_MODEL_CREDENTIALS?.trim();
  if (envPath) candidates.push(path.resolve(envPath));
  candidates.push(path.join(process.cwd(), 'credentials.json'));
  candidates.push(path.join(PKG_ROOT, 'credentials.json'));
  candidates.push(
    path.join(os.homedir(), '.config', 'cc-use-model', 'credentials.json')
  );
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

/** 检测当前 shell 类型 */
function detectShell(shellArg) {
  const validShells = ['bash', 'zsh', 'powershell', 'cmd'];
  if (shellArg) {
    const s = shellArg.toLowerCase();
    if (validShells.includes(s)) return s;
    console.error(`不支持的 shell: ${shellArg}，支持: ${validShells.join(', ')}`);
    process.exit(1);
  }
  // 优先级：SHELL 环境变量 → PSModulePath → 平台默认
  if (process.env.SHELL) {
    if (process.env.SHELL.includes('zsh')) return 'zsh';
    return 'bash';
  }
  if (process.env.PSModulePath) return 'powershell';
  if (process.platform === 'win32') return 'cmd';
  return 'bash';
}

/** 根据 shell 类型格式化单条环境变量语句 */
function formatEnvLine(shell, key, value) {
  switch (shell) {
    case 'bash':
    case 'zsh':
      return `export ${key}='${value.replace(/'/g, "'\\''")}'`;
    case 'powershell':
      return `$env:${key} = '${value.replace(/'/g, "''")}'`;
    case 'cmd':
      return `set ${key}=${value}`;
    default:
      return `export ${key}='${value.replace(/'/g, "'\\''")}'`;
  }
}

/** 输出当前配置的环境变量语句 */
function outputApplyEnvs(shell) {
  const settings = loadOrInitSettings(settingsPathClaude());
  const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const envKey = settings.envKey;

  const lines = [];

  // 输出 ANTHROPIC 相关变量
  if (env.ANTHROPIC_AUTH_TOKEN) {
    lines.push(formatEnvLine(shell, 'ANTHROPIC_AUTH_TOKEN', env.ANTHROPIC_AUTH_TOKEN));
  }
  if (env.ANTHROPIC_BASE_URL) {
    lines.push(formatEnvLine(shell, 'ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL));
  }
  if (env.ANTHROPIC_MODEL) {
    lines.push(formatEnvLine(shell, 'ANTHROPIC_MODEL', env.ANTHROPIC_MODEL));
  }

  // 输出 envKey 对应的其他变量
  if (Array.isArray(envKey)) {
    for (const k of envKey) {
      if (k in env && !k.startsWith('ANTHROPIC_')) {
        lines.push(formatEnvLine(shell, k, String(env[k])));
      }
    }
  }

  if (lines.length === 0) {
    console.error('当前无配置，请先运行 cc-use-model 进行配置');
    process.exit(1);
  }

  console.log(lines.join('\n'));
}

/** 全局 escape 键监听器 */
let escapePressed = false;
let currentAbortController = null;

function setupEscapeListener() {
  if (!process.stdin.isTTY) return;

  // 使用 readline 的 keypress 接口
  readline.emitKeypressEvents(process.stdin);

  const handler = (char, key) => {
    if (key && key.name === 'escape') {
      escapePressed = true;
      if (currentAbortController) {
        currentAbortController.abort();
      }
    }
  };

  process.stdin.on('keypress', handler);
}

/** 处理用户取消操作（ctrl+c / esc） */
function handleCancel() {
  console.log('\n已取消。');
  process.exit(0);
}

/** 包装 inquirer 操作，处理取消信号 */
async function safePrompt(promiseFactory) {
  if (escapePressed) {
    handleCancel();
  }

  const ac = new AbortController();
  currentAbortController = ac;

  try {
    return await promiseFactory(ac.signal);
  } catch (e) {
    if (e && (e.name === 'ExitPromptError' || e.name === 'AbortPromptError')) {
      handleCancel();
    }
    throw e;
  } finally {
    currentAbortController = null;
  }
}

/** 判断 provider 是否为当前 settings.json 中正在使用的 */
function isCurrentProvider(cfg, currentUrlNorm, currentEnvKey) {
  if (cfg?.env && currentEnvKey) {
    const keys = Object.keys(cfg.env).sort();
    const cur = [...currentEnvKey].sort();
    if (keys.length !== cur.length) return false;
    return keys.every((k, i) => k === cur[i]);
  }
  if (!currentUrlNorm) return false;
  if (!cfg?.apiUrl) return false;
  return normalizeBaseUrl(cfg.apiUrl) === currentUrlNorm;
}

/** 判断是否有第三方配置需要清理（即 settings.json 中有 envKey/ANTHROPIC_*） */
function hasThirdPartyConfigToClear() {
  const { baseUrl, envKey } = getCurrentClaudeSelection();
  const currentUrlNorm = normalizeBaseUrl(baseUrl);
  const hasEnvKeys = Array.isArray(envKey) && envKey.length > 0;
  const hasBaseUrl = Boolean(currentUrlNorm);
  return hasEnvKeys || hasBaseUrl;
}

/** 描述当前 ~/.claude/settings.json 实际生效的凭据状态，用于菜单展示 */
function describeCurrentCredentialState(credentials) {
  const { baseUrl, model, envKey } = getCurrentClaudeSelection();
  const currentUrlNorm = normalizeBaseUrl(baseUrl);
  const hasEnvKeys = Array.isArray(envKey) && envKey.length > 0;
  const hasBaseUrl = Boolean(currentUrlNorm);

  if (hasBaseUrl || hasEnvKeys) {
    let providerName = null;
    for (const [name, cfg] of Object.entries(credentials)) {
      if (isCurrentProvider(cfg, currentUrlNorm, envKey)) {
        providerName = name;
        break;
      }
    }
    const who = providerName || '未知第三方 provider';
    return model ? `正在使用 ${who} / ${model}` : `正在使用 ${who}`;
  }

  const native = readNativeClaudeCredential();
  if (native) return '正在使用官方登录凭证';

  return '当前无任何凭据';
}

/** 把凭据对象持久化到磁盘 */
function saveCredentials(credPath, credentials) {
  const credDir = path.dirname(credPath);
  if (!fs.existsSync(credDir)) {
    fs.mkdirSync(credDir, { recursive: true });
  }
  fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2) + '\n', 'utf8');
}

/** 从 /v1/models 响应中提取模型 ID（兼容 Anthropic 与 OpenAI 两种格式）。 */
function extractModelIds(body) {
  if (!body || typeof body !== 'object') return [];
  const data = Array.isArray(body.data) ? body.data : [];
  const models = Array.isArray(body.models) ? body.models : [];
  const list = data.length > 0 ? data : models;
  const ids = [];
  for (const item of list) {
    if (item && typeof item === 'object') {
      const id = item.id || item.name || item.model;
      if (typeof id === 'string' && id.trim()) ids.push(id.trim());
    } else if (typeof item === 'string' && item.trim()) {
      ids.push(item.trim());
    }
  }
  return [...new Set(ids)];
}

/** 从上游 Anthropic 兼容 API 获取模型列表。成功返回 string[]，失败抛出带描述的 Error。 */
async function fetchModelsFromUpstream(apiUrl, apiKey) {
  const base = normalizeBaseUrl(apiUrl);
  if (!base) throw new Error('该 provider 未配置 apiUrl，无法同步');
  if (!apiKey || !String(apiKey).trim()) throw new Error('该 provider 未配置 apiKey，无法同步');

  const endpoint = `${base}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'x-api-key': String(apiKey),
        'anthropic-version': '2023-06-01',
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`上游返回 ${res.status} ${res.statusText}`);
    }
    const body = await res.json();
    const models = extractModelIds(body);
    if (!models || models.length === 0) {
      throw new Error('上游返回中未找到任何模型');
    }
    return models;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时（10s）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 交互获取 models：手动输入逗号分隔，或输入 ? 触发从上游同步。返回 string[]。 */
async function promptModelsWithSync(defaultModels, apiUrl, apiKey) {
  while (true) {
    const inputVal = await safePrompt((signal) => input({
      message: '请输入 Models（逗号分隔，留空清除，输入 ? 从上游同步）',
      default: defaultModels,
    }, { signal }));
    const trimmed = String(inputVal).trim();

    if (trimmed === '?') {
      console.log(`正在从上游获取模型列表（${apiUrl}）...`);
      try {
        const models = await fetchModelsFromUpstream(apiUrl, apiKey);
        console.log(`发现 ${models.length} 个模型：`);
        for (const m of models) console.log(`  ${m}`);
        const ok = await safePrompt((signal) => confirm({
          message: `确认使用这 ${models.length} 个模型？`,
          default: true,
        }, { signal }));
        if (ok) return models;
        console.log('已取消，请重新输入。');
      } catch (e) {
        console.error(`同步失败: ${e.message}`);
        console.log('请手动输入。');
      }
      continue;
    }

    return trimmed
      ? trimmed.split(',').map((m) => m.trim()).filter(Boolean)
      : [];
  }
}

/** 从上游同步模型并写入 provider；成功返回 true，失败/取消返回 false。 */
async function syncModelsFlow(cfg, target, credentials, credPath) {
  if (cfg.env) {
    console.log('注：env provider 无 apiUrl/apiKey，无法从上游同步模型。');
    return false;
  }
  console.log(`正在从上游获取模型列表（${cfg.apiUrl}）...`);
  let models;
  try {
    models = await fetchModelsFromUpstream(cfg.apiUrl, cfg.apiKey);
  } catch (e) {
    console.error(`同步失败: ${e.message}`);
    return false;
  }

  // 尝试获取上下文窗口信息
  let contextMap = new Map();
  try {
    const base = normalizeBaseUrl(cfg.apiUrl);
    const endpoint = `${base}/v1/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'x-api-key': String(cfg.apiKey),
        'anthropic-version': '2023-06-01',
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const body = await res.json();
      const infos = extractModelInfo(body);
      for (const info of infos) {
        const tokens = info.maxInputTokens || info.contextLength || null;
        if (tokens != null) contextMap.set(info.id, tokens);
      }
    }
  } catch { /* 获取上下文信息失败不阻塞同步 */ }

  console.log(`发现 ${models.length} 个模型：`);
  const hasContext = contextMap.size > 0;
  for (const m of models) {
    const ctx = contextMap.get(m);
    const suffix = ctx != null ? ` (context=${formatContextSize(ctx)})` : '';
    console.log(`  ${m}${suffix}`);
  }
  if (!hasContext) console.log('  (上游未返回上下文窗口信息)');

  const ok = await safePrompt((signal) => confirm({
    message: `确认用这 ${models.length} 个模型覆盖「${target}」的现有列表？`,
    default: true,
  }, { signal }));
  if (!ok) {
    console.log('已取消。');
    return false;
  }
  credentials[target] = { ...cfg, models };
  saveCredentials(credPath, credentials);
  console.log(`已更新: ${target}（models 已从上游同步）`);
  return true;
}

/** 从 /v1/models 响应中提取模型信息（含上下文窗口）。兼容 Anthropic / OpenRouter 格式。 */
function extractModelInfo(body) {
  if (!body || typeof body !== 'object') return [];
  const data = Array.isArray(body.data) ? body.data : [];
  const models = Array.isArray(body.models) ? body.models : [];
  const list = data.length > 0 ? data : models;
  const results = [];
  for (const item of list) {
    if (item && typeof item === 'object') {
      const id = item.id || item.name || item.model;
      if (typeof id === 'string' && id.trim()) {
        results.push({
          id: id.trim(),
          maxInputTokens: typeof item.max_input_tokens === 'number' ? item.max_input_tokens : null,
          contextLength: typeof item.context_length === 'number' ? item.context_length : null,
        });
      }
    }
  }
  return results;
}

/** 格式化上下文窗口大小。 */
function formatContextSize(tokens) {
  if (tokens == null) return '?';
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`;
  return String(tokens);
}

/** 管理凭据：列出 / 编辑 / 删除 */
async function manageCredentials(credentials, credPath, { currentUrlNorm, currentEnvKey }) {
  while (true) {
    const names = Object.keys(credentials);
    if (names.length === 0) {
      console.log('凭据文件已无 provider，返回主菜单。');
      return;
    }

    const BACK = '__BACK__';
    const target = await safePrompt((signal) => select({
      message: '管理凭据 — 选择要操作的 Provider',
      choices: [
        ...names.map((name) => {
          const c = credentials[name];
          const type = c.env ? '[env]' : '[api]';
          const cur = isCurrentProvider(c, currentUrlNorm, currentEnvKey) ? ' （当前选择）' : '';
          return { name: `${type} ${name}${cur}`, value: name };
        }),
        { name: '← 返回', value: BACK },
      ],
    }, { signal }));

    if (target === BACK) return;

    const cfg = credentials[target];

    // 显示当前配置详情
    console.log(`\n当前配置 - ${target}:`);
    if (cfg.env) {
      console.log(`  类型: env provider`);
      for (const [k, v] of Object.entries(cfg.env)) {
        const masked = k.toLowerCase().includes('token') || k.toLowerCase().includes('key')
          ? '（已隐藏）'
          : v;
        console.log(`  env.${k}: ${masked}`);
      }
    } else {
      console.log(`  类型: 标准 provider`);
      console.log(`  apiUrl: ${cfg.apiUrl}`);
      console.log(`  apiKey: ${cfg.apiKey ? '（已隐藏）' : '(未设置)'}`);
    }
    console.log(`  models: ${cfg.models && cfg.models.length > 0 ? cfg.models.join(', ') : '(无)'}\n`);

    const op = await safePrompt((signal) => select({
      message: `选择对 ${target} 的操作`,
      choices: [
        { name: '✏️  编辑', value: 'edit' },
        { name: '🔄  从上游同步模型', value: 'sync' },
        { name: '🗑️  删除', value: 'delete' },
        { name: '← 返回', value: 'back' },
      ],
    }, { signal }));

    if (op === 'back') continue;

    if (op === 'delete') {
      const ok = await safePrompt((signal) => confirm({
        message: `确认删除 Provider「${target}」？此操作仅修改 credentials.json，不会影响 ~/.claude/settings.json`,
        default: false,
      }, { signal }));
      if (!ok) {
        console.log('已取消。');
        continue;
      }
      delete credentials[target];
      saveCredentials(credPath, credentials);
      console.log(`已删除: ${target}`);
      continue;
    }

    if (op === 'sync') {
      await syncModelsFlow(cfg, target, credentials, credPath);
      continue;
    }

    if (op === 'edit') {
      if (cfg.env) {
        // env provider：仅支持编辑 models（env 字段较复杂，建议手动编辑文件）
        console.log('注：env provider 的 env 字段请手动编辑文件，这里仅支持修改 models。');
        const modelsInput = await safePrompt((signal) => input({
          message: '请输入 Models（逗号分隔，留空清除）',
          default: cfg.models?.join(', ') || '',
        }, { signal }));
        const models = modelsInput
          ? modelsInput.split(',').map((m) => m.trim()).filter(Boolean)
          : [];
        const updated = { ...cfg };
        if (models.length > 0) updated.models = models;
        else delete updated.models;
        credentials[target] = updated;
        saveCredentials(credPath, credentials);
        console.log(`已更新: ${target}`);
        continue;
      }

      // 标准 provider：编辑 apiUrl / apiKey / models
      const apiUrl = await safePrompt((signal) => input({
        message: '请输入 API URL',
        default: cfg.apiUrl,
        validate: (v) => (v && String(v).trim() ? true : '不能为空'),
      }, { signal }));

      const apiKey = await safePrompt((signal) => input({
        message: '请输入 API Key',
        default: cfg.apiKey,
        validate: (v) => (v && String(v).trim() ? true : '不能为空'),
      }, { signal }));

      const models = await promptModelsWithSync(
        cfg.models?.join(', ') || '',
        apiUrl.trim(),
        apiKey.trim()
      );

      credentials[target] = {
        apiUrl: apiUrl.trim(),
        apiKey: apiKey.trim(),
        ...(models.length > 0 ? { models } : {}),
      };
      saveCredentials(credPath, credentials);
      console.log(`已更新: ${target}`);
    }
  }
}

/** 子流程返回标识 */
const BACK = '__BACK__';

/** 添加 Provider 子流程；成功返回新 provider 名，取消/返回返回 BACK */
async function addProviderFlow(credentials, credPath) {
  let newProviderName;
  if (Object.keys(credentials).length > 0) {
    newProviderName = await safePrompt((signal) => select({
      message: '选择已有 Provider（覆盖）或新增',
      choices: [
        { name: '➕  新增 Provider', value: '__NEW__' },
        ...Object.keys(credentials).map((name) => ({ name: `覆盖：${name}`, value: name })),
        { name: '← 返回上一层', value: BACK },
      ],
    }, { signal }));
    if (newProviderName === BACK) return null;
    if (newProviderName === '__NEW__') {
      newProviderName = await safePrompt((signal) => input({
        message: '请输入 Provider 名称',
        validate: (v) => (v && String(v).trim() ? true : '不能为空'),
      }, { signal }));
      newProviderName = String(newProviderName).trim();
    }
  } else {
    newProviderName = await safePrompt((signal) => input({
      message: '请输入 Provider 名称',
      validate: (v) => (v && String(v).trim() ? true : '不能为空'),
    }, { signal }));
    newProviderName = String(newProviderName).trim();
  }

  const apiUrl = await safePrompt((signal) => input({
    message: '请输入 API URL',
    default: credentials[newProviderName]?.apiUrl || 'https://api.anthropic.com',
    validate: (v) => (v && String(v).trim() ? true : '不能为空'),
  }, { signal }));

  const apiKey = await safePrompt((signal) => input({
    message: '请输入 API Key',
    default: credentials[newProviderName]?.apiKey || undefined,
    validate: (v) => (v && String(v).trim() ? true : '不能为空'),
  }, { signal }));

  const modelsInput = await safePrompt((signal) => input({
    message: '请输入 Models（逗号分隔）',
    default: credentials[newProviderName]?.models?.join(', ') || undefined,
  }, { signal }));
  const models = modelsInput
    ? modelsInput.split(',').map((m) => m.trim()).filter(Boolean)
    : [];

  const ok = await safePrompt((signal) => confirm({
    message: `将保存到 ${credPath}：\n  Provider: ${newProviderName}\n  API URL: ${apiUrl}\n  API Key: （已隐藏）\n  Models: ${models.length > 0 ? models.join(', ') : '（无）'}\n确认？`,
    default: true,
  }, { signal }));
  if (!ok) {
    console.log('已取消。');
    return BACK;
  }

  // 读取或创建 credentials.json，避免覆盖磁盘上已有的其他 provider
  let allCredentials = { ...credentials };
  if (fs.existsSync(credPath)) {
    try {
      const raw = fs.readFileSync(credPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        allCredentials = parsed;
      }
    } catch {}
  }

  allCredentials[newProviderName] = {
    apiUrl: apiUrl.trim(),
    apiKey: apiKey.trim(),
    ...(models.length > 0 ? { models } : {}),
  };

  saveCredentials(credPath, allCredentials);
  console.log(`已保存凭据: ${credPath}`);
  credentials[newProviderName] = allCredentials[newProviderName];
  return newProviderName;
}

/** 把选好的 provider/model 写入 settings.json */
function applySettings(cfg, model) {
  backupNativeCredentialIfNeeded();

  const claudeDir = path.join(os.homedir(), '.claude');
  const settingsPath = settingsPathClaude();
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const settings = loadOrInitSettings(settingsPath);
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};

  if (Array.isArray(settings.envKey)) {
    for (const k of settings.envKey) {
      if (typeof k === 'string' && k in env) delete env[k];
    }
  }

  if (cfg.env) {
    for (const [k, v] of Object.entries(cfg.env)) {
      env[k] = v;
    }
    env.ANTHROPIC_MODEL = model;
    settings.envKey = Object.keys(cfg.env);
  } else {
    if ('envKey' in settings) delete settings.envKey;
    env.ANTHROPIC_AUTH_TOKEN = cfg.apiKey;
    env.ANTHROPIC_BASE_URL = cfg.apiUrl;
    env.ANTHROPIC_MODEL = model;
  }

  settings.env = env;
  settings.model = model;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log(`已更新: ${settingsPath}`);
}

const APPLIED = '__APPLIED__';

/** 选择 Provider/Model 并应用到 settings.json；应用成功返回 APPLIED，中途取消返回 BACK */
async function selectAndApplyFlow(credentials, presetProvider = null) {
  if (Object.keys(credentials).length === 0) {
    console.log('当前没有任何 Provider，请先添加。');
    return BACK;
  }

  const { baseUrl, model: currentModel, envKey: currentEnvKey } = getCurrentClaudeSelection();
  const currentUrlNorm = normalizeBaseUrl(baseUrl);

  let provider = presetProvider;

  while (true) {
    if (!provider) {
      const providerKeys = orderCurrentFirst(Object.keys(credentials), (name) =>
        isCurrentProvider(credentials[name], currentUrlNorm, currentEnvKey)
      );
      provider = await safePrompt((signal) => select({
        message: '选择 Provider',
        choices: [
          ...providerKeys.map((name) => {
            const c = credentials[name];
            const isCur = isCurrentProvider(c, currentUrlNorm, currentEnvKey);
            return { name: isCur ? `${name} （当前选择）` : name, value: name };
          }),
          { name: '← 返回上一层', value: BACK },
        ],
      }, { signal }));
      if (provider === BACK) return BACK;
    }

    const cfg = credentials[provider];
    let model;

    if (Array.isArray(cfg.models) && cfg.models.length > 0) {
      const modelsOrdered = orderCurrentFirst(
        cfg.models.map((m) => String(m)),
        (m) => Boolean(currentModel && m === currentModel)
      );
      model = await safePrompt((signal) => select({
        message: `选择 Model（${provider}）`,
        choices: [
          ...modelsOrdered.map((m) => ({
            name: currentModel && m === currentModel ? `${m} （当前选择）` : m,
            value: m,
          })),
          { name: '← 返回上一层（重选 Provider）', value: BACK },
        ],
      }, { signal }));
      if (model === BACK) {
        provider = null;
        continue;
      }
    } else {
      const hint = currentModel ? `（回车沿用当前：${currentModel}）` : '';
      model = await safePrompt((signal) => input({
        message: `该 provider 未配置 models，请输入 model 名称${hint}`,
        default: currentModel || undefined,
        validate: (v) => (v && String(v).trim() ? true : '不能为空'),
      }, { signal }));
      model = String(model).trim();
    }

    let preview;
    if (cfg.env) {
      const envPairs = Object.entries(cfg.env)
        .map(([k, v]) => `  ${k}: ${k.toLowerCase().includes('token') || k.toLowerCase().includes('key') ? '（已隐藏）' : v}`)
        .join('\n');
      preview = `将写入 ~/.claude/settings.json：\n${envPairs}\n  ANTHROPIC_MODEL: ${model}\n确认？`;
    } else {
      preview = `将写入 ~/.claude/settings.json：\n  ANTHROPIC_BASE_URL: ${cfg.apiUrl}\n  ANTHROPIC_MODEL: ${model}\n  ANTHROPIC_AUTH_TOKEN: （已隐藏）\n确认？`;
    }

    const ok = await safePrompt((signal) => confirm({ message: preview, default: true }, { signal }));
    if (!ok) {
      console.log('已取消。');
      return BACK;
    }

    applySettings(cfg, model);
    return APPLIED;
  }
}

/** 清空配置子流程；成功或取消后都返回 undefined（回到主菜单） */
async function clearConfigFlow() {
  const ok = await safePrompt((signal) => confirm({
    message: '将清空 ~/.claude/settings.json 中的 env 配置（ANTHROPIC_AUTH_TOKEN、ANTHROPIC_BASE_URL、ANTHROPIC_MODEL 等）\n确认？',
    default: true,
  }, { signal }));
  if (!ok) {
    console.log('已取消。');
    return BACK;
  }

  const claudeDir = path.join(os.homedir(), '.claude');
  const settingsPath = settingsPathClaude();
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const settings = loadOrInitSettings(settingsPath);
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};

  if (Array.isArray(settings.envKey)) {
    for (const k of settings.envKey) {
      if (typeof k === 'string' && k in env) delete env[k];
    }
    delete settings.envKey;
  }
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_MODEL;

  delete settings.model;
  settings.env = env;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log(`已清空配置: ${settingsPath}`);

  restoreNativeCredentialIfNeeded();
  // 不返回任何值（回到主菜单）
  return;
}

async function main() {
  // 设置 escape 键监听
  setupEscapeListener();

  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // 处理 apply-envs 命令
  if (args.command === 'apply-envs') {
    const shell = detectShell(args.shell);
    outputApplyEnvs(shell);
    process.exit(0);
  }

  // 处理 restore-login 命令
  if (args.command === 'restore-login') {
    if (process.platform === 'win32') {
      console.error('Windows 暂不支持自动恢复原生 Claude 凭据，请使用 /login 重新登录。');
      process.exit(1);
    }
    if (!fs.existsSync(BACKUP_PATH)) {
      console.error(`未找到备份文件: ${BACKUP_PATH}`);
      process.exit(1);
    }
    let backup;
    try {
      backup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
    } catch (e) {
      console.error(`备份文件解析失败: ${e.message}`);
      process.exit(1);
    }
    if (!backup || typeof backup !== 'object') {
      console.error('备份文件内容无效。');
      process.exit(1);
    }

    // 恢复登录凭据
    const hasPayload = typeof backup.payload === 'string' && backup.payload;
    if (hasPayload) {
      const current = readNativeClaudeCredential();
      if (current === backup.payload) {
        console.log('当前原生凭据已与备份一致，无需恢复。');
      } else {
        const ok = writeNativeClaudeCredential(backup.payload);
        if (ok) {
          console.log('已从备份恢复原生 Claude 凭据。');
        } else {
          console.error(`恢复失败，备份仍保留: ${BACKUP_PATH}`);
          process.exit(1);
        }
      }
    }

    // 恢复 settings.model
    const restoredModel = restoreModelFromBackup();
    if (restoredModel) {
      console.log(`已恢复原 model: ${restoredModel}`);
    }

    if (!hasPayload && !restoredModel) {
      console.error('备份文件内容无效（无凭据也无 model）。');
      process.exit(1);
    }
    // 恢复成功后删除备份，避免下次 backup 复活已废弃的 originalModel/payload
    try { fs.unlinkSync(BACKUP_PATH); } catch {}
    process.exit(0);
  }

  // 处理 toggle-bypass 命令
  if (args.command === 'toggle-bypass') {
    let desired = null;
    if (args.value) {
      desired = ['on', 'true', 'enable'].includes(args.value);
    }
    const next = setBypassPermissions(desired);
    console.log(
      next
        ? '已开启：permissions.defaultMode = "bypassPermissions"（等价于 --dangerously-skip-permissions）'
        : '已关闭：permissions.defaultMode（已移除 bypassPermissions）'
    );
    console.log(`配置文件: ${settingsPathClaude()}`);
    process.exit(0);
  }

  // 解析凭据文件路径
  let credPath;
  if (args.file) {
    credPath = path.resolve(args.file);
    if (!fs.existsSync(credPath)) {
      console.error(`未找到凭据文件: ${credPath}`);
      process.exit(1);
    }
  } else {
    credPath = resolveCredentialsPathAuto() || path.join(os.homedir(), '.config', 'cc-use-model', 'credentials.json');
  }

  let credentials = {};
  if (fs.existsSync(credPath)) {
    console.log(`使用凭据: ${credPath}`);
    try {
      credentials = loadCredentials(credPath);
    } catch (e) {
      console.error('读取 credentials.json 失败:', e.message);
      process.exit(1);
    }
  }

  // 顶层菜单循环：每轮根据是否有 provider 决定走首次引导还是主菜单
  let firstRound = true;
  while (true) {
    // 空状态：直接引导添加第一个 Provider
    if (Object.keys(credentials).length === 0) {
      if (firstRound) {
        console.log('\n👋 欢迎使用 cc-use-model！当前没有任何 Provider，让我们先添加第一个。\n');
      } else {
        console.log('\n当前没有任何 Provider，请添加一个。\n');
      }
      firstRound = false;
      const newName = await addProviderFlow(credentials, credPath);
      if (newName === BACK) {
        console.log('未创建 Provider，已退出。');
        process.exit(0);
      }
      const useNow = await safePrompt((signal) => confirm({
        message: `是否立即使用 Provider「${newName}」？`,
        default: true,
      }, { signal }));
      if (useNow) {
        const result = await selectAndApplyFlow(credentials, newName);
        if (result === APPLIED) process.exit(0);
      }
      continue;
    }

    firstRound = false;

    const needsClear = hasThirdPartyConfigToClear();
    const stateDesc = describeCurrentCredentialState(credentials);

    const menuChoices = [
      { name: '🎯  选择 Provider / Model', value: 'select' },
      { name: '➕  添加 Provider', value: 'add' },
      { name: '⚙️  管理凭据（编辑 / 删除）', value: 'manage' },
    ];
    const bypassOn = isBypassPermissionsEnabled();
    menuChoices.push({
      name: `🛡️  切换 bypassPermissions（当前：${bypassOn ? '已开启' : '已关闭'}）`,
      value: 'toggle-bypass',
    });
    if (needsClear) {
      menuChoices.push({ name: `🗑️  清空配置（${stateDesc}）`, value: 'clear' });
    }
    menuChoices.push({ name: '👋  退出', value: 'exit' });

    const action = await safePrompt((signal) => select({
      message: '请选择操作',
      choices: menuChoices,
    }, { signal }));

    if (action === 'exit') {
      process.exit(0);
    } else if (action === 'select') {
      const result = await selectAndApplyFlow(credentials);
      if (result === APPLIED) process.exit(0);
    } else if (action === 'add') {
      const newName = await addProviderFlow(credentials, credPath);
      if (newName && newName !== BACK) {
        const useNow = await safePrompt((signal) => confirm({
          message: `是否立即使用 Provider「${newName}」？`,
          default: true,
        }, { signal }));
        if (useNow) {
          const result = await selectAndApplyFlow(credentials, newName);
          if (result === APPLIED) process.exit(0);
        }
      }
    } else if (action === 'manage') {
      const { baseUrl, envKey } = getCurrentClaudeSelection();
      await manageCredentials(credentials, credPath, {
        currentUrlNorm: normalizeBaseUrl(baseUrl),
        currentEnvKey: envKey,
      });
    } else if (action === 'clear') {
      await clearConfigFlow();
      // 回到主菜单
    } else if (action === 'toggle-bypass') {
      const next = setBypassPermissions(null);
      console.log(
        next
          ? '✅ 已开启 bypassPermissions（permissions.defaultMode = "bypassPermissions"，等价于 --dangerously-skip-permissions）'
          : '✅ 已关闭 bypassPermissions'
      );
      // 回到主菜单
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
