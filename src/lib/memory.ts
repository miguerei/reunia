import type { Session, LiveQA, AppSettings } from '../types'
import { getOllamaEmbedding } from './ai'

export interface MemoryEntry {
  id: string                 // unique `${sessionId}:${qaId}` or `${sessionId}:insight:N`
  text: string               // high-signal excerpt: "Q: ... | A: ..." or insight/recommendation text
  sessionId: string
  date: string
  tags?: string[]
  starred?: boolean
  focusUsed?: string
  embedding?: number[]       // optional Ollama embedding for semantic retrieval (local only)
}

let cached: MemoryEntry[] = []
let loaded = false

const api = () => (window as any).electron

/**
 * Load the local memory index (once). Falls back to [].
 * Called at app start; keeps in-memory for fast retrieve during live use.
 */
export async function loadMemoryIndex(): Promise<MemoryEntry[]> {
  if (loaded) return cached
  try {
    const e = api()
    if (e?.loadMemory) {
      const data = await e.loadMemory()
      cached = Array.isArray(data) ? data : []
    } else {
      // Fallback: try localStorage for dev without electron (rare)
      const raw = localStorage.getItem('reunia-memory')
      cached = raw ? (JSON.parse(raw) || []) : []
    }
  } catch (e) {
    console.warn('memory load failed, starting empty', e)
    cached = []
  }
  loaded = true
  return cached
}

export function getMemoryCount(): number {
  return cached.length
}

export function getCachedMemory(): MemoryEntry[] {
  return cached
}

/**
 * Persist the index (via main for real FS in userData).
 */
export async function saveMemoryIndex(entries: MemoryEntry[]): Promise<void> {
  cached = entries
  try {
    const e = api()
    if (e?.saveMemory) {
      await e.saveMemory(entries)
    } else {
      localStorage.setItem('reunia-memory', JSON.stringify(entries))
    }
  } catch (err) {
    console.warn('memory save failed (index still in mem for this run)', err)
  }
}

/**
 * Clear the entire local memory index (for privacy / reset self-improvement data).
 * Works via main process (userData json) or localStorage fallback.
 * After clear, cached is empty and count becomes 0.
 */
export async function clearMemory(): Promise<void> {
  cached = []
  loaded = true
  try {
    const e = api()
    if (e?.clearMemory) {
      await e.clearMemory()
    } else if (e?.saveMemory) {
      await e.saveMemory([])
    } else {
      localStorage.removeItem('reunia-memory')
    }
  } catch (err) {
    console.warn('memory clear failed (in-memory already reset)', err)
  }
}

/**
 * Index starred liveQAs from a (just stopped or loaded) session.
 * Non-blocking friendly: dedupes by id, only adds new high-value ones.
 * Called from store on addOrUpdate / after save.
 *
 * Optional settings: when Ollama is configured we attempt to compute+attach
 * embeddings for the new entries (enables semantic retrieval later).
 */
export async function indexStarredFromSession(session: Session, settings?: AppSettings | null): Promise<number> {
  if (!session || !session.liveQAs || session.liveQAs.length === 0) return 0

  const starredQAs = session.liveQAs.filter((qa: LiveQA) => qa.starred)
  if (starredQAs.length === 0) return 0

  const newEntries: MemoryEntry[] = starredQAs.map((qa: LiveQA) => ({
    id: `${session.id}:${qa.id}`,
    text: `Q: ${qa.question}\nA: ${qa.answer}`,
    sessionId: session.id,
    date: session.date,
    tags: qa.tags,
    starred: true,
    focusUsed: qa.focusUsed,
  }))

  // Best-effort embeddings for semantic RAG (only when Ollama configured; tiny N so await is fine)
  if (settings?.aiProvider === 'ollama' && settings.ollamaBaseUrl) {
    for (const ne of newEntries) {
      if (!ne.embedding) {
        try {
          const emb = await getOllamaEmbedding(ne.text, settings.ollamaBaseUrl, settings.ollamaModel || 'nomic-embed-text')
          if (emb) ne.embedding = emb
        } catch { /* ignore, keyword path still works */ }
      }
    }
  }

  try {
    const e = api()
    if (e?.indexMemoryEntries) {
      const added = await e.indexMemoryEntries(newEntries)
      // refresh cache lightly
      await loadMemoryIndex() // will merge on disk side, but reload to sync
      return added
    } else {
      // pure client fallback
      await loadMemoryIndex()
      const byId = new Map(cached.map(en => [en.id, en]))
      let added = 0
      for (const ne of newEntries) {
        if (!byId.has(ne.id)) {
          byId.set(ne.id, ne)
          added++
        }
      }
      const merged = Array.from(byId.values())
      await saveMemoryIndex(merged)
      return added
    }
  } catch (err) {
    console.warn('indexStarredFromSession failed', err)
    return 0
  }
}

