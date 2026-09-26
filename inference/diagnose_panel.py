"""Diagnostic des panneaux a partir du modele LightGBM 16 classes.

Ce script remplace une version qui ne pouvait pas fonctionner : elle attendait
8 features (`intensite, tension, ..., mean_voltage`) alors que le modele en
requiert 13, cherchait `panel_model.pkl` qui n'existe pas, et appelait
`model.predict_proba()` / `model.classes_` sur un `lgb.Booster` qui n'a ni l'un
ni l'autre. Meme si elle avait tourne, elle aurait classe TOUT panneau sain en
`defective` : le modele renvoie "0L" ou "0M", jamais "healthy" ou "0".

Usage :
    python diagnose_panel.py                    # tous les devices actifs
    python diagnose_panel.py --device ESP32-ARRAY-01
    python diagnose_panel.py --dry-run          # calcule sans ecrire en base
    python diagnose_panel.py --prune-days 90    # purge puis diagnostique

A lancer par cron toutes les 5 minutes (voir Dockerfile).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

from features import (
    ConfigError,
    MissingInputError,
    build_vector,
    count_by_mode,
    detect_ood,
    resolve_specs,
)
from model_io import load_feature_infos, load_model
from settings import (
    conf_min,
    is_undocumented,
    load_device_overrides,
    load_fault_catalog,
    load_feature_catalog,
    load_site_settings,
    stale_after_minutes,
)

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

DEFAULT_MODEL_PATH = ROOT / "models" / "lgbm_pv_fault_model.pkl"
DEFAULT_METADATA_PATH = ROOT / "models" / "metadata.json"
DEFAULT_FEATURE_INFOS_PATH = ROOT / "models" / "feature_infos.json"

READINGS_WINDOW = 60  # nombre de mesures lues pour le contexte


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Variable d'environnement manquante : {name}")
    return value


# ---------------------------------------------------------------------------
# Prediction
# ---------------------------------------------------------------------------

def predict(model, vector: list[float]) -> tuple[str, float, list[tuple[str, float]]]:
    """Retourne (fault_code, confiance, classement des 3 meilleurs).

    Pour un objectif multiclass, `Booster.predict` renvoie une matrice
    (n_lignes, num_class). On prend l'argmax puis on traduit l'index en code de
    defaut via `classes` de metadata.json (un LabelEncoder trie, donc
    index i -> classes[i]).
    """
    probabilities = model.booster.predict([vector])
    row = probabilities[0]

    if len(row) != model.num_class:
        raise RuntimeError(
            f"Le modele a renvoye {len(row)} probabilites, {model.num_class} attendu."
        )

    ranked = sorted(
        ((model.classes[i], float(p)) for i, p in enumerate(row)),
        key=lambda item: item[1],
        reverse=True,
    )
    top_code, top_probability = ranked[0]
    return top_code, top_probability, ranked[:3]


def split_code(fault_code: str) -> tuple[int | None, str | None]:
    """'7M' -> (7, 'M'). Tolere un code inattendu sans faire planter le service."""
    digits = "".join(char for char in fault_code if char.isdigit())
    letters = "".join(char for char in fault_code if char.isalpha())
    index = int(digits) if digits else None
    variant = letters.upper()[:1] if letters else None
    return index, variant


# ---------------------------------------------------------------------------
# Decision
# ---------------------------------------------------------------------------

def decide(
    fault_code: str,
    confidence: float,
    fault_index: int | None,
    catalog_entry: dict | None,
    ood: dict,
    reading_age_minutes: float,
    settings: dict,
) -> tuple[str, list[str]]:
    """Applique la regle de decision. L'ORDRE COMPTE : le warning prime.

    Les trois valeurs autorisees par le schema sont healthy / defective /
    warning. Le warning n'est pas un cas degrade secondaire : c'est ce qui
    permet de dire « le resultat est hors du domaine de validite du modele »,
    ce qui est exactement la situation de ce site (tension a ~4x la borne haute).
    """
    reasons: list[str] = []

    if ood.get("is_ood"):
        listed = ", ".join(ood["features"])
        reasons.append(f"mesure hors domaine d'entrainement ({listed})")
    if is_undocumented(catalog_entry, fault_code):
        reasons.append(f"catalogue de pannes non renseigne pour {fault_code}")
    if confidence < conf_min(settings):
        reasons.append(
            f"confiance {confidence:.0%} sous le seuil de {conf_min(settings):.0%}"
        )
    if reading_age_minutes > stale_after_minutes(settings):
        reasons.append(f"derniere mesure vieille de {reading_age_minutes:.0f} min")

    if reasons:
        return "warning", reasons
    if fault_index == 0:
        return "healthy", []
    return "defective", []


def build_reason(
    status: str,
    fault_code: str,
    confidence: float,
    catalog_entry: dict | None,
    reasons: list[str],
) -> str:
    if status == "warning":
        return "Diagnostic degrade : " + " ; ".join(reasons) + "."
    if status == "healthy":
        return "Aucun defaut identifie sur la derniere mesure."
    label = (catalog_entry or {}).get("label_fr") or f"Defaut {fault_code}"
    return f"{label} detecte ({confidence:.0%} de confiance)."


def config_hash(specs) -> str:
    """Empreinte de la configuration effective des 13 features.

    Ecrite dans le diagnostic : elle permet de correler un changement de
    resultat avec un changement de configuration, plutot que de le prendre pour
    un vrai defaut.
    """
    payload = json.dumps(
        [
            {
                "name": spec.name,
                "position": spec.position,
                "mode": spec.mode,
                "source_key": spec.source_key,
                "formula": spec.formula,
                "constant_value": spec.constant_value,
                "scale": round(spec.scale, 10),
                "offset": round(spec.offset, 10),
            }
            for spec in sorted(specs, key=lambda item: item.position)
        ],
        sort_keys=True,
        separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Diagnostic d'un device
# ---------------------------------------------------------------------------

def diagnose_device(client, model, feature_infos: dict, device_id: str, dry_run: bool = False) -> dict | None:
    catalog = load_feature_catalog(client)
    overrides = load_device_overrides(client, device_id)
    settings = load_site_settings(client, device_id)
    fault_catalog = load_fault_catalog(client)

    response = (
        client.table("sensor_readings")
        .select("id,intensite,tension,temperature,luminosite,created_at")
        .eq("device_id", device_id)
        .order("created_at", desc=True)
        .limit(READINGS_WINDOW)
        .execute()
    )
    rows = response.data or []
    if not rows:
        print(f"{device_id} : aucune mesure, rien a diagnostiquer.")
        return None

    reading = rows[0]
    specs = resolve_specs(catalog, overrides, feature_infos, settings)

    try:
        vector, inputs, raw, sources = build_vector(specs, reading, settings)
    except MissingInputError as exc:
        print(f"{device_id} : {exc}")
        return None

    # detect_ood compare les valeurs PHYSIQUES (raw) aux bornes du modele :
    # tester les valeurs apres `scale` les rendrait toujours conformes et la
    # detection ne se declencherait jamais. Voir features.detect_ood.
    ood = detect_ood(specs, raw)
    fault_code, confidence, ranked = predict(model, vector)
    fault_index, variant = split_code(fault_code)
    catalog_entry = fault_catalog.get(fault_code)

    reading_time = datetime.fromisoformat(str(reading["created_at"]).replace("Z", "+00:00"))
    age_minutes = (datetime.now(timezone.utc) - reading_time).total_seconds() / 60.0

    status, reasons = decide(
        fault_code, confidence, fault_index, catalog_entry, ood, age_minutes, settings
    )
    reason = build_reason(status, fault_code, confidence, catalog_entry, reasons)
    modes = count_by_mode(specs)
    specs_hash = config_hash(specs)
    completeness = round(modes["measured"] / len(specs), 4)

    payload = {
        "device_id": device_id,
        "reading_id": reading.get("id"),
        "status": status,
        "score": round(confidence, 4),
        "reason": reason,
        "fault_code": fault_code,
        "fault_index": fault_index,
        "fault_variant": variant,
        "fault_label": (catalog_entry or {}).get("label_fr"),
        "severity": (catalog_entry or {}).get("severity"),
        "recommended_action": (catalog_entry or {}).get("action_fr"),
        "runner_up_code": ranked[1][0] if len(ranked) > 1 else None,
        "runner_up_score": round(ranked[1][1], 4) if len(ranked) > 1 else None,
        "model_version": model.version,
        "data_completeness": round(completeness, 3),
        "is_degraded": bool(reasons),
        "degradation_reasons": reasons,
        "ood_features": ood["features"],
        "config_hash": specs_hash,
        "features": {
            "schema_version": 1,
            "model": {
                "file": model.model_path.name,
                "sha256": model.sha256,
                "best_iteration": model.best_iteration,
                "num_class": model.num_class,
            },
            "inputs": {name: round(value, 6) for name, value in inputs.items()},
            "raw": {name: round(value, 6) for name, value in raw.items()},
            "sources": sources,
            "scales": {
                spec.name: {
                    "scale": round(spec.scale, 10),
                    "offset": spec.offset,
                    "why": spec.scale_justification,
                }
                for spec in specs
            },
            "data_completeness": completeness,
            "measured_count": modes["measured"],
            "derived_count": modes["derived"],
            "constant_count": modes["constant"],
            "ood": ood,
            "probabilities": {
                "top": [[code, round(prob, 4)] for code, prob in ranked],
            },
            "config": {
                "conf_min": conf_min(settings),
                "reading_age_minutes": round(age_minutes, 2),
                "config_hash": specs_hash,
            },
            "degradation_reasons": reasons,
        },
    }

    if dry_run:
        print(json.dumps(payload, indent=2, ensure_ascii=False, default=str))
        return payload

    client.table("panel_diagnostics").insert(payload).execute()
    print(
        f"{device_id} : {status:<10} {fault_code:<3} {confidence:>6.1%} "
        f"| {modes['measured']} mesurees / {modes['derived']} derivees / "
        f"{modes['constant']} figees | {reason}"
    )
    return payload


# ---------------------------------------------------------------------------
# Entree
# ---------------------------------------------------------------------------

def active_device_ids(client, explicit: list[str] | None) -> list[str]:
    if explicit:
        return explicit
    env_devices = [item.strip() for item in os.getenv("DEVICE_IDS", "").split(",") if item.strip()]
    if env_devices:
        return env_devices

    response = client.table("devices").select("id").eq("active", True).order("name").execute()
    return [row["id"] for row in (response.data or [])]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", action="append", help="device a diagnostiquer (repetable)")
    parser.add_argument("--dry-run", action="store_true", help="calculer sans ecrire en base")
    parser.add_argument("--prune-days", type=int, help="purger les diagnostics plus vieux que N jours")
    parser.add_argument("--model", default=os.getenv("PANEL_MODEL_PATH", str(DEFAULT_MODEL_PATH)))
    parser.add_argument("--metadata", default=str(DEFAULT_METADATA_PATH))
    parser.add_argument("--feature-infos", default=str(DEFAULT_FEATURE_INFOS_PATH))
    args = parser.parse_args(argv)

    try:
        model = load_model(args.model, args.metadata)
    except (FileNotFoundError, TypeError, ValueError) as exc:
        print(f"Chargement du modele impossible : {exc}", file=sys.stderr)
        return 2

    feature_infos = load_feature_infos(args.feature_infos)
    if not feature_infos:
        print(
            f"Attention : {args.feature_infos} absent. La detection de hors-domaine "
            "sera desactivee. Regenere-le avec model_io.write_feature_infos().",
            file=sys.stderr,
        )

    print(f"Modele charge : {model.version} | {len(model.feature_names)} features | {model.num_class} classes")

    client = create_client(
        require_env("SUPABASE_URL"), require_env("SUPABASE_SERVICE_ROLE_KEY")
    )

    if args.prune_days is not None:
        deleted = client.rpc("prune_diagnostics", {"p_keep_days": args.prune_days}).execute()
        print(f"Retention : {deleted.data} diagnostics purges (> {args.prune_days} jours).")

    failures = 0
    for device_id in active_device_ids(client, args.device):
        try:
            diagnose_device(client, model, feature_infos, device_id, dry_run=args.dry_run)
        except (ConfigError, MissingInputError) as exc:
            print(f"{device_id} : configuration invalide -- {exc}", file=sys.stderr)
            failures += 1
        except Exception as exc:  # noqa: BLE001 -- un device en echec ne doit pas bloquer les autres
            print(f"{device_id} : echec -- {exc}", file=sys.stderr)
            failures += 1

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
