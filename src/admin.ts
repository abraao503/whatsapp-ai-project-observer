import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { config } from './config.js';
import { inTransaction, pool } from './db/index.js';
import { codexCliStatus, validateRepositoryPath } from './modules/codex.js';
import { interpreterStatus } from './modules/interpreter.js';
import { transcriptionStatus } from './modules/transcription.js';
import { secureEquals } from './modules/webhook-security.js';
import { connectWahaSession, getWahaConnection, listWahaChats } from './modules/waha.js';
import { saveLinearApiKey, saveOpenAIApiKey } from './modules/admin-settings.js';
import { retryBatch, retryDemand } from './jobs/worker.js';

const adminAuth: preHandlerHookHandler = async (request, reply) => {
  const authorization = request.headers.authorization ?? '';
  const [scheme, encoded] = authorization.split(' ', 2);
  let credentials = '';
  if (scheme?.toLowerCase() === 'basic' && encoded) {
    credentials = Buffer.from(encoded, 'base64').toString('utf8');
  }
  const colon = credentials.indexOf(':');
  const username = colon < 0 ? '' : credentials.slice(0, colon);
  const password = colon < 0 ? '' : credentials.slice(colon + 1);
  if (!secureEquals(config.adminUser, username) || !secureEquals(config.adminPassword, password)) {
    reply.header('WWW-Authenticate', 'Basic realm="WhatsApp Observer", charset="UTF-8"');
    return reply.code(401).type('text/plain').send('Autenticação necessária');
  }
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${field} é obrigatório e deve ter até ${max} caracteres`);
  }
  return value.trim();
}

function optionalText(value: unknown, max = 4_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function positiveId(value: unknown, field: string): number {
  const id = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${field} inválido`);
  return id;
}

function parseProject(body: unknown) {
  const input = asRecord(body);
  const project = {
    name: requiredText(input.name, 'Nome', 160),
    description: optionalText(input.description),
    repositoryPath: requiredText(input.repository_path, 'Caminho do repositório', 1_000),
    referenceBranch: requiredText(input.reference_branch, 'Branch de referência', 250),
    linearTeamId: optionalText(input.linear_team_id, 200),
    linearProjectId: optionalText(input.linear_project_id, 200),
    analysisInstructions: optionalText(input.analysis_instructions, 8_000),
    active: input.active !== false
  };
  if (!project.repositoryPath.startsWith('/')) throw new Error('O caminho do repositório deve ser absoluto');
  return project;
}

function parseProjectIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) {
    throw new Error('Selecione de 1 a 30 projetos para esta conversa');
  }
  const ids = [...new Set(value.map((id) => positiveId(id, 'ID do projeto')))];
  return ids;
}

