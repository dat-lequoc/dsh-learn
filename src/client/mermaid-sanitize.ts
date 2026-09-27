/**
 * SVG sanitization for mermaid-rendered diagrams in the Learn tab transcript.
 * Ported verbatim from dsh-better-sidebar's `src/client/mermaid-sanitize.ts`
 * (MIT-licensed, same license as this package): the transcript renders
 * assistant markdown, which is untrusted-origin the same
 * way a previewed file is, so the same defense-in-depth belongs here
 * unweakened. See the upstream file for the full security rationale
 * (foreignObject/script/event-handler/href stripping); this is a direct
 * copy, not a reinterpretation.
 *
 * @module dsh-learn/client/mermaid-sanitize
 */

/** Element local names stripped case-insensitively (all lowercase). */
const STRIP_ELEMENTS = new Set([
  'foreignobject',
  'script',
  'img',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'input',
  'button',
  'form',
  'link',
  'meta',
  'base',
])

/** A parse failure keeps nothing of the input: the caller shows the error. */
export function sanitizeSvg(svg: string): string {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return ''
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  } catch {
    return ''
  }
  if (doc.querySelector('parsererror') !== null) return ''
  if (doc.documentElement === null || doc.documentElement.localName !== 'svg') return ''
  doc.querySelectorAll('*').forEach((node) => {
    if (STRIP_ELEMENTS.has(node.localName.toLowerCase())) {
      node.remove()
      return
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name
      const normalized = name.toLowerCase()
      if (normalized.startsWith('@') || normalized.startsWith('on')) {
        node.removeAttribute(name)
        continue
      }
      if (normalized === 'href' || normalized === 'xlink:href') {
        node.removeAttribute(name)
      }
    }
  })
  return new XMLSerializer().serializeToString(doc.documentElement)
}
