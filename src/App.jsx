import { useCallback, useEffect, useMemo, useState } from "react";
import MetricCard from "./components/MetricCard.jsx";
import Icon from "./components/Icon.jsx";
import Status from "./components/Status.jsx";
import TelemetryChart, { METRIC_OPTIONS } from "./components/TelemetryChart.jsx";
import DiagnosisPanel from "./components/DiagnosisPanel.jsx";
import ReadingsTable from "./components/ReadingsTable.jsx";
import SettingsPanel from "./components/SettingsPanel.jsx";
import LoginScreen from "./components/LoginScreen.jsx";
import { metricValue, periodStartIso, normalizeReading } from "./lib/format.js";
import { describeDiagnosis, localDiagnosis } from "./lib/diagnosis.js";
import { signIn, signOut, getSession, onAuthChange } from "./lib/auth.js";
import {
  isConfigured,
  fetchDevices,
  fetchReadings,
  fetchLatestDiagnosis,
  fetchFeatureCatalog,
  fetchFaultCatalog,
  fetchDeviceSettings,
  fetchFeatureOverrides,
} from "./lib/supabase.js";

const PERIODS = ["24h", "7j", "30j"];

const TABS = { overview: "Vue d'ensemble", settings: "Paramètres" };

/**
 * Onglet courant deduit de l'ancre d'URL (#parametres).
 *
 * La cle d'onglet est `settings` mais l'ancre est `parametres` : les deux
 * doivent rester accordees avec setTab(), sinon le lien ne fait rien.
 */
function tabFromHash() {
  return window.location.hash.replace("#", "") === "parametres" ? "settings" : "overview";
}

/** Ratio -> pourcentage borne pour les barres de progression des cartes. */
function bar(ratio) {
  return Number.isFinite(ratio) ? Math.max(0, Math.min(100, Math.round(ratio * 100))) : undefined;
}

/**
 * Porte d'entree de l'application : elle ne rend le dashboard qu'une fois la
 * session connue et valide.
 *
 * Le dashboard est un composant distinct, et pas une simple condition dans le
 * meme composant, pour une raison precise : ses effets de chargement partent au
 * montage. Les garder ici les ferait tirer les donnees avant toute connexion —
 * inoffensif tant que les policies sont ouvertes, faux des qu'elles seront
 * resserrees, et dans les deux cas gaspilleur. Les demonter fait aussi
 * disparaitre de la memoire les donnees du compte precedent a la deconnexion.
 */
