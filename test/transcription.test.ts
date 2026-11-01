import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('transcribes locally with whisper.cpp in Portuguese without calling an API', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'observer-transcription-test-'));
  const modelPath = path.join(directory, 'ggml-small-q5_1.bin');
  const ffmpeg = path.join(directory, 'ffmpeg');
  const whisper = path.join(directory, 'whisper-cli');
  const argsPath = path.join(directory, 'whisper-args.txt');
  await writeFile(modelPath, 'fixture-model');
  await writeFile(ffmpeg, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1];
const output = args.at(-1);
if (input === output) {
  console.error('Output is the same as input');
  process.exit(234);
}
fs.writeFileSync(output, 'fixture wav');
`);
  await writeFile(whisper, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsPath)}, args.join('\\n'));
const output = args[args.indexOf('--output-file') + 1];
fs.writeFileSync(output + '.txt', 'Precisamos permitir exportar o relatório em CSV.');
console.log('model: gpt-6-luna');
`);
  await chmod(ffmpeg, 0o700);
  await chmod(whisper, 0o700);

  const original = {
    ffmpeg: process.env.FFMPEG_CLI,
    whisper: process.env.WHISPER_CPP_CLI,
    model: process.env.WHISPER_MODEL_PATH,
    language: process.env.WHISPER_LANGUAGE,
    threads: process.env.WHISPER_THREADS
  };
  process.env.FFMPEG_CLI = ffmpeg;
  process.env.WHISPER_CPP_CLI = whisper;
  process.env.WHISPER_MODEL_PATH = modelPath;
  process.env.WHISPER_LANGUAGE = 'pt';
  process.env.WHISPER_THREADS = '1';

  try {
    const { transcribeAudio } = await import('../src/modules/transcription.js');
    const transcript = await transcribeAudio(Buffer.from('fixture audio'), 'audio/ogg; codecs=opus');
    assert.equal(transcript, 'Precisamos permitir exportar o relatório em CSV.');
    const wavTranscript = await transcribeAudio(Buffer.from('fixture audio'), 'audio/wav');
    assert.equal(wavTranscript, 'Precisamos permitir exportar o relatório em CSV.');
    const args = (await readFile(argsPath, 'utf8')).split('\n');
    assert.ok(args.includes('--language'));
    assert.equal(args[args.indexOf('--language') + 1], 'pt');
    assert.equal(args[args.indexOf('--threads') + 1], '1');
    assert.equal(args[args.indexOf('--model') + 1], modelPath);
    assert.ok(args.includes('--no-timestamps'));
  } finally {
    for (const [name, value] of Object.entries({
      FFMPEG_CLI: original.ffmpeg,
      WHISPER_CPP_CLI: original.whisper,
      WHISPER_MODEL_PATH: original.model,
      WHISPER_LANGUAGE: original.language,
      WHISPER_THREADS: original.threads
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
