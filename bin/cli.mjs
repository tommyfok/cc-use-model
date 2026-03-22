#!/usr/bin/env node
/**
 * 读取 credentials.json，交互选择 provider / model，更新 ~/.claude/settings.json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { select, input, confirm } from '@inquirer/prompts';

// 用户取消操作的错误类
class UserCancelError extends Error {
  constructor(message = '用户取消操作') {
    super(message);
    this.name = 'UserCancelError';
  }
}

// 优雅退出处理
function gracefulExit() {
  console.log('\n已退出。');
  process.exit(0);
}

// 捕获 Ctrl+C
process.on('SIGINT', gracefulExit);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { file: null, command: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f' || a === '--file') {
      args.file = argv[++i];
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a === 'apply-envs') {
      args.command = 'apply-envs';
    }
  }
  return args;
}

function printHelp() {
  console.log(`
用法: cc-use-model [选项] [命令]

命令:
  apply-envs          输出 shell 环境变量设置语句，配合 eval 使用：
                     eval "$(cc-use-model apply-envs)"

选项:
  -f, --file <path>   凭据文件路径（见下方默认查找顺序）
  -h, --help          显示帮助

  未指定 -f 时依次尝试:
    1) 环境变量 CC_USE_MODEL_CREDENTIALS
    2) 当前目录 ./credentials.json
    3) 本工具安装目录下的 credentials.json（npm link 时即项目根）
    4) ~/.config/cc-use-model/credentials.json

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

/** 获取当前配置的环境变量，用于 apply-envs 命令 */
function getCurrentEnvForExport() {
  const s = loadOrInitSettings(settingsPathClaude());
  const env = s.env && typeof s.env === 'object' ? s.env : {};
  return env;
}

/** 输出 shell export 语句 */
function printExportStatements() {
  const env = getCurrentEnvForExport();
  const exportLines = [];

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      // 对值进行转义处理，防止特殊字符问题
      const escapedValue = value.replace(/'/g, "'\\''");
      exportLines.push(`export ${key}='${escapedValue}'`);
    }
  }

  if (exportLines.length === 0) {
    console.error('# 无环境变量需要设置');
    process.exit(1);
  }

  console.log(exportLines.join('\n'));
}

