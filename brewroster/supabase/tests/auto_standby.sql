-- Tests for automatic standby alerts. Needs supabase_stub.sql + schema.sql loaded first (TEST ONLY).
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


create or replace function t.cancel_at(p_email text, p_name text, p_day date, p_hours numeric) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform t.clock(to_char(p_day::timestamp + interval '7 hours' - p_hours * interval '1 hour', 'YYYY-MM-DD HH24:MI:SS') || '+11');
  perform t.login(p_email);
  r := public.cancel_shift((select id from public.shifts where staff_id = t.sid(p_name) and day = p_day), 'Test', null)::jsonb;
  perform t.logout();
  return r;
end $$;
-- who has been sent a standby call for the cover request of this person and day
create or replace function t.called(p_name text, p_day date) returns text language sql as $$
  select coalesce(string_agg(split_part(s.name, ' ', 1), ',' order by s.name), '')
    from public.standby_alerts a join public.staff s on s.id = a.staff_id
   where a.cover_id = (select id from public.cover_requests where staff_id = t.sid(p_name) and day = p_day) $$;
create or replace function t.reset() returns void language plpgsql as $$
begin
  delete from public.late_audit where true; delete from public.late_optout_alerts where true; delete from public.standby_alerts where true;
  delete from public.cover_requests where true; delete from public.chat_messages where true;
  delete from public.shifts where via = 'standby';
  update public.settings set auto_standby = true where id = 1;
end $$;
grant execute on all functions in schema t to authenticated;

-- ---------------------------------------------------------------- setup
select t.clock('2026-10-15 19:46:00+11');
insert into auth.users (email, encrypted_password, raw_user_meta_data) values ('dana@littlewren.example', 'x', '{"name":"Dana Kerr"}');
select t.login('dana@littlewren.example'); select public.seed_demo(false); select t.logout();
-- everyone has an account except Amara
insert into auth.users (email, encrypted_password)
  select email, 'x' from public.staff_private where email is not null and email not like 'amara@%' and email not like 'dana@%';
select t.assert((select count(*) from public.profiles where role = 'employee') = 9, 'nine staff have accounts, Amara does not');
select t.reset();
delete from public.shifts where day between '2026-10-19' and '2026-10-25';
insert into public.rosters (week_start, source, status, uploaded_at) values ('2026-10-19', 'manual', 'uploaded', now()) on conflict (week_start) do update set status = 'uploaded', uploaded_at = now();
-- Tuesday 20 Oct: Liam works 7 to 3, and so does Zoe
insert into public.shifts (day, staff_id, start_h, end_h) values ('2026-10-20', t.sid('Liam'), 7, 15), ('2026-10-20', t.sid('Zoe'), 7, 15), ('2026-10-21', t.sid('Liam'), 7, 15);
-- who ticked Tuesday: Sofia, Jack, Amara, Zoe, Ethan, Noah, Maya, Callum (not Priya, not Liam)
update public.staff_private set standby_days = '[false,false,false,false,false,false,false]';
update public.staff_private set standby_days = '[false,true,false,false,false,false,false]'
 where staff_id in (t.sid('Sofia'), t.sid('Jack'), t.sid('Amara'), t.sid('Zoe'), t.sid('Ethan'), t.sid('Noah'), t.sid('Maya'), t.sid('Callum'));
update public.staff_private set standby_days = '[false,false,true,false,false,false,false]' where staff_id = t.sid('Priya');
update public.staff_private set standby_days = '[false,true,false,false,false,false,false]' where staff_id = t.sid('Liam');
-- Jack is on approved leave (sample data: 19 to 21 Oct). Ethan has leave waiting for a decision that day. Noah is at his weekly limit.
insert into public.leave_requests (staff_id, from_day, to_day, type, reason, message, submitted, status) values (t.sid('Ethan'), '2026-10-20', '2026-10-20', 'Annual', 'x', 'x', '2026-10-01', 'pending');
update public.staff_private set max_hours = 5 where staff_id = t.sid('Noah');
select t.assert(exists (select 1 from public.leave_requests where staff_id = t.sid('Jack') and status = 'approved' and '2026-10-20' between from_day and to_day), 'setup: Jack is on approved leave on the 20th');

