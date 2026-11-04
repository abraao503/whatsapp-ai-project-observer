# WhatsApp AI Project Observer

Backend único em Node.js/TypeScript para observar conversas permitidas, persistir as mensagens no PostgreSQL, agrupá-las com debounce e manter demandas sincronizadas com Linear. A análise do repositório é um job separado executado pelo Codex CLI em um snapshot somente de leitura.

O serviço nunca envia mensagens pelo WhatsApp. Mensagens do operador entram no mesmo lote das mensagens do contato. Um lote tem visão fixa; mensagens recebidas durante o processamento ficam em outro lote.

## Ambiente de deploy

A aplicação roda como um único processo Node.js/TypeScript, gerenciado por PM2. Configure `DATABASE_URL` para um banco PostgreSQL exclusivo da aplicação, de preferência acessível apenas localmente. Um Nginx existente pode encaminhar tráfego HTTPS para a porta local do backend. O projeto não exige container nem Docker Compose para a aplicação.

Reutilize os serviços já disponíveis no host. Confira os caminhos, portas e nomes efetivos no momento do deploy; não exponha publicamente a porta do banco.

## Desenvolvimento local

Requisitos: Node.js 22 ou mais recente e um PostgreSQL de desenvolvimento. As dependências são Fastify, `pg`, `dotenv` e TypeScript/tsx.

```sh
npm ci
cp .env.example .env
```

Preencha `.env`, configure um `DATABASE_URL` local, credenciais administrativas fortes, o webhook e as integrações disponíveis. `OPENAI_API_KEY` é necessária para áudio e vídeo. `REPOSITORY_ROOTS` deve conter apenas diretórios autorizados para leitura pelo Codex.

```sh
npm run dev
```

O servidor aplica o schema idempotente na inicialização. O worker fica no mesmo processo. A interpretação das conversas e a análise dos repositórios usam o Codex CLI autenticado com ChatGPT, fixado em `gpt-6-luna`. A transcrição de áudios usa a API da OpenAI com `gpt-transcribe`; configure `OPENAI_API_KEY` no painel ou no `.env`. Os arquivos de áudio são enviados à OpenAI para transcrição em português.

Comandos de verificação local:

```sh
npm run typecheck
npm test
npm run build
```

Os testes locais cobrem cálculo de debounce, limite do lote, backoff, normalização de eventos Evolution/WAHA, mensagens próprias e de grupos, áudio e vídeo, HMAC, criação/edição e reconciliação de issue via Linear mockado, além da execução read-only do job Codex contra um CLI de teste e rejeição de symlink para fora do repositório.

### Validar o fluxo local com PostgreSQL

Os testes de fluxo usam um PostgreSQL local real, um Codex CLI de fixture e o endpoint GraphQL do Linear mockado. O fluxo valida criação/edição do card, webhook duplicado, mensagem própria durante uma interpretação em andamento e recuperação de lote após reinício. Os testes adicionais cobrem debounce, duplicatas que não prolongam o lote, isolamento entre conversas, mensagens fora de ordem, limite máximo de espera, abertura do próximo lote ao atingir a capacidade, preservação de mídia após falha e retry de vídeo sem repetir uma transcrição já persistida.

Use um banco local exclusivo. Se já existir PostgreSQL local, crie nele um banco de teste separado e use a URL abaixo ajustada. Se não houver, este container descartável é opcional e restrito ao loopback:

```sh
docker run --name whatsapp-ai-project-observer-local-postgres --detach \
  --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_DB=observer_test \
  --env POSTGRES_USER=observer_test \
  --env POSTGRES_PASSWORD="$OBSERVER_TEST_PASSWORD" \
  postgres:16-alpine
```

Gere uma senha local e defina a URL do banco de teste antes de iniciar o container:

```sh
export OBSERVER_TEST_PASSWORD="$(openssl rand -hex 24)"
export TEST_DATABASE_URL="postgresql://observer_test:${OBSERVER_TEST_PASSWORD}@127.0.0.1:55432/observer_test"
```

