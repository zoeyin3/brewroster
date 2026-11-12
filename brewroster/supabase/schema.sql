-- =====================================================================
-- Brewroster: database schema, security rules and server functions
-- Run this whole file once in the Supabase SQL editor (Dashboard > SQL).
-- It is safe to re-run: everything is created with "if not exists" or
-- "create or replace", and the function bodies are simply replaced.
--
-- One Supabase project = one cafe.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id           int primary key default 1 check (id = 1),
  cafe_name    text not null default 'My Cafe',
  timezone     text not null default 'Australia/Sydney',
  cap          int  not null default 20 check (cap between 5 and 60),      -- transactions one person serves per hour
  min_staff    int  not null default 2  check (min_staff between 1 and 6),
  lat          numeric,                                                    -- for the live weather forecast
  lng          numeric,
  use_weather  boolean not null default true,
  use_events   boolean not null default true,
  use_school   boolean not null default true,
  seeded       boolean not null default false
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.staff (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  role_title  text not null default '',
  skills      text[] not null default '{}',
  barista     boolean not null default false,
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);

-- Pay rate, hours cap, email and availability are private: the owner and the
-- person themselves can read them, nobody else.
create table if not exists public.staff_private (
  staff_id      uuid primary key references public.staff(id) on delete cascade,
  email         text,
  rate          numeric not null default 28 check (rate >= 0),
  max_hours     int not null default 24 check (max_hours between 1 and 60),
  -- 7 entries Mon..Sun, each null or [startHour, endHour]
  avail         jsonb not null default '[null,null,null,null,null,null,null]',
  -- 7 booleans Mon..Sun: happy to be called in at short notice
  standby_days  jsonb not null default '[false,false,false,false,false,false,false]'
);
create unique index if not exists staff_private_email_uq on public.staff_private (lower(email)) where email is not null;

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  role          text not null check (role in ('owner', 'employee')),
  staff_id      uuid references public.staff(id) on delete set null,
  email         text,
  display_name  text,
  created_at    timestamptz not null default now()
);
create unique index if not exists profiles_staff_uq on public.profiles (staff_id) where staff_id is not null;

create table if not exists public.pos_hourly (
  day    date not null,
  hour   int  not null check (hour between 0 and 23),
  tx     int  not null check (tx >= 0),
  sales  numeric not null default 0,
  primary key (day, hour)
);

create table if not exists public.weather (
  day      date primary key,
  summary  text not null,
  temp     int,
  mult     numeric not null default 1,
  source   text not null default 'sample'
);

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  day         date not null,
  name        text not null,
  short_name  text,
  from_h      int not null default 7,
  to_h        int not null default 15,
  mult        numeric not null default 1.1 check (mult > 0 and mult < 3),
  kind        text not null default 'event' check (kind in ('event', 'school'))
);

create table if not exists public.leave_requests (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references public.staff(id) on delete cascade,
  from_day    date not null,
  to_day      date not null,
  type        text not null default 'Personal',
  reason      text,
  message     text,
  submitted   date not null,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  decided_at  timestamptz,
  check (to_day >= from_day)
);

create table if not exists public.rosters (
  week_start   date primary key check (extract(isodow from week_start) = 1),
  source       text not null default 'manual' check (source in ('ai', 'manual')),
  status       text not null default 'draft' check (status in ('draft', 'uploaded')),
  explain      jsonb,
  updated_at   timestamptz not null default now(),
  uploaded_at  timestamptz
);

create table if not exists public.shifts (
  id          uuid primary key default gen_random_uuid(),
  day         date not null,
  week_start  date generated always as ((date_trunc('week', day::timestamp))::date) stored,
  staff_id    uuid not null references public.staff(id) on delete cascade,
  start_h     int not null check (start_h between 0 and 23),
  end_h       int not null check (end_h between 1 and 24),
  via         text not null default 'roster' check (via in ('roster', 'chat', 'standby')),
  check (end_h > start_h),
  unique (day, staff_id)
);
create index if not exists shifts_week_idx on public.shifts (week_start);

-- One row per shift that needs cover.
--   late   : cancelled within 48 hours, goes straight to Standby
--   optout : opted out 48 hours to 14 days ahead, posted to the team chat first
--   gap    : a hole in the roster that the owner posted to chat / standby
create table if not exists public.cover_requests (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('late', 'optout', 'gap')),
  phase        text not null check (phase in ('chat', 'standby')),
  status       text not null default 'open' check (status in ('open', 'covered', 'closed')),
  staff_id     uuid references public.staff(id) on delete cascade,   -- who cancelled (null for gaps)
  day          date not null,
  week_start   date generated always as ((date_trunc('week', day::timestamp))::date) stored,
  start_h      int not null,                                         -- the hours that are uncovered
  end_h        int not null,
  w_from       int not null,                                         -- the shift a replacement would work
  w_to         int not null,
  reason       text,
  message      text,
  covered_by   uuid references public.staff(id) on delete set null,
  covered_via  text check (covered_via in ('chat', 'standby', 'owner')),
  covered_at   timestamptz,
  created_at   timestamptz not null default now()
);
create unique index if not exists cover_one_cancel_uq on public.cover_requests (staff_id, day) where kind in ('late', 'optout');
create unique index if not exists cover_one_gap_uq on public.cover_requests (day, start_h) where kind = 'gap' and status = 'open';

create table if not exists public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  body        text not null,
  cover_id    uuid references public.cover_requests(id) on delete set null,
  author      text,
  created_at  timestamptz not null default now()
);
-- people can write in the chat too ('msg'); safe to re-run on an existing project
alter table public.chat_messages add column if not exists author text;
alter table public.chat_messages drop constraint if exists chat_messages_kind_check;
alter table public.chat_messages add constraint chat_messages_kind_check check (kind in ('open', 'reg', 'note', 'msg'));
create index if not exists chat_created_idx on public.chat_messages (created_at desc);

create table if not exists public.standby_alerts (
  id            uuid primary key default gen_random_uuid(),
  cover_id      uuid not null references public.cover_requests(id) on delete cascade,
  staff_id      uuid not null references public.staff(id) on delete cascade,
  day           date not null,
  from_h        int not null,
  to_h          int not null,
  status        text not null default 'sent' check (status in ('sent', 'accepted', 'declined', 'expired')),
  sent_at       timestamptz not null default now(),
  responded_at  timestamptz,
  unique (cover_id, staff_id)
);

alter table public.settings        enable row level security;
alter table public.staff           enable row level security;
alter table public.staff_private   enable row level security;
alter table public.profiles        enable row level security;
alter table public.pos_hourly      enable row level security;
alter table public.weather         enable row level security;
alter table public.events          enable row level security;
alter table public.leave_requests  enable row level security;
alter table public.rosters         enable row level security;
alter table public.shifts          enable row level security;
alter table public.cover_requests  enable row level security;
alter table public.chat_messages   enable row level security;
alter table public.standby_alerts  enable row level security;

-- ---------------------------------------------------------------------
-- 2. Small helpers (security definer so policies never recurse)
-- ---------------------------------------------------------------------
-- "now" in the cafe's own time zone. brewroster.now is an optional test hook
-- (leave it unset in production).
create or replace function public.cafe_now() returns timestamp
language sql stable security definer set search_path = public as $$
  select (coalesce(nullif(current_setting('brewroster.now', true), '')::timestamptz, now())
          at time zone (select timezone from public.settings where id = 1))
$$;

