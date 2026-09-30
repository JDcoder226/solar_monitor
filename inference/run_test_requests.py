"""Banc d'essai du modele : rejoue les saisies manuelles deposees par le dashboard.

Le dashboard ne peut pas executer le modele — c'est un Booster LightGBM Python et
le navigateur n'a que la cle anon. `model_test_requests` sert de boite aux
lettres : le dashboard y DEPOSE une demande, ce script la RETIRE, execute le vrai
modele, et ecrit le resultat. Le dashboard relit ensuite sa propre ligne.

Ce que ce script n'est PAS : un diagnostic d'installation. Il n'ecrit rien dans
`panel_diagnostics` et ne lit aucune mesure. Les 13 valeurs viennent d'un
formulaire, pas d'un capteur — les confondre reviendrait a presenter une saisie
manuelle comme une observation du site.

Difference avec `diagnose_panel.py`, et elle est structurelle :

    diagnose_panel  : 4 mesures brutes -> 11 features reconstituees (formules,
                      constantes de topologie) -> conversion en unites du modele
                      par `scale`/`offset` -> vecteur
    run_test_requests : 13 valeurs saisies -> vecteur

Ici il n'y a NI formule NI echelle. Les valeurs saisies sont deja dans l'espace du
modele, telles qu'un chercheur les ecrirait a la main pour sonder le classifieur.
C'est ce que l'utilisateur a demande : « tester le modele en entrant les donnees
manuellement, sans utiliser les donnees mesurees ».

Usage :
    python run_test_requests.py                 # traite les demandes en attente
    python run_test_requests.py --dry-run       # calcule sans rien ecrire
    python run_test_requests.py --limit 20      # au plus 20 demandes
    python run_test_requests.py --recover-stale # debloque les 'running' orphelines
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

from features import FeatureSpec, detect_ood
from model_io import load_feature_infos, load_model

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

DEFAULT_MODEL_PATH = ROOT / "models" / "lgbm_pv_fault_model.pkl"
DEFAULT_METADATA_PATH = ROOT / "models" / "metadata.json"
DEFAULT_FEATURE_INFOS_PATH = ROOT / "models" / "feature_infos.json"

TABLE = "model_test_requests"

# Une demande laissee en 'running' au-dela de ce delai est consideree orpheline :
# le workflow GitHub a ete annule ou a depasse son temps maximum. Sans ce
# rattrapage, la demande resterait 'running' a vie et le dashboard tournerait
# indefiniment.
STALE_MINUTES = 15


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Variable d'environnement manquante : {name}")
    return value


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Prediction
# ---------------------------------------------------------------------------

def predict_all(model, vector: list[float]) -> list[tuple[str, float]]:
    """Classe les 16 classes par probabilite decroissante.

    On renvoie le classement COMPLET et pas seulement le top 3 : sur un banc
    d'essai, la forme de la distribution est l'information utile. Un modele qui
    repond 1,00 sur une classe et 0,00 partout ailleurs ne dit pas la meme chose
    qu'un modele qui repond 0,35 / 0,30 / 0,20 — et le top 3 seul ne permet pas
    de faire la difference.
    """
    probabilities = model.booster.predict([vector])[0]

    if len(probabilities) != model.num_class:
        raise RuntimeError(
            f"Le modele a renvoye {len(probabilities)} probabilites, "
            f"{model.num_class} attendu."
        )

    return sorted(
        ((model.classes[i], float(p)) for i, p in enumerate(probabilities)),
        key=lambda item: item[1],
        reverse=True,
    )


def entropy(probabilities: list[float]) -> float:
    """Entropie de Shannon de la distribution (nats). 0 = certitude totale."""
    import math

    return -sum(p * math.log(p) for p in probabilities if p > 0.0)


# ---------------------------------------------------------------------------
# Validation de la saisie
# ---------------------------------------------------------------------------

def parse_features(payload: object, feature_names: list[str]) -> list[float]:
    """Valide la saisie et la range dans l'ordre attendu par le modele.

    On echoue bruyamment sur une cle manquante ou une valeur non numerique :
    LightGBM accepterait un vecteur trop court en produisant une prediction
    silencieusement fausse, ce qui est le pire resultat possible sur un banc
    d'essai.
    """
    if not isinstance(payload, dict):
        raise ValueError("Le champ 'features' n'est pas un objet JSON.")

    missing = [name for name in feature_names if name not in payload]
    if missing:
        raise ValueError(f"Features manquantes : {', '.join(missing)}")

    unknown = [name for name in payload if name not in feature_names]
    if unknown:
        raise ValueError(f"Features inconnues du modele : {', '.join(unknown)}")

    vector: list[float] = []
    for name in feature_names:
        raw = payload[name]
        if raw is None or raw == "":
            raise ValueError(f"Valeur absente pour {name}.")
        try:
            vector.append(float(raw))
        except (TypeError, ValueError):
            raise ValueError(f"Valeur non numerique pour {name} : {raw!r}") from None

    return vector


def specs_for_bench(
    feature_names: list[str], feature_infos: dict
) -> list[FeatureSpec]:
    """Construit les FeatureSpec du banc d'essai, uniquement pour `detect_ood`.

    `mode='measured'` et `scale=1, offset=0` : une valeur saisie est deja dans
    l'espace du modele, donc aucune conversion ne s'applique. Le mode importe
    parce que `detect_ood` saute les features 'constant' — ici, aucune ne doit
    etre sautee, toutes sont explicitement fournies.

    Les bornes viennent de `feature_infos.json`, genere depuis l'en-tete du
    modele. Une feature sans bornes connues est ecartee du controle plutot que
    comparee a des bornes inventees.
    """
    specs: list[FeatureSpec] = []
    for position, name in enumerate(feature_names):
        info = feature_infos.get(name) or {}
        train_min = info.get("train_min")
        train_max = info.get("train_max")
        if train_min is None or train_max is None:
            continue
        specs.append(
            FeatureSpec(
                name=name,
                position=position,
                mode="measured",
                scale=1.0,
                offset=0.0,
                train_min=float(train_min),
                train_max=float(train_max),
            )
        )
    return specs


# ---------------------------------------------------------------------------
# Traitement d'une demande
# ---------------------------------------------------------------------------

def run_one(model, feature_infos: dict, row: dict) -> dict:
    """Execute le modele sur une demande et construit le resultat a ecrire."""
    vector = parse_features(row.get("features"), model.feature_names)
    ranked = predict_all(model, vector)

    specs = specs_for_bench(model.feature_names, feature_infos)
    # `raw` porte les valeurs saisies : c'est ce que detect_ood compare aux
    # bornes d'entrainement. Les passer apres conversion les masquerait.
    ood = detect_ood(specs, {name: value for name, value in zip(model.feature_names, vector)})

    top_code, top_probability = ranked[0]
    return {
        "schema_version": 1,
        "model": {
            "file": model.model_path.name,
            "version": model.version,
            "sha256": model.sha256,
            "best_iteration": model.best_iteration,
            "num_class": model.num_class,
        },
        "input": {name: value for name, value in zip(model.feature_names, vector)},
        "top": {"code": top_code, "probability": top_probability},
        "ranking": [{"code": code, "probability": p} for code, p in ranked],
        "entropy": entropy([p for _, p in ranked]),
        "ood": ood,
    }


def process(client, model, feature_infos: dict, limit: int, dry_run: bool) -> int:
    pending = (
        client.table(TABLE)
        .select("id,created_at,created_by,features")
        .eq("status", "pending")
        .order("created_at")
        .limit(limit)
        .execute()
        .data
        or []
    )

    if not pending:
        print("Aucune demande en attente.")
        return 0

    print(f"{len(pending)} demande(s) en attente.")
    failures = 0

    for row in pending:
        request_id = row["id"]
        print(f"\n--- {request_id} (deposee par {row.get('created_by') or 'inconnu'})")

        # Prise conditionnelle : la demande n'est marquee 'running' que si elle
        # est encore 'pending'. Deux runners simultanes ne peuvent donc pas
        # traiter la meme ligne — le second repart avec 0 ligne modifiee.
        claimed = (
            client.table(TABLE)
            .update({"status": "running", "started_at": now_iso()})
            .eq("id", request_id)
            .eq("status", "pending")
            .select("id")
            .execute()
            .data
            or []
        )
        if not claimed:
            print("  deja prise par un autre runner, ignoree.")
            continue

        try:
            result = run_one(model, feature_infos, row)
        except Exception as error:  # noqa: BLE001 — on veut TOUT consigner
            failures += 1
            message = f"{type(error).__name__} : {error}"
            print(f"  ECHEC — {message}")
            if not dry_run:
                client.table(TABLE).update(
                    {"status": "error", "error": message, "finished_at": now_iso()}
                ).eq("id", request_id).execute()
            continue

        top = result["top"]
        print(f"  {top['code']}  {top['probability'] * 100:.2f}%")
        for entry in result["ranking"][1:3]:
            print(f"    puis {entry['code']}  {entry['probability'] * 100:.2f}%")
        if result["ood"]["is_ood"]:
            print(f"  HORS DOMAINE : {', '.join(result['ood']['features'])}")

        if dry_run:
            print("  (--dry-run : rien ecrit)")
            continue

        client.table(TABLE).update(
            {"status": "done", "result": result, "error": None, "finished_at": now_iso()}
        ).eq("id", request_id).execute()

    return failures


def recover_stale(client, stale_minutes: int, dry_run: bool) -> int:
    """Remet en attente les demandes bloquees en 'running'.

    Sans cela, un workflow annule en cours de route laisse une ligne 'running'
    que plus personne ne traitera : le dashboard attendrait un resultat qui
    n'arrivera jamais.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=stale_minutes)).isoformat()
    rows = (
        client.table(TABLE)
        .select("id,started_at")
        .eq("status", "running")
        .lt("started_at", cutoff)
        .execute()
        .data
        or []
    )

    if not rows:
        print(f"Aucune demande bloquee en 'running' depuis plus de {stale_minutes} min.")
        return 0

    for row in rows:
        print(f"  debloquee : {row['id']} (demarree {row['started_at']})")
        if not dry_run:
            client.table(TABLE).update(
                {"status": "pending", "started_at": None}
            ).eq("id", row["id"]).execute()

    return len(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=10, help="demandes traitees au plus")
    parser.add_argument("--dry-run", action="store_true", help="calculer sans ecrire en base")
    parser.add_argument(
        "--recover-stale",
        action="store_true",
        help="remettre en attente les demandes bloquees en 'running', puis sortir",
    )
    parser.add_argument(
        "--stale-minutes",
        type=int,
        default=STALE_MINUTES,
        help=f"age au-dela duquel une demande 'running' est orpheline (defaut {STALE_MINUTES})",
    )
    parser.add_argument("--model", default=os.getenv("PANEL_MODEL_PATH", str(DEFAULT_MODEL_PATH)))
    parser.add_argument("--metadata", default=str(DEFAULT_METADATA_PATH))
    parser.add_argument("--feature-infos", default=str(DEFAULT_FEATURE_INFOS_PATH))
    args = parser.parse_args(argv)

    client = create_client(require_env("SUPABASE_URL"), require_env("SUPABASE_SERVICE_ROLE_KEY"))

    if args.recover_stale:
        recover_stale(client, args.stale_minutes, args.dry_run)
        return 0

    # Les orphelines sont rattrapees AVANT de chercher du travail : sinon une
    # demande debloquee ne serait vue qu'au passage suivant, une heure plus tard.
    recover_stale(client, args.stale_minutes, args.dry_run)

    model = load_model(args.model, args.metadata)
    feature_infos = load_feature_infos(args.feature_infos)
    print(f"Modele charge : {model.version} | {len(model.feature_names)} features | {model.num_class} classes")

    if not feature_infos:
        # Ce n'est pas bloquant : on sait predire, on ne sait juste plus dire si
        # la saisie sort du domaine d'entrainement.
        print(
            f"ATTENTION : {args.feature_infos} est absent ou vide — "
            "le controle hors-domaine sera ignore."
        )

    failures = process(client, model, feature_infos, args.limit, args.dry_run)

    if failures:
        print(f"\n{failures} demande(s) en echec — voir le detail ci-dessus.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
