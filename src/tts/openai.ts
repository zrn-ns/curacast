import OpenAI from 'openai';
import type { TTSProvider } from './index.js';
import { getLogger } from '../utils/logger.js';

export interface OpenAITTSConfig {
  apiKey: string;
  model: string;
  voices: string[];
}

type OpenAIVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

export class OpenAITTS implements TTSProvider {
  name = 'openai';
  availableVoices: string[];

  private client: OpenAI;
  private model: string;
  private logger = getLogger();

  constructor(config: OpenAITTSConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model;
    this.availableVoices = config.voices;
  }

  async generateAudio(text: string, voice?: string): Promise<Buffer> {
    const selectedVoice = (voice ?? this.getRandomVoice()) as OpenAIVoice;
    this.logger.debug({ voice: selectedVoice, textLength: text.length }, 'OpenAI TTS生成開始');

    const response = await this.client.audio.speech.create({
      model: this.model,
      voice: selectedVoice,
      input: text,
    });

    const arrayBuffer = await response.arrayBuffer();
    const mp3Buffer = Buffer.from(arrayBuffer);

    this.logger.debug({ voice: selectedVoice, mp3Size: mp3Buffer.length }, 'OpenAI TTS生成完了');

    return mp3Buffer;
  }

  private getRandomVoice(): string {
    const randomIndex = Math.floor(Math.random() * this.availableVoices.length);
    return this.availableVoices[randomIndex] ?? 'nova';
  }
}
