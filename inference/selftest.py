"""Auto-test du service d'inference, sans Supabase.

Verifie que le modele se charge, que la configuration du referentiel produit un
vecteur de 13 features, et que la regle de decision reagit comme prevu.

Le referentiel n'est PAS recopie ici : il est lu depuis le seed de
`supabase_migration_v2.sql`. Le test valide donc aussi la syntaxe des tuples SQL
et la coherence des 13 lignes telles qu'elles seront ecrites en base.

    python selftest.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from features import MODES, build_vector, count_by_mode, detect_ood, resolve_specs
from formulas import available_formulas
from model_io import load_feature_infos, load_model
from settings import DEFAULT_SITE_SETTINGS, UNDOCUMENTED_MARKERS, is_undocumented

ROOT = Path(__file__).resolve().parent
SQL_PATH = ROOT.parent / "supabase_migration_v2.sql"
MODEL_CONFIG_JS = ROOT.parent / "src" / "lib" / "model-config.js"

# Lecture realiste du site : tension dans la fenetre MPPT affichee par le
# dashboard (360-420 V), intensite dans la plage annoncee (0-11,5 A).
SAMPLE_READING = {
    "id": "00000000-0000-0000-0000-000000000000",
    "intensite": 8.4,
    "tension": 402.0,
    "temperature": 41.2,
    "luminosite": 76.0,
    "created_at": "2026-09-24T12:00:00+00:00",
}

PASS, FAIL = "OK  ", "ECHEC"
_failures = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global _failures
    if condition:
        print(f"  [{PASS}] {label}")
    else:
        _failures += 1
        print(f"  [{FAIL}] {label}" + (f" -- {detail}" if detail else ""))


# ---------------------------------------------------------------------------
# Extraction du seed SQL
# ---------------------------------------------------------------------------

def parse_sql_values(sql: str, insert_prefix: str) -> list[list]:
    """Extrait les tuples d'un INSERT ... VALUES depuis le script de migration.

    Petit analyseur caracteres par caracteres : gere les chaines quotees (avec
    '' comme echappement), les nombres, null, les litteraux de tableau '{}' et
    les tuples imbriques.
    """
    start = sql.find(insert_prefix)
    if start < 0:
        raise ValueError(f"INSERT introuvable dans le SQL : {insert_prefix[:60]}...")

    values_at = sql.find("values", start)
    if values_at < 0:
        raise ValueError("Mot-cle VALUES introuvable.")

    # On borne la zone a analyser. Sans cela, le parseur continue dans la clause
    # `on conflict (feature_name) do update set ...` et ramasse `feature_name`
    # et `now()` comme s'il s'agissait de lignes de donnees.
    region = sql[values_at + len("values"):]
    stop = re.search(r"\bon conflict\b|\breturning\b|;", region)
    if stop:
        region = region[: stop.start()]

    sql = region
    index = 0
    rows: list[list] = []
    current: list = []
    token = ""
    depth = 0
    in_string = False

    def flush_token() -> None:
        nonlocal token
        stripped = token.strip()
        if not stripped:
            token = ""
            return
        lowered = stripped.lower()
        if lowered == "null":
            current.append(None)
        elif lowered == "true":
            current.append(True)
        elif lowered == "false":
            current.append(False)
        elif re.fullmatch(r"-?\d+", stripped):
            current.append(int(stripped))
        elif re.fullmatch(r"-?\d*\.?\d+(?:[eE][-+]?\d+)?", stripped):
            current.append(float(stripped))
        elif stripped.startswith("{") or stripped.startswith("'"):
            current.append(stripped)
        else:
            current.append(stripped)
        token = ""

    while index < len(sql):
        char = sql[index]

        if in_string:
            if char == "'":
                if index + 1 < len(sql) and sql[index + 1] == "'":
                    token += "'"
                    index += 2
                    continue
                in_string = False
                token += char
            else:
                token += char
            index += 1
            continue

        if char == "'":
            in_string = True
            token += char
        elif char == "(":
            if depth == 0:
                current, token = [], ""
            else:
                token += char
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                flush_token()
                rows.append(current)
                current, token = [], []
            else:
                token += char
        elif char == "," and depth == 1:
            flush_token()
        elif char == ";" and depth == 0:
            break
        elif depth >= 1:
            token += char
        index += 1

    return rows


def unquote(value) -> str | None:
    if value is None:
        return None
    text = str(value)
    if text.startswith("'") and text.endswith("'"):
        return text[1:-1].replace("''", "'")
    return text


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def main() -> int:
    print("1. Chargement du modele")
    model = load_model(ROOT / "models" / "lgbm_pv_fault_model.pkl")
    check("13 features", len(model.feature_names) == 13, str(model.feature_names))
    check("16 classes", model.num_class == 16, str(model.num_class))
    check("classes 0L..7M", model.classes[0] == "0L" and model.classes[-1] == "7M")

    print("\n2. Lecture du referentiel depuis le seed SQL")
    if not SQL_PATH.exists():
        print(f"  [SKIP] {SQL_PATH.name} absent -- test du seed ignore.")
        return 0 if _failures == 0 else 1

    sql = SQL_PATH.read_text(encoding="utf-8")

    feature_rows = parse_sql_values(sql, "insert into public.model_features")
    check("13 lignes de features", len(feature_rows) == 13, f"obtenu {len(feature_rows)}")

    columns = [
        "feature_name", "position", "train_min", "train_max", "unit", "description_fr",
        "site_base_kind", "default_mode", "default_source_key", "default_formula",
        "default_constant_value", "default_scale", "default_offset", "depends_on",
    ]
    catalog = []
    for row in feature_rows:
        if len(row) != len(columns):
            check(f"tuple a {len(columns)} colonnes", False, f"obtenu {len(row)} : {row[:3]}")
            continue
        entry = dict(zip(columns, row))
        for text_column in (
            "feature_name", "unit", "description_fr", "site_base_kind",
            "default_mode", "default_source_key", "default_formula",
        ):
            entry[text_column] = unquote(entry[text_column])
        # depends_on arrive ici comme le litteral SQL '{}' ou '{Ipv,Vpv}' :
        # on le de-quote avant de le decouper. En production c'est Postgres qui
        # renvoie un vrai tableau text[].
        depends = unquote(entry["depends_on"]) or ""
        entry["depends_on"] = [
            item.strip() for item in depends.strip("{}").split(",") if item.strip()
        ]
        catalog.append(entry)

    check("positions 0..12", sorted(r["position"] for r in catalog) == list(range(13)))

    print("\n3. Resolution de la configuration")
    feature_infos = load_feature_infos(ROOT / "models" / "feature_infos.json")
    site = dict(DEFAULT_SITE_SETTINGS)
    specs = resolve_specs(catalog, [], feature_infos, site)
    modes = count_by_mode(specs)
    check("13 specs resolues", len(specs) == 13)
    check(
        "2 mesurees / 8 derivees / 3 figees",
        (modes["measured"], modes["derived"], modes["constant"]) == (2, 8, 3),
        f"obtenu {modes}",
    )

    # Sans les nominales du site, les formules de puissance doivent refuser de
    # deviner plutot que de produire un vecteur silencieusement faux. L'echec
    # survient a l'assemblage (build_vector), pas a la resolution : resolve_specs
    # valide la FORME de la configuration, build_vector resout les VALEURS.
    try:
        bare = resolve_specs(catalog, [], feature_infos, {})
        build_vector(bare, SAMPLE_READING, {})
        check("nominales absentes -> echec explicite", False, "aucune erreur levee")
    except KeyError:
        check("nominales absentes -> echec explicite", True)
    except Exception as exc:  # noqa: BLE001
        check("nominales absentes -> echec explicite", False, f"{type(exc).__name__}: {exc}")

    print("\n4. Assemblage du vecteur")
    vector, inputs, raw, sources = build_vector(specs, SAMPLE_READING, site)
    check("vecteur de 13 valeurs", len(vector) == 13, f"obtenu {len(vector)}")
    check("aucune valeur non finie", all(isinstance(v, float) for v in vector))

    print(f"     sources : {sources}")
    print(f"     inputs  : { {k: round(v, 3) for k, v in inputs.items()} }")

    print("\n5. Detection de hors-domaine")
    # detect_ood prend les valeurs PHYSIQUES (raw), pas celles apres scale.
    ood = detect_ood(specs, raw)
    check("hors-domaine detecte", ood["is_ood"], str(ood["features"]))
    check("Vpv signale", "Vpv" in ood["features"], str(ood["features"]))
    for name, detail in sorted(ood["details"].items()):
        print(
            f"     {name:<5} = {detail['value']:<10} hors bornes "
            f"[{detail['train_min']:.2f}, {detail['train_max']:.2f}] -> {detail['side']}"
        )

    print("\n6. Prediction")
    probabilities = model.booster.predict([vector])
    check("forme (1, 16)", probabilities.shape == (1, 16), str(probabilities.shape))
    ranked = sorted(
        ((model.classes[i], float(p)) for i, p in enumerate(probabilities[0])),
        key=lambda item: item[1],
        reverse=True,
    )
    check(
        "probabilites sommees a 1",
        abs(sum(p for _, p in ranked) - 1.0) < 1e-6,
        f"somme = {sum(p for _, p in ranked)}",
    )
    print("     top 3 : " + ", ".join(f"{code} {prob:.1%}" for code, prob in ranked[:3]))

    print("\n7. Catalogue de pannes")
    fault_rows = parse_sql_values(sql, "insert into public.fault_catalog")
    check("16 lignes de catalogue", len(fault_rows) == 16, f"obtenu {len(fault_rows)}")
    codes = [unquote(r[0]) for r in fault_rows]
    check("codes 0L..7M", sorted(codes) == sorted(model.classes), f"{sorted(codes)[:5]}...")
    healthy = [unquote(r[0]) for r in fault_rows if r[3] is True]
    check("seuls 0L et 0M sont sains", sorted(healthy) == ["0L", "0M"], str(healthy))
    documented = [c for c, r in zip(codes, fault_rows) if not is_undocumented(
        {"label_fr": unquote(r[4])})]
    check(
        "14 defauts marques a documenter",
        len(documented) == 2,
        f"non documentes : {len(documented)}",
    )

    print("\n8. Coherence Python <-> interface (src/lib/model-config.js)")
    # Le navigateur ne peut pas importer du Python : les registres sont donc
    # dupliques en JS. Cette section est ce qui rend la duplication sure --
    # sans elle, ajouter une formule cote Python la rendrait simplement
    # invisible dans la liste deroulante des Parametres, sans aucun signal.
    if not MODEL_CONFIG_JS.exists():
        check("model-config.js present", False, str(MODEL_CONFIG_JS))
    else:
        js_source = MODEL_CONFIG_JS.read_text(encoding="utf-8")

        def js_string_array(name: str) -> list[str]:
            match = re.search(
                rf"export const {name} = \[(.*?)\];", js_source, re.DOTALL
            )
            if not match:
                return []
            return re.findall(r'"([^"]+)"', match.group(1))

        js_formulas = js_string_array("FORMULAS")
        py_formulas = available_formulas()
        check(
            f"FORMULAS identiques ({len(py_formulas)} cote Python)",
            js_formulas == py_formulas,
            f"JS {js_formulas} != Python {py_formulas}",
        )

        js_modes = js_string_array("MODES")
        check(
            f"MODES identiques ({len(MODES)} cote Python)",
            js_modes == list(MODES),
            f"JS {js_modes} != Python {list(MODES)}",
        )

        # Cette section a ete ajoutee apres avoir constate le bug : le chip
        # « N a documenter » des Parametres affichait 0 alors que 14 defauts
        # portaient la mention, parce que le JS ne testait que la graphie
        # accentuee. Un test qui ne compare que des listes n'aurait rien vu.
        js_markers = js_string_array("UNDOCUMENTED_MARKERS")
        check(
            f"UNDOCUMENTED_MARKERS identiques ({len(UNDOCUMENTED_MARKERS)} cote Python)",
            js_markers == list(UNDOCUMENTED_MARKERS),
            f"JS {js_markers} != Python {list(UNDOCUMENTED_MARKERS)}",
        )
        for label in ("Defaut F1 - variante L (a documenter)", "Defaut F1 (à documenter)"):
            check(f"catalogue : « {label[:28]}... » compte comme non documente",
                  is_undocumented({"label_fr": label}))
        check("catalogue : un libelle renseigne compte comme documente",
              not is_undocumented({"label_fr": "Perte de rendement string 3"}))

    print()
    if _failures:
        print(f"{_failures} verification(s) en echec.")
        return 1
    print("Toutes les verifications passent.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
