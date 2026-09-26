"""Lecture de la configuration depuis Supabase (page Parametres).

Les quatre tables lues ici sont celles creees par supabase_migration_v2.sql :
  public.model_features         referentiel des 13 features
  public.device_feature_config  surcharges par installation
  public.fault_catalog          catalogue 0L..7M
  public.device_settings        nominales du site et seuils

Toutes les lectures sont tolerantes a l'absence de ligne : le service doit
demarrer sur une base fraiche, avant que tu aies saisi quoi que ce soit. Les
valeurs par defaut ci-dessous reproduisent exactement celles documentees en
commentaire dans le script SQL.
"""

from __future__ import annotations

from typing import Any

# Valeurs par defaut, utilisees quand public.device_settings n'a pas de ligne
# pour le device. Ce sont les memes que celles commentees dans le SQL.
DEFAULT_SITE_SETTINGS: dict[str, float | int | str] = {
    "nominal_voltage_v": 400.0,
    "nominal_current_a": 10.0,
    "nominal_frequency_hz": 50.0,
    "efficiency": 0.97,
    "power_factor": 1.0,
    "conf_min": 0.55,
    "stale_after_minutes": 30,
    "model_version": None,
}

# Seuil de confiance sous lequel le diagnostic passe en `warning`.
CONF_MIN_FALLBACK = 0.55
STALE_AFTER_MINUTES_FALLBACK = 30


def _table(client, name: str) -> list[dict]:
    """Lecture simple, avec message d'erreur explicite si la table manque.

    Une table absente signifie presque toujours que supabase_migration_v2.sql
    n'a pas encore ete execute : on le dit clairement plutot que de laisser
    remonter un PGRST205 obscur.
    """
    try:
        response = client.table(name).select("*").execute()
    except Exception as exc:  # noqa: BLE001 -- on retraduit l'erreur du client
        raise RuntimeError(
            f"Lecture de '{name}' impossible ({exc}). "
            "As-tu bien execute supabase_migration_v2.sql dans le SQL Editor ?"
        ) from exc
    return response.data or []


def load_feature_catalog(client) -> list[dict]:
    """Les 13 lignes de public.model_features, ordonnees par position."""
    rows = _table(client, "model_features")
    if not rows:
        raise RuntimeError(
            "public.model_features est vide : le referentiel des 13 features n'a "
            "pas ete seede. Execute supabase_migration_v2.sql."
        )
    return sorted(rows, key=lambda row: row["position"])


def load_device_overrides(client, device_id: str) -> list[dict]:
    """Surcharges de public.device_feature_config pour ce device (peut etre vide)."""
    try:
        response = (
            client.table("device_feature_config")
            .select("*")
            .eq("device_id", device_id)
            .execute()
        )
    except Exception:  # noqa: BLE001 -- surcharges optionnelles, on continue
        return []
    return response.data or []


def load_site_settings(client, device_id: str) -> dict:
    """Nominales du site et seuils, avec repli sur les valeurs par defaut.

    Une ligne absente n'est pas une erreur : `device_settings` est optionnelle.
    """
    settings = dict(DEFAULT_SITE_SETTINGS)
    try:
        response = (
            client.table("device_settings")
            .select("*")
            .eq("device_id", device_id)
            .limit(1)
            .execute()
        )
        rows = response.data or []
    except Exception:  # noqa: BLE001 -- table absente = on garde les defauts
        rows = []

    if rows:
        for key, value in rows[0].items():
            # On ne remplace un defaut que par une valeur reellement renseignee :
            # une colonne NULL signifie « herite du defaut », pas « vaut None ».
            if value is not None:
                settings[key] = value

    return settings


def load_fault_catalog(client) -> dict[str, dict[str, Any]]:
    """Catalogue des 16 codes de defaut, indexe par fault_code."""
    try:
        rows = _table(client, "fault_catalog")
    except RuntimeError:
        return {}
    return {row["fault_code"]: row for row in rows}


# Marqueurs du libelle provisoire. Les deux graphies sont acceptees : le seed
# SQL ecrit « (a documenter) » sans accent, mais l'utilisateur qui corrige un
# libelle a la main ecrira naturellement « (à documenter) ». Refuser l'une des
# deux ferait basculer un defaut non documente en `defective` publie -- soit
# exactement ce que ce mecanisme doit empecher.
# Miroir : src/lib/model-config.js (verifie par selftest.py, section 8).
UNDOCUMENTED_MARKERS = ("(a documenter)", "(à documenter)")


def is_undocumented(entry: dict | None, fault_code: str | None = None) -> bool:
    """Le libelle du catalogue est-il encore provisoire ?

    Le seed SQL marque les 14 defauts non documentes par le suffixe
    "(à documenter)". Tant qu'il est present, le service refuse de conclure et
    force le statut en `warning` : impossible d'oublier de remplir le catalogue
    avant que le dashboard n'affiche un diagnostic a libelle bidon.

    Une entree absente compte comme non documentee : un code predit dont le
    catalogue ne parle pas ne doit pas etre presente comme un resultat ferme.
    `fault_code` n'est la que pour la lisibilite des appels.
    """
    if not entry:
        return True
    label = str(entry.get("label_fr") or "")
    return any(marker in label for marker in UNDOCUMENTED_MARKERS)


def conf_min(settings: dict) -> float:
    value = settings.get("conf_min")
    return float(value) if value is not None else CONF_MIN_FALLBACK


def stale_after_minutes(settings: dict) -> int:
    value = settings.get("stale_after_minutes")
    return int(value) if value is not None else STALE_AFTER_MINUTES_FALLBACK
