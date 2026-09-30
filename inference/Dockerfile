# Image du service d'inference GEP MCI.
#
# Le service est un ONE-SHOT : il diagnostique tous les devices actifs, purge
# les vieux diagnostics, puis sort. C'est ce qui le rend deployable en cron job.
# La commande DOIT se terminer — un cron facture chaque seconde d'un processus
# qui reste en vie, et un service qui ne sort pas bloque le declenchement
# suivant (Render n'autorise qu'une execution a la fois par cron).

FROM python:3.11-slim

# LightGBM est une bibliotheque C++ : ses roues precompilees exigent libgomp
# (OpenMP) a l'execution. Sur une image -slim elle n'est pas presente, et
# l'erreur ne survient qu'au moment du predict, pas a l'installation.
# Rien d'autre n'est necessaire : numpy et lightgbm sont livres en roues, donc
# aucun compilateur n'est requis.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Les dependances en premier : cette couche n'est reconstruite que si
# requirements.txt change, pas a chaque modification du code Python.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Utilisateur non root. Le service n'ecrit rien sur le disque : il lit Supabase
# et y ecrit, donc il n'a besoin d'aucun volume.
RUN useradd --create-home --uid 10001 helio \
 && chown -R helio:helio /app
USER helio

# Sans cela, les print() restent dans le tampon et n'apparaissent dans les logs
# qu'a la fin de l'execution — donc jamais, si le service est tue avant.
ENV PYTHONUNBUFFERED=1

# --prune-days 90 : la retention passe ici plutot que dans un second cron.
# 3 devices x 96 runs/jour font ~290 lignes/jour, soit ~26000 sur 90 jours.
CMD ["python", "diagnose_panel.py", "--prune-days", "90"]
