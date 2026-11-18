-- Agenda da clínica: persistência operacional e métricas agregadas.
-- Horários são locais de America/Bahia; instantes são armazenados como timestamptz.
-- Não há sala nem frontend: a equipe confirma pelo WhatsApp Business.

create table if not exists appointment_services (
  service_code text primary key,
  name text not null unique,
  duration_minutes smallint not null check (duration_minutes > 0),
  capacity_per_slot smallint not null check (capacity_per_slot > 0),
  capacity_scope text not null check (capacity_scope in ('service_slot', 'professional'))
);

create table if not exists appointment_professionals (
  professional_code text primary key,
  display_name text not null unique
);

create table if not exists appointment_service_professionals (
  service_code text not null references appointment_services(service_code) on delete restrict,
  professional_code text not null references appointment_professionals(professional_code) on delete restrict,
  primary key (service_code, professional_code)
);

create table if not exists appointment_schedule_windows (
  service_code text not null references appointment_services(service_code) on delete restrict,
  weekday smallint not null check (weekday between 1 and 5),
  starts_at time not null,
  ends_at time not null,
  check (ends_at > starts_at),
  primary key (service_code, weekday, starts_at),
  unique (service_code, weekday, ends_at)
);

insert into appointment_services (service_code, name, duration_minutes, capacity_per_slot, capacity_scope)
values
  ('fisioterapia', 'Fisioterapia', 30, 6, 'service_slot'),
  ('rpg', 'RPG', 30, 1, 'professional'),
  ('pilates', 'Pilates', 60, 1, 'professional'),
  ('uro', 'URO', 30, 1, 'professional')
on conflict (service_code) do update set
  name = excluded.name,
  duration_minutes = excluded.duration_minutes,
  capacity_per_slot = excluded.capacity_per_slot,
  capacity_scope = excluded.capacity_scope;

insert into appointment_professionals (professional_code, display_name)
values
  ('moises', 'Moisés'),
  ('antonio', 'Antônio'),
  ('luarca', 'Luarca'),
  ('camila', 'Camila')
on conflict (professional_code) do update set display_name = excluded.display_name;

insert into appointment_service_professionals (service_code, professional_code)
values
  ('fisioterapia', 'moises'),
  ('fisioterapia', 'antonio'),
  ('rpg', 'luarca'),
  ('pilates', 'luarca'),
  ('uro', 'camila')
on conflict do nothing;

insert into appointment_schedule_windows (service_code, weekday, starts_at, ends_at)
select schedule.service_code, weekday, schedule.starts_at::time, schedule.ends_at::time
from (values
  ('fisioterapia', '07:30', '12:00'), ('fisioterapia', '14:00', '18:30'),
  ('rpg', '07:30', '12:00'), ('rpg', '14:00', '18:30'),
  ('pilates', '07:00', '12:00'), ('pilates', '14:00', '17:00'),
  ('uro', '07:30', '12:00'), ('uro', '14:00', '18:30')
) as schedule(service_code, starts_at, ends_at)
cross join generate_series(1, 5) as weekday
on conflict do nothing;

create table if not exists appointment_requests (
  id uuid primary key default gen_random_uuid(),
  contact_wa_id text not null references contacts(wa_id) on delete restrict,
  source_message_id uuid not null unique references messages(id) on delete restrict,
  service_code text not null references appointment_services(service_code) on delete restrict,
  preferred_professional_code text not null,
  preferred_starts_at timestamptz not null,
  preferred_ends_at timestamptz not null,
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'cancelled')),
  created_at timestamptz not null default now(),
  check (preferred_ends_at > preferred_starts_at),
  foreign key (service_code, preferred_professional_code)
    references appointment_service_professionals(service_code, professional_code)
    on delete restrict
);

create index if not exists appointment_requests_contact_status_created_at_idx
  on appointment_requests (contact_wa_id, status, created_at);
