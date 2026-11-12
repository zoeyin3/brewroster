-- Tests for the late opt-out alert. Needs supabase_stub.sql + schema.sql loaded first (TEST ONLY).
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
-- run an opt-out at a given number of hours before a 7am shift, as that employee
create or replace function t.cancel_at(p_email text, p_name text, p_day date, p_hours numeric) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform t.clock(to_char(p_day::timestamp + interval '7 hours' - p_hours * interval '1 hour', 'YYYY-MM-DD HH24:MI:SS') || '+11');
  perform t.login(p_email);
  r := public.cancel_shift((select id from public.shifts where staff_id = t.sid(p_name) and day = p_day), 'Test', null)::jsonb;
  perform t.logout();
  return r;
end $$;
-- what the owner sees
create or replace function t.alerts() returns jsonb language plpgsql as $$
declare r jsonb;
begin perform t.login('dana@littlewren.example'); r := public.late_alerts()::jsonb; perform t.logout(); return r; end $$;
create or replace function t.alert_of(p_name text, p_month date) returns jsonb language sql as $$
  select a from jsonb_array_elements(t.alerts() -> 'alerts') a where a ->> 'staff_name' like p_name || '%' and (a ->> 'month')::date = p_month $$;
create or replace function t.n_alerts() returns int language sql as $$ select count(*)::int from public.late_optout_alerts $$;
create or replace function t.cover_of(p_name text, p_day date) returns uuid language sql as $$
  select id from public.cover_requests where staff_id = t.sid(p_name) and day = p_day $$;
create or replace function t.reset_late() returns void language plpgsql as $$
begin
  delete from public.late_audit; delete from public.late_optout_alerts; delete from public.standby_alerts; delete from public.cover_requests; delete from public.chat_messages;
  update public.late_settings set threshold = 3, window_h = 48 where id = 1;
end $$;
grant execute on all functions in schema t to authenticated;

-- ---------------------------------------------------------------- setup
select t.clock('2026-10-15 19:46:00+11');
insert into auth.users (email, encrypted_password, raw_user_meta_data) values ('dana@littlewren.example', 'x', '{"name":"Dana Kerr"}');
select t.login('dana@littlewren.example'); select public.seed_demo(false); select t.logout();
insert into auth.users (email, encrypted_password) values
  ('liam@littlewren.example', 'x'), ('maya@littlewren.example', 'x'), ('priya@littlewren.example', 'x'), ('sofia@littlewren.example', 'x');

-- ---------------------------------------------------------------- the demo sample
select t.assert(t.n_alerts() = 1, 'sample cafe starts with exactly one alert');
select t.assert((t.alert_of('Callum', date '2026-10-01') ->> 'state') = 'open', 'sample alert is open');
select t.assert((t.alert_of('Callum', date '2026-10-01') ->> 'event_count')::int = 3, 'sample alert counts 3');
select t.assert(jsonb_array_length(t.alert_of('Callum', date '2026-10-01') -> 'events') = 3, 'sample alert lists 3 events');
select t.assert((select sum((e ->> 'cost')::numeric) from jsonb_array_elements(t.alert_of('Callum', date '2026-10-01') -> 'events') e) = 720, 'sample cost: 8h at 30 + 31 + 29 = 720');
select t.assert((select count(*) from public.late_audit where action = 'event_counted') = 3 and (select count(*) from public.late_audit where action = 'alert_opened') = 1, 'sample events are in the audit log');

-- a test calendar: uploaded rosters for 19 Oct to 8 Nov, and 7am to 3pm shifts for Liam, Maya and Priya every day
select t.reset_late();
insert into public.rosters (week_start, source, status, uploaded_at) values
  ('2026-10-19', 'manual', 'uploaded', now()), ('2026-10-26', 'manual', 'uploaded', now()), ('2026-11-02', 'manual', 'uploaded', now());
