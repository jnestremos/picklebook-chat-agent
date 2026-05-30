-- Wholesale sync replaces all courts/slots on each scrape. TRUNCATE RESTART IDENTITY
-- keeps bigint ids small (1, 2, 3…) instead of climbing forever after DELETE-only clears.

create or replace function public.truncate_courts_and_slots()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table public.slots restart identity;
  truncate table public.courts restart identity;
end;
$$;

revoke all on function public.truncate_courts_and_slots() from public;
revoke all on function public.truncate_courts_and_slots() from anon;
revoke all on function public.truncate_courts_and_slots() from authenticated;
grant execute on function public.truncate_courts_and_slots() to service_role;
