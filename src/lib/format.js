export function format(value, digits = 0) {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits }).format(value);
}

export function metricValue(value, digits = 0) {
  return Number.isFinite(value) ? format(value, digits) : "--";
}

export function formatDateTime(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeLabel(value) {
  return new Date(value).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function formatPercent(value, digits = 0) {
  return Number.isFinite(value) ? `${format(value * 100, digits)} %` : "--";
}

/**
 * Enrichit une ligne de sensor_readings avec les grandeurs derivees utilisees
 * par l'affichage. La puissance n'est pas stockee : elle se recalcule (P = U x I).
 */
export function normalizeReading(row) {
  const current = Number(row.intensite);
  const voltage = Number(row.tension);
  return {
    ...row,
    label: timeLabel(row.created_at),
    current,
    voltage,
    power: current * voltage,
    temperature: Number(row.temperature),
    luminosity: Number(row.luminosite),
  };
}

/** Borné ISO de debut de periode pour les filtres 24h / 7j / 30j. */
export function periodStartIso(period) {
  const days = period === "24h" ? 1 : period === "7j" ? 7 : 30;
  const start = new Date();
  start.setDate(start.getDate() - days);
  return start.toISOString();
}
