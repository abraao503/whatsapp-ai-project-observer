import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { config } from '../config.js';
import { schemaSql } from './schema.js';

types.setTypeParser(20, (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('ID PostgreSQL fora do intervalo inteiro seguro');
  return parsed;
});

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Math.max(4, config.maxParallelBatches * 3 + 3),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true
});

export async function initializeDatabase(): Promise<void> {
  await pool.query(schemaSql);
  await pool.query(`
    UPDATE batches
    SET status = 'pending', process_after = now(), processing_started_at = NULL,
        last_error = COALESCE(last_error, 'Processamento retomado após reinício do serviço')
    WHERE status = 'processing'
  `);
  await pool.query('UPDATE conversations SET processing_batch_id = NULL');
  await pool.query(`
    UPDATE demands SET linear_sync_status = 'pending', linear_sync_started_at = NULL,
      linear_next_attempt_at = now()
    WHERE linear_sync_status = 'syncing'
  `);
  await pool.query(`
    UPDATE codex_jobs SET status = 'pending', started_at = NULL,
      last_error = COALESCE(last_error, 'Análise retomada após reinício do serviço')
    WHERE status = 'processing'
  `);
}

export async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 800);
}

export async function recordError(
  subsystem: string,
  error: unknown,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const message = safeErrorMessage(error);
  console.error(`[${subsystem}] ${message}`);
  try {
    await pool.query(
      'INSERT INTO app_errors(subsystem, message, metadata) VALUES ($1, $2, $3::jsonb)',
      [subsystem, message, JSON.stringify(metadata)]
    );
    await pool.query(`
      DELETE FROM app_errors WHERE id IN (
        SELECT id FROM app_errors ORDER BY created_at DESC OFFSET 1000
      )
    `);
  } catch (dbError) {
    console.error(`[db:error-log] ${safeErrorMessage(dbError)}`);
  }
}

export async function one<T extends QueryResultRow>(
  sql: string,
  values: unknown[] = []
): Promise<T | undefined> {
  const result = await pool.query<T>(sql, values);
  return result.rows[0];
}
