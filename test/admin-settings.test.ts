import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveLinearApiKey } from '../src/modules/admin-settings.js';

test('Linear key update atomically replaces duplicates, preserves other .env settings, and never loosens file mode', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'observer-admin-settings-'));
  const envPath = path.join(directory, '.env');
  try {
    await writeFile(envPath, 'DATABASE_URL=postgres://local\nLINEAR_API_KEY=old-key-1234567890\nOTHER_SETTING=keep\nLINEAR_API_KEY=duplicate-key-1234567890\n', { mode: 0o644 });
    await saveLinearApiKey('lin_api_test-key_1234567890', envPath);
    const content = await readFile(envPath, 'utf8');
    assert.equal((content.match(/^LINEAR_API_KEY=/gm) ?? []).length, 1);
    assert.match(content, /LINEAR_API_KEY=lin_api_test-key_1234567890/);
    assert.match(content, /DATABASE_URL=postgres:\/\/local/);
    assert.match(content, /OTHER_SETTING=keep/);
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Linear key update rejects newlines and can clear the configured key', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'observer-admin-settings-'));
  const envPath = path.join(directory, '.env');
  try {
    await writeFile(envPath, 'LINEAR_API_KEY=lin_api_test-key_1234567890\n', { mode: 0o600 });
    await assert.rejects(() => saveLinearApiKey('invalid-key\nADMIN_PASSWORD=changed', envPath), /16 a 512 caracteres/);
    await saveLinearApiKey('', envPath);
    assert.match(await readFile(envPath, 'utf8'), /^LINEAR_API_KEY=\n$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
