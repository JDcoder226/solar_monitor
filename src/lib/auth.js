import { supabase, isConfigured } from "./supabase.js";

const config = window.GEPMCI_CONFIG || {};

/**
 * Domaine utilisé pour transformer l'identifiant saisi en email.
 *
 * Supabase Auth n'a pas de champ « nom d'utilisateur » : un compte est
 * identifié par un email. Plutôt que d'imposer de taper l'adresse complète
 * dans le formulaire, on demande `admin` et on complète ici. Un email complet
 * reste accepté tel quel.
 */
export const AUTH_EMAIL_DOMAIN = config.authEmailDomain || "";

/**
 * « admin » → « admin@gmail.com ». Un email complet passe tel quel.
 *
 * Si `authEmailDomain` manque dans config.js, le repli est la chaîne vide :
 * l'aperçu du formulaire affiche alors « admin@ » et la connexion échoue sur
 * un format invalide. C'est volontaire — un domaine inventé en repli serait
 * rejeté par Supabase de toute façon, mais sans que rien ne le montre.
 */
export function usernameToEmail(username) {
  const value = String(username || "").trim().toLowerCase();
  if (!value) return "";
  return value.includes("@") ? value : `${value}@${AUTH_EMAIL_DOMAIN}`;
}

/**
 * Les messages de GoTrue sont en anglais et parlent d'« email » là où
 * l'utilisateur a saisi un identifiant : tel quel, « Email not confirmed »
 * n'indique pas quoi faire. Les trois cas ci-dessous sont ceux qu'on
 * rencontre réellement.
 *
 * Le message d'échec de connexion est volontairement le même que le compte
 * existe ou non — c'est ce que fait Supabase, et le préserver évite de
 * transformer le formulaire en outil pour deviner les comptes valides.
 */
function translate(message) {
  const text = String(message || "");
  if (/invalid login credentials/i.test(text)) {
    return "Identifiant ou mot de passe incorrect.";
  }
  if (/email not confirmed/i.test(text)) {
    return (
      "Ce compte existe mais n'est pas confirmé. Dans Supabase : Authentication > Users, " +
      "ouvre le compte et choisis « Confirm email »."
    );
  }
  if (/failed to fetch|networkerror|load failed/i.test(text)) {
    return "Supabase est injoignable. Vérifie ta connexion, puis supabaseUrl dans config.js.";
  }
  if (/too many requests|rate limit/i.test(text)) {
    return "Trop de tentatives. Patiente une minute avant de réessayer.";
  }
  return text || "Connexion impossible.";
}

function client() {
  if (!isConfigured || !supabase) {
    throw new Error("config.js est absent ou incomplet : url et clé anon requises.");
  }
  return supabase;
}

/**
 * Ouvre une session. Le jeton résultant est rangé par supabase-js dans le
 * localStorage du navigateur, et c'est lui que les appels suivants envoient.
 */
export async function signIn(username, password) {
  const email = usernameToEmail(username);
  if (!email) throw new Error("Identifiant requis.");

  const { error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw new Error(translate(error.message));
}

export async function signOut() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(translate(error.message));
}

/** Session courante, ou null si personne n'est connecté. */
export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session || null;
}

/** S'abonne aux changements de session. Retourne la fonction de désabonnement. */
export function onAuthChange(callback) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((event, session) => callback(event, session));
  return () => data?.subscription?.unsubscribe();
}
