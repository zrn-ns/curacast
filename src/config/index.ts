import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { configSchema, profileSchema, type Config, type UserProfile } from './schema.js';

// 環境変数をオブジェクトにマッピング
function resolveEnvVariables(obj: unknown): unknown {
  if (typeof obj === 'string') {
    // ${ENV_VAR} 形式の環境変数を解決
    return obj.replace(/\$\{(\w+)\}/g, (_, envVar) => {
      return process.env[envVar] ?? '';
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVariables);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVariables(value);
    }
    return result;
  }
  return obj;
}

// 設定ファイルを読み込む
export function loadConfig(configPath?: string): Config {
  const defaultConfigPath = path.resolve(process.cwd(), 'config/default.yaml');
  const filePath = configPath ?? defaultConfigPath;

  let rawConfig: unknown = {};

  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    rawConfig = parseYaml(content);
  }

  // 環境変数を解決
  const resolvedConfig = resolveEnvVariables(rawConfig);

  // 環境変数からAPIキーを取得
  const config = resolvedConfig as Record<string, unknown>;
  if (!config.llm) {
    config.llm = {};
  }
  if (!config.tts) {
    config.tts = {};
  }

  const llmConfig = config.llm as Record<string, unknown>;
  const ttsConfig = config.tts as Record<string, unknown>;

  // LLM APIキーの設定
  if (!llmConfig.apiKey) {
    const provider = llmConfig.provider ?? 'gemini';
    if (provider === 'gemini') {
      llmConfig.apiKey = process.env.GEMINI_API_KEY;
    } else if (provider === 'openai') {
      llmConfig.apiKey = process.env.OPENAI_API_KEY;
    }
  }

  // TTS APIキーの設定（TTSはLLMと同じプロバイダを使うことが多い）
  if (!ttsConfig.apiKey) {
    const provider = ttsConfig.provider ?? 'gemini';
    if (provider === 'gemini') {
      ttsConfig.apiKey = process.env.GEMINI_API_KEY;
    } else if (provider === 'openai') {
      ttsConfig.apiKey = process.env.OPENAI_API_KEY;
    }
  }

  // 環境変数からのオーバーライド
  if (process.env.PORT) {
    if (!config.server) {
      config.server = {};
    }
    (config.server as Record<string, unknown>).port = parseInt(process.env.PORT, 10);
  }
  if (process.env.FEED_URL) {
    if (!config.server) {
      config.server = {};
    }
    (config.server as Record<string, unknown>).feedUrl = process.env.FEED_URL;
  }

  // バリデーションとデフォルト値の適用
  return configSchema.parse(config);
}

// ユーザープロファイルを読み込む
export function loadProfile(profilePath?: string): UserProfile {
  const defaultProfilePath = path.resolve(process.cwd(), 'data/profile.yaml');
  const filePath = profilePath ?? defaultProfilePath;

  let rawProfile: unknown = {};

  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    rawProfile = parseYaml(content);
  }

  // バリデーションとデフォルト値の適用
  return profileSchema.parse(rawProfile);
}

// 設定をYAML形式で保存
export function saveConfig(config: Config, configPath: string): void {
  const { stringify } = require('yaml');
  const content = stringify(config);
  fs.writeFileSync(configPath, content, 'utf-8');
}

// プロファイルをYAML形式で保存
export function saveProfile(profile: UserProfile, profilePath: string): void {
  const { stringify } = require('yaml');
  const content = stringify(profile);
  fs.writeFileSync(profilePath, content, 'utf-8');
}

export { type Config, type UserProfile } from './schema.js';
