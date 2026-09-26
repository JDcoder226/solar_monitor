-- =============================================================================
-- HelioPulse — migration v2
-- Integration du modele LightGBM 16 classes + page Parametres + couture de
-- l'inference a 13 features.
--
-- A executer dans Supabase > SQL Editor. Le script est IDEMPOTENT :
-- tu peux le relancer autant de fois que necessaire sans erreur ni doublon.
--
-- Prerequis : supabase_schema.sql a deja ete execute (tables devices,
-- sensor_readings, predictions, panel_diagnostics).
--
-- POSTURE DE SECURITE : ce script laisse la lecture ET l'ecriture publiques
-- (cle anon), conformement au choix "pas d'auth pour le moment, c'est pour des
-- tests". Les policies sont en `using (true)`. N'importe qui possedant l'URL
-- peut donc modifier la configuration et fabriquer des mesures.
-- Le bloc de durcissement est fourni ENTIEREMENT COMMENTE en fin de fichier
-- (section 9) pour le jour ou tu voudras fermer l'acces.
-- =============================================================================


-- =============================================================================
-- 1. CONTEXTE : POURQUOI CETTE MIGRATION
-- =============================================================================
--
-- Le modele fourni (models/lgbm_pv_fault_model.pkl) attend 13 features :
--     Ipv Vpv Vdc ia ib ic va vb vc Iabc If Vabc Vf
-- et predit 16 classes : 0L 0M 1L 1M 2L 2M 3L 3M 4L 4M 5L 5M 6L 6M 7L 7M
--
-- Le capteur n'envoie que 4 mesures : intensite, tension, temperature,
-- luminosite. Sur ces 4, seules 2 alimentent le modele :
--     Ipv <- intensite      Vpv <- tension
-- temperature et luminosite ne sont PAS des features du modele (elles restent
-- utiles a l'affichage).
--
-- Il manque donc 11 valeurs sur 13. Ce script cree les tables qui permettent de
-- les renseigner depuis la page Parametres, et de tracer leur provenance.
--
-- ATTENTION — les 2 features reellement mesurees sont HORS de la plage
-- d'entrainement du modele :
--     intensite 0-11,5 A   contre  Ipv [-0,58 ; 8,73]
--     tension   360-420 V  contre  Vpv [-10,53 ; 111,08]    (~4x au-dessus)
-- D'ou les colonnes de calibration (site_base_kind, scale, offset) : elles
-- deplacent le point de fonctionnement du site dans la plage du modele.
-- Cela rend le calcul reproductible et borne, mais NE REND PAS le modele
-- valide sur ce systeme. C'est un fait a afficher, pas a masquer — d'ou les
-- colonnes data_completeness / is_degraded / ood_features ci-dessous.
-- =============================================================================


-- =============================================================================
-- 2. ETENDRE panel_diagnostics
-- =============================================================================

alter table public.panel_diagnostics
  add column if not exists reading_id          uuid references public.sensor_readings(id) on delete set null,
  add column if not exists fault_code          text,
  add column if not exists fault_index         smallint,
  add column if not exists fault_variant       text,
  add column if not exists fault_label         text,
  add column if not exists severity            text,
  add column if not exists recommended_action  text,
  add column if not exists runner_up_code      text,
  add column if not exists runner_up_score     numeric(5, 4),
  add column if not exists model_version       text,
  add column if not exists data_completeness   numeric(4, 3),
  add column if not exists is_degraded         boolean not null default false,
  add column if not exists degradation_reasons text[] not null default '{}',
  add column if not exists ood_features        text[] not null default '{}',
  add column if not exists config_hash         text;

-- Contraintes. `alter table add constraint` n'est pas idempotent : on passe par
-- des blocs DO qui avalent l'erreur "already exists".
do $$
begin
  alter table public.panel_diagnostics
    add constraint panel_diag_fault_code_fmt check (fault_code is null or fault_code ~ '^[0-7][LM]$');
exception when duplicate_object then null; end $$;

do $$
begin
  alter table public.panel_diagnostics
    add constraint panel_diag_fault_index_rng check (fault_index is null or fault_index between 0 and 7);
exception when duplicate_object then null; end $$;

do $$
begin
  alter table public.panel_diagnostics
    add constraint panel_diag_variant_enum check (fault_variant is null or fault_variant in ('L', 'M'));
exception when duplicate_object then null; end $$;

do $$
begin
  alter table public.panel_diagnostics
    add constraint panel_diag_severity_enum check (severity is null or severity in ('none', 'low', 'medium', 'high'));
exception when duplicate_object then null; end $$;

do $$
begin
  alter table public.panel_diagnostics
    add constraint panel_diag_completeness_rng check (data_completeness is null or data_completeness between 0 and 1);
exception when duplicate_object then null; end $$;

-- Les deux contraintes suivantes sont VOLONTAIRES. Elles rendent impossible
-- d'ecrire status='healthy' avec fault_index=3 (ou l'inverse). Un bug de
-- mapping cote service devient donc une erreur d'insertion immediate, au lieu
-- d'un diagnostic faux affiche silencieusement.
do $$
begin
  alter table public.panel_diagnostics
    add constraint panel_diag_healthy_consistency
    check (status <> 'healthy' or fault_index is null or fault_index = 0);