async function overview() {
  const [projects, conversations, demands, batches, errors, webhookState] = await Promise.all([
    pool.query(
      `SELECT p.id, p.name, p.description, p.repository_path, p.reference_branch,
         p.linear_team_id, p.linear_project_id, p.analysis_instructions, p.active,
         count(DISTINCT pc.conversation_id)::int AS conversation_count,
         count(DISTINCT d.id)::int AS demand_count
       FROM projects p
       LEFT JOIN project_conversations pc ON pc.project_id = p.id
       LEFT JOIN demands d ON d.project_id = p.id
       GROUP BY p.id ORDER BY p.updated_at DESC`
    ),
    pool.query(
      `SELECT c.id, c.provider, c.instance, c.remote_jid, c.display_name, c.monitored,
         c.last_webhook_at,
         COALESCE(json_agg(jsonb_build_object('id', p.id, 'name', p.name))
           FILTER (WHERE p.id IS NOT NULL), '[]'::json) AS projects
       FROM conversations c LEFT JOIN project_conversations pc ON pc.conversation_id = c.id
       LEFT JOIN projects p ON p.id = pc.project_id
       GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 100`
    ),
    pool.query(
      `SELECT d.id, d.project_id, p.name AS project_name, d.title, d.summary, d.demand_type,
         d.status, d.requirements, d.open_questions, d.linear_issue_id,
         d.linear_issue_identifier, d.linear_issue_url, d.linear_sync_status, d.linear_error,
         d.technical_analysis, d.version, d.updated_at,
         (SELECT count(*)::int FROM demand_media dm WHERE dm.demand_id = d.id) AS media_count,
         (SELECT count(*)::int FROM demand_media dm WHERE dm.demand_id = d.id
           AND dm.status NOT IN ('synced', 'expired')) AS media_pending,
         (SELECT left(string_agg('mensagem #' || dm.message_id || ': ' || dm.last_error, E'\n'
           ORDER BY dm.message_id), 1000) FROM demand_media dm
           WHERE dm.demand_id = d.id AND dm.status = 'failed') AS media_errors,
         cj.status AS codex_status, cj.last_error AS codex_error, cj.repository_commit
       FROM demands d JOIN projects p ON p.id = d.project_id
       LEFT JOIN LATERAL (
         SELECT status, last_error, repository_commit, result
         FROM codex_jobs WHERE demand_id = d.id ORDER BY demand_version DESC LIMIT 1
       ) cj ON TRUE
       ORDER BY d.updated_at DESC LIMIT 100`
    ),
    pool.query(
      `SELECT b.id, b.conversation_id, b.status, b.first_received_at, b.last_received_at,
         b.process_after, b.attempts, b.last_error, c.provider, c.instance, c.remote_jid,
         c.display_name, count(bm.message_id)::int AS message_count,
         count(*) FILTER (WHERE m.transcript_status IN ('pending','failed'))::int AS media_pending
       FROM batches b JOIN conversations c ON c.id = b.conversation_id
       LEFT JOIN batch_messages bm ON bm.batch_id = b.id
       LEFT JOIN messages m ON m.id = bm.message_id
       WHERE b.status IN ('pending','processing','failed')
       GROUP BY b.id, c.id ORDER BY b.process_after, b.id LIMIT 100`
    ),
    pool.query('SELECT id, subsystem, message, created_at FROM app_errors ORDER BY created_at DESC LIMIT 50'),
    pool.query("SELECT key, value FROM app_state WHERE key IN ('last_webhook:waha','last_webhook:evolution')")
  ]);

  const hookTimes = new Map<string, string>();
  for (const row of webhookState.rows as Array<{ key: string; value: { receivedAt?: string } }>) {
    hookTimes.set(row.key, row.value?.receivedAt ?? '');
  }
  return {
    integrations: {
      database: 'ok',
      interpreter: interpreterStatus(),
      transcription: transcriptionStatus(),
      linear: { configured: Boolean(config.linearApiKey), detail: config.linearApiKey ? 'Chave configurada' : 'LINEAR_API_KEY ausente' },
      codex: codexCliStatus(),
      whatsapp: {
        evolution: {
          webhookConfigured: Boolean(config.evolutionWebhookToken),
          apiConfigured: Boolean(config.evolutionApiUrl && config.evolutionApiKey),
          lastWebhookAt: hookTimes.get('last_webhook:evolution') || null
        },
        waha: {
          webhookConfigured: Boolean(config.wahaHmacKey),
          apiConfigured: Boolean(config.wahaApiUrl && config.wahaApiKey && config.wahaHmacKey),
          lastWebhookAt: hookTimes.get('last_webhook:waha') || null
        }
      }
    },
    projects: projects.rows,
    conversations: conversations.rows,
    demands: demands.rows,
    batches: batches.rows,
    errors: errors.rows
  };
}

