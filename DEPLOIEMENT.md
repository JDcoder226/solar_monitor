# Déploiement HelioPulse

Trois briques, trois hébergeurs. Elles se déploient dans cet ordre — chacune
dépend de la précédente.

| Brique | Rôle | Hébergeur | Coût |
|---|---|---|---|
| Supabase | base de données + comptes | existant | gratuit |
| `dist/` | dashboard (statique) | Vercel | gratuit |
| `inference/` | diagnostic (one-shot) | GitHub Actions | gratuit (dépôt public) |

Le dépôt git existe et est poussé ; l'étape 0 ne sert plus qu'en cas de
reprise de zéro. Render reste une alternative payante au service d'inférence,
traitée en fin de document.

---

## Étape 0 — Dépôt git

Le `.gitignore` et le `.vercelignore` sont déjà en place. Sans eux, `git add .`
embarquerait les **195 Mo** de `inference/.venv` et les **49 Mo** de
`node_modules` : Vercel refuse l'envoi.

```bash
cd /Users/apple/Desktop/Armel

# 1. Initialiser le depot. Sans effet si `.git` existe deja — inutile de le
#    supprimer pour repartir de zero.
git init

# 2. Fixer l'identite des commits.
#    `user.email` est deja configure globalement (jeremie.dabire24@inphb.ci).
#    `user.name` ne l'est pas — et le commit REUSSIRA quand meme : git deduit
#    un nom du compte macOS. Sur cette machine il donne « DABIRE  JEREMIE »,
#    avec un double espace. Le nommer explicitement evite ce genre d'artefact.
#    C'est l'email qui rattache un commit a ton compte GitHub ; le nom n'est
#    qu'un affichage, mais autant qu'il soit propre.
git config user.name "Prenom Nom" # <- a remplacer
git config user.email             # doit afficher une adresse

# 3. Mettre en scene et CONTROLER avant de figer quoi que ce soit.
git add .
git status --short | wc -l        # 56 fichiers attendus, pas des milliers
git status --short | grep -cE "\.env$|\.venv|node_modules|^.. dist/"
                                  # doit afficher 0 : rien de lourd, aucun secret
```

Si le compte n'est pas 56, ou si le second affiche autre chose que `0`, **arrête
toi** : un `.gitignore` incomplet ferait entrer les 195 Mo de `.venv` dans
l'historique, et les retirer ensuite demande de réécrire l'historique.

```bash
# 4. Figer le premier commit.
git commit -m "HelioPulse : dashboard, service d'inference, migration Supabase"
```