-- weekly hours that week (19 to 25 Oct) for the three who can take it: Maya 0, Callum 8, Sofia 16. Order of offer should be Maya, Callum, Sofia.
insert into public.shifts (day, staff_id, start_h, end_h) values ('2026-10-19', t.sid('Callum'), 7, 15), ('2026-10-22', t.sid('Sofia'), 7, 15), ('2026-10-23', t.sid('Sofia'), 7, 15);
create or replace function t.reply(p_email text, p_cover_day date, p_who text, p_yes boolean) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform t.login(p_email);
  r := public.respond_standby_alert((select a.id from public.standby_alerts a where a.staff_id = t.sid(p_who) and a.day = p_cover_day and a.status = 'sent'), p_yes)::jsonb;
  perform t.logout();
  return r;
end $$;
grant execute on all functions in schema t to authenticated;

-- ================================================================ 1. A late cancellation offers the shift to ONE person: whoever has worked the fewest hours that week
select t.reset();
-- Callum has an open late opt-out alert (owner flag); it must not stop him being offered cover
insert into public.late_optout_alerts (staff_id, month, state, event_count) values (t.sid('Callum'), '2026-10-01', 'open', 3);
select t.assert(t.called('Liam', date '2026-10-20') = '', '1: nothing to start with');
select t.assert((t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20) ->> 'phase') = 'standby', '1: a cancellation under 48 hours goes to standby');
select t.assert(t.called('Liam', date '2026-10-20') = 'Maya', '1: only Maya (0 hours that week) is offered it first: ' || t.called('Liam', date '2026-10-20'));
select t.assert((select count(*) from public.standby_alerts where status = 'sent') = 1, '1: one call is waiting');
select t.assert((select count(*) from public.standby_alerts where day = '2026-10-20' and from_h = 7 and to_h = 15) = 1, '1: the call is for the cancelled shift hours');
select t.assert((select count(*) from public.shifts where day = '2026-10-20') = 2, '1: the roster is unchanged by sending an alert (Liam and Zoe still rostered)');
select t.assert((select status from public.cover_requests where staff_id = t.sid('Liam') and day = '2026-10-20') = 'open', '1: the shift stays open until someone accepts');

-- ================================================================ 2. A No moves it to the next fairest person, and the flagged person is still offered cover
select t.assert((t.reply('maya@littlewren.example', date '2026-10-20', 'Maya', false) ->> 'result') = 'declined', '2: Maya says No');
select t.assert(t.called('Liam', date '2026-10-20') = 'Callum,Maya', '2: Callum (8 hours) is next: ' || t.called('Liam', date '2026-10-20'));
select t.assert(exists (select 1 from public.standby_alerts a where a.staff_id = t.sid('Callum') and a.status = 'sent'), '2: Callum has an open late opt-out alert and is still offered cover');
select t.assert((t.reply('callum@littlewren.example', date '2026-10-20', 'Callum', false) ->> 'result') = 'declined', '2: Callum says No');
select t.assert(t.called('Liam', date '2026-10-20') = 'Callum,Maya,Sofia', '2: Sofia (16 hours) is last: ' || t.called('Liam', date '2026-10-20'));
select t.assert((t.reply('sofia@littlewren.example', date '2026-10-20', 'Sofia', false) ->> 'result') = 'declined', '2: Sofia says No');
select t.assert((select count(*) from public.standby_alerts) = 3, '2: nobody else is eligible, so no further calls');
select t.assert(not exists (select 1 from public.standby_alerts a where a.staff_id in (t.sid('Jack'), t.sid('Amara'), t.sid('Zoe'), t.sid('Ethan'), t.sid('Noah'), t.sid('Priya'), t.sid('Liam'))), '2: never Jack (leave), Amara (no account), Zoe (working), Ethan (leave pending), Noah (hours limit), Priya (did not tick Tuesday) or Liam (cancelled)');
select t.assert((select status from public.cover_requests where staff_id = t.sid('Liam') and day = '2026-10-20') = 'open', '2: the shift is still open for the owner to deal with');

