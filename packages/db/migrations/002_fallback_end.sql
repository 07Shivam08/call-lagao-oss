-- Calls closed by the API itself (stop without a worker report, or the stale-call reaper)
-- are provisional: a late report from the voice worker replaces them.
alter table calls add column ended_by_fallback boolean not null default false;