exception when duplicate_object then null; end $$;

do $$
begin
  alter table public.panel_diagnostics
    add constraint panel_diag_fault_consistency
    check (status <> 'defective' or (fault_index is not null and fault_index > 0));
exception when duplicate_object then null; end $$;

-- `fault_code`, `fault_index` et `fault_variant` disent la meme chose sous trois
-- formes : '3M' doit s'accorder avec 3 et avec 'M'. Les trois colonnes sont
-- affichees separement par le dashboard ; si elles divergent, il affiche un
-- diagnostic qui se contredit lui-meme (« F3 » a cote de « variante L ») sans
-- qu'aucune erreur ne soit levee. Meme regle que `fault_catalog_code_matches`
-- cote catalogue : on la duplique ici parce que panel_diagnostics ne reference
-- pas fault_catalog (un code predit peut ne pas y figurer).
-- Ajoutee `not valid` puis validee separement, contrairement aux autres.
-- Raison : sur une base ou le service a deja tourne, une seule ligne incoherente
-- (bug de mapping deja en production) ferait echouer l'ALTER TABLE et
-- interromprait TOUT le script au milieu, laissant la migration a moitie faite.
-- `not valid` s'applique toujours ; il dispense seulement de revalider
-- l'historique. Les insertions NOUVELLES sont filtrees des cet instant.
do $$
begin
  alter table public.panel_diagnostics
    add constraint panel_diag_code_consistency
    check (
      fault_code is null
      or (
        -- `fault_index is not null` explicite : sans lui, un fault_index NULL
        -- rendrait la comparaison NULLE, donc la contrainte PASSERAIT (un CHECK
        -- ne refuse que sur FALSE). Le code resterait alors sans son index.
        fault_index is not null
        and fault_index = substring(fault_code, 1, 1)::smallint
        and (fault_variant is null or fault_variant = substring(fault_code, 2, 1))
      )
    ) not valid;
exception when duplicate_object then null; end $$;

-- Validation de l'historique. Si elle echoue, on le DIT au lieu de l'avaler :
-- la contrainte reste active pour les nouvelles lignes, mais les anciennes ne
-- sont pas conformes et il faut les corriger a la main.
do $$
declare
  v_nb integer;
begin
  begin
    alter table public.panel_diagnostics validate constraint panel_diag_code_consistency;
  exception when check_violation then
    select count(*) into v_nb
    from public.panel_diagnostics
    where fault_code is not null
      and (fault_index is null
           or fault_index <> substring(fault_code, 1, 1)::smallint
           or (fault_variant is not null and fault_variant <> substring(fault_code, 2, 1)));
    raise warning
      'panel_diag_code_consistency : % ligne(s) de panel_diagnostics ont un fault_code incoherent avec fault_index/fault_variant. La contrainte bloque les NOUVELLES lignes, mais pas celles-ci. Corrige-les avec : select id, fault_code, fault_index, fault_variant from public.panel_diagnostics where fault_code is not null and (fault_index is null or fault_index <> substring(fault_code,1,1)::smallint or (fault_variant is not null and fault_variant <> substring(fault_code,2,1)));',
      v_nb;
  end;
