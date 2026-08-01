# Script Divider

Documentary director for images-only Mystery YouTube films.

**Phase 1:** Google search logic with cloud background jobs.

## Flow

1. Paste full script **or** Whisper-aligned JSON
2. Job is queued on Railway and runs in the background
3. ContactBoxTools builds entity-first Google packs (+ AI candidates)
4. SearchAPI previews each query and stores results in Postgres
5. Open past jobs anytime from the sidebar

Sized for ~**30–40 Google query previews / day** (soft limit, one job at a time).

## Stack

- Next.js App Router
- Postgres (Prisma)
- ContactBoxTools
- SearchAPI.io Google Images

## Local

```bash
npm install
cp .env.example .env
npx prisma migrate dev
npm run dev
```

## API

- `GET /api/jobs` — list past jobs + daily capacity
- `POST /api/jobs` — queue a job (`{ script, title?, phase? }`)
- `GET /api/jobs/:id` — job detail / progress / results
- `POST /api/jobs/:id/retry` — re-queue a failed job
- `GET /api/health`
