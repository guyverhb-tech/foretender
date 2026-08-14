/**
 * The grading projection over an existing raw store (brief req 6; §5.3; plan
 * slice-5 step 8). Offline, pure disk I/O: it reads the predictions ledger and
 * the raw store, grades each prediction against the subsequent stored notices,
 * and rebuilds two DERIVED siblings — `verdicts.ndjson` and `scoreboard.json`.
 *
 * §5.1: this reads a STRUCTURAL `PredictionRecord` from `predictions.ndjson` and
 * never imports `src/prediction` — the ledger file is the only coupling. Like the
 * prediction projection these are deterministic FULL REBUILDS (rebuildable views
 * of `(store + priors + asof)`, not append-only ledgers), ocid-sorted with fixed
 * key order, so two runs over the same store and `--asof` are byte-identical.
 * `--asof` is validated offset-explicit at entry.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEventsByOcid, toNdjson } from '../lifecycle/read.js';
import { requireOffsetIso } from '../lifecycle/date.js';
import { grade } from './grade.js';
import { calibrate } from './calibrate.js';
import type { PredictionRecord, Scoreboard, Verdict } from './model.js';

/** Format a rejected value for an error message without throwing on `undefined`. */
const describe = (v: unknown): string => (v === undefined ? 'undefined' : JSON.stringify(v));

/**
 * Read the predictions ledger as the structural subset the grader consumes.
 *
 * The `predictions.ndjson` file is the ONLY coupling to the predictor (§5.1): the
 * grader binds to field NAMES, not to the predictor's `Prediction` type, so the
 * seam has no compile-time link. A shape drift — a predictor-side key rename, a
 * hand-corrupted row — would otherwise degrade SILENTLY: a non-numeric
 * `predictedProbability` coerces to NaN and poisons the Brier fold; an offset-less
 * `expectedResolutionDate` parses to a null epoch and drops every verdict to
 * `pending`. So each row is validated on read and a malformed one THROWS, naming
 * the field and locating the row — matching the loud failure a malformed-JSON line
 * already gets, and serving the "fail loudly on unmapped shapes" bar (BUILD_BRIEF
 * §5.4). The happy path is unchanged: every row `projectPredictions` emits passes.
 */
function readPredictionRecords(path: string): PredictionRecord[] {
  const out: PredictionRecord[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    const where = `predictions.ndjson row ${i + 1}` +
      (typeof r['ocid'] === 'string' ? ` (ocid ${r['ocid']})` : '');

    const ocid = r['ocid'];
    if (typeof ocid !== 'string') {
      throw new Error(`${where}: field «ocid» must be a string, got ${describe(ocid)}`);
    }
    const noticeType = r['noticeType'];
    if (noticeType !== null && typeof noticeType !== 'string') {
      throw new Error(
        `${where}: field «noticeType» must be a string or null, got ${describe(noticeType)}`,
      );
    }
    const predictedProbability = r['predictedProbability'];
    if (typeof predictedProbability !== 'number' || !Number.isFinite(predictedProbability)) {
      throw new Error(
        `${where}: field «predictedProbability» must be a finite number, got ${describe(predictedProbability)}`,
      );
    }
    const madeAt = r['madeAt'];
    if (typeof madeAt !== 'string') {
      throw new Error(`${where}: field «madeAt» must be a string, got ${describe(madeAt)}`);
    }
    const expectedResolutionDate = r['expectedResolutionDate'];
    if (typeof expectedResolutionDate !== 'string') {
      throw new Error(
        `${where}: field «expectedResolutionDate» must be a string, got ${describe(expectedResolutionDate)}`,
      );
    }
    // Offset-carrying ISO required: a bare/parse-failing date silently mis-grades.
    requireOffsetIso(expectedResolutionDate, `${where}: field «expectedResolutionDate»`);

    out.push({ ocid, noticeType, predictedProbability, expectedResolutionDate, madeAt });
  }
  return out;
}

export function gradePredictions(
  rootDir: string,
  opts: { asof: string; version?: string },
): Scoreboard {
  requireOffsetIso(opts.asof, '--asof');

  const records = readPredictionRecords(join(rootDir, 'predictions.ndjson'));
  const byOcid = readEventsByOcid(rootDir);

  // Grade ocid-ascending so verdicts.ndjson is ocid-sorted and byte-reproducible.
  const ordered = [...records].sort((a, b) => (a.ocid < b.ocid ? -1 : a.ocid > b.ocid ? 1 : 0));
  const verdicts: Verdict[] = ordered.map((rec) => grade(rec, byOcid.get(rec.ocid) ?? [], opts));

  writeFileSync(join(rootDir, 'verdicts.ndjson'), toNdjson(verdicts));

  const scoreboard = calibrate(verdicts);
  writeFileSync(join(rootDir, 'scoreboard.json'), `${JSON.stringify(scoreboard, null, 2)}\n`);
  return scoreboard;
}