Puis crée un dépôt **public** vide sur GitHub — sans README ni `.gitignore`,
sinon le premier `push` est refusé. Public et pas privé : c'est ce qui rend les
minutes GitHub Actions illimitées (voir étape 4). `gh` n'est pas installé sur
cette machine, donc passe par [github.com/new](https://github.com/new).

```bash
# 5. Relier et pousser. Remplace TON_COMPTE.
git remote add origin git@github.com:TON_COMPTE/heliopulse.git
git push -u origin main
```

Si le `push` échoue avec `Permission denied (publickey)`, c'est que ta clé SSH
n'est pas déposée sur GitHub :

```bash
ssh-keygen -t ed25519 -C "jeremie.dabire24@inphb.ci"   # si tu n'en as pas
pbcopy < ~/.ssh/id_ed25519.pub                          # copie la cle publique
```

Puis colle-la dans GitHub > Settings > SSH and GPG keys > New SSH key. Pour
utiliser HTTPS à la place de SSH, remplace l'URL du remote par
`https://github.com/TON_COMPTE/heliopulse.git`.

Le dépôt contient `config.js`, donc la clé anon. Elle est publique par nature
(elle est déjà servie à chaque visiteur du dashboard) — c'est la RLS qui
protège. La clé `service_role`, elle, n'est **jamais** dans le dépôt : elle ne
vit que dans les variables d'environnement de Render.

---

## Étape 1 — Supabase

Le SQL doit être exécuté **avant** les deux autres : le dashboard lit les
nouvelles tables, et le service lit la configuration.

1. Ouvre le SQL Editor de ton projet.
2. Colle et exécute `supabase_migration_v2.sql` en entier.
3. Contrôle :

```sql
select count(*) from public.model_features;   -- 13
select count(*) from public.fault_catalog;    -- 16
select count(*) from public.device_settings;  -- 0 au depart, c'est normal
```

Une fois la migration passée, remplis **Paramètres > Caractéristiques du site**
depuis le dashboard (étape 2 terminée) : c'est ce qui calibre le modèle.

---

## Étape 2 — Dashboard sur Vercel

`vercel.json` est prêt : build statique, en-têtes de sécurité, CSP
`script-src 'self'`. La clé anon vit dans `config.js`, hors du bundle, donc tu
peux changer de projet Supabase sans reconstruire.

### Par l'interface

1. [vercel.com/new](https://vercel.com/new) → importe le dépôt GitHub.
2. Vercel lit `vercel.json` et n'a rien à demander :
   - Framework Preset : **Other** (imposé par `"framework": null`)
   - Build Command : `npm run build`
   - Output Directory : `dist`
3. Deploy.

### Par la ligne de commande

```bash
npm i -g vercel
vercel          # préversion
vercel --prod   # production
```

### Relier le dépôt — à faire une fois

**Sans cette étape, `git push` ne déploie rien.** Le projet Vercel a été créé
en ligne de commande, donc il n'est relié à aucun dépôt : les pushes
s'accumulent sur GitHub et le site reste figé sur le dernier `vercel --prod`.
C'est arrivé exactement une fois ici — un push est resté 15 h sans effet, et le
site servait encore la version de la veille.

```bash
vercel git connect
```

Ou par l'interface : projet Vercel → Settings → Git → *Connect Git Repository*.
Après quoi chaque push sur `main` déclenche un déploiement automatique.

Pour savoir si c'est bien relié, la liste des déploiements doit contenir une
entrée dont l'origine est Git et non `jdcoder226` :

```bash
vercel ls
```

### Vérifier

Ouvre l'URL de déploiement et regarde la console du navigateur. Tu dois voir
**zéro** avertissement Tailwind (l'ancien `code.html` en produisait un) et
aucune mention de Babel.

Le build est reproductible en local si besoin :

```bash
npm run build && npm run preview
```

---

## Étape 3 — Compte administrateur (authentification)

Le dashboard exige désormais une connexion. **Ce compte doit exister avant que
le site ne soit accessible**, sinon le dashboard est inaccessible — y compris
pour toi.

### La contrainte à connaître : l'email doit être sur un domaine réel

Supabase Auth identifie un compte par un **email**, et il refuse les domaines
qui ne résolvent pas dans le DNS. Vérifié sur ce projet :

| Adresse essayée | Réponse |
|---|---|
| `admin@heliopulse.local` | `email_address_invalid` |
| `admin@heliopulse.app` | `email_address_invalid` |
| `…@inphb.ci`, `…@gmail.com` | acceptés |

`heliopulse.local` et `heliopulse.app` n'ont **aucun** enregistrement DNS (ni A,
ni MX), alors que `inphb.ci` et `gmail.com` ont des MX. Un domaine inventé ne
peut donc pas servir d'identifiant, même s'il « a l'air » valide.

Conséquence sur le formulaire : il accepte un email complet tel quel, et
transforme un identifiant court en `identifiant@<authEmailDomain>` (voir
`config.js`). Pour te connecter avec le seul mot `admin`, il faut donc un
domaine que tu contrôles, avec `admin@` comme adresse réelle.

### Créer le compte

1. Supabase → **Authentication** → **Users** → **Add user** → *Create new user*.
2. Renseigne l'email et le mot de passe de ton choix.
3. Coche **Auto Confirm User**.

Le mot de passe ne doit figurer **nulle part** dans ce dépôt, qui est public :
ni ici, ni dans `config.js`, ni dans un commit. Il ne vit que dans Supabase.

L'étape 3 est importante : sans elle, le compte reste « non confirmé », Supabase
envoie un lien de confirmation à une adresse qui n'existe peut-être pas, et la
connexion répond « Email not confirmed ». Le message d'erreur du dashboard
t'indique cette marche à suivre si ça arrive.

### Fermer les inscriptions

Authentication → **Sign In / Providers** → décoche **Allow new users to sign
up**. Sans cela, n'importe qui peut se créer un compte — sans gain pour lui
tant que les policies restent ouvertes, mais sans raison de le laisser ouvert
non plus.

### Aligner `config.js`

`authEmailDomain` dans `config.js` doit correspondre au domaine du compte créé.
Si tu utilises une adresse réelle, tu peux aussi la taper en entier dans le
formulaire : un email complet n'est jamais transformé.

---

## Étape 4 — Service d'inférence (GitHub Actions)

Le service est un **one-shot** : il diagnostique tous les devices actifs, purge
les diagnostics de plus de 90 jours, puis sort. C'est ce qui le rend planifiable.

Le workflow `.github/workflows/inference.yml` est déjà écrit. Il reste trois
gestes, tous dans l'interface GitHub.

### 1. Rendre le dépôt public

Settings → General → Danger Zone → **Change repository visibility** → Public.

C'est ce qui rend les minutes illimitées. Sur un dépôt privé, le quota gratuit
de 2000 min/mois ne tiendrait qu'une exécution par heure (chaque run coûte
~2 minutes facturées : checkout, Python, `pip install lightgbm`, exécution).

Avant de basculer, vérifie qu'aucun secret ne part avec. L'audit de
l'historique complet a trouvé **un seul jeton, dont le rôle est `anon`** — la
clé publique, déjà servie à chaque visiteur du dashboard. La clé `service_role`
n'est nulle part dans le dépôt. Tu peux refaire le contrôle :

```bash
git grep -I -h -oE "eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+" $(git rev-list --all) | sort -u
```

Décode le deuxième segment de chaque jeton trouvé en base64 : le champ `role`
doit valoir `anon`, jamais `service_role`.

### 2. Ajouter les deux secrets

Settings → Secrets and variables → Actions → **New repository secret** :

| Nom | Valeur |
|---|---|
| `SUPABASE_URL` | `https://cwlzpxclfytmchrgjpdm.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ta clé service_role (Supabase > Settings > API) |

Les secrets sont chiffrés et ne sont **jamais** exposés par le passage en
public, même si le workflow, lui, est lisible. C'est précisément le mécanisme
qui permet un dépôt public avec un secret dedans.

### 3. Pousser le workflow

```bash
git add .github/workflows/inference.yml DEPLOIEMENT.md
git commit -m "Diagnostic automatique toutes les 15 min via GitHub Actions"
git push
```

Puis onglet **Actions** → *Diagnostic HelioPulse* → **Run workflow** pour
vérifier tout de suite, sans attendre le prochain créneau.

### Vérifier

Le journal doit ressembler à :

```
Modele charge : lgbm_pv_fault_model@cdbc699fc2c0 | 13 features | 16 classes
ESP32-ARRAY-01 : warning    3M    100.0% | 2 mesurees / 8 derivees / 3 figees | ...
Retention : 0 diagnostics purges (> 90 jours).
```

Le code de sortie doit être **0**. Un code non nul signifie qu'au moins un
device a échoué — le détail est dans le journal.

### En local, avant de pousser

```bash
cd inference
cp .env.example .env      # puis renseigne les deux valeurs
.venv/bin/python diagnose_panel.py --dry-run
```

`--dry-run` calcule tout et affiche le diagnostic **sans rien écrire** en base.
C'est le mode à utiliser pour vérifier une configuration.

---

## Étape 5 — Vérifier que la boucle est bouclée

1. Le cron écrit dans `panel_diagnostics`.
2. Le dashboard lit la dernière ligne et affiche le diagnostic réel.

```sql
select created_at, device_id, status, fault_code, score, data_completeness
from public.panel_diagnostics
order by created_at desc
limit 5;
```

Si la table reste vide alors que le cron sort en code 0, c'est que la dernière
mesure est absente — le service le dit explicitement dans le journal
(`aucune mesure, rien a diagnostiquer`), il n'écrit pas de ligne dans ce cas.

---

## Option payante — Render (~1 $/mois)

Si tu préfères ne pas rendre le dépôt public, ou si les retards d'exécution de
GitHub Actions deviennent gênants, Render exécute le même service. `inference/Dockerfile`
et `render.yaml` sont fournis et testés. En contrepartie, les cron jobs Render
sont facturés : **1 $/mois minimum** par tâche planifiée.

### Créer le cron job

Le plus simple est l'interface ; `render.yaml` sert si tu préfères que la
configuration soit versionnée.

1. Render → **New > Cron Job**.
2. Connecte le dépôt GitHub.
3. Runtime : **Docker**.
   - Dockerfile Path : `inference/Dockerfile`
   - Docker Build Context : `inference`
4. Schedule : `*/15 * * * *` (toutes les 15 minutes, en UTC)
5. Region : Frankfurt, Instance : Starter.
6. Variables d'environnement :

| Clé | Valeur |
|---|---|
| `SUPABASE_URL` | `https://cwlzpxclfytmchrgjpdm.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ta clé service_role (Supabase > Settings > API) |
| `DEVICE_IDS` | vide (les 3 devices actifs sont pris automatiquement) |

`SUPABASE_SERVICE_ROLE_KEY` contourne la RLS. Elle ne doit exister **que** dans
ces variables d'environnement — jamais dans `config.js`, jamais dans le dépôt.

### Vérifier

Déclenche une exécution manuelle depuis Render. Le journal doit ressembler à :

```
Modele charge : lgbm_pv_fault_model@cdbc699fc2c0 | 13 features | 16 classes
ESP32-ARRAY-01 : warning    3M    100.0% | 2 mesurees / 8 derivees / 3 figees | ...
Retention : 0 diagnostics purges (> 90 jours).
```

Le code de sortie doit être **0**. Un code non nul signifie qu'au moins un
device a échoué — le détail est dans le journal.

### En local, avant de déployer

```bash
cd inference
cp .env.example .env      # puis renseigne les deux valeurs
.venv/bin/python diagnose_panel.py --dry-run
```

`--dry-run` calcule tout et affiche le diagnostic **sans rien écrire** en base.
C'est le mode à utiliser pour vérifier une configuration.

---

## Ce qu'il reste à renseigner

Le service tourne, mais ses valeurs de calibration par défaut sont des
**valeurs d'exemple** (`400 V`, `10 A`), et la base ne contient aucune ligne
`device_settings` : le diagnostic actuel est donc calculé sur une échelle qui
ne correspond pas à ton installation. Voir la section correspondante dans le
compte rendu — c'est le premier réglage à faire dans Paramètres.
