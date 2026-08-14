/**
 * The per-ocid identity model (slice 6). Type-only module mirroring
 * `normalise/model.ts` and `lifecycle/model.ts`: it fixes the output contract
 * that the pure resolver (`extract.ts`), the projection (`project.ts`), and the
 * contract tests bind to.
 *
 * An `Identity` is the human-legible face of a procurement, resolved across ALL
 * of its release types (planning/tender/award) — so a pending planning-only
 * prediction, which the tender canonical never covers, can still be named by its
 * title, buyer, and value. Each field is read from the LATEST release (by numeric
 * notice id) that provides a non-null value; a field absent from every release is
 * `null`. A null title/buyer is NORMAL — this layer records a presence RATE, it
 * has no anomaly channel and never fails loud on absence.
 *
 * `value` mirrors the slice-3 discipline exactly: gross is the UK-extension
 * `amountGross`, net is the core `amount`, currency alongside — kept distinct,
 * never mixed.
 */

export interface Identity {
  ocid: string;
  title: string | null;
  buyer: string | null;
  /** Gross (UK `amountGross`) and net (core `amount`) kept distinct, never mixed. */
  value: {
    gross: number | null;
    net: number | null;
    currency: string | null;
  };
  /** The release id that supplied `title` (null when no release carried one). */
  sourceReleaseId: string | null;
}

/**
 * The projection's inspectable roll-up over one raw store: the ocid count plus,
 * per resolved field, how many identities carry a non-null value and the rate
 * over all ocids. A rate below 100% is a valid observation, not an error.
 */
export interface IdentitySummary {
  ocids: number;
  title: number;
  buyer: number;
  gross: number;
  net: number;
  currency: number;
  rate: {
    title: number;
    buyer: number;
    gross: number;
    net: number;
    currency: number;
  };
}
