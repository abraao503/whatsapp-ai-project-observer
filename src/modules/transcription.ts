import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { runCaptured } from './codex.js';

export interface TranscriptionStatus {
  engine: 'openai';
  state: 'configured' | 'not_configured';
  model: string;
  language: string;
  detail: string;
}

export function transcriptionStatus(): TranscriptionStatus {
  const configured = Boolean(config.openaiApiKey);
  return {
    engine: 'openai',
    state: configured ? 'configured' : 'not_configured',
    model: config.openaiTranscriptionModel,
    language: 'pt',
    detail: configured
      ? `Transcrição via OpenAI configurada: ${config.openaiTranscriptionModel} (português).`
      : 'Configure OPENAI_API_KEY no painel para transcrever áudios e vídeos.'
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
    'application/ogg': '.ogg',
    'audio/opus': '.opus',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/amr': '.amr',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/webm': '.webm',
    'audio/flac': '.flac'
  };
  return extensions[mime] ?? '.audio';
}

const openAiAudioExtensions = new Set(['.ogg', '.mp3', '.m4a', '.wav', '.webm', '.mp4', '.mpeg', '.mpga', '.flac']);

function apiErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') return parsed.error.message.slice(0, 400);
  } catch {
    // Fall through to a short response excerpt.
  }
  return body.trim().slice(0, 400) || 'resposta vazia';
}

async function transcribeWithOpenAI(bytes: Buffer, mimeType: string, allowEmpty: boolean): Promise<string> {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY ausente; configure a chave de transcrição no painel');
  if (!bytes.length) throw new Error('O arquivo de áudio recebido está vazio');
  if (bytes.length > config.maxAudioBytes) throw new Error('O áudio excede MAX_AUDIO_BYTES');

  let uploadBytes = bytes;
  let extension = audioExtension(mimeType);
  let temporaryDirectory: string | undefined;
  try {
    if (!openAiAudioExtensions.has(extension)) {
      temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'whatsapp-observer-audio-'));
      const inputPath = path.join(temporaryDirectory, `input${extension}`);
      const wavPath = path.join(temporaryDirectory, 'normalized.wav');
      await writeFile(inputPath, bytes, { mode: 0o600 });
      await runCaptured(config.ffmpegCli, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath
      ], {
        cwd: temporaryDirectory,
        timeoutMs: 30_000,
        outputLimit: 20_000,
        env: safeSubprocessEnvironment()
      });
      uploadBytes = await readFile(wavPath);
      extension = '.wav';
      if (uploadBytes.length > config.maxAudioBytes) {
        throw new Error('O áudio convertido excede MAX_AUDIO_BYTES');
      }
    }

    const form = new FormData();
    form.set('file', new Blob([Uint8Array.from(uploadBytes)], { type: extension === '.wav' ? 'audio/wav' : mimeType }), `audio${extension}`);
    form.set('model', config.openaiTranscriptionModel);
    form.append('languages[]', 'pt');
    form.set('response_format', 'json');

    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.openaiApiKey}` },
        body: form,
        signal: AbortSignal.timeout(config.openaiTranscriptionTimeoutMs)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro de rede';
      throw new Error(`Falha ao chamar a API de transcrição da OpenAI: ${message.slice(0, 300)}`);
    }

    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI transcrição HTTP ${response.status}: ${apiErrorMessage(responseBody)}`);
    }
    let result: { text?: unknown };
    try {
      result = JSON.parse(responseBody) as { text?: unknown };
    } catch {
      throw new Error('OpenAI retornou uma resposta de transcrição inválida');
    }
    if (typeof result.text !== 'string') throw new Error('OpenAI não retornou o campo de transcrição');
    const transcript = result.text.trim();
    if (!transcript && !allowEmpty) throw new Error('OpenAI retornou uma transcrição vazia');
    return transcript;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function transcribeAudio(bytes: Buffer, mimeType: string): Promise<string> {
  return transcribeWithOpenAI(bytes, mimeType, false);
}

export async function transcribeWavFile(wavPath: string, allowEmpty = false): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(wavPath);
  } catch {
    throw new Error('O arquivo WAV temporário não foi encontrado');
  }
  return transcribeWithOpenAI(bytes, 'audio/wav', allowEmpty);
}
