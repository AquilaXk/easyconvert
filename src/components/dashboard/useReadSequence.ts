import { useMemo, useRef } from 'react';

/** The reads of one list, of which only the latest may apply its answer. */
export interface ReadSequence {
  /** Starts a read and returns whether it is still the latest when its answer comes, so an older answer is dropped. */
  begin: () => () => boolean;
}

/** The order of the reads of one list: a newer read supersedes an older one that answers after it. */
export function useReadSequence(): ReadSequence {
  const latest = useRef(0);
  return useMemo(
    () => ({
      begin: () => {
        const read = ++latest.current;
        return () => read === latest.current;
      },
    }),
    []
  );
}