const adminHtml = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp AI Project Observer</title>
  <style>
    :root{color-scheme:light;--ink:#17201d;--muted:#69756f;--line:#dce4df;--paper:#f4f7f4;--green:#176b4d;--soft:#e6f2ec;--amber:#8c5a00;--red:#a33e3e}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
    main{max-width:1240px;margin:auto;padding:28px 18px 60px}header{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:24px}
    h1{font-size:28px;line-height:1.15;margin:0}h2{font-size:19px;margin:0 0 14px}h3{font-size:16px;margin:0 0 8px}p{margin:6px 0;color:var(--muted)}
    section,.card{background:white;border:1px solid var(--line);border-radius:12px;padding:18px;margin:14px 0;box-shadow:0 2px 8px #17201d08}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
    .stat{padding:12px;border:1px solid var(--line);border-radius:10px}.stat b{display:block;font-size:17px}.stat span{color:var(--muted);font-size:12px}
    label{display:block;font-size:12px;font-weight:650;color:var(--muted);margin:8px 0 4px}input,textarea,select{font:inherit;width:100%;padding:9px 10px;border:1px solid #cbd7d0;border-radius:7px;background:white;color:var(--ink)}textarea{min-height:68px;resize:vertical}
    .fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px}.wide{grid-column:1/-1}
    button{border:0;border-radius:7px;background:var(--green);color:white;font-weight:650;padding:9px 13px;cursor:pointer}button.secondary{background:#eaf0ec;color:var(--ink)}button.danger{background:#f9e9e7;color:var(--red)}button.small{font-size:12px;padding:5px 8px}
    .row{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--line);padding:11px 0}.row:first-child{border-top:0}.row-main{min-width:0}.row-main strong{display:block}.meta{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.actions{display:flex;gap:6px;flex-wrap:wrap}.pill{display:inline-block;padding:2px 7px;border-radius:20px;background:var(--soft);color:var(--green);font-size:11px;font-weight:700}.pill.warn{background:#fff3d9;color:var(--amber)}.pill.bad{background:#fce9e7;color:var(--red)}
    pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7f9f7;border:1px solid var(--line);border-radius:7px;padding:11px;font:12px/1.5 ui-monospace,SFMono-Regular,monospace;max-height:420px;overflow:auto}details{margin-top:8px}summary{cursor:pointer;color:var(--green);font-weight:650}a{color:var(--green)}#notice{position:sticky;top:8px;z-index:2;background:#17201d;color:white;padding:9px 12px;border-radius:8px;display:none}
    @media(max-width:780px){.grid{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}header{display:block}.fields{grid-template-columns:1fr}.wide{grid-column:auto}.row{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body><main>
  <div id="notice"></div>
  <header><div><h1>WhatsApp AI Project Observer</h1><p>Conversas autorizadas → demandas → Linear → análise Codex</p></div><button class="secondary" id="refresh">Atualizar</button></header>
  <section><h2>Integrações</h2><div id="status" class="stats"></div></section>
  <section><h2>Conectar número do WhatsApp</h2>
    <p>Sessão WAHA local: <strong>${config.wahaSession}</strong>. O Observer só recebe mensagens; não envia respostas pelo WhatsApp.</p>
    <p id="waha-status">Consultando a instância WAHA…</p>
    <p id="waha-account" class="meta"></p>
    <img id="waha-qr" alt="QR code para conectar o WhatsApp" hidden style="width:256px;height:256px;border:1px solid var(--line);border-radius:8px">
    <div class="actions"><button type="button" id="waha-connect">Conectar número / gerar QR</button><button type="button" class="secondary" id="waha-refresh">Atualizar status</button></div>
    <p>Para parear, no celular abra WhatsApp → Dispositivos conectados → Conectar dispositivo e leia o QR exibido aqui.</p>
  </section>
  <section><h2>Configuração do Linear</h2>
    <p id="linear-key-status">A chave atual nunca é exibida.</p>
    <form id="linear-key-form"><label for="linear-api-key">Linear API key</label><input id="linear-api-key" name="api_key" type="password" autocomplete="new-password" maxlength="512" placeholder="lin_api_…"><p>Informe uma chave para configurar ou trocar. Deixe vazio para removê-la. Ao salvar, o serviço reinicia para aplicar a alteração.</p><button type="submit">Salvar chave do Linear</button></form>
  </section>
  <section><h2>Transcrição de áudio com OpenAI</h2>
    <p id="openai-key-status">A chave atual nunca é exibida.</p>
    <form id="openai-key-form"><label for="openai-api-key">OpenAI API key</label><input id="openai-api-key" name="api_key" type="password" autocomplete="new-password" maxlength="512" placeholder="sk-…"><p>O áudio será enviado à OpenAI para transcrição em português. Informe uma chave para configurar ou trocar; deixe vazio para removê-la. A alteração é aplicada imediatamente e permanece após reiniciar o serviço.</p><button type="submit">Salvar chave da OpenAI</button></form>
  </section>
  <div class="grid">
    <section><h2 id="project-form-title">Cadastrar projeto</h2>
      <form id="project-form"><input type="hidden" name="id"><div class="fields">
        <div><label>Nome</label><input name="name" required maxlength="160"></div>
        <div><label>Branch de referência</label><input name="reference_branch" value="main" required></div>
        <div class="wide"><label>Descrição</label><textarea name="description"></textarea></div>
        <div class="wide"><label>Caminho do repositório na VPS</label><input name="repository_path" placeholder="/home/ubuntu/projeto" required></div>
        <div><label>Linear Team ID</label><input name="linear_team_id"></div>
        <div><label>Linear Project ID (opcional)</label><input name="linear_project_id"></div>
        <div class="wide"><label>Instruções técnicas para Codex (opcional)</label><textarea name="analysis_instructions"></textarea></div>
      </div><p><button type="submit">Salvar projeto</button> <button type="button" class="secondary" id="cancel-edit" hidden>Cancelar edição</button></p></form>
    </section>
    <section><h2>Vincular contato ou grupo</h2>
      <form id="conversation-form"><div class="fields">
        <div><label>Provedor WhatsApp</label><select name="provider"><option value="waha">WAHA</option><option value="evolution">Evolution API</option></select></div>
        <div><label>Instância / sessão</label><input name="instance" value="${config.wahaSession}" placeholder="sessão WAHA ou nome da instância Evolution" required></div>
        <div class="wide"><label>Escolher contato ou grupo da conta conectada</label><div class="actions"><select id="waha-chat"><option value="">Carregue as conversas do WhatsApp…</option></select><button type="button" id="waha-chats-refresh" class="secondary">Carregar conversas</button></div><p id="waha-chats-hint">A lista só é consultada na sessão conectada. Também é possível informar o JID manualmente.</p></div>
        <div><label>Conversa JID</label><input name="remote_jid" id="conversation-jid" placeholder="Selecione acima ou informe 5511999999999@c.us" required></div>
        <div><label>Nome para exibição (opcional)</label><input name="display_name"></div>
        <div class="wide"><label>Projetos relacionados (selecione um ou mais)</label><select id="conversation-projects" multiple required size="5"></select><p>Segure Ctrl (Windows/Linux) ou Command (macOS) para selecionar vários projetos.</p></div>
      </div><p><button type="submit">Vincular conversa</button></p></form>
    </section>
  </div>
  <section><h2>Projetos</h2><div id="projects"></div></section>
  <section><h2>Conversas monitoradas</h2><div id="conversations"></div></section>
  <section><h2>Demandas identificadas</h2><p>Demandas em contexto pendente ficam registradas aqui. Demandas claras seguem para Linear automaticamente.</p><div id="demands"></div></section>
  <section><h2>Lotes pendentes ou com erro</h2><div id="batches"></div></section>
  <section><h2>Erros recentes</h2><div id="errors"></div></section>
</main>
<script>
const $ = (selector) => document.querySelector(selector);
let state = null;
let wahaChats = [];
let previousWahaStatus = '';
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function notify(text, error=false){const node=$('#notice');node.textContent=text;node.style.display='block';node.style.background=error?'#922f2f':'#176b4d';setTimeout(()=>node.style.display='none',4500)}
async function api(path, method='GET', body){const response=await fetch('/admin/api'+path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||('HTTP '+response.status));return data}
function pill(text, mode=''){return '<span class="pill '+mode+'">'+esc(text)+'</span>'}
function statusCards(i){const cards=[['PostgreSQL',i.database],['Codex · interpretação',i.interpreter.state+' · '+i.interpreter.model],['OpenAI · áudio/vídeo',i.transcription.state+' · '+i.transcription.model],['Linear',i.linear.configured?'chave configurada':'sem chave'],['Codex CLI',i.codex.installed?i.codex.detail:'não instalado'],['WAHA',i.whatsapp.waha.webhookConfigured?'webhook com HMAC':'HMAC não configurado'],['Evolution API',i.whatsapp.evolution.webhookConfigured?'token configurado':'token não configurado']];$('#status').innerHTML=cards.map(([label,value])=>'<div class="stat"><span>'+esc(label)+'</span><b>'+esc(value)+'</b></div>').join('')+'<div class="stat"><span>Último webhook WAHA</span><b>'+esc(i.whatsapp.waha.lastWebhookAt||'nenhum')+'</b></div>'+'<div class="stat"><span>Último webhook Evolution</span><b>'+esc(i.whatsapp.evolution.lastWebhookAt||'nenhum')+'</b></div>'+'<div class="stat"><span>Interpretação</span><b>'+esc(i.interpreter.detail)+'</b></div>'+'<div class="stat"><span>Transcrição</span><b>'+esc(i.transcription.detail)+'</b></div>';$('#openai-key-status').textContent=i.transcription.state==='configured'?'Chave configurada; o valor nunca é exibido.':'Nenhuma chave OpenAI configurada.'}
function render(){const s=state;statusCards(s.integrations);
  const selectedProjects=new Set(Array.from($('#conversation-projects').selectedOptions).map(option=>option.value));
  $('#conversation-projects').innerHTML=s.projects.filter(p=>p.active).map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+' (#'+esc(p.id)+')</option>').join('');
  for(const option of $('#conversation-projects').options)option.selected=selectedProjects.has(option.value);
  $('#projects').innerHTML=s.projects.length?s.projects.map(p=>'<div class="row"><div class="row-main"><strong>'+esc(p.name)+' '+(p.active?pill('ativo'):pill('pausado','warn'))+'</strong><div class="meta">'+esc(p.repository_path)+' · branch '+esc(p.reference_branch)+' · '+p.conversation_count+' conversas · '+p.demand_count+' demandas</div><div class="meta">Linear team: '+esc(p.linear_team_id||'não definido')+' · project: '+esc(p.linear_project_id||'não definido')+'</div></div><div class="actions"><button class="small secondary" onclick="editProject('+p.id+')">Editar</button></div></div>').join(''):'<p>Nenhum projeto cadastrado.</p>';
  $('#conversations').innerHTML=s.conversations.length?s.conversations.map(c=>'<div class="row"><div class="row-main"><strong>'+esc(c.display_name||c.remote_jid)+' '+pill(c.provider)+'</strong><div class="meta">'+esc(c.instance)+' · '+esc(c.remote_jid)+' · projetos: '+esc((c.projects||[]).map(p=>p.name+' (#'+p.id+')').join(', '))+'</div><div class="meta">Último webhook: '+esc(c.last_webhook_at||'nenhum')+'</div></div><div class="actions"><button class="small secondary" onclick="editConversation('+c.id+')">Editar vínculo</button><button class="small danger" onclick="unmonitor('+c.id+')">Parar monitoramento</button></div></div>').join(''):'<p>Nenhuma conversa vinculada.</p>';
  $('#demands').innerHTML=s.demands.length?s.demands.map(d=>'<div class="row"><div class="row-main"><strong>'+esc(d.title)+' '+pill(d.status,d.status==='pending_context'?'warn':d.status==='cancelled'?'bad':'')+'</strong><div class="meta">'+esc(d.project_name)+' · '+esc(d.demand_type)+' · versão '+d.version+' · Linear: '+esc(d.linear_sync_status)+(d.codex_status?' · Codex: '+esc(d.codex_status):'')+'</div><p>'+esc(d.summary)+'</p>'+(d.media_count?'<div class="meta">Evidências de mídia: '+d.media_count+' · pendentes: '+d.media_pending+'</div>':'')+(d.media_errors?'<div class="meta">Falha ao anexar evidência: '+esc(d.media_errors)+'</div>':'')+(d.linear_issue_url?'<div class="meta"><a href="'+esc(d.linear_issue_url)+'" target="_blank" rel="noreferrer">'+esc(d.linear_issue_identifier||'Abrir no Linear')+'</a></div>':'')+(d.linear_error?'<div class="meta">Erro Linear: '+esc(d.linear_error)+'</div>':'')+(d.codex_error?'<div class="meta">Erro Codex: '+esc(d.codex_error)+'</div>':'')+'<details><summary>Requisitos e dúvidas</summary><pre>'+esc(JSON.stringify({requirements:d.requirements,openQuestions:d.open_questions},null,2))+'</pre></details>'+(d.technical_analysis?'<details><summary>Análise técnica · commit '+esc(d.repository_commit||'')+'</summary><pre>'+esc(d.technical_analysis)+'</pre></details>':d.codex_result?'<details><summary>Resultado Codex</summary><pre>'+esc(d.codex_result)+'</pre></details>':'')+'</div><div class="actions">'+(d.linear_sync_status==='error'?'<button class="small secondary" onclick="retryDemand('+d.id+',\\'linear\\')">Tentar Linear</button>':'')+(d.codex_status==='failed'?'<button class="small secondary" onclick="retryDemand('+d.id+',\\'codex\\')">Tentar Codex</button>':'')+'</div></div>').join(''):'<p>Nenhuma demanda identificada.</p>';
  $('#batches').innerHTML=s.batches.length?s.batches.map(b=>'<div class="row"><div class="row-main"><strong>Lote #'+b.id+' '+pill(b.status,b.status==='failed'?'bad':b.status==='processing'?'warn':'')+'</strong><div class="meta">'+esc(b.provider)+' · '+esc(b.instance)+' · '+esc(b.display_name||b.remote_jid)+' · '+b.message_count+' mensagens · '+b.media_pending+' áudios/vídeos pendentes</div><div class="meta">Primeira: '+esc(b.first_received_at)+' · última: '+esc(b.last_received_at)+' · pronto: '+esc(b.process_after)+' · tentativas: '+b.attempts+'</div>'+(b.last_error?'<div class="meta">'+esc(b.last_error)+'</div>':'')+'</div>'+(b.status==='failed'?'<button class="small secondary" onclick="retryBatch('+b.id+')">Reprocessar lote</button>':'')+'</div>').join(''):'<p>Nenhum lote pendente.</p>';
  $('#errors').innerHTML=s.errors.length?s.errors.map(e=>'<div class="row"><div class="row-main"><strong>'+esc(e.subsystem)+' · '+esc(e.created_at)+'</strong><div class="meta">'+esc(e.message)+'</div></div></div>').join(''):'<p>Nenhum erro recente.</p>';
}
async function refresh(){try{state=await api('/overview');render()}catch(error){notify(error.message,true)}}
function statusLabel(status){const labels={WORKING:'Conectado',SCAN_QR_CODE:'Aguardando leitura do QR',STARTING:'Iniciando',STOPPED:'Desconectado',FAILED:'Falha',NOT_CREATED:'Ainda não pareado',NOT_CONFIGURED:'WAHA não configurado',ERROR:'Erro ao acessar WAHA'};return labels[status]||status}
async function refreshWahaChats(){try{const result=await api('/waha/chats');wahaChats=result.chats||[];const select=$('#waha-chat');const selected=select.value;select.innerHTML='<option value="">Selecione um contato ou grupo…</option>'+wahaChats.map(chat=>'<option value="'+esc(chat.id)+'">'+esc(chat.kind==='group'?'Grupo':'Contato')+' · '+esc(chat.name)+' · '+esc(chat.id)+'</option>').join('');if(wahaChats.some(chat=>chat.id===selected))select.value=selected;$('#waha-chats-hint').textContent=wahaChats.length?'Conversas disponíveis: '+wahaChats.length+'. A seleção preenche o JID abaixo; ela só passa a ser monitorada após salvar o vínculo.':'Nenhum contato ou grupo foi encontrado. Você pode informar o JID manualmente.'}catch(error){$('#waha-chats-hint').textContent=error.message}}
async function refreshWaha(){try{const w=await api('/waha/connection');const mode=w.status==='WORKING'?'':w.status==='ERROR'?'bad':'warn';$('#waha-status').innerHTML=pill(statusLabel(w.status),mode)+' '+esc(w.detail);$('#waha-account').textContent=w.account?('Conta: '+w.account):'';const qr=$('#waha-qr');if(w.qrDataUrl){qr.src=w.qrDataUrl;qr.hidden=false}else{qr.removeAttribute('src');qr.hidden=true}$('#waha-connect').disabled=!w.configured||w.status==='WORKING'||w.status==='STARTING';$('#waha-connect').textContent=w.status==='SCAN_QR_CODE'?'Atualizar QR':w.status==='WORKING'?'Número conectado':'Conectar número / gerar QR';if(w.status==='WORKING'&&previousWahaStatus!=='WORKING')await refreshWahaChats();$('#waha-chat').disabled=$('#conversation-form').elements.provider.value!=='waha'||w.status!=='WORKING';previousWahaStatus=w.status}catch(error){$('#waha-status').textContent='Não foi possível consultar o WAHA: '+error.message}}
$('#waha-connect').addEventListener('click',async()=>{const button=$('#waha-connect');button.disabled=true;$('#waha-status').textContent='Solicitando conexão ao WAHA…';notify('Solicitando conexão ao WAHA…');try{await api('/waha/connect','POST',{});notify('Sessão iniciada. O QR aparecerá quando estiver pronto.')}catch(error){$('#waha-status').textContent='Falha ao conectar ao WAHA: '+error.message;notify(error.message,true)}finally{await refreshWaha()}});
$('#waha-refresh').addEventListener('click',refreshWaha);
$('#waha-chats-refresh').addEventListener('click',refreshWahaChats);
$('#conversation-form').elements.provider.addEventListener('change',()=>{$('#waha-chat').disabled=$('#conversation-form').elements.provider.value!=='waha'||previousWahaStatus!=='WORKING'});
$('#waha-chat').addEventListener('change',()=>{const chat=wahaChats.find(item=>item.id===$('#waha-chat').value);if(!chat)return;$('#conversation-jid').value=chat.id;$('#conversation-form').elements.display_name.value=chat.name});
$('#conversation-jid').addEventListener('input',()=>{if($('#conversation-jid').value!==$('#waha-chat').value)$('#waha-chat').value=''});
$('#linear-key-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget;const api_key=form.elements.api_key.value;try{await api('/settings/linear','POST',{api_key});form.reset();notify('Chave salva e aplicada.');await refresh()}catch(error){notify(error.message,true)}});
$('#openai-key-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget;const api_key=form.elements.api_key.value;try{await api('/settings/openai-transcription','POST',{api_key});form.reset();notify('Chave OpenAI salva e aplicada.');await refresh()}catch(error){notify(error.message,true)}});
window.editProject=(id)=>{const p=state.projects.find(item=>item.id===id);if(!p)return;const form=$('#project-form');form.elements.id.value=p.id;form.elements.name.value=p.name;form.elements.description.value=p.description;form.elements.repository_path.value=p.repository_path;form.elements.reference_branch.value=p.reference_branch;form.elements.linear_team_id.value=p.linear_team_id;form.elements.linear_project_id.value=p.linear_project_id;form.elements.analysis_instructions.value=p.analysis_instructions;$('#project-form-title').textContent='Editar projeto #'+id;$('#cancel-edit').hidden=false;window.scrollTo({top:0,behavior:'smooth'})};
window.editConversation=(id)=>{const c=state.conversations.find(item=>item.id===id);if(!c)return;const form=$('#conversation-form');form.elements.provider.value=c.provider;form.elements.instance.value=c.instance;form.elements.remote_jid.value=c.remote_jid;form.elements.display_name.value=c.display_name||'';const ids=new Set((c.projects||[]).map(project=>String(project.id)));for(const option of $('#conversation-projects').options)option.selected=ids.has(option.value);$('#conversation-form').scrollIntoView({behavior:'smooth',block:'center'})};
window.unmonitor=async(id)=>{if(!confirm('Parar de observar esta conversa?'))return;try{await api('/conversations/'+id,'DELETE');notify('Monitoramento removido; histórico preservado.');await refresh()}catch(e){notify(e.message,true)}};
window.retryDemand=async(id,kind)=>{try{await api('/demands/'+id+'/retry-'+kind,'POST',{});notify('Job agendado.');await refresh()}catch(e){notify(e.message,true)}};
window.retryBatch=async(id)=>{try{await api('/batches/'+id+'/retry','POST',{});notify('Lote reprocessado.');await refresh()}catch(e){notify(e.message,true)}};
$('#project-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget;const data=Object.fromEntries(new FormData(form).entries());const id=data.id;delete data.id;try{await api(id?'/projects/'+id:'/projects',id?'PUT':'POST',data);form.reset();form.elements.reference_branch.value='main';$('#project-form-title').textContent='Cadastrar projeto';$('#cancel-edit').hidden=true;notify('Projeto salvo.');await refresh()}catch(e){notify(e.message,true)}});
$('#cancel-edit').addEventListener('click',()=>{const form=$('#project-form');form.reset();form.elements.reference_branch.value='main';$('#project-form-title').textContent='Cadastrar projeto';$('#cancel-edit').hidden=true});
$('#conversation-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget;const data=Object.fromEntries(new FormData(form).entries());data.project_ids=Array.from($('#conversation-projects').selectedOptions).map(option=>Number(option.value));try{await api('/conversations','POST',data);form.reset();form.elements.instance.value='${config.wahaSession}';wahaChats=[];$('#waha-chat').innerHTML='<option value="">Carregue as conversas do WhatsApp…</option>';notify('Conversa vinculada e monitoramento ativado.');await refresh()}catch(e){notify(e.message,true)}});
$('#refresh').addEventListener('click',refresh);refresh();refreshWaha();setInterval(refresh,30000);setInterval(refreshWaha,5000);
</script></body></html>`;

function sendApiError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : 'Requisição inválida';
  return reply.code(400).send({ error: message.slice(0, 500) });
}

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get('/admin', { preHandler: adminAuth }, async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(adminHtml);
  });

  app.get('/admin/api/overview', { preHandler: adminAuth }, async (request, reply) => {
    try {
      return await overview();
    } catch (error) {
      request.log.error({ err: error }, 'admin overview failed');
      return reply.code(500).send({ error: 'Não foi possível carregar os dados administrativos' });
    }
  });

  app.get('/admin/api/waha/connection', { preHandler: adminAuth }, async () => getWahaConnection());

  app.get('/admin/api/waha/chats', { preHandler: adminAuth }, async (_request, reply) => {
    try {
      return { chats: await listWahaChats() };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao carregar conversas do WAHA';
      return reply.code(503).send({ error: message.slice(0, 300) });
    }
  });

  app.post('/admin/api/waha/connect', { preHandler: adminAuth }, async (_request, reply) => {
    try {
      return await connectWahaSession();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao iniciar a sessão WAHA';
      return reply.code(503).send({ error: message.slice(0, 300) });
    }
  });

  app.post('/admin/api/settings/linear', { preHandler: adminAuth }, async (request, reply) => {
    const body = asRecord(request.body);
    if (typeof body.api_key !== 'string') return reply.code(400).send({ error: 'Informe api_key como texto' });
    try {
      await saveLinearApiKey(body.api_key);
      config.linearApiKey = body.api_key.trim();
      return { ok: true };
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.post('/admin/api/settings/openai-transcription', { preHandler: adminAuth }, async (request, reply) => {
    const body = asRecord(request.body);
    if (typeof body.api_key !== 'string') return reply.code(400).send({ error: 'Informe api_key como texto' });
    try {
      await saveOpenAIApiKey(body.api_key);
      config.openaiApiKey = body.api_key.trim();
      return { ok: true };
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.post('/admin/api/projects', { preHandler: adminAuth }, async (request, reply) => {
    try {
      const project = parseProject(request.body);
      project.repositoryPath = await validateRepositoryPath(project.repositoryPath);
      const result = await pool.query<{ id: number }>(
        `INSERT INTO projects(name, description, repository_path, reference_branch,
           linear_team_id, linear_project_id, analysis_instructions, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [project.name, project.description, project.repositoryPath, project.referenceBranch,
          project.linearTeamId, project.linearProjectId, project.analysisInstructions, project.active]
      );
      return reply.code(201).send({ id: result.rows[0]!.id });
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>('/admin/api/projects/:id', { preHandler: adminAuth }, async (request, reply) => {
    try {
      const id = positiveId(request.params.id, 'ID do projeto');
      const project = parseProject(request.body);
      project.repositoryPath = await validateRepositoryPath(project.repositoryPath);
      const result = await pool.query(
        `UPDATE projects SET name=$2, description=$3, repository_path=$4, reference_branch=$5,
           linear_team_id=$6, linear_project_id=$7, analysis_instructions=$8, active=$9, updated_at=now()
         WHERE id=$1`,
        [id, project.name, project.description, project.repositoryPath, project.referenceBranch,
          project.linearTeamId, project.linearProjectId, project.analysisInstructions, project.active]
      );
      if (!result.rowCount) return reply.code(404).send({ error: 'Projeto não encontrado' });
      return { ok: true };
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.post('/admin/api/conversations', { preHandler: adminAuth }, async (request, reply) => {
    try {
      const input = asRecord(request.body);
      const provider = input.provider;
      if (provider !== 'waha' && provider !== 'evolution') throw new Error('Provedor WhatsApp inválido');
      const instance = requiredText(input.instance, 'Instância', 120);
      const remoteJid = requiredText(input.remote_jid, 'Conversa JID', 220);
      const displayName = optionalText(input.display_name, 200);
      const projectIds = parseProjectIds(input.project_ids);
      const result = await inTransaction(async (client) => {
        const validProjects = await client.query<{ id: number }>(
          'SELECT id FROM projects WHERE id = ANY($1::bigint[]) AND active', [projectIds]
        );
        if (validProjects.rowCount !== projectIds.length) throw new Error('Um projeto não existe ou está pausado');
        const conversation = await client.query<{ id: number }>(
          `INSERT INTO conversations(provider, instance, remote_jid, display_name, monitored)
           VALUES ($1,$2,$3,$4,TRUE)
           ON CONFLICT (provider, instance, remote_jid) DO UPDATE SET
             display_name = EXCLUDED.display_name, monitored = TRUE, updated_at = now()
           RETURNING id`,
          [provider, instance, remoteJid, displayName]
        );
        const conversationId = conversation.rows[0]!.id;
        await client.query('DELETE FROM project_conversations WHERE conversation_id = $1', [conversationId]);
        for (const projectId of projectIds) {
          await client.query(
            'INSERT INTO project_conversations(project_id, conversation_id) VALUES ($1,$2)',
            [projectId, conversationId]
          );
        }
        return conversationId;
      });
      return reply.code(201).send({ id: result });
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/admin/api/conversations/:id', { preHandler: adminAuth }, async (request, reply) => {
    try {
      const id = positiveId(request.params.id, 'ID da conversa');
      await inTransaction(async (client) => {
        await client.query('DELETE FROM project_conversations WHERE conversation_id = $1', [id]);
        const result = await client.query(
          'UPDATE conversations SET monitored = FALSE, updated_at = now() WHERE id = $1', [id]
        );
        if (!result.rowCount) throw new Error('Conversa não encontrada');
      });
      return { ok: true };
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/admin/api/demands/:id/retry-linear', { preHandler: adminAuth }, async (request, reply) => {
    try {
      const ok = await retryDemand(positiveId(request.params.id, 'ID da demanda'), 'linear');
      return ok ? { ok: true } : reply.code(409).send({ error: 'A demanda não está pronta para Linear' });
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/admin/api/demands/:id/retry-codex', { preHandler: adminAuth }, async (request, reply) => {
    try {
      const ok = await retryDemand(positiveId(request.params.id, 'ID da demanda'), 'codex');
      return ok ? { ok: true } : reply.code(409).send({ error: 'A demanda não está pronta para análise Codex' });
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/admin/api/batches/:id/retry', { preHandler: adminAuth }, async (request, reply) => {
    try {
      const ok = await retryBatch(positiveId(request.params.id, 'ID do lote'));
      return ok ? { ok: true } : reply.code(409).send({ error: 'O lote não está falho ou já há um lote posterior processado' });
    } catch (error) {
      return sendApiError(reply, error);
    }
  });
}
