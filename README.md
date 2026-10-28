# SardarIT Loom

A private, single-user screen recorder for personal use — record your screen (720p, 1080p, or 1080p + webcam), upload it in resumable chunks to your own Backblaze B2 bucket (any S3-compatible store works — Cloudflare R2 too), and organize everything in a personal library with optional share links.

No third-party recording service: your videos live in **your** Backblaze B2 bucket and **your** Supabase project.

## Features

- **Owner-only access** — one email may sign in (`OWNER_EMAIL`); everything else is blocked by middleware (`src/proxy.ts`) and database RLS policies.
- **3 recording modes** — 720p @ 2.5 Mbps, 1080p @ 4 Mbps, 1080p + webcam picture-in-picture @ 4.5 Mbps (VP9 → VP8 → H.264 → MP4 codec fallback).
- **Pause / resume / stop / discard** — plus browser-initiated stops (the native “Stop sharing” bar), a tab-hidden warning, and a screen wake lock.
- **Chunked, resumable uploads** — 8 MB multipart chunks uploaded directly from the browser to R2 with presigned URLs; progress, retry with backoff, and crash/reload recovery via IndexedDB.
- **Personal library** — search, rename, thumbnail preview, playback, download, delete.
- **Share links** — token-based public watch pages (`/v/<token>`), enable/disable without losing the token, revoke permanently.
- **Storage quota cleanup** — when usage reaches `STORAGE_LIMIT_GB`, the oldest *completed* recordings are deleted first (down to 90% of the limit). Active or incomplete uploads are never auto-deleted.
- **Private by default** — the R2 bucket stays private; every playback/download/upload link is a short-lived presigned URL generated server-side (6 h default).

## Tech stack

| Layer     | Choice                                                   |
| --------- | -------------------------------------------------------- |
| Framework | Next.js 16 (App Router, Turbopack), React 19, TypeScript |
| Styling   | Tailwind CSS 4                                           |
| Auth + DB | Supabase (Email/password, Postgres with RLS)             |
| Storage   | Any S3-compatible store — Backblaze B2 or Cloudflare R2 — via the AWS S3 SDK (presigned URLs) |
| Uploads   | Browser → R2 multipart uploads, IndexedDB session store  |
| Tests     | Node built-in test runner + `tsx`                        |

## Architecture in one paragraph

The browser never receives storage credentials. Server routes initiate a multipart upload, hand out presigned per-part URLs, and complete the upload by reading the store's `ListParts` (never trusting client ETags); the size recorded in Postgres is verified against the store's view of the object before the row is marked `completed`. All database access runs as the signed-in owner under Row Level Security — there is **no service-role key** in this app. A public share page reads a single row through a `SECURITY DEFINER` SQL function (`get_shared_recording`) and only ever exposes a fresh presigned URL, never a bucket listing. Storage cleanup deletes objects from the bucket first and only removes database rows whose objects were fully deleted, so reported usage can never under-report reality.

## Local-only development (no login or cloud services)

Set `LOCAL_DEMO_MODE=true` in `.env.local`, then run `npm run dev` and open `http://localhost:3000`. Local mode skips sign-in and supports the recorder, chunked/resumable uploads, playback, download, rename, delete, share links, search, and storage quota cleanup without contacting Supabase or R2. Recording metadata is kept in `data/local/recordings.json`; videos, upload parts and thumbnails are stored in `data/local/` on the development machine. This directory is git-ignored. Local mode is guarded by `NODE_ENV=development` and is not enabled by production builds.

### 1. Supabase (auth + database)

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste the entire contents of [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql), and run it. (Idempotent — safe to re-run.) It creates the `recordings` table, RLS policies, an `updated_at` trigger, and the `get_shared_recording(p_token)` function.
3. **Authentication → Users → Add user**: create the owner account (email + password, auto-confirm). This must match `OWNER_EMAIL` later.
4. **Disable public sign-ups** (wording varies: *Authentication → Providers → Email → Enable sign-ups*, or *Authentication → Settings*). The app is single-user; sign-ups should be off.
5. Copy **Project URL** and **anon public key** from *Project Settings → API*.

### 2. Backblaze B2 (video storage)

Any S3-compatible store works; B2 is the configured default.