insert into public.shifts (day, staff_id, start_h, end_h)
  select d::date, t.sid(n), 7, 15 from generate_series(date '2026-10-19', date '2026-11-08', interval '1 day') d, (values ('Liam'), ('Maya'), ('Priya')) v(n);

-- ================================================================ 1. Normal: 3 late opt-outs in a month make exactly one alert with 3 events
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20);
select t.assert(t.n_alerts() = 0, '1: no alert after the first');
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-21', 10);
select t.assert(t.n_alerts() = 0, '1: no alert after the second');
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-22', 30);
select t.assert(t.n_alerts() = 1, '1: exactly one alert after the third');
select t.assert((t.alert_of('Liam', date '2026-10-01') ->> 'state') = 'open', '1: alert is open');
select t.assert((t.alert_of('Liam', date '2026-10-01') ->> 'event_count')::int = 3, '1: alert counts 3');
select t.assert(jsonb_array_length(t.alert_of('Liam', date '2026-10-01') -> 'events') = 3, '1: alert lists the 3 events');
select t.assert((select string_agg((e ->> 'notice_hours')::numeric(6,1)::text, ',' order by e ->> 'day') from jsonb_array_elements(t.alert_of('Liam', date '2026-10-01') -> 'events') e) = '20.0,10.0,30.0', '1: notice given is stored for each event');
select t.assert((select count(*) from public.late_audit where action = 'event_counted' and staff_id = t.sid('Liam')) = 3, '1: each counted event is in the audit log');
select t.assert((select count(*) from public.late_audit where action = 'alert_opened') = 1, '1: the alert opening is in the audit log');

-- ================================================================ 2. Normal: 2 late opt-outs make no alert
select t.reset_late();
select t.cancel_at('priya@littlewren.example', 'Priya', date '2026-10-20', 20);
select t.cancel_at('priya@littlewren.example', 'Priya', date '2026-10-21', 40);
select t.assert(t.n_alerts() = 0, '2: two late opt-outs: no alert');
select t.assert(public._late_count(t.sid('Priya'), date '2026-10-01') = 2, '2: but both are counted');

-- ================================================================ 3. Normal: a third opt-out with 3 days notice does not count
select t.reset_late();
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-21', 10);
select t.assert((t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-24', 72) ->> 'kind') = 'optout', '3: 3 days notice is an opt-out to the team chat');
select t.assert(t.n_alerts() = 0, '3: no alert');
select t.assert(public._late_count(t.sid('Liam'), date '2026-10-01') = 2, '3: the count stays at 2');
select t.assert((select count(*) from public.late_audit where action = 'event_counted') = 2, '3: the 3-day opt-out is not logged as a counted event');
select t.assert((select triggered_standby from public.cover_requests where staff_id = t.sid('Liam') and day = date '2026-10-24') = false, '3: it did not trigger standby');

-- ================================================================ 4. Boundary: excusing one of three closes the alert
select t.reset_late();
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-21', 10);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-22', 30);
select t.assert(t.n_alerts() = 1, '4: alert is open before excusing');
select t.login('dana@littlewren.example');
select public.late_event_excuse(t.cover_of('Liam', date '2026-10-21'), true, 'Called in sick with a fever');
select t.logout();
select t.assert((t.alert_of('Liam', date '2026-10-01') ->> 'state') = 'closed', '4: the alert closes by itself');
select t.assert((t.alert_of('Liam', date '2026-10-01') ->> 'event_count')::int = 2, '4: the count drops to 2');
select t.assert(jsonb_array_length(t.alert_of('Liam', date '2026-10-01') -> 'events') = 3, '4: the excused event stays in the history');
select t.assert((select e ->> 'note' from jsonb_array_elements(t.alert_of('Liam', date '2026-10-01') -> 'events') e where (e ->> 'excused')::boolean) = 'Called in sick with a fever', '4: the reason is kept as a note');
select t.assert((select e ->> 'excused_by' from jsonb_array_elements(t.alert_of('Liam', date '2026-10-01') -> 'events') e where (e ->> 'excused')::boolean) = 'Dana Kerr', '4: who excused it is kept');
select t.assert((select count(*) from public.late_audit where action = 'event_excused') = 1 and (select count(*) from public.late_audit where action = 'alert_closed') = 1, '4: excusing and closing are in the audit log');
-- taking the excuse back reopens the same alert rather than making a new one
select t.login('dana@littlewren.example'); select public.late_event_excuse(t.cover_of('Liam', date '2026-10-21'), false); select t.logout();
select t.assert(t.n_alerts() = 1 and (t.alert_of('Liam', date '2026-10-01') ->> 'state') = 'open' and (t.alert_of('Liam', date '2026-10-01') ->> 'event_count')::int = 3, '4: removing the excuse reopens the same alert');

-- ================================================================ 5. Boundary: a 4th late opt-out updates the alert, it does not make a second
select t.reset_late();
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-21', 10);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-22', 30);
select t.assert((select id from public.late_optout_alerts) is not null, '5: one alert exists');
create temp table first_alert as select id from public.late_optout_alerts;
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-23', 12);
select t.assert(t.n_alerts() = 1, '5: still exactly one alert');
select t.assert((select id from public.late_optout_alerts) = (select id from first_alert), '5: it is the same alert');
select t.assert((t.alert_of('Liam', date '2026-10-01') ->> 'event_count')::int = 4, '5: its count is now 4');
select t.assert(jsonb_array_length(t.alert_of('Liam', date '2026-10-01') -> 'events') = 4, '5: it lists 4 events');
select t.assert((select count(*) from public.late_audit where action = 'alert_updated') = 1 and (select count(*) from public.late_audit where action = 'alert_opened') = 1, '5: the update is logged, no second opening');
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-24', 8);
select t.assert(t.n_alerts() = 1 and (t.alert_of('Liam', date '2026-10-01') ->> 'event_count')::int = 5, '5: a 5th does the same');

