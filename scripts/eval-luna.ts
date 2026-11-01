import 'dotenv/config';
import assert from 'node:assert/strict';
import type { Interpretation, ObserverContext } from '../src/modules/interpreter.js';
import { interpret, validateCodexAccess } from '../src/modules/interpreter.js';

const model = 'gpt-6-luna';

function context(
  messages: Array<{ id: string; sender: string; fromMe: boolean; text: string }>,
  demands: ObserverContext['projects'][number]['demands'] = [],
  summary = ''
): ObserverContext {
  return {
    conversation: {
      provider: 'evolution',
      instance: 'synthetic-luna-evaluation',
      remoteJid: '5511999999999@s.whatsapp.net',
      summary,
      decisions: []
    },
    recentMessages: [],
    projects: [{
      id: 1,
      name: 'Projeto sintético para avaliação',
      description: 'Contexto de exemplo; nenhuma conversa real será usada.',
      technicalInstructions: '',
      demands
    }],
    batchMessages: messages.map((message, index) => ({
      ...message,
      sentAt: new Date(Date.UTC(2026, 10, 1, 12, 0, index)).toISOString()
    }))
  };
}

function message(id: string, text: string, fromMe = false) {
  return { id, sender: fromMe ? 'Operador' : 'Cliente', fromMe, text };
}

function readyActions(result: Interpretation) {
  return result.actions.filter((action) => ['new', 'update'].includes(action.action) && action.ready);
}

async function main(): Promise<void> {
  const status = await validateCodexAccess();
  assert.equal(status.state, 'available', status.detail);
  assert.equal(status.model, model);

  const initial = await interpret(context([
    message('101', 'Precisamos exportar os relatórios mensais da folha.'),
    message('102', 'O arquivo deve ser CSV.'),
    message('103', 'Preciso filtrar por data e funcionário.')
  ]));
  assert.ok(readyActions(initial).some((action) => action.action === 'new'), 'pedido claro deveria gerar uma demanda nova pronta');

  const refined = await interpret(context([
    message('201', 'Além do filtro por funcionário, inclua centro de custo.', true),
    message('202', 'E mantenha os filtros escolhidos para a próxima consulta.')
  ], [{
    id: 4242,
    version: 3,
    title: 'Exportar relatórios da folha em CSV',
    summary: 'Exportar relatórios da folha para CSV com filtros de período e funcionário.',
    type: 'feature',
    status: 'ready',
    requirements: ['Exportar em CSV', 'Filtrar por período', 'Filtrar por funcionário'],
    openQuestions: []
  }], 'O cliente pediu exportação CSV da folha, com filtros por período e funcionário.'));
  assert.ok(refined.actions.some((action) =>
    action.action === 'update' && action.demandId === 4242 && action.demandVersion === 3
  ), 'refinamento deveria apontar para o ID e a versão existentes');

  const multiple = await interpret(context([
    message('301', 'Na ficha do cliente, mostrar uma prévia dos anexos antes de baixar.'),
    message('302', 'No fechamento, faturas canceladas estão duplicando o imposto; devem ser excluídas do cálculo.')
  ]));
  assert.ok(readyActions(multiple).length >= 2, 'duas solicitações independentes deveriam continuar separadas');

  const vague = await interpret(context([
    message('401', 'Oi, tudo bem? Sobre aquela tela, depois vemos com calma; por enquanto deixa assim.')
  ]));
  assert.equal(readyActions(vague).length, 0, 'mensagem vaga não deveria criar demanda pronta');

  console.log(JSON.stringify({
    model,
    authentication: status.detail,
    cases: [
      { name: 'nova demanda clara', passed: true, result: initial },
      { name: 'refinamento aponta para mesma demanda', passed: true, result: refined },
      { name: 'duas demandas independentes no lote', passed: true, result: multiple },
      { name: 'mensagem vaga ignorada', passed: true, result: vague }
    ]
  }, null, 2));
}

main().catch((error) => {
  console.error(`[eval:luna] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
