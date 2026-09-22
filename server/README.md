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
cd /root && docker compose up -d --build provision-api
```
