-- Postgres requires truncating FK-related tables together (slots → courts).

create or replace function public.truncate_courts_and_slots()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table public.courts, public.slots restart identity;
end;
$$;
