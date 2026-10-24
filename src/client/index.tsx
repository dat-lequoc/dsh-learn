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
import type { ReactNode } from 'react'
import type {} from 'dsh-better-sidebar/client/service'
import type { Context } from '@deepseek-ai/cordis'
import { LearnView } from './LearnView.tsx'
import css from './LearnView.module.css'

export const inject = ['betterSidebar']

/** Token-colored mortarboard glyph for the tab strip, chip, and guide. */
function renderLearnTabIcon(size = 14): ReactNode {
  return (
    <span className={css.tabIcon} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M8 2L1.25 5.5L8 9L13.5 6.15V10.5H14.75V5.5L8 2Z"
          fill="currentColor"
        />
        <path
          d="M3.75 7.9V11.1C3.75 12.35 5.65 13.5 8 13.5C10.35 13.5 12.25 12.35 12.25 11.1V7.9L8 10.1L3.75 7.9Z"
          fill="currentColor"
          fillOpacity="0.82"
        />
      </svg>
    </span>
  )
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'dsh-learn:learn',
    title: 'Learn',
    description: 'Guided learning: the lesson with its quizzes inline.',
    icon: renderLearnTabIcon,
    order: 60,
    single: true,
    component: (props) => <LearnView {...props} />,
  }))
}
