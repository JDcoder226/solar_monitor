"""Assemblage du vecteur de 13 features attendu par le modele LightGBM.

Trois responsabilites :

1. `resolve_specs`  -- fusionne le referentiel global (`model_features`) et les
   surcharges par installation (`device_feature_config`) en une liste de
   FeatureSpec complete, ordonnee par `position`.
2. `build_vector`   -- transforme une ligne `sensor_readings` + les nominales du
   site en un vecteur (13,) dans les unites du modele.
3. `detect_ood`     -- signale les features hors de la plage d'entrainement.

CONVENTION DE CALIBRATION (la meme que dans supabase_migration_v2.sql) :

  mode = 'measured' | 'derived'  ->  la valeur est produite en unites du SITE, puis
                                     ramenee en unites du MODELE par
                                         valeur_modele = valeur_site * scale + offset
  mode = 'constant'              ->  constant_value est DEJA en unites du MODELE,
                                     scale/offset ne sont pas appliques. Une constante
                                     n'a pas de contrepartie mesuree sur le site, donc
                                     la convertir n'aurait aucun sens.

`scale` par defaut = base du modele / base du site, ou
  base du modele = (train_max - train_min) / 2
  base du site   = la grandeur nominale du site designee par `site_base_kind`
C'est ce qui rend la valeur auditable : « 0,152 car base modele 60,8 V / base site
400 V » se verifie, un `scale = 0,152` nu ne se verifie pas.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable

from formulas import get_formula

MODES = ("measured", "derived", "constant")

# Nombre de features attendues. Doit rester coherent avec `max_feature_idx = 12`
# et avec `num_class = 16` du modele.
EXPECTED_FEATURE_COUNT = 13

_SQRT2 = math.sqrt(2.0)
_SQRT3 = math.sqrt(3.0)


class ConfigError(RuntimeError):
    """Configuration incoherente -- on echoue bruyamment plutot que de deviner."""


class MissingInputError(RuntimeError):
    """Une feature declaree 'measured' n'a pas de valeur dans la ligne lue."""


@dataclass(frozen=True)
class FeatureSpec:
    name: str
    position: int
    mode: str
    scale: float
    offset: float
    train_min: float
    train_max: float
    source_key: str | None = None
    constant_value: float | None = None
    formula: str | None = None
    depends_on: tuple[str, ...] = ()
    scale_justification: str = ""


# ---------------------------------------------------------------------------
# Resolution de l'echelle
# ---------------------------------------------------------------------------

def site_base(kind: str | None, site: dict) -> tuple[float | None, str]:
    """Grandeur nominale du site servant de denominateur au `scale`.

    Retourne (valeur, justification lisible). `valeur` vaut None si la grandeur
    n'est pas disponible dans les parametres du site.
    """
    def need(key: str) -> float | None:
        value = site.get(key)
        return float(value) if value not in (None, "") else None

    if kind == "dc_voltage":
        v = need("nominal_voltage_v")
        return v, f"tension nominale du site {v} V" if v else "tension nominale absente"

    if kind == "dc_current":
        v = need("nominal_current_a")
        return v, f"courant nominal du site {v} A" if v else "courant nominal absent"

    if kind == "frequency":
        v = need("nominal_frequency_hz")
        return v, f"frequence nominale {v} Hz" if v else "frequence nominale absente"

    if kind == "ac_voltage_peak":
        v_ll = need("nominal_voltage_v")
        if v_ll is None:
            return None, "tension nominale absente"
        peak = v_ll * _SQRT2 / _SQRT3
        return peak, f"creneau de phase {peak:.1f} V (compose {v_ll} V / racine(3) x racine(2))"

    if kind == "ac_current_peak":
        v_ll = need("nominal_voltage_v")
        i_dc = need("nominal_current_a")
        efficiency = need("efficiency")
        power_factor = need("power_factor")
        if None in (v_ll, i_dc, efficiency, power_factor):
            return None, "nominales de puissance incompletes"
        power_dc = v_ll * i_dc
        i_peak = power_dc * efficiency * _SQRT2 / (_SQRT3 * v_ll * power_factor)
        return i_peak, (
            f"courant de crete {i_peak:.2f} A "
            f"({power_dc:.0f} W DC, rendement {efficiency}, cos phi {power_factor})"
        )

    if kind == "excitation_current":
        # Aucune contrepartie sur ce site : on apparie la base du modele a la
        # base du courant disponible, ce qui revient a ne pas deformer l'echelle.
        v = need("nominal_current_a")
        return v, f"courant nominal du site {v} A (pas de contrepartie reelle)" if v else "non resolu"

    return None, "echelle non derivee (mode constante ou type inconnu)"


def compute_scale(
    model_base: float,
    kind: str | None,
    site: dict,
    default_scale: float | None,
    manual_scale: float | None,
) -> tuple[float, str]:
    """Echelle effective d'une feature, avec sa justification.

    Precedence : surcharge manuelle > calcul depuis les nominales du site >
    `default_scale` du referentiel.
    """
    if manual_scale is not None:
        return float(manual_scale), "valeur fixee manuellement dans Parametres"

    base, why = site_base(kind, site)
    if base:
        return model_base / base, f"base modele {model_base:.2f} / {why}"

    if default_scale is not None:
        return float(default_scale), "echelle par defaut du referentiel (nominales du site indisponibles)"

    return 1.0, "echelle neutre (1,0)"


