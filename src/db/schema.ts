export const schemaSql = `
CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  repository_path TEXT NOT NULL,
  reference_branch TEXT NOT NULL DEFAULT 'main',
  linear_team_id TEXT NOT NULL DEFAULT '',
  linear_project_id TEXT NOT NULL DEFAULT '',
  analysis_instructions TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  instance TEXT NOT NULL,
  remote_jid TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  monitored BOOLEAN NOT NULL DEFAULT TRUE,
  memory_summary TEXT NOT NULL DEFAULT '',
  decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  processing_batch_id BIGINT,
  last_webhook_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, instance, remote_jid)
);

CREATE TABLE IF NOT EXISTS project_conversations (
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_message_id TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sender_jid TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  from_me BOOLEAN NOT NULL DEFAULT FALSE,
  kind TEXT NOT NULL DEFAULT 'other',
  text TEXT NOT NULL DEFAULT '',
  media JSONB NOT NULL DEFAULT '{}'::jsonb,
  audio_base64 TEXT,
  video_base64 TEXT,
  transcript TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'not_required',
  transcript_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, external_message_id)
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS video_base64 TEXT;

CREATE TABLE IF NOT EXISTS batches (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  first_received_at TIMESTAMPTZ NOT NULL,
  last_received_at TIMESTAMPTZ NOT NULL,
  process_after TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  processing_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batch_messages (
  batch_id BIGINT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, message_id)
);

CREATE TABLE IF NOT EXISTS demands (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  demand_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_context',
  requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  open_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  conversation_context TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  linear_issue_id TEXT,
  linear_issue_identifier TEXT,
  linear_issue_url TEXT,
  linear_sync_status TEXT NOT NULL DEFAULT 'not_ready',
  linear_sync_revision INTEGER NOT NULL DEFAULT 0,
  linear_synced_revision INTEGER NOT NULL DEFAULT 0,
  linear_sync_attempts INTEGER NOT NULL DEFAULT 0,
  linear_sync_started_at TIMESTAMPTZ,
  linear_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  linear_error TEXT,
  technical_analysis TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS demand_messages (
  demand_id BIGINT NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (demand_id, message_id)
);

CREATE TABLE IF NOT EXISTS codex_jobs (
  id BIGSERIAL PRIMARY KEY,
  demand_id BIGINT NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  demand_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  repository_commit TEXT,
  result TEXT,
  last_error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (demand_id, demand_version)
);

CREATE TABLE IF NOT EXISTS app_errors (
  id BIGSERIAL PRIMARY KEY,
  subsystem TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS batches_ready_idx ON batches(status, process_after, id);
CREATE INDEX IF NOT EXISTS batches_conversation_idx ON batches(conversation_id, id, status);
CREATE INDEX IF NOT EXISTS messages_conversation_time_idx ON messages(conversation_id, sent_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS demands_project_status_idx ON demands(project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS demands_linear_sync_idx ON demands(linear_sync_status, updated_at);
CREATE INDEX IF NOT EXISTS codex_jobs_ready_idx ON codex_jobs(status, next_attempt_at, created_at, id);
CREATE INDEX IF NOT EXISTS app_errors_recent_idx ON app_errors(created_at DESC);
`;
