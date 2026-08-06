-- DemoBro jobs queue + delivery metadata (service_role only).
-- Columns match src/lib/jobs.ts, worker/src/upload.js, and cron/src/index.js.

create table if not exists public.jobs (
  id uuid primary key,
  ip_hash text not null,
  live_url text not null,
  repo_url text not null,
  title text not null default '',
  description text not null default '',
  stack_badges text[] not null default '{}'::text[],
  storyboard jsonb not null default '{"steps":[]}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'recording', 'rendering', 'ready', 'failed')),
  stage text,
  output_path text,
  error_message text,
  bytes_stored bigint,
  claimed_at timestamptz,
  claimed_by text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_status_created_at_idx
  on public.jobs (status, created_at asc);

create index if not exists jobs_expires_at_idx
  on public.jobs (expires_at)
  where expires_at is not null;

alter table public.jobs enable row level security;

-- Intentionally no anon/authenticated policies.
-- App + worker + cron use the service_role key (bypasses RLS).
