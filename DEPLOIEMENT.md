# Déploiement HelioPulse

Trois briques, trois hébergeurs. Elles se déploient dans cet ordre — chacune
dépend de la précédente.

| Brique | Rôle | Hébergeur | Coût |
|---|---|---|---|
| Supabase | base de données | existant | gratuit |
| `dist/` | dashboard (statique) | Vercel | gratuit |
| `inference/` | diagnostic (one-shot) | Render Cron | ~1 $/mois |

Rien n'est encore dans un dépôt git aujourd'hui : c'est l'étape 0, et c'est
obligatoire, car Vercel comme Render déploient depuis git.

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

Puis crée un dépôt **privé** vide sur GitHub — sans README ni `.gitignore`, sinon
le premier `push` est refusé. `gh` n'est pas installé sur cette machine, donc
passe par [github.com/new](https://github.com/new).

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

### Vérifier

Ouvre l'URL de déploiement et regarde la console du navigateur. Tu dois voir
**zéro** avertissement Tailwind (l'ancien `code.html` en produisait un) et
aucune mention de Babel.

Le build est reproductible en local si besoin :

```bash
npm run build && npm run preview
```

---

## Étape 3 — Service d'inférence (Render)

`inference/Dockerfile` et `render.yaml` sont fournis. Le service est un
**one-shot** : il diagnostique tous les devices actifs, purge les diagnostics
de plus de 90 jours, puis sort. C'est ce qui le rend déployable en cron.

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

## Étape 4 — Vérifier que la boucle est bouclée

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

## Variante : GitHub Actions au lieu de Render

Si tu ne veux pas payer le dollar mensuel de Render, GitHub Actions exécute le
même service gratuitement. C'est moins confortable (pas de journal Render, pas
de déclenchement manuel en un clic) mais c'est gratuit.

Crée `.github/workflows/inference.yml` :

```yaml
name: Diagnostic HelioPulse
on:
  schedule:
    - cron: "*/30 * * * *"   # toutes les 30 min (le minimum gratuit utile)
  workflow_dispatch:          # permet un declenchement manuel

jobs:
  diagnostiquer:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip
      - run: pip install -r inference/requirements.txt
      - run: python inference/diagnose_panel.py --prune-days 90
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
```

Ajoute les deux secrets dans Settings > Secrets and variables > Actions. Le
fichier `inference/Dockerfile` reste utile : il ne gêne pas et sert si tu
changes d'hébergeur plus tard.

Attention à la fréquence : GitHub facture les minutes des dépôts privés
(2000/mois en gratuit). Toutes les 30 minutes représentent environ 700 minutes
par mois pour cette tâche — ça tient, mais toutes les 5 minutes non.

---

## Ce qu'il reste à renseigner

Le service tourne, mais ses valeurs de calibration par défaut sont des
**valeurs d'exemple** (`400 V`, `10 A`), et la base ne contient aucune ligne
`device_settings` : le diagnostic actuel est donc calculé sur une échelle qui
ne correspond pas à ton installation. Voir la section correspondante dans le
compte rendu — c'est le premier réglage à faire dans Paramètres.