create or replace function public.cafe_today() returns date
language sql stable security definer set search_path = public as $$ select public.cafe_now()::date $$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'owner')
$$;

create or replace function public.my_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select staff_id from public.profiles where id = auth.uid()
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and (role = 'owner' or staff_id is not null))
$$;

create or replace function public.h12(h int) returns int language sql immutable as $$ select case when h % 12 = 0 then 12 else h % 12 end $$;
create or replace function public.hfmt(h int) returns text language sql immutable as $$ select public.h12(h)::text || case when h % 24 >= 12 then 'pm' else 'am' end $$;
create or replace function public.hrange(a int, b int) returns text language sql immutable as $$
  select case when (a % 24 >= 12) = (b % 24 >= 12) then public.h12(a)::text || '–' || public.hfmt(b) else public.hfmt(a) || '–' || public.hfmt(b) end
$$;
create or replace function public.dlabel(d date) returns text language sql immutable as $$ select to_char(d, 'Dy FMDD Mon') $$;

-- ---------------------------------------------------------------------
-- 3. New accounts: the first sign-up becomes the owner. Everyone else is
--    an employee, linked to their staff record by email address.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role text; v_staff uuid; v_portal text := coalesce(new.raw_user_meta_data ->> 'portal', '');
begin
  perform pg_advisory_xact_lock(724001);
  if exists (select 1 from public.profiles where role = 'owner') then
    if v_portal = 'owner' then raise exception 'This cafe already has an owner. Please use the Employee portal.'; end if;
    v_role := 'employee';
  else
    -- nobody is the owner yet: only the Owner portal can claim it
    if v_portal = 'employee' then raise exception 'This cafe has not been set up yet. The owner needs to create their account first.'; end if;
    v_role := 'owner';
  end if;
  if v_role = 'employee' then
    select sp.staff_id into v_staff
      from public.staff_private sp join public.staff s on s.id = sp.staff_id
     where lower(sp.email) = lower(new.email) and s.active
       and not exists (select 1 from public.profiles p where p.staff_id = sp.staff_id)
     limit 1;
  end if;
  insert into public.profiles (id, role, staff_id, email, display_name)
  values (new.id, v_role, v_staff, new.email, coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- when the owner adds or changes a staff email, link a waiting account
create or replace function public.link_staff_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null then
    update public.profiles set staff_id = new.staff_id
     where role = 'employee' and staff_id is null and lower(email) = lower(new.email)
       and not exists (select 1 from public.profiles p where p.staff_id = new.staff_id);
  end if;
  return new;
end $$;
drop trigger if exists staff_email_link on public.staff_private;
create trigger staff_email_link after insert or update of email on public.staff_private for each row execute function public.link_staff_email();

create or replace function public.owner_exists() returns boolean
language sql stable security definer set search_path = public as $$ select exists (select 1 from public.profiles where role = 'owner') $$;

create or replace function public.cafe_clock() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('today', public.cafe_now()::date,
                           'minutes', extract(hour from public.cafe_now())::int * 60 + extract(minute from public.cafe_now())::int,
                           'timezone', (select timezone from public.settings where id = 1))
$$;

-- ---------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------
drop policy if exists settings_read   on public.settings;
drop policy if exists settings_write  on public.settings;
create policy settings_read  on public.settings for select to authenticated using (public.is_member());
create policy settings_write on public.settings for update to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (id = auth.uid() or public.is_owner());

drop policy if exists staff_read  on public.staff;
drop policy if exists staff_write on public.staff;
create policy staff_read  on public.staff for select to authenticated using (public.is_member());
create policy staff_write on public.staff for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists staffp_read  on public.staff_private;
drop policy if exists staffp_write on public.staff_private;
create policy staffp_read  on public.staff_private for select to authenticated using (public.is_owner() or staff_id = public.my_staff_id());
create policy staffp_write on public.staff_private for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists pos_owner on public.pos_hourly;
create policy pos_owner on public.pos_hourly for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists weather_read  on public.weather;
drop policy if exists weather_write on public.weather;
create policy weather_read  on public.weather for select to authenticated using (public.is_member());
create policy weather_write on public.weather for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists events_read  on public.events;
drop policy if exists events_write on public.events;
create policy events_read  on public.events for select to authenticated using (public.is_member());
create policy events_write on public.events for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists leave_read   on public.leave_requests;
drop policy if exists leave_owner  on public.leave_requests;
create policy leave_read  on public.leave_requests for select to authenticated using (public.is_owner() or staff_id = public.my_staff_id());
create policy leave_owner on public.leave_requests for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists rosters_read  on public.rosters;
drop policy if exists rosters_write on public.rosters;
create policy rosters_read  on public.rosters for select to authenticated using (public.is_owner() or (status = 'uploaded' and public.is_member()));
create policy rosters_write on public.rosters for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists shifts_read  on public.shifts;
drop policy if exists shifts_write on public.shifts;
create policy shifts_read on public.shifts for select to authenticated using (
  public.is_owner() or (public.is_member() and exists (select 1 from public.rosters r where r.week_start = shifts.week_start and r.status = 'uploaded')));
create policy shifts_write on public.shifts for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists cover_owner on public.cover_requests;
create policy cover_owner on public.cover_requests for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists chat_read  on public.chat_messages;
drop policy if exists chat_owner on public.chat_messages;
create policy chat_read  on public.chat_messages for select to authenticated using (public.is_member());
create policy chat_owner on public.chat_messages for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists alerts_read  on public.standby_alerts;
drop policy if exists alerts_owner on public.standby_alerts;
create policy alerts_read  on public.standby_alerts for select to authenticated using (public.is_owner() or staff_id = public.my_staff_id());
create policy alerts_owner on public.standby_alerts for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- Employees see open shifts through this view (it leaves out the private
-- reason and message the person gave when they cancelled).
create or replace view public.open_shifts as
  select c.id, c.kind, c.phase, c.status, c.staff_id, c.day, c.week_start, c.start_h, c.end_h, c.w_from, c.w_to,
         c.covered_by, c.covered_via, c.created_at
    from public.cover_requests c
   where public.is_member();

-- a leave lock: once a roster covering the dates is uploaded, a decision cannot change
create or replace function public.leave_lock_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if exists (select 1 from public.rosters r where r.status = 'uploaded' and r.week_start <= new.to_day and r.week_start + 6 >= new.from_day) then
      raise exception 'The roster for those dates is already uploaded, so this decision is locked.' using errcode = 'P0001';
    end if;
    new.decided_at := now();
  end if;
  return new;
end $$;
drop trigger if exists leave_lock on public.leave_requests;
create trigger leave_lock before update on public.leave_requests for each row execute function public.leave_lock_check();

-- ---------------------------------------------------------------------
-- 5. Server functions (the only way employees change anything)
-- ---------------------------------------------------------------------
create or replace function public.post_chat(p_kind text, p_body text, p_cover uuid default null) returns void
language sql security definer set search_path = public as $$
  insert into public.chat_messages (kind, body, cover_id) values (p_kind, p_body, p_cover)
$$;

create or replace function public.week_hours(p_staff uuid, p_week date) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(end_h - start_h), 0)::int from public.shifts s
   where s.staff_id = p_staff and s.week_start = p_week
     and not exists (select 1 from public.cover_requests c where c.staff_id = s.staff_id and c.day = s.day and c.kind in ('late', 'optout'))
$$;

