import { Pool } from 'pg';

export interface DbConfig {
  host:     string;
  port:     number;
  database: string;
  user:     string;
  password: string;
  ssl:      boolean;
}

export interface ContactRow {
  phone:              string;
  name?:              string;
  email?:             string;
  channel?:           string;
  action_key_count?:  number;
  action_key_last_at?: string;
  [key: string]: any;
}

export interface ColumnMapping {
  phone:               string;
  name?:               string;
  email?:              string;
  channel?:            string;
  action_key_count?:   string;   // cantidad de acciones clave (compras, pedidos…)
  action_key_last_at?: string;   // fecha última acción clave
  registered_at?:      string;   // fecha de registro en el sistema del cliente
  segment_name?:       string;   // segmento (ej: VIP, regular)
  classification?:     string;   // clasificación libre del cliente
  ltv?:                string;   // valor total del cliente (lifetime value)
  extra_fields?:       string[]; // columnas adicionales que pasan a custom_fields
}

let _pool: Pool | null = null;

export function createPool(cfg: DbConfig): Pool {
  _pool = new Pool({
    host:     cfg.host,
    port:     cfg.port,
    database: cfg.database,
    user:     cfg.user,
    password: cfg.password,
    ssl:      cfg.ssl ? { rejectUnauthorized: false } : false,
    max:      3,
    idleTimeoutMillis: 30000,
  });
  return _pool;
}

export async function testConnection(cfg: DbConfig): Promise<{ ok: boolean; tables?: string[]; error?: string }> {
  const pool = createPool(cfg);
  try {
    await pool.query('SELECT 1');
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
    );
    return { ok: true, tables: rows.map((r: any) => r.table_name) };
  } catch (e: any) {
    return { ok: false, error: e.message };
  } finally {
    await pool.end();
  }
}

export async function getColumns(cfg: DbConfig, table: string): Promise<string[]> {
  const pool = createPool(cfg);
  try {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [table]
    );
    return rows.map((r: any) => r.column_name);
  } finally {
    await pool.end();
  }
}

export async function fetchRows(
  pool: Pool,
  table: string,
  mapping: ColumnMapping,
  sinceColumn?: string,
  sinceValue?: string
): Promise<ContactRow[]> {
  const cols = Object.values(mapping).filter(Boolean).join(', ');
  let query  = `SELECT ${cols} FROM ${table}`;
  const params: any[] = [];

  if (sinceColumn && sinceValue) {
    query += ` WHERE ${sinceColumn} > $1`;
    params.push(sinceValue);
  }

  query += ' LIMIT 500';

  const { rows } = await pool.query(query, params);

  return rows.map((row: any) => {
    const get = (col?: string) => col ? row[col] : undefined;
    const out: ContactRow = { phone: String(row[mapping.phone] ?? '').trim() };

    if (get(mapping.name))               out.name               = String(get(mapping.name));
    if (get(mapping.email))              out.email              = String(get(mapping.email));
    if (get(mapping.channel))            out.channel            = String(get(mapping.channel));
    if (get(mapping.action_key_count))   out.action_key_count   = Number(get(mapping.action_key_count));
    if (get(mapping.action_key_last_at)) out.action_key_last_at = String(get(mapping.action_key_last_at));
    if (get(mapping.registered_at))      out.registered_at      = String(get(mapping.registered_at));
    if (get(mapping.segment_name))       out.segment_name       = String(get(mapping.segment_name));
    if (get(mapping.classification))     out.classification     = String(get(mapping.classification));
    if (get(mapping.ltv))                out.ltv                = Number(get(mapping.ltv));

    // Extra custom fields
    if (mapping.extra_fields?.length) {
      const custom: Record<string, any> = {};
      for (const col of mapping.extra_fields) {
        if (row[col] != null) custom[col] = row[col];
      }
      if (Object.keys(custom).length) out['custom_fields'] = custom;
    }

    return out;
  }).filter((r: ContactRow) => r.phone);
}
