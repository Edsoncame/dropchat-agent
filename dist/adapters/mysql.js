"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testMySQLConnection = testMySQLConnection;
exports.previewMySQLQuery = previewMySQLQuery;
exports.fetchMySQLContacts = fetchMySQLContacts;
const promise_1 = __importDefault(require("mysql2/promise"));
const postgres_1 = require("./postgres");
/** Quoting de identificadores para MySQL: usa backticks y escapa los internos. */
function quoteMyIdent(name) {
    (0, postgres_1.validateIdentifier)(name, 'identifier');
    return name.split('.').map(p => '`' + p.replace(/`/g, '``') + '`').join('.');
}
/** Construye un SELECT seguro a partir de tabla + columnas validadas. */
function buildSafeSelect(cfg, limit) {
    (0, postgres_1.validateIdentifier)(cfg.table, 'tabla');
    (0, postgres_1.validateIdentifier)(cfg.phone_column, 'phone_column');
    const cols = [quoteMyIdent(cfg.phone_column)];
    if (cfg.name_column) {
        (0, postgres_1.validateIdentifier)(cfg.name_column, 'name_column');
        cols.push(quoteMyIdent(cfg.name_column));
    }
    if (cfg.email_column) {
        (0, postgres_1.validateIdentifier)(cfg.email_column, 'email_column');
        cols.push(quoteMyIdent(cfg.email_column));
    }
    if (cfg.action_column) {
        (0, postgres_1.validateIdentifier)(cfg.action_column, 'action_column');
        cols.push(quoteMyIdent(cfg.action_column));
    }
    if (cfg.action_date_column) {
        (0, postgres_1.validateIdentifier)(cfg.action_date_column, 'action_date_column');
        cols.push(quoteMyIdent(cfg.action_date_column));
    }
    let sql = `SELECT ${cols.join(', ')} FROM ${quoteMyIdent(cfg.table)}`;
    if (limit && Number.isInteger(limit) && limit > 0 && limit <= 10000) {
        sql += ` LIMIT ${limit}`;
    }
    else {
        sql += ` LIMIT 500`;
    }
    return sql;
}
async function testMySQLConnection(cfg) {
    let conn;
    const t0 = Date.now();
    try {
        conn = await promise_1.default.createConnection({
            host: cfg.host,
            port: cfg.port,
            user: cfg.user,
            password: cfg.password,
            database: cfg.database,
            connectTimeout: 10000,
        });
        await conn.execute('SELECT 1');
        return { ok: true, latency_ms: Date.now() - t0 };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
    finally {
        conn?.end();
    }
}
async function previewMySQLQuery(cfg, limit = 5) {
    const conn = await promise_1.default.createConnection({
        host: cfg.host, port: cfg.port,
        user: cfg.user, password: cfg.password, database: cfg.database,
    });
    try {
        const sql = buildSafeSelect(cfg, limit);
        const [rows] = await conn.execute(sql);
        // Estimate total con COUNT sobre la tabla validada
        let total_estimated = 0;
        try {
            const countSql = `SELECT COUNT(*) AS n FROM ${quoteMyIdent(cfg.table)}`;
            const [cRows] = await conn.execute(countSql);
            total_estimated = Number(cRows[0]?.n ?? 0);
        }
        catch { /* count failed, not critical */ }
        return { rows: rows.map(r => mapRow(r, cfg)), total_estimated };
    }
    finally {
        conn.end();
    }
}
async function fetchMySQLContacts(cfg) {
    const conn = await promise_1.default.createConnection({
        host: cfg.host, port: cfg.port,
        user: cfg.user, password: cfg.password, database: cfg.database,
    });
    try {
        const sql = buildSafeSelect(cfg);
        const [rows] = await conn.execute(sql);
        return rows.map(r => mapRow(r, cfg)).filter(c => c.phone);
    }
    finally {
        conn.end();
    }
}
function mapRow(row, cfg) {
    const out = { phone: formatPhone(row[cfg.phone_column]) };
    if (cfg.name_column && row[cfg.name_column] != null)
        out.name = String(row[cfg.name_column]);
    if (cfg.email_column && row[cfg.email_column] != null)
        out.email = String(row[cfg.email_column]);
    if (cfg.action_column && row[cfg.action_column] != null)
        out.action_key_count = Number(row[cfg.action_column]);
    if (cfg.action_date_column && row[cfg.action_date_column] != null)
        out.action_key_last_at = String(row[cfg.action_date_column]);
    return out;
}
function formatPhone(raw) {
    if (!raw)
        return '';
    const digits = String(raw).replace(/\D/g, '');
    if (!digits)
        return '';
    // Already has country code (10+ digits starting with known prefix)
    if (digits.length >= 10)
        return `+${digits}`;
    // Short local number — prepend +51 (Perú) as default
    return `+51${digits}`;
}