end $$;

create index if not exists panel_diagnostics_created_idx
  on public.panel_diagnostics (created_at desc);


-- =============================================================================
-- 3. model_features — referentiel des 13 features du modele
-- =============================================================================
--
-- C'est la table qui rend la liste des donnees manquantes VISIBLE et EDITABLE.
-- train_min / train_max sont des constantes du modele (extraites de son
-- en-tete interne), pas des reglages : ne les modifie pas.
--
-- CONVENTION DE CALIBRATION — a lire avant de toucher scale/offset :
--
--   * mode = 'measured' ou 'derived' : la valeur produite est dans les unites
--     du SITE. On la ramene dans les unites du MODELE par :
--         valeur_modele = valeur_site * scale + offset
--     avec par defaut  scale = (train_max - train_min) / 2 / site_base
--     et offset = 0. `site_base_kind` designe la grandeur nominale du site
--     utilisee comme denominateur (voir section 5).
--
--   * mode = 'constant' : constant_value est exprimee DIRECTEMENT dans les
--     unites du MODELE, et scale/offset ne sont PAS appliques. C'est
--     volontaire : une constante n'a pas de contrepartie mesuree sur le site,
--     donc la convertir n'aurait aucun sens. Exemple : Vf = 50,0 (Hz) tombe
--     naturellement dans la plage du modele [49,44 ; 50,46].
--
-- Le service recalcule `scale` a l'execution a partir de `site_base_kind` et
-- des valeurs nominales du device. Les `default_scale` ci-dessous ne sont que
-- le resultat de ce calcul avec les nominales par defaut (400 V, 10 A,
-- rendement 0,97, cos phi 1,0) — ils servent de repli et de documentation
-- lisible, et ne sont utilises QUE si les nominales du site sont absentes.
--
-- Attention : pour `ac_current_peak`, la base du site depend du RENDEMENT
-- (i_crete = v_ll x i_dc x rendement x racine(2) / (racine(3) x v_ll x cos phi)).
-- Changer `efficiency` dans device_settings deplace donc le scale de ia, ib,
-- ic et Iabc. Les valeurs ci-dessous sont calculees avec 0,97, la valeur par
-- defaut du service.

create table if not exists public.model_features (
  feature_name            text primary key,
  position                smallint not null unique check (position between 0 and 12),
  train_min               double precision not null,
  train_max               double precision not null,
  unit                    text,
  description_fr          text,
  site_base_kind          text check (site_base_kind in (
                            'dc_voltage', 'dc_current',
                            'ac_voltage_peak', 'ac_current_peak',
                            'excitation_current', 'frequency', 'none')),
  default_mode            text not null check (default_mode in ('measured', 'constant', 'derived')),
  default_source_key      text,
  default_formula         text,
  default_constant_value  double precision,
  default_scale           double precision not null default 1,
  default_offset          double precision not null default 0,
  depends_on              text[] not null default '{}',
  updated_at              timestamptz not null default now(),
  constraint model_features_range_order check (train_min <= train_max),
  constraint model_features_mode_coherence check (
    (default_mode = 'measured' and default_source_key is not null) or
    (default_mode = 'constant' and default_constant_value is not null) or
    (default_mode = 'derived'  and default_formula is not null))
);

-- Seed des 13 features. `on conflict do update` sur les seules colonnes issues
-- du modele (bornes, position, unite) : relancer le script rafraichit les
-- constantes du modele sans ecraser tes reglages (mode, formule, constantes).
insert into public.model_features (
  feature_name, position, train_min, train_max, unit, description_fr,
  site_base_kind, default_mode, default_source_key, default_formula,
  default_constant_value, default_scale, default_offset, depends_on)
