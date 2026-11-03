import { notFound } from 'next/navigation';

/**
 * A path of two or more segments under a locale is no page of the site; it meets the same localized 404 page as a path of one
 * segment that is none. The metadata answers 404 as well: without it the layout's title travels in the payload the browser
 * hydrates from, and the tab reads the home page's title after the page has loaded.
 */
export function generateMetadata(): never {
  notFound();
}

export default function UnknownPath(): never {
  notFound();
}
