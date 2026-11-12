-- Scenario tests for schema.sql. Needs supabase_stub.sql + schema.sql loaded first (TEST ONLY).
-- Every check raises an exception when it fails, so a clean run means everything passed.
create schema if not exists t;
create or replace function t.assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'ASSERT FAILED: %', msg; end if; end $$;

create or replace function t.uid(p_email text) returns uuid language sql as $$ select id from auth.users where email = p_email $$;
create or replace function t.sid(p_name text) returns uuid language sql as $$ select id from public.staff where name like p_name || '%' $$;

create or replace function t.clock(p_ts text) returns void language plpgsql as $$
begin perform set_config('brewroster.now', p_ts, false); end $$;

-- run a statement and require it to fail with a message containing p_like
create or replace function t.fails(p_sql text, p_like text) returns void language plpgsql as $$
declare ok boolean := false; m text;
begin
  begin execute p_sql; exception when others then ok := true; m := sqlerrm; end;
  if not ok then raise exception 'EXPECTED ERROR BUT SUCCEEDED: %', p_sql; end if;
  if m not ilike '%' || p_like || '%' then raise exception 'WRONG ERROR for %: got "%" wanted "%"', p_sql, m, p_like; end if;
end $$;

create or replace function t.login(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', (select id from auth.users where email = p_email), 'role', 'authenticated')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function t.logout() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', false); perform set_config('request.jwt.claims', '', false); end $$;
grant usage on schema t to authenticated;
grant execute on all functions in schema t to authenticated;

-- ---------------------------------------------------------------- setup
select t.clock('2026-10-15 19:46:00+11');
insert into auth.users (email, encrypted_password, raw_user_meta_data) values ('dana@littlewren.example', 'x', '{"name":"Dana Kerr"}');
select t.assert(public.owner_exists(), 'owner exists after first signup');
select t.assert((select role from public.profiles where email = 'dana@littlewren.example') = 'owner', 'first signup is owner');
select t.assert((select display_name from public.profiles where email = 'dana@littlewren.example') = 'Dana Kerr', 'display name from metadata');

select t.login('dana@littlewren.example');
select public.seed_demo(false);
select t.fails('select public.seed_demo(false)', 'empty cafe');
select t.logout();

select t.assert((select count(*) from public.staff) = 10, '10 staff');
select t.assert((select count(*) from public.leave_requests where status = 'pending') = 5, '5 pending leave');
select t.assert((select count(*) from public.pos_hourly) > 400, 'pos history seeded');
select t.assert((select min(day) from public.pos_hourly) = date '2026-08-20', 'history starts 56 days back: ' || (select min(day) from public.pos_hourly));
select t.assert((select count(*) from public.events) = 5, '5 events');
select t.assert((select min(from_day) from public.leave_requests where status = 'pending') = date '2026-10-26', 'Maya leave 26 Oct');

insert into auth.users (email, encrypted_password) values
  ('maya@littlewren.example', 'x'), ('callum@littlewren.example', 'x'), ('priya@littlewren.example', 'x'),
  ('zoe@littlewren.example', 'x'), ('sofia@littlewren.example', 'x'), ('jack@littlewren.example', 'x'), ('stranger@gmail.com', 'x');
select t.assert((select role from public.profiles where email = 'maya@littlewren.example') = 'employee', 'maya is employee');
select t.assert((select staff_id from public.profiles where email = 'maya@littlewren.example') = t.sid('Maya'), 'maya linked by email');
select t.assert((select staff_id from public.profiles where email = 'stranger@gmail.com') is null, 'stranger not linked');

-- ---------------------------------------------------------------- row level security
select t.login('maya@littlewren.example');
select t.assert((select count(*) from public.staff) = 10, 'employee sees the team names');
select t.assert((select count(*) from public.staff_private) = 1, 'employee sees only own private row');
select t.assert((select count(*) from public.pos_hourly) = 0, 'employee cannot see sales');
select t.assert((select count(*) from public.leave_requests) = 1, 'employee sees only own leave (Maya has one pending)');
select t.assert((select count(*) from public.profiles) = 1, 'employee sees only own profile');
select t.assert((select count(*) from public.cover_requests) = 0, 'employee cannot read cover table');
update public.staff_private set rate = 999 where staff_id = t.sid('Maya');
update public.leave_requests set status = 'approved' where staff_id = t.sid('Maya');
select t.fails($$insert into public.shifts (day, staff_id, start_h, end_h) values ('2026-10-20', t.sid('Maya'), 7, 12)$$, 'row-level security');
select t.fails($$insert into public.chat_messages (kind, body) values ('note', 'hi')$$, 'row-level security');
select t.fails('select public.seed_demo(true)', 'Only the owner');
select t.fails('select public.publish_roster(date ''2026-10-19'')', 'Only the owner');
select t.logout();
select t.assert((select rate from public.staff_private where staff_id = t.sid('Maya')) = 34, 'rate unchanged by employee update');
select t.assert((select status from public.leave_requests where staff_id = t.sid('Maya')) = 'pending', 'leave unchanged by employee update');

