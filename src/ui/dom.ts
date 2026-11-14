/** Minimal element builder; avoids innerHTML for anything containing text. */
type Attrs = Readonly<Record<string, string | number | boolean | null | undefined>>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: ReadonlyArray<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

/** Parses a trusted, static SVG icon string (no user data). */
export function icon(svgMarkup: string): SVGElement {
  const template = document.createElement('template');
  template.innerHTML = svgMarkup.trim();
  const svg = template.content.firstElementChild;
  if (!(svg instanceof SVGElement)) throw new Error('icon: invalid SVG markup');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