Rode o container e os testes, mantendo o banco local disponível para próximos testes:

```sh
# Execute o comando docker run acima depois de definir a senha.
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:flow
```

Os testes removem os registros temporários que criam. O container não publica a porta fora do loopback; mantenha-o ativo para próximos testes.

### Avaliação comportamental com GPT-6 Luna via Codex CLI

O script chama a mesma função de interpretação do backend, pelo Codex CLI autenticado, sem usar chave OpenAI API. Ele avalia uma demanda nova, refinamento do mesmo ID/versão, dois assuntos no lote e mensagem vaga. Não faz chamadas ao WhatsApp nem ao Linear.

```sh
npm run eval:luna
```

Esse caminho consome o uso do Codex associado à conta autenticada. O modelo é passado explicitamente como `gpt-6-luna`; se o CLI não tiver acesso a ele, a execução falha e não há fallback. As interpretações sintéticas saem no terminal.

## Banco PostgreSQL

No deploy, conecte ao PostgreSQL já disponível no host e crie uma role e um banco exclusivos para a aplicação, com senha própria. Por exemplo, em uma sessão administrativa do `psql`:

```sql
CREATE ROLE whatsapp_observer LOGIN PASSWORD 'substitua-por-uma-senha-forte';
CREATE DATABASE whatsapp_observer OWNER whatsapp_observer;
```

Não rode o SQL se a role ou banco já existirem; confira o estado primeiro. Configure `DATABASE_URL` com o endereço local e a porta corretos do serviço PostgreSQL existente. Não altere os mapeamentos de porta de outros projetos.

## Configuração de integrações

### WhatsApp

Cadastre explicitamente cada conversa autorizada no painel `/admin`. Depois de conectar a conta WAHA, carregue os contatos/grupos, escolha a conversa e selecione um ou mais projetos relacionados; o JID continua editável para entrada manual e para Evolution. Vínculos existentes podem ser editados pela lista de conversas. A seleção no painel apenas concede monitoramento após salvar; eventos de outras conversas são descartados. O webhook só persiste a mensagem e agenda o lote; não chama IA nem Codex durante a requisição.

- Evolution: configure `EVOLUTION_WEBHOOK_TOKEN` e envie os eventos `MESSAGES_UPSERT` e `SEND_MESSAGE` para `/webhooks/evolution/<token>`. Para mídia, configure a integração para incluir base64 (`webhookBase64`) ou forneça `EVOLUTION_API_URL` e chave de API compatíveis com um endpoint `/api/files/...`.
- WAHA: o projeto usa uma instância própria em `127.0.0.1:3201`. O painel inicia a sessão `observer`, configura `message.any` com assinatura HMAC e mostra o QR/status. O Observer acessa a API pelo loopback e usa chave; mantenha a porta 3201 bloqueada para conexões externas no firewall. Mensagens não monitoradas são descartadas pelo Observer. Para baixar áudio ou vídeo sem base64, o processo usa a API local autenticada.

Para conectar um número, abra `/admin`, selecione **Conectar número do WhatsApp** e escaneie o QR em WhatsApp → Dispositivos conectados. O estado da conexão e o nome/número da conta são atualizados pelo painel. A sessão fica persistida no volume `/home/ubuntu/.local/share/whatsapp-observer/waha-sessions`, inclusive após reiniciar o container. A sessão habilita o armazenamento NOWEB com sincronização histórica limitada; isso é necessário para listar contatos e grupos e não deve ser alterado depois do pareamento.

Na VPS ARM64, a instância usa `devlikeapro/waha:noweb-arm-2026.10.1`, uma versão fixada do engine NOWEB. Ela roda em container Docker separado, com `--network host`, mas o servidor WAHA está configurado para escutar somente em `127.0.0.1:3201`; não publique a porta na Internet nem altere o container WAHA de outros projetos. A API key de WAHA fica hasheada no arquivo de ambiente do container; o Observer guarda a chave correspondente em `.env`, com permissões restritas.

