# Clave de Gemini compartida para el equipo (modo equipo)

Objetivo: que **todos tus compañeros usen una sola clave de Gemini, gratis y sin configurar nada**, sin que la clave aparezca en GitHub ni dentro de la app.

Cómo funciona: la app no lleva la clave. Llama a un pequeño **proxy** alojado en tu Vercel (`/api/gemini`). El proxy guarda la clave como **variable de entorno** (solo visible para ti en Vercel) y reenvía las peticiones a Google. Así la clave **nunca** viaja en el instalador ni en el repositorio público.

```
App de cada compañero  ──►  https://reunia-pied.vercel.app/api/gemini  ──►  Google Gemini
   (sin clave)                 (la clave vive aquí, en Vercel)
```

## Configuración (una sola vez, solo tú)

1. **Consigue una clave gratis** en https://aistudio.google.com/app/apikey → "Create API key".
   - Recomendado: usa un proyecto de Google **sin facturación** (así, en el peor caso, solo se agota la cuota gratuita; nunca hay cargos).
2. En **Vercel** → tu proyecto `reunia` → **Settings → Environment Variables**, añade:
   - `GEMINI_API_KEY` = *(tu clave)*  → marca Production (y Preview si quieres).
   - *(opcional, recomendado)* `REUNIA_PROXY_TOKEN` = *(un texto secreto cualquiera)* para que solo tu app pueda usar el proxy.
3. **Despliega** el proxy (incluye `api/gemini.js` y el `vercel.json` actualizado):
   ```bash
   npx vercel --prod
   ```
   (o conecta el repo en Vercel → Settings → Git para que se despliegue solo en cada push).
4. Comprueba que responde:
   ```bash
   curl -X POST https://reunia-pied.vercel.app/api/gemini \
     -H 'Content-Type: application/json' \
     -d '{"model":"gemini-2.0-flash","payload":{"contents":[{"parts":[{"text":"di hola"}]}]}}'
   ```
   Debe devolver un JSON de Gemini (no un error 500).

Listo. A partir de aquí, cualquier compañero que instale ReunIA y deje **Gemini → "Clave del equipo"** (que es lo que viene por defecto) grabará y obtendrá informes y Coach IA **sin pegar ninguna clave**.

## Notas

- **Reuniones muy largas**: Vercel (plan gratis) limita cada petición a ~4.5 MB. El Coach en vivo y las reuniones cortas pasan perfectamente; para transcribir audios muy largos por el proxy puede fallar — en ese caso, ese usuario puede cambiar a **"Mi propia clave"** (también gratis) solo para transcribir.
- **Si la clave se abusa o se agota**: como vive en Vercel, basta con generar una nueva en Google AI Studio y actualizar `GEMINI_API_KEY` en Vercel. **No hace falta reconstruir ni reinstalar la app.**
- **Privacidad**: el proxy solo reenvía a Google; no guarda audio ni transcripciones.
- **Rotación / gating**: si pones `REUNIA_PROXY_TOKEN`, habría que incluir esa cabecera desde la app (hoy la app no la envía por defecto; se puede añadir si quieres cerrar el proxy del todo).
