import { useState } from "react";
import Icon from "./Icon.jsx";
import Status from "./Status.jsx";
import {
  saveRow,
  updateRow,
  deleteFeatureOverride,
} from "../lib/supabase.js";
import { format } from "../lib/format.js";
import {
  FORMULAS,
  SOURCE_KEYS,
  MODES,
  MODE_LABELS,
  SEVERITIES,
  isUndocumented,
} from "../lib/model-config.js";

const SQRT2 = Math.SQRT2;
const SQRT3 = Math.sqrt(3);

/* -------------------------------------------------------------------------- */
/* Reproduction fidele de features.py::site_base()                             */
/* -------------------------------------------------------------------------- */
/*
 * Cette fonction existe en double (Python + JS) et c'est assume : le service
 * Python a besoin de la valeur pour CALCULER, l'interface a besoin de la
 * justification pour l'AFFICHER. La dupliquer coute moins cher que de faire
 * un aller-retour reseau a chaque frappe.
 *
 * Le risque est la divergence. Il est borne par le fait que `selftest.py`
 * verifie cote Python que ces deux conventions donnent le meme scale avec les
 * nominales par defaut (voir la section 3 de l'autotest).
 *
 * Toute modification ici doit etre repercutee dans inference/features.py.
 */
function siteBase(kind, site) {
  const num = (value) => (value === null || value === undefined || value === "" ? null : Number(value));
  const vLl = num(site.nominal_voltage_v);
  const iDc = num(site.nominal_current_a);

  switch (kind) {
    case "dc_voltage":
      return vLl === null
        ? null
        : { value: vLl, why: `tension nominale du site ${format(vLl, 0)} V` };

    case "dc_current":
      return iDc === null
        ? null
        : { value: iDc, why: `courant nominal du site ${format(iDc, 0)} A` };

    case "frequency": {
      const f = num(site.nominal_frequency_hz);
      return f === null ? null : { value: f, why: `fréquence nominale ${format(f, 0)} Hz` };
    }

    case "ac_voltage_peak": {
      if (vLl === null) return null;
      const peak = (vLl * SQRT2) / SQRT3;
      return {
        value: peak,
        why: `crête de phase ${format(peak, 1)} V (composé ${format(vLl, 0)} V ÷ √3 × √2)`,
      };
    }

    case "ac_current_peak": {
      const eff = num(site.efficiency);
      const pf = num(site.power_factor);
      if (vLl === null || iDc === null || eff === null || pf === null) return null;
      const powerDc = vLl * iDc;
      const peak = (powerDc * eff * SQRT2) / (SQRT3 * vLl * pf);
      return {
        value: peak,
        why:
          `courant de crête ${format(peak, 2)} A ` +
          `(${format(powerDc, 0)} W DC, rendement ${format(eff, 2)}, cos φ ${format(pf, 2)})`,
      };
    }

    case "excitation_current":
      // Aucune contrepartie reelle sur ce site : on apparie la base du modele a
      // celle du courant disponible, ce qui revient a ne pas deformer l'echelle.
      return iDc === null
        ? null
        : {
            value: iDc,
            why: `courant nominal du site ${format(iDc, 0)} A (pas de contrepartie réelle)`,
          };

    default:
      return null;
  }
}

const modelBaseOf = (feature) => (Number(feature.train_max) - Number(feature.train_min)) / 2;

/**
 * Reproduit features.py::compute_scale(). Precedence :
 * surcharge manuelle > calcul depuis les nominales > default_scale du referentiel.
 */
function effectiveScale(feature, site, override) {
  if (feature.mode === "constant") {
    return { value: 1, why: "mode constante : valeur déjà en unités du modèle", manual: false };
  }
  if (override?.scale !== null && override?.scale !== undefined && override?.scale !== "") {
    return { value: Number(override.scale), why: "valeur fixée manuellement pour cette installation", manual: true };
  }
  const base = siteBase(feature.site_base_kind, site);
  if (base && base.value) {
    const modelBase = modelBaseOf(feature);
    return {
      value: modelBase / base.value,
      why: `base modèle ${format(modelBase, 2)} / ${base.why}`,
      manual: false,
    };
  }
  const fallback = feature.default_scale;
  return {
    value: Number(fallback ?? 1),
    why: "échelle par défaut du référentiel (nominales du site indisponibles)",
    manual: false,
  };
}