Áudio e vídeo sem base64 ficam preservados como mídia pendente/falha e o lote não é apagado.

### Interpretação com Codex CLI

Instale e autentique o Codex CLI para o mesmo usuário do PM2. O backend verifica `codex login status` e executa `codex exec --model gpt-6-luna` em modo não interativo, read-only e ephemeral, com schema JSON estruturado. O identificador do modelo é fixo por `CODEX_MODEL`; se o CLI não aceitar `gpt-6-luna`, o lote falha com retry e não troca de modelo. A `OPENAI_API_KEY` é usada somente para transcrever áudio e não é passada ao Codex CLI.

### Transcrição de áudio pela OpenAI

Configure `OPENAI_API_KEY` no painel, em **Transcrição de áudio com OpenAI**, ou no `.env`. O modelo padrão é `gpt-transcribe` (`OPENAI_TRANSCRIPTION_MODEL`), com dica de idioma português (`pt`). Áudios compatíveis são enviados como recebidos; formatos não aceitos pela API são convertidos para WAV com `ffmpeg`. Se faltar a chave ou a transcrição falhar, o lote registra erro e mantém o áudio armazenado para retry. O limite é controlado por `MAX_AUDIO_BYTES` e o timeout por `OPENAI_TRANSCRIPTION_TIMEOUT_MS`.

### Análise de vídeo

Vídeos passam pelo mesmo worker assíncrono: `ffprobe` verifica faixa e duração; `ffmpeg` extrai a faixa de áudio para transcrição pela OpenAI e amostra quadros em intervalos regulares; o Codex CLI recebe a transcrição e as imagens com seus timestamps junto do contexto do lote. O Codex analisa quadros estáticos, não o arquivo de vídeo bruto. A amostragem é limitada para controlar tempo e custo, então movimentos muito rápidos entre quadros podem não aparecer na análise.

Os limites padrão são 50 MB por vídeo, 180 segundos, até 6 quadros por vídeo e 12 quadros por lote. Ajuste `MAX_VIDEO_BYTES`, `VIDEO_MAX_DURATION_SECONDS`, `VIDEO_MAX_FRAMES_PER_MESSAGE`, `VIDEO_MAX_FRAMES_PER_BATCH` e `VIDEO_PROCESSING_TIMEOUT_MS` conforme a capacidade da máquina. `ffprobe` vem no pacote `ffmpeg`; se o executável tiver outro caminho, configure `FFPROBE_CLI`. Legenda, fala transcrita e quadros visuais são enviados juntos ao `gpt-6-luna` pelo Codex CLI. Os quadros temporários são apagados após a interpretação; o vídeo bruto fica no PostgreSQL apenas enquanto o lote precisa de retry e é removido ao concluir.

### Linear

Configure ou troque `LINEAR_API_KEY` diretamente no painel, em **Configuração do Linear**. A chave é gravada no `.env` com modo privado, nunca é exibida novamente e o processo PM2 reinicia após salvar. No desenvolvimento local, reinicie o processo manualmente depois de alterar a chave. Para cada projeto, preencha `linear_team_id` e, quando desejado, `linear_project_id` no cadastro/edição de projeto. A issue inclui um marcador interno determinístico usado na reconciliação após timeout; atualizações e retries mantêm o mesmo vínculo.

Issues novas são criadas explicitamente em **Backlog**. Atualizações de refinamento preservam a coluna escolhida no Linear; a descrição não repete um status interno, então a coluna do Linear é a única fonte do status de trabalho.

Demandas concretas aparecem no Linear assim que identificadas, mesmo quando ainda faltam detalhes. Esses cards recebem a label `Aguardando contexto` e listam as dúvidas pendentes; quando a conversa esclarece o suficiente, o mesmo card é atualizado e a label é removida. A análise técnica do Codex continua aguardando a demanda ficar pronta.

