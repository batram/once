import { Lexer, type Token } from "marked"

/** Markdown supplies tokens only; the host creates every element and attribute. */
export function trayMarkdown(text: string): DocumentFragment {
  try { return render(new Lexer({ gfm: true }).lex(text)) }
  catch {
    const fallback = document.createDocumentFragment()
    fallback.append(document.createTextNode(text))
    return fallback
  }
}

function literal(text: string): Text { return document.createTextNode(text) }

function decoded(text: string): string {
  if (!text.includes("&")) return text
  // Decode entities without ever passing a tag to the HTML parser.
  const field = document.createElement("div")
  field.innerHTML = text.replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return field.textContent ?? ""
}

function render(tokens: Token[], depth = 0): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const token of tokens) {
    if (depth >= 32) { fragment.append(literal(token.raw)); continue }
    const children = (items: Token[] = []) => render(items, depth + 1)
    const element = (tag: string, items?: Token[]) => {
      const node = document.createElement(tag)
      node.append(children(items))
      fragment.append(node)
      return node
    }
    switch (token.type) {
      case "space": case "def": break
      case "heading": element(`h${token.depth}`, token.tokens); break
      case "paragraph": element("p", token.tokens); break
      case "blockquote": element("blockquote", token.tokens); break
      case "strong": element("strong", token.tokens); break
      case "em": element("em", token.tokens); break
      case "del": element("del", token.tokens); break
      case "hr": case "br": fragment.append(document.createElement(token.type)); break
      case "code": {
        const pre = document.createElement("pre")
        const code = document.createElement("code")
        code.textContent = token.text
        pre.append(code)
        fragment.append(pre)
        break
      }
      case "codespan": {
        const code = document.createElement("code")
        code.textContent = token.text
        fragment.append(code)
        break
      }
      case "list": {
        const list = document.createElement(token.ordered ? "ol" : "ul")
        if (token.ordered && token.start !== 1) list.setAttribute("start", String(token.start))
        for (const item of token.items) {
          const li = document.createElement("li")
          li.append(children(item.tokens))
          list.append(li)
        }
        fragment.append(list)
        break
      }
      case "link": {
        let url: URL | undefined
        try { url = new URL(decoded(token.href)) } catch { /* Relative links stay text. */ }
        if (url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
          const link = element("a", token.tokens) as HTMLAnchorElement
          link.href = url.href
          link.target = "_blank"
          link.rel = "noopener noreferrer"
        } else fragment.append(children(token.tokens))
        break
      }
      case "table": {
        const wrapper = document.createElement("div")
        wrapper.className = "addon_tray_table"
        const table = document.createElement("table")
        for (const [index, cells] of [token.header, ...token.rows].entries()) {
          const row = document.createElement("tr")
          for (const cell of cells) {
            const node = document.createElement(index === 0 ? "th" : "td")
            node.append(children(cell.tokens))
            row.append(node)
          }
          table.append(row)
        }
        wrapper.append(table)
        fragment.append(wrapper)
        break
      }
      case "text":
        fragment.append(token.tokens ? children(token.tokens) : literal(decoded(token.text)))
        break
      case "escape": fragment.append(literal(decoded(token.text))); break
      case "checkbox": fragment.append(literal(token.checked ? "☑ " : "☐ ")); break
      case "image": fragment.append(literal(decoded(token.text))); break
      default: fragment.append(literal(token.raw))
    }
  }
  return fragment
}
