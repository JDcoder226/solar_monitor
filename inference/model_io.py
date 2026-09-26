"""Chargement du modele LightGBM et lecture de ses metadonnees internes.

PIEGE A CONNAITRE -- `models/lgbm_pv_fault_model.txt` n'est PAS un modele texte
LightGBM, malgre son extension :

    $ shasum -a 256 models/lgbm_pv_fault_model.txt models/lgbm_pv_fault_model.pkl
    cdbc699f...4b8  models/lgbm_pv_fault_model.txt
    cdbc699f...4b8  models/lgbm_pv_fault_model.pkl

Les deux fichiers sont byte-identiques et commencent par `\\x80\\x04`, l'opcode
du protocole pickle 4. Le `.txt` est un pickle encapsulant un
`lightgbm.basic.Booster`, dont le `model_str` natif est imbrique a l'interieur.

Consequence : `lgb.Booster(model_file=".../lgbm_pv_fault_model.txt")` ECHOUE
("Model file is not a valid LightGBM model"), et l'exemple de rechargement de la
cellule 32 du notebook est faux pour cet artefact. La seule voie est
`joblib.load()` / `pickle.load()`, utilisee ci-dessous.

Autre consequence utile : les classes venant de `metadata.json` (un LabelEncoder
trie, donc `index i -> classes[i]`), on n'a plus besoin de scikit-learn au
runtime. `joblib` ne sert plus qu'a deserialiser.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

import joblib
import lightgbm as lgb

# Le modele a ete entraine sur 13 features et 16 classes. Ces valeurs sont
# verifiees au chargement : un modele remplace par erreur doit echouer tout de
# suite, pas produire des diagnostics silencieusement faux.
EXPECTED_FEATURE_COUNT = 13
EXPECTED_CLASS_COUNT = 16


@dataclass(frozen=True)
class LoadedModel:
    booster: lgb.Booster
    metadata: dict
    feature_names: list[str]
    classes: list[str]
    num_class: int
    best_iteration: int
    sha256: str
    model_path: Path

    @property
    def version(self) -> str:
        """Identifiant court et stable, ecrit dans panel_diagnostics.model_version.

        Permet de retrouver quels diagnostics venaient de quel modele apres un
        reentrainement.
        """
        return f"{self.model_path.stem}@{self.sha256[:12]}"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_native_header(booster: lgb.Booster) -> dict:
    """Relit l'en-tete LightGBM natif depuis le Booster deserialise.

    C'est la source de verite pour `feature_names`, `num_class` et
    `feature_infos` : ces valeurs viennent du modele lui-meme, pas d'un fichier
    annexe qui pourrait avoir diverges.
    """
    text = booster.model_to_string()
    header: dict = {}

    for key in ("num_class", "max_feature_idx", "objective", "label_index"):
        match = re.search(rf"^{key}=(.*)$", text, re.M)
        if match:
            header[key] = match.group(1).strip()

    match = re.search(r"^feature_names=(.*)$", text, re.M)
    if match:
        header["feature_names"] = match.group(1).split()

    match = re.search(r"^feature_infos=(.*)$", text, re.M)
    if match:
        pairs = re.findall(r"\[([^:\]]+):([^\]]+)\]", match.group(1))
        header["feature_infos"] = [
            {"train_min": float(lo), "train_max": float(hi)} for lo, hi in pairs
        ]

    return header


def load_model(model_path: str | Path, metadata_path: str | Path | None = None) -> LoadedModel:
    """Charge le modele et verifie sa coherence avec metadata.json."""
    model_path = Path(model_path)
    if not model_path.exists():
        raise FileNotFoundError(f"Modele introuvable : {model_path}")

    if metadata_path is None:
        metadata_path = model_path.parent / "metadata.json"
    metadata_path = Path(metadata_path)
    metadata = (
        json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata_path.exists()
        else {}
    )

    # joblib.load et non lgb.Booster(model_file=...) -- voir le docstring.
    booster = joblib.load(model_path)
    if not isinstance(booster, lgb.Booster):
        raise TypeError(
            f"{model_path} contient un objet {type(booster).__name__}, pas un lgb.Booster."
        )

    header = parse_native_header(booster)
    feature_names = header.get("feature_names") or list(metadata.get("feature_cols") or [])
    num_class = int(header.get("num_class", metadata.get("num_class", 0)) or 0)

    classes = [str(label) for label in (metadata.get("classes") or [])]
    if not classes:
        raise ValueError(
            f"{metadata_path} ne contient pas de liste 'classes'. Elle est necessaire "
            "pour traduire l'index predit (0..15) en code de defaut (0L..7M)."
        )

    # --- Garde-fous ---------------------------------------------------------
    if len(feature_names) != EXPECTED_FEATURE_COUNT:
        raise ValueError(
            f"Le modele attend {len(feature_names)} features, {EXPECTED_FEATURE_COUNT} "
            f"attendu. Obtenu : {feature_names}"
        )
    if num_class != EXPECTED_CLASS_COUNT or len(classes) != EXPECTED_CLASS_COUNT:
        raise ValueError(
            f"Incoherence de classes : num_class={num_class}, "
            f"{len(classes)} libelles dans metadata.json, {EXPECTED_CLASS_COUNT} attendu."
        )

    metadata_cols = metadata.get("feature_cols")
    if metadata_cols and list(metadata_cols) != feature_names:
        raise ValueError(
            "metadata.json et le modele ne decrivent pas les memes features.\n"
            f"  metadata.json : {metadata_cols}\n"
            f"  modele        : {feature_names}\n"
            "Un modele a probablement ete remplace sans regenerer les metadonnees."
        )

    best_iteration = int(
        getattr(booster, "best_iteration", 0) or metadata.get("best_iteration", 0) or 0
    )

    return LoadedModel(
        booster=booster,
        metadata=metadata,
        feature_names=list(feature_names),
        classes=classes,
        num_class=num_class,
        best_iteration=best_iteration,
        sha256=sha256_file(model_path),
        model_path=model_path,
    )


def load_feature_infos(path: str | Path) -> dict:
    """Charge models/feature_infos.json (bornes d'entrainement des 13 features)."""
    path = Path(path)
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def write_feature_infos(booster_or_model: lgb.Booster | LoadedModel, path: str | Path) -> dict:
    """Genere models/feature_infos.json depuis l'en-tete du modele.

    Utile apres un reentrainement : les bornes d'entrainement changent avec les
    donnees, et `detect_ood` comme le seed SQL en dependent.
    """
    booster = (
        booster_or_model.booster
        if isinstance(booster_or_model, LoadedModel)
        else booster_or_model
    )
    header = parse_native_header(booster)
    names = header.get("feature_names", [])
    infos = header.get("feature_infos", [])
    if len(names) != len(infos):
        raise ValueError("feature_names et feature_infos n'ont pas la meme longueur.")

    payload = {}
    for position, (name, bounds) in enumerate(zip(names, infos)):
        lo, hi = bounds["train_min"], bounds["train_max"]
        payload[name] = {
            "position": position,
            "train_min": lo,
            "train_max": hi,
            "model_base": (hi - lo) / 2.0,
            "is_bipolar": lo < 0 < hi,
        }

    path = Path(path)
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return payload