Ao sincronizar uma demanda, o serviço aplica as labels `Tipo: Funcionalidade`, `Tipo: Bug`, `Tipo: Melhoria` ou `Tipo: Alteração`, além de `Aguardando contexto` quando a demanda ainda precisa de detalhes. O card é associado ao projeto do Linear configurado, sem criar uma label de projeto. Em refinamentos, o serviço remove antigas labels `Projeto: ...` criadas por versões anteriores e preserva as demais labels adicionadas manualmente.

Os cards usam um modelo editorial curto: objetivo/escopo, requisitos, critérios de aceite, dúvidas pendentes e contexto/decisões. Seções opcionais sem conteúdo são omitidas. O tipo é exibido em português e a análise Codex entra em uma seção separada. O agente tem alvos flexíveis: título normalmente com 5–12 palavras; resumo em 2–3 frases; 2–5 requisitos e 2–4 critérios verificáveis; até 3 dúvidas que possam alterar o escopo. Pedidos simples podem usar menos itens. O sistema valida limites para evitar respostas excessivas: título até 140 caracteres, resumo até 1.800, no máximo 8 requisitos, 6 critérios e 4 dúvidas. O Codex é orientado a escrever normalmente 100–160 palavras, chegando a cerca de 200 em análises realmente complexas, com até 3 caminhos, 3 passos de implementação e 2–3 verificações sugeridas.

### Codex CLI

Instale e autentique o Codex CLI para o mesmo usuário que executa a aplicação no PM2. Se o binário não estiver no `PATH` desse usuário, defina `CODEX_CLI` com seu caminho completo. O worker verifica atualizações no GitHub a cada `REPOSITORY_SYNC_INTERVAL_MS` (padrão: 5 minutos) e também antes de cada análise. Só aplica fast-forward na branch configurada quando o clone está limpo; alterações locais, divergências ou falhas de acesso ficam registradas e não são sobrescritas. Se o caminho configurado contiver repositórios Git em pastas diretas, o worker cria um snapshot separado de cada um e o Codex analisa todos no mesmo contexto, registrando o commit considerado em cada repositório. O Codex recebe snapshots via `git archive`, em modo não interativo, sandbox read-only, saída temporária e timeout; não recebe os diretórios graváveis nem executa comandos originados de conversas. `REPOSITORY_ROOTS` é obrigatório para cadastrar repositórios.

### WAHA próprio na VPS

Use uma instância separada daquelas pertencentes a outros projetos. Esta VPS usa host networking para que o webhook WAHA alcance o backend em `127.0.0.1:3105`; a API WAHA escuta em wildcard nesta imagem, portanto a firewall do host precisa rejeitar conexões de entrada na porta 3201. Não adicione uma regra de liberação nem exponha a porta por Nginx. Exemplo para a imagem ARM64 usada nesta VPS, sem Docker Compose:

```sh
docker run --detach --name whatsapp-observer-waha \
  --restart unless-stopped --network host --memory 2g --cpus 1 \
  --env-file /home/ubuntu/.config/whatsapp-observer/waha.env \
  --volume /home/ubuntu/.local/share/whatsapp-observer/waha-sessions:/app/.sessions \
  devlikeapro/waha:noweb-arm-2026.10.1
```

O arquivo privado `waha.env` define a URL-base local, `WHATSAPP_API_PORT=3201`, `WHATSAPP_DEFAULT_ENGINE=NOWEB`, uma `WAHA_API_KEY` em formato SHA-512, desativa Dashboard/Swagger e mantém o QR fora dos logs. `WHATSAPP_API_HOSTNAME` compõe URLs do WAHA, mas nesta imagem não restringe o endereço de bind do servidor. No `.env` do Observer, configure `WAHA_API_URL=http://127.0.0.1:3201`, a chave original em `WAHA_API_KEY`, `WAHA_HMAC_KEY` e `WAHA_SESSION=observer`. O painel cria/atualiza a sessão e a assinatura do webhook ao iniciar o pareamento.

## Debounce, sequência e recuperação

Padrões iniciais configuráveis no `.env`:

- Silêncio: `BATCH_IDLE_MS=90000`.
- Espera máxima desde a primeira mensagem: `BATCH_MAX_WAIT_MS=300000`.
- Limite: `BATCH_MAX_MESSAGES=30`.
- Concorrência entre conversas: `MAX_PARALLEL_BATCHES=2`.

