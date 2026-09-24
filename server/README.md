# Farm Buddie Provisioning API

Issues MQTT credentials on TBMQ for devices (admin panel) and the farmer app.
Must run on the same VPS as TBMQ, because it talks to TBMQ's REST API
(`http://tbmq:8083`), which is intentionally not exposed to the internet.

Two endpoints:
- `POST /provision/device` — called by farmbuddie-web (admin panel), issues/rotates
  credentials for one assigned controller.
- `POST /provision/app` — called by the Irrigo app, issues/rotates one credential
  covering every farm the signed-in phone number owns.

Both require `Authorization: Bearer <Firebase ID token>`. Neither endpoint, nor
Firestore, ever stores the plaintext MQTT password — it's returned once in the
JSON response and must be captured by the caller at issue time.

Two more endpoints are called by the Motor hub itself (no Firebase token -
a device has no account):
- `POST /provision/bootstrap` — first-boot credential fetch.
- `POST /provision/bind` — one-time key enrolment for hubs bootstrapped before
  device keys existed.

### Device-key binding (bootstrap / bind)

The fleet-wide `DEVICE_PROVISIONING_SECRET` is in every hub's flash, so it's
treated as extractable. Each hub also generates its own random key on first
boot; the first bootstrap for a farm binds the farm to that key
(`controllers/{id}.deviceKeyHash` - only a SHA-256 is stored), and from then on
bootstrap refuses any other key (`403 device_mismatch`) or none
(`403 device_key_required`). Hubs that were already provisioned bind their key
via `/provision/bind` by proving they hold the farm's current MQTT password -
firmware does this automatically at boot until it succeeds. See
`src/deviceBinding.js`.

- **Hub replaced, or its flash wiped?** Its new key won't match. Clear the
  binding, then let the new hub bootstrap:
  `node scripts/resetDeviceBinding.js <farmId>` (dry run) then `... --apply`.
- **Legacy firmware** (no device key) can still bootstrap a farm that isn't
  bound yet. Once no unit in stock or in the field runs such firmware, set
  `BOOTSTRAP_REQUIRE_DEVICE_KEY=true` in `.env` to refuse keyless requests.

## 1. Firebase service account

Firebase Console → Project settings → Service accounts → Generate new private key.
Save it on the VPS as `/root/secrets/firebase-service-account.json` (not in git).

## 2. Add to the VPS's `docker-compose.yml`

Add this service alongside the existing `tbmq`, `postgres`, `kafka`, `valkey` services
(same file, same docker network — no port needs to be added to TBMQ's compose,
this container reaches TBMQ via `http://tbmq:8083` over the internal network):

```yaml
  provision-api:
    build: /root/farmbuddie-web/server
    container_name: provision-api
    restart: unless-stopped
    env_file:
      - /root/farmbuddie-web/server/.env
    volumes:
      - /root/secrets/firebase-service-account.json:/run/secrets/firebase-service-account.json:ro
    ports:
      - "127.0.0.1:4000:4000"
    mem_limit: 256m
    cpus: 0.5
    depends_on:
      - tbmq
```

`127.0.0.1:4000` keeps it off the public internet directly — nginx is the only
public entry point (below), same pattern already used for the TBMQ dashboard.

## 3. Clone this repo onto the VPS and configure `.env`

```bash
cd /root
git clone https://github.com/praveen7154-maker/farmbuddie-web.git
cd farmbuddie-web/server
cp .env.example .env
nano .env   # fill in TBMQ_ADMIN_EMAIL / TBMQ_ADMIN_PASSWORD (the dashboard login you already changed)
```

Then from `/root`: `docker compose up -d --build provision-api`

## 4. nginx + TLS for `api.farmbuddie.com`

Point a DNS A record for `api.farmbuddie.com` at `217.217.249.78`, same as
`mqtt.farmbuddie.com`, then:

```bash
certbot certonly --standalone -d api.farmbuddie.com
```

nginx site (`/etc/nginx/sites-available/api.farmbuddie.com`):

```nginx
server {
    listen 443 ssl;
    server_name api.farmbuddie.com;

    ssl_certificate     /etc/letsencrypt/live/api.farmbuddie.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.farmbuddie.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

server {
    listen 80;
    server_name api.farmbuddie.com;
    return 301 https://$host$request_uri;
}
```

```bash
ln -s /etc/nginx/sites-available/api.farmbuddie.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Certbot's default renewal already reloads nginx on renew — no extra deploy-hook
needed here (unlike TBMQ, which reads the cert file directly and needs the
copy+restart hook already in place at `/etc/letsencrypt/renewal-hooks/deploy/`).

## 5. Redeploying after a code change

```bash
cd /root/farmbuddie-web && git pull
cd /root && docker compose up -d --build provision-api bridge
```

`provision-api` and `bridge` are built from the same image - rebuild both,
or the bridge keeps running old code.

## 6. The bridge service (device ↔ TBMQ ↔ VPS ↔ app/web)

A second, separate long-running service (`server/src/bridge`) — not the
REST API above. Holds the one persistent MQTT connection that relays
everything: subscribes to `farm/+/#`, writes every event into Postgres
(15-day rolling history, auto-cleaned hourly) and mirrors live status into
Firestore; exposes `POST /command/device` and `GET /telemetry/:farmId` so
neither the admin panel nor the Irrigo app ever needs its own MQTT
credential.

### Postgres database (same instance as TBMQ's, separate database)

