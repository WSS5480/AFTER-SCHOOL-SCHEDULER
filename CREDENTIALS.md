# School Scheduler — who logs in where
### Int-AI-lisoft · keep this file private

Base URL: `https://after-school-scheduler.onrender.com`

---

## 1 · YOUR office (platform owner — only you)

| | |
|---|---|
| **URL** | `/office` **or** `/owner` |
| **Email** | whatever you set as the `OWNER_EMAIL` env var |
| **Password** | whatever you set as `OWNER_PASSWORD` |
| **If never set** | `owner@demo.school` / `owner123` ← change this today |

This is the Int-AI-lisoft console: every school, alerts, the trial-code generator,
support inbox, email status. Completely separate from any school login — school
admins get a 401 if they try to reach it.

> **Why your link kept landing on the school page:** `/office` used to have no route,
> so the server bounced it to the storefront. Fixed — both `/office` and `/owner` now
> open your console.

---

## 2 · A SCHOOL's admin (one per school — they create it themselves)

| | |
|---|---|
| **URL** | the school's own link, e.g. `/patriots-high-school` |
| **Login** | the email + password **they** chose when they registered the school |

You never hold a school's password. If a principal locks themselves out, you reset it
from your office: **Schools → Reset admin PW** — that hands you a temporary password
to send them.

---

## 3 · Teachers & students (inside one school)

| | |
|---|---|
| **URL** | their school's link, e.g. `/patriots-high-school` |
| **Login** | their own email + password |

Three ways they get an account — all from **Admin** tab in the school's console:
1. Admin adds them one at a time
2. Admin pastes/uploads a roster list
3. Admin invites them by email — they set their own password

Anyone the admin adds is pre-approved. Anyone who self-registers waits in **Approvals**.

---

## 4 · Demo accounts (seeded automatically — testing only)

Live at the demo school `/demo`:

| Role | Email | Password |
|---|---|---|
| School admin | `admin@demo.school` | `admin123` |
| Teacher | `rivera@demo.school` | `teach123` |
| Student | `maya@demo.school` | `learn123` |

These exist so you can demo the product without touching a real school. They are
**not** your owner login. Delete them before a real school uses that instance.

---

## 5 · What you hand out vs what stays secret

**Give to a school**
- Their school link (`/their-slug`)
- An access code, when you're giving a trial — minted in your office → Access codes
- Nothing else. They make their own passwords.

**Never leave your office**
- `OWNER_EMAIL` / `OWNER_PASSWORD` — your console login
- `CODE_SECRET` — signs access codes; anyone with it can mint free Pro
- `JWT_SECRET` — signs every login session
- `UPGRADE_CODE` — the permanent unlock code
- `EMAIL_USER` / `EMAIL_PASSWORD` — your Gmail + app password
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` — money
- `PARTNER_KEY` — lets Int-AI-lisoft HQ read this app's numbers

All of these live in **Render → your service → Environment**, never in the code.

---

## 6 · Quick links

| What | Where |
|---|---|
| Your office | `/office` |
| Storefront (public) | `/` |
| Demo school | `/demo` |
| Set env vars | Render → after-school-scheduler → Environment |
| Repo | github.com/WSS5480/AFTER-SCHOOL-SCHEDULER |