-- ================================================================ 6. Escalation or refusal: only the owner can act, and the alert never touches the employee
select t.reset_late();
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-21', 10);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-22', 30);
-- what an employee gets back from opting out says nothing about any alert (this opt-out is 4 days ahead, so it goes to the chat)
select t.assert((select array_agg(k order by k) from jsonb_object_keys(t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-27', 100)) k) = array['id', 'kind', 'phase'], '6: the opt-out reply has no alert information');
create temp table before_state as select
  (select count(*) from public.shifts where staff_id = t.sid('Liam')) shifts,
  (select max_hours from public.staff_private where staff_id = t.sid('Liam')) max_hours,
  (select count(*) from public.chat_messages) chat, (select count(*) from public.standby_alerts) calls,
  (select count(*) from public.leave_requests) leave;
-- the flagged employee and a colleague cannot see it, or act on it
select t.login('liam@littlewren.example');
select t.assert((select count(*) from public.late_optout_alerts) = 0, '6: flagged employee cannot read alerts');
select t.assert((select count(*) from public.late_audit) = 0, '6: flagged employee cannot read the audit log');
select t.assert((select count(*) from public.late_settings) = 0, '6: flagged employee cannot read the threshold');
select t.assert((select count(*) from public.cover_requests) = 0, '6: flagged employee cannot read the opt-out records');
select t.fails('select public.late_alerts()', 'Only the owner');
select t.fails($$select public.late_alert_dismiss((select id from public.late_optout_alerts))$$, 'Only the owner');
select t.fails($$select public.late_event_excuse(gen_random_uuid(), true)$$, 'Only the owner');
select t.fails('select public.late_save_settings(10, 48)', 'Only the owner');
select t.logout();
select t.login('maya@littlewren.example');
select t.assert((select count(*) from public.late_optout_alerts) = 0 and (select count(*) from public.late_audit) = 0, '6: a colleague cannot see it either');
select t.fails('select public.late_alerts()', 'Only the owner');
select t.fails($$select public.late_alert_watch(gen_random_uuid())$$, 'Only the owner');
-- asked to remove the flagged employee's shifts or message them, nobody but the owner can: the data layer refuses
select t.fails($$select public.save_roster(date '2026-10-26', 'manual', '[]'::jsonb)$$, 'Only the owner');
select t.fails($$select public.owner_alert_standby(gen_random_uuid(), array[t.sid('Liam')])$$, 'Only the owner');
delete from public.shifts where staff_id = t.sid('Liam');
select t.logout();
select t.assert((select count(*) from public.shifts where staff_id = t.sid('Liam')) = (select shifts from before_state), '6: a colleague cannot delete the flagged employee''s shifts');
-- and the alert actions themselves are information only
select t.login('dana@littlewren.example');
select public.late_alert_watch((select id from public.late_optout_alerts));
select public.late_event_note(t.cover_of('Liam', date '2026-10-20'), 'Checked in with Liam');
select public.late_event_excuse(t.cover_of('Liam', date '2026-10-22'), true);
select public.late_event_excuse(t.cover_of('Liam', date '2026-10-22'), false);
select public.late_alert_dismiss((select id from public.late_optout_alerts));
select t.logout();
select t.assert((select count(*) from public.shifts where staff_id = t.sid('Liam')) = (select shifts from before_state), '6: no shift removed');
select t.assert((select max_hours from public.staff_private where staff_id = t.sid('Liam')) = (select max_hours from before_state), '6: hours limit not lowered');
select t.assert((select count(*) from public.chat_messages) = (select chat from before_state), '6: nothing posted to the team chat');
select t.assert((select count(*) from public.standby_alerts) = (select calls from before_state), '6: nobody was called or messaged');
select t.assert((select count(*) from public.leave_requests) = (select leave from before_state), '6: leave untouched');

-- ================================================================ 7. Month rollover: counts reset on the 1st
select t.reset_late();
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-28', 12);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-30', 29);
-- opted out at 11:30pm on 31 October for a 7am shift on 1 November: it counts in October (the month it was made)
select t.clock('2026-10-31 23:30:00+11');
select t.login('liam@littlewren.example'); select public.cancel_shift((select id from public.shifts where staff_id = t.sid('Liam') and day = date '2026-11-01'), 'Test', null); select t.logout();
select t.assert(public._late_count(t.sid('Liam'), date '2026-10-01') = 3 and t.n_alerts() = 1, '7: three in October make the October alert');
select t.assert((t.alert_of('Liam', date '2026-10-01') ->> 'event_count')::int = 3, '7: October alert counts 3');
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-11-02', 11);
select t.assert(public._late_count(t.sid('Liam'), date '2026-11-01') = 1, '7: on 1 November the count starts again at 1');
select t.assert(t.n_alerts() = 1 and (t.alert_of('Liam', date '2026-10-01') ->> 'event_count')::int = 3, '7: October is untouched and no new alert yet');
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-11-03', 15);
select t.assert(t.n_alerts() = 1, '7: two in November: still no new alert');
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-11-04', 9);
select t.assert(t.n_alerts() = 2, '7: three in November make a separate November alert');
select t.assert((t.alert_of('Liam', date '2026-11-01') ->> 'event_count')::int = 3 and (t.alert_of('Liam', date '2026-10-01') ->> 'event_count')::int = 3, '7: each month has its own count');

-- ================================================================ extra checks
-- dismissing stores who and when; a later event updates the count but does not bring a dismissed alert back
select t.reset_late();
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-21', 10);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-22', 30);
select t.login('dana@littlewren.example'); select public.late_alert_dismiss((select id from public.late_optout_alerts)); select t.logout();
select t.assert((select state from public.late_optout_alerts) = 'dismissed' and (select dismissed_by_name from public.late_optout_alerts) = 'Dana Kerr' and (select dismissed_at from public.late_optout_alerts) is not null, 'dismissal stores who and when');
select t.assert((select dismissed_by from public.late_optout_alerts) = t.uid('dana@littlewren.example'), 'dismissal stores the owner account');
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-23', 12);
select t.assert(t.n_alerts() = 1 and (select state from public.late_optout_alerts) = 'dismissed' and (select event_count from public.late_optout_alerts) = 4, 'a dismissed alert stays dismissed, count still updates');
select t.login('dana@littlewren.example'); select t.fails($$select public.late_alert_dismiss((select id from public.late_optout_alerts))$$, 'Only an open alert'); select t.logout();

-- keep watching: leaves the owner's list until something new happens
select t.reset_late();
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-21', 10);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-22', 30);
select t.login('dana@littlewren.example'); select public.late_alert_watch((select id from public.late_optout_alerts)); select t.logout();
select t.assert((select watching from public.late_optout_alerts) and (select state from public.late_optout_alerts) = 'open', 'keep watching leaves it open and marked');
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-23', 12);
select t.assert(not (select watching from public.late_optout_alerts), 'a new late opt-out brings a watched alert back to the owner');
select t.assert((select count(*) from public.late_audit where action = 'alert_watching') = 1, 'keep watching is logged');

