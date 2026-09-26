/* Les cles sont les libelles affiches : elles doivent rester identiques a celles
   de code.html (« Intensité », « Température », « Luminosité »), parce que
   App.jsx s'en sert aussi comme valeur de <option> et d'etat `metric`. */
const METRIC_KEYS = {
  Puissance: { key: "power", unit: "W" },
  Intensité: { key: "current", unit: "A" },
  Tension: { key: "voltage", unit: "V" },
  Température: { key: "temperature", unit: "°C" },
  Luminosité: { key: "luminosity", unit: "%" },
};

export const METRIC_OPTIONS = Object.keys(METRIC_KEYS);

export default function TelemetryChart({ data, metric }) {
  if (!data.length) {
    return (
      <div className="mt-5 h-[300px] rounded-lg border border-dashed border-slate-200 grid place-items-center text-sm text-slate-400">
        Aucune mesure disponible pour cette installation.
      </div>
    );
  }

  const { key, unit } = METRIC_KEYS[metric] || METRIC_KEYS.Puissance;

  // Les mesures arrivent de Supabase en ordre decroissant (la plus recente
  // d'abord) : on remet dans l'ordre chronologique pour tracer de gauche a droite.
  const series = [...data].reverse();
  const values = series.map((item) => item[key]);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);

  const width = 760;
  const height = 250;
  const pad = 28;
  const span = max - min || 1;
  const stepX = series.length > 1 ? (width - pad * 2) / (series.length - 1) : 0;

  const pointAt = (value, index) => {
    const x = pad + index * stepX;
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return [x, y];
  };

  const points = values.map((value, index) => pointAt(value, index).join(",")).join(" ");
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const baseline = series.map((_, index) => pointAt(average, index).join(",")).join(" ");

  return (
    <div className="mt-5 grid-paper rounded-lg border border-slate-100 p-2 h-[300px] relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-full overflow-visible"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Évolution de la ${metric.toLowerCase()} sur la période sélectionnée`}
      >
        <polyline
          points={`${pad},${height - pad} ${points} ${width - pad},${height - pad}`}
          fill="rgba(247,169,40,.12)"
          stroke="none"
        />
        <polyline
          points={baseline}
          fill="none"
          stroke="#3f79bd"
          strokeWidth="2"
          strokeDasharray="5 6"
        />
        <polyline
          points={points}
          fill="none"
          stroke="#f7a928"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {series.map((item, index) => {
          const [cx, cy] = pointAt(values[index], index);
          return (
            <circle key={item.id || index} cx={cx} cy={cy} r="3.5" fill="#fff" stroke="#f7a928" strokeWidth="2" />
          );
        })}
      </svg>

      <div className="absolute bottom-2 left-3 right-3 flex justify-between text-[10px] text-slate-400 mono">
        <span>{series[0].label}</span>
        <span>{series[series.length - 1].label}</span>
      </div>

      <div className="absolute top-3 left-3 flex gap-4 text-[11px] font-medium">
        <span className="flex items-center gap-1.5">
          <i className="w-2 h-2 rounded-full bg-[#f7a928]" />
          Mesure · {unit}
        </span>
        <span className="flex items-center gap-1.5 text-slate-500">
          <i className="w-2 h-0.5 border-t border-dashed border-[#3f79bd]" />
          Référence historique · {average.toFixed(1)} {unit}
        </span>
      </div>
    </div>
  );
}