# ---------------------------------------------------------------------------
# resolve_specs
# ---------------------------------------------------------------------------

def _pick(override: dict | None, catalog: dict, field: str, default: Any = None) -> Any:
    """Surcharge par device si non NULLE, sinon valeur du referentiel global."""
    if override is not None:
        value = override.get(field)
        if value is not None and value != "":
            return value
    value = catalog.get(field)
    return default if value is None else value


def resolve_specs(
    catalog: list[dict],
    overrides: Iterable[dict] = (),
    feature_infos: dict | None = None,
    site: dict | None = None,
) -> list[FeatureSpec]:
    """Fusionne referentiel global et surcharges, puis valide la coherence.

    `catalog`       : lignes de public.model_features
    `overrides`     : lignes de public.device_feature_config pour ce device
    `feature_infos` : models/feature_infos.json (bornes d'entrainement)
    `site`          : nominales du site (public.device_settings)
    """
    feature_infos = feature_infos or {}
    site = site or {}
    override_by_name = {row["feature_name"]: row for row in overrides}

    specs: list[FeatureSpec] = []
    for row in catalog:
        name = row["feature_name"]
        info = feature_infos.get(name, {})
        override = override_by_name.get(name)

        train_min = float(row.get("train_min", info.get("train_min", 0.0)))
        train_max = float(row.get("train_max", info.get("train_max", 1.0)))
        model_base = (train_max - train_min) / 2.0

        mode = _pick(override, row, "mode") or row.get("default_mode")
        if mode not in MODES:
            raise ConfigError(
                f"Feature '{name}' : mode '{mode}' invalide. Attendu : {', '.join(MODES)}."
            )

        scale_kind = row.get("site_base_kind")
        manual_scale = override.get("scale") if override else None
        # `scale_offset` et non `offset` : OFFSET est reserve en PostgreSQL.
        manual_offset = override.get("scale_offset") if override else None

        if mode == "constant":
            scale, why = 1.0, "mode constante : valeur deja en unites du modele"
        else:
            scale, why = compute_scale(
                model_base, scale_kind, site, row.get("default_scale"), manual_scale
            )

        offset = (
            float(manual_offset)
            if manual_offset is not None
            else float(row.get("default_offset") or 0.0)
        )

        specs.append(
            FeatureSpec(
                name=name,
                position=int(row["position"]),
                mode=mode,
                scale=scale,
                offset=offset,
                train_min=train_min,
                train_max=train_max,
                source_key=_pick(override, row, "source_key") or row.get("default_source_key"),
                constant_value=(
                    float(_pick(override, row, "constant_value"))
                    if _pick(override, row, "constant_value") is not None
                    else (
                        float(row["default_constant_value"])
                        if row.get("default_constant_value") is not None
                        else None
                    )
                ),
                formula=_pick(override, row, "formula") or row.get("default_formula"),
                depends_on=tuple(row.get("depends_on") or ()),
                scale_justification=why,
            )
        )

    _validate(specs)
    return sorted(specs, key=lambda spec: spec.position)


def _validate(specs: list[FeatureSpec]) -> None:
    """Echoue bruyamment plutot que de produire un vecteur mal forme.

    Sans cette validation, une config a 12 features produirait une matrice a 12
    colonnes et LightGBM leverait une erreur opaque au moment du predict.
    """
    positions = sorted(spec.position for spec in specs)
    if positions != list(range(EXPECTED_FEATURE_COUNT)):
        raise ConfigError(
            f"Le referentiel doit couvrir exactement les positions "
            f"0..{EXPECTED_FEATURE_COUNT - 1}. Obtenu : {positions}. "
            "Verifie public.model_features (13 lignes attendues)."
        )

    for spec in specs:
        if spec.mode == "measured" and not spec.source_key:
            raise ConfigError(f"Feature '{spec.name}' : mode 'measured' sans source_key.")
        if spec.mode == "derived":
            if not spec.formula:
                raise ConfigError(f"Feature '{spec.name}' : mode 'derived' sans formule.")
            get_formula(spec.formula)  # leve si la formule n'existe pas
        if spec.mode == "constant" and spec.constant_value is None:
            raise ConfigError(f"Feature '{spec.name}' : mode 'constant' sans constante.")

    names = {spec.name for spec in specs}
    for spec in specs:
        for dep in spec.depends_on:
            if dep not in names:
                raise ConfigError(
                    f"Feature '{spec.name}' depend de '{dep}', absent du referentiel."
                )


def _topological_order(specs: list[FeatureSpec]) -> list[FeatureSpec]:
    """Trie les features pour qu'aucune ne soit resolue avant ses dependances."""
    by_name = {spec.name: spec for spec in specs}
    ordered: list[FeatureSpec] = []
    seen: set[str] = set()
    visiting: set[str] = set()

    def visit(spec: FeatureSpec) -> None:
        if spec.name in seen:
            return
        if spec.name in visiting:
            raise ConfigError(f"Dependance circulaire autour de '{spec.name}'.")
        visiting.add(spec.name)
        for dep in spec.depends_on:
            visit(by_name[dep])
        visiting.discard(spec.name)
        seen.add(spec.name)
        ordered.append(spec)

    for spec in sorted(specs, key=lambda s: s.position):
        visit(spec)
    return ordered