```bash
docker exec -it root-postgres-1 psql -U postgres -c "CREATE DATABASE farmbuddie_bridge;"
docker exec -it root-postgres-1 psql -U postgres -c "CREATE USER bridge WITH PASSWORD 'CHOOSE_A_PASSWORD';"
docker exec -it root-postgres-1 psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE farmbuddie_bridge TO bridge;"
```

(Container name may differ — check with `docker compose ps`.)

### Bridge's own TBMQ credential

Infrastructure-level, not per-customer — created once directly via TBMQ's
REST API (same pattern used elsewhere in this session), with broad
read+write since it relays both directions:

```bash
# from the VPS, with TBMQ admin token already obtained (see earlier steps)
curl -s -X POST http://127.0.0.1:8083/api/mqtt/client/credentials \
  -H "X-Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"bridge","credentialsType":"MQTT_BASIC","credentialsValue":"{\"clientId\":\"bridge\",\"userName\":\"bridge\",\"password\":\"CHOOSE_A_PASSWORD\",\"authRules\":{\"pubAuthRulePatterns\":[\"farm/[^/]+/.*\"],\"subAuthRulePatterns\":[\"farm/[^/]+/.*\"]}}"}'
```

`authRulePatterns` are **regex**, not MQTT wildcard syntax — `farm/+/.*` looks
right but isn't: as a regex, `+` quantifies the preceding `/` ("one or more
slashes"), so it only matches topics with a *double* slash after `farm` and
silently rejects every real one (confirmed live: TBMQ returned SUBACK code
128 for every subscribe attempt with that pattern). `farm/[^/]+/.*` ("one or
more non-slash characters" for the farmId segment) is the correct regex
equivalent of MQTT's `+` wildcard.

### `.env` additions

Add to the same `server/.env` used by `provision-api` (see `.env.example`):
`BRIDGE_MQTT_USERNAME`, `BRIDGE_MQTT_PASSWORD` (from above), `BRIDGE_PG_CONNECTION_STRING`
(`postgresql://bridge:PASSWORD@postgres:5432/farmbuddie_bridge` — service
name `postgres`, not `127.0.0.1`, since this runs in the same docker
network), `BRIDGE_PORT` (default 4100).

### docker-compose service

```yaml
  bridge:
    build: /root/farmbuddie-web/server
    container_name: bridge
    restart: unless-stopped
    command: ["node", "src/bridge/index.js"]
    depends_on:
      - tbmq
      - postgres
    env_file:
      - /root/farmbuddie-web/server/.env
    volumes:
      - /root/secrets/firebase-service-account.json:/run/secrets/firebase-service-account.json:ro
    ports:
      - "127.0.0.1:4100:4100"
    mem_limit: 256m
    cpus: 0.5
```

Same image as `provision-api` (same `Dockerfile`, same `package.json`),
just a different `command:` — no second Dockerfile needed. Expose
`GET /telemetry/*` and `POST /command/device` publicly the same way as
`provision-api` (nginx + TLS, a new site block or reusing `api.farmbuddie.com`
with a path prefix) once ready to wire up the app/web panel against it.

### Known follow-up

`device-view.js` (the web panel's live device page) still reads an older
Firestore schema (`deviceStatus.m1/m2/m3`, `.lora.packets_*`) from a
superseded architecture. The bridge writes the *current* firmware's real
shape instead (`deviceStatus.pumpA`/`pumpB`, raw payload as published) —
`device-view.js` needs a matching update before it'll show anything
real, not done as part of this change to keep it scoped to the bridge
itself.

## 7. MQTT access rules (OTA is admin-only)

Every TBMQ credential's topic rules come from `src/mqttAuthRules.js`:

| login | may publish | may subscribe |
|---|---|---|
| `FBIRG<farmId>` (Motor hub - also on the farm's setup QR) | its farm's topics **except** `.../ota/cmd` | its farm's topics + `motor/ota/broadcast` |
| `app-*` (Irrigo app) | its farms' topics **except** `.../ota/*` | its farms' topics |
| `ota-admin` (`tools/ota_admin.py`) | `farm/<id>/<node>/ota/cmd`, `motor/ota/broadcast` | `farm/<id>/<node>/ota/status` |
| `bridge` | `farm/<id>/<node>/motor/1|2/cmd` | every farm |
| `monitor-*` | nothing | every farm |
| `TBMQ WebSockets MQTT Credentials` (TBMQ built-in, no password) | nothing | nothing |

New credentials get these automatically. Once, after deploying this, create
the OTA login and bring existing credentials in line:

```bash
cd /root && docker compose exec provision-api node scripts/createOtaAdminCredential.js
docker compose exec provision-api node scripts/applyMqttAuthRules.js                        # dry run
docker compose exec provision-api node scripts/applyMqttAuthRules.js --apply --disconnect   # apply
```

- The OTA password is printed once - store it next to the OTA signing key.
  `--rotate` issues a new one.
- `applyMqttAuthRules.js` never changes a password. TBMQ only reads rules at
  connect, so `--disconnect` makes each changed client reconnect now (apps
  and hubs reconnect by themselves; a GSM hub takes ~15-40s).
- Anything it lists as `REVIEW` is a login this system didn't issue that can
  still publish OTA commands (e.g. an old shared login) - tighten or delete
  it in the TBMQ dashboard.
- Re-run it any time; it only touches credentials that differ.
