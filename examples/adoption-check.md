# jev-rerank-server — contrôle d’adoption · adoption check · comprobación de adopción

## Français

Point de départ local, après la préparation indiquée dans le README :

```sh
node examples/cache-savings.mjs
```

Rejouez la même requête sur les mêmes documents, puis modifiez la requête. Les compteurs de requêtes fournisseur et de documents en cache montrent quand un résultat est réutilisé.

## English

Local starting point, after the setup described in the README:

```sh
node examples/cache-savings.mjs
```

Rerun the same query over the same documents, then change the query. Provider-request and cached-document counters show when a result is reused.

## Español

Punto de partida local, después de la preparación descrita en el README:

```sh
node examples/cache-savings.mjs
```

Repita la misma consulta sobre los mismos documentos y después cambie la consulta. Los contadores de solicitudes al proveedor y documentos en caché muestran cuándo se reutiliza un resultado.
## Variante synthétique · Synthetic variation · Variante sintética

```text
query_1="refund"; docs=["policy"]; query_2="refund"; query_3="exchange"
```

FR : adaptez une copie de la fixture locale à cette situation, puis vérifiez le comportement décrit ci-dessus. Les valeurs sont illustratives, pas des résultats Jev mesurés.

EN: adapt a copy of the local fixture to this situation, then check the behavior described above. Values are illustrative, not measured Jev output.

ES: adapte una copia de la fixture local a esta situación y compruebe el comportamiento descrito arriba. Los valores son ilustrativos, no resultados Jev medidos.