create index if not exists appointment_requests_status_slot_idx
  on appointment_requests (status, preferred_starts_at, service_code);

create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  appointment_request_id uuid not null unique references appointment_requests(id) on delete restrict,
  contact_wa_id text not null references contacts(wa_id) on delete restrict,
  service_code text not null references appointment_services(service_code) on delete restrict,
  professional_code text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  attendance_status text check (attendance_status = 'attended'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  foreign key (service_code, professional_code)
    references appointment_service_professionals(service_code, professional_code)
    on delete restrict,
  check (status = 'confirmed' or attendance_status is null)
);

create index if not exists appointments_contact_status_starts_at_idx
  on appointments (contact_wa_id, status, starts_at);
create index if not exists appointments_service_starts_at_idx
  on appointments (service_code, starts_at) where status = 'confirmed';
create index if not exists appointments_professional_starts_at_idx
  on appointments (professional_code, starts_at, ends_at) where status = 'confirmed';

-- Serialize booking writes by local clinic date, then enforce the supplied
-- schedule and capacity inside the same transaction as the appointment write.
-- Physiotherapy is pooled to six people per half-hour; other services reserve
-- one professional across all of that professional's services.
create or replace function enforce_appointment_schedule_and_capacity() returns trigger language plpgsql as $$
declare
  v_service appointment_services%rowtype;
  v_local_start timestamp;
  v_local_end timestamp;
  v_window appointment_schedule_windows%rowtype;
  v_booked integer;
begin
  if new.status <> 'confirmed' then
    return new;
  end if;

  select * into v_service from appointment_services where service_code = new.service_code;
  if not found then
    raise exception 'Unknown appointment service.' using errcode = '23514';
  end if;

  v_local_start := new.starts_at at time zone 'America/Bahia';
  v_local_end := new.ends_at at time zone 'America/Bahia';
  if new.ends_at - new.starts_at <> make_interval(mins => v_service.duration_minutes) then
    raise exception 'Appointment duration does not match the service.' using errcode = '23514';
  end if;
  if extract(isodow from v_local_start) not between 1 and 5 then
    raise exception 'Appointments are available Monday through Friday only.' using errcode = '23514';
  end if;

  select * into v_window
  from appointment_schedule_windows
  where service_code = new.service_code
    and weekday = extract(isodow from v_local_start)::smallint
    and v_local_start::time >= starts_at
    and v_local_end::time <= ends_at
    and mod(extract(epoch from (v_local_start::time - starts_at))::integer, v_service.duration_minutes * 60) = 0
  limit 1;
  if not found then
    raise exception 'Appointment is outside the configured clinic schedule.' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_local_start::date::text, 0));
  if v_service.capacity_scope = 'service_slot' then
    select count(*) into v_booked from appointments
    where status = 'confirmed' and service_code = new.service_code and starts_at = new.starts_at
      and id <> new.id;
  else
    select count(*) into v_booked from appointments
    where status = 'confirmed' and professional_code = new.professional_code
      and tstzrange(starts_at, ends_at, '[)') && tstzrange(new.starts_at, new.ends_at, '[)')
      and id <> new.id;
  end if;
  if v_booked >= v_service.capacity_per_slot then
    raise exception 'Appointment slot capacity is exhausted.' using errcode = '23P01';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists appointments_schedule_capacity on appointments;
create trigger appointments_schedule_capacity before insert or update of
  service_code, professional_code, starts_at, ends_at, status on appointments
for each row execute function enforce_appointment_schedule_and_capacity();

