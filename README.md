# Ops Center — standalone version

Same app you've been using, rebuilt as a real (tiny) web app: one Node.js server,
one Postgres database. Code and data are now fully separate — deploying a new
version of the code never touches the data in the database.

No build step. No framework tooling. Just Node + Express + Postgres, and a
single static HTML page for the frontend.

## What you need first

- A free [Railway](https://railway.app) account (recommended — has a built-in
  Postgres you can add in one click, and a generous free usage tier). Render
  or Fly.io work too, but the steps below assume Railway since it's the
  simplest path from zero.
- [Node.js](https://nodejs.org) installed on your machine (v18+), so you can
  test locally first if you want.
- A [GitHub](https://github.com) account, since Railway deploys from a repo.

## 1. Get the code into a GitHub repo

```bash
cd ops-center-app
git init
git add .
git commit -m "Ops Center"
```
Create a new empty repo on GitHub, then:
```bash
git remote add origin https://github.com/YOUR_USERNAME/ops-center.git
git branch -M main
git push -u origin main
```

## 2. Create the Railway project

1. Go to [railway.app](https://railway.app) → New Project → **Deploy from GitHub repo** → pick the repo you just pushed.
2. In the same project, click **+ New** → **Database** → **Add PostgreSQL**.
   Railway automatically wires a `DATABASE_URL` environment variable into your
   app's service — you don't need to copy/paste anything.
3. Click into your app's service → **Variables** tab → add:
   - `OPS_USER` — a username for your team (e.g. `crew`)
   - `OPS_PASS` — a real password (this is a basic shared login gate, not
     per-person accounts — good enough for a small trusted team, not for
     anything public-facing)
4. Railway will build and deploy automatically. Once it's live, click
   **Settings → Networking → Generate Domain** to get a public URL.

That URL is now permanent. Every time you ask me for a new feature and push
the updated code, Railway redeploys **that same URL** — the database is a
separate service that's never touched by a code deploy. No more export/import
dance.

## 3. Set up file storage (Cloudflare R2) — needed for receipt photos & project files

Receipts and project photos/files upload to a Cloudflare R2 bucket (S3-compatible,
free tier is generous — 10GB storage/month free). The app works fine without
this configured, it just disables photo/file uploads until you add it.

1. Sign up at [cloudflare.com](https://dash.cloudflare.com) (free) → **R2 Object Storage** in the sidebar.
2. **Create bucket** → give it a name (e.g. `ops-center-files`).
3. Open the bucket → **Settings** → **Public access** → enable it. Copy the
   `r2.dev` public URL shown there (e.g. `https://pub-xxxxxxxx.r2.dev`) — this
   is your `S3_PUBLIC_URL_BASE`.
4. Back in the R2 dashboard → **Manage R2 API Tokens** → **Create API Token**
   → permission: **Object Read & Write**, scoped to your bucket. Copy the
   **Access Key ID**, **Secret Access Key**, and the **Endpoint URL** shown
   (looks like `https://<account-id>.r2.cloudflarestorage.com`).
5. In Railway → your app's **Variables** tab, add:
   - `S3_ENDPOINT` = the endpoint URL from step 4
   - `S3_BUCKET` = your bucket name
   - `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` = from step 4
   - `S3_PUBLIC_URL_BASE` = the `r2.dev` URL from step 3 (no trailing slash)
6. Railway redeploys automatically when you save variables. Uploads should
   now work — try attaching a receipt photo to a test expense.

## 4. Testing locally before you deploy (optional but recommended)

```bash
npm install
cp .env.example .env
# edit .env with a local Postgres connection string, or use Railway's DATABASE_URL directly
npm start
```
Then open `http://localhost:3000`.

## 5. Making future updates

1. Come back to Claude, ask for the change.
2. I'll hand you the updated file(s).
3. Replace them in your local repo folder, then:
   ```bash
   git add .
   git commit -m "describe the change"
   git push
   ```
4. Railway redeploys automatically. Your data is untouched — it never left the database.

## Notes on this version vs. the artifact

- **Auth:** one shared username/password for the whole team (Basic Auth).
  It's not per-person accounts, and there's no audit trail of who changed
  what — same limitation as before, just now it's at least not a fully public
  link.
- **Data:** stored as one JSON blob in a single Postgres row (table
  `ops_data`), same shape the app has always used. This was the fastest,
  lowest-risk way to get you off artifact storage. If the team grows or you
  want per-job history/permissions later, this is the point where a real
  relational schema (separate `jobs`, `tasks`, `appointments`, `expenses`
  tables) would be the next upgrade — worth a fresh conversation with Claude
  Code when you get there.
- **P&L:** each job now has an Expenses tab (Labor / Materials / Other,
  each with an optional receipt photo) and a Files tab (project photos and
  documents). Revenue is pulled from the job's estimate amount — if the
  actual contract value differs from the original estimate, just update
  that number and the P&L recalculates. There's also a portfolio-wide P&L
  strip on the main dashboard summing revenue/expenses/profit across every job.
- **File storage:** receipts and project files go to Cloudflare R2 (or any
  S3-compatible bucket), not the database — keeps Postgres small and fast
  even with lots of large photos. See section 3 above for setup.
- **Export/Import buttons:** kept them in the app even though they're no
  longer strictly necessary for deploys — still useful as a manual backup
  before any risky change.

## Coming next: in-app takeoffs (replacing Vertigraph)

**This is now built.** Each job has a **Takeoff** tab:
- Upload plan sheets (PDF or image) — PDFs render their first page automatically
- **Calibrate**: click two points spanning a known real-world distance, enter that distance in feet, and the sheet's scale is set
- **Line**: click points along a run, Finish, label it — gives total length in feet
- **Area**: click points around a shape, Finish, label it — gives area in square feet
- **Count**: click to drop a pin per item, Finish, label it — gives an item count
- All measurements summarize into a quantities list at the bottom of the tab, grouped by label

Limitations worth knowing:
- **Multi-page PDFs**: only page 1 renders. If a plan set has multiple sheets, upload each page as a separate file (split the PDF first, or export each sheet individually).
- **No 3D earthwork**: this covers 2D linear/area/count takeoffs only — not cut/fill volume calculations like SiteWorx/OS does. That would be a much larger separate project.
- **Scale is per-sheet**: if a plan set has sheets at different scales, calibrate each one individually.

### One extra setup step: enable CORS on your R2 bucket for PDFs

Images display fine without this, but PDF rendering (via pdf.js) fetches the
file directly from R2 in the browser, which requires CORS to be allowed. In
the Cloudflare dashboard: your R2 bucket → **Settings** → **CORS Policy** → add:
```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"]
  }
]
```
(You can restrict `AllowedOrigins` to your actual Railway domain instead of
`*` once it's live, for tighter security.)