select t.login('stranger@gmail.com');
select t.assert((select count(*) from public.staff) = 0, 'unlinked account sees nothing');
select t.assert((select count(*) from public.open_shifts) = 0, 'unlinked account sees no open shifts');
select t.fails('select public.request_leave(date ''2026-11-20'', date ''2026-11-21'', ''Personal'', ''x'', ''x'')', 'not linked');
select t.logout();

-- ---------------------------------------------------------------- rosters: build, gate, publish
select t.login('dana@littlewren.example');
select t.fails($$select public.save_roster(date '2026-10-26', 'ai', '[]'::jsonb)$$, 'Decide the leave requests');
-- this week: Maya Fri 16 (inside 48h), Callum Sun 18 (opt-out zone)
select public.save_roster(date '2026-10-12', 'ai', jsonb_build_array(
  jsonb_build_object('day', '2026-10-16', 'staff_id', t.sid('Maya'),   'start_h', 7, 'end_h', 14),
  jsonb_build_object('day', '2026-10-16', 'staff_id', t.sid('Liam'),   'start_h', 7, 'end_h', 12),
  jsonb_build_object('day', '2026-10-18', 'staff_id', t.sid('Callum'), 'start_h', 8, 'end_h', 14),
  jsonb_build_object('day', '2026-10-18', 'staff_id', t.sid('Priya'),  'start_h', 7, 'end_h', 13)));
-- next week: includes Jack on approved leave (must block upload) and Liam Tue
select public.save_roster(date '2026-10-19', 'manual', jsonb_build_array(
  jsonb_build_object('day', '2026-10-20', 'staff_id', t.sid('Liam'),  'start_h', 7, 'end_h', 12),
  jsonb_build_object('day', '2026-10-20', 'staff_id', t.sid('Jack'),  'start_h', 11, 'end_h', 15),
  jsonb_build_object('day', '2026-10-21', 'staff_id', t.sid('Maya'),  'start_h', 7, 'end_h', 14)));
select t.fails($$select public.publish_roster(date '2026-10-19')$$, 'approved leave');
select public.save_roster(date '2026-10-19', 'manual', jsonb_build_array(
  jsonb_build_object('day', '2026-10-20', 'staff_id', t.sid('Liam'),  'start_h', 7, 'end_h', 12),
  jsonb_build_object('day', '2026-10-20', 'staff_id', t.sid('Ethan'), 'start_h', 9, 'end_h', 15),
  jsonb_build_object('day', '2026-10-21', 'staff_id', t.sid('Maya'),  'start_h', 7, 'end_h', 14)));
select t.logout();

select t.login('maya@littlewren.example');
select t.assert((select count(*) from public.shifts) = 0, 'drafts are invisible to staff');
select t.assert((select count(*) from public.rosters) = 0, 'draft rosters are invisible to staff');
select t.logout();

select t.login('dana@littlewren.example');
select public.publish_roster(date '2026-10-12');
select public.publish_roster(date '2026-10-19');
select t.fails($$select public.save_roster(date '2026-10-12', 'ai', '[]'::jsonb)$$, 'already uploaded');
select t.assert((select count(*) from public.chat_messages where body like 'Roster for the week%') = 2, 'upload notes in chat');
select t.logout();

select t.login('maya@littlewren.example');
select t.assert((select count(*) from public.shifts) = 7, 'staff see uploaded rosters, everyone''s shifts: ' || (select count(*) from public.shifts));
select t.assert((select count(*) from public.chat_messages) = 2, 'staff see chat');
select t.logout();

