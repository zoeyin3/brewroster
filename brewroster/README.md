# Brewroster

Rostering for small independent cafes. One Supabase project = one cafe. Plain HTML, CSS and JavaScript. No build step.

- The front page asks who you are: **Employee portal** or **Owner portal**. An owner account is turned away from the employee portal and the other way round.
- Both portals work on a laptop and on a phone. On a laptop each role gets a left sidebar. On a phone each role gets a top bar (with a role badge and Sign out) and tabs along the bottom. Add it to a phone's home screen for an app-like feel.
- **Owner**: Home, Roster, Leave, Cover, Demand, Team.
- **Employees** see four things only: **Roster** (their shifts and the whole team), **Chat** (team chat, with open shifts anyone can register for), **Leave** (requests) and **Standby** (put their name down for standby days and answer calls).
- **Rosterbot** builds each week from POS history, weather, events and school terms, and the owner approves and uploads it.

Rules enforced in the database (not just the screen):

- Leave needs at least 14 days notice and is decided before a roster is uploaded.
- Rosters are uploaded weekly. Uploaded rosters are confirmed and cannot include anyone on approved leave.
- Cancelling a shift more than 48 hours ahead posts it to the team chat. Anyone can register, first come first served, normal pay.
- Chat shifts nobody has taken by 48 hours out move to Standby.
- Standby is for day shifts within 48 hours only.
- **Late opt-out alert (owner only).** When one person opts out of 3 shifts in a calendar month with under 48 hours notice (each one sent to standby), the owner gets a single alert on Home and in Shift cover, with the events, who covered, and an estimated cost. Later events update the same alert. The owner can mark an event as excused (it stops counting; the alert closes if the count falls below 3), add a note, keep watching or dismiss. The threshold and notice window are editable on the Team page. It never contacts, penalises or changes the roster or hours of anyone, and employees cannot see it. Every counted event, excuse and alert action is kept in an audit log (`late_audit`).

## 1. Create the Supabase project

1. Go to supabase.com, create a project (any region, note the database password).
2. Open **SQL editor**, paste all of `supabase/schema.sql`, run it.
3. Optional: run `supabase/seed.sql` to load the sample cafe ("Little Wren Coffee"). You can also load it from the owner's first-run screen.
4. **Authentication, Providers, Email**: for a quick demo turn **Confirm email** off. For real use keep it on (see Security).
5. **Project Settings, API**: copy the **Project URL** and the **anon public** key. Never use the `service_role` key anywhere in this app.

## 2. Deploy to Vercel

1. Put this folder in a GitHub repo and import it in Vercel (or run `vercel` from this folder).
2. Framework preset: **Other**. Build command: none. Output directory: leave empty (the root is served).
3. Add environment variables (Settings, Environment Variables):
   - `SUPABASE_URL` = your Project URL
   - `SUPABASE_ANON_KEY` = your anon public key
4. Deploy. `api/config.js` hands those two values to the browser.

If you skip step 3, the app shows a setup screen where you can paste the URL and key. They are kept in that browser only.

## 3. First sign in

1. Open the site, choose **Owner portal**, then **Create the owner account**. Only the Owner portal can create the first account, and only while there is no owner. Do this yourself straight after deploying.
2. Choose **Load sample data** or **Start with my own cafe** and add your team on the Team page.
3. Employees choose **Employee portal**, then **Create an account** with the **same email** the owner entered for them. They are linked automatically. The employee portal does not allow sign-up until the owner exists. If the owner adds the email later, the employee taps "Check again" on the waiting screen.

Sample staff use emails like `maya@littlewren.example`.

## Run locally

```
python3 -m http.server 8080
```

Open http://localhost:8080. There is no `/api/config` locally, so use the setup screen (or put the values in `js/config.js`).

## Security notes

- The anon key is meant to be public. Data is protected by row level security in `schema.sql`: employees only see their own private details, the POS history and cover requests are owner-only, and employees change data only through the checked functions.
- Anyone who signs up with an email listed on the Team page is linked to that person. With **Confirm email** off, someone could claim a sample email. Before real use, replace the sample emails and turn Confirm email on.
- Only one owner exists. Once there is one, the Owner portal offers no sign-up, and the database refuses a second owner.
- The portal choice is a convenience on top of the real rule: what each person can see and do comes from their role in the database, not from which door they used.

## Good to know

- Standby is a volunteer list (the days someone is happy to be called). It does not need approval; the owner calls from the Cover page.
- Employees can no longer edit their working hours in the app (the owner does that on the Team page).
- Screens refresh by polling every 20 seconds. There are no push or email notifications yet.
- Weather comes from Open-Meteo once a day and falls back to sample values if it cannot be reached. Public events and school terms are entered on the Demand page.
- Supabase returns at most 1000 rows per request by default. That is plenty for one cafe's POS history of hourly totals.

## Files

- `index.html`, `css/app.css`: shell and styles
- `js/sb.js`: small Supabase client (auth + data API over fetch)
- `js/logic.js`: demand model and roster optimiser
- `js/data.js`: loading/saving between Supabase and the screens
- `js/owner.js`, `js/employee.js`, `js/app.js`: the two apps and sign-in/boot
- `supabase/schema.sql`: tables, security rules, functions, sample-data function
- `supabase/tests/`: SQL scenarios for the rules (run on plain Postgres with `supabase_stub.sql` first)
