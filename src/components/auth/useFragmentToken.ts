'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The token of a mailed link, read from the URL fragment (`#token=...`). A fragment is not sent to any server and not
 * passed on in a Referer header, so the link's token stays between the mail and this page; it is taken out of the address
 * bar once read. `ready` is false until the fragment has been read, and `token` is then the value or null when there is none.
 */
export function useFragmentToken(): { ready: boolean; token: string | null } {
  const [state, setState] = useState<{ ready: boolean; token: string | null }>({ ready: false, token: null });
  // The first reading is kept: React runs an effect twice in development, and the second run finds the fragment gone.
  const read = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (read.current === undefined) {
      read.current = new URLSearchParams(globalThis.location.hash.replace(/^#/, '')).get('token') || null;
      if (globalThis.location.hash) {
        globalThis.history.replaceState(null, '', `${globalThis.location.pathname}${globalThis.location.search}`);
      }
    }
    setState({ ready: true, token: read.current });
  }, []);
  return state;
}
