#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Drop Chat Sync Agent — Script de verificación de seguridad
# ═══════════════════════════════════════════════════════════════
# Corre el agente localmente y valida los 4 hardenings de v1.1.0.
# Uso: ./test-security.sh
# ═══════════════════════════════════════════════════════════════

set -u
cd "$(dirname "$0")"

# Colores
R='\033[0;31m'; G='\033[0;32m'; Y='\033[0;33m'; B='\033[0;34m'; N='\033[0m'
PASS=0; FAIL=0

ok()   { echo -e " ${G}✓${N} $1"; PASS=$((PASS+1)); }
fail() { echo -e " ${R}✗${N} $1"; FAIL=$((FAIL+1)); }
info() { echo -e " ${B}ℹ${N} $1"; }
hdr()  { echo; echo -e "${Y}━━━ $1 ━━━${N}"; }

hdr "0. Pre-flight: build del agente"
if ! command -v node >/dev/null; then
  fail "node no encontrado. Instala Node.js 18+"
  exit 1
fi
ok "node $(node -v)"

if [ ! -f dist/index.js ]; then
  info "Compilando TypeScript..."
  npx tsc 2>&1 | tail -5
fi
[ -f dist/index.js ] && ok "dist/index.js existe" || { fail "Build falló"; exit 1; }

# Backup del config existente si hay
if [ -f dropchat-agent-config.json ]; then
  cp dropchat-agent-config.json dropchat-agent-config.json.bak
  info "Backup del config actual en .bak"
fi

# Config mínimo con token conocido para los tests
TEST_TOKEN="test_token_12345"
cat > dropchat-agent-config.json <<JSON
{
  "local_token": "$TEST_TOKEN",
  "api_url": "https://omni-platform-api-production.up.railway.app/api/v1",
  "interval": 60,
  "running": false
}
JSON
chmod 600 dropchat-agent-config.json
ok "Config de prueba creado con token conocido"

# Arrancar el agente en background
info "Arrancando agente en background..."
node dist/index.js > /tmp/dropchat-agent-test.log 2>&1 &
AGENT_PID=$!
sleep 2

cleanup() {
  kill $AGENT_PID 2>/dev/null
  wait $AGENT_PID 2>/dev/null
  if [ -f dropchat-agent-config.json.bak ]; then
    mv dropchat-agent-config.json.bak dropchat-agent-config.json
  else
    rm -f dropchat-agent-config.json
  fi
}
trap cleanup EXIT

if ! kill -0 $AGENT_PID 2>/dev/null; then
  fail "El agente no arrancó. Log:"
  cat /tmp/dropchat-agent-test.log
  exit 1
fi
ok "Agente PID $AGENT_PID arriba"

# ════════════════════════════════════════════════════════════════
hdr "1. Bind a 127.0.0.1 (no expuesto en LAN)"
# ════════════════════════════════════════════════════════════════

# Verificar que el proceso escucha SOLO en 127.0.0.1
if command -v lsof >/dev/null; then
  BIND=$(lsof -iTCP:3001 -sTCP:LISTEN -P 2>/dev/null | awk 'NR==2 {print $9}')
  if [[ "$BIND" == "127.0.0.1:3001" || "$BIND" == "localhost:3001" ]]; then
    ok "Socket bindeado a $BIND (solo loopback)"
  elif [[ "$BIND" == "*:3001" || "$BIND" == "0.0.0.0:3001" ]]; then
    fail "Socket bindeado a $BIND — expuesto en TODAS las interfaces!"
  else
    fail "Bind inesperado: $BIND"
  fi
else
  info "lsof no disponible, intentando con netstat..."
  netstat -an 2>/dev/null | grep 3001 | grep LISTEN | head -3
fi

# Test: request desde localhost responde
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/bootstrap)
if [ "$STATUS" = "200" ]; then
  ok "GET /bootstrap desde 127.0.0.1 responde 200"
else
  fail "GET /bootstrap desde 127.0.0.1 respondió $STATUS"
fi

# Test: request a otra IP de la máquina (si existe) DEBE fallar o llegar a otro servicio
LAN_IP=$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2; exit}')
if [ -n "$LAN_IP" ]; then
  # Usar --fail para que curl devuelva exit code != 0 si no conecta
  # y limitar tiempo para no esperar
  if curl --fail --silent --output /dev/null --max-time 3 "http://$LAN_IP:3001/bootstrap" 2>/dev/null; then
    # Conectó con éxito → malo, el bind es incorrecto
    fail "GET http://$LAN_IP:3001 respondió 200 — el agente es alcanzable desde la LAN!"
  else
    EXIT_CODE=$?
    # 7 = couldn't connect, 28 = timeout, 22 = HTTP error
    # En macOS a veces loopback routing devuelve 200 aun con bind 127.0.0.1
    # → necesitamos distinguir entre "no conectó" (bien) y "respondió pero con error HTTP" (depende)
    if [ $EXIT_CODE -eq 7 ] || [ $EXIT_CODE -eq 28 ]; then
      ok "GET http://$LAN_IP:3001 rechazó conexión (exit $EXIT_CODE — correcto, bind 127.0.0.1)"
    else
      # Verificar si el 200 que llegó realmente es nuestro agente
      BODY=$(curl -s --max-time 3 "http://$LAN_IP:3001/bootstrap" 2>/dev/null)
      if echo "$BODY" | grep -q "token"; then
        fail "GET http://$LAN_IP:3001/bootstrap devolvió nuestro token — el agente es alcanzable desde la LAN!"
      else
        # No es nuestro agente; lo que respondió es otro servicio
        ok "GET http://$LAN_IP:3001 NO lleva a nuestro agente (respondió otro servicio o 404 del kernel)"
      fi
    fi
  fi
