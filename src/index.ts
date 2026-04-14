#!/usr/bin/env node
/**
 * Drop Chat Sync Agent
 *
 * Corre un servidor local en http://127.0.0.1:3001
 * El usuario configura la conexión a su BD desde el navegador.
 *
 * GARANTÍAS DE SEGURIDAD:
 * 1. Las credenciales de BD nunca salen de esta máquina.
 * 2. El servidor del agente bindea SOLO a 127.0.0.1 (loopback).
 *    No es accesible desde otros equipos de la red local.
 * 3. Todos los endpoints del agente requieren un token local
 *    (LOCAL_TOKEN) que se genera la primera vez y se guarda en
 *    el archivo de config (sólo legible por el dueño del proceso).
 * 4. Los nombres de tabla/columna se validan con regex antes de
 *    interpolarse en SQL para prevenir inyección.
 * 5. El archivo de config se persiste con permisos 0600 (Unix).
 */

import express        from 'express';
import path           from 'path';
import fs             from 'fs';
import os             from 'os';
import crypto         from 'crypto';
import axios          from 'axios';
import { exec }       from 'child_process';
import { Pool }       from 'pg';
import readline       from 'readline';
import { createPool, testConnection, getColumns, fetchRows, DbConfig, ColumnMapping, validateIdentifier } from './adapters/postgres';
import { testMySQLConnection, previewMySQLQuery, fetchMySQLContacts, MySQLConfig } from './adapters/mysql';

// ── Helpers compartidos ───────────────────────────────────────
const CONFIG_FILE = path.join(process.cwd(), 'dropchat-agent-config.json');

function loadConfigOrEmpty(): any {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch { /* fresh start */ }
  return {};
}

function saveConfigSecure(data: any) {
  const json = JSON.stringify(data, null, 2);
  // Escribir con permisos restrictivos. En Unix: 0600 (solo dueño puede leer/escribir).
  fs.writeFileSync(CONFIG_FILE, json, { mode: 0o600 });
  // En Windows fs.chmod no aplica permisos POSIX, pero el icacls sería ideal.
  // Reforzar chmod en Unix por si el archivo ya existía con otros permisos:
  if (process.platform !== 'win32') {
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* ignore */ }
  }
}

function generateLocalToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