/**
 * Lightweight retrieval for self-improvement injection.
 * Scoring: starred boost (high), recency, keyword overlap on query + tags/focus.
 * Returns up to limit best past excerpts (prefer matches to focus or query terms).
 * Fast: pure in-memory after initial load.
 */
export function retrieveRelevant(
  query: string,
  focus?: string | null,
  limit = 3
): MemoryEntry[] {
  if (!cached || cached.length === 0) return []

  const q = (query || '').toLowerCase().trim()
  const focusTag = focus ? focusToTag(focus) : null

  const scored = cached.map((entry) => {
    let score = 0

    // Strong signal: user explicitly starred for future use
    if (entry.starred) score += 12

    // Recency boost (last ~30 days matter most for "learned style")
    const ageDays = (Date.now() - new Date(entry.date).getTime()) / (1000 * 3600 * 24)
    if (ageDays < 2) score += 4
    else if (ageDays < 7) score += 3
    else if (ageDays < 30) score += 1.5
    else if (ageDays < 90) score += 0.5

    // Keyword overlap (question words, tags, focus)
    const haystack = `${entry.text} ${(entry.tags || []).join(' ')} ${entry.focusUsed || ''}`.toLowerCase()
    if (q) {
      const terms = q.split(/[\s,¿?¡!.:;]+/).filter((t) => t.length >= 3)
      for (const t of terms) {
        if (haystack.includes(t)) score += 2.5
      }
    }
    if (focusTag && entry.tags?.includes(focusTag)) score += 5
    if (focus && entry.focusUsed === focus) score += 4
    if (entry.tags && q && entry.tags.some((t) => q.includes(t) || t.includes(q.substring(0, 6)))) score += 2

    return { entry, score }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry)
}

/**
 * Async retrieval with optional semantic boost (Ollama embeddings).
 * - Always runs the strong keyword/recency/starred scoring (retrieveRelevant).
 * - When settings point to Ollama and we can embed the query + some entries have embeddings,
 *   we blend in cosine similarity as an extra high-signal booster (hybrid RAG).
 * - Keeps the spirit of "self-improvement from what user explicitly starred + recent".
 * - Falls back silently to pure kw path if embeddings unavailable.
 */
export async function retrieveRelevantAsync(
  query: string,
  focus?: string | null,
  limit = 3,
  settings?: AppSettings | null
): Promise<MemoryEntry[]> {
  // Base candidates via existing fast path (over-fetch a bit for re-rank opportunity)
  const base = retrieveRelevant(query, focus, Math.min(12, Math.max(limit, 6)))
  if (base.length === 0) return []

  const hasAnyEmbedding = base.some((e) => Array.isArray(e.embedding) && e.embedding.length > 0)
  const canTrySemantic = !!(settings && settings.aiProvider === 'ollama' && settings.ollamaBaseUrl && hasAnyEmbedding)

  if (!canTrySemantic) {
    return base.slice(0, limit)
  }

  try {
    const qEmb = await getOllamaEmbedding(query || 'reunión', settings!.ollamaBaseUrl, settings!.ollamaModel || 'nomic-embed-text')
    if (!qEmb) return base.slice(0, limit)

    const hybrid = base.map((entry) => {
      const sem = cosineSim(qEmb, entry.embedding)
      // Strong blend: keep original signals dominant, semantic as powerful tie-breaker / booster
      let extra = 0
      if (sem > 0.72) extra = 9
      else if (sem > 0.58) extra = 6
      else if (sem > 0.42) extra = 3.5
      else if (sem > 0.28) extra = 1.5
      const baseScore = (entry.starred ? 12 : 0) + extra + sem * 4
      return { entry, score: baseScore }
    })

    return hybrid
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry)
  } catch {
    return base.slice(0, limit)
  }
}