O lote pendente, suas mensagens, datas, estado, tentativas, erros e agendamento ficam no PostgreSQL. Cada conversa tem apenas um lote em execução. Uma nova mensagem durante a análise fica no próximo lote; processos podem executar em paralelo para conversas diferentes. Lotes falhos bloqueiam os posteriores da mesma conversa até retry, para preservar a sequência contextual.

`MESSAGE_RETENTION_DAYS` controla o conteúdo bruto. Mensagens antigas sem vínculo a demandas são excluídas; mensagens citadas por demandas mantêm seus IDs de evidência, mas texto, transcrição, mídia e dados do remetente são apagados. Demandas consolidadas, resumos e issues do Linear permanecem para acompanhar o trabalho.

## Deploy manual na VPS

1. Clone o projeto em um diretório dedicado, por exemplo `/home/ubuntu/whatsapp-ai-project-observer`; não coloque `.env` no Git.
2. Carregue NVM no shell, instale deps, preencha `.env`, compile e crie a pasta de logs:

   ```sh
   source ~/.nvm/nvm.sh
   npm ci
   cp .env.example .env
   # editar .env com credenciais e caminhos reais
   npm run build
   mkdir -p logs
   ```

3. Verifique `pm2 status` e os serviços atuais. Inicie apenas este ecosystem:

   ```sh
   pm2 start ecosystem.config.cjs
   pm2 status
   pm2 logs whatsapp-observer
   pm2 restart whatsapp-observer
   ```

   `pm2 save` persiste a lista inteira de processos do PM2 daquele usuário. Antes de executá-lo, confirme que os processos existentes que devem voltar após reboot estão presentes na lista; ele não salva somente este app.

4. Configure Nginx como reverse proxy para `127.0.0.1:3105`, TLS HTTPS e limite de corpo adequado a `MAX_AUDIO_BYTES`. Proteja `/admin` com a autenticação do app. O token Evolution faz parte do caminho e deve ser excluído dos access logs Nginx (ou troque a validação para header em um ajuste futuro); não encaminhe a porta da API diretamente à Internet.

Exemplo de configuração de proxy para adaptar ao server block TLS já existente:

```nginx
location /webhooks/evolution/ {
    access_log off;
    client_max_body_size 80m;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:3105;
}

location / {
    client_max_body_size 80m;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:3105;
}
```

Valide o Nginx com o usuário administrativo que pode ler os certificados e recarregue somente depois da validação; não substitua o arquivo nem reinicie aplicações existentes sem revisar o server block efetivo.

## Painel e endpoints

- `/admin`: interface autenticada para projetos, conversas, demandas, lotes, erros e retries.
- `/health`: disponibilidade básica do processo/banco e estado da validação do modelo.
- `/webhooks/evolution/:token` e `/webhooks/evolution/:token/:event`.
- `/webhooks/waha` com HMAC-SHA512 do corpo bruto.

Projetos e contatos são configurados no painel. Ao salvar um projeto, o caminho é resolvido e validado dentro de `REPOSITORY_ROOTS`; isso impede cadastrar caminhos que saiam das raízes permitidas.

## Limitações que dependem de credenciais/ambiente de deploy

- O Linear, as credenciais do provedor WhatsApp e os projetos/conversas observados precisam ser configurados no ambiente de deploy. O painel e `/health` mostram o status do Codex; o acesso a `gpt-6-luna` é confirmado na primeira interpretação real, sem fallback.
- Configure o provedor WhatsApp e os eventos que sua instalação envia; Evolution e WAHA têm parsers próprios.
- O download de áudio/vídeo de uma URL do provedor só aceita o caminho `/api/files/...` e exige que o processo alcance a API configurada.
- Os testes de fluxo com PostgreSQL exigem `TEST_DATABASE_URL`; a avaliação Luna usa quatro conversas sintéticas e a conta autenticada do Codex CLI.
