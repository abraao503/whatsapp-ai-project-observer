import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('video preparation bounds frames, transcribes extracted audio locally, and cleans temporary files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'observer-video-test-'));
  const modelPath = path.join(directory, 'whisper-model.bin');
  const ffmpeg = path.join(directory, 'ffmpeg');
  const ffprobe = path.join(directory, 'ffprobe');
  const whisper = path.join(directory, 'whisper-cli');
  const ffmpegArgsPath = path.join(directory, 'ffmpeg-args.jsonl');
  const whisperArgsPath = path.join(directory, 'whisper-args.json');
  await writeFile(modelPath, 'fixture model');
  await writeFile(ffprobe, `#!/usr/bin/env node
const file = process.argv.at(-1);
const duration = file.endsWith('.mov') ? 181 : 6;
console.log(JSON.stringify({ format: { duration: String(duration) }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }));
`);
  await writeFile(ffmpeg, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ffmpegArgsPath)}, JSON.stringify(args) + '\\n');
fs.writeFileSync(args.at(-1), args.at(-1).endsWith('.jpg') ? 'fixture jpeg' : 'fixture wav');
`);
  await writeFile(whisper, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(whisperArgsPath)}, JSON.stringify(args));
fs.writeFileSync(args[args.indexOf('--output-file') + 1] + '.txt', 'A pessoa toca no botão exportar.');
`);
  for (const executable of [ffmpeg, ffprobe, whisper]) await chmod(executable, 0o700);

  const envNames = ['FFMPEG_CLI', 'FFPROBE_CLI', 'WHISPER_CPP_CLI', 'WHISPER_MODEL_PATH', 'WHISPER_LANGUAGE', 'WHISPER_THREADS', 'MAX_VIDEO_BYTES'];
  const original = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    FFMPEG_CLI: ffmpeg,
    FFPROBE_CLI: ffprobe,
    WHISPER_CPP_CLI: whisper,
    WHISPER_MODEL_PATH: modelPath,
    WHISPER_LANGUAGE: 'pt',
    WHISPER_THREADS: '1',
    MAX_VIDEO_BYTES: '64'
  });

  try {
    const { allocateVideoFrameCounts, prepareVideo, videoFrameTimestamps } = await import('../src/modules/video.js');
    assert.deepEqual(videoFrameTimestamps(6, 2), [1.5, 4.5]);
    assert.deepEqual(allocateVideoFrameCounts(4, 6, 2), [0, 1, 0, 1]);
    assert.deepEqual(allocateVideoFrameCounts(2, 2, 3), [2, 1]);

    const prepared = await prepareVideo(Buffer.from('video fixture'), 'video/mp4', { frameCount: 2, transcribe: true });
    assert.equal(prepared.durationSeconds, 6);
    assert.equal(prepared.transcript, 'A pessoa toca no botão exportar.');
    assert.deepEqual(prepared.frames.map((frame) => frame.timestampSeconds), [1.5, 4.5]);
    assert.equal((await stat(prepared.frames[0]!.path)).size, Buffer.byteLength('fixture jpeg'));
    const ffmpegCalls = (await readFile(ffmpegArgsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    assert.equal(ffmpegCalls.length, 3, 'extrai o áudio uma vez e gera apenas os dois quadros configurados');
    assert.ok(ffmpegCalls[0]?.includes('-map'));
    assert.deepEqual(ffmpegCalls.slice(1).map((args) => args[args.indexOf('-ss') + 1]), ['1.5', '4.5']);
    const whisperArgs = JSON.parse(await readFile(whisperArgsPath, 'utf8')) as string[];
    assert.equal(whisperArgs[whisperArgs.indexOf('--language') + 1], 'pt');
    assert.equal(whisperArgs[whisperArgs.indexOf('--model') + 1], modelPath);
    const framePath = prepared.frames[0]!.path;
    await prepared.cleanup();
    await assert.rejects(stat(framePath), { code: 'ENOENT' });

    await assert.rejects(
      prepareVideo(Buffer.alloc(65), 'video/mp4', { frameCount: 0, transcribe: false }),
      /MAX_VIDEO_BYTES/
    );
    await assert.rejects(
      prepareVideo(Buffer.from('video fixture'), 'video/quicktime', { frameCount: 0, transcribe: false }),
      /VIDEO_MAX_DURATION_SECONDS/
    );
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
