import { format, formatPercent } from "./format.js";

/**
 * Met en forme un diagnostic produit par le service d'inférence.
 *
 * Remplace deux comportements de l'ancien dashboard :
 *   - le faux « score de confiance 97,3 % » écrit en dur dans le JSX ;
 *   - la logique binaire `status === "healthy" ? ... : "Défaut probable"`,
 *     qui écrasait la distinction entre un défaut confirmé et un diagnostic
 *     inexploitable (`warning`).
 */
export function describeDiagnosis(row) {
  if (!row) {
    return {
      tone: "warn",
      headline: "Aucun diagnostic disponible",
      detail:
        "Le service d'inférence n'a pas encore produit de diagnostic pour cette " +
        "installation. Lance `python diagnose_panel.py` ou attends le prochain cron.",
      status: null,
      confidence: null,
      degraded: true,
      reasons: ["aucun diagnostic en base"],
    };
  }

  const degraded = Boolean(row.is_degraded) || row.status === "warning";
  const tone = row.status === "healthy" ? "good" : row.status === "defective" ? "bad" : "warn";

  let headline;
  if (row.status === "healthy") {
    headline = "Panneau sain";
  } else if (row.status === "defective") {
    headline = row.fault_label || `Défaut ${row.fault_code || "?"}`;
  } else {
    headline = "Diagnostic inexploitable";
  }

  const parts = [];
  if (row.fault_code) {
    parts.push(`Code prédit ${row.fault_code}`);
    if (row.fault_variant) parts.push(`variante ${row.fault_variant}`);
  }
  if (Number.isFinite(Number(row.score))) {
    parts.push(`confiance ${formatPercent(Number(row.score), 1)}`);
  }
  if (row.runner_up_code) {
    parts.push(`second candidat ${row.runner_up_code}`);
  }

  return {
    tone,
    headline,
    detail: row.reason || parts.join(" · ") || "—",
    status: row.status,
    confidence: Number.isFinite(Number(row.score)) ? Number(row.score) : null,
    faultCode: row.fault_code,
    faultIndex: row.fault_index,
    faultVariant: row.fault_variant,
    label: row.fault_label,
    action: row.recommended_action,
    severity: row.severity,
    degraded,
    reasons: row.degradation_reasons || [],
    oodFeatures: row.ood_features || [],
    dataCompleteness: Number.isFinite(Number(row.data_completeness))
      ? Number(row.data_completeness)
      : null,
    measuredCount: row.features?.measured_count,
    derivedCount: row.features?.derived_count,
    constantCount: row.features?.constant_count,
    modelVersion: row.model_version,
    configHash: row.config_hash,
    createdAt: row.created_at,
  };
}

/**
 * Diagnostic local de repli, utilisé UNIQUEMENT quand le service d'inférence
 * n'a rien produit. Il est volontairement présenté comme tel dans l'interface :
 * ce n'est pas le modèle, c'est une heuristique à seuils.
 *
 * Les seuils étaient codés en dur dans l'ancien code.html ; ils sont
 * regroupés ici pour être lisibles et ajustables.
 */
export const LOCAL_THRESHOLDS = {
  temperatureAlert: 60, // °C
  voltageMin: 360, // V
  voltageMax: 420, // V
  powerDropRatio: 0.72,
};

export function localDiagnosis(readings, device) {
  if (!readings.length) {
    return {
      tone: "warn",
      headline: "Aucune mesure disponible",
      detail: "Cette installation n'a envoyé aucune donnée sur la période sélectionnée.",
      degraded: true,
      reasons: ["aucune mesure sur la période"],
    };
  }

  const current = readings[0];
  const history = readings.slice(0, 6);
  const averagePower = history.reduce((sum, r) => sum + r.power, 0) / history.length;
  const capacity = Number(device?.capacity_kwc || 0) * 1000;

  if (current.temperature >= LOCAL_THRESHOLDS.temperatureAlert) {
    return {
      tone: "warn",
      headline: "Surchauffe probable",
      detail: `Température ${format(current.temperature, 1)} °C, au-dessus du seuil de ${LOCAL_THRESHOLDS.temperatureAlert} °C.`,
      degraded: true,
      reasons: ["diagnostic local par seuils, pas le modèle"],
    };
  }
  if (
    current.voltage < LOCAL_THRESHOLDS.voltageMin ||
    current.voltage > LOCAL_THRESHOLDS.voltageMax
  ) {
    return {
      tone: "warn",
      headline: "Tension hors fenêtre MPPT",
      detail: `Tension ${format(current.voltage)} V, hors de la fenêtre ${LOCAL_THRESHOLDS.voltageMin}–${LOCAL_THRESHOLDS.voltageMax} V.`,
      degraded: true,
      reasons: ["diagnostic local par seuils, pas le modèle"],
    };
  }
  if (averagePower > 0 && current.power < averagePower * LOCAL_THRESHOLDS.powerDropRatio) {
    return {
      tone: "warn",
      headline: "Baisse de rendement",
      detail: `Puissance ${format(current.power)} W contre ${format(averagePower)} W en moyenne récente.`,
      degraded: true,
      reasons: ["diagnostic local par seuils, pas le modèle"],
    };
  }

  return {
    tone: "warn",
    headline: "Aucune anomalie visible",
    detail:
      "Les seuils locaux ne détectent rien, mais le diagnostic par le modèle " +
      "n'a pas encore été produit. Cette conclusion ne vaut pas validation.",
    degraded: true,
    reasons: ["diagnostic local par seuils, pas le modèle"],
    capacity,
  };
}