-- ---------------------------------------------------------------- cancelling: inside 48h goes to Standby
select t.login('maya@littlewren.example');
select t.fails($$select public.cancel_shift((select id from public.shifts where staff_id = t.sid('Liam') and day = '2026-10-16'), 'x', 'x')$$, 'own shifts');
select t.assert((public.cancel_shift((select id from public.shifts where staff_id = t.sid('Maya') and day = '2026-10-16'), 'Unwell', 'Fever')::jsonb ->> 'kind') = 'late', 'inside 48h is a late cancellation');
select t.fails($$select public.cancel_shift((select id from public.shifts where staff_id = t.sid('Maya') and day = '2026-10-16'), 'x', 'x')$$, 'already cancelled');
select t.logout();
select t.assert((select phase from public.cover_requests where kind = 'late' and staff_id = t.sid('Maya')) = 'standby', 'late cancel goes to standby');
select t.assert((select reason from public.cover_requests where kind = 'late' and staff_id = t.sid('Maya')) = 'Unwell', 'reason kept for the owner');
select t.assert((select count(*) from public.chat_messages where cover_id is not null) = 0, 'late cancellation is not posted to the chat');

-- ---------------------------------------------------------------- opting out 48h to 14 days: team chat, normal pay
select t.login('callum@littlewren.example');
select t.assert((public.cancel_shift((select id from public.shifts where staff_id = t.sid('Callum')), 'Family lunch', 'Nan''s birthday')::jsonb ->> 'kind') = 'optout', 'outside 48h is an opt-out');
select t.logout();
select t.assert((select count(*) from public.chat_messages where kind = 'open') = 1, 'opt-out posted to the chat');
select t.assert((select body from public.chat_messages where kind = 'open') like 'Open shift: Sun 18 Oct, 8am–2pm. Callum can no longer work it. Normal pay.', 'chat wording: ' || (select body from public.chat_messages where kind = 'open'));

-- the open shift view hides the reason
select t.login('priya@littlewren.example');
select t.assert((select count(*) from public.open_shifts where status = 'open') = 2, 'employees see both open items');
select t.fails('select reason from public.open_shifts', 'does not exist');
select t.assert((select count(*) from public.cover_requests) = 0, 'employee cannot read the private cover table');
-- Priya is already rostered that Sunday: cannot register
select t.fails($$select public.register_open_shift((select id from public.open_shifts where kind = 'optout'))$$, 'already have a shift');
select t.logout();

select t.login('zoe@littlewren.example');
select t.fails($$select public.register_open_shift((select id from public.open_shifts where kind = 'late' and staff_id = t.sid('Maya')))$$, 'moved to Standby');
select public.register_open_shift((select id from public.open_shifts where kind = 'optout'));
select t.logout();
select t.assert((select status from public.cover_requests where kind = 'optout') = 'covered', 'opt-out covered');
select t.assert((select via from public.shifts where staff_id = t.sid('Zoe') and day = '2026-10-18') = 'chat', 'registered shift is added with via=chat');
select t.assert((select start_h || '-' || end_h from public.shifts where staff_id = t.sid('Zoe') and day = '2026-10-18') = '8-14', 'registered into the original window');
select t.login('sofia@littlewren.example');
select t.fails($$select public.register_open_shift((select id from public.open_shifts where kind = 'optout'))$$, 'already been filled');
select t.logout();

-- ---------------------------------------------------------------- escalation at 48 hours
-- Liam opts out of Tue 20 Oct 7am on Thursday evening (4+ days away)
select t.login('dana@littlewren.example');
select t.assert((public.owner_record_cancellation((select id from public.shifts where staff_id = t.sid('Liam') and day = '2026-10-20'), 'Physio', null)::jsonb ->> 'phase') = 'chat', 'owner-recorded opt-out goes to the chat');
select t.assert(public.escalate_due_cover() = 0, 'nothing due yet');
select t.logout();
select t.clock('2026-10-18 06:00:00+11');   -- Tue 7am is 49h away
select t.login('sofia@littlewren.example');
select t.assert(public.escalate_due_cover() = 0, 'still 49h away');
select t.logout();
select t.clock('2026-10-18 08:30:00+11');   -- 46.5h away
select t.login('sofia@littlewren.example');
select t.assert(public.escalate_due_cover() = 1, 'escalates once inside 48h');
select t.assert(public.escalate_due_cover() = 0, 'and only once');
select t.fails($$select public.register_open_shift((select id from public.open_shifts where staff_id = t.sid('Liam')))$$, 'moved to Standby');
select t.logout();
select t.assert((select phase from public.cover_requests where staff_id = t.sid('Liam')) = 'standby', 'phase is standby');
select t.assert((select count(*) from public.chat_messages where body like 'Nobody registered for Tue 20 Oct%') = 1, 'escalation note posted');

