-- 사용자별 기기와 토큰 사용량을 격리 저장하는 초기 스키마
create table public.devices (
  id uuid not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  platform text not null,
  app_version text not null,
  last_seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table public.projects (
  id text not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  git_remote_hash text,
  local_project_hash text,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint projects_identity_present check (git_remote_hash is not null or local_project_hash is not null)
);

create unique index projects_git_remote_unique
  on public.projects (user_id, git_remote_hash)
  where git_remote_hash is not null;
create unique index projects_local_hash_unique
  on public.projects (user_id, local_project_hash)
  where git_remote_hash is null and local_project_hash is not null;

create table public.sessions (
  id text not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  device_id uuid not null,
  project_id text,
  provider text not null check (provider in ('openai', 'anthropic', 'google', 'codex', 'claude', 'gemini')),
  external_id text not null,
  title text,
  started_at timestamptz not null,
  ended_at timestamptz,
  primary key (user_id, id),
  unique (user_id, provider, device_id, external_id),
  foreign key (user_id, device_id) references public.devices(user_id, id) on delete cascade,
  foreign key (user_id, project_id) references public.projects(user_id, id)
);

create table public.usage_events (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_id text not null,
  provider text not null check (provider in ('openai', 'anthropic', 'google', 'codex', 'claude', 'gemini')),
  source text not null check (source in ('local_session', 'provider_api', 'cloud_billing')),
  device_id uuid not null,
  session_id text,
  project_id text,
  model text,
  occurred_at timestamptz not null,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  cached_tokens bigint not null default 0 check (cached_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  reasoning_tokens bigint not null default 0 check (reasoning_tokens >= 0),
  tool_tokens bigint not null default 0 check (tool_tokens >= 0),
  session_title text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id),
  foreign key (user_id, device_id) references public.devices(user_id, id) on delete cascade,
  foreign key (user_id, session_id) references public.sessions(user_id, id),
  foreign key (user_id, project_id) references public.projects(user_id, id)
);

create index usage_events_occurred_at_idx on public.usage_events (user_id, occurred_at desc);
create index usage_events_project_idx on public.usage_events (user_id, project_id, occurred_at desc);

create table public.sync_checkpoints (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  device_id uuid not null,
  source text not null,
  cursor jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id, source),
  foreign key (user_id, device_id) references public.devices(user_id, id) on delete cascade
);

alter table public.devices enable row level security;
alter table public.projects enable row level security;
alter table public.sessions enable row level security;
alter table public.usage_events enable row level security;
alter table public.sync_checkpoints enable row level security;

create policy devices_owner_all on public.devices for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy projects_owner_all on public.projects for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy sessions_owner_all on public.sessions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy usage_events_owner_all on public.usage_events for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy sync_checkpoints_owner_all on public.sync_checkpoints for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

revoke all on public.devices, public.projects, public.sessions, public.usage_events, public.sync_checkpoints from anon;
grant select, insert, update, delete on public.devices, public.projects, public.sessions, public.usage_events, public.sync_checkpoints to authenticated;
