# School Classes & Afterschool Programs Scheduler

A working multi-school scheduler: students reserve spots in classes and afterschool programs,
teachers take attendance, admins approve accounts and run everything.

**Live app:** deployed via Render (Docker). The old clickable mockup is kept at `/mockup`.

## Demo accounts (seeded on first run)

| Role    | Email              | Password |
|---------|--------------------|----------|
| Admin   | admin@demo.school  | admin123 |
| Teacher | rivera@demo.school | teach123 |
| Student | maya@demo.school   | learn123 |

Change or remove these once real accounts exist (Admin → Datasets).

## How it works

- Students & teachers sign up from the landing page → land in the admin **Approvals** queue.
- Approved students see a rolling calendar (window length set by admin, default 14 days):
  green = open (tap to reserve), grey = full (tap to waitlist, auto-promoted when a spot opens),
  blue = reserved (locked until cancelled). Overlapping reservations are blocked.
- Past sessions show ✔ attended / ✘ no-show; the attendance % score is top-right.
  Below the admin-set threshold, booking becomes waitlist-only.
- Teachers open any session for its roster and must mark every student present/absent.
- Admins: approvals, programs/students/teachers datasets, school branding + photo uploads,
  and settings (window, threshold, limitation, auto-promotion).

## Files

```
server.js     # API + static server (Express + SQLite)
index.html    # the app UI (all four views)
mockup.html   # original approved mockup, served at /mockup
package.json  # dependencies
Dockerfile    # Render Docker deploy
```

## Important: data persistence

SQLite lives on the service's disk. On Render's **free tier the disk is ephemeral** —
data resets on every deploy/restart. Fine for trials; before real use either
add a Render persistent disk (set `DB_PATH` to the mount) or ask Claude to wire up Postgres.

Also set a strong `JWT_SECRET` environment variable in Render for production.