-- notice window: under the window counts, at or over does not
select t.reset_late();
select t.assert((t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 47.9) ->> 'kind') = 'late', '47.9 hours notice is a late opt-out');
select t.assert(public._late_count(t.sid('Liam'), date '2026-10-01') = 1, '47.9 hours notice counts');
select t.assert((t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-21', 48.1) ->> 'kind') = 'optout', '48.1 hours notice is an opt-out to the chat');
select t.assert(public._late_count(t.sid('Liam'), date '2026-10-01') = 1, '48.1 hours notice does not count');
-- owner-editable threshold and window
select t.login('dana@littlewren.example');
select t.fails('select public.late_save_settings(1, 48)', 'between 2 and 20');
select t.fails('select public.late_save_settings(3, 72)', 'between 1 and 48');
select public.late_save_settings(2, 48);
select t.logout();
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-22', 20);
select t.assert(t.n_alerts() = 1, 'lowering the threshold to 2 makes the alert at 2');
select t.login('dana@littlewren.example'); select public.late_save_settings(4, 48); select t.logout();
select t.assert((select state from public.late_optout_alerts) = 'closed', 'raising the threshold closes an alert that is now below it');
select t.login('dana@littlewren.example'); select public.late_save_settings(2, 24); select t.logout();
select t.assert(public._late_count(t.sid('Liam'), date '2026-10-01') = 1, 'a 24 hour window leaves only the 20 hour notice counted');
select t.assert((select count(*) from public.late_audit where action = 'settings_changed') = 3, 'settings changes are logged');

-- cost estimate: cover hours x the cover person's pay rate, hidden when there is no pay data
select t.reset_late(); update public.late_settings set threshold = 2 where id = 1;
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20);
select t.login('dana@littlewren.example'); select public.owner_alert_standby(t.cover_of('Liam', date '2026-10-20'), array[t.sid('Sofia')]); select t.logout();
select t.login('sofia@littlewren.example'); select public.respond_standby_alert((select id from public.standby_alerts), true); select t.logout();
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-21', 10);
select t.assert((select (e ->> 'cost')::numeric from jsonb_array_elements(t.alert_of('Liam', date '2026-10-01') -> 'events') e where e ->> 'day' = '2026-10-20') = 232, 'cost = 8 hours x Sofia''s $29');
select t.assert((select (e ->> 'covered_by_name') from jsonb_array_elements(t.alert_of('Liam', date '2026-10-01') -> 'events') e where e ->> 'day' = '2026-10-20') = 'Sofia Lindqvist', 'who covered it is shown');
select t.assert((select e -> 'cost' from jsonb_array_elements(t.alert_of('Liam', date '2026-10-01') -> 'events') e where e ->> 'day' = '2026-10-21') = 'null'::jsonb, 'no cover yet means no cost is shown for that event');
select t.assert((select count(*) from public.late_audit where action = 'event_counted') = 2, 'both events are in the audit log');

select 'ALL LATE OPT-OUT TESTS PASSED' as result;
