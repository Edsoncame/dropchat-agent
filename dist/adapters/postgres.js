"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateIdentifier = validateIdentifier;
exports.quoteIdent = quoteIdent;
exports.createPool = createPool;
exports.testConnection = testConnection;
exports.getColumns = getColumns;
exports.fetchRows = fetchRows;
const pg_1 = require("pg");
/**
 * Valida que un nombre de tabla/columna sea un identificador SQL "safe":
 * - solo letras (a-z A-Z), números, guion bajo
 * - no empieza con número
 * - máximo 63 caracteres (límite NAMEDATALEN de Postgres)
 *
 * Lanza Error si no es válido. NO devuelve el identificador entrecomillado;
 * solo lo valida. El llamador debe usar `quoteIdent()` para envolverlo.
 */
function validateIdentifier(name, label = 'identifier') {
    if (!name || typeof name !== 'string') {
        throw new Error(`${label} requerido`);
    }
    // Permitimos opcional schema.table → validar cada parte
    const parts = name.split('.');
    if (parts.length > 2) {
        throw new Error(`${label} inválido: demasiados puntos en "${name}"`);
    }
    for (const part of parts) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(part)) {
            throw new Error(`${label} inválido: "${part}". Solo letras, números y guiones bajos. Sin espacios ni caracteres especiales.`);
        }
    }
    return name;
}
/**
 * Envuelve un identificador en comillas dobles, escapando cualquier comilla
 * doble interna (Postgres y MySQL ANSI mode aceptan esto).
 * Combinado con validateIdentifier() previene SQL injection en nombres.
 */
function quoteIdent(name) {
    validateIdentifier(name, 'identifier');
    // Soportar schema.table → "schema"."table"
    return name.split('.').map(p => `"${p.replace(/"/g, '""')}"`).join('.');
}
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
    validateIdentifier(table, 'tabla');
    const pool = createPool(cfg);
    try {
        // information_schema acepta el nombre como string parametrizado (no es un identifier
        // dentro de FROM, así que es safe usar $1 acá).
        const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
        return rows.map((r) => r.column_name);
    }
    finally {
        await pool.end();
    }
}
async function fetchRows(pool, table, mapping, sinceColumn, sinceValue) {
    // Anti-SQLi: validar TODOS los identificadores antes de interpolar.
    validateIdentifier(table, 'tabla');
    const colValues = Object.values(mapping)
        .filter((v) => typeof v === 'string' && v.length > 0);
    for (const c of colValues)
        validateIdentifier(c, 'columna');
    if (sinceColumn)
        validateIdentifier(sinceColumn, 'sinceColumn');
    // Quoting con comillas dobles para los identificadores.
    const quotedCols = colValues.map(quoteIdent).join(', ');
    const quotedTable = quoteIdent(table);
    let query = `SELECT ${quotedCols} FROM ${quotedTable}`;
    const params = [];
    if (sinceColumn && sinceValue) {
        query += ` WHERE ${quoteIdent(sinceColumn)} > $1`;
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