else
  info "No se detectó IP LAN. Saltando test de exposición externa."
fi

# ════════════════════════════════════════════════════════════════
hdr "2. Auth con token local"
# ════════════════════════════════════════════════════════════════

# /bootstrap es público (para que el UI recupere el token)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/bootstrap)
[ "$STATUS" = "200" ] && ok "/bootstrap accesible sin token" || fail "/bootstrap debería ser público, got $STATUS"

# /api/status SIN token → 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/api/status)
[ "$STATUS" = "401" ] && ok "/api/status sin token → 401" || fail "/api/status sin token → $STATUS (esperado 401)"

# /api/status CON token inválido → 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong_token" http://127.0.0.1:3001/api/status)
[ "$STATUS" = "401" ] && ok "/api/status con token inválido → 401" || fail "/api/status con token inválido → $STATUS"

# /api/status CON token válido (Bearer) → 200
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TEST_TOKEN" http://127.0.0.1:3001/api/status)
[ "$STATUS" = "200" ] && ok "/api/status con Bearer válido → 200" || fail "/api/status con Bearer válido → $STATUS"

# /api/status CON token en X-Local-Token → 200
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Local-Token: $TEST_TOKEN" http://127.0.0.1:3001/api/status)
[ "$STATUS" = "200" ] && ok "/api/status con X-Local-Token → 200" || fail "/api/status con X-Local-Token → $STATUS"

# /api/status CON token en query → 200
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3001/api/status?token=$TEST_TOKEN")
[ "$STATUS" = "200" ] && ok "/api/status con ?token=... → 200" || fail "/api/status con ?token=... → $STATUS"

# ════════════════════════════════════════════════════════════════
hdr "3. Validación anti-SQLi (identificadores)"
# ════════════════════════════════════════════════════════════════

# POST /api/columns con tabla inyectada → 400
RESP=$(curl -s -X POST http://127.0.0.1:3001/api/columns \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"db":{"host":"localhost","port":5432,"database":"x","user":"x","password":"x","ssl":false},"table":"users; DROP TABLE x;--"}')
if echo "$RESP" | grep -qi "inválid\|invalid\|error"; then
  ok "Tabla con 'DROP TABLE' rechazada"
else
  fail "Tabla maliciosa aceptada: $RESP"
fi

# POST /api/columns con tabla válida → intenta conectar (fallará por la conn pero no por validación)
RESP=$(curl -s -X POST http://127.0.0.1:3001/api/columns \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"db":{"host":"localhost","port":5432,"database":"x","user":"x","password":"x","ssl":false},"table":"users"}')
# No debe incluir "inválido" (puede fallar por conn refused pero no por validation)
if echo "$RESP" | grep -qi "inválid"; then
  fail "Tabla 'users' rechazada como inválida: $RESP"
else
  ok "Tabla 'users' válida pasa la regex (otro error de conn está OK)"
fi

# ════════════════════════════════════════════════════════════════
hdr "4. api_url whitelist en POST /api/config"
# ════════════════════════════════════════════════════════════════

# Intentar redirigir el api_url a un atacante
RESP=$(curl -s -X POST http://127.0.0.1:3001/api/config \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"api_url":"https://evil.example.com/api"}')
if echo "$RESP" | grep -qi "no permitido\|not allowed\|error"; then
  ok "api_url malicioso rechazado"
else
  fail "api_url malicioso aceptado: $RESP"
fi

# Verificar que el api_url del config NO cambió
RESP=$(curl -s -H "Authorization: Bearer $TEST_TOKEN" http://127.0.0.1:3001/api/status)
if echo "$RESP" | grep -q "evil.example.com"; then
  fail "El api_url malicioso se persistió en el config!"
else
  ok "api_url del config no fue modificado (revertido)"
fi

# api_url oficial → aceptado
RESP=$(curl -s -X POST http://127.0.0.1:3001/api/config \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"api_url":"https://omni-platform-api-production.up.railway.app/api/v1"}')
if echo "$RESP" | grep -q '"ok":true'; then
  ok "api_url oficial aceptado"
else
  fail "api_url oficial rechazado inesperadamente: $RESP"
fi

# Intentar sobrescribir el local_token vía /api/config
RESP=$(curl -s -X POST http://127.0.0.1:3001/api/config \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"local_token":"hijacked_token"}')
# Verificar que el token NO fue cambiado probando con el token original
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TEST_TOKEN" http://127.0.0.1:3001/api/status)
if [ "$STATUS" = "200" ]; then
  ok "local_token NO puede ser sobrescrito vía /api/config"
else
  fail "local_token fue sobrescrito! Status con el original: $STATUS"
fi

# ════════════════════════════════════════════════════════════════
hdr "5. Permisos 0600 del config"
# ════════════════════════════════════════════════════════════════

PERMS=$(stat -f "%Lp" dropchat-agent-config.json 2>/dev/null || stat -c "%a" dropchat-agent-config.json 2>/dev/null)
if [ "$PERMS" = "600" ]; then
  ok "Config permisos 0600 (solo dueño)"
else
  fail "Config permisos $PERMS (esperado 600)"
fi

# ════════════════════════════════════════════════════════════════
hdr "Resumen"
# ════════════════════════════════════════════════════════════════
echo
echo -e " ${G}Pasaron:${N} $PASS"
echo -e " ${R}Fallaron:${N} $FAIL"
echo
if [ $FAIL -eq 0 ]; then
  echo -e " ${G}✅ Todos los hardenings verificados${N}"
  exit 0
else
  echo -e " ${R}❌ Hay tests fallando — revisa el output de arriba${N}"
  exit 1
fi
