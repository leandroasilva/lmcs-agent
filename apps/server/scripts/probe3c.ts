import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

function go(label: string, fn: () => unknown) {
  try {
    console.log(`${label.padEnd(44)} => ${JSON.stringify(fn())}`);
  } catch (e) {
    console.log(
      `${label.padEnd(44)} !! ${(e as Error).message.split("\n").slice(0, 3).join(" | ")}`,
    );
  }
}

const refinementKey = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*$/)).check(
  Schema.isMaxLength(4),
);
const refinementRecord = Schema.Record(
  refinementKey as never,
  Schema.String as never,
) as unknown as Schema.Top;
const encR = Schema.encodeUnknownSync(refinementRecord);

console.log("--- ENCODE side of a refinement-keyed Record ---");
go("encode all-good", () => encR({ abc: "v", d: "w" }));
go("encode one over-long key", () => encR({ abcdef: "v", d: "w" }));
go("encode one pattern-failing key", () => encR({ BAD: "v", d: "w" }));
go("encode only a bad key", () => encR({ BAD: "v" }));
go("encode bad VALUE", () => encR({ d: 5 as unknown as string }));

const transformKey = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (value: string) => Effect.succeed(value.trim()),
      encode: (value: string) => Effect.succeed(value.trim()),
    }),
  ),
);
const transformRecord = Schema.Record(
  transformKey.check(Schema.isNonEmpty()) as never,
  Schema.Number as never,
) as unknown as Schema.Top;
const encT = Schema.encodeUnknownSync(transformRecord);
const decT = Schema.decodeUnknownSync(transformRecord);

console.log("--- ENCODE + collapse order of a transform-keyed Record ---");
go("encode {' a ':1}", () => encT({ " a ": 1 }));
go("encode {'':1, b:2}", () => encT({ "": 1, b: 2 }));
go("encode {'  ':1, b:2}", () => encT({ "  ": 1, b: 2 }));
go("decode {'a ':1, a:2}", () => decT({ "a ": 1, a: 2 }));
go("decode {a:2, 'a ':1}", () => decT({ a: 2, "a ": 1 }));

console.log("--- refinement key + isMaxProperties, encode counts ---");
const envLike = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z_]/)) as never,
  Schema.String as never,
).check(Schema.isMaxProperties(2)) as unknown as Schema.Top;
go("encode 3 keys, one pattern-failing", () =>
  Schema.encodeUnknownSync(envLike)({ A: "1", B: "2", "-": "3" }),
);
go("encode 2 good keys", () => Schema.encodeUnknownSync(envLike)({ A: "1", B: "2" }));
