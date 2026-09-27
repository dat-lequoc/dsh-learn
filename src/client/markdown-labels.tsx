/**
 * Chrome labels for DSH's shared `MarkdownText` (see
 * dsh-better-sidebar's `src/client/markdown-labels.tsx` for the full
 * contract rationale: the renderer takes a REQUIRED nested `labels` prop).
 * dsh-learn is English-only for v0.1 (no i18n system) — a fixed set of
 * strings, not resolved per-locale.
 *
 * @module dsh-learn/client/markdown-labels
 */
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Fixed English chrome labels for every transcript markdown render. */
export const TRANSCRIPT_MARKDOWN_LABELS: MarkdownLabels = {
  code: {
    copyLabel: 'Copy',
    copiedLabel: 'Copied',
    toolbarLabels: {
      codeLabel: 'Code',
      wrapLabel: 'Wrap',
      unwrapLabel: 'Unwrap',
    },
  },
  footnotes: '',
}
