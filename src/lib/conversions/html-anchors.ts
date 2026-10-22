import type { HtmlElement } from './html-blocks';

/**
 * The names an element is a link target by (HTML Living Standard, "the indicated part of the document"): its `id`, and
 * for an `a` its `name` unless an element has that `id`. Every element is a target, not only those drawn as blocks.
 */

const ANCHOR_ELEMENT = 'a';

/** The `id` of every element under `root`. */
export function documentIds(root: HtmlElement): Set<string> {
  const ids = new Set<string>();
  const pending: HtmlElement[] = [root];
  for (let element = pending.pop(); element !== undefined; element = pending.pop()) {
    const id = element.attrs.get('id');
    if (id) ids.add(id);
    for (const child of element.children) {
      if (typeof child !== 'string') pending.push(child);
    }
  }
  return ids;
}

/** The names `element` is a link target by, given every `id` of the document (an `a` named like one of them is not what a fragment finds). */
export function anchorNamesOf(element: HtmlElement, ids: ReadonlySet<string>): string[] {
  const names: string[] = [];
  const id = element.attrs.get('id');
  if (id) names.push(id);
  const name = element.tag === ANCHOR_ELEMENT ? element.attrs.get('name') : undefined;
  if (name && name !== id && !ids.has(name)) names.push(name);
  return names;
}