-- is this person free for a cover window? returns null when free, else the reason
create or replace function public.cover_blocker(p_staff uuid, p_day date, p_from int, p_to int, p_ignore_cover uuid default null) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_max int; v_active boolean;
begin
  select sp.max_hours, s.active into v_max, v_active from public.staff s join public.staff_private sp on sp.staff_id = s.id where s.id = p_staff;
  if v_active is distinct from true then return 'This person is not on the active team.'; end if;
  if exists (select 1 from public.leave_requests l where l.staff_id = p_staff and l.status = 'approved' and p_day between l.from_day and l.to_day) then
    return 'You are on approved leave that day.';
  end if;
  if exists (select 1 from public.cover_requests c where c.staff_id = p_staff and c.day = p_day and c.kind in ('late', 'optout')) then
    return 'You cancelled your shift that day.';
  end if;
  if exists (select 1 from public.shifts s where s.staff_id = p_staff and s.day = p_day) then
    return 'You already have a shift that day.';
  end if;
  if public.week_hours(p_staff, (date_trunc('week', p_day::timestamp))::date) + (p_to - p_from) > v_max then
    return 'That would take you over your weekly limit of ' || v_max || ' hours.';
  end if;
  return null;
end $$;

-- ---- employee: ask for leave (needs 14 days notice) ----
create or replace function public.request_leave(p_from date, p_to date, p_type text, p_reason text, p_msg text) returns json
language plpgsql security definer set search_path = public as $$
declare v_me uuid := public.my_staff_id(); v_id uuid; v_today date := public.cafe_today();
begin
  if v_me is null then raise exception 'Your account is not linked to a staff record yet.'; end if;
  if p_to < p_from then raise exception 'The last day must be on or after the first day.'; end if;
  if p_from - v_today < 14 then raise exception 'Leave needs at least 14 days notice. For a shift sooner than that, opt out of the shift instead.'; end if;
  if p_to - p_from > 60 then raise exception 'That is a long stretch. Please talk to your manager.'; end if;
  if exists (select 1 from public.leave_requests l where l.staff_id = v_me and l.status in ('pending', 'approved') and l.from_day <= p_to and l.to_day >= p_from) then
    raise exception 'You already have leave requested for some of those days.';
  end if;
  if exists (select 1 from public.rosters r where r.status = 'uploaded' and r.week_start <= p_to and r.week_start + 6 >= p_from) then
    raise exception 'The roster for some of those days is already uploaded. Please talk to your manager.';
  end if;
  insert into public.leave_requests (staff_id, from_day, to_day, type, reason, message, submitted)
  values (v_me, p_from, p_to, coalesce(nullif(p_type, ''), 'Personal'), p_reason, p_msg, v_today) returning id into v_id;
  -- a draft roster for those weeks is no longer valid until the owner decides
  delete from public.shifts s where s.week_start in (select r.week_start from public.rosters r where r.status = 'draft' and r.week_start <= p_to and r.week_start + 6 >= p_from);
  delete from public.rosters r where r.status = 'draft' and r.week_start <= p_to and r.week_start + 6 >= p_from;
  return json_build_object('id', v_id);
end $$;

