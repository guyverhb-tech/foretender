/**
 * The calibration segment, shared DOWNWARD by the prediction and grading layers.
 * Placed in lifecycle — the home both layers already depend on — so the single
 * definition lives in one place and neither layer imports the other (§5.1). This
 * is a classification label only; it never drives lifecycle state.
 *
 * `None` is the CATCH bucket: a noticeType that is not exactly `UK1`/`UK2`/`UK3` —
 * null OR an unexpected string — lands here deliberately. noticeType has no schema
 * enum (pipeline-volume.md), so unknown codes are EXPECTED; each is priced at the
 * `default` prior and its raw value is preserved verbatim on the record, so it
 * stays individually observable even though its calibration is tracked under `None`.
 */
export type Segment = 'UK1' | 'UK2' | 'UK3' | 'None';

/** The calibration segment for a noticeType — exact `UK1`/`UK2`/`UK3`, else `None`. */
export const segmentOf = (noticeType: string | null): Segment =>
  noticeType === 'UK1' || noticeType === 'UK2' || noticeType === 'UK3' ? noticeType : 'None';
