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

Preencha `.env`, configure um `DATABASE_URL` local, credenciais administrativas fortes, o webhook e as integrações disponíveis. `REPOSITORY_ROOTS` deve conter apenas diretórios autorizados para leitura pelo Codex.

```sh
npm run dev
```

O servidor aplica o schema idempotente na inicialização. O worker fica no mesmo processo. Sem chave OpenAI, as mensagens e os lotes ficam persistidos e aguardam processamento; sem credencial Linear ou Codex, seus jobs permanecem registrados para configuração/retry posterior.

Comandos de verificação local:

```sh
npm run typecheck
npm test
npm run build
```

Os testes locais cobrem cálculo de debounce, limite do lote, backoff, normalização de eventos Evolution/WAHA, mensagens próprias e de grupos, áudio, HMAC, criação/edição e reconciliação de issue via Linear mockado, além da execução read-only do job Codex contra um CLI de teste e rejeição de symlink para fora do repositório.

### Validar o fluxo local com PostgreSQL

Os testes de fluxo usam um PostgreSQL local real e mockam a entrada WhatsApp e o endpoint GraphQL do Linear. O fluxo padrão usa respostas OpenAI controladas para validar criação/edição do card, webhook duplicado, mensagem própria durante uma análise em andamento e recuperação de lote após reinício. Os testes adicionais cobrem debounce, duplicatas que não prolongam o lote, isolamento entre conversas, mensagens fora de ordem, limite máximo de espera, abertura do próximo lote ao atingir a capacidade e preservação de áudio após falha de transcrição.

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

O Codex CLI autenticado pode executar as mesmas instruções e schema JSON do interpretador do app sem uma chave OpenAI API. A avaliação injeta mensagens sintéticas pelo webhook, usa o PostgreSQL local, deixa o worker real processar os lotes e mocka somente o Linear. A primeira resposta Luna é segurada brevemente para enviar um refinamento durante o processamento; a saída registrada permite revisar como o modelo agrupou, criou e atualizou a demanda. Depois avalia dois assuntos no mesmo lote, uma mensagem vaga e um cancelamento explícito. Também cria um repositório Git sintético, roda a análise técnica pelo Codex CLI em sandbox `read-only` e confirma que a análise foi publicada no mesmo card sem alterar o repositório. As chamadas de interpretação usam `gpt-6-luna` confirmado no cabeçalho do Codex CLI.

```sh
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run eval:luna
```

Esse caminho valida decisões reais do Luna através do Codex CLI, o fluxo local de persistência/card e a análise técnica real do Codex. Ele não valida a autenticação nem a disponibilidade da chave da OpenAI API usada pela aplicação em produção; essa validação continua sendo feita pelo backend com `GET /v1/models/gpt-6-luna`. O relatório completo das interpretações sintéticas e o tamanho das análises saem no terminal; a avaliação retorna código diferente de zero se o modelo não criar/refinar a mesma demanda, se o Codex exceder o limite de tamanho ou se falhar nos casos de ambiguidade, múltiplos assuntos, cancelamento e análise somente de leitura.

## Banco PostgreSQL

No deploy, conecte ao PostgreSQL já disponível no host e crie uma role e um banco exclusivos para a aplicação, com senha própria. Por exemplo, em uma sessão administrativa do `psql`:

```sql
CREATE ROLE whatsapp_observer LOGIN PASSWORD 'substitua-por-uma-senha-forte';
CREATE DATABASE whatsapp_observer OWNER whatsapp_observer;
```

Não rode o SQL se a role ou banco já existirem; confira o estado primeiro. Configure `DATABASE_URL` com o endereço local e a porta corretos do serviço PostgreSQL existente. Não altere os mapeamentos de porta de outros projetos.

## Configuração de integrações

### WhatsApp

Cadastre explicitamente cada conversa autorizada no painel `/admin`, escolhendo o provedor, nome da instância/sessão, JID do contato ou grupo e um ou mais projetos. Eventos de conversas ainda não cadastradas são descartados. O webhook só persiste a mensagem e agenda o lote; não chama IA nem Codex durante a requisição.

- Evolution: configure `EVOLUTION_WEBHOOK_TOKEN` e envie os eventos `MESSAGES_UPSERT` e `SEND_MESSAGE` para `/webhooks/evolution/<token>`. Para mídia, configure a integração para incluir base64 (`webhookBase64`) ou forneça `EVOLUTION_API_URL` e chave de API compatíveis com um endpoint `/api/files/...`.
- WAHA: configure `WAHA_HMAC_KEY` igual ao segredo de assinatura do webhook e aponte `message` e `message.any` a `/webhooks/waha`. Para baixar áudio sem base64, configure `WAHA_API_URL` como URL acessível a partir do processo Node e, se necessário, `WAHA_API_KEY`.

