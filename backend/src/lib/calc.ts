/**
 * Re-export so backend code can `import { computeShares } from './calc.ts'`
 * while the implementation stays in shared/ — the Mini App runs the same
 * reconciliation to preview totals, and two copies of that arithmetic would
 * eventually disagree by a cent.
 */
export {
  CalcError,
  computeShares,
  deriveFactor,
  expandUnits,
  reconcilesToSubtotal,
  subtotalOf,
  summaryDelta,
  unassignedCents,
  type PersonAssignment,
} from '../../../shared/calc.ts';
