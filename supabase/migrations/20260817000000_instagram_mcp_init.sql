-- instagram-mcp initial schema
--
-- team_members: one row per person. The bearer token (stored only as a hash)
-- identifies the person, and the person maps to exactly one Instagram account.
-- No tool ever accepts an Instagram account id as a parameter.
--
-- posts: append-only publish log with idempotency state so a failed carousel
-- run can be resumed without duplicating containers or posts.

create table team_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  token_hash text not null unique,
  ig_user_id text not null,
  ig_username text not null,
  ig_access_token_encrypted text not null,
  ig_token_expires_at timestamptz not null,
  revoked_at timestamptz,
  -- Set when the 30-day refresh cron hits a permanent failure (revoked access,
  -- account type change). Surfaced through check_token_health; never retried
  -- blindly forever.
  refresh_failed_at timestamptz,
  refresh_error text,
  created_at timestamptz default now()
);

create table posts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references team_members(id),
  ig_media_id text,
  permalink text,
  caption text,
  image_urls text[],
  idempotency_key text unique,
  status text not null,            -- pending | published | failed
  container_ids text[],            -- child container ids, persisted as created
  -- The carousel parent (or single-image) container id. Kept separate from
  -- container_ids because retrying media_publish with the same parent id is
  -- safe, while re-running container creation is not.
  parent_container_id text,
  error text,
  created_at timestamptz default now()
);

create index on posts (member_id, created_at desc);

-- The MCP server talks to Postgres exclusively through the service role key,
-- which bypasses RLS. Enabling RLS with no policies means the anon/public API
-- surface can read nothing from these tables.
alter table team_members enable row level security;
alter table posts enable row level security;
