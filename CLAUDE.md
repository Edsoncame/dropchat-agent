# dropchat-agent — Desktop Sync Agent

> Este repo es el **agente de sincronización de BD** que se ejecuta en la infraestructura del cliente.
> El cerebro del CTO Virtual vive en `omni-platform-api`.
> **Antes de trabajar acá, leer el hub central:** `/Users/securex07/omni-platform-api/CLAUDE.md`

## Contexto mínimo

- **Propósito:** leer datos desde la BD del cliente (Postgres/MySQL) y mandarlos a Drop Chat SaaS sin que las credenciales salgan de su servidor
- **Version actual:** 1.1.0 (hardenizado 2026-04-14)
- **Stack:** TypeScript + Express 4 + `pg` + `mysql2` + `axios` + `chokidar`
- **Distribution:** `npx github:Edsoncame/dropchat-agent setup --db-type=...`
- **Repo GitHub:** `Edsoncame/dropchat-agent`

## Garantías de seguridad

1. **Bind 127.0.0.1** — nunca expuesto a la red local
2. **Auth token local** (`crypto.randomBytes(24)` con `timingSafeEqual`) en todos los endpoints `/api/*`
3. **Anti-SQLi** en nombres de tabla/columna — `validateIdentifier()` + `quoteIdent()`
4. **File permissions 0600** en el config
5. **Whitelist de `api_url`** — solo acepta el dominio oficial Drop Chat
6. **local_token no sobreescribible** vía `/api/config`
7. **9 columnas mapeables:** phone, name, email, action_key_count, action_key_last_at, registered_at, segment_name, classification, ltv

## Estructura

```
src/
├── index.ts              # Express server + setup CLI
├── adapters/
│   ├── postgres.ts       # validateIdentifier, quoteIdent, fetchRows
│   └── mysql.ts          # Misma API con backticks
└── ui/
    └── index.html        # Panel local de config
```

## Testing

```bash
./test-security.sh       # 20 checks de hardening (9 PASS esperado)
```

## Reglas del CTO Virtual

- Este agente corre en infra del CLIENTE — cualquier cambio debe mantener las 6 garantías arriba
- **Nunca** aceptar SQL libre del usuario — siempre `table + columns validados`
- **Nunca** loggear passwords de BD
- El config del cliente (`dropchat-agent-config.json`) es SU secreto — nunca lo copiamos a nuestros servidores
- Cuando subimos versión, debe pasar `./test-security.sh` 20/20 antes del release

## Ver también

- **Hub central:** `/Users/securex07/omni-platform-api/CLAUDE.md`
- **Security test:** `./test-security.sh`
- **Memoria del agente:** `/Users/securex07/omni-platform-api/memory.md`
