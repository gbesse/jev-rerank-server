# Jev Rerank

[English](README.md) · Français · [Español](README.es.md)

## Reranker avec Cloudflare Clef

Choisissez `JEV_PROVIDER=clef` et `JEV_MODEL=clef` ou `clef-flash` pour utiliser les mêmes routes de reranking via Cloudflare Workers AI. Définissez `CLOUDFLARE_ACCOUNT_ID` et `CLOUDFLARE_AUTH_TOKEN` dans l’environnement, puis lancez `npm start`. L’adaptateur envoie les questions System One à l’API REST, extrait l’enveloppe `result`, valide les réponses typées et estime le coût au tarif du modèle choisi. `npm test` utilise des réponses synthétiques ; aucun appel Cloudflare réel n’a été vérifié pour cette version.

**Projets voisins :** [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/) documente l’API et le tarif ; [Hindsight #5455](https://github.com/vectorize-io/hindsight/issues/5455) décrit le besoin d’un adaptateur Clef pour le reranking. Ce paquet est indépendant des deux. Les routes HTTP compatibles Cohere, Jina et Voyage constituent l’intégration disponible.

```sh
npm run demo
# Avec votre propre compte et jeton Cloudflare :
JEV_PROVIDER=clef JEV_MODEL=clef-flash npm start
```

Consultez le [README anglais](README.md) pour les anciennes fonctions et limites.
