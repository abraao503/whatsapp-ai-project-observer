import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const linearKeyPattern = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const openAiKeyPattern = /^[A-Za-z0-9._~+/=-]{16,512}$/;

async function saveApiKey(
  keyName: 'LINEAR_API_KEY' | 'OPENAI_API_KEY',
  apiKey: string,
  pattern: RegExp,
  envFilePath: string
): Promise<void> {
  const value = apiKey.trim();
  if (value && !pattern.test(value)) {
    throw new Error(`A chave de ${keyName} deve ter de 16 a 512 caracteres e não pode conter espaços ou quebras de linha`);
  }

  const fileInfo = await lstat(envFilePath);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('O arquivo .env não é um arquivo regular');
  const original = await readFile(envFilePath, 'utf8');
  const lines = original.split(/\r?\n/);
  const updated: string[] = [];
  let keyWritten = false;
  for (const line of lines) {
    if (new RegExp(`^\\s*(?:export\\s+)?${keyName}=`).test(line)) {
      if (!keyWritten) {
        updated.push(`${keyName}=${value}`);
        keyWritten = true;
      }
    } else {
      updated.push(line);
    }
  }
  if (!keyWritten) updated.push(`${keyName}=${value}`);
  const contents = `${updated.join('\n').replace(/\n+$/, '')}\n`;
  const temporaryPath = `${envFilePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fileHandle = await open(temporaryPath, 'wx', 0o600);
    await fileHandle.writeFile(contents, 'utf8');
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    await rename(temporaryPath, envFilePath);
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error(`Não foi possível salvar ${keyName} no .env: ${error instanceof Error ? error.message : 'erro de arquivo'}`);
  }
}

export function saveLinearApiKey(apiKey: string, envFilePath = path.resolve(process.cwd(), '.env')): Promise<void> {
  return saveApiKey('LINEAR_API_KEY', apiKey, linearKeyPattern, envFilePath);
}

export function saveOpenAIApiKey(apiKey: string, envFilePath = path.resolve(process.cwd(), '.env')): Promise<void> {
  return saveApiKey('OPENAI_API_KEY', apiKey, openAiKeyPattern, envFilePath);
}
