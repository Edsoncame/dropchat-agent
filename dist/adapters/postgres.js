"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPool = createPool;
exports.testConnection = testConnection;
exports.getColumns = getColumns;
exports.fetchRows = fetchRows;
const pg_1 = require("pg");
let _pool = null;
function createPool(cfg) {
    _pool = new pg_1.Pool({
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
        max: 3,
        idleTimeoutMillis: 30000,
    });
    return _pool;
}
async function testConnection(cfg) {
    const pool = createPool(cfg);
    try {
        await pool.query('SELECT 1');
        const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
        return { ok: true, tables: rows.map((r) => r.table_name) };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
    finally {
        await pool.end();
    }
}
async function getColumns(cfg, table) {
    const pool = createPool(cfg);
    try {
        const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
        return rows.map((r) => r.column_name);
    }
    finally {
        await pool.end();
    }
}
async function fetchRows(pool, table, mapping, sinceColumn, sinceValue) {
    const cols = Object.values(mapping).filter(Boolean).join(', ');
    let query = `SELECT ${cols} FROM ${table}`;
    const params = [];
    if (sinceColumn && sinceValue) {
        query += ` WHERE ${sinceColumn} > $1`;
        params.push(sinceValue);
    }
    query += ' LIMIT 500';
    const { rows } = await pool.query(query, params);
    return rows.map((row) => {
        const get = (col) => col ? row[col] : undefined;
        const out = { phone: String(row[mapping.phone] ?? '').trim() };
        if (get(mapping.name))
            out.name = String(get(mapping.name));
        if (get(mapping.email))
            out.email = String(get(mapping.email));
        if (get(mapping.channel))
            out.channel = String(get(mapping.channel));
        if (get(mapping.action_key_count))
            out.action_key_count = Number(get(mapping.action_key_count));
        if (get(mapping.action_key_last_at))
            out.action_key_last_at = String(get(mapping.action_key_last_at));
        if (get(mapping.registered_at))
            out.registered_at = String(get(mapping.registered_at));
        if (get(mapping.segment_name))
            out.segment_name = String(get(mapping.segment_name));
        if (get(mapping.classification))
            out.classification = String(get(mapping.classification));
        if (get(mapping.ltv))
            out.ltv = Number(get(mapping.ltv));
        // Extra custom fields
        if (mapping.extra_fields?.length) {
            const custom = {};
            for (const col of mapping.extra_fields) {
                if (row[col] != null)
                    custom[col] = row[col];
            }
            if (Object.keys(custom).length)
                out['custom_fields'] = custom;
        }
        return out;
    }).filter((r) => r.phone);
}
