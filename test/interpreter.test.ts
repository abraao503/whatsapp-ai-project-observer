import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ObserverContext } from '../src/modules/interpreter.js';

test('Codex interpretation attaches sampled video frames to the initial prompt', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'observer-interpreter-test-'));
  const cli = path.join(directory, 'codex');
  const argsPath = path.join(directory, 'args.json');
  const promptPath = path.join(directory, 'prompt.txt');
  const imageOne = path.join(directory, 'frame-1.jpg');
  const imageTwo = path.join(directory, 'frame-2.jpg');
  await writeFile(imageOne, 'frame one');
  await writeFile(imageTwo, 'frame two');
  await writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in'); process.exit(0); }
if (args[0] !== 'exec') process.exit(2);
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(promptPath)}, prompt);
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ conversationSummary: 'O cliente mostrou o fluxo.', actions: [] }));
  for (const image of args.filter((value, index) => args[index - 1] === '--image')) {
    if (!fs.existsSync(image)) throw new Error('Imagem ausente: ' + image);
  }
  console.log('model: ' + args[args.indexOf('--model') + 1]);
});
`);
  await chmod(cli, 0o700);
  const envNames = ['CODEX_CLI', 'CODEX_MODEL', 'CODEX_HOME'];
  const original = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { CODEX_CLI: cli, CODEX_MODEL: 'gpt-6-luna', CODEX_HOME: directory });

  try {
    const { interpret, validateCodexAccess } = await import('../src/modules/interpreter.js');
    const status = await validateCodexAccess();
    assert.equal(status.state, 'available');
    const context: ObserverContext = {
      conversation: { provider: 'waha', instance: 'observer', remoteJid: 'chat@c.us', summary: '', decisions: [] },
      recentMessages: [],
      projects: [],
      batchMessages: [{ id: '17', sentAt: new Date().toISOString(), sender: 'Cliente', fromMe: false, kind: 'video', text: 'Vídeo enviado.' }],
      videoFrames: [
        { messageId: '17', frameNumber: 1, timestampSeconds: 1.5, durationSeconds: 6 },
        { messageId: '17', frameNumber: 2, timestampSeconds: 4.5, durationSeconds: 6 }
      ]
    };
    const result = await interpret(context, [imageOne, imageTwo]);
    assert.equal(result.actions.length, 0);
    const args = JSON.parse(await readFile(argsPath, 'utf8')) as string[];
    const images = args.flatMap((value, index) => value === '--image' ? [args[index + 1]!] : []);
    assert.deepEqual(images, [imageOne, imageTwo]);
    const prompt = await readFile(promptPath, 'utf8');
    assert.match(prompt, /"timestampSeconds":1\.5/);
    assert.match(prompt, /mesma ordem/);
    assert.ok(args.includes('--sandbox') && args[args.indexOf('--sandbox') + 1] === 'read-only');
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