-- ================================================================ 3. Yes gets the shift; nothing changes before that
select t.reset();
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20);
select t.assert((t.reply('maya@littlewren.example', date '2026-10-20', 'Maya', true) ->> 'result') = 'accepted', '3: Maya says Yes');
select t.assert((select via from public.shifts where staff_id = t.sid('Maya') and day = '2026-10-20') = 'standby', '3: Maya is put on the shift');
select t.assert((select status from public.cover_requests where staff_id = t.sid('Liam') and day = '2026-10-20') = 'covered', '3: the shift is covered');
select t.assert(t.called('Liam', date '2026-10-20') = 'Maya', '3: nobody else was bothered');
select t.assert((select count(*) from public.shifts where day = '2026-10-20' and via = 'standby') = 1, '3: only one person is added');

-- ================================================================ 3b. No reply in 30 minutes moves it on
select t.reset();
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20);
select t.login('sofia@littlewren.example'); select public.escalate_due_cover(); select t.logout();
select t.assert(t.called('Liam', date '2026-10-20') = 'Maya', '3b: still Maya inside the 30 minutes: ' || t.called('Liam', date '2026-10-20'));
update public.standby_alerts set sent_at = now() - interval '31 minutes' where true;
select t.login('sofia@littlewren.example'); select public.escalate_due_cover(); select t.logout();
select t.assert((select status from public.standby_alerts where staff_id = t.sid('Maya')) = 'expired', '3b: Maya lost her turn');
select t.assert(t.called('Liam', date '2026-10-20') = 'Callum,Maya', '3b: Callum is offered it next: ' || t.called('Liam', date '2026-10-20'));
select t.login('sofia@littlewren.example'); select public.escalate_due_cover(); select t.logout();
select t.assert((select count(*) from public.standby_alerts) = 2, '3b: and it does not offer it again while Callum has his turn');

-- ================================================================ 3c. Equal hours: whoever has picked up fewer standby shifts lately goes first
select t.reset();
delete from public.shifts where day between '2026-10-19' and '2026-10-25';
insert into public.shifts (day, staff_id, start_h, end_h) values ('2026-10-20', t.sid('Liam'), 7, 15), ('2026-10-20', t.sid('Zoe'), 7, 15),
  ('2026-10-19', t.sid('Callum'), 7, 15), ('2026-10-19', t.sid('Maya'), 7, 15), ('2026-10-22', t.sid('Sofia'), 7, 15), ('2026-10-23', t.sid('Sofia'), 7, 15);
insert into public.shifts (day, staff_id, start_h, end_h, via) values ('2026-10-10', t.sid('Maya'), 7, 15, 'standby');
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20);
select t.assert(t.called('Liam', date '2026-10-20') = 'Callum', '3c: Callum and Maya both have 8 hours; Maya picked up a standby shift recently, so Callum is first: ' || t.called('Liam', date '2026-10-20'));

-- ================================================================ 3d. Under 3 hours to go there is no time to wait, so everyone free is offered it at once
select t.reset();
delete from public.shifts where day between '2026-10-19' and '2026-10-25';
insert into public.shifts (day, staff_id, start_h, end_h) values ('2026-10-20', t.sid('Liam'), 7, 15), ('2026-10-20', t.sid('Zoe'), 7, 15),
  ('2026-10-19', t.sid('Callum'), 7, 15), ('2026-10-22', t.sid('Sofia'), 7, 15), ('2026-10-23', t.sid('Sofia'), 7, 15);
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 2);
select t.assert(t.called('Liam', date '2026-10-20') = 'Callum,Maya,Sofia', '3d: all three are offered it at once: ' || t.called('Liam', date '2026-10-20'));
select t.assert((t.reply('sofia@littlewren.example', date '2026-10-20', 'Sofia', true) ->> 'result') = 'accepted', '3d: Sofia says Yes first');
select t.assert((select count(*) from public.standby_alerts where status = 'expired') = 2, '3d: the other two calls close');

