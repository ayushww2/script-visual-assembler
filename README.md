# Script Visual Assembler

Clean Railway deploy for assembling documentary visuals from scripts, powered by [ContactBoxTools](https://api.contactboxtools.me).

## Stack

- Next.js App Router (TypeScript)
- ContactBoxTools (OpenAI-compatible API)
- Railway + Nixpacks

## Local

```bash
npm install
cp .env.example .env.local
# set CONTACTBOX_API_KEY
npm run dev
```

## Env

| Variable | Purpose |
|----------|---------|
| `CONTACTBOX_API_KEY` | ContactBoxTools token |
| `CONTACTBOX_BASE_URL` | Default `https://api.contactboxtools.me/v1` |
| `CONTACTBOX_MODEL` | Default `gpt-5.6-terra` |

`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` are accepted as aliases.

## Endpoints

- `GET /api/health` — service + config status
- `GET /api/contactbox/status` — live models probe

## Deploy

```bash
railway up
```
