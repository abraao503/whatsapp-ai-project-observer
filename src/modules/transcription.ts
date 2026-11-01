import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { runCaptured } from './codex.js';

export interface TranscriptionStatus {
  engine: 'whisper.cpp';
  state: 'configured' | 'not_configured';
  model: string;
  language: string;
  detail: string;
}

export function transcriptionStatus(): TranscriptionStatus {
  const configured = Boolean(config.whisperModelPath);
  return {
    engine: 'whisper.cpp',
    state: configured ? 'configured' : 'not_configured',
    model: config.whisperModelPath ? path.basename(config.whisperModelPath) : '(não configurado)',
    language: config.whisperLanguage,
    detail: configured
      ? `Transcrição local configurada: ${path.basename(config.whisperModelPath)} (${config.whisperLanguage}).`
      : 'Configure WHISPER_MODEL_PATH e instale whisper-cli, ffmpeg e ffprobe para analisar vídeos.'
  };
}

function safeSubprocessEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'];
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
}

function audioExtension(mimeType: string): string {
  const mime = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  const extensions: Record<string, string> = {
    'audio/ogg': '.ogg',
    'audio/opus': '.opus',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/amr': '.amr',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/webm': '.webm'
  };
  return extensions[mime] ?? '.audio';
}

export async function transcribeAudio(bytes: Buffer, mimeType: string): Promise<string> {
  if (!config.whisperModelPath) {
    throw new Error('Transcrição local não configurada: WHISPER_MODEL_PATH ausente');
  }
  if (!bytes.length) throw new Error('O arquivo de áudio recebido está vazio');
  if (bytes.length > config.maxAudioBytes) throw new Error('O áudio excede MAX_AUDIO_BYTES');

  try {
    await access(config.whisperModelPath);
  } catch {
    throw new Error('O modelo local não foi encontrado em WHISPER_MODEL_PATH');
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'whatsapp-observer-audio-'));
  const inputPath = path.join(directory, `input${audioExtension(mimeType)}`);
  const wavPath = path.join(directory, 'input.wav');
  const env = safeSubprocessEnvironment();

  try {
    await writeFile(inputPath, bytes, { mode: 0o600 });
    await runCaptured(config.ffmpegCli, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath
    ], {
      cwd: directory,
      timeoutMs: 30_000,
      outputLimit: 20_000,
      env
    });
    return await transcribeWavFile(wavPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function transcribeWavFile(wavPath: string, allowEmpty = false): Promise<string> {
  if (!config.whisperModelPath) {
    throw new Error('Transcrição local não configurada: WHISPER_MODEL_PATH ausente');
  }
  try {
    await access(config.whisperModelPath);
    await access(wavPath);
  } catch {
    throw new Error('O modelo Whisper ou o áudio WAV temporário não foi encontrado');
  }

  const outputPrefix = path.join(path.dirname(wavPath), `transcript-${path.basename(wavPath)}`);
  await runCaptured(config.whisperCppCli, [
    '--model', config.whisperModelPath,
    '--file', wavPath,
    '--language', config.whisperLanguage,
    '--threads', String(config.whisperThreads),
    '--no-timestamps',
    '--output-txt',
    '--output-file', outputPrefix
  ], {
    cwd: path.dirname(wavPath),
    timeoutMs: config.whisperTimeoutMs,
    outputLimit: 50_000,
    env: safeSubprocessEnvironment()
  });
  const transcript = (await readFile(`${outputPrefix}.txt`, 'utf8')).trim();
  if (!transcript && !allowEmpty) throw new Error('whisper.cpp retornou uma transcrição vazia');
  return transcript;
}