values
  ('Ipv', 0, -0.58465576171875, 8.72821044921875, 'A', 'Courant DC du champ PV', 'dc_current',
   'measured', 'intensite', null, null, 0.465643, 0, '{}'),

  ('Vpv', 1, -10.528564453125, 111.077880859375, 'V', 'Tension DC du champ PV', 'dc_voltage',
   'measured', 'tension', null, null, 0.152008, 0, '{}'),

  ('Vdc', 2, 0.5859375, 250.78125, 'V', 'Tension du bus DC (non mesuree sur ce site)', 'dc_voltage',
   'constant', null, null, 250.0, 1, 0, '{}'),

  ('ia', 3, -6.3454599609375, 13.7692861328125, 'A', 'Courant instantane phase A', 'ac_current_peak',
   'derived', null, 'ac_phase_peak_from_dc_power', null, 1.269868, 0, '{Ipv,Vpv}'),

  ('ib', 4, -7.264404296875, 6.619873046875, 'A', 'Courant instantane phase B', 'ac_current_peak',
   'derived', null, 'ac_phase_peak_from_dc_power', null, 0.876531, 0, '{Ipv,Vpv}'),

  ('ic', 5, -12.8494921875, 6.35216796875, 'A', 'Courant instantane phase C', 'ac_current_peak',
   'derived', null, 'ac_phase_peak_from_dc_power', null, 1.212223, 0, '{Ipv,Vpv}'),

  ('va', 6, -160.637512207031, 160.697784423828, 'V', 'Tension instantanee phase A', 'ac_voltage_peak',
   'derived', null, 'phase_voltage_peak', null, 0.491936, 0, '{}'),

  ('vb', 7, -161.963500976562, 160.577239990234, 'V', 'Tension instantanee phase B', 'ac_voltage_peak',
   'derived', null, 'phase_voltage_peak', null, 0.493787, 0, '{}'),

  ('vc', 8, -160.034790039062, 159.528503418009, 'V', 'Tension instantanee phase C', 'ac_voltage_peak',
   'derived', null, 'phase_voltage_peak', null, 0.489230, 0, '{}'),

  ('Iabc', 9, 1.03016206111374e-07, 6.76204640165311, 'A', 'Magnitude du courant triphase (toujours > 0)', 'ac_current_peak',
   'derived', null, 'mean_abs3', null, 0.426896, 0, '{ia,ib,ic}'),

  ('If', 10, -0.0221909906231321, 51.8599476218074, 'A', 'Courant d''excitation — AUCUNE contrepartie sur ce site', 'excitation_current',
   'constant', null, null, 26.0, 1, 0, '{}'),

  ('Vabc', 11, 1.0, 156.291664479182, 'V', 'Magnitude de la tension triphasee (toujours > 0)', 'ac_voltage_peak',
   'derived', null, 'mean_abs3', null, 0.237731, 0, '{va,vb,vc}'),

  ('Vf', 12, 49.4445723886848, 50.4642429692192, 'Hz', 'Frequence reseau (quasi constante)', 'frequency',
   'constant', null, null, 50.0, 1, 0, '{}')
on conflict (feature_name) do update set
  position     = excluded.position,
  train_min    = excluded.train_min,
  train_max    = excluded.train_max,
  unit         = excluded.unit,
  description_fr = excluded.description_fr,
  site_base_kind = excluded.site_base_kind,
  updated_at   = now();


-- =============================================================================
-- 4. device_feature_config — surcharge par installation
-- =============================================================================
--
-- Tous les champs sont NULLABLE : NULL signifie « herite du defaut global de
-- model_features ». C'est ce qui evite de saisir 11 valeurs x 3 installations.
-- Precedence : cette table PRIME sur model_features.

create table if not exists public.device_feature_config (
  device_id       text not null references public.devices(id) on delete cascade,
  feature_name    text not null references public.model_features(feature_name) on delete cascade,
  mode            text check (mode in ('measured', 'constant', 'derived')),
  source_key      text,
  formula         text,
  constant_value  double precision,
  scale           double precision,
  -- Nommee `scale_offset` et non `offset` : OFFSET est un mot RESERVE en
  -- PostgreSQL (clause LIMIT ... OFFSET) et ne peut pas servir de nom de
  -- colonne sans guillemets. Le nommer autrement evite d'avoir a le quoter
  -- dans chaque requete, chaque appel PostgREST et chaque lecture cote Python.
  scale_offset    double precision,
  note            text,
  updated_at      timestamptz not null default now(),
  primary key (device_id, feature_name)
);