create table if not exists appointment_events (
  id uuid primary key default gen_random_uuid(),
  appointment_request_id uuid not null references appointment_requests(id) on delete restrict,
  appointment_id uuid references appointments(id) on delete restrict,
  source_message_id uuid references messages(id) on delete restrict,
  event_type text not null check (event_type in ('requested', 'confirmed', 'cancelled', 'rescheduled', 'attendance_recorded')),
  actor_kind text not null check (actor_kind in ('patient_structured_whatsapp', 'clinic_whatsapp_business_account')),
  previous_starts_at timestamptz,
  previous_ends_at timestamptz,
  resulting_starts_at timestamptz,
  resulting_ends_at timestamptz,
  attendance_status text check (attendance_status = 'attended'),
  occurred_at timestamptz not null default now(),
  check (
    (event_type = 'requested' and appointment_id is null and actor_kind = 'patient_structured_whatsapp') or
    (event_type <> 'requested' and appointment_id is not null and actor_kind = 'clinic_whatsapp_business_account')
  ),
  check ((
    (event_type in ('requested', 'confirmed') and previous_starts_at is null
      and previous_ends_at is null and resulting_ends_at > resulting_starts_at) or
    (event_type = 'rescheduled' and previous_ends_at > previous_starts_at
      and resulting_ends_at > resulting_starts_at) or
    (event_type = 'cancelled' and previous_ends_at > previous_starts_at
      and resulting_starts_at is null and resulting_ends_at is null) or
    (event_type = 'attendance_recorded' and previous_ends_at > previous_starts_at
      and resulting_starts_at = previous_starts_at and resulting_ends_at = previous_ends_at)
  ) is true),
  check ((event_type = 'attendance_recorded') = (attendance_status is not null))
);

create unique index if not exists appointment_events_source_message_id_idx
  on appointment_events (source_message_id) where source_message_id is not null;
create index if not exists appointment_events_request_occurred_at_idx
  on appointment_events (appointment_request_id, occurred_at);

create or replace function prevent_appointment_event_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'appointment_events are append-only';
end;
$$;
drop trigger if exists appointment_events_immutable on appointment_events;
create trigger appointment_events_immutable before update or delete on appointment_events
for each row execute function prevent_appointment_event_mutation();

-- Operational reporting views expose aggregates and coded service/provider
-- dimensions only. They never return patient or message identifiers.
create or replace view reporting.daily_appointment_event_metrics as
select
  (event.occurred_at at time zone 'America/Bahia')::date as activity_date,
  event.event_type,
  request.service_code,
  service.name as service_name,
  coalesce(appointment.professional_code, request.preferred_professional_code) as professional_code,
  professional.display_name as professional_name,
  count(*) as event_count
from appointment_events event
join appointment_requests request on request.id = event.appointment_request_id
join appointment_services service on service.service_code = request.service_code
left join appointments appointment on appointment.id = event.appointment_id
left join appointment_professionals professional
  on professional.professional_code = coalesce(appointment.professional_code, request.preferred_professional_code)
group by
  (event.occurred_at at time zone 'America/Bahia')::date,
  event.event_type, request.service_code, service.name,
  coalesce(appointment.professional_code, request.preferred_professional_code), professional.display_name;

create or replace view reporting.appointment_request_status_metrics as
select
  (request.created_at at time zone 'America/Bahia')::date as request_date,
  request.status,
  request.service_code,
  service.name as service_name,
  request.preferred_professional_code as professional_code,
  professional.display_name as professional_name,
  count(*) as request_count
from appointment_requests request
join appointment_services service on service.service_code = request.service_code
left join appointment_professionals professional on professional.professional_code = request.preferred_professional_code
group by
  (request.created_at at time zone 'America/Bahia')::date,
  request.status, request.service_code, service.name,
  request.preferred_professional_code, professional.display_name;

create or replace view reporting.scheduled_appointment_metrics as
select
  (appointment.starts_at at time zone 'America/Bahia')::date as scheduled_date,
  (appointment.starts_at at time zone 'America/Bahia')::time as scheduled_time,
  (appointment.ends_at at time zone 'America/Bahia')::time as scheduled_end_time,
  appointment.status,
  appointment.attendance_status,
  appointment.service_code,
  service.name as service_name,
  appointment.professional_code,
  professional.display_name as professional_name,
  count(*) as appointment_count