/** Applique mode/source/formule/constante de la surcharge, sinon du referentiel. */
function effectiveFeature(feature, override) {
  const pick = (field, fallback) => {
    const v = override?.[field];
    return v === null || v === undefined || v === "" ? fallback : v;
  };
  return {
    ...feature,
    mode: pick("mode", feature.default_mode),
    source_key: pick("source_key", feature.default_source_key),
    formula: pick("formula", feature.default_formula),
    constant_value: pick("constant_value", feature.default_constant_value),
    // La colonne s'appelle `scale_offset` en base : `offset` est un mot reserve
    // en PostgreSQL. On garde `offset` comme nom de champ interne.
    offset: override?.scale_offset ?? feature.default_offset ?? 0,
    _override: override || null,
  };
}

/* -------------------------------------------------------------------------- */

export default function SettingsPanel({ deviceId, settings, features, faults, overrides, onReload }) {
  const [site, setSite] = useState(() => ({ ...settings }));
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  const overrideByName = Object.fromEntries((overrides || []).map((row) => [row.feature_name, row]));
  const resolved = features.map((feature) => effectiveFeature(feature, overrideByName[feature.feature_name]));

  const counts = resolved.reduce(
    (acc, feature) => {
      acc[feature.mode] = (acc[feature.mode] || 0) + 1;
      return acc;
    },
    { measured: 0, derived: 0, constant: 0 },
  );

  async function run(key, work) {
    setBusy(key);
    setNotice(null);
    try {
      await work();
      setNotice({ tone: "good", text: "Enregistré." });
    } catch (error) {
      setNotice({ tone: "bad", text: error.message });
    } finally {
      setBusy(null);
    }
  }

  const setSiteField = (field, value) => setSite((prev) => ({ ...prev, [field]: value }));

  const draftOf = (name, feature) =>
    drafts[name] ?? {
      mode: feature.mode,
      source_key: feature.source_key ?? SOURCE_KEYS[0],
      formula: feature.formula ?? FORMULAS[0],
      constant_value: feature.constant_value ?? 0,
      scale: feature._override?.scale ?? "",
      offset: feature.offset ?? 0,
    };

  const setDraft = (name, feature, patch) =>
    setDrafts((prev) => ({ ...prev, [name]: { ...draftOf(name, feature), ...patch } }));

  return (
    <div className="space-y-5">
      {notice && <div className={`notice ${notice.tone}`}>{notice.text}</div>}

      <SiteCard
        deviceId={deviceId}
        site={site}
        setField={setSiteField}
        busy={busy}
        onSave={() => run("site", () => saveRow("device_settings", rowFromSite(deviceId, site), "device_id"))}
      />

      <ThresholdsCard
        site={site}
        setField={setSiteField}
        busy={busy}
        onSave={() => run("seuils", () => saveRow("device_settings", rowFromSite(deviceId, site), "device_id"))}
      />

      <FeaturesCard
        resolved={resolved}
        counts={counts}
        site={site}
        busy={busy}
        draftOf={draftOf}
        setDraft={setDraft}
        onPin={(feature) =>
          run(`pin:${feature.feature_name}`, async () => {
            const draft = draftOf(feature.feature_name, feature);
            await saveRow(
              "device_feature_config",
              {
                device_id: deviceId,
                feature_name: feature.feature_name,
                mode: draft.mode,
                source_key: draft.mode === "measured" ? draft.source_key : null,
                formula: draft.mode === "derived" ? draft.formula : null,
                constant_value: draft.mode === "constant" ? Number(draft.constant_value) : null,
                // scale vide => NULL => le service recalcule depuis les nominales.
                scale: draft.mode === "constant" || draft.scale === "" ? null : Number(draft.scale),
                scale_offset: draft.offset === "" ? null : Number(draft.offset),
              },
              "device_id,feature_name",
            );
            setDrafts((prev) => {
              const next = { ...prev };
              delete next[feature.feature_name];
              return next;
            });
            await onReload?.();
          })
        }
        onReset={(feature) =>
          run(`reset:${feature.feature_name}`, async () => {
            await deleteFeatureOverride(deviceId, feature.feature_name);
            setDrafts((prev) => {
              const next = { ...prev };
              delete next[feature.feature_name];
              return next;
            });
            await onReload?.();
          })
        }
      />

      <FaultCard
        faults={faults}
        busy={busy}
        onSave={(code, patch) =>
          run(`fault:${code}`, () => updateRow("fault_catalog", "fault_code", code, patch))
        }
      />
    </div>
  );
}

