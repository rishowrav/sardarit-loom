-- ===========================================================================
-- SardarIT Loom — initial schema
-- Run this once in: Supabase Dashboard → SQL Editor → New query → Run
-- Safe to re-run (every statement is idempotent).
-- =========================================================================-----------

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- recordings: one row per finished/pending screen recording
-- ---------------------------------------------------------------------------
create table if not exists public.recordings (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  title            text not null default 'Untitled recording'
                   check (char_length(title) between 1 and 200),
  status           text not null default 'uploading'
                   check (status in ('uploading', 'completed', 'failed')),
  share_token      text unique,
  share_enabled    boolean not null default false,
  size_bytes       bigint not null default 0 check (size_bytes >= 0),
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  width            integer check (width is null or width > 0),
  height           integer check (height is null or height > 0),
  mime_type        text,
  r2_key           text not null,
  thumbnail_key    text,
  upload_id        text,
  error_message    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists recordings_owner_created_idx
  on public.recordings (owner_id, created_at desc);

create index if not exists recordings_owner_status_created_idx
  on public.recordings (owner_id, status, created_at asc);

-- ---------------------------------------------------------------------------
-- Row Level Security: the signed-in owner can only touch their own rows.
-- The public share view is exposed through a SECURITY DEFINER function below,
-- so anonymous visitors can never list or scan the table itself.
-- ---------------------------------------------------------------------------
alter table public.recordings enable row level security;

drop policy if exists "owner select" on public.recordings;
create policy "owner select" on public.recordings
  for select using (auth.uid() = owner_id);

drop policy if exists "owner insert" on public.recordings;
create policy "owner insert" on public.recordings
  for insert with check (auth.uid() = owner_id);

drop policy if exists "owner update" on public.recordings;
create policy "owner update" on public.recordings
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "owner delete" on public.recordings;
create policy "owner delete" on public.recordings
  for delete using (auth.uid() = owner_id);

-- keep updated_at fresh automatically
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists recordings_set_updated_at on public.recordings;
create trigger recordings_set_updated_at
  before update on public.recordings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Public sharing: anyone holding an enabled link token may read ONE row's
-- playback metadata. Tokens are long random strings; disabled/unknown tokens
-- return zero rows, which the app renders as 404.
-- ---------------------------------------------------------------------------
create or replace function public.get_shared_recording(p_token text)
returns table (
  id               uuid,
  title            text,
  size_bytes       bigint,
  duration_seconds integer,
  width            integer,
  height           integer,
  mime_type        text,
  r2_key           text,
  thumbnail_key    text,
  created_at       timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.title, r.size_bytes, r.duration_seconds, r.width, r.height,
         r.mime_type, r.r2_key, r.thumbnail_key, r.created_at
  from public.recordings r
  where r.share_token = p_token
    and r.share_enabled = true
    and r.status = 'completed'
  limit 1;
$$;

revoke execute on function public.get_shared_recording(text) from public;
grant execute on function public.get_shared_recording(text) to anon, authenticated;
