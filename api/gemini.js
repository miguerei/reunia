// Proxy de Gemini para ReunIA — la clave vive aquí (variable de entorno en Vercel),
// NUNCA en GitHub ni dentro de la app. Los compañeros usan la app sin pegar ninguna clave:
// la app llama a este endpoint y el proxy añade la clave del equipo y reenvía a Google.
//
// Configuración (una sola vez, por el dueño):
//   Vercel → Project → Settings → Environment Variables → GEMINI_API_KEY = <tu clave gratis de Google AI Studio>
//   (opcional) REUNIA_PROXY_TOKEN = <texto secreto> para exigir una cabecera y limitar quién usa el proxy.
//
// Nota: Vercel (plan gratis) limita el cuerpo de cada petición (~4.5 MB). El Coach en vivo y
// las reuniones cortas pasan sin problema; para transcribir audios muy largos conviene una clave propia.
//
// Usa métodos nativos de Node (res.statusCode/setHeader/end) para ser portable y testeable.

export const config = { api: { bodyParser: false } }

function send(res, status, obj) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj))
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const MAX = 8 * 1024 * 1024 // 8MB tope defensivo
    req.on('data', (c) => {
      size += c.length
      if (size > MAX) { reject(new Error('payload too large')); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export default async function handler(req, res) {
  // CORS: el renderer de Electron puede tener origen file:// (null) o el de la app.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Reunia-Token')
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }
  if (req.method !== 'POST') return send(res, 405, { error: 'Método no permitido' })

  const key = process.env.GEMINI_API_KEY
  if (!key) return send(res, 500, { error: 'El proxy no tiene GEMINI_API_KEY configurada en Vercel.' })

  // Gating opcional: si el dueño define REUNIA_PROXY_TOKEN, exige esa cabecera.
  const requiredToken = process.env.REUNIA_PROXY_TOKEN
  if (requiredToken && req.headers['x-reunia-token'] !== requiredToken) {
    return send(res, 401, { error: 'No autorizado.' })
  }

  let body
  try {
    body = JSON.parse((await readRawBody(req)) || '{}')
  } catch {
    return send(res, 413, { error: 'Petición demasiado grande o inválida (¿audio muy largo? usa una clave propia para reuniones largas).' })
  }

  const model = String(body.model || 'gemini-2.0-flash').replace(/[^a-zA-Z0-9.\-]/g, '') || 'gemini-2.0-flash'
  const payload = body.payload || {}
  const upstream = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`

  try {
    const r = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await r.text()
    return send(res, r.status, text)
  } catch (e) {
    return send(res, 502, { error: 'Error contactando con Gemini: ' + ((e && e.message) || 'desconocido') })
  }
}
