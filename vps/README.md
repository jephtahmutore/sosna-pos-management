# Sosna POS — VPS setup guide

Run these once on the Hostinger VPS (Ubuntu) to get `sosnazm.com` live.

Prerequisites already installed from your Liquor/Butchery work:
- Node.js 20+
- npm
- PM2
- nginx
- Certbot

If any are missing, install them with the same commands you used for Liquor.

---

## 1 — Clone the repo

```bash
sudo mkdir -p /var/www
cd /var/www
sudo git clone https://github.com/siraksol94-creator/sosna-pos-tenant.git
sudo chown -R $USER:$USER sosna-pos-tenant
cd sosna-pos-tenant
```

## 2 — Backend deps + .env

```bash
cd backend
npm install --production
cp .env.vps .env
nano .env
```

In the .env file, **change at least**:
- `JWT_SECRET` to a long random string (`openssl rand -hex 32`)
- `ADMIN_PASSWORD` to a real password

Save and exit.

## 3 — Frontend build

```bash
cd ../frontend
npm install
npm run build:web
cd ..
```

## 4 — Start with PM2

```bash
cd backend
pm2 start server.js --name sosna-tenant
pm2 save
pm2 startup   # follow the printed instructions if not already done
```

Verify it's running:
```bash
pm2 status sosna-tenant
curl -I http://127.0.0.1:5300
```

You should see `HTTP/1.1 200 OK` (or 301/redirect — either means the app responded).

## 5 — nginx server block

```bash
sudo cp vps/nginx-sosnazm.com.conf /etc/nginx/sites-available/sosnazm.com
sudo ln -s /etc/nginx/sites-available/sosnazm.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

At this point `http://sosnazm.com` should resolve (assuming Cloudflare is Active) and proxy to the Node app — but no HTTPS yet.

## 6 — SSL certificate via Certbot

```bash
sudo mkdir -p /var/www/certbot
sudo certbot --nginx -d sosnazm.com -d www.sosnazm.com
```

Follow the prompts. Certbot will edit the nginx file to add the SSL lines and reload nginx. Auto-renewal is already configured at the system level from your earlier domain setups.

Test renewal:
```bash
sudo certbot renew --dry-run
```

## 7 — Pull-deploy cron

Install the deploy script:

```bash
sudo cp vps/sosna-deploy.sh /usr/local/bin/sosna-deploy.sh
sudo chmod +x /usr/local/bin/sosna-deploy.sh
```

Add to root's crontab:

```bash
sudo crontab -e
```

Append:

```
* * * * * /usr/local/bin/sosna-deploy.sh >> /var/log/sosna-deploy.log 2>&1
```

Save. From now on, every `git push` to main on this repo deploys automatically within ~1 minute.

## 8 — Smoke test

Open `https://sosnazm.com` in a browser. You should see the Sosna login screen.

Default admin (created on first DB init):
- Email: from your code's default seed (check `backend/server.js` or run the create-user script)
- Password: whatever was in the seed

If login works, you're live.

---

## Troubleshooting

**502 Bad Gateway**: Node app crashed. `pm2 logs sosna-tenant --lines 100`.

**Cert error**: DNS hasn't propagated to Cloudflare yet, OR Cloudflare is proxied (must be grey). `dig sosnazm.com +short` should return your VPS IP directly.

**Cron not deploying**: `tail -f /var/log/sosna-deploy.log` to see if the script is firing.
