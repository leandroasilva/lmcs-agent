// Scratch probe 2: the timestamp half of claudeResetCreditsToContract, with dates strictly
// after the reference instant so "future" and "well-formed" stop being the same answer.

import * as credits from "../src/provider/Layers/claudeResetCredits.ts";

const NOW = Date.parse("2026-05-08T12:00:00.000Z");

const one = (endsAt: unknown) =>
  console.log(
    `${JSON.stringify(endsAt)} => ${JSON.stringify(
      credits.claudeResetCreditsToContract(
        {
          eligible: true,
          grants: [{ id: "g1", resets_left: 2, usable_now: true, ends_at: endsAt }],
          next_grant_id: "g1",
        },
        NOW,
      ),
    )}`,
  );

// The shape questions the first probe left unasked.
console.log("## block shape");
for (const block of [
  { eligible: true },
  { eligible: true, grants: [grant()] },
  { eligible: true, grants: "no" },
  { eligible: true, grants: [null, 5, "x", {}, grant()] },
  { eligible: true, grants: [grant()], extra: 1 },
  { eligible: null, grants: [grant()] },
]) {
  console.log(
    `${JSON.stringify(block)} => ${JSON.stringify(credits.claudeResetCreditsToContract(block, NOW))}`,
  );
}
function grant(): Record<string, unknown> {
  return { id: "g1", resets_left: 2, usable_now: true };
}

console.log("## timestamps, all after NOW unless the row says so");
for (const endsAt of [
  "2026-05-08T12:00:00.001Z",
  "2026-05-08T12:00:00Z",
  "2026-05-08T12:00:00.000Z",
  "2026-05-08T13:00:00Z",
  "2026-05-08T11:00:00Z",
  "2027-01-01T00:00:00Z",
  "2027-02-29T00:00:00Z",
  "2028-02-29T00:00:00Z",
  "2026-02-30T00:00:00Z",
  "2026-04-31T00:00:00Z",
  "2026-05-32T00:00:00Z",
  "2026-12-32T00:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-00-10T00:00:00Z",
  "2026-05-08T25:00:00Z",
  "2026-05-08T12:60:00Z",
  "2026-05-08T12:00:60Z",
  "2026-05-08T12:00:00+02:00",
  "2026-05-08T23:00:00+02:00",
  "2026-05-08T12:00:00-03:30",
  "2026-05-08T12:00:00+0200",
  "2026-05-08T12:00:00+00:00",
  "2026-05-08T12:00:00.123456Z",
  "2026-05-08T12:00:00.1Z",
  "2026-05-08T12:00:00.12Z",
  "2026-05-08T12:00:00.Z",
  "2026-05-08t12:00:00z",
  "2026-05-08T12:00:00z",
  "2026-05-08t12:00:00Z",
  " 2026-05-09T00:00:00Z",
  "2026-05-09T00:00:00Z ",
  "2026-05-09",
  "2026-05-09 00:00:00",
  "2026-05-09T00:00:00",
  "Fri, 09 May 2026 00:00:00 GMT",
  "05/09/2026",
  "2026-05-09T00:00:00Z[Europe/Berlin]",
  "2026-05-09T00:00:00 GMT",
  "9999-12-31T23:59:59Z",
  "275760-09-13T00:00:00Z",
  "-000001-01-01T00:00:00Z",
  "2026-05-08T12:00:00.000+00:00",
  "2026-05-09T00:00:00+14:00",
  "2026-05-08T00:00:00-14:00",
  1777000000000,
  true,
  [],
  {},
  null,
  undefined,
  "",
  "not a date",
]) {
  one(endsAt);
}

console.log("## next-grant pairing, with a live non-next grant");
const show = (label: string, block: unknown) =>
  console.log(`${label} => ${JSON.stringify(credits.claudeResetCreditsToContract(block, NOW))}`);
show("two-live-no-next", {
  eligible: true,
  grants: [
    { id: "g1", resets_left: 3, usable_now: true },
    { id: "g2", resets_left: 4, usable_now: true },
  ],
});
show("next-is-g2", {
  eligible: true,
  grants: [
    { id: "g1", resets_left: 3, usable_now: true },
    { id: "g2", resets_left: 4, usable_now: true, ends_at: "2026-06-01T00:00:00Z" },
  ],
  next_grant_id: "g2",
});
show("next-matches-expired", {
  eligible: true,
  grants: [
    { id: "g1", resets_left: 3, usable_now: true },
    { id: "g2", resets_left: 4, usable_now: true, ends_at: "2026-05-01T00:00:00Z" },
  ],
  next_grant_id: "g2",
});
show("sum-over-twelve", {
  eligible: true,
  grants: Array.from({ length: 12 }, (_, index) => ({
    id: `g${index}`,
    resets_left: 1,
    usable_now: true,
  })),
  next_grant_id: "g0",
});
