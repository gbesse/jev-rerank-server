# Jev Rerank

[English](README.md) · [Français](README.fr.md) · Español

## Reranking con Cloudflare Clef

Elija `JEV_PROVIDER=clef` y `JEV_MODEL=clef` o `clef-flash` para usar las mismas rutas de reranking con Cloudflare Workers AI. Defina `CLOUDFLARE_ACCOUNT_ID` y `CLOUDFLARE_AUTH_TOKEN` en el entorno y ejecute `npm start`. El adaptador envía preguntas System One a la API REST, extrae el sobre `result`, valida las respuestas tipadas y estima el costo con la tarifa del modelo elegido. `npm test` utiliza respuestas sintéticas; esta versión no se ha verificado con una llamada real a Cloudflare.

**Proyectos relacionados:** [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/) documenta la API y el precio; [Hindsight #5455](https://github.com/vectorize-io/hindsight/issues/5455) expone la necesidad de un adaptador Clef para reranking. Este paquete es independiente de ambos. Las rutas HTTP compatibles con Cohere, Jina y Voyage son la integración disponible.

```sh
npm run demo
# Con su propia cuenta y token de Cloudflare:
JEV_PROVIDER=clef JEV_MODEL=clef-flash npm start
```

Consulte el [README en inglés](README.md) para las funciones anteriores y sus límites.
