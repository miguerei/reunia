import OpenAI from 'openai'
import type { Report, AppSettings } from '../types'

interface GenerateParams {
  settings: AppSettings
  audioFile: File
  sessionTitle?: string
}

/**
 * Main entry point for full post-recording report.
 * learnedExamples optional for self-improvement (injected in generateStructuredReport).
 */
export async function generateReport(
  params: GenerateParams,
  learnedExamples?: string[]
): Promise<{ transcript: string; report: Report }> {
  const { settings, audioFile, sessionTitle } = params

  const transcript = await transcribeAudioFile(settings, audioFile)
  const report = await generateStructuredReport(settings, transcript, sessionTitle, learnedExamples)

  return { transcript, report }
}

/* ===================== PUBLIC HELPERS FOR LIVE MODE ===================== */

/**
 * Transcribe an audio Blob (used for live "últimos minutos").
 * Works with both OpenAI and local OpenAI-compatible STT endpoints.
 */
export async function transcribeAudioBlob(settings: AppSettings, audioBlob: Blob): Promise<string> {
  const fileName = 'live-segment.webm'
  const audioFile = new File([audioBlob], fileName, { type: audioBlob.type || 'audio/webm' })
  return transcribeAudioFile(settings, audioFile)
}

/**
 * Ask the configured LLM (OpenAI or Ollama) a question about recent meeting transcript.
 * Returns a concise answer in Spanish.
 * 
 * focus: when provided, the prompt tells the model to semantically prioritize / filter the
 * rolling recent transcript for that theme (decisions, actions, risks, budget, people...).
 * This powers the "smart context focus filter" without mutating the raw buffer.
 *
 * learnedExamples: 0-3 short high-value excerpts from past starred liveQAs (via memory.ts).
 * Injected lightly as "En reuniones anteriores similares, el usuario valoró positivamente respuestas como..."
 * This is the core self-improvement injection point. Kept very concise.
 */
export async function askAboutRecentTranscript(
  settings: AppSettings,
  recentTranscript: string,
  userQuestion: string,
  focus?: string | null,
  learnedExamples?: string[]
): Promise<string> {
  const context = recentTranscript.trim().slice(-12000) // last ~12k chars as recent context

  let focusInstruction = ''
  if (focus) {
    const focusLabel = getFocusLabel(focus)
    focusInstruction = `\n\nENFOQUE DE CONTEXTO ACTUAL DEL USUARIO: "${focusLabel}". 
Prioriza fuertemente (y filtra para) la información de la transcripción que sea relevante a este enfoque. 
Destaca decisiones, acciones, riesgos, números o menciones de personas según el foco. 
Si no hay nada relevante en el contexto reciente para este enfoque, dilo claramente en lugar de inventar.`
  }

  let memoryInjection = ''
  if (learnedExamples && learnedExamples.length > 0) {
    const ex = learnedExamples.slice(0, 3).map((e, i) => `${i + 1}. ${e}`).join('\n')
    memoryInjection = `\n\nEn reuniones anteriores similares, el usuario valoró positivamente respuestas como:\n${ex}\nSigue un estilo similar (directo, accionable, en español) si encaja con la pregunta actual.`
  }

  const prompt = `Eres un asistente de reuniones en vivo. El usuario está en medio de una llamada y quiere saber cosas de lo que se ha dicho recientemente.

Transcripción de los últimos minutos:
${context || '(aún no hay suficiente transcripción)'}

Pregunta del usuario: ${userQuestion}${focusInstruction}${memoryInjection}

Responde de forma clara, directa y útil en español. Si no hay suficiente contexto, dilo honestamente.`

  if (settings.aiProvider === 'ollama') {
    return askOllama(settings, prompt)
  }

  // OpenAI
  if (!settings.openaiApiKey) throw new Error('Falta API Key de OpenAI')

  const openai = new OpenAI({ apiKey: settings.openaiApiKey, dangerouslyAllowBrowser: true })

  const completion = await openai.chat.completions.create({
    model: settings.preferredModel || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Eres un asistente útil y conciso para reuniones en español.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.4,
  })

  return completion.choices[0]?.message?.content?.trim() || 'No se pudo obtener respuesta.'
}

