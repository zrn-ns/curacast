import type { Config } from '../config/index.js';
import { GeminiTTS } from './gemini.js';
import { OpenAITTS } from './openai.js';

// TTSプロバイダーインターフェース
export interface TTSProvider {
  name: string;
  generateAudio(text: string, voice?: string): Promise<Buffer>;
  availableVoices: string[];
}

// TTS設定
export interface TTSConfig {
  provider: 'gemini' | 'openai';
  model: string;
  voices: string[];
  chunkSize: number;
  concurrency: number;
  apiKey?: string;
  speakerPrompt?: string;
}

// TTSプロバイダーを作成
export function createTTSProvider(config: TTSConfig): TTSProvider {
  if (config.provider === 'gemini') {
    return new GeminiTTS({
      apiKey: config.apiKey ?? process.env.GEMINI_API_KEY ?? '',
      model: config.model,
      voices: config.voices,
      speakerPrompt: config.speakerPrompt,
    });
  } else if (config.provider === 'openai') {
    return new OpenAITTS({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY ?? '',
      model: config.model,
      voices: config.voices,
    });
  }

  throw new Error(`Unknown TTS provider: ${config.provider}`);
}

// 設定からTTSプロバイダーを作成
export function createTTSProviderFromConfig(config: Config): TTSProvider {
  return createTTSProvider({
    provider: config.tts.provider,
    model: config.tts.model,
    voices: config.tts.voices,
    chunkSize: config.tts.chunkSize,
    concurrency: config.tts.concurrency,
    speakerPrompt: config.tts.speakerPrompt,
  });
}

export { GeminiTTS } from './gemini.js';
export { OpenAITTS } from './openai.js';