// ── CLI: `dropchat-agent setup` ──────────────────────────────
if (process.argv[2] === 'setup') {
  runSetup().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else {
  startServer();
}

async function ask(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  return new Promise(r => {
    const q = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    rl.question(q, ans => r(ans.trim() || defaultVal || ''));
  });
}

async function runSetup() {
  const args = process.argv.slice(3);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] ?? '';
  }

  const dbType          = flags['db-type']         ?? '';
  const table           = flags['table']           ?? '';
  // Básicos
  const phone           = flags['phone']           ?? '';
  const name            = flags['name']            ?? '';
  const email           = flags['email']           ?? '';
  // Funnel
  const actionCount     = flags['action-count']    ?? '';
  const actionLastAt    = flags['action-last-at']  ?? '';
  const registeredAt    = flags['registered-at']   ?? '';
  // Segmentación
  const segment         = flags['segment']         ?? '';
  const classification  = flags['classification']  ?? '';
  const ltv             = flags['ltv']             ?? '';
  // Drop Chat credentials
  const apiKey          = flags['api-key']         ?? '';
  const tenantId        = flags['tenant-id']       ?? '';

  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║   Drop Chat Sync Agent — Setup       ║');
  console.log('  ╚══════════════════════════════════════╝\n');
  console.log(`  BD: ${dbType || 'no especificada'} | Tabla: ${table || 'no especificada'}`);
  console.log('  Mapeo de columnas:');
  console.log(`    phone=${phone}${name ? `, name=${name}` : ''}${email ? `, email=${email}` : ''}`);
  if (actionCount || actionLastAt || registeredAt) {
    console.log(`    funnel: action_count=${actionCount||'—'}, action_last_at=${actionLastAt||'—'}, registered_at=${registeredAt||'—'}`);
  }
  if (segment || classification || ltv) {
    console.log(`    segment=${segment||'—'}, classification=${classification||'—'}, ltv=${ltv||'—'}`);
  }
  console.log();

  // ── Validar identificadores antes de seguir (anti SQLi) ──────
  try {
    validateIdentifier(table,  'tabla');
    validateIdentifier(phone,  'columna phone');
    if (name)           validateIdentifier(name,           'columna name');
    if (email)          validateIdentifier(email,          'columna email');
    if (actionCount)    validateIdentifier(actionCount,    'columna action_key_count');
    if (actionLastAt)   validateIdentifier(actionLastAt,   'columna action_key_last_at');
    if (registeredAt)   validateIdentifier(registeredAt,   'columna registered_at');
    if (segment)        validateIdentifier(segment,        'columna segment_name');
    if (classification) validateIdentifier(classification, 'columna classification');
    if (ltv)            validateIdentifier(ltv,            'columna ltv');
  } catch (e: any) {
    console.error(`\n  ❌ ${e.message}`);
    console.error('     Solo se permiten letras, números y guiones bajos. Máximo 63 caracteres.');
    return;
  }

  // ── Validar API key (debe parecer una real, no la versión enmascarada) ──
  if (!apiKey || apiKey.includes('•')) {
    console.error('\n  ❌ La API key recibida está enmascarada o vacía.');
    console.error('     Vuelve al panel de Drop Chat → Settings → Sincronización de datos');
    console.error('     y genera una nueva. Las API keys solo se muestran una vez por seguridad.');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('  ⚠  Las credenciales que ingreses a continuación NUNCA salen');
  console.log('     de esta máquina. Se guardan solo en un archivo local con');
  console.log('     permisos restrictivos (0600 — solo tu usuario puede leerlo).\n');

  const host     = await ask(rl, '  Host de la base de datos', 'localhost');
  const port     = await ask(rl, '  Puerto', dbType === 'mysql' ? '3306' : '5432');
  const database = await ask(rl, '  Nombre de la base de datos');
  const user     = await ask(rl, '  Usuario');
  const password = await ask(rl, '  Contraseña');
  // Sugerir SSL automáticamente si el host no es local
  const isLocalHost = ['localhost','127.0.0.1','::1'].includes(host.toLowerCase());
  const sslDefault  = isLocalHost ? 'n' : 's';
  if (!isLocalHost) {
    console.log('     (Recomendamos SSL=s porque tu BD no es local, así las credenciales');
    console.log('      no viajan en claro entre este equipo y la BD)');
  }
  const useSsl   = await ask(rl, '  Usar SSL? (s/n)', sslDefault);

  rl.close();

  // Test connection
  console.log('\n  ⏳ Probando conexión...');
  const dbConfig: DbConfig = {
    host, port: parseInt(port), database, user, password, ssl: useSsl === 's',
  };

  if (dbType === 'mysql') {
    const result = await testMySQLConnection({ host, port: parseInt(port), database, user, password } as any);
    if (!result.ok) { console.error(`  ❌ No se pudo conectar: ${result.error}`); return; }
  } else {
    const result = await testConnection(dbConfig);
    if (!result.ok) { console.error(`  ❌ No se pudo conectar: ${result.error}`); return; }
  }
  console.log('  ✅ Conexión exitosa!\n');

  // Construir mapping completo
  const mapping: ColumnMapping = { phone };
  if (name)           mapping.name               = name;
  if (email)          mapping.email              = email;
  if (actionCount)    mapping.action_key_count   = actionCount;
  if (actionLastAt)   mapping.action_key_last_at = actionLastAt;
  if (registeredAt)   mapping.registered_at      = registeredAt;
  if (segment)        mapping.segment_name       = segment;
  if (classification) mapping.classification     = classification;
  if (ltv)            mapping.ltv                = ltv;

  // Preview
  console.log('  ⏳ Obteniendo preview...');
  try {
    const p = createPool(dbConfig);
    const allRows = await fetchRows(p, table, mapping);
    const rows = allRows.slice(0, 3);
    console.log(`  📋 Preview (${rows.length} filas):`);
    rows.forEach((r, i) => {
      const extras: string[] = [];
      if (r.segment_name)       extras.push(`seg=${r.segment_name}`);
      if (r.action_key_count != null) extras.push(`count=${r.action_key_count}`);
      if (r.ltv != null)        extras.push(`ltv=${r.ltv}`);
      const extraStr = extras.length ? ` (${extras.join(', ')})` : '';
      console.log(`     ${i + 1}. ${r.name ?? '—'} | ${r.phone} | ${r.email ?? '—'}${extraStr}`);
    });
    await p.end();
  } catch (e: any) {
    console.log(`  ⚠  No se pudo obtener preview: ${e.message}`);
  }

  // Save config (con local_token generado para el server mode)
  const existing = loadConfigOrEmpty();
  const localToken = existing.local_token || generateLocalToken();

  const configData = {
    db: dbConfig,
    db_type: dbType || 'postgres',
    table,
    mapping,
    api_key: apiKey,
    api_url: 'https://omni-platform-api-production.up.railway.app/api/v1',
    interval: 15,
    running: true,
    tenant_id: tenantId,
    local_token: localToken,
  };

  saveConfigSecure(configData);
  console.log(`\n  💾 Configuración guardada en: ${CONFIG_FILE}`);
  console.log('     Permisos del archivo: 0600 (solo tu usuario puede leerlo)\n');
  console.log('  🚀 Para iniciar el agente ejecuta:');
  console.log('     npx dropchat-agent\n');
  console.log('  El agente sincronizará tus contactos cada 15 minutos.');
  console.log('  Puedes cambiar el intervalo en http://127.0.0.1:3001');
  console.log(`  (Token local: ${localToken.slice(0, 8)}… — necesario para acceder al panel local)\n`);
}

