import type { Session, Report } from '../types'
import { format } from 'date-fns'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'

/**
 * Creates a nice folder name based on date + inferred topic.
 * In a future version the AI can suggest a better slug.
 */
export function createSessionFolderName(session: Session): string {
  const d = new Date(session.date)
  const datePart = format(d, 'yyyy-MM-dd_HH-mm')
  const safeTitle = (session.topic || session.title)
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return `${datePart}_${safeTitle || 'Reunion'}`
}

/**
 * Best-effort save of a complete session (audio + transcript + report + metadata).
 * Tries to use Electron main process first (via IPC). 
 * Falls back to downloading a ZIP in the browser.
 */
export async function saveSessionToDisk(
  session: Session,
  transcript: string | undefined,
  report: Report | undefined,
  audioBlob: Blob,
  suggestedFolder?: string
): Promise<string | boolean> {
  const folderName = suggestedFolder || createSessionFolderName(session)
  const api = (window as any).electron

  // Try native save via main process (we will add the handler)
  if (api) {
    try {
      const result = await api.invoke?.('session:save-full', {
        folderName,
        session,
        transcript,
        report,
        audioBuffer: await audioBlob.arrayBuffer(),
      })
      if (result?.success && result.folderPath) {
        return result.folderPath
      }
    } catch (e) {
      console.warn('Native save failed, falling back to ZIP download', e)
    }
  }

  // Fallback: generate a nice ZIP the user can expand into their ReunIA folder
  const zip = new JSZip()
  const audioExt = audioBlob.type.includes('webm') ? 'webm' : 'wav'
  zip.file(`${folderName}/audio.${audioExt}`, audioBlob)
  zip.file(`${folderName}/metadata.json`, JSON.stringify(session, null, 2))

  if (transcript) {
    zip.file(`${folderName}/transcript.txt`, transcript)
  }
  if (report) {
    const md = generateMarkdownReport(session, report)
    zip.file(`${folderName}/informe.md`, md)
    zip.file(`${folderName}/report.json`, JSON.stringify(report, null, 2))
  }

  const content = await zip.generateAsync({ type: 'blob' })
  saveAs(content, `${folderName}.zip`)

  return true
}

function generateMarkdownReport(session: Session, report: Report): string {
  return `# ${session.title}

**Fecha:** ${new Date(session.date).toLocaleString('es-ES')}
**Duración:** ${Math.floor(session.durationSec / 60)} minutos

## Resumen

${report.summary}

## Insights clave

${report.keyInsights.map(i => `- ${i}`).join('\n')}

## Personas asistentes

${report.attendees.map(p => `- ${p}`).join('\n') || '_No detectadas explícitamente_'}

## Personas que intervinieron

${report.speakers.map(p => `- ${p}`).join('\n') || '_No detectadas explícitamente_'}

## Recomendaciones

${report.recommendations.map(r => `- ${r}`).join('\n')}

## Consejos

${report.advice.map(a => `- ${a}`).join('\n')}

## Lista de acciones (To-Do)

${report.todoList.map(t => `- [${t.done ? 'x' : ' '}] ${t.task}`).join('\n')}

---
*Generado automáticamente por ReunIA • ${new Date().toISOString()}*
`
}

// Future: function to scan a directory and reconstruct sessions from metadata.json files
export async function scanSessionsFolder(_basePath: string): Promise<Session[]> {
  // Will be implemented with IPC call to main (fs.readdir + read metadata)
  return []
}
