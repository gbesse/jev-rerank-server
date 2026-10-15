# Jev Rerank

## Nuevo: el caché respeta el contexto de pasajes agrupados

`node examples/packed-cache.mjs` muestra un proveedor **sintético** cuya puntuación cambia con otros pasajes presentes. El caché exacto sigue activo para pares (`pack=1`). En modo agrupado (`pack>1`) no se lee ni se alimenta: una entrada `(query, passage)` no representa otros pasajes ni sus posiciones. Las solicitudes agrupadas anuncian la decisión en avisos FR/EN/ES y cuentan cero documentos del caché. Puede aumentar las llamadas si antes combinaba agrupación y caché.

La corrección impide reutilizar una puntuación de otro contexto. No mide una mejora de calidad Jev ni añade caché de grupos completos. La demo comprueba un par con 0,9, un grupo con 0,1, otro contexto con 0,8 y reproducción del par sin otra llamada. Las probabilidades son ficticias. Se conservan índices y duplicados del protocolo.

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

## Caché exacta por proveedor

El `createScoreCache` integrado aísla puntuaciones por identidad de función del proveedor y modelo declarado. Dos proveedores con el mismo nombre de modelo y una caché compartida ya no reutilizan sus puntuaciones. Mantenga estable la función entre llamadas para aprovechar la caché. Si cambia configuración oculta, llame a `cache.clear()` o cree otro proveedor: los cambios de cierre no son detectables. Las llamadas manuales aceptan un argumento de proveedor opcional; entradas sin proveedor no alimentan el reranking. Una caché personalizada debe respetar el argumento para ofrecer el mismo aislamiento. El modo agrupado sigue sin caché.
