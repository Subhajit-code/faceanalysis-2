# Sentinel Biometrics — Production Backend Setup

Two services: `face-engine` (Python/InsightFace) and `server` (Node/Express/Prisma/PostgreSQL), plus the `/` frontend which talks to the API. The project went through a SQLite phase during local development, but moved to PostgreSQL (e.g. Neon or Supabase's free tier) once real hosting entered the picture — Render's free web services have no persistent disk, so a local SQLite file gets wiped every time the service spins down from idle and wakes back up. A real Postgres instance elsewhere survives that.

## 1. Configure secrets

```bash
cd server
cp .env.example .env
```

Generate real secrets before touching production:

```bash
# AES_KEY: 32-byte hex key for encrypting stored face embeddings
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# JWT_SECRET: any long random string
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Paste both into `server/.env`. Never commit `.env`.

## 2. Start everything

```bash
docker compose up -d --build
```

This brings up the face-engine (downloads InsightFace's `buffalo_l` model on first run — needs internet access once) and the API on `:4000`. The API container runs its Postgres migration automatically on startup (`npm start` = `prisma migrate deploy && node src/index.js`). `DATABASE_URL` in `server/.env` must point at a real Postgres instance (Neon/Supabase free tier, or your own) — there's no local database container in this compose file.

## 3. Run migrations + create the first admin

For local (non-Docker) development:

```bash
cd server
npx prisma migrate dev --name init
node src/seedAdmin.js admin@yourcompany.com "ChooseAStrongPassword123!"
```

Against the Docker setup, run the seed script inside the running container instead:

```bash
docker compose exec api node src/seedAdmin.js admin@yourcompany.com "ChooseAStrongPassword123!"
```

## 4. Frontend integration (what still needs doing)

The existing `src/*.js` frontend currently does everything client-side (model loading, matching, localStorage). To point it at this backend:

- Replace `faceService.matchFace(...)` calls with a `POST /api/verify` request sending a base64 JPEG frame; the API returns grant/deny + a short-lived JWT.
- Replace `storage.saveEmployee(...)` with `POST /api/enroll` (admin-authenticated), sending 1–3 face images + employee metadata.
- Replace the `storage.js` localStorage reads for attendance/audit/employees with `GET /api/attendance`, `GET /api/audit`, `GET /api/employees` (all admin-authenticated).
- Remove `@vladmandic/face-api` model loading from the browser entirely once the backend is live — the browser only needs `getUserMedia` to capture frames, not to run the recognition model.
- Admin login screen needed (`POST /api/auth/admin/login`) — this is now a real login, not the old PIN prompt.

I did not wire this up yet since it's a meaningful frontend rewrite — say the word and I'll do that pass next.

## Why this is production-appropriate (vs. the original browser-only prototype)

| Concern | Before | Now |
|---|---|---|
| Face embeddings | dlib-ResNet, 128-D, computed & matched in-browser | ArcFace (InsightFace `buffalo_l`), 512-D, computed & matched server-side |
| Data storage | `localStorage`, per-browser, plaintext | PostgreSQL (via Prisma), embeddings AES-256-GCM encrypted at rest |
| Matching/threshold | Visible & alterable via browser devtools | Server-only, never exposed to the client |
| Liveness | Blink-only, client-reported (trivially bypassable) | Server-enforced passive liveness + optional active head-turn challenge sequence |
| Brute-force protection | None (client-side counter only) | DB-backed lockout + IP rate limiting on both login and verify endpoints |
| Admin actions | `prompt()` PIN, hardcoded `1234` | bcrypt-hashed admin password + JWT, rate-limited login |
| Duplicate enrollment | Checked client-side, bypassable | Checked server-side against encrypted DB, cannot be bypassed from the browser |
| Audit trail | localStorage array, user can clear it themselves | Postgres table, admin-only read, not clearable by employees |

## Update: multi-frame liveness burst (now implemented)

`/api/verify` now requires 2+ frames per login attempt instead of one still image. The server:
- rejects the attempt if any two frames are byte-identical (a static photo can't vary frame-to-frame the way a live camera feed does),
- requires the embedding to stay consistent across every frame (stops a photo-swap mid-attempt),
- averages the passive liveness score across the whole burst rather than trusting one frame.

The frontend (`src/main.js`) now captures 3 frames ~180ms apart automatically whenever it attempts a login. No UI change needed on your end — it just happens during the normal scan.

CORS is now locked to `ALLOWED_ORIGIN` (set it in `server/.env` to your real frontend URL) and the enroll endpoint is rate-limited.

## Remaining hardening before you'd call this fully "foolproof"

1. **Swap the passive-liveness heuristic** in `face-engine/main.py` for a trained anti-spoofing model (e.g. MiniFASNet / Silent-Face-Anti-Spoofing). The burst check above closes the "submit one photo" and "swap photos mid-attempt" holes, but a genuinely high-quality video replay of a real blinking, moving face could still pass today's heuristic. This is the one remaining item I can't fully close without you deciding on a model and (ideally) a short labeled dataset of your own real vs. spoof attempts to validate against.
2. **TLS termination** (nginx/Caddy or your cloud load balancer) in front of the API — never serve this over plain HTTP in production.
3. **Secrets management** — move `AES_KEY`/`JWT_SECRET`/`DATABASE_URL` into a real secrets manager (AWS Secrets Manager, Vault, etc.) rather than a `.env` file on the host.
4. **Backups** — Neon/Supabase both offer point-in-time recovery or scheduled backups on their free/low tiers; confirm which one yours does and don't assume it's automatic. Losing the database means losing every enrolled face and attendance record, and the AES key is still needed to read what's left even if you have a backup.
5. **Free-tier database limits** — Neon and Supabase's free tiers cap storage (typically 0.5-3GB) and may pause the database after extended inactivity (it wakes on the next query, with a short delay). Fine for this project's scale; worth checking the current limits on whichever provider you pick before relying on it for real attendance data.
5. **GDPR/biometric-data compliance** — face embeddings are legally sensitive biometric data in most jurisdictions; you likely need employee consent records and a data-retention/deletion policy, not just encryption.

## What I need from YOU to go further

I've pushed everything I can decide on my own as far as it reasonably goes. The items below need information or decisions only you have:

| # | What I need | Why I can't decide it myself |
|---|---|---|
| 1 | **Where this will actually run** (your own server/VM, AWS/GCP/Azure, a Raspberry Pi at a door, etc.) | Changes the deployment steps, whether GPU is available for the face model, and the TLS setup |
| 2 | **A real domain name**, if this is reachable over the internet (not just LAN) | Needed for HTTPS certificates (Let's Encrypt via Caddy) — can't be faked for production |
| 3 | **The admin email + a strong password** you want for the first admin account | `seedAdmin.js` needs real values; I put placeholders, you should run it yourself rather than tell me the password |
| 4 | **Confirmation on data residency / compliance requirements** (country, any industry regulation like GDPR/BIPA) | Determines retention rules and whether you need written employee consent before enrolling faces — a legal decision, not a technical one |
| 5 | **Expected number of employees and concurrent logins** | Affects whether CPU inference is fine or you need a GPU box for the face-engine under load |
| 6 | **If you want a real anti-spoof model (item 1 above):** either approval to use a specific pretrained open model (I'd pick MiniFASNet) as-is, or sample photos/videos of real vs. spoof attempts from your own setup to validate it | I won't fetch and wire in a third-party ML model's exact weights without your go-ahead, and validating it needs your actual camera/lighting conditions |

Once you tell me #1 and #2 (even roughly — e.g. "self-hosted on a Linux VM, no public domain yet, just the office LAN"), I can finish the deployment config (Caddy/nginx + TLS or a LAN-only setup) without further back-and-forth.