from appointments appointment
join appointment_services service on service.service_code = appointment.service_code
join appointment_professionals professional on professional.professional_code = appointment.professional_code
group by
  (appointment.starts_at at time zone 'America/Bahia')::date,
  (appointment.starts_at at time zone 'America/Bahia')::time,
  (appointment.ends_at at time zone 'America/Bahia')::time,
  appointment.status, appointment.attendance_status,
  appointment.service_code, service.name,
  appointment.professional_code, professional.display_name;

-- Future and recent slot grid for occupancy/availability measures. The
-- physiotherapy row is pooled across both therapists, matching capacity=6.
create or replace view reporting.appointment_slot_capacity_metrics as
with calendar as (
  select day::date as slot_date
  from generate_series(
    (now() at time zone 'America/Bahia')::date - 90,
    (now() at time zone 'America/Bahia')::date + 180,
    interval '1 day'
  ) day
), slots as (
  select
    calendar.slot_date,
    schedule_window.service_code,
    service.name as service_name,
    case when service.capacity_scope = 'professional' then mapping.professional_code else null end as professional_code,
    case when service.capacity_scope = 'professional' then professional.display_name else null end as professional_name,
    (calendar.slot_date + schedule_window.starts_at
      + generated.slot_index * make_interval(mins => service.duration_minutes))::time as slot_time,
    service.duration_minutes,
    service.capacity_per_slot
  from calendar
  join appointment_schedule_windows schedule_window on schedule_window.weekday = extract(isodow from calendar.slot_date)::smallint
  join appointment_services service on service.service_code = schedule_window.service_code
  cross join lateral (
    select mapping.professional_code
    from appointment_service_professionals mapping
    where mapping.service_code = service.service_code
      and service.capacity_scope = 'professional'
    union all
    select null::text as professional_code
    where service.capacity_scope = 'service_slot'
  ) mapping
  left join appointment_professionals professional on professional.professional_code = mapping.professional_code
  cross join lateral generate_series(
    0,
    ((extract(epoch from (schedule_window.ends_at - schedule_window.starts_at))::integer / 60
      - service.duration_minutes) / service.duration_minutes)::integer
  ) generated(slot_index)
), slots_with_utc as (
  select *, ((slot_date + slot_time) at time zone 'America/Bahia') as starts_at_utc
  from slots
)
select
  slot.slot_date,
  slot.slot_time,
  slot.service_code,
  slot.service_name,
  slot.professional_code,
  slot.professional_name,
  slot.duration_minutes,
  slot.capacity_per_slot,
  count(appointment.id) as confirmed_count,
  greatest(slot.capacity_per_slot - count(appointment.id), 0) as remaining_capacity
from slots_with_utc slot
left join appointments appointment
  on appointment.status = 'confirmed'
  and (
    (slot.professional_code is null
      and appointment.service_code = slot.service_code
      and appointment.starts_at = slot.starts_at_utc)
    or
    (slot.professional_code is not null
      and appointment.professional_code = slot.professional_code
      and tstzrange(appointment.starts_at, appointment.ends_at, '[)')
        && tstzrange(slot.starts_at_utc,
          slot.starts_at_utc + make_interval(mins => slot.duration_minutes), '[)'))
  )
group by
  slot.slot_date, slot.slot_time, slot.service_code, slot.service_name,
  slot.professional_code, slot.professional_name, slot.duration_minutes, slot.capacity_per_slot;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'powerbi_reader') then
    execute 'grant usage on schema reporting to powerbi_reader';
    execute 'grant select on reporting.daily_appointment_event_metrics to powerbi_reader';
    execute 'grant select on reporting.appointment_request_status_metrics to powerbi_reader';
    execute 'grant select on reporting.scheduled_appointment_metrics to powerbi_reader';
    execute 'grant select on reporting.appointment_slot_capacity_metrics to powerbi_reader';
  end if;
end
$$;