1. *Create bucket* — name it (e.g. `sardarit-loom`), **private** (no public access needed). Note the bucket's **Region/Endpoint** (e.g. `https://s3.us-west-004.backblazeb2.com`, region `us-west-004`).
2. *Account → Application Keys → Add a new key* — **scope it to this bucket** with file Read / Write / Delete (and List) capabilities. Copy the **key ID** and the **application key** (shown once).
3. **CORS** — the browser PUTs chunks and streams playback cross-origin, so the bucket must allow your origins. With the [B2 CLI](https://www.backblaze.com/docs/cloud-storage-enable-cors-with-the-cli):

```bash
b2 authorized-account <key-id> <application-key>   # needs writeBucketCors (e.g. a master key)
b2 update-bucket --cors-rules '[
  {
    "corsRuleName": "sardarit-loom",
    "allowedOrigins": ["http://localhost:3000", "https://your-domain.example"],
    "allowedHeaders": ["*"],
    "allowedOperations": ["s3_get", "s3_put", "s3_head"],
    "maxAgeSeconds": 3600
  }
]' sardarit-loom
```

(Alternatively: B2 web console → bucket → *CORS rules* → choose the **S3-compatible API**, if shown on your console, and enter the same rule.)

Without CORS, chunk uploads fail with a preflight error in the browser console.

### 3. Environment variables

```bash
cp .env.example .env.local
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anon (public) key |
| `OWNER_EMAIL` | ✅ strongly recommended | The only email allowed to use the app |
| `R2_ENDPOINT` | ✅ for B2 | S3 endpoint, e.g. `https://s3.us-west-004.backblazeb2.com` |
| `R2_REGION` | ✅ for B2 | SigV4 region matching the bucket (e.g. `us-west-004`); defaults to `auto` (Cloudflare R2) |
| `R2_ACCESS_KEY_ID` | ✅ | B2 application key ID (or R2 access key) |
| `R2_SECRET_ACCESS_KEY` | ✅ | B2 application key (or R2 secret) — **secret**, never expose |
| `R2_BUCKET` | ✅ | Private bucket name |
| `R2_ACCOUNT_ID` | alternative | Cloudflare R2 only — builds the endpoint when `R2_ENDPOINT` is unset |
| `R2_FORCE_PATH_STYLE` | optional | `true` forces `endpoint/bucket/key` URLs if a store rejects virtual-hosted style |
| `STORAGE_LIMIT_GB` | optional (20) | Quota in gigabytes; cleanup triggers at 100% and frees to 90% |
| `CHUNK_SIZE_MB` | optional (8) | Upload chunk size (R2 multipart minimum: 5) |
| `PRESIGN_TTL_SECONDS` | optional (21600) | Lifetime of playback/upload links (6 h) |

Only `NEXT_PUBLIC_*` variables reach the browser.

### 4. Run

```bash
npm install
npm run dev        # http://localhost:3000
```

For the cloud-backed mode, sign in with the owner account you created in Supabase, then open **Record**. To develop locally without a login or cloud services, see [Local-only development](#local-only-development-no-login-or-cloud-services).

### 5. Production deploy (e.g. Vercel)

1. Push the repository and import it into your host.
2. Set the same environment variables from `.env.example` in the host's project settings.
3. Deploy. Notes:
   - Video bytes go **browser → R2** directly; serverless request/body limits don't affect uploads.
   - `src/proxy.ts` runs as middleware on every request (Next 16 convention — not `middleware.ts`).
   - HTTPS is mandatory for screen capture (`getDisplayMedia`), which any real deployment has.

## Scripts

```bash
npm run dev      # dev server (Turbopack)
npm run build    # production build (type-checks; needs env vars or at least runs routes dynamically)
npm run start    # serve the production build
npm run lint     # eslint (flat config, eslint-config-next incl. react-hooks rules)
npm test         # unit tests: planCleanup, R2 presigning, part math, formatters
npx tsc --noEmit # standalone type-check
```

## Project structure

```
supabase/migrations/0001_init.sql   # schema + RLS + share RPC (run once)
src/proxy.ts                        # auth gate: session refresh, single-owner enforcement
src/lib/
  env.ts / config.ts / types.ts     # server env, modes/bitrates, shared types
  supabase/                         # browser/server clients + owner helpers
  r2.ts                             # any S3-compatible store (B2/R2): multipart + presigning
  storage-cleanup.ts                # pure planCleanup() + runStorageCleanup()
  share.ts / api.ts                 # share tokens, API helpers
  recording/                        # codecs, capture, canvas compositor, engine
  upload/                           # IndexedDB sessions + chunked uploader
src/app/
  login/ library/ record/ recordings/[id]/ settings/   # owner pages
  v/[token]/                        # public share player (no sign-in)
  api/...                           # uploads, recordings, share, storage, health
src/components/                     # UI (RecorderStudio, VideoPlayer, cards, toasts…)
tests/                              # unit tests (node:test via tsx)
```

## Security model

- **Auth**: `src/proxy.ts` refreshes the session, allows only `/login`, `/v/*` and two API paths anonymously, and rejects any signed-in user whose email ≠ `OWNER_EMAIL`.
- **Database**: RLS policies restrict `recordings` to the owner's own rows; the public share path goes through a `SECURITY DEFINER` function that matches an enabled token and returns exactly one row. The anon key is safe to expose.
- **Storage**: bucket stays private; the browser only ever sees short-lived presigned URLs scoped to a single object/part.
- **Secrets**: `R2_SECRET_ACCESS_KEY` (storage key) and everything non-`NEXT_PUBLIC_` stays server-side.

## Known limitations

- **Background tabs** can freeze captured frames (browser throttling). The app warns you while recording and holds a screen wake lock, but keep the tab visible.
- **Codec availability varies by browser.** Chromium is the best-tested path; Firefox/Safari may fall back to VP8 or H.264/MP4, which changes the container extension of the stored file (chosen automatically from the recorder's MIME type).
- **Resume is per-browser.** Interrupted uploads are stored in IndexedDB of the browser that started them — another device can't pick them up.
- **Single user by design.** No teams, no per-share passwords, no analytics.
- **Practical length limits** come from the browser/device (memory), not from the app — there is no artificial time cap.
