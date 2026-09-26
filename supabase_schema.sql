-- Execute this complete script in Supabase SQL Editor.
-- The service_role key must stay on the Python inference server.

create extension if not exists pgcrypto;

create table if not exists public.devices (
  id text primary key,
  name text not null,
  location text,
  capacity_kwc numeric(10, 2),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint devices_capacity_non_negative check (capacity_kwc is null or capacity_kwc >= 0)
);

create table if not exists public.sensor_readings (
  id uuid primary key default gen_random_uuid(),
  device_id text not null references public.devices(id) on update cascade on delete restrict,
  intensite double precision not null,
  tension double precision not null,
  temperature double precision not null,
  luminosite double precision not null,
  created_at timestamptz not null default now(),
  constraint sensor_intensite_non_negative check (intensite >= 0),
  constraint sensor_tension_non_negative check (tension >= 0),
  constraint sensor_luminosite_range check (luminosite >= 0 and luminosite <= 100)
);

create table if not exists public.predictions (
  id uuid primary key default gen_random_uuid(),
  reading_id uuid references public.sensor_readings(id) on delete set null,
  device_id text not null references public.devices(id) on update cascade on delete restrict,
  valeur_predite double precision not null,
  horizon text not null,
  created_at timestamptz not null default now(),
  constraint predictions_horizon_not_empty check (length(trim(horizon)) > 0)
);

create table if not exists public.panel_diagnostics (
  id uuid primary key default gen_random_uuid(),
  device_id text not null references public.devices(id) on update cascade on delete restrict,
  status text not null check (status in ('healthy', 'defective', 'warning')),
  score numeric(5, 4) not null check (score >= 0 and score <= 1),
  reason text,
  features jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists sensor_readings_device_created_idx
  on public.sensor_readings (device_id, created_at desc);

create index if not exists predictions_device_created_idx
  on public.predictions (device_id, created_at desc);

create index if not exists predictions_reading_idx
  on public.predictions (reading_id);

create index if not exists panel_diagnostics_device_created_idx
  on public.panel_diagnostics (device_id, created_at desc);

alter table public.devices enable row level security;
alter table public.sensor_readings enable row level security;
alter table public.predictions enable row level security;
alter table public.panel_diagnostics enable row level security;

drop policy if exists "Public can read devices" on public.devices;
create policy "Public can read devices"
  on public.devices for select
  using (true);

drop policy if exists "Public can read sensor readings" on public.sensor_readings;
create policy "Public can read sensor readings"
  on public.sensor_readings for select
  using (true);

drop policy if exists "Public can insert sensor readings" on public.sensor_readings;
create policy "Public can insert sensor readings"
  on public.sensor_readings for insert
  with check (true);

drop policy if exists "Public can read predictions" on public.predictions;
create policy "Public can read predictions"
  on public.predictions for select
  using (true);

drop policy if exists "Public can read panel diagnostics" on public.panel_diagnostics;
create policy "Public can read panel diagnostics"
  on public.panel_diagnostics for select
  using (true);

-- Seed devices used by the dashboard. Safe to run more than once.
insert into public.devices (id, name, location, capacity_kwc)
values
  ('ESP32-ARRAY-01', 'Toiture sud', 'Paris · FR', 4.80),
  ('ESP32-ARRAY-02', 'Façade est', 'Paris · FR', 2.40),
  ('ESP32-ARRAY-03', 'Ombrière parking', 'Paris · FR', 8.00)
on conflict (id) do update set
  name = excluded.name,
  location = excluded.location,
  capacity_kwc = excluded.capacity_kwc,
  updated_at = now();
