import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

function git(repository: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} falhou`);
  return result.stdout.trim();
}

test('Codex analisa snapshot read-only e rejeita symlink que saia do repositório', async () => {
  const originalRoots = process.env.REPOSITORY_ROOTS;
  const originalCodexCli = process.env.CODEX_CLI;
  const originalTimeout = process.env.CODEX_TIMEOUT_MS;
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'whatsapp-observer-codex-test-'));
  const repository = path.join(temporaryRoot, 'repository');
  const cli = path.join(temporaryRoot, 'fake-codex');

  try {
    await mkdir(repository);
    await writeFile(path.join(repository, 'README.md'), '# Repositório de teste\n');
    await symlink('/bin/echo', cli);
    git(repository, ['init']);
    git(repository, ['config', 'user.name', 'Observer Test']);
    git(repository, ['config', 'user.email', 'observer-test@example.invalid']);
    git(repository, ['checkout', '-b', 'main']);
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-m', 'fixture']);

    process.env.REPOSITORY_ROOTS = temporaryRoot;
    process.env.CODEX_CLI = cli;
    process.env.CODEX_TIMEOUT_MS = '10000';
    const { analyzeRepository } = await import('../src/modules/codex.js');
    const task = {
      demandId: 5,
      title: 'Exportar relatórios',
      summary: 'Permitir exportar relatórios para uma planilha.',
      demandType: 'feature',
      requirements: ['Exportar relatórios em Excel'],
      acceptanceCriteria: ['O arquivo contém os relatórios selecionados'],
      openQuestions: [],
      conversationContext: 'O operador confirmou o formato Excel.',
      projectName: 'Fixture',
      repositoryPath: repository,
      referenceBranch: 'main',
      analysisInstructions: ''
    };

    const analysis = await analyzeRepository(task);
    assert.match(analysis.commit, /^[a-f0-9]{40}$/);
    const args = analysis.text.trim();
    assert.ok(args.startsWith('exec --sandbox read-only --ephemeral --ignore-user-config --skip-git-repo-check'));
    const snapshot = args.match(/-C ([^ ]+) -$/)?.[1] ?? '';
    assert.ok(snapshot);
    assert.notEqual(snapshot, repository);
    assert.equal(path.basename(snapshot), 'repository');
    assert.equal(git(repository, ['status', '--porcelain']), '', 'o repositório original permanece intacto');

    await symlink('/etc/passwd', path.join(repository, 'outside.txt'));
    git(repository, ['add', 'outside.txt']);
    git(repository, ['commit', '-m', 'unsafe symlink fixture']);
    await assert.rejects(analyzeRepository(task), /symlink fora do repositório/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    if (originalRoots === undefined) delete process.env.REPOSITORY_ROOTS;
    else process.env.REPOSITORY_ROOTS = originalRoots;
    if (originalCodexCli === undefined) delete process.env.CODEX_CLI;
    else process.env.CODEX_CLI = originalCodexCli;
    if (originalTimeout === undefined) delete process.env.CODEX_TIMEOUT_MS;
    else process.env.CODEX_TIMEOUT_MS = originalTimeout;
  }
});
