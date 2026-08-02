# Script Divider

Documentary director for Mystery YouTube films — Google/AI stills, optional Pexels B-roll clips.

## Flow

1. Paste full script **or** Whisper-aligned JSON
2. Job is queued on Railway and runs in the background
3. ContactBoxTools builds entity-first Google packs (+ AI candidates)
4. SearchAPI previews each query and stores results in Postgres
5. Optional: Pexels landscape clips (~4–5s use, looped) on place/B-roll scenes
6. Remotion package uploaded to R2 (`imageUrl` + optional `videoUrl`)

## Stack

- Next.js App Router
- Postgres (Prisma)
- ContactBoxTools
- SearchAPI.io Google Images
- OpenAI gpt-image-2 (AI stills)
- Pexels Videos API (optional B-roll)

## Local

```bash
npm install
cp .env.example .env
npx prisma migrate dev
npm run dev
```

Set `PEXELS_API_KEY` (free at https://www.pexels.com/api/) to enable short clips.

## API

- `GET /api/jobs` — list past jobs + daily capacity
- `POST /api/jobs` — queue a job (`{ script, title?, phase? }`)
- `GET /api/jobs/:id` — job detail / progress / results
- `POST /api/jobs/:id/retry` — re-queue a failed job
- `GET /api/health`
