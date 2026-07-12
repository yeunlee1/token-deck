-- 사용자별 기기 설정 인벤토리를 비밀값 없이 원자적 스냅샷으로 저장하는 스키마
create table public.device_setting_snapshots (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  device_id uuid not null,
  schema_version smallint not null default 1,
  content_hash text not null,
  captured_at timestamptz not null,
  items jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id),
  foreign key (user_id, device_id) references public.devices(user_id, id) on delete cascade,
  constraint device_setting_snapshots_schema_version_check check (schema_version = 1),
  constraint device_setting_snapshots_content_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint device_setting_snapshots_items_array_check check (jsonb_typeof(items) = 'array'),
  constraint device_setting_snapshots_items_count_check check (
    case when jsonb_typeof(items) = 'array' then jsonb_array_length(items) <= 512 else false end
  ),
  constraint device_setting_snapshots_items_size_check check (octet_length(items::text) <= 524288)
);

alter table public.device_setting_snapshots enable row level security;

create policy device_setting_snapshots_owner_select
  on public.device_setting_snapshots
  for select
  using (auth.uid() = user_id);

create policy device_setting_snapshots_owner_insert
  on public.device_setting_snapshots
  for insert
  with check (auth.uid() = user_id);

create policy device_setting_snapshots_owner_update
  on public.device_setting_snapshots
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

revoke all on public.device_setting_snapshots from anon, authenticated;
grant select, insert, update on public.device_setting_snapshots to authenticated;
