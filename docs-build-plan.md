# School Classes & Afterschool Programs Scheduler — Build Plan

**For approval by:** Steve
**Date:** August 11, 2026
**Scope:** Multi-school web application with four builds — Landing Page, Student View, Teacher View, Admin View.

---

## 1. How the app works (plain-English summary)

A school (or multiple school locations under one district account) runs classes and afterschool programs. Students create accounts and, once approved by an admin, reserve spots in sessions on a rolling two-week calendar window. Teachers see their rosters and take attendance during class. Admins brand the site, manage all data, approve accounts, and set the rules (window length, attendance threshold, capacities).

---

## 2. Core rules (locked from your spec)

1. **Account approval gate** — Students and teachers self-register, but cannot do anything (reserve, teach) until an admin approves the account. Unapproved users see a "pending approval" screen.
2. **Booking window** — Default view is *this week + next week* (14 days). Window length is editable by the admin. Students may browse other dates but can only reserve within the window.
3. **Availability colors** — Open sessions show **green**; full sessions show **no color** (grey). Students can reserve green sessions, or join the **waitlist** on full ones.
4. **Reservation lock** — Once reserved, a session shows as locked for that student unless they cancel. Cancelling frees the seat, and the first waitlisted student is auto-promoted (with a notification).
5. **No class-count limit** — A student may sign up for unlimited classes inside the window, **but overlapping time slots are blocked**. The system checks day + start/end time of every reservation and rejects conflicts with a clear message showing which class conflicts.
6. **Attendance history** — Past dates show only sessions the student had reserved: **green check** = attended, **red X** = no-show.
7. **Attendance score** — Top-right of the student page: percentage = attended ÷ reserved (past sessions). Below the admin-set threshold (e.g., 80%), limitations kick in (e.g., can only book 1 day ahead, or waitlist-only). The exact limitation is an admin setting.
8. **Multi-school** — Every record (user, class, session, photo, setting) belongs to a school location. Admins can manage one school or all schools in their district. Students/teachers pick their school at sign-up.

---

## 3. Data model

- **School** — name, logo, colors, photos, settings (booking window days, attendance threshold %, limitation rule).
- **User** — role (student / teacher / admin), school, name, email, grade (students), status (pending / approved / suspended).
- **Program** — a class or afterschool program: name, type (class vs. afterschool — set by admin at creation), description, teacher(s), location/room, capacity, days of week, time slot, start date, end date, photo.
- **Session** — one dated occurrence of a program (generated from its days-of-week within the date range).
- **Reservation** — student + session, status: reserved / waitlisted (with position) / cancelled / attended / no-show.
- **Photo** — admin-uploaded marketing images tied to a school.

---

## 4. The four builds

### Build 1 — Landing Page
- School name + logo at top (pulled from the school's branding settings — each school location gets its own landing page or a school picker).
- Photo hero/carousel of admin-uploaded marketing images (chess club, track, robotics…).
- **Login dropdown**: Student / Teacher / Admin.
- **Sign Up for Account** flow: choose school → choose role (student/teacher) → basic info → lands in "pending admin approval" state.
- Program showcase strip so visitors see what's offered before logging in.

### Build 2 — Student View
- **First-login welcome banner** explaining how reservations work (dismissable, shown until first reservation).
- **Attendance score** top-right with threshold warning state.
- **This Week / Next Week calendar** (default; date-range picker to change). Each day cell lists sessions: green = open (tap to reserve), grey = full (tap to waitlist), blue/locked = already reserved (tap to cancel).
- **Program directory** listing every class/afterschool program with type badge, days available, and date range.
- **Past dates**: only their own reservations, with ✓ / ✗ marks.
- **Conflict guard**: reserving a session that overlaps an existing reservation is blocked with an explanatory message.

### Build 3 — Teacher View
- Same calendar layout, filtered to the sessions they teach; green = full roster indicator.
- **Tap a session → roster** with student list, capacity, and waitlist.
- **Attendance mode** during class time: check off each student (present / absent), saved to records. Unmarked students prompt a reminder before closing.
- *Creative additions (proposed):* roster print/export button; per-student attendance % visible to the teacher; session notes field; "message my roster" announcement box; low-attendance flags next to at-risk students.

### Build 4 — Admin View
- **School switcher** (multi-location) + "All Schools" district rollup.
- **Branding tab**: edit school name(s), upload/reorder marketing photos, preview the landing page live.
- **Datasets tab**: three tables — Teachers, Students (main roster), Programs/Classes. Each supports: view, add, edit, delete, and **CSV import** (so admins can upload existing rosters) or build from scratch by hand.
- **Approvals queue**: pending student and teacher accounts with approve/reject; approving a teacher includes assigning (or letting them pick) the program(s) they'll instruct.
- **Settings tab**: booking window length, attendance threshold %, what limitation applies under threshold, waitlist auto-promotion on/off.
- **Dashboard**: headline numbers — enrollments this window, fill rates, attendance rate, pending approvals.

---

## 5. Build order (step-by-step for approval)

**Phase 0 — Mockups & sign-off** *(this deliverable)*
Clickable HTML mockups of all four views; you approve or redline.

**Phase 1 — Foundation (week 1)**
Project setup, database with the model above, authentication with three roles, school-scoping of every record, seed data for one demo school.

**Phase 2 — Admin core (week 2)**
Branding + photos, the three datasets with add/edit/delete + CSV import, settings, approvals queue. (Admin comes early because everything else depends on its data.)

**Phase 3 — Landing page (week 2–3)**
Public page driven by the admin's branding, login + sign-up flows, pending-approval state.

**Phase 4 — Student booking engine (week 3–4)**
Calendar with window logic, reserve/cancel/waitlist with auto-promotion, overlap safeguard, attendance score + threshold limitation, past-date history.

**Phase 5 — Teacher tools (week 4–5)**
Teacher calendar, rosters, attendance check-off, teacher extras.

**Phase 6 — Multi-school + polish (week 5–6)**
School switcher, district rollup, notifications (waitlist promotion, approval emails), mobile responsiveness pass, testing with real rosters.

Each phase ends with a working demo for your review before the next begins.

---

## 6. Suggested tech stack (for the real build)

Web app: **Next.js (React)** front end, **PostgreSQL** database, hosted on Vercel/Supabase or similar — fast to build, cheap to run, works on phones and school Chromebooks. Authentication via email/password with optional Google sign-in. (Happy to adjust if you have a stack preference.)

---

## 7. Open questions for you

1. Should each school location get its own web address (e.g., `lincoln.yourapp.com`) or one site with a school picker?
2. Do parents ever need accounts (to book for younger students), or is it always the student booking?
3. When a student falls below the attendance threshold, what should the limitation be — waitlist-only, booking frozen until admin resets, or reduced booking window? (Mockup assumes waitlist-only.)
4. Should teachers be allowed to create their own classes pending admin approval, or is class creation admin-only? (Mockup assumes admin-only.)