export default function App() {
  // Trois etats distincts : `undefined` = on ne sait pas encore, `null` =
  // deconnecte, objet = connecte. Ecraser `undefined` et `null` ferait
  // clignoter l'ecran de connexion a chaque rechargement de page.
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    let cancelled = false;

    // Deux sources pour la meme information, et la premiere qui repond gagne.
    // getSession() lit le jeton local immediatement ; onAuthStateChange émet
    // INITIAL_SESSION juste apres. Se reposer sur le seul abonnement
    // laisserait l'ecran de chargement bloque si l'evenement n'arrivait pas.
    getSession().then((current) => {
      if (!cancelled) setSession((prev) => (prev === undefined ? current : prev));
    });

    const unsubscribe = onAuthChange((_event, next) => {
      if (!cancelled) setSession(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const handleSignIn = useCallback((username, password) => signIn(username, password), []);

  const handleSignOut = useCallback(async () => {
    try {
      await signOut();
    } catch {
      // Si la revocation cote serveur echoue, on verrouille quand meme
      // l'ecran : laisser l'utilisateur devant un dashboard qu'il a demande a
      // quitter serait pire que de lui faire reessayer.
      setSession(null);
    }
  }, []);

  if (session === undefined) {
    return (
      <div className="min-h-screen grid place-items-center">
        <p className="text-xs text-slate-400">Vérification de la session…</p>
      </div>
    );
  }

  if (!session) {
    return <LoginScreen onSubmit={handleSignIn} />;
  }

  return <Dashboard session={session} onSignOut={handleSignOut} />;
}

function Dashboard({ session, onSignOut }) {
  const [tab, setTabState] = useState(tabFromHash);

  // L'onglet est reflete dans l'URL : le lien est partageable et le bouton
  // « precedent » du navigateur fonctionne.
  const setTab = useCallback((next) => {
    setTabState(next);
    window.location.hash = next === "settings" ? "parametres" : "";
  }, []);

  useEffect(() => {
    const onHashChange = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [period, setPeriod] = useState("24h");
  const [metric, setMetric] = useState(METRIC_OPTIONS[0]);
  const [readings, setReadings] = useState([]);
  const [diagnosisRow, setDiagnosisRow] = useState(null);
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState({ state: "loading", error: null });
  const [refreshing, setRefreshing] = useState(false);
  // Erreur propre a l'onglet Parametres. Elle est separee de `status` parce
  // qu'une table de configuration absente ne doit pas rendre la vue d'ensemble
  // inutilisable : c'est l'etat normal tant que la migration n'a pas ete jouee.
  const [configError, setConfigError] = useState(null);

  const device = devices.find((item) => item.id === deviceId) || null;

  const loadReadings = useCallback(async (id, currentPeriod) => {
    if (!id) return;
    const rows = await fetchReadings(id, periodStartIso(currentPeriod));
    setReadings(rows.map(normalizeReading));
  }, []);

  const loadDiagnosis = useCallback(async (id) => {
    if (!id) return;
    setDiagnosisRow(await fetchLatestDiagnosis(id));
  }, []);

  const loadConfig = useCallback(async (id) => {
    if (!id) return;
    const [features, faults, settings, overrides] = await Promise.all([
      fetchFeatureCatalog(),
      fetchFaultCatalog(),
      fetchDeviceSettings(id),
      fetchFeatureOverrides(id),
    ]);
    setConfig({ features, faults, settings: settings || {}, overrides });
  }, []);

  // Chargement initial : appareils puis diagnostic du premier.
  useEffect(() => {
    if (!isConfigured) {
      setStatus({ state: "error", error: "config.js est absent ou incomplet : url et cle anon requises." });
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const list = await fetchDevices();
        if (cancelled) return;
        setDevices(list);
        if (!list.length) {
          setStatus({ state: "empty", error: null });
          return;
        }
        setDeviceId(list[0].id);
        setStatus({ state: "ready", error: null });
      } catch (error) {
        if (!cancelled) setStatus({ state: "error", error: error.message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Rechargement a chaque changement d'appareil ou de periode.
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    setStatus((prev) => ({ ...prev, state: prev.state === "ready" ? "ready" : "loading" }));

    (async () => {
      try {
        await Promise.all([loadReadings(deviceId, period), loadDiagnosis(deviceId)]);
      } catch (error) {
        if (!cancelled) setStatus({ state: "error", error: error.message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [deviceId, period, loadReadings, loadDiagnosis]);

  useEffect(() => {
    if (tab !== "settings" || !deviceId) return;
    setConfigError(null);
    loadConfig(deviceId).catch((error) => setConfigError(error.message));
  }, [tab, deviceId, loadConfig]);

  /**
   * Rafraichissement manuel. L'ancien dashboard avait ce bouton (code.html:441)
   * avec un indicateur de rotation ; il a ete conserve ici parce que le capteur
   * pousse toutes les 60 s et qu'attendre le rechargement de la page est penible
   * pendant la mise au point.
   */
  const refresh = useCallback(async () => {
    if (!deviceId) return;
    setRefreshing(true);
    try {
      await Promise.all([loadReadings(deviceId, period), loadDiagnosis(deviceId)]);
      setStatus((prev) => (prev.state === "error" ? { state: "ready", error: null } : prev));
    } catch (error) {
      setStatus({ state: "error", error: error.message });
    } finally {
      setRefreshing(false);
    }
    // La config a son propre canal d'erreur : un echec ici ne doit pas
    // effacer la vue d'ensemble.
    if (tab === "settings") {
      setConfigError(null);
      try {
        await loadConfig(deviceId);
      } catch (error) {
        setConfigError(error.message);
      }
    }
  }, [deviceId, period, tab, loadReadings, loadDiagnosis, loadConfig]);

  const stats = useMemo(() => {
    if (!readings.length) return null;
    const history = readings.slice(0, 6);
    const mean = (key) => history.reduce((sum, row) => sum + row[key], 0) / history.length;
    const averagePower = mean("power");
    const capacity = Number(device?.capacity_kwc || 0) * 1000;
    return {
      averagePower,
      averageVoltage: mean("voltage"),
      averageTemp: mean("temperature"),
      current: readings[0],
      // Le ratio n'a de sens que si l'installation a une capacite connue.
      loadRatio: capacity > 0 ? Math.min(100, (averagePower / capacity) * 100) : null,
    };
  }, [readings, device]);

  const diagnosis = useMemo(() => {
    if (diagnosisRow) {
      return { ...describeDiagnosis(diagnosisRow), local: false };
    }
    // Repli explicite : le service d'inference n'a rien produit. On ne fait pas
    // passer une heuristique a seuils pour le modele.
    return { ...localDiagnosis(readings, device), local: true };
  }, [diagnosisRow, readings, device]);

  if (status.state === "error") {
    return (
      <Shell tab={tab} setTab={setTab} session={session} onSignOut={onSignOut}>
        <div className="notice bad">
          <strong className="block mb-1">Chargement impossible</strong>
          {status.error}
        </div>
      </Shell>
    );
  }

  if (status.state === "empty") {
    return (
      <Shell tab={tab} setTab={setTab} session={session} onSignOut={onSignOut}>
        <div className="notice info">
          <strong className="block mb-1">Aucune installation enregistrée</strong>
          La table <span className="mono">devices</span> ne contient aucune ligne active. Ajoute ton
          installation dans Supabase pour commencer.
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      tab={tab}
      setTab={setTab}
      device={device}
      devices={devices}
      setDeviceId={setDeviceId}
      onRefresh={refresh}
      refreshing={refreshing}
      session={session}
      onSignOut={onSignOut}
    >
      {tab === "overview" ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <MetricCard
              title="Puissance"
              value={metricValue(stats?.current.power)}
              unit="W"
              detail="P = U × I · actif"
              progress={stats?.loadRatio}
              icon="bolt"
              tone="sun"
            />
            <MetricCard
              title="Intensité"
              value={metricValue(stats?.current.current, 1)}
              unit="A"
              detail="Plage normale · 0–11,5 A"
              progress={bar(stats?.current.current / 11.5)}
              icon="wave"
            />
            <MetricCard
              title="Tension"
              value={metricValue(stats?.current.voltage)}
              unit="V"
              detail="Fenêtre MPPT · 360–420 V"
              progress={bar(stats?.current.voltage / 420)}
              icon="bolt"
              tone="blue"
            />
            <MetricCard
              title="Température"
              value={metricValue(stats?.current.temperature, 1)}
              unit="°C"
              detail="Seuil d'alerte · 65 °C"
              progress={bar(stats?.current.temperature / 65)}
              icon="temp"
              tone="rose"
            />
            <MetricCard
              title="Luminosité"
              value={metricValue(stats?.current.luminosity)}
              unit="%"
              detail="Irradiance estimée · ciel clair"
              progress={bar(stats?.current.luminosity / 100)}
              icon="sun"
            />
          </section>

          <section className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]">
            <div className="card p-5">
              <div className="flex justify-between items-start gap-4 flex-wrap">
                <div>
                  <p className="text-xs uppercase tracking-wider font-semibold text-slate-400">
                    Courbe
                  </p>
                  <h3 className="text-xl font-bold mt-1">{metric}</h3>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <select className="input w-auto" value={metric} onChange={(e) => setMetric(e.target.value)}>
                    {METRIC_OPTIONS.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <div className="segmented">
                    {PERIODS.map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={period === value ? "active" : ""}
                        onClick={() => setPeriod(value)}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <TelemetryChart data={readings} metric={metric} />
            </div>

            <DiagnosisPanel diagnosis={diagnosis} stats={stats} />
          </section>

          {diagnosis.local && (
            <div className="notice warn">
              <strong className="block mb-1">Diagnostic de repli</strong>
              Le service d'inference n'a produit aucun diagnostic pour cette installation. Ce qui
              est affiché ci-dessus provient de seuils locaux, pas du modèle.
            </div>
          )}

          <section className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]">
            <ReadingsTable readings={readings} averagePower={stats?.averagePower} />
            <DataConnectionCard
              readings={readings}
              diagnosisRow={diagnosisRow}
              deviceId={deviceId}
            />
          </section>
        </>
      ) : (
        <>
          {/*
            On ne rend le panneau que si la configuration a ete lue. Sinon il
            s'afficherait avec 0 feature et 0 panne, ce qui se lirait comme
            « catalogue vide » au lieu de « catalogue indisponible » — une
            confusion couteuse, puisqu'un catalogue vide est justement l'etat
            qui force le diagnostic en avertissement.
          */}
          {configError ? (
            <div className="notice bad">
              <strong className="block mb-1">Configuration indisponible</strong>
              {configError}
            </div>
          ) : config ? (
            <SettingsPanel
              deviceId={deviceId}
              settings={config.settings}
              features={config.features}
              faults={config.faults}
              overrides={config.overrides}
              onReload={() => loadConfig(deviceId)}
            />
          ) : (
            <div className="notice info">Chargement de la configuration…</div>
          )}
        </>
      )}
    </Shell>
  );
}

/**
 * Encart « Connexion données ».
 *
 * Reprend l'encart de code.html:676, mais en remplacant les trois pastilles
 * decoratives (« Connectée », « Actif », « 60 secondes ») par des etats
 * reellement observes. La version d'origine affichait « diagnostic historique
 * Actif » en dur, y compris quand aucun diagnostic n'existait.
 */
function DataConnectionCard({ readings, diagnosisRow, deviceId }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-3">
        <div className="metric-icon slate">
          <Icon name="database" />
        </div>
        <div>
          <h3 className="font-bold">Connexion données</h3>
          <p className="text-xs text-slate-500 mt-0.5">Architecture prête pour plusieurs sites</p>
        </div>
      </div>

      <div className="mt-5 space-y-3 text-sm">
        <div className="flex justify-between items-center">
          <span className="text-slate-500">sensor_readings</span>
          <Status tone={readings.length ? "good" : "warn"}>
            {readings.length ? `${readings.length} mesures` : "Aucune mesure"}
          </Status>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-slate-500">panel_diagnostics</span>
          <Status tone={diagnosisRow ? "good" : "warn"}>
            {diagnosisRow ? "Diagnostic disponible" : "En attente"}
          </Status>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-slate-500">Installation</span>
          <span className="mono text-xs">{deviceId ? `${deviceId.slice(0, 8)}…` : "--"}</span>
        </div>
      </div>

      <div className="mt-5 pt-4 border-t border-slate-100 text-xs text-slate-500 leading-relaxed">
        {diagnosisRow
          ? "Le service d'inférence a produit un diagnostic pour cette installation."
          : "Aucun diagnostic en base. Lance `python diagnose_panel.py` dans inference/, ou attends le prochain passage du cron."}
      </div>
    </div>
  );
}

function Shell({
  tab,
  setTab,
  device,
  devices,
  setDeviceId,
  onRefresh,
  refreshing,
  session,
  onSignOut,
  children,
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-[1280px] px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#f7a928] text-white grid place-items-center font-bold">
              H
            </div>
            <div>
              <p className="font-bold leading-tight">GEP MCI</p>
              <p className="text-[11px] text-slate-500 leading-tight">Monitoring solaire</p>
            </div>
          </div>

          <nav className="flex items-center gap-4 flex-wrap">
            {devices?.length > 1 && (
              <select
                className="input max-w-[220px]"
                value={device?.id || ""}
                onChange={(e) => setDeviceId(e.target.value)}
              >
                {devices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
            {device && devices?.length <= 1 && (
              <span className="text-sm text-slate-500 whitespace-nowrap">{device.name}</span>
            )}
            {onRefresh && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onRefresh}
                disabled={refreshing || !device}
                title="Rafraîchir les données"
              >
                <span className={refreshing ? "inline-block animate-spin" : ""}>
                  <Icon name="refresh" />
                </span>
                <span className="ml-2">Actualiser</span>
              </button>
            )}
            <div className="segmented">
              {Object.entries(TABS).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={tab === key ? "active" : ""}
                  onClick={() => setTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </nav>

          {/*
            Le compte est un frere du <nav>, pas un enfant : place dedans, il
            suivait les retours a la ligne de la barre d'onglets et se
            retrouvait seul sur une seconde ligne des que la place manquait.
            L'email est masque sur petit ecran plutot que tronque — « admin@he… »
            n'apprend rien.
          */}
          {onSignOut && (
            <div className="flex items-center gap-2 md:pl-4 md:border-l md:border-slate-200">
              <span
                className="text-xs text-slate-500 whitespace-nowrap hidden lg:inline"
                title={session?.user?.email || ""}
              >
                {session?.user?.email}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onSignOut}
                title={session?.user?.email ? `Se déconnecter (${session.user.email})` : "Se déconnecter"}
                aria-label="Se déconnecter"
              >
                <Icon name="logout" />
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[1280px] px-6 py-6 space-y-5">{children}</main>

      <footer className="mx-auto max-w-[1280px] px-6 pb-8 flex flex-wrap justify-between gap-3 text-xs text-slate-400">
        <span className="mono">GEP MCI / EU-WEST</span>
        <span className="mono">sensor_readings → panel_diagnostics → dashboard</span>
      </footer>
    </div>
  );
}
