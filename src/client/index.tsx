/**
 * dsh-learn client half: registers one "Learn" tab into dsh-better-sidebar's
 * native right sidebar. Pure additive consumer of `ctx.betterSidebar` — no
 * DSH source and no dsh-better-sidebar source are touched. `inject =
 * ['betterSidebar']` means this Cordis fiber only activates once
 * dsh-better-sidebar's service is ready; when that plugin is absent from the
 * profile entirely, this whole module simply never activates (no crash, no
 * visible trace) — the documented optional-peer no-op path.
 *
 * @module dsh-learn/client
 */
import type {} from 'dsh-better-sidebar/client/service'
import type { Context } from '@deepseek-ai/cordis'
import { LearnView } from './LearnView.tsx'

export const inject = ['betterSidebar']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'dsh-learn:learn',
    title: 'Learn',
    description: 'Guided learning: transcript, quiz, notes, and a compact composer — all in one place.',
    order: 60,
    single: true,
    component: (props) => <LearnView {...props} />,
  }))
}