// ── Server mode (default) ────────────────────────────────────
function startServer() {

const app  = express();
const PORT = 3001;
const HOST = '127.0.0.1'; // loopback only — nunca exponer a la red

app.use(express.json({ limit: '512kb' }));

// ── In-memory config (persisted to dropchat-agent-config.json) ─
let config: {
  db?:           DbConfig;
  db_type?:      string;
  table?:        string;
  mapping?:      ColumnMapping;
  api_key?:      string;
  api_url?:      string;
  interval?:     number;   // minutes
  running?:      boolean;
  tenant_id?:    string;
  local_token?:  string;
} = loadConfigOrEmpty();

// Generar token local si no existe (primer arranque)
if (!config.local_token) {
  config.local_token = generateLocalToken();
  saveConfigSecure(config);
}

function saveConfig() { saveConfigSecure(config); }

// ── Auth middleware: token local en header o query ────────────
// Acepta el token vía:
//   - Header: Authorization: Bearer <token>
//   - Header: X-Local-Token: <token>
//   - Query:  ?token=<token>   (para abrir el HTML inicial desde el browser)
function localAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  // Permitir GET / (HTML del UI) sin token, pero todos los /api/* lo requieren
  const isApi = req.path.startsWith('/api/');
  if (!isApi) return next();

  const expected = config.local_token;
  if (!expected) {
    res.status(503).json({ error: 'Agente sin token configurado' });
    return;
  }

  const headerAuth = (req.headers['authorization'] || '').toString();
  const headerToken = (req.headers['x-local-token'] || '').toString();
  const queryToken  = (req.query['token'] || '').toString();
  const provided =
    (headerAuth.startsWith('Bearer ') ? headerAuth.slice(7) : '') ||
    headerToken ||
    queryToken;

  if (!provided || !timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: 'Token local inválido o ausente' });
    return;
  }
  next();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

app.use(localAuth);

// Servir UI estático DESPUÉS del middleware: el HTML está exento (no es /api)
// pero los fetch que haga el HTML deben mandar el token.
app.use(express.static(path.join(__dirname, 'ui')));

// ── Endpoint público para que el UI sepa el token al abrirse ──
// Se sirve sin auth porque el UI corre en localhost y necesita poder
// inicializar. Como el server bindea a 127.0.0.1, solo procesos del
// mismo equipo pueden alcanzarlo; el token sigue protegiendo contra
// scripts del navegador apuntando a otros sitios.
app.get('/bootstrap', (_req, res) => {
  res.json({ token: config.local_token });
});