-- =============================================================================
-- 5. device_settings — nominales du site et seuils de diagnostic
-- =============================================================================
--
-- Source de la calibration. `scale` n'est pas un nombre magique : c'est
--     (train_max - train_min) / 2 / site_base
-- soit « le site fonctionne a N x la base du modele ». L'UI affiche la
-- justification, ce qui rend la valeur auditable.
--
-- Les lignes de cette table sont OPTIONNELLES : si un device n'a pas de ligne,
-- le service applique ses valeurs par defaut internes (celles ecrites en
-- commentaire ci-dessous). Pas besoin de peupler la table pour demarrer.

create table if not exists public.device_settings (
  device_id            text primary key references public.devices(id) on delete cascade,
  nominal_voltage_v    double precision,  -- defaut service 400  : tension DC/AC nominale du site
  nominal_current_a    double precision,  -- defaut service 10   : courant DC nominal
  nominal_frequency_hz double precision,  -- defaut service 50
  efficiency           double precision,  -- defaut service 0.97 : rendement onduleur
  power_factor         double precision,  -- defaut service 1.0
  conf_min             double precision,  -- defaut service 0.55 : sous ce seuil -> warning
  stale_after_minutes  integer,           -- defaut service 30   : mesure perimee -> warning
  model_version        text,
  updated_at           timestamptz not null default now(),
  constraint device_settings_voltage_pos  check (nominal_voltage_v is null or nominal_voltage_v > 0),
  constraint device_settings_current_pos  check (nominal_current_a is null or nominal_current_a > 0),
  constraint device_settings_efficiency   check (efficiency is null or (efficiency > 0 and efficiency <= 1)),
  constraint device_settings_power_factor check (power_factor is null or (power_factor > 0 and power_factor <= 1)),
  constraint device_settings_conf_min     check (conf_min is null or (conf_min >= 0 and conf_min <= 1)),
  constraint device_settings_stale_pos    check (stale_after_minutes is null or stale_after_minutes > 0)
);


-- =============================================================================
-- 6. fault_catalog — catalogue de pannes editable (16 lignes)
-- =============================================================================
--
-- L/M n'est PAS une severite : d'apres toi, un meme defaut (ex. F7) peut avoir
-- plusieurs causes, et L/M distingue laquelle. `severity` est donc une colonne
-- SEPAREE, nullable, que tu remplis librement.
--
-- Les libelles 1L..7M sont seedes en PROVISOIRE avec le suffixe "(a documenter)".
-- Le service d'inference detecte ce suffixe et force alors le statut en
-- `warning` au lieu de publier un diagnostic a libelle bidon. Tu ne peux donc
-- pas oublier de remplir le catalogue : tant qu'il est vide, le dashboard dit
-- explicitement que le diagnostic n'est pas exploitable.

create table if not exists public.fault_catalog (
  fault_code     text primary key check (fault_code ~ '^[0-7][LM]$'),
  fault_index    smallint not null check (fault_index between 0 and 7),
  variant        text not null check (variant in ('L', 'M')),
  is_healthy     boolean not null,
  label_fr       text not null check (length(trim(label_fr)) > 0),
  severity       text check (severity is null or severity in ('none', 'low', 'medium', 'high')),
  description_fr text,
  action_fr      text,
  display_order  smallint not null,
  updated_at     timestamptz not null default now(),
  -- Empeche un catalogue incoherent du type fault_code='3M' avec fault_index=5.
  constraint fault_catalog_code_matches check (
    fault_index = substring(fault_code from 1 for 1)::smallint
    and variant = substring(fault_code from 2 for 1)),
  constraint fault_catalog_healthy_index check (is_healthy = (fault_index = 0))
);

