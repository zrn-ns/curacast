import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { parseFile } from 'music-metadata';

// ffmpegのパスを設定
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);
}

// PCMデータをWAV形式に変換
export function pcmToWav(pcmBuffer: Buffer, sampleRate = 24000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = Buffer.alloc(totalSize);

  // RIFFヘッダー
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(totalSize - 8, 4);
  buffer.write('WAVE', 8);

  // fmtチャンク
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmtチャンクサイズ
  buffer.writeUInt16LE(1, 20); // オーディオフォーマット（PCM）
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // dataチャンク
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, 44);

  return buffer;
}

// WAVファイルをMP3に変換
export async function convertWavToMp3(wavPath: string, mp3Path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(wavPath)
      .audioCodec('libmp3lame')
      .audioBitrate('192k')
      .toFormat('mp3')
      .on('end', () => {
        resolve();
      })
      .on('error', (err) => {
        reject(err);
      })
      .save(mp3Path);
  });
}

// WAVバッファをMP3バッファに変換
export async function convertWavBufferToMp3(wavBuffer: Buffer, tempDir: string): Promise<Buffer> {
  const tempWavPath = path.join(tempDir, `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  const tempMp3Path = path.join(tempDir, `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);

  try {
    // ディレクトリが存在しない場合は作成
    await fs.mkdir(tempDir, { recursive: true });

    // 一時WAVファイルを書き込み
    await fs.writeFile(tempWavPath, wavBuffer);

    // WAVをMP3に変換
    await convertWavToMp3(tempWavPath, tempMp3Path);

    // MP3ファイルを読み込み
    const mp3Buffer = await fs.readFile(tempMp3Path);

    return mp3Buffer;
  } finally {
    // 一時ファイルを削除
    try {
      await fs.unlink(tempWavPath);
    } catch {
      // 削除エラーは無視
    }
    try {
      await fs.unlink(tempMp3Path);
    } catch {
      // 削除エラーは無視
    }
  }
}

// 音声ファイルの再生時間を取得
export async function getAudioDuration(filePath: string): Promise<number> {
  const metadata = await parseFile(filePath);
  return Math.round(metadata.format.duration ?? 0);
}

// 再生時間を MM:SS 形式の文字列に変換
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// 複数の音声バッファを結合（単純連結、メタデータは更新されない）
export function concatAudioBuffers(buffers: Buffer[]): Buffer {
  return Buffer.concat(buffers);
}

// MP3ファイルにアートワークを埋め込む
export async function embedArtwork(
  mp3Path: string,
  artworkPath: string,
  outputPath: string,
  metadata?: { title?: string; artist?: string; album?: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    let command = ffmpeg()
      .input(mp3Path)
      .input(artworkPath)
      .outputOptions([
        '-map', '0:a',
        '-map', '1:v',
        '-c:a', 'copy',
        '-c:v', 'png',
        '-id3v2_version', '3',
        '-metadata:s:v', 'title=Album cover',
        '-metadata:s:v', 'comment=Cover (front)',
      ]);

    // メタデータを追加
    if (metadata?.title) {
      command = command.outputOptions(['-metadata', `title=${metadata.title}`]);
    }
    if (metadata?.artist) {
      command = command.outputOptions(['-metadata', `artist=${metadata.artist}`]);
    }
    if (metadata?.album) {
      command = command.outputOptions(['-metadata', `album=${metadata.album}`]);
    }

    command
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

// 複数のMP3バッファをffmpegで正しく結合
export async function concatMp3Buffers(buffers: Buffer[], tempDir: string): Promise<Buffer> {
  if (buffers.length === 0) {
    return Buffer.alloc(0);
  }
  if (buffers.length === 1 && buffers[0]) {
    return buffers[0];
  }

  const timestamp = Date.now();
  const tempFiles: string[] = [];

  // 絶対パスに変換（ffmpegが正しくファイルを参照できるようにする）
  const absoluteTempDir = path.resolve(tempDir);

  try {
    // ディレクトリが存在しない場合は作成
    await fs.mkdir(absoluteTempDir, { recursive: true });

    // 各バッファを一時ファイルとして保存
    for (let i = 0; i < buffers.length; i++) {
      const buffer = buffers[i];
      if (!buffer) continue;
      const tempPath = path.join(absoluteTempDir, `chunk_${timestamp}_${i}.mp3`);
      await fs.writeFile(tempPath, buffer);
      tempFiles.push(tempPath);
    }

    // 連結リストファイルを作成（絶対パスを使用）
    const listPath = path.join(absoluteTempDir, `concat_${timestamp}.txt`);
    const listContent = tempFiles.map((f) => `file '${f}'`).join('\n');
    await fs.writeFile(listPath, listContent);

    // 出力ファイルパス
    const outputPath = path.join(absoluteTempDir, `output_${timestamp}.mp3`);

    // ffmpegで結合
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .audioCodec('copy')
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .save(outputPath);
    });

    // 結合したファイルを読み込み
    const result = await fs.readFile(outputPath);

    // 出力ファイルも削除対象に追加
    tempFiles.push(listPath, outputPath);

    return result;
  } finally {
    // 一時ファイルを削除
    for (const tempFile of tempFiles) {
      try {
        await fs.unlink(tempFile);
      } catch {
        // 削除エラーは無視
      }
    }
  }
}
