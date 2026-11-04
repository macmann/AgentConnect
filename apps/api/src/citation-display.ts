/** Remove reference markers without exposing partial markers during streaming. */
export class CitationTextFilter {
  private pending = "";
  private whitespace = "";
  private code = "";
  private lineStart = true;
  private labelDepth = 0;
  private afterLabel = false;
  private destinationDepth = 0;

  push(text: string) {
    this.pending += text;
    return this.drain(false);
  }
  finish() {
    return this.drain(true);
  }
  private drain(final: boolean) {
    let out = this.whitespace;
    this.whitespace = "";
    let i = 0;
    const consume = (n: number, show = true) => {
      const part = this.pending.slice(i, i + n);
      if (show) out += part;
      for (const char of part) {
        if (char === "\n") this.lineStart = true;
        else if (!/[ \t\r]/.test(char)) this.lineStart = false;
      }
      i += n;
    };
    while (i < this.pending.length) {
      const char = this.pending[i]!;
      if (this.afterLabel) {
        this.afterLabel = false;
        if (char === "(") {
          this.destinationDepth = 1;
          consume(1);
          continue;
        }
      }
      if (this.destinationDepth) {
        if (char === "\\") {
          if (!final && i + 1 === this.pending.length) break;
          consume(Math.min(2, this.pending.length - i));
          continue;
        }
        if (char === "(") this.destinationDepth++;
        if (char === ")") this.destinationDepth--;
        consume(1);
        continue;
      }
      if (
        char === "`" ||
        (char === "~" && (this.lineStart || this.code[0] === "~"))
      ) {
        let n = 1;
        while (this.pending[i + n] === char) n++;
        if (!final && i + n === this.pending.length) break;
        if (!this.code && (char === "`" || n >= 3)) this.code = char.repeat(n);
        else if (
          this.code[0] === char &&
          (n === this.code.length ||
            (this.code.length >= 3 && this.lineStart && n >= this.code.length))
        )
          this.code = "";
        consume(n);
        continue;
      }
      if (this.code) {
        consume(1);
        continue;
      }
      if (char === "\\") {
        if (!final && i + 1 === this.pending.length) break;
        consume(Math.min(2, this.pending.length - i));
        continue;
      }
      if (char === "[") {
        const rest = this.pending.slice(i);
        const marker = rest.match(
          /^\[\d+(?:[ \t]*[,;–-][ \t]*\d+)*[ \t]*\]/,
        )?.[0];
        if (marker) {
          const next = this.pending[i + marker.length];
          if (!final && next === undefined) break;
          // Numeric Markdown link labels/definitions are content, not citations.
          if (next === "(" || (next === ":" && this.lineStart)) {
            consume(marker.length);
            this.afterLabel = next === "(";
          } else {
            out = out.replace(/[ \t]+$/, "");
            consume(marker.length, false);
          }
          continue;
        }
        if (!final && rest.length < 256 && /^\[[\d \t,;–-]*$/.test(rest)) break;
      }
      if (char === "[") this.labelDepth++;
      if (char === "]" && this.labelDepth) {
        this.labelDepth--;
        this.afterLabel = true;
      }
      consume(1);
    }
    this.pending = this.pending.slice(i);
    if (!final) {
      this.whitespace = out.match(/[ \t]+$/)?.[0] ?? "";
      return out.slice(0, out.length - this.whitespace.length);
    }
    return out;
  }
}
export function withoutCitationMarkers(text: string) {
  const filter = new CitationTextFilter();
  return filter.push(text) + filter.finish();
}
/** Touch display fields only: never IDs, URLs, action arguments or file contents. */
export function withoutBlockCitations<T extends object>(blocks: T[]): T[] {
  return blocks.map((block) => {
    const copy = { ...block } as T & {
      title?: string;
      content?: string;
      type?: string;
      value?: unknown;
    };
    if (typeof copy.title === "string")
      copy.title = withoutCitationMarkers(copy.title);
    if (
      ["text", "card", "alert"].includes(copy.type ?? "") &&
      typeof copy.content === "string"
    )
      copy.content = withoutCitationMarkers(copy.content);
    if (copy.type === "kpi" && typeof copy.value === "string")
      copy.value = withoutCitationMarkers(copy.value);
    return copy;
  });
}
export function citationDisplay<T extends Record<string, unknown>>(
  message: T,
  required: boolean,
): T {
  if (
    required ||
    message.role !== "assistant" ||
    typeof message.content !== "string"
  )
    return message;
  return {
    ...message,
    content: withoutCitationMarkers(message.content),
    citations: [],
    ...(Array.isArray(message.blocks)
      ? { blocks: withoutBlockCitations(message.blocks) }
      : {}),
  };
}
