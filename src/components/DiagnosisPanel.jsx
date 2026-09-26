import Icon from "./Icon.jsx";
import Status from "./Status.jsx";
import { format, formatDateTime } from "../lib/format.js";

/**
 * Panneau de diagnostic.
 *
 * Il remplace l'ancien encart qui affichait un « score de confiance 97,3 % »
 * code en dur et une phrase « Analyse des six dernieres mesures » jamais
 * verifiee. Ici tout vient de la ligne panel_diagnostics reellement produite
 * par le service d'inference.
 *
 * Le bandeau de degradation est la piece la plus importante : c'est lui qui
 * empeche la confiance softmax elevee de tromper. Sur ce site, le modele
 * repond « 3M, 100 % » sur un vecteur entierement hors domaine ; sans ce
 * bandeau, l'interface presenterait cette reponse comme un fait etabli.
 */
export default function DiagnosisPanel({ diagnosis, stats }) {
  const toneClass = diagnosis.tone === "good" ? "good" : diagnosis.tone === "bad" ? "bad" : "warn";
  const statusLabel =
    diagnosis.tone === "good" ? "Normal" : diagnosis.tone === "bad" ? "Défaut confirmé" : "À vérifier";

  return (
    <aside className="card p-5">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-xs uppercase tracking-wider font-semibold text-slate-400">Diagnostic ML</p>
          <h3 className="text-xl font-bold mt-1">Santé du panneau</h3>
        </div>
        <div className="w-9 h-9 rounded-lg bg-[#e5f5ee] text-[#17856a] flex items-center justify-center">
          <Icon name="model" />
        </div>
      </div>

      <div className="mt-5 border border-slate-100 rounded-lg p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold">{diagnosis.headline}</span>
          <Status tone={toneClass}>{statusLabel}</Status>
        </div>
        <p className="text-xs text-slate-500 mt-3 leading-relaxed">{diagnosis.detail}</p>

        {diagnosis.faultCode && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="mono bg-slate-100 rounded px-2 py-1">{diagnosis.faultCode}</span>
            {diagnosis.severity && (
              <span className="mono bg-slate-100 rounded px-2 py-1">gravité {diagnosis.severity}</span>
            )}
            {diagnosis.action && <span className="text-slate-500">{diagnosis.action}</span>}
          </div>
        )}
      </div>

      {diagnosis.degraded && diagnosis.reasons?.length > 0 && (
        <div className="mt-3 notice warn">
          <strong className="block mb-1">Diagnostic dégradé</strong>
          <ul className="list-disc pl-4 space-y-0.5">
            {diagnosis.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {diagnosis.oodFeatures?.length > 0 && (
            <p className="mt-2">
              Features hors de la plage d'entraînement du modèle :{" "}
              <span className="mono">{diagnosis.oodFeatures.join(", ")}</span>. La calibration les
              ramène dans les bornes numériques, ce qui rend le calcul reproductible mais ne
              rend pas le modèle valide sur ces valeurs.
            </p>
          )}
        </div>
      )}

      <Completeness diagnosis={diagnosis} />

      <div className="mt-4 space-y-2 text-xs">
        <Row label="Puissance moyenne historique" value={stats?.averagePower} unit="W" digits={0} />
        <Row label="Tension moyenne historique" value={stats?.averageVoltage} unit="V" digits={0} />
        <Row label="Température moyenne" value={stats?.averageTemp} unit="°C" digits={1} />
      </div>

      <div className="mt-4 pt-4 border-t border-slate-100 space-y-1.5 text-[11px] text-slate-500">
        <div className="flex justify-between gap-3">
          <span>Empreinte de configuration</span>
          <span className="mono truncate" title={diagnosis.configHash || ""}>
            {diagnosis.configHash ? diagnosis.configHash.slice(7, 19) : "--"}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span>Modèle</span>
          <span className="mono truncate" title={diagnosis.modelVersion || ""}>
            {diagnosis.modelVersion || "--"}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span>Produit le</span>
          <span className="mono">{formatDateTime(diagnosis.createdAt)}</span>
        </div>
      </div>
    </aside>
  );
}

function Row({ label, value, unit, digits }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-500">{label}</span>
      <strong className="mono">
        {Number.isFinite(value) ? format(value, digits) : "--"} {unit}
      </strong>
    </div>
  );
}

/**
 * « 2 mesurees · 8 derivees · 3 figees ».
 *
 * On n'affiche PAS un simple pourcentage de completude : il laisserait croire
 * que 11/13 est presque complet. Une valeur derivee depend d'une mesure reelle
 * mais reste une reconstruction ; une constante est un choix de configuration.
 * Les confondre surestimerait la qualite du diagnostic.
 */
function Completeness({ diagnosis }) {
  const measured = diagnosis.measuredCount;
  const derived = diagnosis.derivedCount;
  const constant = diagnosis.constantCount;

  if (measured === undefined) return null;
  const total = measured + derived + constant;

  return (
    <div className="mt-3 border border-slate-100 rounded-lg p-3">
      <div className="flex justify-between text-[11px] text-slate-500">
        <span>Complétude des données d'entrée</span>
        <span className="mono">
          {measured}/{total}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        <Cell value={measured} label="mesurées" tone="text-[#17856a]" />
        <Cell value={derived} label="dérivées" tone="text-[#3f79bd]" />
        <Cell value={constant} label="figées" tone="text-slate-500" />
      </div>
      <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
        Seules les features mesurées portent une information indépendante. Les dérivées suivent
        l'installation, les figées sont des choix de configuration.
      </p>
    </div>
  );
}

function Cell({ value, label, tone }) {
  return (
    <div className="bg-slate-50 rounded py-2">
      <div className={`mono text-base font-bold ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  );
}
