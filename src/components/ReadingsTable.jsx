import Status from "./Status.jsx";
import { format, metricValue, formatDateTime } from "../lib/format.js";

/**
 * Tableau « Dernieres comparaisons ».
 *
 * Corrige un bug de l'ancien dashboard (code.html:640) :
 *
 *     const reference = index === 0 ? averagePower : averagePower;
 *
 * Les deux branches du ternaire sont identiques : la condition ne servait a
 * rien, et la colonne « ecart » comparait chaque mesure a la moyenne de la
 * periode sans jamais le dire. Ici l'ecart est calcule contre la moyenne
 * affichee en en-tete, et la ligne courante (la plus recente) est mise en
 * avant parce que c'est celle qui alimente le diagnostic.
 */
export default function ReadingsTable({ readings, averagePower }) {
  if (!readings.length) {
    return (
      <section className="card p-5">
        <Header count={0} />
        <div className="mt-5 rounded-lg border border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">
          Aucune mesure sur la période sélectionnée.
        </div>
      </section>
    );
  }

  return (
    <section className="card p-5">
      <Header count={readings.length} averagePower={averagePower} />
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-400">
              <th className="text-left font-semibold pb-2">Horodatage</th>
              <th className="text-right font-semibold pb-2">Tension</th>
              <th className="text-right font-semibold pb-2">Courant</th>
              <th className="text-right font-semibold pb-2">Puissance</th>
              <th className="text-right font-semibold pb-2">Écart</th>
              <th className="text-right font-semibold pb-2">État</th>
            </tr>
          </thead>
          <tbody>
            {readings.slice(0, 12).map((reading, index) => {
              // L'ecart n'a de sens que si la moyenne est connue et non nulle.
              const hasReference = Number.isFinite(averagePower) && averagePower > 0;
              const delta = hasReference ? (reading.power - averagePower) / averagePower : null;
              const isCurrent = index === 0;

              return (
                <tr
                  key={reading.id || index}
                  className={`border-t border-slate-100 ${isCurrent ? "bg-[#fffaf0]" : ""}`}
                >
                  <td className="py-2.5">
                    <span className="mono text-xs">{formatDateTime(reading.created_at)}</span>
                    {isCurrent && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-[#c98a1f] font-semibold">
                        courante
                      </span>
                    )}
                  </td>
                  <td className="text-right mono">{metricValue(reading.voltage)} V</td>
                  <td className="text-right mono">{metricValue(reading.current, 2)} A</td>
                  <td className="text-right mono font-semibold">{metricValue(reading.power)} W</td>
                  <td className="text-right mono">
                    {delta === null ? (
                      "--"
                    ) : (
                      <span className={delta < 0 ? "text-[#c0453f]" : "text-[#17856a]"}>
                        {delta > 0 ? "+" : ""}
                        {format(delta * 100, 0)} %
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    <Status tone={reading.temperature >= 60 ? "warn" : "good"}>
                      {reading.temperature >= 60 ? "Chaud" : "OK"}
                    </Status>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {readings.length > 12 && (
        <p className="mt-3 text-[11px] text-slate-400">
          Les 12 mesures les plus récentes sur {readings.length} sur la période.
        </p>
      )}
    </section>
  );
}

function Header({ count, averagePower }) {
  return (
    <div className="flex justify-between items-start gap-4">
      <div>
        <p className="text-xs uppercase tracking-wider font-semibold text-slate-400">
          Contrôle qualité
        </p>
        <h3 className="text-xl font-bold mt-1">Dernières comparaisons</h3>
      </div>
      <div className="text-right">
        <p className="text-[11px] uppercase tracking-wide text-slate-400">Référence période</p>
        <p className="mono text-sm font-bold">
          {Number.isFinite(averagePower) ? `${format(averagePower)} W` : "--"}
        </p>
        <p className="text-[11px] text-slate-400">{count} mesure{count > 1 ? "s" : ""}</p>
      </div>
    </div>
  );
}
