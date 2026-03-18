#!/usr/bin/env node
/**
 * 读取 credentials.json，交互选择 provider / model，更新 ~/.claude/settings.json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { select, input, confirm } from '@inquirer/prompts';

function parseArgs(argv) {
  const args = { file: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f' || a === '--file') {
      args.file = argv[++i];
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
用法: cc-use-model [选项]

  -f, --file <path>   credentials.json 路径（默认: 当前目录 credentials.json）
  -h, --help          显示帮助

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
  const providers = Object.entries(data).filter(
    ([, v]) => v && typeof v === 'object' && typeof v.apiUrl === 'string' && typeof v.apiKey === 'string'
  );
  if (providers.length === 0) {
    throw new Error('未找到有效 provider：每项需包含 apiUrl、apiKey（字符串）');
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

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const credPath = path.resolve(
    args.file || path.join(process.cwd(), 'credentials.json')
  );
  if (!fs.existsSync(credPath)) {
    console.error(`未找到凭据文件: ${credPath}`);
    console.error('请复制 credentials.json.example 为 credentials.json 并填写，或使用 -f 指定路径。');
    process.exit(1);
  }

  let credentials;
  try {
    credentials = loadCredentials(credPath);
  } catch (e) {
    console.error('读取 credentials.json 失败:', e.message);
    process.exit(1);
  }

  const providerKeys = Object.keys(credentials);
  const provider = await select({
    message: '选择 Provider',
    choices: providerKeys.map((name) => ({ name, value: name })),
  });

  const cfg = credentials[provider];
  let model;

  if (Array.isArray(cfg.models) && cfg.models.length > 0) {
    model = await select({
      message: `选择 Model（${provider}）`,
      choices: cfg.models.map((m) => ({ name: String(m), value: String(m) })),
    });
  } else {
    model = await input({
      message: '该 provider 未配置 models，请输入 model 名称',
      validate: (v) => (v && v.trim() ? true : '不能为空'),
    });
    model = model.trim();
  }

  const ok = await confirm({
    message: `将写入 ~/.claude/settings.json：\n  ANTHROPIC_BASE_URL: ${cfg.apiUrl}\n  ANTHROPIC_MODEL: ${model}\n  ANTHROPIC_AUTH_TOKEN: （已隐藏）\n确认？`,
    default: true,
  });
  if (!ok) {
    console.log('已取消。');
    process.exit(0);
  }

  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const settings = loadOrInitSettings(settingsPath);
  settings.env = {
    ...(settings.env && typeof settings.env === 'object' ? settings.env : {}),
    ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
    ANTHROPIC_BASE_URL: cfg.apiUrl,
    ANTHROPIC_MODEL: model,
  };

  settings.model = model;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log(`已更新: ${settingsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