-- ---------------------------------------------------------------- standby calls
select t.login('dana@littlewren.example');
select t.assert(public.owner_alert_standby((select id from public.cover_requests where staff_id = t.sid('Liam')), array[t.sid('Sofia'), t.sid('Jack')]) = 2, 'two calls sent');
select t.assert(public.owner_alert_standby((select id from public.cover_requests where staff_id = t.sid('Liam')), array[t.sid('Sofia')]) = 0, 'no duplicate calls');
select t.logout();
select t.login('jack@littlewren.example');
select t.assert((select count(*) from public.standby_alerts) = 1, 'Jack sees only his own call');
select t.fails($$select public.respond_standby_alert((select id from public.standby_alerts), true)$$, 'approved leave');
select t.assert((public.respond_standby_alert((select id from public.standby_alerts), false)::jsonb ->> 'result') = 'declined', 'Jack can decline');
select t.fails($$select public.respond_standby_alert((select id from public.standby_alerts), true)$$, 'already replied');
select t.logout();
select t.login('sofia@littlewren.example');
select t.assert((public.respond_standby_alert((select id from public.standby_alerts), true)::jsonb ->> 'result') = 'accepted', 'Sofia accepts');
select t.logout();
select t.assert((select via from public.shifts where staff_id = t.sid('Sofia') and day = '2026-10-20') = 'standby', 'standby shift added');
select t.assert((select status from public.cover_requests where staff_id = t.sid('Liam')) = 'covered', 'cover marked covered');
select t.assert((select covered_via from public.cover_requests where staff_id = t.sid('Liam')) = 'standby', 'covered via standby');

-- ---------------------------------------------------------------- leave rules
select t.clock('2026-10-15 19:46:00+11');
select t.login('dana@littlewren.example');
update public.leave_requests set status = 'declined' where staff_id = t.sid('Liam');
update public.leave_requests set status = 'approved' where staff_id = t.sid('Noah');
update public.leave_requests set status = 'approved' where staff_id = t.sid('Priya');
select public.save_roster(date '2026-11-02', 'ai', jsonb_build_array(jsonb_build_object('day', '2026-11-03', 'staff_id', t.sid('Maya'), 'start_h', 7, 'end_h', 14)));
select t.assert((select count(*) from public.shifts where week_start = date '2026-11-02') = 1, 'draft for 2 Nov saved');
select t.fails($$update public.leave_requests set status = 'declined' where staff_id = t.sid('Jack')$$, 'locked');
select t.logout();

select t.login('maya@littlewren.example');
select t.fails($$select public.request_leave(date '2026-10-28', date '2026-10-29', 'Personal', 'x', 'x')$$, '14 days');
select t.fails($$select public.request_leave(date '2026-10-28', date '2026-10-29', 'Personal', 'x', 'x')$$, 'opt out of the shift');
select t.fails($$select public.request_leave(date '2026-11-05', date '2026-11-02', 'Personal', 'x', 'x')$$, 'last day');
-- 18 days ahead is fine and wipes the draft roster for that week
select public.request_leave(date '2026-11-02', date '2026-11-03', 'Personal', 'Trip', 'Away for two days');
select t.assert((select count(*) from public.leave_requests where staff_id = t.sid('Maya')) = 2, 'Maya now has two requests');
select t.fails($$select public.request_leave(date '2026-11-03', date '2026-11-04', 'Personal', 'x', 'x')$$, 'already have leave');
select public.withdraw_leave((select id from public.leave_requests where staff_id = t.sid('Maya') and from_day = '2026-11-02'));
select t.assert((select count(*) from public.leave_requests where staff_id = t.sid('Maya')) = 1, 'withdrawn');
select t.logout();
select t.assert((select count(*) from public.rosters where week_start = date '2026-11-02') = 0, 'draft roster wiped by a new leave request');
select t.assert((select count(*) from public.shifts where week_start = date '2026-11-02') = 0, 'and its shifts');
select t.login('jack@littlewren.example');
select t.fails($$select public.withdraw_leave((select id from public.leave_requests where staff_id = t.sid('Jack')))$$, 'not been decided');
select t.logout();