Configure a URL da API do provedor de WhatsApp para que o processo Node consiga acessá-la. Se estiver em Docker, use um endereço de rede alcançável pelo host ou receba o webhook pelo Nginx HTTPS. O áudio sem base64 fica preservado como transcrição pendente/falha e o lote não é apagado.

### OpenAI

O padrão é exatamente `gpt-6-luna`. No boot o serviço chama `GET /v1/models/gpt-6-luna` com a chave configurada; os lotes só são interpretados se essa chave puder acessar o modelo. Se o modelo não existir ou não estiver permitido para a conta, o sistema mantém os lotes pendentes e mostra o estado no painel. Não há fallback silencioso.

O modelo de transcrição é configurável em `OPENAI_TRANSCRIBE_MODEL`, inicialmente `whisper-1`. Interpretação estruturada usa Responses API com schema JSON estrito, contexto recente e demandas abertas do projeto.

### Linear

Configure `LINEAR_API_KEY`. Para cada projeto, preencha `linear_team_id` e, quando desejado, `linear_project_id`. A issue inclui um marcador interno determinístico usado na reconciliação após timeout; atualizações e retries mantêm o mesmo vínculo.

Os cards usam um modelo editorial curto: objetivo/escopo, requisitos, critérios de aceite, dúvidas pendentes e contexto/decisões. Seções opcionais sem conteúdo são omitidas. O tipo é exibido em português e a análise Codex entra em uma seção separada. O agente tem alvos flexíveis: título normalmente com 5–12 palavras; resumo em 2–3 frases; 2–5 requisitos e 2–4 critérios verificáveis; até 3 dúvidas que possam alterar o escopo. Pedidos simples podem usar menos itens. O sistema valida limites para evitar respostas excessivas: título até 140 caracteres, resumo até 1.800, no máximo 8 requisitos, 6 critérios e 4 dúvidas. O Codex é orientado a escrever normalmente 100–160 palavras, chegando a cerca de 200 em análises realmente complexas, com até 3 caminhos, 3 passos de implementação e 2–3 verificações sugeridas.

### Codex CLI

Instale e autentique o Codex CLI para o mesmo usuário que executa a aplicação no PM2. Se o binário não estiver no `PATH` desse usuário, defina `CODEX_CLI` com seu caminho completo. O worker cria um snapshot do commit configurado via `git archive` e executa `codex exec` em modo não interativo, com sandbox read-only, saída temporária e timeout. O CLI recebe o snapshot, não o repositório gravável; não executa comandos originados de conversas. `REPOSITORY_ROOTS` é obrigatório para cadastrar repositórios.

## Debounce, sequência e recuperação

Padrões iniciais configuráveis no `.env`:

- Silêncio: `BATCH_IDLE_MS=90000`.
- Espera máxima desde a primeira mensagem: `BATCH_MAX_WAIT_MS=300000`.
- Limite: `BATCH_MAX_MESSAGES=30`.
- Concorrência entre conversas: `MAX_PARALLEL_BATCHES=2`.

O lote pendente, suas mensagens, datas, estado, tentativas, erros e agendamento ficam no PostgreSQL. Cada conversa tem apenas um lote em execução. Uma nova mensagem durante a análise fica no próximo lote; processos podem executar em paralelo para conversas diferentes. Lotes falhos bloqueiam os posteriores da mesma conversa até retry, para preservar a sequência contextual.

`MESSAGE_RETENTION_DAYS` controla o conteúdo bruto. Mensagens antigas sem vínculo a demandas são excluídas; mensagens citadas por demandas mantêm seus IDs de evidência, mas texto, transcrição, mídia e dados do remetente são apagados. Demandas consolidadas, resumos e issues do Linear permanecem para acompanhar o trabalho.

## Deploy manual na VPS

O usuário faz o deploy. Esta implementação não copia arquivos nem altera serviços remotos.

1. Copie o projeto para um diretório dedicado, por exemplo `/home/ubuntu/whatsapp-ai-project-observer`; não coloque `.env` no Git.
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
    client_max_body_size 40m;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:3105;
}

location / {
    client_max_body_size 40m;
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

- O acesso de conta a `gpt-6-luna`, Linear, chaves do WhatsApp e Codex CLI só pode ser validado com as credenciais reais do deploy. A aplicação executa o check exato do modelo.
- Configure o provedor WhatsApp e os eventos que sua instalação envia; Evolution e WAHA têm parsers próprios.
- O download de áudio de uma URL do provedor só aceita o caminho `/api/files/...` e exige que o processo alcance a API configurada.
- Não há testes end-to-end com banco remoto ou APIs externas nesta primeira versão local.
