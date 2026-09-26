/**
 * Miroirs JavaScript des registres definis cote Python.
 *
 * Ces listes DOIVENT rester identiques a leur source :
 *   FORMULAS    <-> inference/formulas.py :: available_formulas()
 *   SOURCE_KEYS <-> colonnes de public.sensor_readings
 *   MODES       <-> inference/features.py :: MODES
 *   SEVERITIES  <-> contrainte fault_catalog_severity du SQL
 *
 * La duplication est inevitable : le navigateur ne peut pas importer du Python.
 * Elle est verifiee automatiquement par inference/selftest.py, section 8, qui
 * relit ce fichier et compare FORMULAS au registre reel. Si tu ajoutes une
 * formule dans formulas.py sans l'ajouter ici, l'autotest echoue.
 *
 * Pourquoi une liste fermee plutot qu'un champ libre : une formule stockee en
 * base puis evaluee serait de l'execution de code arbitraire par quiconque peut
 * ecrire dans model_features. Le registre ferme supprime ce risque.
 */
/** Ordre alphabetique, identique a `sorted(FORMULAS)` cote Python. */
export const FORMULAS = [
  "ac_phase_peak_from_dc_power",
  "dc_power",
  "mean_abs3",
  "phase_voltage_peak",
  "rms3",
];

/** Colonnes de sensor_readings utilisables comme source directe. */
export const SOURCE_KEYS = ["intensite", "tension", "temperature", "luminosite"];

export const MODES = ["measured", "derived", "constant"];

export const MODE_LABELS = {
  measured: "mesurée",
  derived: "dérivée",
  constant: "figée",
};

export const SEVERITIES = ["none", "low", "medium", "high"];

/**
 * Marqueurs du libelle provisoire du catalogue de pannes.
 *
 * Miroir de settings.py :: UNDOCUMENTED_MARKERS, verifie par l'autotest.
 * Les deux graphies sont acceptees parce que le seed SQL ecrit
 * « (a documenter) » sans accent alors qu'un libelle corrige a la main
 * contiendra « (à documenter) ». N'en reconnaitre qu'une seule ferait passer
 * un defaut non documente pour un defaut etabli -- precisement ce que ce
 * mecanisme doit empecher.
 */
export const UNDOCUMENTED_MARKERS = ["(a documenter)", "(à documenter)"];

export function isUndocumented(label) {
  const text = String(label || "");
  return UNDOCUMENTED_MARKERS.some((marker) => text.includes(marker));
}