insert into public.fault_catalog (
  fault_code, fault_index, variant, is_healthy, label_fr, severity,
  description_fr, action_fr, display_order)
values
  ('0L', 0, 'L', true, 'Aucun défaut identifié', 'none',
   'Fonctionnement de référence du modèle, variante L.',
   'Aucune action requise.', 0),
  ('0M', 0, 'M', true, 'Aucun défaut identifié', 'none',
   'Fonctionnement de référence du modèle, variante M.',
   'Aucune action requise.', 1),

  ('1L', 1, 'L', false, 'Défaut F1 · variante L (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée. L et M distinguent deux causes possibles du même défaut.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 10),
  ('1M', 1, 'M', false, 'Défaut F1 · variante M (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 11),

  ('2L', 2, 'L', false, 'Défaut F2 · variante L (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 20),
  ('2M', 2, 'M', false, 'Défaut F2 · variante M (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 21),

  ('3L', 3, 'L', false, 'Défaut F3 · variante L (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 30),
  ('3M', 3, 'M', false, 'Défaut F3 · variante M (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 31),

  ('4L', 4, 'L', false, 'Défaut F4 · variante L (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 40),
  ('4M', 4, 'M', false, 'Défaut F4 · variante M (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 41),

  ('5L', 5, 'L', false, 'Défaut F5 · variante L (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 50),
  ('5M', 5, 'M', false, 'Défaut F5 · variante M (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 51),

  ('6L', 6, 'L', false, 'Défaut F6 · variante L (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 60),
  ('6M', 6, 'M', false, 'Défaut F6 · variante M (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 61),

  ('7L', 7, 'L', false, 'Défaut F7 · variante L (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 70),
  ('7M', 7, 'M', false, 'Défaut F7 · variante M (à documenter)', null,
   'Nomenclature issue du jeu d''entraînement, non renseignée.',
   'Renseigner ce libellé dans Paramètres > Catalogue de pannes.', 71)
on conflict (fault_code) do update set
  fault_index  = excluded.fault_index,
  variant      = excluded.variant,
  is_healthy   = excluded.is_healthy,
  display_order = excluded.display_order;
  -- label_fr / severity / description_fr / action_fr ne sont VOLONTAIREMENT pas
  -- mis a jour : relancer le script ne doit jamais ecraser ce que tu as saisi.


-- =============================================================================
-- 7. RLS — posture de test : lecture et ecriture publiques
-- =============================================================================

alter table public.model_features        enable row level security;
alter table public.fault_catalog         enable row level security;
alter table public.device_feature_config enable row level security;
alter table public.device_settings       enable row level security;

-- Le dashboard anonyme doit lire le referentiel et le catalogue.
drop policy if exists "Public reads model features" on public.model_features;
create policy "Public reads model features"
  on public.model_features for select using (true);

drop policy if exists "Public reads fault catalog" on public.fault_catalog;
create policy "Public reads fault catalog"
  on public.fault_catalog for select using (true);

drop policy if exists "Public reads feature config" on public.device_feature_config;
create policy "Public reads feature config"
  on public.device_feature_config for select using (true);

drop policy if exists "Public reads device settings" on public.device_settings;
create policy "Public reads device settings"
  on public.device_settings for select using (true);

-- ATTENTION : ecriture publique, pour que la page Parametres fonctionne sans
-- authentification. Toute personne ayant l'URL peut modifier ces tables.
-- Voir la section 9 pour fermer cet acces.
drop policy if exists "Public writes model features" on public.model_features;
create policy "Public writes model features"
  on public.model_features for all using (true) with check (true);

drop policy if exists "Public writes fault catalog" on public.fault_catalog;
create policy "Public writes fault catalog"
  on public.fault_catalog for all using (true) with check (true);

drop policy if exists "Public writes feature config" on public.device_feature_config;
create policy "Public writes feature config"
  on public.device_feature_config for all using (true) with check (true);

drop policy if exists "Public writes device settings" on public.device_settings;
create policy "Public writes device settings"
  on public.device_settings for all using (true) with check (true);


-- =============================================================================
-- 8. CONFORT : updated_at, retention
-- =============================================================================

-- devices.updated_at existait deja mais n'etait jamais maintenu.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;

drop trigger if exists devices_touch_updated_at on public.devices;
create trigger devices_touch_updated_at
  before update on public.devices
  for each row execute function public.touch_updated_at();

drop trigger if exists model_features_touch_updated_at on public.model_features;
create trigger model_features_touch_updated_at
  before update on public.model_features
  for each row execute function public.touch_updated_at();

drop trigger if exists fault_catalog_touch_updated_at on public.fault_catalog;
create trigger fault_catalog_touch_updated_at
  before update on public.fault_catalog
  for each row execute function public.touch_updated_at();

drop trigger if exists device_feature_config_touch_updated_at on public.device_feature_config;
create trigger device_feature_config_touch_updated_at
  before update on public.device_feature_config
  for each row execute function public.touch_updated_at();

drop trigger if exists device_settings_touch_updated_at on public.device_settings;
create trigger device_settings_touch_updated_at
  before update on public.device_settings
  for each row execute function public.touch_updated_at();

-- Retention. Le cron tourne toutes les 5 min : 3 devices x 288 runs/jour =
-- 864 lignes/jour dans panel_diagnostics sans purge. A appeler une fois par
-- jour depuis le service d'inference (qui possede deja la cle service_role).
create or replace function public.prune_diagnostics(p_keep_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_deleted integer;
begin
  delete from public.panel_diagnostics
   where created_at < now() - make_interval(days => p_keep_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end; $$;

revoke all on function public.prune_diagnostics(integer) from public, anon, authenticated;


-- =============================================================================
-- 9. DURCISSEMENT (COMMENTE) — a activer le jour ou tu ouvres le produit
-- =============================================================================
--
-- Aujourd'hui la cle anon est livree dans le navigateur (config.js) et les
-- policies sont ouvertes. Consequence concrete : n'importe qui peut inserer de
-- fausses mesures dans sensor_readings, et comme l'inference lit cette table,
-- un tiers peut piloter ce que le dashboard affiche comme « diagnostic du
-- modele ». Acceptable pour des tests, pas pour un produit.
--
-- Le bloc ci-dessous ferme cet acces. Il suppose que tu crees d'abord un
-- utilisateur admin dans Supabase > Authentication > Users, et que tu
-- DESACTIVES « Allow new users to sign up » (sinon `authenticated` n'est pas
-- une frontiere de confiance : n'importe qui cree un compte).
--
-- Etapes manuelles, dans cet ordre :
--   1. Authentication > Providers > Email : decocher "Allow new users to sign up"
--   2. Authentication > Users : Add user (email + mot de passe fort, confirme)
--   3. Decommenter et executer le bloc ci-dessous en remplacant <UUID>
--
-- -----------------------------------------------------------------------------
-- create table if not exists public.admins (
--   user_id uuid primary key references auth.users(id) on delete cascade,
--   created_at timestamptz not null default now()
-- );
-- alter table public.admins enable row level security;
-- create policy "Admin sees own row" on public.admins
--   for select to authenticated using (user_id = auth.uid());
-- -- Aucune policy insert/update/delete : un utilisateur authentifie ne peut
-- -- PAS se promouvoir lui-meme. L'ajout se fait ici, en SQL Editor.
--
-- insert into public.admins (user_id) values ('<UUID>')
--   on conflict (user_id) do nothing;
--
-- create or replace function public.is_admin() returns boolean
-- language sql stable security definer set search_path = public, pg_temp as $$
--   select exists (select 1 from public.admins a where a.user_id = auth.uid());
-- $$;
-- revoke all on function public.is_admin() from public, anon;
-- grant execute on function public.is_admin() to authenticated;
--
-- -- Referentiels : lecture publique conservee, ecriture reservee aux admins.
-- drop policy if exists "Public writes model features" on public.model_features;
-- drop policy if exists "Public writes fault catalog"  on public.fault_catalog;
-- drop policy if exists "Public reads feature config"  on public.device_feature_config;
-- drop policy if exists "Public reads device settings" on public.device_settings;
-- drop policy if exists "Public writes feature config" on public.device_feature_config;
-- drop policy if exists "Public writes device settings" on public.device_settings;
--
-- create policy "Admins write model features" on public.model_features
--   for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- create policy "Admins write fault catalog" on public.fault_catalog
--   for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- create policy "Admins write feature config" on public.device_feature_config
--   for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- create policy "Admins write device settings" on public.device_settings
--   for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- create policy "Admins read feature config" on public.device_feature_config
--   for select to authenticated using (public.is_admin());
-- create policy "Admins read device settings" on public.device_settings
--   for select to authenticated using (public.is_admin());
--
-- -- Ingestion ESP32 par jeton par device, a la place de l'insertion publique.
-- create table if not exists public.device_ingest_tokens (
--   device_id  text primary key references public.devices(id) on delete cascade,
--   token_hash text not null,
--   created_at timestamptz not null default now(),
--   revoked_at timestamptz
-- );
-- alter table public.device_ingest_tokens enable row level security;
-- -- Aucune policy : inaccessible a anon et authenticated, service_role seulement.
--
-- create or replace function public.ingest_reading(
--   p_device_id text, p_token text,
--   p_intensite double precision, p_tension double precision,
--   p_temperature double precision, p_luminosite double precision
-- ) returns uuid
-- language plpgsql security definer set search_path = public, pg_temp as $$
-- declare
--   v_hash text; v_id uuid; v_last timestamptz;
-- begin
--   v_hash := encode(digest(p_token, 'sha256'), 'hex');
--   if not exists (select 1 from public.device_ingest_tokens t
--                  where t.device_id = p_device_id
--                    and t.token_hash = v_hash
--                    and t.revoked_at is null) then
--     raise exception 'unauthorized device' using errcode = '28000';
--   end if;
--   if not exists (select 1 from public.devices d
--                  where d.id = p_device_id and d.active) then
--     raise exception 'unknown or inactive device' using errcode = '22023';
--   end if;
--   select max(created_at) into v_last from public.sensor_readings
--    where device_id = p_device_id;
--   if v_last is not null and now() - v_last < interval '5 seconds' then
--     raise exception 'rate limited' using errcode = '53400';
--   end if;
--   insert into public.sensor_readings
--     (device_id, intensite, tension, temperature, luminosite)
--   values (p_device_id, p_intensite, p_tension, p_temperature, p_luminosite)
--   returning id into v_id;
--   return v_id;
-- end; $$;
--
-- -- La fonction DOIT etre appelable par anon (c'est l'ESP32 avec la cle anon) ;
-- -- la protection vient du jeton, pas du role.
-- revoke execute on function public.ingest_reading(text,text,double precision,double precision,double precision,double precision) from public;
-- grant execute on function public.ingest_reading(text,text,double precision,double precision,double precision,double precision) to anon;
--
-- drop policy if exists "Public can insert sensor readings" on public.sensor_readings;
-- revoke insert, update, delete on public.sensor_readings from anon;
-- create policy "Admins can insert sensor readings" on public.sensor_readings
--   for insert to authenticated with check (public.is_admin());
--
-- revoke insert, update, delete on public.devices from anon;
-- -----------------------------------------------------------------------------


-- =============================================================================
-- 10. VERIFICATION — a executer apres la migration
-- =============================================================================
--
-- select count(*) as features from public.model_features;   -- attendu : 13
-- select count(*) as pannes   from public.fault_catalog;    -- attendu : 16
--
-- -- La somme des defauts et du sain doit faire 16, et 0L/0M seuls sont sains :
-- select is_healthy, count(*) from public.fault_catalog group by 1;
--
-- -- Les 11 features sans contrepartie mesuree sur le site :
-- select feature_name, default_mode, coalesce(default_source_key, default_formula, 'constante') as origine
--   from public.model_features
--  where default_mode <> 'measured'
--  order by position;
--
-- Puis RELANCE le script entier : il doit passer sans erreur (idempotence).
-- =============================================================================
