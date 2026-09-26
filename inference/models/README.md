# Modèle d'inférence

Place ici le fichier entraîné :

```text
inference/models/panel_model.pkl
```

Le modèle doit accepter un tableau 2D de 8 variables, dans cet ordre :

1. `intensite`
2. `tension`
3. `temperature`
4. `luminosite`
5. `power`
6. `mean_power`
7. `mean_temperature`
8. `mean_voltage`

Il doit retourner `0`/`1` ou `healthy`/`defective` avec `predict()`. `predict_proba()` est utilisé automatiquement si disponible.
