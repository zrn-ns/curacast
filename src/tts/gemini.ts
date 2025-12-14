import { GoogleGenAI } from '@google/genai';
import type { TTSProvider } from './index.js';
import { pcmToWav, convertWavBufferToMp3 } from '../utils/audio.js';
import { getLogger } from '../utils/logger.js';
import os from 'os';

export interface GeminiTTSConfig {
  apiKey: string;
  model: string;
  voices: string[];
  speakerPrompt?: string;
}

export class GeminiTTS implements TTSProvider {
  name = 'gemini';
  availableVoices: string[];

  private client: GoogleGenAI;
  private model: string;
  private speakerPrompt?: string;
  private logger = getLogger();

  constructor(config: GeminiTTSConfig) {
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
    this.model = config.model;
    this.availableVoices = config.voices;
    this.speakerPrompt = config.speakerPrompt;
  }

  async generateAudio(text: string, voice?: string): Promise<Buffer> {
    const selectedVoice = voice ?? this.getRandomVoice();
    this.logger.debug({ voice: selectedVoice, textLength: text.length }, 'Gemini TTS生成開始');

    // speakerPromptがある場合、テキストの前に付与して話し方のトーンを指示する
    const promptedText = this.speakerPrompt
      ? `${this.speakerPrompt}\n\n${text}`
      : text;

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [{ parts: [{ text: promptedText }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: selectedVoice },
          },
        },
      },
    });

    // レスポンスから音声データを取得
    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts?.[0]) {
      throw new Error('Gemini TTSからの応答が不正です');
    }

    const part = candidate.content.parts[0];
    if (!('inlineData' in part) || !part.inlineData?.data) {
      throw new Error('Gemini TTSから音声データが取得できませんでした');
    }

    const audioData = part.inlineData.data;
    const pcmBuffer = Buffer.from(audioData, 'base64');

    // PCMをWAVに変換
    const wavBuffer = pcmToWav(pcmBuffer);

    // WAVをMP3に変換
    const tempDir = os.tmpdir();
    const mp3Buffer = await convertWavBufferToMp3(wavBuffer, tempDir);

    this.logger.debug({ voice: selectedVoice, mp3Size: mp3Buffer.length }, 'Gemini TTS生成完了');

    return mp3Buffer;
  }

  private getRandomVoice(): string {
    const randomIndex = Math.floor(Math.random() * this.availableVoices.length);
    return this.availableVoices[randomIndex] ?? 'Laomedeia';
  }
}