function rowFromSite(deviceId, site) {
  const num = (value) => (value === "" || value === null || value === undefined ? null : Number(value));
  return {
    device_id: deviceId,
    nominal_voltage_v: num(site.nominal_voltage_v),
    nominal_current_a: num(site.nominal_current_a),
    nominal_frequency_hz: num(site.nominal_frequency_hz),
    efficiency: num(site.efficiency),
    power_factor: num(site.power_factor),
    conf_min: num(site.conf_min),
    stale_after_minutes: num(site.stale_after_minutes),
  };
}

/* -------------------------------------------------------------------------- */

function Section({ title, hint, icon, children, action }) {
  return (
    <section className="card p-5">
      <div className="flex justify-between items-start gap-4">
        <div className="flex gap-3">
          <div className="metric-icon slate">
            <Icon name={icon} />
          </div>
          <div>
            <h3 className="text-lg font-bold">{title}</h3>
            {hint && <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">{hint}</p>}
          </div>
        </div>
        {action}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function SaveButton({ onClick, busy, children = "Enregistrer" }) {
  return (
    <button type="button" className="btn" onClick={onClick} disabled={busy}>
      {busy ? "…" : children}
    </button>
  );
}

function SiteCard({ site, setField, busy, onSave }) {
  return (
    <Section
      title="Caractéristiques du site"
      icon="bolt"
      hint="Ces valeurs sont la source du calibrage : le service en déduit le facteur qui ramène les mesures du site dans les unités du modèle. Modifie-les ici plutôt que de retoucher chaque échelle une par une."
      action={<SaveButton onClick={onSave} busy={busy === "site"} />}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Tension nominale" hint="V — tension DC du champ ou composée AC">
          <input
            type="number"
            className="input"
            value={site.nominal_voltage_v ?? ""}
            onChange={(e) => setField("nominal_voltage_v", e.target.value)}
          />
        </Field>
        <Field label="Courant nominal" hint="A — courant DC nominal">
          <input
            type="number"
            className="input"
            value={site.nominal_current_a ?? ""}
            onChange={(e) => setField("nominal_current_a", e.target.value)}
          />
        </Field>
        <Field label="Fréquence nominale" hint="Hz">
          <input
            type="number"
            className="input"
            value={site.nominal_frequency_hz ?? ""}
            onChange={(e) => setField("nominal_frequency_hz", e.target.value)}
          />
        </Field>
        <Field label="Rendement onduleur" hint="0 à 1 — déplace aussi ia, ib, ic et Iabc">
          <input
            type="number"
            step="0.01"
            className="input"
            value={site.efficiency ?? ""}
            onChange={(e) => setField("efficiency", e.target.value)}
          />
        </Field>
        <Field label="Facteur de puissance" hint="0 à 1 — cos φ">
          <input
            type="number"
            step="0.01"
            className="input"
            value={site.power_factor ?? ""}
            onChange={(e) => setField("power_factor", e.target.value)}
          />
        </Field>
      </div>
    </Section>
  );
}

function ThresholdsCard({ site, setField, busy, onSave }) {
  return (
    <Section
      title="Seuils de diagnostic"
      icon="model"
      hint="Ces deux seuils ne changent pas la prédiction du modèle : ils décident quand le service refuse de la publier telle quelle et écrit un avertissement à la place."
      action={<SaveButton onClick={onSave} busy={busy === "seuils"} />}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Confiance minimale"
          hint="0 à 1 — en dessous, le diagnostic passe en avertissement. Défaut : 0,55"
        >
          <input
            type="number"
            step="0.01"
            className="input"
            value={site.conf_min ?? ""}
            onChange={(e) => setField("conf_min", e.target.value)}
          />
        </Field>
        <Field
          label="Âge maximal d'une mesure"
          hint="minutes — au-delà, la mesure est considérée périmée. Défaut : 30"
        >
          <input
            type="number"
            className="input"
            value={site.stale_after_minutes ?? ""}
            onChange={(e) => setField("stale_after_minutes", e.target.value)}
          />
        </Field>
      </div>
    </Section>
  );
}

function FeaturesCard({ resolved, counts, site, busy, draftOf, setDraft, onPin, onReset }) {
  return (
    <Section
      title="Les 13 entrées du modèle"
      icon="database"
      hint="Le capteur n'en fournit que deux. Les autres sont soit reconstruites à partir des mesures (dérivées), soit fixées à une valeur de configuration (figées). Chaque ligne indique laquelle des trois, et pourquoi."
      action={
        <div className="flex gap-2 text-[11px]">
          <span className="chip good">{counts.measured} mesurées</span>
          <span className="chip info">{counts.derived} dérivées</span>
          <span className="chip">{counts.constant} figées</span>
        </div>
      }
    >
      <div className="space-y-3">
        {resolved.map((feature) => (
          <FeatureRow
            key={feature.feature_name}
            feature={feature}
            site={site}
            draft={draftOf(feature.feature_name, feature)}
            setDraft={(patch) => setDraft(feature.feature_name, feature, patch)}
            busy={busy}
            onPin={() => onPin(feature)}
            onReset={() => onReset(feature)}
          />
        ))}
      </div>
    </Section>
  );
}

function FeatureRow({ feature, site, draft, setDraft, busy, onPin, onReset }) {
  const pinned = Boolean(feature._override);
  const scale = effectiveScale({ ...feature, mode: draft.mode }, site, pinned ? feature._override : null);
  const modelBase = modelBaseOf(feature);

  return (
    <article className={`rounded-lg border p-3 ${pinned ? "border-[#f0d9a8] bg-[#fffaf0]" : "border-slate-200"}`}>
      <div className="flex justify-between items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="mono text-sm font-bold">{feature.feature_name}</span>
            <span className="mono text-[10px] text-slate-400">#{feature.position}</span>
            {pinned && <Status tone="warn">personnalisée</Status>}
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">{feature.description_fr}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] uppercase tracking-wide text-slate-400">Bornes modèle</p>
          <p className="mono text-[11px]">
            {format(feature.train_min, 2)} … {format(feature.train_max, 2)} {feature.unit}
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[120px_1fr_150px]">
        <Field label="Mode">
          <select className="input" value={draft.mode} onChange={(e) => setDraft({ mode: e.target.value })}>
            {MODES.map((mode) => (
              <option key={mode} value={mode}>
                {MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Source">
          {draft.mode === "measured" && (
            <select
              className="input"
              value={draft.source_key}
              onChange={(e) => setDraft({ source_key: e.target.value })}
            >
              {SOURCE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          )}
          {draft.mode === "derived" && (
            <select className="input" value={draft.formula} onChange={(e) => setDraft({ formula: e.target.value })}>
              {FORMULAS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {draft.mode === "constant" && (
            <input
              type="number"
              step="any"
              className="input"
              value={draft.constant_value}
              onChange={(e) => setDraft({ constant_value: e.target.value })}
            />
          )}
        </Field>

        <Field label="Échelle">
          <input
            type="number"
            step="any"
            className="input"
            placeholder={scale.value.toFixed(4)}
            value={draft.scale}
            disabled={draft.mode === "constant"}
            onChange={(e) => setDraft({ scale: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-2 flex justify-between items-end gap-3">
        <p className="text-[11px] text-slate-500 leading-relaxed">
          {draft.mode === "constant" ? (
            <>Valeur écrite directement en unités du modèle, sans mise à l&apos;échelle.</>
          ) : draft.scale !== "" ? (
            <>
              Échelle forcée à <span className="mono">{Number(draft.scale).toFixed(4)}</span>. Laisser
              vide pour laisser le service la recalculer.
            </>
          ) : (
            <>
              {/* `scale.why` contient deja « base modèle X / ... » (meme
                  convention que compute_scale cote Python) : ne pas le
                  repeter ici, sinon la phrase dit deux fois la meme chose. */}
              Échelle calculée : <span className="mono">{scale.value.toFixed(4)}</span> = {scale.why}
            </>
          )}
        </p>
        <div className="flex gap-2 shrink-0">
          <button type="button" className="btn btn-ghost" onClick={onPin} disabled={busy === `pin:${feature.feature_name}`}>
            {pinned ? "Mettre à jour" : "Personnaliser"}
          </button>
          {pinned && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onReset}
              disabled={busy === `reset:${feature.feature_name}`}
            >
              Défaut global
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function FaultCard({ faults, busy, onSave }) {
  return (
    <Section
      title="Catalogue de pannes"
      icon="model"
      hint="Le modèle distingue 16 étiquettes, mais le projet ne documente aucune des pannes F1 à F7. Tant qu'un libellé porte la mention « à documenter », le service refuse de publier le diagnostic et écrit un avertissement : c'est volontaire, pour qu'une prédiction sans signification connue ne soit jamais présentée comme un résultat."
      action={
        <span className="chip warn">
          {faults.filter((f) => isUndocumented(f.label_fr)).length} à documenter
        </span>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-400 text-left">
              <th className="pb-2 font-semibold">Code</th>
              <th className="pb-2 font-semibold">Libellé</th>
              <th className="pb-2 font-semibold">Gravité</th>
              <th className="pb-2 font-semibold">Action recommandée</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {faults.map((fault) => (
              <FaultRow key={fault.fault_code} fault={fault} busy={busy} onSave={onSave} />
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function FaultRow({ fault, busy, onSave }) {
  const [draft, setDraft] = useState({
    label_fr: fault.label_fr ?? "",
    severity: fault.severity ?? "",
    action_fr: fault.action_fr ?? "",
  });

  const dirty =
    draft.label_fr !== (fault.label_fr ?? "") ||
    draft.severity !== (fault.severity ?? "") ||
    draft.action_fr !== (fault.action_fr ?? "");

  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="py-2 pr-3">
        <span className="mono text-xs font-bold">{fault.fault_code}</span>
        {fault.is_healthy && (
          <div className="mt-1">
            <Status tone="good">sain</Status>
          </div>
        )}
      </td>
      <td className="py-2 pr-3">
        <input
          className="input"
          value={draft.label_fr}
          onChange={(e) => setDraft((prev) => ({ ...prev, label_fr: e.target.value }))}
        />
      </td>
      <td className="py-2 pr-3">
        <select
          className="input"
          value={draft.severity}
          onChange={(e) => setDraft((prev) => ({ ...prev, severity: e.target.value }))}
        >
          <option value="">non renseignée</option>
          {SEVERITIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </td>
      <td className="py-2 pr-3">
        <input
          className="input"
          value={draft.action_fr}
          onChange={(e) => setDraft((prev) => ({ ...prev, action_fr: e.target.value }))}
        />
      </td>
      <td className="py-2 text-right">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!dirty || busy === `fault:${fault.fault_code}`}
          onClick={() =>
            onSave(fault.fault_code, {
              label_fr: draft.label_fr,
              severity: draft.severity === "" ? null : draft.severity,
              action_fr: draft.action_fr,
            })
          }
        >
          {dirty ? "Enregistrer" : "À jour"}
        </button>
      </td>
    </tr>
  );
}