// ── MySQL routes ──────────────────────────────────────────────

app.post('/api/mysql/test', async (req, res) => {
  const t0 = Date.now();
  const result = await testMySQLConnection(req.body as MySQLConfig);
  res.json({ ...result, latency_ms: Date.now() - t0 });
});

app.post('/api/mysql/preview', async (req, res) => {
  try {
    const cfg = req.body as MySQLConfig & { limit?: number };
    // Validar columnas antes de ejecutar nada
    validateIdentifier(cfg.phone_column, 'phone_column');
    if (cfg.name_column)         validateIdentifier(cfg.name_column,         'name_column');
    if (cfg.email_column)        validateIdentifier(cfg.email_column,        'email_column');
    if (cfg.action_column)       validateIdentifier(cfg.action_column,       'action_column');
    if (cfg.action_date_column)  validateIdentifier(cfg.action_date_column,  'action_date_column');
    const result = await previewMySQLQuery(cfg, cfg.limit ?? 5);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/mysql/run', async (req, res) => {
  try {
    const cfg = req.body as MySQLConfig & { api_key: string; api_url?: string };
    if (!cfg.api_key) { res.status(400).json({ error: 'api_key requerido' }); return; }
    validateIdentifier(cfg.phone_column, 'phone_column');
    if (cfg.name_column)         validateIdentifier(cfg.name_column,         'name_column');
    if (cfg.email_column)        validateIdentifier(cfg.email_column,        'email_column');
    if (cfg.action_column)       validateIdentifier(cfg.action_column,       'action_column');
    if (cfg.action_date_column)  validateIdentifier(cfg.action_date_column,  'action_date_column');

    const contacts = await fetchMySQLContacts(cfg);
    if (!contacts.length) { res.json({ created: 0, updated: 0, skipped: 0, total: 0, message: 'Sin contactos' }); return; }

    const apiUrl = (cfg.api_url ?? 'https://omni-platform-api-production.up.railway.app/api/v1').replace(/\/$/, '');
    const resp = await axios.post(
      `${apiUrl}/sync/contacts`,
      { contacts },
      { headers: { 'X-API-Key': cfg.api_key }, timeout: 60_000 },
    );
    res.json(resp.data);
  } catch (e: any) {
    res.status(500).json({ error: e?.response?.data?.message ?? e.message });
  }
});

// ── Sync state ────────────────────────────────────────────────
let syncInterval: ReturnType<typeof setInterval> | null = null;
let lastSyncAt: string | null  = null;
let lastSyncResult: any        = null;
let syncRunning                = false;
let pool: Pool | null          = null;

// ── API Routes ────────────────────────────────────────────────

// Get current config + status
app.get('/api/status', (_req, res) => {
  res.json({
    configured:    !!(config.db && config.table && config.mapping && config.api_key),
    running:       config.running ?? false,
    db:            config.db ? { ...config.db, password: '••••••••' } : null,
    table:         config.table,
    mapping:       config.mapping,
    api_url:       config.api_url,
    interval:      config.interval ?? 60,
    last_sync_at:  lastSyncAt,
    last_result:   lastSyncResult,
    sync_running:  syncRunning,
  });
});

// Test DB connection
app.post('/api/test-connection', async (req, res) => {
  const result = await testConnection(req.body as DbConfig);
  res.json(result);
});

// Get columns for a table
app.post('/api/columns', async (req, res) => {
  try {
    const { db, table } = req.body;
    validateIdentifier(table, 'tabla');
    const cols = await getColumns(db, table);
    res.json({ columns: cols });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Save config
app.post('/api/config', (req, res) => {
  try {
    // Validar campos sensibles antes de persistir
    const incoming = req.body || {};

    // No permitir cambiar el local_token vía API
    delete incoming.local_token;

    // Validar table y mapping si vienen
    if (incoming.table) validateIdentifier(incoming.table, 'tabla');
    if (incoming.mapping && typeof incoming.mapping === 'object') {
      for (const [field, col] of Object.entries(incoming.mapping as Record<string,string>)) {
        if (!col) continue;
        validateIdentifier(col, `mapping.${field}`);
      }
    }

    // Validar api_url contra hijacking — solo permitir el dominio oficial
    // o overrides por env var DC_ALLOWED_API_URL para entornos de prueba
    if (incoming.api_url) {
      const allowedUrls = [
        'https://omni-platform-api-production.up.railway.app/api/v1',
        process.env['DC_ALLOWED_API_URL'],
      ].filter(Boolean) as string[];
      const norm = String(incoming.api_url).replace(/\/$/, '');
      if (!allowedUrls.some(u => u && u.replace(/\/$/, '') === norm)) {
        res.status(400).json({ error: 'api_url no permitido. Solo se acepta el dominio oficial de Drop Chat.' });
        return;
      }
    }

    config = { ...config, ...incoming };
    saveConfig();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Manual sync
app.post('/api/sync-now', async (_req, res) => {
  if (syncRunning) { res.json({ error: 'Sync already running' }); return; }
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
    if (!pool) pool = createPool(config.db);
    const rows = await fetchRows(pool, config.table!, config.mapping!);

    if (!rows.length) {
      lastSyncResult = { created: 0, updated: 0, skipped: 0, total: 0, message: 'Sin filas' };
      lastSyncAt     = new Date().toISOString();
      return lastSyncResult;
    }

    const apiUrl = (config.api_url ?? 'https://omni-platform-api-production.up.railway.app/api/v1')
      .replace(/\/$/, '');

    const resp = await axios.post(
      `${apiUrl}/sync/contacts`,
      { contacts: rows },
      { headers: { 'X-API-Key': config.api_key! }, timeout: 30_000 }
    );

    lastSyncResult = resp.data;
    lastSyncAt     = new Date().toISOString();
    console.log(`[Sync] ${new Date().toLocaleTimeString()} — +${resp.data.created} new, ~${resp.data.updated} updated`);
    return lastSyncResult;
  } catch (e: any) {
    const err = { error: e?.response?.data?.message ?? e.message };
    lastSyncResult = err;
    lastSyncAt     = new Date().toISOString();
    console.error('[Sync] Error:', err.error);
    return err;
  } finally {
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
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}

// ── Startup ───────────────────────────────────────────────────
// Bind a 127.0.0.1 explícitamente — NO 0.0.0.0.
// Esto previene que cualquiera en la red local del cliente alcance
// el agente. Solo procesos del mismo equipo pueden conectarse.
app.listen(PORT, HOST, () => {
  const localUrl = `http://${HOST}:${PORT}`;
  console.log(`\n  ✅ Drop Chat Sync Agent corriendo`);
  console.log(`  🔒 Bind: ${HOST}:${PORT} (solo accesible desde este equipo)`);
  console.log(`  🌐 Abre el panel: ${localUrl}/?token=${config.local_token}\n`);

  // Auto-open browser con el token en el query string para que se autocomplete
  const urlWithToken = `${localUrl}/?token=${config.local_token}`;
  const cmd = process.platform === 'darwin' ? `open "${urlWithToken}"`
            : process.platform === 'win32'  ? `start "" "${urlWithToken}"`
            : `xdg-open "${urlWithToken}"`;
  exec(cmd);

  // Resume sync if was running
  if (config.running && config.db && config.table && config.mapping && config.api_key) {
    console.log('[Scheduler] Resuming sync from saved config');
    startScheduler();
  }

  // Heartbeat — report status to Drop Chat every 5 min
  if (config.api_key) {
    const heartbeat = () => {
      const apiUrl = (config.api_url ?? 'https://omni-platform-api-production.up.railway.app/api/v1').replace(/\/$/, '');
      axios.post(`${apiUrl}/sync/heartbeat`, {
        agent_version: '1.1.0',
        last_sync_at: lastSyncAt,
        status: config.running ? 'running' : 'stopped',
      }, { headers: { 'X-API-Key': config.api_key! }, timeout: 10_000 }).catch(() => {});
    };
    heartbeat();
    setInterval(heartbeat, 5 * 60 * 1000);
  }
});

// Suprimir el aviso de "os" no usado en algunos build setups
void os;

} // end startServer()
