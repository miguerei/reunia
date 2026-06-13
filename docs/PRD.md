# PRD — ReunIA

**Producto:** ReunIA — Grabador de reuniones con informes de IA, 100% local-first
**Owner:** Miguel Reina
**Estado:** v0.3.1 — Coach IA en vivo, captura dual, proveedor Gemini gratis, instalación de un comando + hardening de seguridad
**Última actualización:** 2026-06-13

---

## 1. Visión

Que cualquier persona del equipo pueda **grabar cualquier llamada o reunión con un clic** (Google Meet, Zoom, presencial) y obtener en minutos un **informe estructurado por IA** — resumen, insights, asistentes, recomendaciones y to-do list — **sin depender de un SaaS externo, sin cuentas compartidas y sin que el audio salga de su máquina** (salvo que el usuario elija OpenAI).

### Por qué local-first

- **Privacidad:** las reuniones contienen información sensible de negocio y de clientes. Con Ollama, nada sale del PC.
- **Coste:** sin suscripción por asiento. Con OpenAI el coste es ~0,5–2 céntimos por reunión de 30 min; con Ollama, cero.
- **Control:** cada miembro instala su propia copia, usa su propia clave y conserva sus grabaciones en su disco.

## 2. Usuarios y casos de uso

| Usuario | Caso de uso principal |
|---|---|
| Miembro del equipo en llamadas comerciales/internas | Graba la llamada, recibe informe + to-dos, comparte el `informe.md` |
| Manager | Revisa informes y to-do lists de las reuniones de su equipo |
| Cualquier usuario en reunión presencial | Graba con el micrófono y genera acta automática |

**Flujo crítico (happy path):** abrir app → (primer uso: pegar API key u Ollama) → pulsar grabar o `Cmd/Ctrl+Shift+R` → terminar → la IA transcribe y genera el informe → revisar to-dos → exportar/compartir.

## 3. Principios de producto

1. **Un clic para grabar.** Cualquier fricción antes de grabar es un bug de producto.
2. **El informe es el producto.** El audio y la transcripción son medios; el valor está en el informe accionable.
3. **Local por defecto, nube por elección.** OpenAI es una opción explícita del usuario.
4. **Instalación de 2 minutos.** Descargar de GitHub Releases → instalar → pegar key → listo.
5. **Invisible durante la reunión.** Modos compacto/stealth para no distraer ni filtrar contexto al compartir pantalla.

## 4. Alcance actual (v0.2.0) — qué ya está hecho

- ✅ Grabación micrófono + audio del sistema (BlackHole en macOS / VB-Cable en Windows)
- ✅ Atajo global `Cmd/Ctrl+Shift+R`, bandeja del sistema, power-save blocker
- ✅ Transcripción con Whisper (OpenAI) o endpoint local compatible
- ✅ Informe estructurado (resumen, insights, asistentes, intervenciones, recomendaciones, consejos, to-do list editable)
- ✅ Triple provider: **Gemini (gratis)**, OpenAI (de pago) u Ollama (100% local)
- ✅ Preguntas en vivo durante la reunión (buffer rolling) + memoria local de auto-mejora (RAG con ★)
- ✅ Sesiones guardadas en `~/Documents/ReunIA/<fecha>_<tema>/` (audio + transcript + report.json + informe.md)
- ✅ Exportación: Markdown, JSON, DOCX, PDF, ZIP
- ✅ Reproducción con waveform (wavesurfer)
- ✅ Modos compacto (pill), stealth y ventana companion always-on-top
- ✅ Onboarding: modal de bienvenida en primer arranque + Ajustes se abre solo + guía de 3 pasos
- ✅ Seguridad: settings cifrados, prompts endurecidos contra inyección, IPC con validación de rutas, Actions pineadas por SHA
- ✅ Distribución: GitHub Releases con instaladores DMG (mac x64+arm64) y EXE (Windows NSIS)
- ✅ Auto-updates con electron-updater (manifiestos `latest*.yml` publicados en cada release)

## 5. Roadmap — de menos a más

### v0.2.x — Fiabilidad de distribución (ahora)

*Objetivo: que cualquier persona del equipo instale sin fricción y reciba updates solas.*

