import { createClient } from "@supabase/supabase-js";

// Remplace le client cree depuis les bundles UMD charges par CDN dans l'ancien
// code.html. Les valeurs viennent toujours de config.js, lu au chargement de la
// page via window.HELIOPULSE_CONFIG.
const config = window.HELIOPULSE_CONFIG || {};
const url = config.supabaseUrl || "";
const anonKey = config.supabaseAnonKey || "";

export const isConfigured = Boolean(url && anonKey);

export const supabase = isConfigured ? createClient(url, anonKey) : null;

/** Erreur reseau/Supabase enveloppee, avec un message exploitable par l'UI. */
export class DataError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "DataError";
    this.cause = cause;
  }
}

function unwrap(response, what) {
  if (response.error) {
    throw new DataError(`Lecture de ${what} impossible : ${response.error.message}`, response.error);
  }
  return response.data || [];
}

/**
 * Une table absente signifie presque toujours que supabase_migration_v2.sql
 * n'a pas encore ete execute. Sans ce traitement, l'UI afficherait une erreur
 * de reseau generique au lieu de dire quoi faire.
 */
function isMissingTable(error) {
  const code = error?.code || error?.cause?.code;
  return code === "PGRST205" || code === "42P01";
}

export async function fetchDevices() {
  return unwrap(
    await supabase.from("devices").select("id,name,location,capacity_kwc,active").eq("active", true).order("name"),
    "devices",
  );
}

export async function fetchReadings(deviceId, sinceIso) {
  return unwrap(
    await supabase
      .from("sensor_readings")
      .select("id,device_id,intensite,tension,temperature,luminosite,created_at")
      .eq("device_id", deviceId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(200),
    "sensor_readings",
  );
}

export async function fetchLatestDiagnosis(deviceId) {
  const response = await supabase
    .from("panel_diagnostics")
    .select("*")
    .eq("device_id", deviceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // PGRST116 = aucune ligne : ce n'est pas une erreur, juste un device jamais
  // diagnostique (le service d'inference n'a pas encore tourne).
  if (response.error && response.error.code !== "PGRST116") {
    throw new DataError(
      `Lecture de panel_diagnostics impossible : ${response.error.message}`,
      response.error,
    );
  }
  return response.data || null;
}

// --- Configuration (page Parametres) ---------------------------------------

export async function fetchFeatureCatalog() {
  const response = await supabase.from("model_features").select("*").order("position");
  if (response.error) {
    if (isMissingTable(response.error)) {
      throw new DataError(
        "La table model_features est absente. Exécute supabase_migration_v2.sql " +
          "dans le SQL Editor de Supabase, puis recharge cette page.",
        response.error,
      );
    }
    throw new DataError(`Lecture de model_features impossible : ${response.error.message}`, response.error);
  }
  return response.data || [];
}

export async function fetchFaultCatalog() {
  const response = await supabase.from("fault_catalog").select("*").order("display_order");
  if (response.error) {
    if (isMissingTable(response.error)) return [];
    throw new DataError(`Lecture de fault_catalog impossible : ${response.error.message}`, response.error);
  }
  return response.data || [];
}

export async function fetchDeviceSettings(deviceId) {
  const response = await supabase
    .from("device_settings")
    .select("*")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (response.error && response.error.code !== "PGRST116") {
    if (isMissingTable(response.error)) return null;
    throw new DataError(`Lecture de device_settings impossible : ${response.error.message}`, response.error);
  }
  return response.data || null;
}

export async function fetchFeatureOverrides(deviceId) {
  const response = await supabase.from("device_feature_config").select("*").eq("device_id", deviceId);
  if (response.error) {
    if (isMissingTable(response.error)) return [];
    throw new DataError(
      `Lecture de device_feature_config impossible : ${response.error.message}`,
      response.error,
    );
  }
  return response.data || [];
}

/** Upsert d'une ligne de configuration. Cree la ligne si elle n'existe pas. */
export async function saveRow(table, row, onConflict) {
  const query = supabase.from(table).upsert(row, onConflict ? { onConflict } : undefined);
  const { error } = await query;
  if (error) {
    throw new DataError(`Enregistrement dans ${table} impossible : ${error.message}`, error);
  }
}

export async function deleteFeatureOverride(deviceId, featureName) {
  const { error } = await supabase
    .from("device_feature_config")
    .delete()
    .eq("device_id", deviceId)
    .eq("feature_name", featureName);
  if (error) {
    throw new DataError(`Suppression impossible : ${error.message}`, error);
  }
}

export async function updateRow(table, idColumn, idValue, patch) {
  const { error } = await supabase.from(table).update(patch).eq(idColumn, idValue);
  if (error) {
    throw new DataError(`Mise a jour de ${table} impossible : ${error.message}`, error);
  }
}
