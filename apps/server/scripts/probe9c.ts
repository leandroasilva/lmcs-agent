// Scratch probe 3: the integer boundary `Schema.Int` draws, and the two config-dir shapes.

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as credits from "../src/provider/Layers/claudeResetCredits.ts";

const NOW = Date.parse("2026-05-08T12:00:00.000Z");

const count = (resetsLeft: unknown) =>
  console.log(
    `${typeof resetsLeft === "number" ? resetsLeft.toString() : JSON.stringify(resetsLeft)} => ${JSON.stringify(
      credits.claudeResetCreditsToContract(
        {
          eligible: true,
          grants: [{ id: "g1", resets_left: resetsLeft, usable_now: true }],
          next_grant_id: "g1",
        },
        NOW,
      ),
    )}`,
  );

console.log("## resets_left boundary (Schema.Int)");
for (const value of [
  0,
  1,
  2,
  9007199254740991,
  9007199254740992,
  9007199254740993,
  -9007199254740991,
  1e21,
  -0,
  0.5,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.EPSILON,
  "2",
  true,
  null,
  [],
]) {
  count(value);
}

console.log("## the same through raw JSON text, which is how the trace will spell it");
const viaText = (raw: string) => {
  try {
    var block = JSON.parse(
      `{"eligible":true,"grants":[{"id":"g1","resets_left":${raw},"usable_now":true}],"next_grant_id":"g1"}`,
    );
  } catch {
    console.log(`${raw} => the text does not parse as JSON at all`);
    return;
  }
  console.log(`${raw} => ${JSON.stringify(credits.claudeResetCreditsToContract(block, NOW))}`);
};
for (const raw of ["9007199254740992", "1e21", "1e20", "-0", "NaN", "Infinity", "2.0", "0000002"]) {
  viaText(raw);
}

console.log("## id boundary (GRANT_ID)");
for (const id of [
  "g",
  "g".repeat(40),
  "g".repeat(41),
  "g1_A-x",
  "g 1",
  "g-1",
  "g_1",
  "bé",
  "g\n1",
  "g\t1",
]) {
  console.log(
    `${JSON.stringify(id)} => ${JSON.stringify(
      credits.claudeResetCreditsToContract(
        { eligible: true, grants: [{ id, resets_left: 1, usable_now: true }], next_grant_id: id },
        NOW,
      ),
    )}`,
  );
}

console.log(
  "## request id boundary (REQUEST_ID) is only visible through the claim, so via regex reading:",
);
console.log(
  "grant path with configDir:",
  await Effect.runPromise(credits.claudeAccountConfigPath("").pipe(Effect.provide(Path.layer))),
);
console.log(
  "account path:",
  await Effect.runPromise(
    credits.claudeAccountConfigPath("/cfg with space").pipe(Effect.provide(Path.layer)),
  ),
);
