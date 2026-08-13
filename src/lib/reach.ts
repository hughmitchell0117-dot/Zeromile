/**
 * The reach envelope: which corridors can still be run and still get home.
 *
 * The customer gives us three things — how much of the day is left, where the
 * truck is now, and which garage it has to end at. Everything drawn on the map
 * as "reachable" is a function of exactly those three and nothing else.
 *
 * For a corridor a→b the question is whether the whole shape fits:
 *
 *     now → a  (deadhead out)
 *     a → b    (the load itself)
 *     b → garage  (deadhead home)
 *     plus a dock stop at each end
 *
 * If that total fits the remaining duty hours, the corridor is in the
 * envelope, and the slack left over is how brightly it burns. This is the
 * same arithmetic `settle()` does for a one-leg tour — the envelope is not a
 * decorative approximation of the solver, it is the solver's own feasibility
 * test applied to every corridor at once.
 *
 * It is deliberately a *single-leg* envelope. A two-leg chain can reach
 * further, so the lit area is the conservative floor: everything shown is
 * genuinely reachable, and the solver is free to beat it.
 */

import { SITES, primarySite } from './sites';
import { LEG_HANDLING_HOURS, MAX_DUTY_HOURS, hrs } from './model';

export type ReachInput = {
  /** City id the truck is at now. */
  current: string;
  /** City id of the garage it has to finish at. */
  garage: string;
  /** Duty hours left in the day. */
  budgetHours: number;
};

export type ReachEdge = {
  a: string;
  b: string;
  /** Duty hours the round trip costs, out and home included. */
  cost: number;
  /** 0 at the ragged edge of the day, 1 with the whole day to spare. */
  slack: number;
  /**
   * The end the truck enters this corridor from, and the hours before and
   * during it. A corridor isn't reached at one moment — the truck deadheads to
   * `entry` over `out` hours and then drives the corridor itself over `leg`,
   * which is what lets the map flood along the road rather than switch it on.
   */
  entry: string;
  out: number;
  leg: number;
};

export type Reach = {
  input: ReachInput;
  /** Corridors that fit, richest slack first. */
  inside: ReachEdge[];
  /** Corridors that don't — drawn as the unlit remainder of the network. */
  outside: { a: string; b: string }[];
};

/**
 * What the day actually allows, given a shift window, a self-declared driving
 * limit and the legal ceiling. The tightest of the three wins.
 */
export function dutyBudget(
  startHour: number,
  deadlineHour: number,
  maxDriveHours: number,
): number {
  return Math.max(0, Math.min(deadlineHour - startHour, maxDriveHours, MAX_DUTY_HOURS));
}

/** Cost of running a→b and getting home. All ids here are docks, not cities. */
function legCost(current: string, a: string, b: string, garage: string): number {
  return hrs(current, a) + hrs(a, b) + hrs(b, garage) + LEG_HANDLING_HOURS;
}

export function computeReach(input: ReachInput): Reach {
  const { current, garage, budgetHours } = input;
  // The UI asks for cities; freight moves between docks. Anchor on the primary
  // dock of each, the same way `driverStart` does, so the envelope is measured
  // against the same points the solver will actually route through.
  const from = primarySite(current).id;
  const home = primarySite(garage).id;

  const inside: ReachEdge[] = [];
  const outside: { a: string; b: string }[] = [];

  for (let i = 0; i < SITES.length; i++) {
    for (let j = i + 1; j < SITES.length; j++) {
      const a = SITES[i].id;
      const b = SITES[j].id;

      // A corridor is a piece of road, not a direction. Run it whichever way
      // is cheaper from where the truck stands.
      const ab = legCost(from, a, b, home);
      const ba = legCost(from, b, a, home);
      const cost = Math.min(ab, ba);

      if (budgetHours > 0 && cost <= budgetHours) {
        const entry = ab <= ba ? a : b;
        const exit = ab <= ba ? b : a;
        inside.push({
          a,
          b,
          cost,
          slack: 1 - cost / budgetHours,
          entry,
          out: hrs(from, entry),
          leg: hrs(entry, exit),
        });
      } else {
        outside.push({ a, b });
      }
    }
  }

  inside.sort((x, y) => y.slack - x.slack);
  return { input, inside, outside };
}