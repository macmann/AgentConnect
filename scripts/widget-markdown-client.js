import { marked } from "marked";

// Parse Markdown in an inert template, then rebuild only allowed DOM nodes.
// Provider HTML, event attributes, images, and executable URLs never reach the page.
export function renderMarkdown(parent, text) {
  const template = document.createElement("template");
  template.innerHTML = marked.parse(String(text || ""), {
    gfm: true,
    breaks: true,
    async: false,
  });
  const tags = new Set([
    "P",
    "BR",
    "STRONG",
    "EM",
    "DEL",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "UL",
    "OL",
    "LI",
    "BLOCKQUOTE",
    "PRE",
    "CODE",
    "HR",
    "TABLE",
    "THEAD",
    "TBODY",
    "TR",
    "TH",
    "TD",
    "A",
  ]);
  function safe(node) {
    if (node.nodeType === 3) return document.createTextNode(node.textContent);
    const fragment = document.createDocumentFragment();
    if (node.nodeType !== 1) return fragment;
    if (
      [
        "SCRIPT",
        "STYLE",
        "IFRAME",
        "OBJECT",
        "SVG",
        "MATH",
        "TEMPLATE",
      ].includes(node.tagName)
    )
      return fragment;
    const target = tags.has(node.tagName)
      ? document.createElement(node.tagName.toLowerCase())
      : fragment;
    if (node.tagName === "A") {
      const href = node.getAttribute("href") || "";
      try {
        const url = new URL(href, location.href);
        if (["https:", "http:", "mailto:"].includes(url.protocol)) {
          target.setAttribute("href", url.href);
          target.setAttribute("target", "_blank");
          target.setAttribute("rel", "noopener noreferrer");
        }
      } catch {
        /* Keep the link text for invalid URLs. */
      }
    }
    if (node.tagName === "OL" && /^\d+$/.test(node.getAttribute("start") || ""))
      target.setAttribute("start", node.getAttribute("start"));
    for (const child of node.childNodes) target.append(safe(child));
    return target;
  }
  parent.replaceChildren(...Array.from(template.content.childNodes, safe));
  parent.classList.add("markdown-content");
}
