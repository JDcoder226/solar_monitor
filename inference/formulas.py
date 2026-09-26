"""Registre FERME des formules de derivation des features.

Pourquoi un registre ferme plutot qu'une expression stockee en base ?

`model_features.default_formula` et `device_feature_config.formula` contiennent
un NOM de formule, jamais une expression. Ces colonnes sont ecrites par la page
Parametres, donc par le navigateur. Evaluer une chaine venue de la base avec
`eval()` serait de l'execution de code arbitraire par quiconque peut ecrire la
configuration -- et la cle anon est publique. Un dictionnaire ferme elimine ce
risque par construction : une formule inconnue leve une erreur explicite au lieu
d'etre executee.

Toutes les formules travaillent en UNITES DU SITE. La conversion vers les
unites du modele est faite separement, par le scale/offset de la FeatureSpec.
"""

from __future__ import annotations

import math
from typing import Callable

# ctx attendu par les formules qui ont besoin de la topologie du site.
SITE_CONTEXT_KEYS = (
    "nominal_voltage_v",  # tension DC/AC nominale du site
    "nominal_current_a",  # courant DC nominal
    "nominal_frequency_hz",
    "efficiency",         # rendement onduleur
    "power_factor",
)

_SQRT2 = math.sqrt(2.0)
_SQRT3 = math.sqrt(3.0)


def _required(ctx: dict, key: str) -> float:
    value = ctx.get(key)
    if value is None:
        raise KeyError(
            f"La formule a besoin de '{key}' dans les parametres du site "
            f"(device_settings). Renseigne-le dans Parametres > Caracteristiques du site."
        )
    return float(value)


def dc_power(site: dict, ctx: dict) -> float:
    """Puissance DC instantanee, en W."""
    return float(site["Vpv"]) * float(site["Ipv"])


def mean_abs3(site: dict, ctx: dict) -> float:
    """Moyenne des valeurs absolues de trois signaux (magnitude, toujours > 0).

    Utilisee pour Iabc (alimentee par ia/ib/ic) et Vabc (alimentee par va/vb/vc),
    dont les bornes d'entrainement sont strictement positives ([1e-7 ; 6,76] et
    [1 ; 156,29]) : ce sont des magnitudes, pas des grandeurs instantanees.

    Les cles `a`, `b`, `c` sont injectees par build_vector depuis `depends_on`
    de la FeatureSpec -- c'est `depends_on` qui fait foi, il n'y a pas de table
    de correspondance separee a maintenir.
    """
    return (abs(float(site["a"])) + abs(float(site["b"])) + abs(float(site["c"]))) / 3.0


def rms3(site: dict, ctx: dict) -> float:
    """Valeur efficace d'un systeme triphase, cles a/b/c injectees comme ci-dessus."""
    return math.sqrt(
        (float(site["a"]) ** 2 + float(site["b"]) ** 2 + float(site["c"]) ** 2) / 3.0
    )


def phase_voltage_peak(site: dict, ctx: dict) -> float:
    """Creneau (peak) d'une tension de phase a partir de la tension composee.

    V_phase_peak = V_LL * sqrt(2) / sqrt(3)

    Le modele a ete entraine avec va/vb/vc bornes a ~+/-160 V, soit 113 V
    efficaces phase-neutre et ~197 V compose. Le site est a 400 V compose :
    d'ou le facteur correctif porte par `scale`, calcule a l'execution.
    """
    return _required(ctx, "nominal_voltage_v") * _SQRT2 / _SQRT3


def ac_phase_peak_from_dc_power(site: dict, ctx: dict) -> float:
    """Courant de phase crete deduit de la puissance DC mesuree.

    P_dc = Vpv * Ipv
    I_rms = P_dc * rendement / (sqrt(3) * V_LL * facteur_de_puissance)
    I_crete = I_rms * sqrt(2)

    C'est cette formule qui rend ia/ib/ic REACTIFS a la mesure reelle au lieu
    d'etre des constantes figees : sans elle, un changement de puissance DC
    n'aurait aucun effet sur les courants AC vus par le modele.

    Limite assumee : le dephasage entre phases n'est pas modelise, donc ia, ib
    et ic sont identiques a un facteur d'echelle pres.
    """
    power_dc = dc_power(site, ctx)
    v_ll = _required(ctx, "nominal_voltage_v")
    efficiency = _required(ctx, "efficiency")
    power_factor = _required(ctx, "power_factor")
    i_rms = power_dc * efficiency / (_SQRT3 * v_ll * power_factor)
    return i_rms * _SQRT2


FORMULAS: dict[str, Callable[[dict, dict], float]] = {
    "dc_power": dc_power,
    "mean_abs3": mean_abs3,
    "rms3": rms3,
    "phase_voltage_peak": phase_voltage_peak,
    "ac_phase_peak_from_dc_power": ac_phase_peak_from_dc_power,
}

def get_formula(name: str) -> Callable[[dict, dict], float]:
    """Retourne la formule nommee, ou leve une erreur explicite."""
    if name not in FORMULAS:
        raise KeyError(
            f"Formule inconnue : '{name}'. "
            f"Formules disponibles : {', '.join(sorted(FORMULAS))}. "
            "Le registre est volontairement ferme -- ajoute la formule dans "
            "inference/formulas.py, pas en base."
        )
    return FORMULAS[name]


def available_formulas() -> list[str]:
    """Liste des formules, pour alimenter la liste deroulante de la page Parametres."""
    return sorted(FORMULAS)