-- a leave request cannot touch an uploaded week
select t.login('dana@littlewren.example');
update public.leave_requests set status = 'approved' where staff_id in (t.sid('Maya'), t.sid('Zoe')) and status = 'pending';
select public.save_roster(date '2026-10-26', 'ai', jsonb_build_array(jsonb_build_object('day', '2026-10-30', 'staff_id', t.sid('Maya'), 'start_h', 7, 'end_h', 14)));
select public.publish_roster(date '2026-10-26');
select t.logout();
select t.clock('2026-10-10 12:00:00+11');   -- a week earlier, so the 26 Oct week is 16 days away
select t.login('zoe@littlewren.example');
select t.fails($$select public.request_leave(date '2026-10-27', date '2026-10-27', 'Personal', 'x', 'x')$$, 'already uploaded');
select t.logout();
select t.clock('2026-10-15 19:46:00+11');

-- ---------------------------------------------------------------- availability
select t.login('priya@littlewren.example');
select public.update_my_availability('[[7,15],null,null,[7,15],null,null,null]'::jsonb, '[true,false,false,false,false,false,false]'::jsonb);
select t.assert((select avail -> 3 from public.staff_private where staff_id = t.sid('Priya')) = '[7,15]'::jsonb, 'availability saved');
select t.fails($$select public.update_my_availability('[[7,15]]'::jsonb, '[true,false,false,false,false,false,false]'::jsonb)$$, 'seven days');
select t.fails($$select public.update_my_availability('[[9,7],null,null,null,null,null,null]'::jsonb, '[true,false,false,false,false,false,false]'::jsonb)$$, 'do not look right');
select t.logout();

-- ---------------------------------------------------------------- owner posts a gap
select t.login('dana@littlewren.example');
select public.owner_open_gap(date '2026-10-22', 12, 15, 12, 15, 'chat');
select public.owner_open_gap(date '2026-10-22', 12, 15, 12, 15, 'chat');
select t.assert((select count(*) from public.cover_requests where kind = 'gap') = 1, 'one gap row even if posted twice');
select t.logout();
-- ---------------------------------------------------------------- portals, chat messages, standby sign-up
select t.fails($$insert into auth.users (email, encrypted_password, raw_user_meta_data) values ('second.owner@gmail.com', 'x', '{"portal":"owner"}')$$, 'already has an owner');
insert into auth.users (email, encrypted_password, raw_user_meta_data) values ('newhire@gmail.com', 'x', '{"portal":"employee","name":"New Hire"}');
select t.assert((select role from public.profiles where email = 'newhire@gmail.com') = 'employee', 'employee portal signup is an employee');

select t.login('priya@littlewren.example');
select public.update_my_standby('[false,true,false,true,false,false,false]'::jsonb);
select t.assert((select standby_days from public.staff_private where staff_id = t.sid('Priya')) = '[false,true,false,true,false,false,false]'::jsonb, 'standby days saved');
select t.assert((select avail -> 3 from public.staff_private where staff_id = t.sid('Priya')) = '[7,15]'::jsonb, 'standby save leaves availability alone');
select t.fails($$select public.update_my_standby('[true]'::jsonb)$$, 'seven days');
select t.fails($$select public.update_my_standby('[1,0,0,0,0,0,0]'::jsonb)$$, 'seven days');
select public.send_chat('  Anyone swap Saturday?  ');
select t.assert((select author from public.chat_messages where kind = 'msg') like 'Priya%', 'chat shows the author name');
select t.assert((select body from public.chat_messages where kind = 'msg') = 'Anyone swap Saturday?', 'chat body trimmed');
select t.fails($$select public.send_chat('   ')$$, 'Type a message');
select t.fails($$select public.send_chat(repeat('x', 301))$$, '300');
select t.logout();

select t.login('stranger@gmail.com');
select t.fails($$select public.send_chat('hello')$$, 'people on the team');
select t.fails($$select public.update_my_standby('[true,true,true,true,true,true,true]'::jsonb)$$, 'not linked');
select t.logout();

select t.login('dana@littlewren.example');
select public.send_chat('Roster is up');
select t.assert((select author from public.chat_messages where body = 'Roster is up') = 'Dana Kerr', 'owner chat author');
select t.logout();

select 'ALL SCENARIO TESTS PASSED' as result;
