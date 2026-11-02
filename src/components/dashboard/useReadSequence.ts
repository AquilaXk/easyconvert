import { useCallback, useRef } from 'react';

/**
 * The order of the reads of one list: each read takes the next number, and only the latest may apply its answer, so an
 * older read that answers after a newer one is dropped (a newer request supersedes an older one).
 */
export function useReadSequence(): () => () => boolean {
  const latest = useRef(0);
  return useCallback(() => {
    const read = ++latest.current;
    return () => read === latest.current;
  }, []);
}