/** 包装 inquirer 操作，捕获取消操作 */
async function safePrompt(promise) {
  try {
    return await promise;
  } catch (err) {
    // @inquirer/prompts 在用户按 esc/ctrl+c 时会抛出错误
    if (err && (err.name === 'ExitPromptError' || err.message?.includes('User force closed the prompt'))) {
      gracefulExit();
    }
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // 处理 apply-envs 命令
  if (args.command === 'apply-envs') {
    printExportStatements();
    process.exit(0);
  }

  let credPath;
  let noCredentialsFile = false;
  if (args.file) {
    credPath = path.resolve(args.file);
    if (!fs.existsSync(credPath)) {
      console.error(`未找到凭据文件: ${credPath}`);
      process.exit(1);
    }
  } else {
    credPath = resolveCredentialsPathAuto();
    if (!credPath) {
      noCredentialsFile = true;
      // 默认使用 ~/.config/cc-use-model/credentials.json
      credPath = path.join(os.homedir(), '.config', 'cc-use-model', 'credentials.json');
    }
  }

  if (!noCredentialsFile) {
    console.log(`使用凭据: ${credPath}`);
  }

  let credentials = {};
  if (!noCredentialsFile) {
    try {
      credentials = loadCredentials(credPath);
    } catch (e) {
      console.error('读取 credentials.json 失败:', e.message);
      process.exit(1);
    }
  }

  const { baseUrl: currentBaseUrl, model: currentModel, envKey: currentEnvKey } = getCurrentClaudeSelection();
  const currentUrlNorm = normalizeBaseUrl(currentBaseUrl);

  const providerKeys = orderCurrentFirst(Object.keys(credentials), (name) => {
    const c = credentials[name];
    if (c?.env && currentEnvKey) {
      const keys = Object.keys(c.env).sort();
      const cur = [...currentEnvKey].sort();
      if (keys.length !== cur.length) return false;
      return keys.every((k, i) => k === cur[i]);
    }
    if (!currentUrlNorm) return false;
    if (!c?.apiUrl) return false;
    return normalizeBaseUrl(c.apiUrl) === currentUrlNorm;
  });

  // 特殊选项：增加配置、清空配置
  const ADD_CHOICE = '__ADD__';
  const CLEAR_CHOICE = '__CLEAR__';

  // 如果没有凭据文件，直接进入增加配置流程
  let provider;
  if (noCredentialsFile) {
    provider = ADD_CHOICE;
  } else {
    provider = await safePrompt(select({
      message: '选择 Provider',
      choices: [
        ...providerKeys.map((name) => {
          const c = credentials[name];
          const isCur =
            (c?.env &&
              currentEnvKey &&
              Object.keys(c.env).length === currentEnvKey.length &&
              Object.keys(c.env).every((k) => currentEnvKey.includes(k))) ||
            (currentUrlNorm && c?.apiUrl && normalizeBaseUrl(c.apiUrl) === currentUrlNorm);
          return {
            name: isCur ? `${name} （当前选择）` : name,
            value: name,
          };
        }),
        { name: '➕  增加配置', value: ADD_CHOICE },
        { name: '🗑️  清空配置（恢复无 API Key 状态）', value: CLEAR_CHOICE },
      ],
    }));
  }

  // 处理增加配置
  if (provider === ADD_CHOICE) {
    // 让用户填写 provider 名称，如果已有凭据则提供选择
    let newProviderName;
    if (Object.keys(credentials).length > 0) {
      newProviderName = await safePrompt(select({
        message: '选择或输入 Provider 名称',
        choices: [
          ...Object.keys(credentials).map((name) => ({ name, value: name })),
          { name: '➕  新增 Provider', value: '__NEW__' },
        ],
      }));
      if (newProviderName === '__NEW__') {
        newProviderName = await safePrompt(input({
          message: '请输入 Provider 名称',
          validate: (v) => (v && String(v).trim() ? true : '不能为空'),
        }));
        newProviderName = String(newProviderName).trim();
      }
    } else {
      newProviderName = await safePrompt(input({
        message: '请输入 Provider 名称',
        validate: (v) => (v && String(v).trim() ? true : '不能为空'),
      }));
      newProviderName = String(newProviderName).trim();
    }

    const apiUrl = await safePrompt(input({
      message: '请输入 API URL',
      default: credentials[newProviderName]?.apiUrl || 'https://api.anthropic.com',
      validate: (v) => (v && String(v).trim() ? true : '不能为空'),
    }));

    const apiKey = await safePrompt(input({
      message: '请输入 API Key',
      default: credentials[newProviderName]?.apiKey || undefined,
      validate: (v) => (v && String(v).trim() ? true : '不能为空'),
    }));

    const modelsInput = await safePrompt(input({
      message: '请输入 Models（逗号分隔）',
      default: credentials[newProviderName]?.models?.join(', ') || undefined,
    }));
    const models = modelsInput
      ? modelsInput.split(',').map((m) => m.trim()).filter(Boolean)
      : [];

    // 确认保存
    const ok = await safePrompt(confirm({
      message: `将保存到 ${credPath}：\n  Provider: ${newProviderName}\n  API URL: ${apiUrl}\n  API Key: （已隐藏）\n  Models: ${models.length > 0 ? models.join(', ') : '（无）'}\n确认？`,
      default: true,
    }));
    if (!ok) {
      console.log('已取消。');
      process.exit(0);
    }

    // 读取或创建 credentials.json
    let allCredentials = {};
    if (fs.existsSync(credPath)) {
      try {
        const raw = fs.readFileSync(credPath, 'utf8');
        allCredentials = JSON.parse(raw);
        if (typeof allCredentials !== 'object' || allCredentials === null || Array.isArray(allCredentials)) {
          allCredentials = {};
        }
      } catch {
        allCredentials = {};
      }
    }

    allCredentials[newProviderName] = {
      apiUrl: apiUrl.trim(),
      apiKey: apiKey.trim(),
      ...(models.length > 0 ? { models } : {}),
    };

    // 确保目录存在
    const credDir = path.dirname(credPath);
    if (!fs.existsSync(credDir)) {
      fs.mkdirSync(credDir, { recursive: true });
    }

    fs.writeFileSync(credPath, JSON.stringify(allCredentials, null, 2) + '\n', 'utf8');
    console.log(`已保存凭据: ${credPath}`);

    // 更新 credentials 并继续选择 model
    credentials[newProviderName] = allCredentials[newProviderName];
    provider = newProviderName;
  }

  // 处理清空配置
  if (provider === CLEAR_CHOICE) {
    const ok = await safePrompt(confirm({
      message: '将清空 ~/.claude/settings.json 中的 env 配置（ANTHROPIC_AUTH_TOKEN、ANTHROPIC_BASE_URL、ANTHROPIC_MODEL 等）\n确认？',
      default: true,
    }));
    if (!ok) {
      console.log('已取消。');
      process.exit(0);
    }

    const home = os.homedir();
    const claudeDir = path.join(home, '.claude');
    const settingsPath = settingsPathClaude();

    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    const settings = loadOrInitSettings(settingsPath);
    const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};

    // 清理 envKey 对应的 env 变量
    if (Array.isArray(settings.envKey)) {
      for (const k of settings.envKey) {
        if (typeof k === 'string' && k in env) delete env[k];
      }
      delete settings.envKey;
    }

    // 清理 ANTHROPIC 相关字段
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_MODEL;

    // 清理顶层 model 字段
    delete settings.model;

    settings.env = env;

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    console.log(`已清空配置: ${settingsPath}`);
    process.exit(0);
  }

  const cfg = credentials[provider];
  let model;

  if (Array.isArray(cfg.models) && cfg.models.length > 0) {
    const modelsOrdered = orderCurrentFirst(
      cfg.models.map((m) => String(m)),
      (m) => Boolean(currentModel && m === currentModel)
    );
    model = await safePrompt(select({
      message: `选择 Model（${provider}）`,
      choices: modelsOrdered.map((m) => ({
        name: currentModel && m === currentModel ? `${m} （当前选择）` : m,
        value: m,
      })),
    }));
  } else {
    const hint =
      currentModel && (!cfg.models || cfg.models.length === 0)
        ? `（回车沿用当前：${currentModel}）`
        : '';
    model = await safePrompt(input({
      message: `该 provider 未配置 models，请输入 model 名称${hint}`,
      default: currentModel || undefined,
      validate: (v) => (v && String(v).trim() ? true : '不能为空'),
    }));
    model = String(model).trim();
  }

  let preview = '';
  if (cfg.env) {
    const envPairs = Object.entries(cfg.env)
      .map(([k, v]) => `  ${k}: ${k.toLowerCase().includes('token') || k.toLowerCase().includes('key') ? '（已隐藏）' : v}`)
      .join('\n');
    preview = `将写入 ~/.claude/settings.json：\n${envPairs}\n  ANTHROPIC_MODEL: ${model}\n确认？`;
  } else {
    preview = `将写入 ~/.claude/settings.json：\n  ANTHROPIC_BASE_URL: ${cfg.apiUrl}\n  ANTHROPIC_MODEL: ${model}\n  ANTHROPIC_AUTH_TOKEN: （已隐藏）\n确认？`;
  }

  const ok = await safePrompt(confirm({ message: preview, default: true }));
  if (!ok) {
    console.log('已取消。');
    process.exit(0);
  }

  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  const settingsPath = settingsPathClaude();

  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const settings = loadOrInitSettings(settingsPath);
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};

  // 切换 provider 时，清理旧 envKey 对应的 env 变量
  if (Array.isArray(settings.envKey)) {
    for (const k of settings.envKey) {
      if (typeof k === 'string' && k in env) delete env[k];
    }
  }

  if (cfg.env) {
    // env provider：忽略 apiUrl/apiKey，覆盖写入对应 env 字段，并记录 envKey
    for (const [k, v] of Object.entries(cfg.env)) {
      env[k] = v;
    }
    env.ANTHROPIC_MODEL = model;
    settings.envKey = Object.keys(cfg.env);
  } else {
    // 非 env provider：删除旧 envKey，并按原逻辑写入 ANTHROPIC_*
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

main().catch((err) => {
  // 用户取消操作，正常退出
  if (err instanceof UserCancelError) {
    gracefulExit();
  }
  console.error(err);
  process.exit(1);
});
