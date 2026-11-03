import { notFound } from 'next/navigation';

/** A path of two or more segments under a locale is no page of the site; it meets the same localized 404 page as a path of one segment that is none. */
export default function UnknownPath(): never {
  notFound();
}
