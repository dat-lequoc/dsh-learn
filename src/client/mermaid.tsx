/**
 * Mermaid diagram renderer for the Learn tab transcript. Architecture ported
 * from dsh-better-sidebar's `src/client/mermaid.tsx` (MIT-licensed, same
 * license as this package), scoped down for a v0.1 read-only transcript:
 * kept the security-critical sanitizer and the fence-swap-over-MarkdownText
 * rendering (both load-bearing for correctness); dropped the zoom/pan modal,
 * the copy button, and dark/light theme sync (polish, not correctness) and
 * the separate lazy-loaded chunk (mermaid ships in the main client bundle —
 * the Learn tab is already an opt-in, low-traffic surface, so the extra
 * bundle-route/ETag-revalidation infrastructure isn't earning its keep here).
 *
 * Rendering architecture unchanged from upstream: the whole document renders
 * ONCE through DSH's shared `MarkdownText` (cross-fence reference/footnote/
 * list semantics stay intact), then a layout effect swaps every rendered
 * `language-mermaid` code block for a diagram, keeping the React-managed
 * `.md-code-block` host node in the tree.
 *
 * @module dsh-learn/client/mermaid
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import mermaid from 'mermaid'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { sanitizeSvg } from './mermaid-sanitize.ts'
import { splitMermaidBlocks } from './mermaid-blocks.ts'

/** Monotonic id seed: every render call gets a fresh, document-unique id. */
let mermaidSeq = 0

/** Configure mermaid (idempotent; static light theme — no dark/light sync in v0.1). */
function configureMermaid(): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: 'default',
  })
}

/** First lines of a mermaid error (its dumps are huge; the head explains). */
function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n').slice(0, 6).join('\n')
}

/** One rendered mermaid fence: diagram, or an error plus the raw source. */
function MermaidDiagram({ code }: { code: string }): ReactNode {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)
    if (code.trim() === '') return () => { cancelled = true }
    configureMermaid()
    const id = `dsh-learn-mermaid-${mermaidSeq += 1}`
    mermaid.render(id, code)
      .then(({ svg: rendered }) => {
        if (cancelled) return
        const clean = sanitizeSvg(rendered)
        if (clean === '') {
          setError('Diagram could not be rendered safely.')
          return
        }
        setSvg(clean)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(summarizeError(reason))
      })
    return () => { cancelled = true }
  }, [code])

  return (
    <div>
      {error !== null && <div role="alert">{error}</div>}
      {svg !== null && <div data-mermaid-diagram dangerouslySetInnerHTML={{ __html: svg }} />}
      {error !== null && <pre><code>{code}</code></pre>}
    </div>
  )
}

/** One swapped mount: the diagram root + the CodeBlock children it displaced. */
interface MermaidMount {
  root: Root
  source: string
  removed: ChildNode[]
}

/** Fence bodies of every mermaid fence in the source, trailing-whitespace-normalized. */
function mermaidFenceBodies(text: string): Set<string> {
  const bodies = new Set<string>()
  for (const block of splitMermaidBlocks(text)) {
    if (block.kind === 'mermaid') bodies.add(block.code.trimEnd())
  }
  return bodies
}

/** The block's fence body as rendered: CodeBlock trims one trailing newline. */
function blockBody(block: HTMLElement): string {
  return (block.querySelector('code')?.textContent ?? '').trimEnd()
}

/** True when a rendered CodeBlock is a mermaid fence (by class hint or body match). */
function isMermaidBlock(block: HTMLElement, bodies: ReadonlySet<string>): boolean {
  const code = block.querySelector('code')
  if (code === null) return false
  if ([...code.classList].some(c => c.startsWith('language-mermaid'))) return true
  return bodies.has(blockBody(block))
}

/**
 * Transcript markdown renderer: one `MarkdownText` pass, then every rendered
 * mermaid code block is swapped for a diagram.
 */
export function MermaidMarkdown({ text, labels }: { text: string; labels: MarkdownLabels }): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  const mountsRef = useRef(new Map<HTMLElement, MermaidMount>())

  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const mounts = mountsRef.current
    const seen = new Set<HTMLElement>()
    const bodies = mermaidFenceBodies(text)

    for (const block of container.querySelectorAll<HTMLElement>('.md-code-block')) {
      const mount = mounts.get(block)
      const isMermaid = isMermaidBlock(block, bodies)
      if (!isMermaid) {
        if (mount !== undefined) {
          mount.root.unmount()
          block.replaceChildren(...mount.removed)
          block.removeAttribute('data-mermaid-processed')
          mounts.delete(block)
        }
        continue
      }
      seen.add(block)
      const source = block.querySelector('code')?.textContent ?? ''
      if (mount !== undefined && mount.source === source) continue
      if (mount === undefined) {
        const host = document.createElement('div')
        const removed = [...block.childNodes]
        block.replaceChildren(host)
        block.setAttribute('data-mermaid-processed', 'true')
        const root = createRoot(host)
        mounts.set(block, { root, source, removed })
        root.render(<MermaidDiagram code={source} />)
      } else {
        mount.source = source
        mount.root.render(<MermaidDiagram code={source} />)
      }
    }

    for (const [block, mount] of mounts) {
      if (seen.has(block)) continue
      mount.root.unmount()
      mounts.delete(block)
    }
  }, [text])

  useEffect(() => () => {
    for (const { root } of mountsRef.current.values()) root.unmount()
    mountsRef.current.clear()
  }, [])

  return (
    <div ref={containerRef}>
      <MarkdownText text={text} labels={labels} />
    </div>
  )
}
