/**
 * Badge de statut. Trois tonalites : good (sain), warn (diagnostic
 * inexploitable), bad (defaut confirme).
 *
 * `bad` est un ajout : l'ancienne interface n'avait que good/warn et affichait
 * donc un defaut confirme par le modele avec la meme couleur qu'un simple
 * avertissement.
 */
export default function Status({ tone = "good", children }) {
  return (
    <span className={`status ${tone}`}>
      <i />
      {children}
    </span>
  );
}
