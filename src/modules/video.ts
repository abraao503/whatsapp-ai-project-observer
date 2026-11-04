import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { runCaptured } from './codex.js';
import { transcribeWavFile } from './transcription.js';

export interface VideoFrame {
  path: string;
  timestampSeconds: number;
}

export interface PreparedVideo {
  durationSeconds: number;
  transcript: string | null;
  frames: VideoFrame[];
  cleanup(): Promise<void>;
}

function safeSubprocessEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'];
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
}

function videoExtension(mimeType: string): string {
  const mime = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  const extensions: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/3gpp': '.3gp',
    'video/x-matroska': '.mkv'
  };
  return extensions[mime] ?? '.video';
}

export function videoFrameTimestamps(durationSeconds: number, frameCount: number): number[] {
  const count = Math.max(0, Math.min(frameCount, config.videoMaxFramesPerMessage));
  return Array.from({ length: count }, (_, index) => {
    const timestamp = (durationSeconds * (index + 0.5)) / count;
    return Math.round(Math.min(timestamp, Math.max(0, durationSeconds - 0.1)) * 100) / 100;
  });
}

export function allocateVideoFrameCounts(
  videoCount: number,
  maxPerMessage = config.videoMaxFramesPerMessage,
  batchLimit = config.videoMaxFramesPerBatch
): number[] {
  const counts = Array.from({ length: Math.max(0, videoCount) }, () => 0);
  const budget = Math.max(0, Math.min(batchLimit, videoCount * maxPerMessage));
  if (!budget || !videoCount || !maxPerMessage) return counts;

  const firstRound = Math.min(videoCount, budget);
  for (let index = 0; index < firstRound; index += 1) {
    const selected = Math.floor(((index + 0.5) * videoCount) / firstRound);
    counts[selected] = 1;
  }
  let remaining = budget - counts.reduce((total, count) => total + count, 0);
  while (remaining > 0) {
    let added = false;
    for (let index = 0; index < counts.length && remaining > 0; index += 1) {
      if (counts[index]! < maxPerMessage) {
        counts[index]! += 1;
        remaining -= 1;
        added = true;
      }
    }
    if (!added) break;
  }
  return counts;
}

export async function prepareVideo(
  bytes: Buffer,
  mimeType: string,
  options: { frameCount: number; transcribe: boolean }
): Promise<PreparedVideo> {
  if (!bytes.length) throw new Error('O arquivo de vídeo recebido está vazio');
  if (bytes.length > config.maxVideoBytes) throw new Error('O vídeo excede MAX_VIDEO_BYTES');
  if (options.frameCount > config.videoMaxFramesPerMessage) {
    throw new Error('A quantidade de quadros excede VIDEO_MAX_FRAMES_PER_MESSAGE');
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'whatsapp-observer-video-'));
  const inputPath = path.join(directory, `input${videoExtension(mimeType)}`);
  const env = safeSubprocessEnvironment();
  try {
    await writeFile(inputPath, bytes, { mode: 0o600 });
    const { stdout } = await runCaptured(config.ffprobeCli, [
      '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', inputPath
    ], {
      cwd: directory,
      timeoutMs: 30_000,
      outputLimit: 50_000,
      env
    });
    let metadata: { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
    try {
      metadata = JSON.parse(stdout) as typeof metadata;
    } catch {
      throw new Error('ffprobe retornou metadados de vídeo inválidos');
    }
    const durationSeconds = Number(metadata.format?.duration);
    const streamTypes = (metadata.streams ?? []).map((stream) => stream.codec_type);
    if (!streamTypes.includes('video')) throw new Error('O anexo não contém uma faixa de vídeo reconhecida');
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('A duração do vídeo é inválida');
    if (durationSeconds > config.videoMaxDurationSeconds) {
      throw new Error(`O vídeo excede VIDEO_MAX_DURATION_SECONDS (${config.videoMaxDurationSeconds})`);
    }

    let transcript: string | null = null;
    if (options.transcribe && streamTypes.includes('audio')) {
      const wavPath = path.join(directory, 'video-audio.wav');
      await runCaptured(config.ffmpegCli, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
        '-map', '0:a:0', '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath
      ], {
        cwd: directory,
        timeoutMs: config.videoProcessingTimeoutMs,
        outputLimit: 20_000,
        env
      });
      transcript = await transcribeWavFile(wavPath, true);
    }

    const frames: VideoFrame[] = [];
    for (const [index, timestampSeconds] of videoFrameTimestamps(durationSeconds, options.frameCount).entries()) {
      const framePath = path.join(directory, `frame-${index + 1}.jpg`);
      await runCaptured(config.ffmpegCli, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(timestampSeconds),
        '-i', inputPath, '-frames:v', '1', '-an',
        '-vf', "scale='min(960,iw)':-2:force_original_aspect_ratio=decrease",
        '-q:v', '5', framePath
      ], {
        cwd: directory,
        timeoutMs: config.videoProcessingTimeoutMs,
        outputLimit: 20_000,
        env
      });
      const frameBytes = await stat(framePath);
      if (frameBytes.size === 0 || frameBytes.size > 2_000_000) {
        throw new Error('ffmpeg gerou um quadro vazio ou maior que o limite de 2 MB');
      }
      await chmod(framePath, 0o600);
      frames.push({ path: framePath, timestampSeconds });
    }

    return {
      durationSeconds,
      transcript,
      frames,
      cleanup: () => rm(directory, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
