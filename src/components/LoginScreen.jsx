import { useState } from "react";
import { AUTH_EMAIL_DOMAIN, usernameToEmail } from "../lib/auth.js";

/**
 * Écran de connexion.
 *
 * Il ne connaît ni la session ni la logique d'authentification : il reçoit
 * `onSubmit` et se contente d'en afficher le résultat. C'est App qui détient
 * la session, parce qu'elle conditionne le rendu de toute l'application ;
 * dupliquer cet état ici ferait diverger les deux.
 */
export default function LoginScreen({ onSubmit }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const email = usernameToEmail(username);
  const ready = Boolean(username && password);

  const submit = async (event) => {
    // Sans ce preventDefault, le navigateur rechargerait la page : le message
    // d'erreur disparaîtrait avant d'avoir pu être lu.
    event.preventDefault();
    if (busy || !ready) return;

    setBusy(true);
    setError(null);
    try {
      // En cas de succès, le changement de session remonte à App, qui démonte
      // cet écran : il n'y a rien à faire de plus ici.
      await onSubmit(username, password);
    } catch (err) {
      setError(err.message);
      // Le mot de passe est vidé, pas l'identifiant : une faute de frappe sur
      // le mot de passe est le cas courant, la ressaisir entièrement est
      // inutilement pénible.
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center px-6 py-10">
      <div className="w-full max-w-[380px]">
        <div className="flex items-center justify-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-[#f7a928] text-white grid place-items-center font-bold text-lg">
            H
          </div>
          <div>
            <p className="font-bold leading-tight text-lg">HelioPulse</p>
            <p className="text-[11px] text-slate-500 leading-tight">Monitoring solaire</p>
          </div>
        </div>

        <form className="card p-6" onSubmit={submit}>
          <h1 className="text-lg font-bold">Connexion</h1>
          <p className="text-xs text-slate-500 mt-1">Accès réservé à l'exploitant de l'installation.</p>

          <div className="mt-5 space-y-4">
            <label className="field">
              <span className="field-label">Identifiant</span>
              <input
                className="input"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                disabled={busy}
              />
              {/*
                Le compte Supabase porte un email, pas « admin ». Afficher la
                conversion pendant la saisie évite que l'écart entre ce qui est
                tapé et ce qui existe en base ne devienne un mystère le jour où
                la connexion échoue.
              */}
              {email && email !== username && (
                <span className="field-hint">
                  Compte <span className="mono">{email}</span>
                </span>
              )}
            </label>

            <label className="field">
              <span className="field-label">Mot de passe</span>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={busy}
              />
            </label>
          </div>

          {error && (
            <div className="notice bad mt-4" role="alert">
              {error}
            </div>
          )}

          <button className="btn w-full mt-5" type="submit" disabled={busy || !ready}>
            {busy ? "Connexion…" : "Se connecter"}
          </button>
        </form>

        <p className="text-[11px] text-slate-400 text-center mt-4 leading-relaxed">
          Les identifiants sont vérifiés par Supabase Auth.
          <br />
          Le domaine <span className="mono">{AUTH_EMAIL_DOMAIN}</span> est ajouté à l'identifiant.
        </p>
      </div>
    </div>
  );
}
