import mysql from 'mysql2/promise';
import { validateIdentifier } from './postgres';

/**
 * Config para MySQL. **NO permitimos query SQL arbitraria** — solo
 * tabla + columnas mapeadas. Esto previene SQL injection y mantiene
 * paridad de seguridad con el adapter de Postgres.
 */
export interface MySQLConfig {
  host:               string;
  port:               number;
  user:               string;
  password:           string;
  database:           string;
  table:              string;     // tabla destino
  phone_column:       string;
  name_column?:       string;
  email_column?:      string;
  action_column?:     string;     // count de acciones clave
  action_date_column?: string;    // fecha última acción
  /** @deprecated SQL libre — solo aceptado si se ejecuta vía un script
   *  controlado por el operador local del agente, NUNCA desde requests del UI. */
  query?:             string;
}

export interface SyncContact {
  phone:             string;
  name?:             string;
  email?:            string;
  action_key_count?: number;
  action_key_last_at?: string;
}

/** Quoting de identificadores para MySQL: usa backticks y escapa los internos. */
function quoteMyIdent(name: string): string {
  validateIdentifier(name, 'identifier');
  return name.split('.').map(p => '`' + p.replace(/`/g, '``') + '`').join('.');
}

/** Construye un SELECT seguro a partir de tabla + columnas validadas. */
function buildSafeSelect(cfg: MySQLConfig, limit?: number): string {
  validateIdentifier(cfg.table, 'tabla');
  validateIdentifier(cfg.phone_column, 'phone_column');

  const cols: string[] = [quoteMyIdent(cfg.phone_column)];
  if (cfg.name_column)         { validateIdentifier(cfg.name_column,         'name_column');         cols.push(quoteMyIdent(cfg.name_column)); }
  if (cfg.email_column)        { validateIdentifier(cfg.email_column,        'email_column');        cols.push(quoteMyIdent(cfg.email_column)); }
  if (cfg.action_column)       { validateIdentifier(cfg.action_column,       'action_column');       cols.push(quoteMyIdent(cfg.action_column)); }
  if (cfg.action_date_column)  { validateIdentifier(cfg.action_date_column,  'action_date_column');  cols.push(quoteMyIdent(cfg.action_date_column)); }

  let sql = `SELECT ${cols.join(', ')} FROM ${quoteMyIdent(cfg.table)}`;
  if (limit && Number.isInteger(limit) && limit > 0 && limit <= 10000) {
    sql += ` LIMIT ${limit}`;
  } else {
    sql += ` LIMIT 500`;
  }
  return sql;
}

export async function testMySQLConnection(cfg: MySQLConfig): Promise<{ ok: boolean; error?: string; latency_ms?: number }> {
  let conn: mysql.Connection | undefined;
  const t0 = Date.now();
  try {
    conn = await mysql.createConnection({
      host:           cfg.host,
      port:           cfg.port,
      user:           cfg.user,
      password:       cfg.password,
      database:       cfg.database,
      connectTimeout: 10_000,
    });
    await conn.execute('SELECT 1');
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, error: e.message };
  } finally {
    conn?.end();
  }
}

export async function previewMySQLQuery(cfg: MySQLConfig, limit = 5): Promise<{ rows: SyncContact[]; total_estimated: number }> {
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port,
    user: cfg.user, password: cfg.password, database: cfg.database,
  });
  try {
    const sql = buildSafeSelect(cfg, limit);
    const [rows] = await conn.execute(sql) as [any[], any];

    // Estimate total con COUNT sobre la tabla validada
    let total_estimated = 0;
    try {
      const countSql = `SELECT COUNT(*) AS n FROM ${quoteMyIdent(cfg.table)}`;
      const [cRows] = await conn.execute(countSql) as [any[], any];
      total_estimated = Number(cRows[0]?.n ?? 0);
    } catch { /* count failed, not critical */ }

    return { rows: rows.map(r => mapRow(r, cfg)), total_estimated };
  } finally {
    conn.end();
  }
}

export async function fetchMySQLContacts(cfg: MySQLConfig): Promise<SyncContact[]> {
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port,
    user: cfg.user, password: cfg.password, database: cfg.database,
  });
  try {
    const sql = buildSafeSelect(cfg);
    const [rows] = await conn.execute(sql) as [any[], any];
    return (rows as any[]).map(r => mapRow(r, cfg)).filter(c => c.phone);
  } finally {
    conn.end();
  }
}

function mapRow(row: any, cfg: MySQLConfig): SyncContact {
  const out: SyncContact = { phone: formatPhone(row[cfg.phone_column]) };
  if (cfg.name_column  && row[cfg.name_column]  != null) out.name  = String(row[cfg.name_column]);
  if (cfg.email_column && row[cfg.email_column] != null) out.email = String(row[cfg.email_column]);
  if (cfg.action_column && row[cfg.action_column] != null)
    out.action_key_count = Number(row[cfg.action_column]);
  if (cfg.action_date_column && row[cfg.action_date_column] != null)
    out.action_key_last_at = String(row[cfg.action_date_column]);
  return out;
}

function formatPhone(raw: any): string {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  // Already has country code (10+ digits starting with known prefix)
  if (digits.length >= 10) return `+${digits}`;
  // Short local number — prepend +51 (Perú) as default
  return `+51${digits}`;
}
