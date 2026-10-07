// DOM-light anchoring: walks text nodes only, so it works in browsers and linkedom alike.
export type HighlightColor = "yellow" | "green" | "blue" | "pink";
export interface Anchor {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  color: HighlightColor;
  note?: string | null;
}

const CTX = 32;

interface Seg {
  node: Text;
  start: number;
  end: number;
}

function textSegments(root: Node): { segs: Seg[]; text: string } {
  const segs: Seg[] = [];
  let text = "";
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const t = c as Text;
        const v = t.data;
        segs.push({ node: t, start: text.length, end: text.length + v.length });
        text += v;
      } else if (c.nodeType === 1) {
        const tag = (c as Element).tagName?.toLowerCase();
        if (tag === "script" || tag === "style") continue;
        walk(c);
      }
    }
  };
  walk(root);
  return { segs, text };
}

export function contextFor(text: string, start: number, end: number): { prefix: string; suffix: string } {
  return { prefix: text.slice(Math.max(0, start - CTX), start), suffix: text.slice(end, end + CTX) };
}

function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Find the best offset of quote in text, using prefix/suffix to disambiguate repeats. */
export function findQuote(text: string, quote: string, prefix: string, suffix: string): number {
  if (!quote) return -1;
  let best = -1,
    bestScore = -1;
  let from = 0;
  for (;;) {
    const i = text.indexOf(quote, from);
    if (i < 0) break;
    const score =
      commonSuffixLen(text.slice(Math.max(0, i - prefix.length), i), prefix) +
      commonPrefixLen(text.slice(i + quote.length, i + quote.length + suffix.length), suffix);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
    from = i + 1;
  }
  return best;
}

/** Wrap [start,end) of the text content in <mark data-hid>, one mark per text node touched. */
function wrapRange(doc: Document, segs: Seg[], start: number, end: number, a: Anchor): number {
  let n = 0;
  // process in reverse so splitText does not invalidate earlier offsets
  for (const seg of [...segs].reverse()) {
    if (seg.end <= start || seg.start >= end) continue;
    const s = Math.max(start, seg.start) - seg.start;
    const e = Math.min(end, seg.end) - seg.start;
    if (e <= s) continue;
    const node = seg.node;
    const data = node.data;
    const mid = data.slice(s, e);
    if (!mid.trim()) continue; // whitespace-only fragments between blocks stay unmarked
    const parent = node.parentNode!;
    // manual split: not every DOM (linkedom) implements Text#splitText
    if (e < data.length) parent.insertBefore(doc.createTextNode(data.slice(e)), node.nextSibling);
    if (s > 0) parent.insertBefore(doc.createTextNode(data.slice(0, s)), node);
    const target = doc.createTextNode(mid);
    parent.replaceChild(target, node);
    const mark = doc.createElement("mark");
    mark.setAttribute("data-hid", a.id);
    mark.setAttribute("data-color", a.color);
    if (a.note) mark.setAttribute("data-note", "1");
    target.parentNode!.replaceChild(mark, target);
    mark.appendChild(target);
    n++;
  }
  return n;
}

/** Anchor one highlight. Returns true if found and wrapped. Re-walks the DOM so call order is safe. */
export function applyHighlight(root: Element, a: Anchor): boolean {
  const { segs, text } = textSegments(root);
  const idx = findQuote(text, a.quote, a.prefix, a.suffix);
  if (idx < 0) return false;
  const doc = root.ownerDocument;
  return wrapRange(doc, segs, idx, idx + a.quote.length, a) > 0;
}

export function applyHighlights(root: Element, anchors: Anchor[]): Set<string> {
  const ok = new Set<string>();
  for (const a of anchors) if (applyHighlight(root, a)) ok.add(a.id);
  return ok;
}

export function removeHighlight(root: Element, id: string): void {
  for (const m of Array.from(root.querySelectorAll(`mark[data-hid="${id}"]`))) {
    const p = m.parentNode;
    if (!p) continue;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
  }
  root.normalize();
}

/** Offsets of a selection range within root's text, for building quote/prefix/suffix. */
export function selectionAnchor(
  root: Element,
  range: Range,
): { quote: string; prefix: string; suffix: string } | null {
  const { segs, text } = textSegments(root);
  const find = (node: Node, off: number, isEnd: boolean): number => {
    if (node.nodeType === 3) {
      for (const s of segs) if (s.node === node) return s.start + off;
      return -1;
    }
    // element boundary: resolve to the adjacent child's text
    const kids = node.childNodes;
    if (isEnd) {
      const child = kids[off - 1];
      const inside = child ? segs.filter((s) => child === s.node || child.contains(s.node)) : [];
      return inside.length ? inside[inside.length - 1]!.end : -1;
    }
    const child = kids[off];
    const inside = child ? segs.filter((s) => child === s.node || child.contains(s.node)) : [];
    return inside.length ? inside[0]!.start : -1;
  };
  let start = find(range.startContainer, range.startOffset, false);
  let end = find(range.endContainer, range.endOffset, true);
  if (start < 0 || end < 0 || end <= start) return null;
  // trim whitespace
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (end <= start) return null;
  return { quote: text.slice(start, end), ...contextFor(text, start, end) };
}
