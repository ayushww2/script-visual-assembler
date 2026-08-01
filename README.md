# Script Divider

Documentary director for images-only Mystery YouTube films.

**Phase 1 (now):** Google search logic — decide which visuals can come from real Google Image Search, write entity-first queries, bundle them to beats, and preview SearchAPI hits.

## Flow

1. Paste full script **or** Whisper-aligned JSON
2. ContactBoxTools runs the documentary-director prompt
3. Get `googleSearches` packs (+ AI candidates listed, not generated yet)
4. Preview what Google actually returns via SearchAPI

## Stack

- Next.js App Router
- ContactBoxTools (`CONTACTBOX_*`)
- SearchAPI.io Google Images (`SEARCHAPI_API_KEY`)

## Local

```bash
npm install
cp .env.example .env.local
npm run dev
```

## Env

| Variable | Purpose |
|----------|---------|
| `CONTACTBOX_API_KEY` | LLM token |
| `CONTACTBOX_BASE_URL` | `https://api.contactboxtools.me/v1` |
| `CONTACTBOX_MODEL` | e.g. `gpt-5.6-terra` |
| `SEARCHAPI_API_KEY` | Google Images via SearchAPI.io |

## API

- `POST /api/divide` — `{ script, phase?: "google-first" | "full" }`
- `POST /api/search/preview` — `{ queries: string[] }`
- `GET /api/health`
