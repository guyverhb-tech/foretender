/**
 * The tender projection over an existing raw store (brief reqs 5–6; §5.3; plan
 * step 4). Offline and pure disk I/O: it reads the append-only store, normalises
 * every tender-tagged release, and rebuilds two DERIVED sibling files —
 * `canonical.ndjson` and `anomalies.ndjson` — plus a `ProjectionSummary`
 * (counts, anomaly rate, regime split, per-regime field coverage).
 *
 * The projection is a deterministic FULL REBUILD (truncate-then-write in
 * `releases.ndjson` order with fixed key order), not an append: it is a
 * re-derivable view of the source-of-truth raw store, so two runs over the same
 * store produce byte-identical output (orchestrator ruling; §5.3). A partial
 * file on interrupt is acceptable for an offline batch tool — the next run
 * rebuilds it wholesale.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAcceptedReleases, readPageBody } from '../store/raw-store.js';
import { normaliseTender } from './normalise.js';
import type { CanonicalLot, CanonicalTender, TenderAnomaly } from './model.js';

export interface UkpgaCoverage {
  n: number;
  amountGross: number;
  coreAmount: number;
  cpv: number;
  lotContractPeriod: number;
  deadline: number;
  mainProcurementCategory: number;
  hasRenewalTrue: number;
}

export interface CelexCoverage {
  n: number;
  amount: number;
  cpv: number;
  lotDurationInDays: number;
  lotEndDate: number;
  tenderPeriodEnd: number;
  mainProcurementCategory: number;
}

export interface ProjectionSummary {
  tenderReleases: number;
  canonical: number;
  anomalies: number;
  anomalyRate: number;
  regime: { UKPGA: number; CELEX: number };
  fieldCoverage: { ukpga: UkpgaCoverage; celex: CelexCoverage };
}

interface PackagePage {
  releases?: unknown[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Count records for which `pred` holds — the coverage-over-canonical basis. */
const count = <T>(rs: T[], pred: (r: T) => boolean): number => rs.filter(pred).length;
const anyLot = (c: CanonicalTender, pred: (lot: CanonicalLot) => boolean): boolean =>
  c.lots.some(pred);

/** NDJSON: one record per line, trailing newline; an empty list yields an empty file. */
const toNdjson = (records: unknown[]): string =>
  records.map((r) => `${JSON.stringify(r)}\n`).join('');

export function projectTenders(rootDir: string): ProjectionSummary {
  const accepted = readAcceptedReleases(rootDir);
  const pageCache = new Map<string, PackagePage>();
  const canonical: CanonicalTender[] = [];
  const anomalies: TenderAnomaly[] = [];

  for (const rec of accepted) {
    let pkg = pageCache.get(rec.bodyHash);
    if (pkg === undefined) {
      const body = readPageBody(rootDir, rec.bodyHash);
      pkg = JSON.parse(new TextDecoder().decode(body)) as PackagePage;
      pageCache.set(rec.bodyHash, pkg);
    }
    const releases = Array.isArray(pkg.releases) ? pkg.releases : [];
    const release = releases.find((r) => isObject(r) && r['id'] === rec.id);
    if (release === undefined) {
      // The accepted-release projection points at a body that must contain it
      // by id; a miss means a tampered/mismatched store, so fail loud.
      throw new Error(`release ${rec.id} not found in page ${rec.bodyHash}`);
    }
    // Tender-tag filter: `tag` INCLUDES "tender" (captures dual planning,tender).
    const tags = isObject(release) ? release['tag'] : undefined;
    if (!Array.isArray(tags) || !tags.includes('tender')) continue;

    const result = normaliseTender(release);
    if (result.kind === 'canonical') canonical.push(result);
    else anomalies.push(result);
  }

  writeFileSync(join(rootDir, 'canonical.ndjson'), toNdjson(canonical));
  writeFileSync(join(rootDir, 'anomalies.ndjson'), toNdjson(anomalies));

  const ukpga = canonical.filter((c) => c.regime === 'UKPGA');
  const celex = canonical.filter((c) => c.regime === 'CELEX');
  const tenderReleases = canonical.length + anomalies.length;

  return {
    tenderReleases,
    canonical: canonical.length,
    anomalies: anomalies.length,
    anomalyRate: tenderReleases === 0 ? 0 : anomalies.length / tenderReleases,
    regime: { UKPGA: ukpga.length, CELEX: celex.length },
    fieldCoverage: {
      ukpga: {
        n: ukpga.length,
        amountGross: count(ukpga, (c) => c.value.gross !== null),
        coreAmount: count(ukpga, (c) => c.value.net !== null),
        cpv: count(ukpga, (c) => c.cpv.length > 0),
        lotContractPeriod: count(ukpga, (c) =>
          anyLot(c, (l) => l.contractPeriod.startDate !== null || l.contractPeriod.endDate !== null),
        ),
        deadline: count(ukpga, (c) => c.deadline !== null),
        mainProcurementCategory: count(ukpga, (c) => c.mainProcurementCategory !== null),
        hasRenewalTrue: count(ukpga, (c) => anyLot(c, (l) => l.hasRenewal === true)),
      },
      celex: {
        n: celex.length,
        amount: count(celex, (c) => c.value.net !== null),
        cpv: count(celex, (c) => c.cpv.length > 0),
        lotDurationInDays: count(celex, (c) => anyLot(c, (l) => l.contractPeriod.durationInDays !== null)),
        lotEndDate: count(celex, (c) => anyLot(c, (l) => l.contractPeriod.endDate !== null)),
        tenderPeriodEnd: count(celex, (c) => c.deadline !== null),
        mainProcurementCategory: count(celex, (c) => c.mainProcurementCategory !== null),
      },
    },
  };
}