function focusToTag(f: string | null | undefined): string | null {
  if (!f) return null
  const m: Record<string, string> = {
    decisions: 'decision',
    actions: 'action',
    risks: 'risk',
    budget: 'budget',
    people: 'person',
  }
  return m[f] || null
}

/** Pure JS cosine similarity for two vectors (used for semantic memory retrieval). */
function cosineSim(a?: number[], b?: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const va = a[i]
    const vb = b[i]
    dot += va * vb
    na += va * va
    nb += vb * vb
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Helper to turn entries into concise injection strings for prompts (Spanish, high-signal, short).
 */
export function entriesToPromptSnippets(entries: MemoryEntry[], maxLen = 1200): string[] {
  const snippets: string[] = []
  let used = 0
  for (const en of entries) {
    const snip = en.text.length > 280 ? en.text.slice(0, 277) + '...' : en.text
    if (used + snip.length > maxLen) break
    snippets.push(snip)
    used += snip.length
  }
  return snippets
}

/**
 * Index high-value parts from a generated report into memory (beyond liveQAs).
 * Creates stable entries for keyInsights, recommendations, advice and todo tasks.
 * These become available for future live asks and reports (stronger self-improvement).
 * Tags: 'insight' | 'recommendation' | 'advice' | 'todo'
 */
export async function indexReportInsights(
  session: Session,
  report: any,
  settings?: AppSettings | null
): Promise<number> {
  if (!session || !report) return 0
  const newEntries: MemoryEntry[] = []
  const baseDate = session.date
  const sid = session.id

  const push = (text: string, tag: string, extraTags?: string[]) => {
    const id = `${sid}:insight:${newEntries.length}`
    newEntries.push({
      id,
      text: text.length > 420 ? text.slice(0, 417) + '...' : text,
      sessionId: sid,
      date: baseDate,
      tags: [tag, ...(extraTags || [])],
      starred: false,
    })
  }

  // Key insights (high signal)
  if (Array.isArray(report.keyInsights)) {
    report.keyInsights.slice(0, 6).forEach((ins: string) => {
      if (ins && ins.trim()) push(`Insight: ${ins}`, 'insight')
    })
  }
  // Summary as one compact memory
  if (report.summary && report.summary.trim()) {
    push(`Resumen de reunión: ${report.summary}`, 'insight', ['summary'])
  }
  // Recommendations
  if (Array.isArray(report.recommendations)) {
    report.recommendations.slice(0, 5).forEach((r: string) => {
      if (r && r.trim()) push(`Recomendación: ${r}`, 'recommendation')
    })
  }
  // Advice
  if (Array.isArray(report.advice)) {
    report.advice.slice(0, 4).forEach((a: string) => {
      if (a && a.trim()) push(`Consejo: ${a}`, 'advice')
    })
  }
  // Todo items as actionable memory
  if (Array.isArray(report.todoList)) {
    report.todoList.slice(0, 6).forEach((t: any) => {
      const task = typeof t === 'string' ? t : t?.task || ''
      if (task) push(`Acción: ${task}`, 'todo')
    })
  }

  if (newEntries.length === 0) return 0

  // Embeddings when possible (same as starred path)
  if (settings?.aiProvider === 'ollama' && settings.ollamaBaseUrl) {
    for (const ne of newEntries) {
      if (!ne.embedding) {
        try {
          const emb = await getOllamaEmbedding(ne.text, settings.ollamaBaseUrl, settings.ollamaModel || 'nomic-embed-text')
          if (emb) ne.embedding = emb
        } catch {}
      }
    }
  }

  try {
    const e = api()
    if (e?.indexMemoryEntries) {
      const added = await e.indexMemoryEntries(newEntries)
      await loadMemoryIndex()
      return added
    } else {
      await loadMemoryIndex()
      const byId = new Map(cached.map((en) => [en.id, en]))
      let added = 0
      for (const ne of newEntries) {
        if (!byId.has(ne.id)) {
          byId.set(ne.id, ne)
          added++
        }
      }
      await saveMemoryIndex(Array.from(byId.values()))
      return added
    }
  } catch (err) {
    console.warn('indexReportInsights failed', err)
    return 0
  }
}