async function askOllama(settings: AppSettings, prompt: string): Promise<string> {
  const base = (settings.ollamaBaseUrl || 'http://localhost:11434').replace(/\/$/, '')
  const model = settings.ollamaModel || 'llama3.2'

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { temperature: 0.4 },
    }),
  })

  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Ollama error: ${res.status} ${t}`)
  }

  const data = await res.json()
  return (data?.message?.content || data?.response || '').trim()
}

/**
 * Compute embedding for a text using Ollama /api/embeddings when available.
 * Uses a sensible default embed model (nomic-embed-text works great and is small).
 * Returns null on any failure (no Ollama, wrong model, network) so callers degrade gracefully.
 * Embeddings stay 100% local and are only used for in-memory RAG scoring.
 */
export async function getOllamaEmbedding(
  text: string,
  baseUrl: string,
  model = 'nomic-embed-text'
): Promise<number[] | null> {
  if (!text || !text.trim()) return null
  const base = (baseUrl || 'http://localhost:11434').replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text.trim() }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const emb = data?.embedding
    return Array.isArray(emb) && emb.length > 0 ? emb : null
  } catch {
    return null
  }
}

/** Human-friendly label for a contextFocus key (used in prompts + UI). */
export function getFocusLabel(focus: string | null | undefined): string {
  if (!focus) return 'Todo el contexto'
  const map: Record<string, string> = {
    decisions: 'Decisiones y acuerdos',
    actions: 'Acciones y próximos pasos',
    risks: 'Riesgos y preocupaciones',
    budget: 'Presupuesto, costes y números',
    people: 'Personas y quién dijo qué',
  }
  if (map[focus]) return map[focus]
  // Allow free-form topics (e.g. "marketing" or "el cliente X")
  return focus.charAt(0).toUpperCase() + focus.slice(1)
}

/* ===================== INTERNAL ===================== */

async function transcribeAudioFile(settings: AppSettings, audioFile: File): Promise<string> {
  if (settings.transcriptionMode === 'local' && settings.transcriptionEndpoint) {
    const base = settings.transcriptionEndpoint.replace(/\/$/, '')
    const form = new FormData()
    form.append('file', audioFile)
    form.append('model', 'whisper-1')
    if (settings.language === 'es') form.append('language', 'es')

    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      body: form,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Error en transcripción local: ${res.status} ${text}`)
    }

    const data = await res.json()
    return data.text || ''
  }

  // OpenAI
  if (!settings.openaiApiKey) {
    throw new Error('Falta la API Key de OpenAI para la transcripción.')
  }

  const openai = new OpenAI({
    apiKey: settings.openaiApiKey,
    dangerouslyAllowBrowser: true,
  })

  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    language: settings.language === 'es' ? 'es' : undefined,
    response_format: 'verbose_json',
  })

  return (transcription as any).text || ''
}

/* ===================== REPORT (LLM) ===================== */

const SYSTEM_PROMPT = `Eres un asistente experto en actas y análisis de reuniones. El usuario habla en español. 
Devuelve SOLO un JSON válido con esta estructura exacta (sin markdown, sin explicaciones extra):

{
  "summary": "Resumen ejecutivo en 3-5 frases claras y accionables.",
  "keyInsights": ["insight 1", "insight 2", ...],
  "attendees": ["Nombre o rol si se menciona", ...],
  "speakers": ["Personas que intervinieron activamente", ...],
  "recommendations": ["recomendación concreta", ...],
  "advice": ["consejo práctico", ...],
  "todoList": [{"task": "acción concreta", "done": false}, ...]
}

Reglas:
- Sé conciso pero específico.
- Si no se mencionan nombres, deja arrays vacíos o usa roles ("el CEO", "Marketing").
- Extrae acciones reales y con dueño cuando sea posible.
- El idioma de salida debe ser español.`

async function generateStructuredReport(
  settings: AppSettings,
  transcript: string,
  sessionTitle?: string,
  learnedExamples?: string[]
): Promise<Report> {
  let learnedBlock = ''
  if (learnedExamples && learnedExamples.length > 0) {
    const ex = learnedExamples.slice(0, 3).map((e, i) => `${i + 1}. ${e}`).join('\n')
    learnedBlock = `Estilo y preferencias aprendidas de tus reuniones anteriores (usa este contexto ligero si ayuda a afinar insights/acciones/recomendaciones):\n${ex}\n\n`
  }

  const userPrompt = `${learnedBlock}Título aproximado de la reunión: ${sessionTitle || 'Reunión'}

Transcripción:
${transcript.slice(0, 14000)}

Genera el JSON del informe ahora.`

  if (settings.aiProvider === 'ollama') {
    return generateReportWithOllama(settings, userPrompt)
  }

  // OpenAI path
  if (!settings.openaiApiKey) {
    throw new Error('Falta la API Key de OpenAI.')
  }

  const openai = new OpenAI({
    apiKey: settings.openaiApiKey,
    dangerouslyAllowBrowser: true,
  })

  const completion = await openai.chat.completions.create({
    model: settings.preferredModel || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  })

  return parseReportFromContent(completion.choices[0]?.message?.content)
}

async function generateReportWithOllama(settings: AppSettings, userPrompt: string): Promise<Report> {
  const base = (settings.ollamaBaseUrl || 'http://localhost:11434').replace(/\/$/, '')
  const model = settings.ollamaModel || 'llama3.2'

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    format: 'json',           // Ollama supports this for structured output
    options: {
      temperature: 0.3,
    },
  }

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Error llamando a Ollama (${base}): ${res.status} ${text}`)
  }

  const data = await res.json()
  const content = data?.message?.content || data?.response || '{}'

  return parseReportFromContent(content)
}

function parseReportFromContent(content: string | undefined | null): Report {
  let parsed: any = {}
  try {
    // Ollama sometimes returns the JSON wrapped in ```json ... ```
    const cleaned = (content || '').replace(/```json|```/g, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    parsed = {}
  }

  return {
    summary: parsed.summary || 'No se pudo generar un resumen claro.',
    keyInsights: Array.isArray(parsed.keyInsights) ? parsed.keyInsights : [],
    attendees: Array.isArray(parsed.attendees) ? parsed.attendees : [],
    speakers: Array.isArray(parsed.speakers) ? parsed.speakers : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    advice: Array.isArray(parsed.advice) ? parsed.advice : [],
    todoList: Array.isArray(parsed.todoList)
      ? parsed.todoList.map((t: any, i: number) => ({
          id: 'td' + i,
          task: typeof t === 'string' ? t : t.task || '',
          done: typeof t === 'object' ? !!t.done : false,
        }))
      : [],
  }
}
