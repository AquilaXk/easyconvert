import { minuteSurcharge } from '../billing/credits';
import type { ChargeOptions } from './reservation-ledger';

/**
 * What a conversion was when it succeeded, for its reservation to be charged by (docs/policy-decisions.md, entry 285): the reservation
 * holds the base cost of the conversion's class, and the end of it adds one credit for every started minute of processing beyond the
 * first, so a long conversion costs more than a short one of the same class and a fast one never costs less than the base.
 */
export interface ConversionCharge {
  /** The source and target format ids; absent for a tool, which has none. */
  from?: string;
  to?: string;
  /** Credits of the class, which the reservation holds. */
  base: number;
  /** How long each conversion of the reservation ran, in milliseconds; a batch gives one for each file. */
  processingMs?: number | readonly number[];
  /** `batch` for the charge of a batch of files, which the note then names as such. */
  kind?: 'batch';
}

/** The surcharge and the note the ledger charges at the end of a reservation. */
export function chargeOptionsOf(charge: ConversionCharge): ChargeOptions {
  const times = charge.processingMs === undefined ? [] : [charge.processingMs].flat();
  const surcharge = times.reduce((sum, ms) => sum + minuteSurcharge(ms), 0);
  return {
    extra: surcharge,
    note: {
      ...(charge.from === undefined ? {} : { from: charge.from }),
      ...(charge.to === undefined ? {} : { to: charge.to }),
      base: charge.base,
      ...(surcharge > 0 ? { surcharge } : {}),
      ...(charge.kind === undefined ? {} : { kind: charge.kind }),
    },
  };
}
