# School Scheduler — Classes & Afterschool Programs

Multi-tenant SaaS: schools self-register, students reserve spots, teachers take attendance,
admins run their school, and the platform owner manages everything from /owner.

## URLs

- `/` — storefront with **Register your school**
- `/<school-slug>` — each school's private page (branding, programs, signup, login)
- `/owner` — platform owner: schools, alerts, trial-code generator, support inbox, email test

## Environment variables (Render → service → Environment)

| Var | Purpose |
|---|---|
| `DB_PATH` | e.g. `/data/afterschoolscheduler/app.db` — on the persistent disk |
| `JWT_SECRET` | long random phrase — secures logins |
| `CODE_SECRET` | long random phrase — signs trial codes |
| `UPGRADE_CODE` | permanent unlock code (manual sales) |
| `OWNER_EMAIL` / `OWNER_PASSWORD` | /owner dashboard login |
| `EMAIL_USER` / `EMAIL_PASSWORD` | Gmail address + app password for reset emails (aliases: GMAIL_USER / GMAIL_APP_PASSWORD) |
| `ALERT_WEBHOOK_URL` | optional Slack/Discord webhook for instant alerts |
| `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` / `STRIPE_WEBHOOK_SECRET` | card subscriptions |

## Plans

Free: 3 classes/programs, 3 teachers, 10 students per school. Trial codes (owner dashboard)
unlock Unlimited for N days, then auto-revert. Stripe subscription = permanent Unlimited.

## Files

```
server.js     # API + static server (Express + SQLite)
index.html    # the whole front end (storefront, school pages, all dashboards, PWA)
manifest.webmanifest, sw.js, icon-*.png, apple-touch-icon.png   # phone-install support
Dockerfile    # Render Docker deploy
```