create or replace function public.withdraw_leave(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.leave_requests where id = p_id and staff_id = public.my_staff_id() and status = 'pending';
  if not found then raise exception 'Only a request that has not been decided can be withdrawn.'; end if;
end $$;

-- ---- cancelling a shift: employee, or the owner recording a phone call ----
create or replace function public._cancel_shift(p_shift uuid, p_reason text, p_msg text, p_by_owner boolean) returns json
language plpgsql security definer set search_path = public as $$
declare s public.shifts; v_up boolean; v_hours numeric; v_days int; v_kind text; v_phase text; v_id uuid; v_name text;
begin
  select * into s from public.shifts where id = p_shift;
  if not found then raise exception 'That shift could not be found.'; end if;
  if not p_by_owner and s.staff_id is distinct from public.my_staff_id() then raise exception 'You can only cancel your own shifts.'; end if;
  select (status = 'uploaded') into v_up from public.rosters where week_start = s.week_start;
  if v_up is distinct from true then raise exception 'That roster has not been uploaded yet.'; end if;
  v_hours := extract(epoch from ((s.day::timestamp + make_interval(hours => s.start_h)) - public.cafe_now())) / 3600.0;
  v_days := s.day - public.cafe_today();
  if v_hours <= 0 then raise exception 'That shift has already started.'; end if;
  if v_days >= 14 then raise exception 'That shift is 14 or more days away. Please send a leave request instead.'; end if;
  if exists (select 1 from public.cover_requests c where c.staff_id = s.staff_id and c.day = s.day and c.kind in ('late', 'optout')) then
    raise exception 'That shift is already cancelled.';
  end if;
  if v_hours > 48 then v_kind := 'optout'; v_phase := 'chat'; else v_kind := 'late'; v_phase := 'standby'; end if;
  insert into public.cover_requests (kind, phase, staff_id, day, start_h, end_h, w_from, w_to, reason, message, opted_out_at, notice_hours, triggered_standby, by_owner)
  values (v_kind, v_phase, s.staff_id, s.day, s.start_h, s.end_h, s.start_h, s.end_h, nullif(p_reason, ''), nullif(p_msg, ''), public.cafe_now(), v_hours, v_phase = 'standby', p_by_owner) returning id into v_id;
  select name into v_name from public.staff where id = s.staff_id;
  if v_kind = 'optout' then
    perform public.post_chat('open', 'Open shift: ' || public.dlabel(s.day) || ', ' || public.hrange(s.start_h, s.end_h) || '. ' || split_part(v_name, ' ', 1) || ' can no longer work it. Normal pay.', v_id);
  end if;
  -- the late opt-out alert is owner-only: nothing about it is returned to the person who opted out
  if v_kind = 'late' then perform public._late_record_event(v_id); end if;
  return json_build_object('id', v_id, 'kind', v_kind, 'phase', v_phase);
end $$;

create or replace function public.cancel_shift(p_shift uuid, p_reason text, p_msg text) returns json
language plpgsql security definer set search_path = public as $$
begin
  if public.my_staff_id() is null then raise exception 'Your account is not linked to a staff record yet.'; end if;
  return public._cancel_shift(p_shift, p_reason, p_msg, false);
end $$;

create or replace function public.owner_record_cancellation(p_shift uuid, p_reason text, p_msg text) returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Only the owner can do that.'; end if;
  return public._cancel_shift(p_shift, p_reason, p_msg, true);
end $$;

-- ---- a worker takes an open shift from the team chat ----
create or replace function public.register_open_shift(p_cover uuid) returns json
language plpgsql security definer set search_path = public as $$
declare c public.cover_requests; v_me uuid := public.my_staff_id(); v_block text; v_name text;
begin
  if v_me is null then raise exception 'Your account is not linked to a staff record yet.'; end if;
  select * into c from public.cover_requests where id = p_cover for update;
  if not found then raise exception 'That shift could not be found.'; end if;
  if c.status <> 'open' then raise exception 'Sorry, that shift has already been filled.'; end if;
  if c.phase <> 'chat' then raise exception 'That shift has moved to Standby. The owner will contact people directly.'; end if;
  if c.staff_id = v_me then raise exception 'That is your own shift.'; end if;
  if (c.day::timestamp + make_interval(hours => c.w_from)) <= public.cafe_now() then raise exception 'That shift has already started.'; end if;
  v_block := public.cover_blocker(v_me, c.day, c.w_from, c.w_to);
  if v_block is not null then raise exception '%', v_block; end if;
  insert into public.shifts (day, staff_id, start_h, end_h, via) values (c.day, v_me, c.w_from, c.w_to, 'chat');
  update public.cover_requests set status = 'covered', covered_by = v_me, covered_via = 'chat', covered_at = now() where id = c.id;
  update public.standby_alerts set status = 'expired', responded_at = now() where cover_id = c.id and status = 'sent';
  select name into v_name from public.staff where id = v_me;
  perform public.post_chat('reg', v_name || ' registered for ' || public.dlabel(c.day) || ', ' || public.hrange(c.w_from, c.w_to) || '.', c.id);
  perform public.post_chat('note', public.dlabel(c.day) || ' is filled.', c.id);
  return json_build_object('day', c.day, 'from', c.w_from, 'to', c.w_to);
end $$;

-- ---- a worker answers a standby call ----
create or replace function public.respond_standby_alert(p_alert uuid, p_accept boolean) returns json
language plpgsql security definer set search_path = public as $$
declare a public.standby_alerts; c public.cover_requests; v_me uuid := public.my_staff_id(); v_block text; v_name text;
begin
  select * into a from public.standby_alerts where id = p_alert;
  if not found or a.staff_id is distinct from v_me then raise exception 'That call could not be found.'; end if;
  if a.status <> 'sent' then raise exception 'You have already replied to that call.'; end if;
  select * into c from public.cover_requests where id = a.cover_id for update;
  if not p_accept then
    update public.standby_alerts set status = 'declined', responded_at = now() where id = a.id;
    return json_build_object('result', 'declined');
  end if;
  if c.status <> 'open' then
    update public.standby_alerts set status = 'expired', responded_at = now() where id = a.id;
    return json_build_object('result', 'taken');
  end if;
  v_block := public.cover_blocker(v_me, c.day, a.from_h, a.to_h);
  if v_block is not null then raise exception '%', v_block; end if;
  insert into public.shifts (day, staff_id, start_h, end_h, via) values (c.day, v_me, a.from_h, a.to_h, 'standby');
  update public.cover_requests set status = 'covered', covered_by = v_me, covered_via = 'standby', covered_at = now() where id = c.id;
  update public.standby_alerts set status = 'accepted', responded_at = now() where id = a.id;
  update public.standby_alerts set status = 'expired', responded_at = now() where cover_id = c.id and status = 'sent' and id <> a.id;
  if c.kind = 'optout' then
    select name into v_name from public.staff where id = v_me;
    perform public.post_chat('note', public.dlabel(c.day) || ' was filled through Standby.', c.id);
  end if;
  return json_build_object('result', 'accepted', 'day', c.day, 'from', a.from_h, 'to', a.to_h);
end $$;

-- ---- anything still in the team chat 48 hours before it starts moves to Standby ----
create or replace function public.escalate_due_cover() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not public.is_member() then return 0; end if;
  for r in select * from public.cover_requests c
            where c.status = 'open' and c.phase = 'chat'
              and extract(epoch from ((c.day::timestamp + make_interval(hours => c.w_from)) - public.cafe_now())) / 3600.0 <= 48
            for update loop
    update public.cover_requests set phase = 'standby', triggered_standby = true where id = r.id;
    perform public.post_chat('note', 'Nobody registered for ' || public.dlabel(r.day) || ', ' || public.hrange(r.w_from, r.w_to) || '. It is now within 48 hours and has moved to Standby.', r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---- owner: post a roster gap to the chat or to standby ----
create or replace function public.owner_open_gap(p_day date, p_start int, p_end int, p_from int, p_to int, p_phase text) returns json
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_owner() then raise exception 'Only the owner can do that.'; end if;
  select id into v_id from public.cover_requests where kind = 'gap' and status = 'open' and day = p_day and start_h = p_start;
  if v_id is null then
    insert into public.cover_requests (kind, phase, day, start_h, end_h, w_from, w_to) values ('gap', p_phase, p_day, p_start, p_end, p_from, p_to) returning id into v_id;
    if p_phase = 'chat' then
      perform public.post_chat('open', 'Open shift: ' || public.dlabel(p_day) || ', ' || public.hrange(p_from, p_to) || '. The roster needs one more person. Normal pay.', v_id);
    end if;
  end if;
  return json_build_object('id', v_id);
end $$;

-- ---- owner: send standby calls ----
create or replace function public.owner_alert_standby(p_cover uuid, p_staff uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare c public.cover_requests; sid uuid; n int := 0;
begin
  if not public.is_owner() then raise exception 'Only the owner can do that.'; end if;
  select * into c from public.cover_requests where id = p_cover;
  if not found or c.status <> 'open' then raise exception 'That shift is no longer open.'; end if;
  if c.phase <> 'standby' then update public.cover_requests set phase = 'standby', triggered_standby = true where id = c.id; end if;
  foreach sid in array p_staff loop
    insert into public.standby_alerts (cover_id, staff_id, day, from_h, to_h) values (c.id, sid, c.day, c.w_from, c.w_to) on conflict (cover_id, staff_id) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- ---- owner: save a whole roster week in one go, and publish it ----
create or replace function public.save_roster(p_week date, p_source text, p_shifts jsonb, p_explain jsonb default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Only the owner can do that.'; end if;
  if extract(isodow from p_week) <> 1 then raise exception 'A roster week starts on a Monday.'; end if;
  if exists (select 1 from public.rosters where week_start = p_week and status = 'uploaded') then raise exception 'That roster is already uploaded.'; end if;
  if exists (select 1 from public.leave_requests l where l.status = 'pending' and l.from_day <= p_week + 6 and l.to_day >= p_week) then
    raise exception 'Decide the leave requests for that week before building its roster.';
  end if;
  insert into public.rosters (week_start, source, status, explain, updated_at) values (p_week, p_source, 'draft', p_explain, now())
  on conflict (week_start) do update set source = excluded.source, explain = excluded.explain, updated_at = now();
  delete from public.shifts where week_start = p_week;
  insert into public.shifts (day, staff_id, start_h, end_h)
  select (x ->> 'day')::date, (x ->> 'staff_id')::uuid, (x ->> 'start_h')::int, (x ->> 'end_h')::int from jsonb_array_elements(p_shifts) x;
end $$;

create or replace function public.publish_roster(p_week date) returns void
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_owner() then raise exception 'Only the owner can do that.'; end if;
  if not exists (select 1 from public.rosters where week_start = p_week) then raise exception 'There is no roster for that week yet.'; end if;
  if exists (select 1 from public.leave_requests l where l.status = 'pending' and l.from_day <= p_week + 6 and l.to_day >= p_week) then
    raise exception 'Decide the leave requests for that week first.';
  end if;
  select count(*) into n from public.shifts s join public.leave_requests l on l.staff_id = s.staff_id and l.status = 'approved' and s.day between l.from_day and l.to_day where s.week_start = p_week;
  if n > 0 then raise exception 'Remove % shift(s) on approved leave before uploading.', n; end if;
  update public.rosters set status = 'uploaded', uploaded_at = now(), updated_at = now() where week_start = p_week;
  perform public.post_chat('note', 'Roster for the week of ' || public.dlabel(p_week) || ' was uploaded.');
end $$;

-- ---- employee: update my own availability and standby days ----
create or replace function public.update_my_availability(p_avail jsonb, p_standby jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := public.my_staff_id(); i int; a jsonb;
begin
  if v_me is null then raise exception 'Your account is not linked to a staff record yet.'; end if;
  if jsonb_typeof(p_avail) <> 'array' or jsonb_array_length(p_avail) <> 7 or jsonb_typeof(p_standby) <> 'array' or jsonb_array_length(p_standby) <> 7 then
    raise exception 'Availability needs seven days.';
  end if;
  for i in 0..6 loop
    a := p_avail -> i;
    if jsonb_typeof(a) = 'array' then
      if jsonb_array_length(a) <> 2 or (a ->> 0)::int < 0 or (a ->> 1)::int > 24 or (a ->> 0)::int >= (a ->> 1)::int then raise exception 'Those hours do not look right.'; end if;
    elsif jsonb_typeof(a) <> 'null' then raise exception 'Those hours do not look right.';
    end if;
  end loop;
  update public.staff_private set avail = p_avail, standby_days = p_standby where staff_id = v_me;
end $$;

-- ---- employee: volunteer for standby (days they are happy to be called in) ----
create or replace function public.update_my_standby(p_standby jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := public.my_staff_id(); i int;
begin
  if v_me is null then raise exception 'Your account is not linked to a staff record yet.'; end if;
  if jsonb_typeof(p_standby) <> 'array' or jsonb_array_length(p_standby) <> 7 then raise exception 'Standby needs seven days.'; end if;
  for i in 0..6 loop
    if jsonb_typeof(p_standby -> i) <> 'boolean' then raise exception 'Standby needs seven days.'; end if;
  end loop;
  update public.staff_private set standby_days = p_standby where staff_id = v_me;
end $$;

-- ---- anyone on the team: write in the team chat ----
create or replace function public.send_chat(p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text; v_body text := btrim(coalesce(p_body, ''));
begin
  if auth.uid() is null or not public.is_member() then raise exception 'Only people on the team can write in the chat.'; end if;
  if v_body = '' then raise exception 'Type a message first.'; end if;
  if char_length(v_body) > 300 then raise exception 'Messages can be up to 300 characters.'; end if;
  select coalesce(s.name, p.display_name) into v_name from public.profiles p left join public.staff s on s.id = p.staff_id where p.id = auth.uid();
  insert into public.chat_messages (kind, body, author) values ('msg', v_body, v_name);
end $$;

-- ---------------------------------------------------------------------
-- 6. Sample data: Little Wren Coffee, relative to today
-- ---------------------------------------------------------------------
create or replace function public.seed_demo(p_reset boolean default false) returns json
language plpgsql security definer set search_path = public as $$
declare
  t date := public.cafe_today(); n date; d date; dow int; h int; dayf numeric; tx int; tk numeric; base numeric; close_h int;
  wk int[] := array[52,72,62,41,38,57,34,18]; fri int[] := array[55,76,66,46,42,62,38,20];
  sat int[] := array[30,52,74,82,72,54,32]; sun int[] := array[26,46,70,78,68,50,28];
  ticket numeric[] := array[9.6,10.4,12.8,14.2,15.0,16.8,15.4,13.2];
  w_c text[] := array['Sunny','Fine','Cloudy','Showers','Rain','Sunny','Cloudy'];
  w_t int[]  := array[24,25,21,18,17,26,22];
  w_m numeric[] := array[1.02,1.03,0.98,0.93,0.90,1.04,0.99];
  i int; sid uuid; ids jsonb := '{}';
  w jsonb := '[null,null,null,null,null,null,null]';
begin
  if auth.uid() is not null and not public.is_owner() then raise exception 'Only the owner can do that.'; end if;
  if exists (select 1 from public.staff) and not p_reset then raise exception 'Sample data can only be loaded into an empty cafe. Use reset to replace what is there.'; end if;
  if p_reset then
    -- (Supabase refuses DELETE without a WHERE clause, so every delete says "where true")
    delete from public.chat_messages where true; delete from public.standby_alerts where true; delete from public.cover_requests where true;
    delete from public.late_audit where true; delete from public.late_optout_alerts where true;
    update public.late_settings set threshold = 3, window_h = 48 where id = 1;
    delete from public.shifts where true; delete from public.rosters where true;
    delete from public.leave_requests where true; delete from public.events where true; delete from public.weather where true; delete from public.pos_hourly where true;
    update public.profiles set staff_id = null where role = 'employee';
    delete from public.staff where true;
  end if;
  perform setseed(0.2026);
  update public.settings set cafe_name = 'Little Wren Coffee', cap = 20, min_staff = 2, lat = -33.8688, lng = 151.2093, seeded = true where id = 1;
  n := t + (7 - extract(isodow from t)::int) + 1;     -- next Monday

  -- team (10 people). Availability is [start, end] hours per weekday Mon..Sun.
  perform public._seed_staff('Maya Okafor',      'Head barista',        array['Barista','Opens'],   true,  34, 38, 'maya@littlewren.example',   '[[7,15],[7,15],[7,15],[7,15],[7,15],[7,14],null]', '[false,false,true,false,false,true,true]', 1);
  perform public._seed_staff('Liam Tran',        'Barista',             array['Barista'],           true,  31, 30, 'liam@littlewren.example',   '[[7,15],[7,15],[7,15],[7,15],[7,15],null,[7,14]]', '[false,true,false,false,false,true,false]', 2);
  perform public._seed_staff('Priya Nair',       'Barista',             array['Barista','Counter'], true,  30, 24, 'priya@littlewren.example',  '[[7,15],[7,15],null,[7,15],[7,15],[7,14],[7,14]]', '[false,false,true,false,false,false,true]', 3);
  perform public._seed_staff('Jack Moreno',      'Barista and counter', array['Barista','Counter'], true,  29, 20, 'jack@littlewren.example',   '[[11,15],null,[11,15],[11,15],[7,15],[7,14],[7,14]]', '[false,true,false,false,true,true,true]', 4);
  perform public._seed_staff('Noah Bennett',     'Barista',             array['Barista'],           true,  30, 24, 'noah@littlewren.example',   '[null,[7,15],null,[7,15],[7,15],[7,14],[7,14]]', '[true,false,true,false,false,true,false]', 5);
  perform public._seed_staff('Sofia Lindqvist',  'Floor and counter',   array['Counter','Floor'],   false, 29, 24, 'sofia@littlewren.example',  '[null,[7,15],[7,15],[7,15],[7,15],[7,14],[7,14]]', '[true,false,false,false,false,true,true]', 6);
  perform public._seed_staff('Ethan Cole',       'Kitchen and counter', array['Kitchen','Counter'], false, 30, 30, 'ethan@littlewren.example',  '[[7,15],[7,15],[7,15],[7,15],[7,15],[7,14],null]', '[false,false,true,true,false,false,true]', 7);
  perform public._seed_staff('Amara Singh',      'Floor and counter',   array['Counter','Floor'],   false, 28, 20, 'amara@littlewren.example',  '[[7,15],null,[7,15],null,[7,15],[7,14],null]', '[false,true,false,true,false,false,true]', 8);
  perform public._seed_staff('Callum Reid',      'Kitchen (casual)',    array['Kitchen'],           false, 29, 22, 'callum@littlewren.example', '[null,[7,15],[7,15],[7,15],null,[7,14],[7,14]]', '[true,false,false,true,true,false,false]', 9);
  perform public._seed_staff('Zoe Hart',         'Floor (casual)',      array['Floor'],             false, 28, 16, 'zoe@littlewren.example',    '[[11,15],null,[11,15],null,[7,15],[7,14],[7,14]]', '[true,true,true,false,true,true,true]', 10);
  update public.profiles p set staff_id = sp.staff_id from public.staff_private sp
   where p.role = 'employee' and p.staff_id is null and lower(p.email) = lower(sp.email);

  -- eight weeks of point-of-sale history, ending yesterday
  for d in select generate_series(t - 56, t - 1, interval '1 day')::date loop
    dow := extract(isodow from d)::int - 1;
    close_h := case when dow < 5 then 15 else 14 end;
    dayf := 0.9 + 0.16 * random();
    for h in 7 .. close_h - 1 loop
      base := case when dow < 4 then wk[h - 6] when dow = 4 then fri[h - 6] when dow = 5 then sat[h - 6] else sun[h - 6] end;
      tx := greatest(4, round(base * dayf * (0.9 + 0.2 * random())))::int;
      tk := (ticket[h - 6] + case when dow >= 5 then 1.4 else 0 end) * (0.96 + 0.08 * random());
      insert into public.pos_hourly (day, hour, tx, sales) values (d, h, tx, round(tx * tk, 2));
    end loop;
  end loop;

  -- sample weather around today (replaced by the live forecast when the owner opens the app)
  for d in select generate_series(t - 7, t + 28, interval '1 day')::date loop
    i := 1 + floor(random() * 7)::int;
    insert into public.weather (day, summary, temp, mult, source) values (d, w_c[i], w_t[i], w_m[i], 'sample');
  end loop;

  -- local events and a school day
  insert into public.events (day, name, short_name, from_h, to_h, mult, kind) values
    (n + 5,  'Saturday markets at the park', 'Markets',        9, 13, 1.22, 'event'),
    (n + 6,  'Park fun run',                 'Fun run',        7, 10, 1.30, 'event'),
    (n + 12, 'Street Halloween parade',      'Parade',        10, 13, 1.15, 'event'),
    (n + 15, 'Cup day lunches',              'Cup day',       11, 14, 1.15, 'event'),
    (n + 4,  'School pupil-free day',        'Pupil-free day', 7, 10, 0.86, 'school');

  -- leave requests: a few waiting for a decision, a few already decided
  insert into public.leave_requests (staff_id, from_day, to_day, type, reason, message, submitted, status, decided_at)
  select s.id, v.f, v.t2, v.ty, v.rs, v.msg, v.sub, v.st, case when v.st = 'pending' then null else now() end
    from (values
      ('Maya Okafor',     n + 7,  n + 9,  'Annual',   'Annual leave',          'I would like to book annual leave for these three days please.', t - 6,  'pending'),
      ('Zoe Hart',        n + 13, n + 13, 'Personal', 'Family trip',           'Would it be ok to have this Sunday off? We are heading down the coast as a family.', t, 'pending'),
      ('Liam Tran',       n + 16, n + 17, 'Personal', 'Family wedding',        'Can I please take these two days off? My cousin is getting married interstate.', t - 3, 'pending'),
      ('Priya Nair',      n + 19, n + 19, 'Personal', 'Engagement party',      'Could I get this Saturday off please? It is my cousin''s engagement party.', t - 2, 'pending'),
      ('Noah Bennett',    n + 18, n + 19, 'Personal', 'Friend''s wedding',     'My friend is getting married. Could I have Friday and Saturday off to travel up?', t - 1, 'pending'),
      ('Jack Moreno',     n,      n + 2,  'Study',    'Uni assessment block',  'I have uni assessments so I cannot do shifts those days.', t - 15, 'approved'),
      ('Sofia Lindqvist', n + 3,  n + 4,  'Annual',   'Annual leave',          'Could I take Thursday and Friday as annual leave?', t - 13, 'approved'),
      ('Ethan Cole',      n + 11, n + 11, 'Medical',  'Specialist appointment','Need this Friday off for a specialist appointment. Thanks!', t - 7, 'approved')
    ) as v(nm, f, t2, ty, rs, msg, sub, st)
    join public.staff s on s.name = v.nm;

  perform public._seed_late_sample(t);
  return json_build_object('ok', true, 'today', t);
end $$;

create or replace function public._seed_staff(p_name text, p_role text, p_skills text[], p_bar boolean, p_rate numeric, p_max int, p_email text, p_avail jsonb, p_sb jsonb, p_sort int) returns void
language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  insert into public.staff (name, role_title, skills, barista, sort) values (p_name, p_role, p_skills, p_bar, p_sort) returning id into sid;
  insert into public.staff_private (staff_id, email, rate, max_hours, avail, standby_days) values (sid, p_email, p_rate, p_max, p_avail, p_sb);
end $$;

-- ---------------------------------------------------------------------
-- 6b. Late opt-out alert (owner only)
--
-- Tells the owner when one person keeps opting out of shifts with under
-- 48 hours notice, because each one forces the standby process.
--   * It only ever informs. Nothing in this section changes a roster, sends a
--     message, approves leave or touches anyone's hours.
--   * Employees cannot read any of it: the tables below have an owner-only
--     read rule and no write rules, and every action is an owner-only function.
--   * What counts: an opt-out made with less than the notice window (default
--     48 hours) that sent the shift to standby, per person per calendar month
--     (the month the opt-out was made in). Excused events stay in the history
--     but are not counted. Opt-outs with more notice, leave decided in advance,
--     and shifts the owner changed never create one of these events.
-- ---------------------------------------------------------------------

-- what we remember about each opt-out (the rows already exist in cover_requests)
alter table public.cover_requests add column if not exists opted_out_at      timestamp;            -- cafe time when the person opted out
alter table public.cover_requests add column if not exists notice_hours      numeric;              -- hours between opting out and the shift start
alter table public.cover_requests add column if not exists triggered_standby boolean not null default false;
alter table public.cover_requests add column if not exists by_owner          boolean not null default false;  -- the owner recorded a phone call
alter table public.cover_requests add column if not exists excused           boolean not null default false;
alter table public.cover_requests add column if not exists excused_by        text;
alter table public.cover_requests add column if not exists excused_at        timestamptz;
alter table public.cover_requests add column if not exists owner_note        text;

-- fill in the new fields for opt-outs that were recorded before this feature existed
update public.cover_requests c
   set opted_out_at = c.created_at at time zone (select timezone from public.settings where id = 1),
       notice_hours = extract(epoch from ((c.day::timestamp + make_interval(hours => c.start_h)) - (c.created_at at time zone (select timezone from public.settings where id = 1)))) / 3600.0,
       triggered_standby = (c.phase = 'standby')
 where c.kind in ('late', 'optout') and c.opted_out_at is null;

-- owner-only settings (kept out of the public settings table on purpose)
create table if not exists public.late_settings (
  id        int primary key default 1 check (id = 1),
  threshold int not null default 3  check (threshold between 2 and 20),   -- alert when a person reaches this many in a month
  window_h  int not null default 48 check (window_h between 1 and 48)     -- "short notice" means under this many hours
);
insert into public.late_settings (id) values (1) on conflict (id) do nothing;

-- one alert per person per calendar month; later events update its count
create table if not exists public.late_optout_alerts (
  id                uuid primary key default gen_random_uuid(),
  staff_id          uuid not null references public.staff(id) on delete cascade,
  month             date not null,                      -- first day of the calendar month
  state             text not null default 'open' check (state in ('open', 'dismissed', 'closed')),
  event_count       int  not null,
  watching          boolean not null default false,     -- the owner chose "Keep watching"
  watching_by       text,
  watching_at       timestamptz,
  dismissed_by      uuid,
  dismissed_by_name text,
  dismissed_at      timestamptz,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (staff_id, month)
);

-- every counted event, excused event and alert action
create table if not exists public.late_audit (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  cafe_time   timestamp,
  actor_id    uuid,
  actor_name  text,
  action      text not null,
  staff_id    uuid,
  cover_id    uuid,
  alert_id    uuid,
  detail      jsonb not null default '{}'
);
create index if not exists late_audit_staff_idx on public.late_audit (staff_id, at desc);

alter table public.late_settings       enable row level security;
alter table public.late_optout_alerts  enable row level security;
alter table public.late_audit          enable row level security;
drop policy if exists late_settings_read on public.late_settings;
drop policy if exists late_alerts_read   on public.late_optout_alerts;
drop policy if exists late_audit_read    on public.late_audit;
create policy late_settings_read on public.late_settings      for select to authenticated using (public.is_owner());
create policy late_alerts_read   on public.late_optout_alerts for select to authenticated using (public.is_owner());
create policy late_audit_read    on public.late_audit         for select to authenticated using (public.is_owner());

create or replace function public._actor_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select coalesce(nullif(display_name, ''), email) from public.profiles where id = auth.uid()), 'System')
$$;

create or replace function public._late_log(p_action text, p_staff uuid, p_cover uuid, p_alert uuid, p_detail jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.late_audit (cafe_time, actor_id, actor_name, action, staff_id, cover_id, alert_id, detail)
  values (public.cafe_now(), auth.uid(), public._actor_name(), p_action, p_staff, p_cover, p_alert, coalesce(p_detail, '{}'::jsonb))
$$;

-- how many events count for one person in one month
create or replace function public._late_count(p_staff uuid, p_month date) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int
    from public.cover_requests c, public.late_settings s
   where s.id = 1 and c.staff_id = p_staff and c.kind in ('late', 'optout')
     and c.triggered_standby and not c.excused and c.notice_hours < s.window_h
     and date_trunc('month', c.opted_out_at)::date = p_month
$$;

-- bring the alert for one person and month in line with the events.
-- Creates it at the threshold, updates the count after that, closes it when excusing
-- events drops the count below the threshold, and reopens the same one if it rises again.
create or replace function public._late_refresh(p_staff uuid, p_month date) returns uuid
language plpgsql security definer set search_path = public as $$
declare s public.late_settings; n int; a public.late_optout_alerts; v_state text;
begin
  select * into s from public.late_settings where id = 1;
  n := public._late_count(p_staff, p_month);
  select * into a from public.late_optout_alerts where staff_id = p_staff and month = p_month for update;
  if not found then
    if n >= s.threshold then
      insert into public.late_optout_alerts (staff_id, month, event_count) values (p_staff, p_month, n) returning * into a;
      perform public._late_log('alert_opened', p_staff, null, a.id, jsonb_build_object('month', p_month, 'count', n, 'threshold', s.threshold));
      return a.id;
    end if;
    return null;
  end if;
  v_state := a.state;
  if a.state = 'open' and n < s.threshold then v_state := 'closed';
  elsif a.state = 'closed' and n >= s.threshold then v_state := 'open'; end if;
  if n <> a.event_count or v_state <> a.state then
    update public.late_optout_alerts
       set event_count = n, state = v_state, updated_at = now(),
           closed_at = case when v_state = 'closed' then now() when v_state = 'open' then null else closed_at end,
           watching = case when n > a.event_count and v_state = 'open' then false else watching end   -- new information, so it comes back to the owner's list
     where id = a.id;
    perform public._late_log(case when v_state <> a.state and v_state = 'closed' then 'alert_closed' when v_state <> a.state then 'alert_reopened' else 'alert_updated' end,
                             p_staff, null, a.id, jsonb_build_object('month', p_month, 'from', a.event_count, 'to', n, 'threshold', s.threshold));
  end if;
  return a.id;
end $$;

create or replace function public._late_refresh_all() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select staff_id as sid, date_trunc('month', opted_out_at)::date as m from public.cover_requests
            where staff_id is not null and kind in ('late', 'optout') and triggered_standby and opted_out_at is not null
           union select staff_id, month from public.late_optout_alerts loop
    perform public._late_refresh(r.sid, r.m);
  end loop;
end $$;

-- called right after an opt-out is recorded: log it if it counts, then update the alert
create or replace function public._late_record_event(p_cover uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cover_requests; s public.late_settings; m date;
begin
  select * into c from public.cover_requests where id = p_cover;
  select * into s from public.late_settings where id = 1;
  if not found or c.staff_id is null or c.kind not in ('late', 'optout') or not c.triggered_standby or c.notice_hours >= s.window_h then return; end if;
  m := date_trunc('month', c.opted_out_at)::date;
  perform public._late_log('event_counted', c.staff_id, c.id, null,
    jsonb_build_object('day', c.day, 'notice_hours', round(c.notice_hours, 1), 'month', m, 'count_after', public._late_count(c.staff_id, m), 'recorded_by_owner', c.by_owner));
  perform public._late_refresh(c.staff_id, m);
end $$;

-- backfill and settle anything recorded before this feature existed
select public._late_refresh_all();

-- ---- owner: everything the alert screens need, in one call ----
create or replace function public.late_alerts() returns json
language plpgsql stable security definer set search_path = public as $$
declare s public.late_settings; v_tz text; v_out json;
begin
  if not public.is_owner() then raise exception 'Only the owner can do that.'; end if;
  select * into s from public.late_settings where id = 1;
  select timezone into v_tz from public.settings where id = 1;
  select json_build_object('threshold', s.threshold, 'window_h', s.window_h,
           'alerts', coalesce(json_agg(a order by a.month desc, a.created_at desc), '[]'::json))
    into v_out
    from (
      select al.id, al.staff_id, st.name as staff_name, al.month, al.state, al.event_count, al.watching, al.watching_by,
             al.dismissed_by_name, (al.dismissed_at at time zone v_tz)::date as dismissed_on, al.created_at,
             (select json_agg(e order by e.day, e.start_h) from (
                select c.id, c.day, c.start_h, c.end_h, c.notice_hours, c.status, c.covered_via, cb.name as covered_by_name,
                       c.excused, c.excused_by, c.owner_note as note, c.reason, c.by_owner,
                       case when c.covered_by is not null and cp.rate is not null
                            then coalesce(sh.end_h - sh.start_h, c.w_to - c.w_from) end as cover_hours,
                       case when c.covered_by is not null and cp.rate is not null
                            then round(coalesce(sh.end_h - sh.start_h, c.w_to - c.w_from) * cp.rate, 2) end as cost
                  from public.cover_requests c
                  left join public.staff cb on cb.id = c.covered_by
                  left join public.staff_private cp on cp.staff_id = c.covered_by
                  left join public.shifts sh on sh.staff_id = c.covered_by and sh.day = c.day
                 where c.staff_id = al.staff_id and c.kind in ('late', 'optout') and c.triggered_standby
                   and c.notice_hours < s.window_h and date_trunc('month', c.opted_out_at)::date = al.month
             ) e) as events
        from public.late_optout_alerts al
        join public.staff st on st.id = al.staff_id
       where al.month >= (date_trunc('month', public.cafe_today()) - interval '5 months')::date
    ) a;
  return v_out;
end $$;

create or replace function public.late_save_settings(p_threshold int, p_window int) returns json
language plpgsql security definer set search_path = public as $$
declare o public.late_settings;
begin
  if not public.is_owner() then raise exception 'Only the owner can do that.'; end if;
  if p_threshold is null or p_threshold < 2 or p_threshold > 20 then raise exception 'Alert after must be between 2 and 20 late opt-outs.'; end if;
  if p_window is null or p_window < 1 or p_window > 48 then raise exception 'Short notice must be between 1 and 48 hours. Standby only starts within 48 hours.'; end if;
  select * into o from public.late_settings where id = 1;
  if o.threshold <> p_threshold or o.window_h <> p_window then
    update public.late_settings set threshold = p_threshold, window_h = p_window where id = 1;
    perform public._late_log('settings_changed', null, null, null, jsonb_build_object('threshold_from', o.threshold, 'threshold_to', p_threshold, 'window_from', o.window_h, 'window_to', p_window));
    perform public._late_refresh_all();
  end if;
  return json_build_object('threshold', p_threshold, 'window_h', p_window);
end $$;

-- ---- owner: mark an event as excused (for example illness) or take the excuse back ----
create or replace function public.late_event_excuse(p_cover uuid, p_excused boolean, p_note text default null) returns json
language plpgsql security definer set search_path = public as $$
declare c public.cover_requests; a public.late_optout_alerts; v_id uuid; v_note text := nullif(left(trim(coalesce(p_note, '')), 500), '');
begin
  if not public.is_owner() then raise exception 'Only the owner can do that.'; end if;
  select * into c from public.cover_requests where id = p_cover for update;
  if not found or c.staff_id is null or c.kind not in ('late', 'optout') or not c.triggered_standby then raise exception 'That is not a late opt-out.'; end if;
  update public.cover_requests
     set excused = p_excused, excused_by = case when p_excused then public._actor_name() end, excused_at = case when p_excused then now() end,
         owner_note = case when p_note is null then owner_note else v_note end
   where id = c.id;
  perform public._late_log(case when p_excused then 'event_excused' else 'event_unexcused' end, c.staff_id, c.id, null,
                           jsonb_build_object('day', c.day, 'note', v_note));
  v_id := public._late_refresh(c.staff_id, date_trunc('month', c.opted_out_at)::date);
  select * into a from public.late_optout_alerts where id = v_id;
  return json_build_object('alert_id', v_id, 'state', a.state, 'count', a.event_count);
end $$;

create or replace function public.late_event_note(p_cover uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cover_requests; v_note text := nullif(left(trim(coalesce(p_note, '')), 500), '');
begin
  if not public.is_owner() then raise exception 'Only the owner can do that.'; end if;
  select * into c from public.cover_requests where id = p_cover for update;
  if not found or c.staff_id is null or c.kind not in ('late', 'optout') or not c.triggered_standby then raise exception 'That is not a late opt-out.'; end if;
  update public.cover_requests set owner_note = v_note where id = c.id;
  perform public._late_log('note_added', c.staff_id, c.id, null, jsonb_build_object('day', c.day, 'note', v_note));
end $$;

-- ---- owner: dismiss, or keep watching ----
create or replace function public.late_alert_dismiss(p_alert uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a public.late_optout_alerts;
begin
  if not public.is_owner() then raise exception 'Only the owner can do that.'; end if;
  select * into a from public.late_optout_alerts where id = p_alert for update;
  if not found then raise exception 'That alert could not be found.'; end if;
  if a.state <> 'open' then raise exception 'Only an open alert can be dismissed.'; end if;
  update public.late_optout_alerts
     set state = 'dismissed', dismissed_by = auth.uid(), dismissed_by_name = public._actor_name(), dismissed_at = now(), watching = false, updated_at = now()
   where id = a.id;
  perform public._late_log('alert_dismissed', a.staff_id, null, a.id, jsonb_build_object('month', a.month, 'count', a.event_count));
end $$;

create or replace function public.late_alert_watch(p_alert uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a public.late_optout_alerts;
begin
  if not public.is_owner() then raise exception 'Only the owner can do that.'; end if;
  select * into a from public.late_optout_alerts where id = p_alert for update;
  if not found then raise exception 'That alert could not be found.'; end if;
  if a.state <> 'open' then raise exception 'Only an open alert can be watched.'; end if;
  update public.late_optout_alerts set watching = true, watching_by = public._actor_name(), watching_at = now(), updated_at = now() where id = a.id;
  perform public._late_log('alert_watching', a.staff_id, null, a.id, jsonb_build_object('month', a.month, 'count', a.event_count));
end $$;

-- ---- sample data for the demo only: three late opt-outs by one casual in the current month ----
create or replace function public._seed_late_sample(t date) returns void
language plpgsql security definer set search_path = public as $$
declare anchor date; d date; first_ok date; n int := 0; sid uuid; cov uuid[]; v_id uuid;
  notice numeric[] := array[20, 9, 30]; why text[] := array['Unwell', null, 'Family matter'];
begin
  select id into sid from public.staff where name = 'Callum Reid';
  if sid is null then return; end if;
  cov := array[(select id from public.staff where name = 'Priya Nair'), (select id from public.staff where name = 'Liam Tran'), (select id from public.staff where name = 'Sofia Lindqvist')];
  anchor := case when extract(day from t) >= 15 then t else (date_trunc('month', t)::date - 1) end;   -- early in a month, use last month so three events fit
  first_ok := date_trunc('month', anchor)::date + 2;
  d := anchor - 1;
  while n < 3 and d >= first_ok loop
    if extract(isodow from d) in (2, 3, 4) then        -- Callum works Tuesday to Thursday
      n := n + 1;
      insert into public.cover_requests (kind, phase, status, staff_id, day, start_h, end_h, w_from, w_to, reason, covered_by, covered_via, covered_at, opted_out_at, notice_hours, triggered_standby)
      values ('late', 'standby', 'covered', sid, d, 7, 15, 7, 15, why[n], cov[n], 'standby', now(), d::timestamp + interval '7 hours' - notice[n] * interval '1 hour', notice[n], true)
      returning id into v_id;
      perform public._late_record_event(v_id);
    end if;
    d := d - 1;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. Permissions
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on public.open_shifts to authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.owner_exists() to anon, authenticated;
grant execute on function
  public.cafe_clock(), public.request_leave(date, date, text, text, text), public.withdraw_leave(uuid),
  public.cancel_shift(uuid, text, text), public.owner_record_cancellation(uuid, text, text),
  public.register_open_shift(uuid), public.respond_standby_alert(uuid, boolean), public.escalate_due_cover(),
  public.owner_open_gap(date, int, int, int, int, text), public.owner_alert_standby(uuid, uuid[]),
  public.save_roster(date, text, jsonb, jsonb), public.publish_roster(date), public.update_my_availability(jsonb, jsonb),
  public.update_my_standby(jsonb), public.send_chat(text),
  public.late_alerts(), public.late_save_settings(int, int), public.late_event_excuse(uuid, boolean, text), public.late_event_note(uuid, text),
  public.late_alert_dismiss(uuid), public.late_alert_watch(uuid),
  public.seed_demo(boolean)
to authenticated;
-- the helpers below are used inside row level security policies, which run as the signed-in user
grant execute on function public.is_owner(), public.is_member(), public.my_staff_id(), public.cafe_now(), public.cafe_today() to authenticated;
