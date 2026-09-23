-- ============================================================================
-- 0011 · RLS helper functions
-- SECURITY DEFINER so a policy on one table can consult another without
-- recursive RLS; STABLE with an empty search_path and fully qualified names.
-- Every helper returns false/NULL when there is no signed-in user.
-- ============================================================================

create function private.is_friend(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.friendships f where f.user_id = p_a and f.friend_id = p_b
  )
$$;

create function private.is_blocked_between(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b)
       or (b.blocker_id = p_b and b.blocked_id = p_a)
  )
$$;

-- Core private / friends / public rule for owned content.
create function private.can_view(p_owner uuid, p_visibility text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when (select auth.uid()) is null or p_owner is null then false
    when p_owner = (select auth.uid()) then true
    when private.is_blocked_between(p_owner, (select auth.uid())) then false
    when p_visibility = 'public' then true
    when p_visibility = 'friends' then private.is_friend(p_owner, (select auth.uid()))
    else false
  end
$$;

-- Bio, stats, achievements: governed by the owner's profile_visibility.
create function private.profile_details_visible(p_profile uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when (select auth.uid()) is null then false
    when p_profile = (select auth.uid()) then true
    when private.is_blocked_between(p_profile, (select auth.uid())) then false
    else coalesce((
      select case s.profile_visibility
               when 'public'  then true
               when 'friends' then private.is_friend(p_profile, (select auth.uid()))
               else false
             end
      from public.user_settings s
      where s.user_id = p_profile
    ), false)
  end
$$;

-- Caller's ACTIVE role in a group ('owner' | 'admin' | 'member') or NULL.
create function private.group_role(p_group uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select m.role from public.group_members m
  where m.group_id = p_group and m.user_id = (select auth.uid()) and m.status = 'active'
$$;

-- Caller's membership status in a group ('active' | 'pending' | 'invited') or NULL.
create function private.group_member_status(p_group uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select m.status from public.group_members m
  where m.group_id = p_group and m.user_id = (select auth.uid())
$$;

create function private.can_view_group(p_group uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.groups g
    where g.id = p_group
      and (g.is_public or g.owner_id = (select auth.uid()) or private.group_member_status(g.id) is not null)
  )
$$;

create function private.is_convoy_member(p_convoy uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.convoy_participants p
    where p.convoy_id = p_convoy and p.user_id = (select auth.uid())
  )
$$;

create function private.can_view_convoy(p_convoy uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.convoys c
    where c.id = p_convoy
      and (
        c.owner_id = (select auth.uid())
        or private.is_convoy_member(c.id)
        or (
          not private.is_blocked_between(c.owner_id, (select auth.uid()))
          and (
            c.visibility = 'public'
            or (c.visibility = 'friends' and private.is_friend(c.owner_id, (select auth.uid())))
            or (c.group_id is not null and private.group_role(c.group_id) is not null)
          )
        )
      )
  )
$$;

create function private.can_view_event(p_event uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.events e
    where e.id = p_event
      and (
        e.organiser_id = (select auth.uid())
        or exists (select 1 from public.event_rsvps r where r.event_id = e.id and r.user_id = (select auth.uid()))
        or (
          not private.is_blocked_between(e.organiser_id, (select auth.uid()))
          and (
            e.visibility = 'public'
            or (e.group_id is not null and private.group_role(e.group_id) is not null)
          )
        )
      )
  )
$$;

create function private.can_view_vehicle(p_vehicle uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.vehicles v
    where v.id = p_vehicle and private.can_view(v.owner_id, v.visibility)
  )
$$;

create function private.can_view_journey(p_journey uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.journeys j
    where j.id = p_journey
      and (j.owner_id = (select auth.uid())
           or (j.status = 'completed' and private.can_view(j.owner_id, j.visibility)))
  )
$$;

create function private.can_view_location(p_location uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.saved_locations s
    where s.id = p_location
      and (s.owner_id = (select auth.uid())
           or (s.status = 'active' and private.can_view(s.owner_id, s.visibility)))
  )
$$;

-- Cross-table lookups used inside policies. Policies run as the querying
-- role, so a plain subquery would be filtered by the other table's RLS (or
-- denied outright); these read the facts they need as the definer.

create function private.owns_journey(p_journey uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.journeys j where j.id = p_journey and j.owner_id = (select auth.uid())
  )
$$;

create function private.owns_location(p_location uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.saved_locations s where s.id = p_location and s.owner_id = (select auth.uid())
  )
$$;

create function private.accepts_friend_requests(p_user uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_settings s
    where s.user_id = p_user and s.allow_friend_requests = 'everyone'
  )
$$;

create function private.is_event_organiser(p_event uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.events e where e.id = p_event and e.organiser_id = (select auth.uid())
  )
$$;

-- Storage: may the caller read this object in a private photo bucket?
create function private.can_read_photo_object(p_bucket text, p_name text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.photos p
    where p.bucket = p_bucket
      and (p.storage_path = p_name or p.thumb_path = p_name)
      and (
        p.owner_id = (select auth.uid())
        or (
          p.status = 'ready'
          and case
                when p.vehicle_id  is not null then private.can_view_vehicle(p.vehicle_id)
                when p.journey_id  is not null then private.can_view_journey(p.journey_id)
                when p.location_id is not null then private.can_view_location(p.location_id)
                else false
              end
        )
      )
  )
$$;

-- Storage: does the caller own the vehicle document stored at this path?
create function private.owns_document_object(p_name text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.vehicle_documents d
    where d.storage_path = p_name and d.owner_id = (select auth.uid())
  )
$$;

-- Policies run as the querying role, which therefore needs EXECUTE.
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.is_friend(uuid, uuid),
  private.is_blocked_between(uuid, uuid),
  private.can_view(uuid, text),
  private.profile_details_visible(uuid),
  private.group_role(uuid),
  private.group_member_status(uuid),
  private.can_view_group(uuid),
  private.is_convoy_member(uuid),
  private.can_view_convoy(uuid),
  private.can_view_event(uuid),
  private.can_view_vehicle(uuid),
  private.can_view_journey(uuid),
  private.can_view_location(uuid),
  private.owns_journey(uuid),
  private.owns_location(uuid),
  private.accepts_friend_requests(uuid),
  private.is_event_organiser(uuid),
  private.can_read_photo_object(text, text),
  private.owns_document_object(text),
  private.try_uuid(text),
  -- Evaluated for the generated profiles.level column on any direct update.
  private.level_for_xp(integer)
to authenticated;
