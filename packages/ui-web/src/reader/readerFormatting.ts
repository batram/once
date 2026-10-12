import { ReaderBlockEdit, ReaderBlockKind, ReaderFormatBlock } from "@once/core"

const PROTECTED = "pre,code,table,math,svg,figure,video,audio,iframe"
export function captureFormatBlocks(article: HTMLElement): { blocks: ReaderFormatBlock[]; apply(edits: ReaderBlockEdit[]): void } {
  const nodes = [...article.querySelectorAll<HTMLElement>("p,h1,h2,h3,h4,h5,h6,li")].filter(node => !node.closest(PROTECTED) && !node.querySelector(`${PROTECTED},p,li,h1,h2,h3,h4,h5,h6`) && !!node.textContent?.trim())
  const blocks = nodes.map((node, index) => ({ id: `b${index}`, text: node.textContent ?? "", ...(node.childElementCount === 0 ? { repairable: true } : {}), kind: (["p", "h2", "h3", "h4", "li"].includes(node.localName) ? node.localName : "h2") as ReaderBlockKind }))
  return { blocks, apply(edits) {
    if (edits.length !== nodes.length || nodes.some((node, index) => !article.contains(node) || node.textContent !== blocks[index].text || edits[index].id !== blocks[index].id || (edits[index].text !== undefined && node.childElementCount > 0))) throw new Error("Reader content changed; original retained")
    for (const [index, edit] of edits.entries()) {
      const node = nodes[index]
      if (edit.text !== undefined && edit.text !== blocks[index].text) {
        const paragraphs = edit.kind === "p" ? edit.text.split(/\n\s*\n/).filter(text => text.trim()) : [edit.text]
        const replacements = paragraphs.map(text => { const next = document.createElement(node.localName === "li" ? "li" : edit.kind === "li" ? "p" : edit.kind); next.textContent = text; return next })
        node.replaceWith(...replacements)
        continue
      }
      // Existing list structure is retained; list items cannot become invalid direct list children.
      if (node.localName === "li" || node.localName === edit.kind) continue
      const replacement = document.createElement(edit.kind)
      while (node.firstChild) replacement.append(node.firstChild)
      if (edit.kind === "li") {
        const previous = node.previousElementSibling
        const list = previous?.localName === "ul" ? previous : document.createElement("ul")
        if (!list.parentElement) node.before(list)
        list.append(replacement); node.remove()
      } else node.replaceWith(replacement)
    }
  } }
}