-- ================================================================ 4. An opt-out with 48 hours or more notice is posted to the chat, not alerted
select t.reset();
insert into public.shifts (day, staff_id, start_h, end_h) select '2026-10-21', t.sid('Liam'), 7, 15 where not exists (select 1 from public.shifts where day = '2026-10-21' and staff_id = t.sid('Liam'));
select t.assert((t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-21', 100) ->> 'phase') = 'chat', '4: 100 hours notice goes to the team chat');
select t.assert(t.called('Liam', date '2026-10-21') = '', '4: no standby calls yet');

-- ================================================================ 5. Unclaimed chat shifts are alerted when they escalate at 48 hours
select t.clock('2026-10-19 06:00:00+11');   -- Wed 21 Oct 7am is 49 hours away
select t.login('sofia@littlewren.example'); select t.assert(public.escalate_due_cover() = 0, '5: not due yet'); select t.logout();
select t.assert(t.called('Liam', date '2026-10-21') = '', '5: still no calls at 49 hours');
select t.clock('2026-10-19 08:30:00+11');   -- 46.5 hours away
select t.login('sofia@littlewren.example'); select t.assert(public.escalate_due_cover() = 1, '5: escalates at 48 hours'); select t.logout();
select t.assert((select phase from public.cover_requests where staff_id = t.sid('Liam') and day = '2026-10-21') = 'standby', '5: now in standby');
select t.assert(t.called('Liam', date '2026-10-21') = '', '5: nobody ticked Wednesday except Priya, who is free, so she is the only one: ' || t.called('Liam', date '2026-10-21')) where false;
select t.assert(t.called('Liam', date '2026-10-21') = 'Priya', '5: Priya (the only one who ticked Wednesday) was alerted: ' || t.called('Liam', date '2026-10-21'));
select t.login('sofia@littlewren.example'); select t.assert(public.escalate_due_cover() = 0, '5: and only once'); select t.logout();
select t.assert((select count(*) from public.standby_alerts) = 1, '5: no duplicate calls');

-- ================================================================ 6. The owner can turn it off, and can still alert by hand
select t.reset();
select t.login('dana@littlewren.example'); select public.set_auto_standby(false); select t.logout();
select t.assert((select auto_standby from public.settings where id = 1) = false, '6: setting is off');
select t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20);
select t.assert(t.called('Liam', date '2026-10-20') = '', '6: with it off nobody is alerted automatically');
select t.login('dana@littlewren.example');
select t.assert(public.owner_alert_standby((select id from public.cover_requests where staff_id = t.sid('Liam') and day = '2026-10-20'), array[t.sid('Maya')]) = 1, '6: the owner can still alert by hand');
select public.set_auto_standby(true);
select t.logout();
select t.assert(t.called('Liam', date '2026-10-20') = 'Maya', '6: turning it back on does not alert for shifts already open');

-- ================================================================ 7. Only the owner can change the setting
select t.login('maya@littlewren.example');
select t.fails($$select public.set_auto_standby(false)$$, 'Only the owner');
select t.logout();
select t.assert((select auto_standby from public.settings where id = 1) = true, '7: unchanged');
select t.login('maya@littlewren.example');
select t.fails($$select public._standby_autoalert(gen_random_uuid())$$, 'permission denied');
select t.logout();

-- ================================================================ 8. What the person who cancelled gets back does not mention alerts
select t.reset();
select t.assert((select array_agg(k order by k) from jsonb_object_keys(t.cancel_at('liam@littlewren.example', 'Liam', date '2026-10-20', 20)) k) = array['id', 'kind', 'phase'], '8: the reply is only id, kind and phase');

-- ================================================================ 9. A shift that has already finished is not alerted
select t.reset();
delete from public.cover_requests where true;
insert into public.cover_requests (kind, phase, staff_id, day, start_h, end_h, w_from, w_to, status) values ('late', 'standby', t.sid('Liam'), '2026-10-13', 7, 15, 7, 15, 'open');
select t.clock('2026-10-15 19:46:00+11');
select t.assert(public._standby_autoalert((select id from public.cover_requests where day = '2026-10-13')) = 0, '9: nothing sent for a shift in the past');

select 'ALL AUTO STANDBY TESTS PASSED';
