#!/usr/bin/env node
/**
 * 读取 credentials.json，交互选择 provider / model，更新 ~/.claude/settings.json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { select, input, confirm } from '@inquirer/prompts';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 信号处理：Ctrl+C / ESC 优雅退出
process.on('SIGINT', () => {
  console.log('\n已取消。');
  process.exit(0);
});

function parseArgs(argv) {
  const args = { file: null, command: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f' || a === '--file') {
      args.file = argv[++i];
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (!args.command && !a.startsWith('-')) {
      args.command = a;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
用法: cc-use-model [命令] [选项]

命令:
  apply-envs          输出环境变量 export 语句（用于 eval $(cc-use-model apply-envs)）

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

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
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
    provider = await select({
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
    });
  }

  // 处理增加配置
  if (provider === ADD_CHOICE) {
    // 让用户填写 provider 名称，如果已有凭据则提供选择
    let newProviderName;
    if (Object.keys(credentials).length > 0) {
      newProviderName = await select({
        message: '选择或输入 Provider 名称',
        choices: [
          ...Object.keys(credentials).map((name) => ({ name, value: name })),
          { name: '➕  新增 Provider', value: '__NEW__' },
        ],
      });
      if (newProviderName === '__NEW__') {
        newProviderName = await input({
          message: '请输入 Provider 名称',
          validate: (v) => (v && String(v).trim() ? true : '不能为空'),
        });
        newProviderName = String(newProviderName).trim();
      }
    } else {
      newProviderName = await input({
        message: '请输入 Provider 名称',
        validate: (v) => (v && String(v).trim() ? true : '不能为空'),
      });
      newProviderName = String(newProviderName).trim();
    }

    const apiUrl = await input({
      message: '请输入 API URL',
      default: credentials[newProviderName]?.apiUrl || 'https://api.anthropic.com',
      validate: (v) => (v && String(v).trim() ? true : '不能为空'),
    });

    const apiKey = await input({
      message: '请输入 API Key',
      default: credentials[newProviderName]?.apiKey || undefined,
      validate: (v) => (v && String(v).trim() ? true : '不能为空'),
    });

    const modelsInput = await input({
      message: '请输入 Models（逗号分隔）',
      default: credentials[newProviderName]?.models?.join(', ') || undefined,
    });
    const models = modelsInput
      ? modelsInput.split(',').map((m) => m.trim()).filter(Boolean)
      : [];

    // 确认保存
    const ok = await confirm({
      message: `将保存到 ${credPath}：\n  Provider: ${newProviderName}\n  API URL: ${apiUrl}\n  API Key: （已隐藏）\n  Models: ${models.length > 0 ? models.join(', ') : '（无）'}\n确认？`,
      default: true,
    });
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
    const ok = await confirm({
      message: '将清空 ~/.claude/settings.json 中的 env 配置（ANTHROPIC_AUTH_TOKEN、ANTHROPIC_BASE_URL、ANTHROPIC_MODEL 等）\n确认？',
      default: true,
    });
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
    model = await select({
      message: `选择 Model（${provider}）`,
      choices: modelsOrdered.map((m) => ({
        name: currentModel && m === currentModel ? `${m} （当前选择）` : m,
        value: m,
      })),
    });
  } else {
    const hint =
      currentModel && (!cfg.models || cfg.models.length === 0)
        ? `（回车沿用当前：${currentModel}）`
        : '';
    model = await input({
      message: `该 provider 未配置 models，请输入 model 名称${hint}`,
      default: currentModel || undefined,
      validate: (v) => (v && String(v).trim() ? true : '不能为空'),
    });
    model = String(model).trim();
  }

  // 处理 apply-envs 命令：直接输出 export 语句
  if (args.command === 'apply-envs') {
    const exports = [];
    if (cfg.env) {
      // env provider：输出所有 env 变量
      for (const [k, v] of Object.entries(cfg.env)) {
        exports.push(`export ${k}="${escapeShellValue(v)}"`);
      }
      exports.push(`export ANTHROPIC_MODEL="${escapeShellValue(model)}"`);
    } else {
      // 标准 provider
      exports.push(`export ANTHROPIC_AUTH_TOKEN="${escapeShellValue(cfg.apiKey)}"`);
      exports.push(`export ANTHROPIC_BASE_URL="${escapeShellValue(cfg.apiUrl)}"`);
      exports.push(`export ANTHROPIC_MODEL="${escapeShellValue(model)}"`);
    }
    console.log(exports.join('\n'));
    process.exit(0);
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

  const ok = await confirm({ message: preview, default: true });
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

/** 转义 shell 变量值中的特殊字符 */
function escapeShellValue(value) {
  if (!value) return '';
  return value.replace(/["\\$`]/g, '\\$&');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