| # | Item | Estado |
|---|---|---|
| 1 | CI verde (lockfile sync, lint, typecheck) | ✅ esta versión |
| 2 | Release workflow funcional: DMG + EXE + zip + manifiestos de auto-update generados por Actions | ✅ esta versión |
| 3 | Firma + notarización macOS (elimina el "app dañada" de Gatekeeper) | ⏳ requiere cuenta Apple Developer (99 USD/año) — secrets documentados en `release.yml` |
| 4 | Landing/demo (`preview.html`) desplegada con CTAs de descarga | ⏳ opcional |

### v0.3 — Live Coach + captura total + instalación fácil + seguridad ✅ (esta versión)

*Objetivo: experiencia tipo Read AI, gratis y local, sin fricción de instalación.*

- ✅ **Live Coach**: botón "resumen de los últimos minutos" durante la grabación → resumen, tono de la conversación, sugerencias de mejora en tiempo real, perfil psicológico/comunicativo estimado del interlocutor y nombres detectados.
- ✅ **Captura dual de audio**: micrófono + audio del sistema (BlackHole/VB-Cable) mezclados en una sola grabación con WebAudio, para videollamadas con varias personas.
- ✅ **Detección de nombres** del interlocutor en el informe final y en el Live Coach.
- ✅ **Instalación de un comando** (mismo concepto en Mac y Windows): `install.sh` (curl … | bash) e `install.ps1` (irm … | iex) que descargan el último release, instalan y abren la app.
- ✅ **Hardening de seguridad** (ver §10): contención de rutas en IPC, bloqueo de navegación, CSP, permisos de CI por job, dependencias sin CVEs.
- ✅ **Bug crítico de arranque corregido**: el proceso Electron se compilaba como ESM bajo `"type":"module"`, lo que rompía la app al abrir (`__dirname`/import de electron-updater). Ahora se compila a CommonJS.

### v0.4 — Calidad del informe

*Objetivo: que el informe sea tan bueno que nadie quiera tomar notas a mano.*

- Diarización básica de hablantes (quién dijo qué) — vía Whisper timestamps + heurística o pyannote local
- Plantillas de informe por tipo de reunión (comercial, 1:1, daily, brainstorm)
- Re-generar informe con instrucciones del usuario ("hazlo más corto", "enfócate en riesgos")
- Idioma de salida configurable (ES/EN)
- **Mover las llamadas a OpenAI/Ollama al main process** detrás de IPC (hoy la API key vive en el renderer con `dangerouslyAllowBrowser`; la CSP ya acota la exfiltración como mitigación).
- **Firma + notarización** de los instaladores para activar la verificación de firma en el auto-update (hoy los builds van sin firmar; ver §10).
- Tipar los contratos IPC y eliminar los `any` (deuda técnica marcada en eslint como warning)

### v0.4 — Flujo de equipo

*Objetivo: que el valor fluya del individuo al equipo sin renunciar a local-first.*

- Compartir informe a Slack/email con un clic (opt-in, solo el informe, nunca el audio)
- Exportar to-dos a herramientas de tareas (ClickUp/Linear/Notion)
- Carpeta de equipo opcional (Drive/sincronizada) solo para `informe.md`

### v1.0 — Madurez

- Detección automática de inicio de reunión (calendario o detección de Meet/Zoom activos) con sugerencia de grabar
- Búsqueda semántica sobre todas las reuniones pasadas (RAG local ampliado)
- Captura nativa de audio del sistema sin BlackHole/VB-Cable (ScreenCaptureKit en macOS / WASAPI loopback en Windows)
- Onboarding interactivo con verificación de audio (test de niveles antes de la primera reunión)

## 6. No-objetivos (por ahora)

- ❌ Backend/SaaS propio, cuentas de usuario o sincronización en la nube
- ❌ Bot que se une a las llamadas como participante (tipo Fireflies/Otter)
- ❌ Grabación de vídeo
- ❌ App móvil

## 7. Métricas de éxito

| Métrica | Objetivo v0.2 |
|---|---|
| Tiempo desde descarga hasta primera grabación | < 5 min |
| Miembros del equipo con la app instalada y ≥1 informe generado | 100% del equipo objetivo |
| Reuniones grabadas que terminan en informe generado | > 90% |
| Coste por reunión (OpenAI) | < 0,05 USD |
| Fallos de instalación reportados | 0 (tras firma de macOS) |

