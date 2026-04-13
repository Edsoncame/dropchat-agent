"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testMySQLConnection = testMySQLConnection;
exports.previewMySQLQuery = previewMySQLQuery;
exports.fetchMySQLContacts = fetchMySQLContacts;
const promise_1 = __importDefault(require("mysql2/promise"));
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
        // Preview query with LIMIT
        const limitedQuery = wrapLimit(cfg.query, limit);
        const [rows] = await conn.execute(limitedQuery);
        // Estimate total (run COUNT wrapper)
        let total_estimated = 0;
        try {
            const [cRows] = await conn.execute(`SELECT COUNT(*) AS n FROM (${cfg.query}) __dc_count`);
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
        const [rows] = await conn.execute(cfg.query);
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
/** Wraps a query to add LIMIT without duplicating existing LIMIT */
function wrapLimit(query, limit) {
    const q = query.trim().replace(/;$/, '');
    if (/\bLIMIT\s+\d+/i.test(q))
        return q;
    return `${q} LIMIT ${limit}`;
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
