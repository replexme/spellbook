-- Spellbook usage numbers for one period, as a single JSON row.
-- Parameters: $1 first day, $2 last day (both inclusive, Asia/Seoul dates),
-- $3 "today" (the last day a return visit can have happened).
-- Run with scripts/usage-metrics.mjs. Reads spellbook_usage_events only.
--
-- Definitions (plain words):
--   active accounts  accounts that opened Spellbook on that day
--   new accounts     accounts whose first recorded visit falls in the period
--   activation       new accounts that saved a real edit within 7 days of the
--                    first visit (days 0-6); "downloaded" likewise
--   edit success     (account, document, day) groups with at least one save
--                    that changed the file and no save failure, divided by
--                    groups that changed the file or had a save failure
--   AI success       completed / (completed + failed) per provider;
--                    cancelled requests are counted but left out of the rate
--   D1 / D7          new accounts that came back exactly 1 / 7 days after the
--                    first visit, among those whose day 1 / day 7 has passed;
--                    week1 is "came back on any of days 1-7"
with params as (
  select $1::date as first_day, $2::date as last_day, $3::date as today
),
period as (
  select e.* from spellbook_usage_events e, params p
  where e.day between p.first_day and p.last_day
),
daily as (
  select day, count(distinct account_id)::int as accounts
  from period where event_type = 'visit'
  group by day
),
first_visit as (
  select account_id, min(day) as first_day
  from spellbook_usage_events where event_type = 'visit'
  group by account_id
),
cohort as (
  select f.* from first_visit f, params p
  where f.first_day between p.first_day and p.last_day
),
cohort_stats as (
  select
    count(*)::int as new_accounts,
    count(*) filter (where exists (
      select 1 from spellbook_usage_events e
      where e.account_id = c.account_id and e.event_type = 'first_edit'
        and e.day between c.first_day and c.first_day + 6))::int as activated,
    count(*) filter (where exists (
      select 1 from spellbook_usage_events e
      where e.account_id = c.account_id and e.event_type = 'download'
        and e.day between c.first_day and c.first_day + 6))::int as downloaded,
    count(*) filter (where c.first_day + 1 <= p.today)::int as d1_eligible,
    count(*) filter (where exists (
      select 1 from spellbook_usage_events e
      where e.account_id = c.account_id and e.event_type = 'visit'
        and e.day = c.first_day + 1))::int as d1_returned,
    count(*) filter (where c.first_day + 7 <= p.today)::int as d7_eligible,
    count(*) filter (where exists (
      select 1 from spellbook_usage_events e
      where e.account_id = c.account_id and e.event_type = 'visit'
        and e.day = c.first_day + 7))::int as d7_returned,
    count(*) filter (where c.first_day + 7 <= p.today and exists (
      select 1 from spellbook_usage_events e
      where e.account_id = c.account_id and e.event_type = 'visit'
        and e.day between c.first_day + 1 and c.first_day + 7))::int as week1_returned
  from cohort c, params p
),
edit_groups as (
  select account_id, document_id, day,
    bool_or(event_type = 'save_accepted'
      and coalesce((detail->>'unchanged')::boolean, false) = false) as changed,
    bool_or(event_type in ('save_rejected', 'save_failed_client')) as failed
  from period
  where event_type in ('save_accepted', 'save_rejected', 'save_failed_client')
  group by account_id, document_id, day
),
edit_stats as (
  select
    count(*) filter (where changed or failed)::int as edit_groups,
    count(*) filter (where changed and not failed)::int as successful_groups
  from edit_groups
),
save_counts as (
  select
    count(*) filter (where event_type = 'save_accepted')::int as accepted,
    count(*) filter (where event_type = 'save_accepted'
      and coalesce((detail->>'unchanged')::boolean, false) = false)::int as accepted_with_changes,
    count(*) filter (where event_type = 'save_rejected')::int as rejected,
    count(*) filter (where event_type = 'save_failed_client')::int as client_failures,
    count(*) filter (where event_type = 'upload')::int as uploads,
    count(*) filter (where event_type = 'download')::int as downloads
  from period
),
rejections as (
  select coalesce(detail->>'reason', detail->>'stage', 'other') as reason,
    event_type, count(*)::int as count
  from period
  where event_type in ('save_rejected', 'save_failed_client')
  group by 1, 2
),
ai as (
  select coalesce(detail->>'provider', 'default') as provider,
    count(*) filter (where detail->>'outcome' = 'completed')::int as completed,
    count(*) filter (where detail->>'outcome' = 'failed')::int as failed,
    count(*) filter (where detail->>'outcome' = 'cancelled')::int as cancelled
  from period where event_type = 'ai_turn'
  group by 1
),
ai_reasons as (
  select coalesce(detail->>'provider', 'default') as provider,
    coalesce(detail->>'reason', 'other') as reason, count(*)::int as count
  from period where event_type = 'ai_turn' and detail->>'outcome' = 'failed'
  group by 1, 2
)
select json_build_object(
  'period', (select json_build_object('from', first_day, 'to', last_day, 'today', today) from params),
  'dailyActive', coalesce((select json_agg(json_build_object('day', day, 'accounts', accounts) order by day) from daily), '[]'::json),
  'activation', (select json_build_object(
      'newAccounts', new_accounts,
      'editedWithin7Days', activated,
      'downloadedWithin7Days', downloaded) from cohort_stats),
  'retention', (select json_build_object(
      'd1Eligible', d1_eligible, 'd1Returned', d1_returned,
      'd7Eligible', d7_eligible, 'd7Returned', d7_returned,
      'week1Returned', week1_returned) from cohort_stats),
  'edits', (select json_build_object(
      'editGroups', e.edit_groups,
      'successfulGroups', e.successful_groups,
      'savesAccepted', s.accepted,
      'savesAcceptedWithChanges', s.accepted_with_changes,
      'savesRejected', s.rejected,
      'clientReportedFailures', s.client_failures,
      'uploads', s.uploads,
      'downloads', s.downloads) from edit_stats e, save_counts s),
  'saveFailureReasons', coalesce((select json_agg(json_build_object('kind', event_type, 'reason', reason, 'count', count) order by count desc) from rejections), '[]'::json),
  'ai', coalesce((select json_agg(json_build_object('provider', provider, 'completed', completed, 'failed', failed, 'cancelled', cancelled) order by provider) from ai), '[]'::json),
  'aiFailureReasons', coalesce((select json_agg(json_build_object('provider', provider, 'reason', reason, 'count', count) order by count desc) from ai_reasons), '[]'::json)
) as metrics;