## 8. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Gatekeeper macOS bloquea builds sin firma | Alto (fricción de instalación) | Workaround `xattr -cr` documentado; plan: Apple Developer + notarización (secrets ya soportados en CI) |
| Configurar BlackHole/VB-Cable es la mayor fricción del onboarding | Alto | Guía paso a paso en README + onboarding; v1.0: captura nativa sin drivers |
| Calidad variable de informes con Ollama en modelos pequeños | Medio | Recomendar modelos concretos (qwen2.5, gemma2); OpenAI como default de calidad |
| Costes de API inesperados | Bajo | Estimación de coste visible; Whisper+GPT ≈ céntimos por reunión |
| Legalidad de grabar llamadas | Medio | El usuario es responsable de avisar a los participantes; añadir recordatorio en onboarding |

## 9. Decisiones técnicas (registro)

- **Electron + React 19 + TS + Tailwind + Zustand** — velocidad de desarrollo y multiplataforma.
- **MediaRecorder** para captura (multiplataforma, sin nativos) — limitación: requiere driver virtual para audio del sistema; se acepta hasta v1.0.
- **Distribución por GitHub Releases + electron-updater** — sin infraestructura propia; el repo es la fuente de verdad.
- **electron-store cifrado** para la API key; nunca en texto plano ni en logs.
- **Lint:** reglas `no-explicit-any`/`set-state-in-effect` en warning hasta tipar el puente IPC (v0.4).
- **Proceso Electron en CommonJS** (`dist-electron/package.json` con `{"type":"commonjs"}`) aunque el paquete raíz sea ESM, para evitar fallos de `__dirname` e interop con módulos CJS (electron-updater).

## 10. Seguridad y privacidad (auditoría v0.3)

Auditoría multi-agente (Electron/IPC, privacidad de datos, secretos, prompt-injection, supply chain, branding/PII) con verificación adversarial.

**Corregido en v0.3:**
- **Contención de rutas en IPC**: `session:save-full` saneaba mal el nombre de carpeta (path traversal) y `audio/report/transcript:load` + `shell:open-path`/`show-item-in-folder` no validaban contención al directorio de almacenamiento. Ahora todo se valida contra `getStorageBase()`.
- **Hardening de navegación Electron**: `setWindowOpenHandler` + `will-navigate` en ambas ventanas; los enlaces externos abren en el navegador del SO, no dentro de la app.
- **Content-Security-Policy** en el renderer empaquetado: `connect-src` limitado a `api.openai.com` + localhost (acota exfiltración).
- **CI con permisos por job** (`build: read`, `release: write`) + `persist-credentials: false` para que el token no quede en `.git/config` durante los postinstall.
- **Dependencias**: jspdf actualizado a v4 + override de dompurify → `npm audit --omit=dev` = 0 vulnerabilidades.
- **Branding/PII**: eliminadas menciones a la empresa; autor = "Miguel Reina"; LICENSE con titular; identidad de git con email noreply.

**Diseño local-first (privacidad):** sin telemetría; audio, transcripciones, informes y memoria RAG se quedan en el disco del usuario. Con Ollama no sale nada a internet; con OpenAI solo se envían audio y texto a `api.openai.com` con la clave personal del usuario.

**Deuda de seguridad pendiente (v0.4):**
- **Auto-update sin firma**: los builds van sin firmar, así que el auto-update no puede verificar firma de código. `autoDownload` está desactivado (requiere acción del usuario). Mitigar con firma Apple/Authenticate + `verifyUpdateCodeSignature`/`publisherName`, y publicar attestations de provenance.
- **Llamadas IA en el renderer** (`dangerouslyAllowBrowser`): mover al main process tras IPC para reducir el radio de impacto ante una dependencia npm comprometida (la CSP es la mitigación intermedia).
- **Electron 31 (EOL)**: subir a una línea con soporte; sin ruta de explotación remota plausible hoy (HTML local, `contextIsolation` activo, sin `dangerouslySetInnerHTML`).
- **encryptionKey fija** de electron-store (ofuscación en reposo, no a prueba de atacante local): evaluar keychain del SO.
