-- Call Lagao initial schema. Plain Postgres SQL (also runs on embedded PGlite for dev/tests).

create table organizations (
  id                text primary key,
  name              text not null,
  webhook_url       text,
  webhook_secret    text not null,
  concurrency_limit integer not null default 10,
  created_at        timestamptz not null default now()
);

create table users (
  id            text primary key,
  email         text not null unique,
  name          text,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table memberships (
  org_id     text not null references organizations(id) on delete cascade,
  user_id    text not null references users(id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table sessions (
  token_hash text primary key,              -- sha256 of the cookie value; the raw token is never stored
  user_id    text not null references users(id) on delete cascade,
  org_id     text not null references organizations(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table api_keys (
  id           text primary key,
  org_id       text not null references organizations(id) on delete cascade,
  name         text not null,
  key_hash     text not null unique,         -- sha256 of the key; shown to the user once
  key_prefix   text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create table agents (
  id                text primary key,
  org_id            text not null references organizations(id) on delete cascade,
  name              text not null,
  latest_version    integer not null default 0,
  published_version integer,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index agents_org_idx on agents (org_id, updated_at desc);

create table agent_versions (
  agent_id     text not null references agents(id) on delete cascade,
  version      integer not null,
  base_version integer,
  is_published boolean not null default false,
  title        text,
  config       jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (agent_id, version)
);

create table calls (
  id                   text primary key,       -- also the LiveKit room name
  org_id               text not null references organizations(id) on delete cascade,
  agent_id             text not null references agents(id),
  agent_version        integer not null,
  call_type            text not null check (call_type in ('web_call', 'phone_call')),
  direction            text check (direction in ('inbound', 'outbound')),
  from_number          text,
  to_number            text,
  status               text not null default 'registered'
                         check (status in ('registered', 'ongoing', 'ended', 'not_connected', 'error')),
  disconnection_reason text,
  dynamic_variables    jsonb not null default '{}',
  collected_variables  jsonb not null default '{}',
  metadata             jsonb not null default '{}',
  transcript           jsonb not null default '[]',
  latency              jsonb not null default '{}',
  usage                jsonb,
  cost                 jsonb,
  analysis             jsonb,
  recording_url        text,
  error_message        text,
  started_at           timestamptz,
  ended_at             timestamptz,
  duration_ms          integer,
  created_at           timestamptz not null default now()
);
create index calls_org_idx on calls (org_id, id desc);
create index calls_active_idx on calls (org_id, status) where status in ('registered', 'ongoing');

create table webhook_deliveries (
  id          text primary key,
  org_id      text not null references organizations(id) on delete cascade,
  call_id     text,
  event       text not null,
  url         text not null,
  attempt     integer not null,
  status_code integer,
  error       text,
  duration_ms integer,
  created_at  timestamptz not null default now()
);
create index webhook_deliveries_call_idx on webhook_deliveries (call_id);
