import mysql from 'mysql2/promise';

export interface MySQLConfig {
  host:               string;
  port:               number;
  user:               string;
  password:           string;
  database:           string;
  query:              string;  // SQL que devuelve los contactos
  phone_column:       string;
  name_column?:       string;
  email_column?:      string;
  action_column?:     string;  // count de acciones clave
  action_date_column?: string; // fecha última acción
}

export interface SyncContact {
  phone:             string;
  name?:             string;
  email?:            string;
  action_key_count?: number;
  action_key_last_at?: string;
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
    // Preview query with LIMIT
    const limitedQuery = wrapLimit(cfg.query, limit);
    const [rows] = await conn.execute(limitedQuery) as [any[], any];

    // Estimate total (run COUNT wrapper)
    let total_estimated = 0;
    try {
      const [cRows] = await conn.execute(`SELECT COUNT(*) AS n FROM (${cfg.query}) __dc_count`) as [any[], any];
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
    const [rows] = await conn.execute(cfg.query) as [any[], any];
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

/** Wraps a query to add LIMIT without duplicating existing LIMIT */
function wrapLimit(query: string, limit: number): string {
  const q = query.trim().replace(/;$/, '');
  if (/\bLIMIT\s+\d+/i.test(q)) return q;
  return `${q} LIMIT ${limit}`;
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
