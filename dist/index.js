#!/usr/bin/env node
"use strict";
/**
 * Drop Chat Sync Agent
 *
 * Corre un servidor local en http://localhost:3001
 * El usuario configura la conexión a su BD desde el navegador.
 * Las credenciales de BD nunca salen de esta máquina.
 * Solo se envían los campos de contacto a la API de Drop Chat.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const axios_1 = __importDefault(require("axios"));
const child_process_1 = require("child_process");
const readline_1 = __importDefault(require("readline"));
const postgres_1 = require("./adapters/postgres");
const mysql_1 = require("./adapters/mysql");
// ── CLI: `dropchat-agent setup` ──────────────────────────────
if (process.argv[2] === 'setup') {
    runSetup().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
else {
    startServer();
}
async function ask(rl, question, defaultVal) {
    return new Promise(r => {
        const q = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
        rl.question(q, ans => r(ans.trim() || defaultVal || ''));
    });
}
async function runSetup() {
    const args = process.argv.slice(3);
    const flags = {};
    for (let i = 0; i < args.length; i += 2) {
        if (args[i].startsWith('--'))
            flags[args[i].slice(2)] = args[i + 1] ?? '';
    }
    const dbType = flags['db-type'] ?? '';
    const table = flags['table'] ?? '';
    const phone = flags['phone'] ?? '';
    const name = flags['name'] ?? '';
    const email = flags['email'] ?? '';
    const apiKey = flags['api-key'] ?? '';
    const tenantId = flags['tenant-id'] ?? '';
    console.log('\n  ╔══════════════════════════════════════╗');
    console.log('  ║   Drop Chat Sync Agent — Setup       ║');
    console.log('  ╚══════════════════════════════════════╝\n');
    console.log(`  BD: ${dbType || 'no especificada'} | Tabla: ${table || 'no especificada'}`);
    console.log(`  Mapeo: phone=${phone}, name=${name}, email=${email}\n`);
    const rl = readline_1.default.createInterface({ input: process.stdin, output: process.stdout });
    console.log('  ⚠  Las credenciales que ingreses a continuación NUNCA salen');
    console.log('     de esta máquina. Se guardan solo en un archivo local.\n');
    const host = await ask(rl, '  Host de la base de datos', 'localhost');
    const port = await ask(rl, '  Puerto', dbType === 'mysql' ? '3306' : '5432');
    const database = await ask(rl, '  Nombre de la base de datos');
    const user = await ask(rl, '  Usuario');
    const password = await ask(rl, '  Contraseña');
    const useSsl = await ask(rl, '  Usar SSL? (s/n)', 'n');
    rl.close();
    // Test connection
    console.log('\n  ⏳ Probando conexión...');
    const dbConfig = {
        host, port: parseInt(port), database, user, password, ssl: useSsl === 's',
    };
    if (dbType === 'mysql') {
        const result = await (0, mysql_1.testMySQLConnection)({ host, port: parseInt(port), database, user, password });
        if (!result.ok) {
            console.error(`  ❌ No se pudo conectar: ${result.error}`);
            return;
        }
    }
    else {
        const result = await (0, postgres_1.testConnection)(dbConfig);
        if (!result.ok) {
            console.error(`  ❌ No se pudo conectar: ${result.error}`);
            return;
        }
    }
    console.log('  ✅ Conexión exitosa!\n');
    // Preview
    console.log('  ⏳ Obteniendo preview...');
    try {
        const p = (0, postgres_1.createPool)(dbConfig);
        const mapping = { phone };
        if (name)
            mapping.name = name;
        if (email)
            mapping.email = email;
        const allRows = await (0, postgres_1.fetchRows)(p, table, mapping);
        const rows = allRows.slice(0, 3);
        console.log(`  📋 Preview (${rows.length} filas):`);
        rows.forEach((r, i) => console.log(`     ${i + 1}. ${r.name ?? '—'} | ${r.phone} | ${r.email ?? '—'}`));
        await p.end();
    }
    catch (e) {
        console.log(`  ⚠  No se pudo obtener preview: ${e.message}`);
    }
    // Save config
    const configData = {
        db: dbConfig,
        db_type: dbType || 'postgres',
        table,
        mapping: { phone, ...(name ? { name } : {}), ...(email ? { email } : {}) },
        api_key: apiKey,
        api_url: 'https://omni-platform-api-production.up.railway.app/api/v1',
        interval: 15,
        running: true,
        tenant_id: tenantId,
    };
    const configPath = path_1.default.join(process.cwd(), 'dropchat-agent-config.json');
    fs_1.default.writeFileSync(configPath, JSON.stringify(configData, null, 2));
    console.log(`\n  💾 Configuración guardada en: ${configPath}`);
    console.log('\n  🚀 Para iniciar el agente ejecuta:');
    console.log('     npx dropchat-agent\n');
    console.log('  El agente sincronizará tus contactos cada 15 minutos.');
    console.log('  Puedes cambiar el intervalo en http://localhost:3001\n');
}
// ── Server mode (default) ────────────────────────────────────
function startServer() {
    const app = (0, express_1.default)();
    const PORT = 3001;
    app.use(express_1.default.json());
    app.use(express_1.default.static(path_1.default.join(__dirname, 'ui')));
    // ── In-memory config (persisted to config.json on disk) ───────
    const CONFIG_FILE = path_1.default.join(process.cwd(), 'dropchat-agent-config.json');
    let config = {};
    try {
        if (fs_1.default.existsSync(CONFIG_FILE))
            config = JSON.parse(fs_1.default.readFileSync(CONFIG_FILE, 'utf-8'));
    }
    catch { /* fresh start */ }
    function saveConfig() {
        fs_1.default.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    }
    // ── MySQL routes ──────────────────────────────────────────────
    app.post('/api/mysql/test', async (req, res) => {
        const t0 = Date.now();
        const result = await (0, mysql_1.testMySQLConnection)(req.body);
        res.json({ ...result, latency_ms: Date.now() - t0 });
    });
    app.post('/api/mysql/preview', async (req, res) => {
        try {
            const { limit = 5, ...cfg } = req.body;
            const result = await (0, mysql_1.previewMySQLQuery)(cfg, limit);
            res.json(result);
        }
        catch (e) {
            res.status(400).json({ error: e.message });
        }
    });
    app.post('/api/mysql/run', async (req, res) => {
        try {
            const cfg = req.body;
            if (!cfg.api_key) {
                res.status(400).json({ error: 'api_key requerido' });
                return;
            }
            const contacts = await (0, mysql_1.fetchMySQLContacts)(cfg);
            if (!contacts.length) {
                res.json({ created: 0, updated: 0, skipped: 0, total: 0, message: 'Sin contactos' });
                return;
            }
            const apiUrl = (cfg.api_url ?? 'https://omni-platform-api-production.up.railway.app/api/v1').replace(/\/$/, '');
            const resp = await axios_1.default.post(`${apiUrl}/sync/contacts`, { contacts }, { headers: { 'X-API-Key': cfg.api_key }, timeout: 60000 });
            res.json(resp.data);
        }
        catch (e) {
            res.status(500).json({ error: e?.response?.data?.message ?? e.message });
        }
    });
    // ── Sync state ────────────────────────────────────────────────
    let syncInterval = null;
    let lastSyncAt = null;
    let lastSyncResult = null;
    let syncRunning = false;
    let pool = null;
    // ── API Routes ────────────────────────────────────────────────
    // Get current config + status
    app.get('/api/status', (_req, res) => {
        res.json({
            configured: !!(config.db && config.table && config.mapping && config.api_key),
            running: config.running ?? false,
            db: config.db ? { ...config.db, password: '••••••••' } : null,
            table: config.table,
            mapping: config.mapping,
            api_url: config.api_url,
            interval: config.interval ?? 60,
            last_sync_at: lastSyncAt,
            last_result: lastSyncResult,
            sync_running: syncRunning,
        });
    });
    // Test DB connection
    app.post('/api/test-connection', async (req, res) => {
        const result = await (0, postgres_1.testConnection)(req.body);
        res.json(result);
    });
    // Get columns for a table
    app.post('/api/columns', async (req, res) => {
        try {
            const { db, table } = req.body;
            const cols = await (0, postgres_1.getColumns)(db, table);
            res.json({ columns: cols });
        }
        catch (e) {
            res.status(400).json({ error: e.message });
        }
    });
    // Save config
    app.post('/api/config', (req, res) => {
        config = { ...config, ...req.body };
        saveConfig();
        res.json({ ok: true });
    });
    // Manual sync
    app.post('/api/sync-now', async (req, res) => {
        if (syncRunning) {
            res.json({ error: 'Sync already running' });
            return;
        }
        const result = await runSync();
        res.json(result);
    });
    // Start / Stop
    app.post('/api/start', (_req, res) => {
        config.running = true;
        saveConfig();
        startScheduler();
        res.json({ ok: true });
    });
    app.post('/api/stop', (_req, res) => {
        config.running = false;
        saveConfig();
        stopScheduler();
        res.json({ ok: true });
    });
    // ── Sync engine ───────────────────────────────────────────────
    async function runSync() {
        if (!config.db || !config.table || !config.mapping || !config.api_key) {
            return { error: 'Configuración incompleta' };
        }
        syncRunning = true;
        try {
            if (!pool)
                pool = (0, postgres_1.createPool)(config.db);
            const rows = await (0, postgres_1.fetchRows)(pool, config.table, config.mapping);
            if (!rows.length) {
                lastSyncResult = { created: 0, updated: 0, skipped: 0, total: 0, message: 'Sin filas' };
                lastSyncAt = new Date().toISOString();
                return lastSyncResult;
            }
            const apiUrl = (config.api_url ?? 'https://omni-platform-api-production.up.railway.app/api/v1')
                .replace(/\/$/, '');
            const resp = await axios_1.default.post(`${apiUrl}/sync/contacts`, { contacts: rows }, { headers: { 'X-API-Key': config.api_key }, timeout: 30000 });
            lastSyncResult = resp.data;
            lastSyncAt = new Date().toISOString();
            console.log(`[Sync] ${new Date().toLocaleTimeString()} — +${resp.data.created} new, ~${resp.data.updated} updated`);
            return lastSyncResult;
        }
        catch (e) {
            const err = { error: e?.response?.data?.message ?? e.message };
            lastSyncResult = err;
            lastSyncAt = new Date().toISOString();
            console.error('[Sync] Error:', err.error);
            return err;
        }
        finally {
            syncRunning = false;
        }
    }
    function startScheduler() {
        stopScheduler();
        const minutes = config.interval ?? 60;
        console.log(`[Scheduler] Starting — every ${minutes} min`);
        runSync(); // run immediately on start
        syncInterval = setInterval(runSync, minutes * 60 * 1000);
    }
    function stopScheduler() {
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
        }
    }
    // ── Startup ───────────────────────────────────────────────────
    app.listen(PORT, () => {
        console.log(`\n  ✅ Drop Chat Sync Agent corriendo`);
        console.log(`  🌐 Abre http://localhost:${PORT} en tu navegador\n`);
        // Auto-open browser (cross-platform)
        const url = `http://localhost:${PORT}`;
        const cmd = process.platform === 'darwin' ? `open ${url}`
            : process.platform === 'win32' ? `start ${url}`
                : `xdg-open ${url}`;
        (0, child_process_1.exec)(cmd);
        // Resume sync if was running
        if (config.running && config.db && config.table && config.mapping && config.api_key) {
            console.log('[Scheduler] Resuming sync from saved config');
            startScheduler();
        }
        // Heartbeat — report status to Drop Chat every 5 min
        if (config.api_key) {
            const heartbeat = () => {
                const apiUrl = (config.api_url ?? 'https://omni-platform-api-production.up.railway.app/api/v1').replace(/\/$/, '');
                axios_1.default.post(`${apiUrl}/sync/heartbeat`, {
                    agent_version: '1.0.0',
                    last_sync_at: lastSyncAt,
                    status: config.running ? 'running' : 'stopped',
                }, { headers: { 'X-API-Key': config.api_key }, timeout: 10000 }).catch(() => { });
            };
            heartbeat();
            setInterval(heartbeat, 5 * 60 * 1000);
        }
    });
} // end startServer()