# ---------------------------------------------------------------------------
# build_vector
# ---------------------------------------------------------------------------

def build_vector(
    specs: list[FeatureSpec],
    reading: dict,
    site: dict | None = None,
) -> tuple[list[float], dict, dict, dict[str, str]]:
    """Construit le vecteur (13,) dans les unites du modele.

    Retourne (vecteur, inputs, raw, sources) :
      inputs  -- valeurs en unites du MODELE (ce que le modele voit)
      raw     -- valeurs en unites du SITE (ce que la formule/le capteur produit)
      sources -- provenance de chaque feature, pour la tracabilite
    """
    site = site or {}
    site_values: dict[str, float] = {}
    inputs: dict[str, float] = {}
    raw: dict[str, float] = {}
    sources: dict[str, str] = {}

    for spec in _topological_order(specs):
        if spec.mode == "measured":
            value = reading.get(spec.source_key)
            if value is None:
                raise MissingInputError(
                    f"Feature '{spec.name}' : la colonne '{spec.source_key}' est vide "
                    f"dans la mesure lue."
                )
            value = float(value)
            raw[spec.name] = value
            site_values[spec.name] = value
            sources[spec.name] = f"measured:{spec.source_key}"
            inputs[spec.name] = value * spec.scale + spec.offset

        elif spec.mode == "derived":
            # Les formules a/b/c (mean_abs3, rms3) recoivent leur triplet via
            # depends_on -- depend_on fait foi, il n'y a pas de table annexe.
            args = dict(site_values)
            if len(spec.depends_on) == 3:
                args = {"a": site_values[spec.depends_on[0]],
                        "b": site_values[spec.depends_on[1]],
                        "c": site_values[spec.depends_on[2]]}
            value = get_formula(spec.formula)(args, site)
            raw[spec.name] = value
            site_values[spec.name] = value
            sources[spec.name] = f"derived:{spec.formula}"
            inputs[spec.name] = value * spec.scale + spec.offset

        else:  # constant
            value = float(spec.constant_value)
            raw[spec.name] = value
            site_values[spec.name] = value
            sources[spec.name] = "constant"
            # Les constantes sont deja en unites du modele : pas de scale/offset.
            inputs[spec.name] = value

    vector = [inputs[spec.name] for spec in sorted(specs, key=lambda s: s.position)]
    return vector, inputs, raw, sources


# ---------------------------------------------------------------------------
# Hors-domaine
# ---------------------------------------------------------------------------

def detect_ood(specs: list[FeatureSpec], raw: dict) -> dict:
    """Repere les features hors de la plage d'entrainement du modele.

    ATTENTION -- on compare les valeurs en UNITES DU SITE (`raw`), pas les
    valeurs apres `scale`. C'est volontaire, et c'est tout l'interet.

    Le `scale` sert precisement a ramener le point de fonctionnement du site
    dans la plage numerique du modele. Si on testait les valeurs APRES mise a
    l'echelle, elles seraient toujours dans les bornes par construction et la
    detection ne se declencherait jamais : la calibration masquerait exactement
    ce qu'il faut signaler. Verifier la valeur physique revient a demander
    « le modele a-t-il deja vu une tension de 400 V ? » -- non, sa borne haute
    est 111 V.

    Cela suppose que `scale` convertit entre la meme grandeur physique (c'est le
    cas : A -> A, V -> V, Hz -> Hz), ce qui est sa definition meme.

    Sans cette detection, le dashboard afficherait un healthy/defective
    peremptoire. Un modele a base d'arbres ne leve pas d'erreur sur une valeur
    hors bornes : il la fait tomber dans le dernier bin, silencieusement -- et
    renvoie ici 3M avec 100 % de confiance, ce qui est plus trompeur qu'une
    confiance basse.
    """
    details: dict[str, dict] = {}
    for spec in specs:
        if spec.mode == "constant":
            continue  # une constante est un choix assume, pas une mesure a valider
        value = raw[spec.name]
        span = spec.train_max - spec.train_min
        if value < spec.train_min:
            side, excess = "below", spec.train_min - value
        elif value > spec.train_max:
            side, excess = "above", value - spec.train_max
        else:
            continue
        details[spec.name] = {
            "value": round(value, 6),
            "train_min": spec.train_min,
            "train_max": spec.train_max,
            "side": side,
            "excess_ratio": round(excess / span, 4) if span else None,
        }
    return {"is_ood": bool(details), "features": sorted(details), "details": details}


def count_by_mode(specs: list[FeatureSpec]) -> dict[str, int]:
    """« 2 mesurees, 8 derivees, 3 figees » -- affiche tel quel dans le dashboard."""
    counts = {mode: 0 for mode in MODES}
    for spec in specs:
        counts[spec.mode] += 1
    return counts
