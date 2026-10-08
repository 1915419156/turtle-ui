/**
 * Context keys a launcher provides so the terminal can hand its session off in
 * place, print the command that resumes it, and seed a guided fresh session.
 *
 * The keys live in one module shared by the two entries — the startup provider
 * (`./startup`) that provides them and the TUI (`./index`) that reads them —
 * so the two sides cannot drift apart.
 * @module @deepseek-ai/dsh-tui/host-keys
 */

/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(TUI_RESUME_HOST_KEY, host)`) to give the TUI an in-place resume
 * host. The TUI's `/resume` handoff calls `host.handoff(sessionId, cwd)` after
 * releasing the terminal; absent leaves a session selectable but not resumable
 * in place.
 */
export const TUI_RESUME_HOST_KEY = 'tuiResumeHost'

/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(TUI_GOODBYE_MESSAGE_KEY, line)`) to supply the line the TUI
 * prints once the terminal is released on exit — for the shipped CLI, the
 * command that resumes this session. The launcher owns the wording because only
 * it knows how it was invoked; the TUI escapes terminal controls before
 * rendering. Absent prints nothing.
 */
export const TUI_GOODBYE_MESSAGE_KEY = 'tuiGoodbyeMessage'

/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(INITIAL_SKILL_KEY, name)`) to seed a fresh session's first user
 * turn with `/skill:<name>` — the guided-session entry. The launcher sets it
 * only when minting a fresh session, so it never re-fires on a resumed one.
 * Absent leaves the first turn to the user.
 */
export const INITIAL_SKILL_KEY = 'tuiInitialSkill'
