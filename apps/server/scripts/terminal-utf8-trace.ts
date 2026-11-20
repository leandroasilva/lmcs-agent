import * as NodeStringDecoder from "node:string_decoder";
import * as Schema from "effect/Schema";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
let count = 0;

const record = (name: string, chunks: ReadonlyArray<Uint8Array>) => {
  const decoder = new NodeStringDecoder.StringDecoder("utf8");
  const writes = chunks.map((chunk) => decoder.write(Buffer.from(chunk)));
  process.stdout.write(
    encode({
      name,
      chunks: chunks.map((chunk) => Buffer.from(chunk).toString("hex")),
      writes,
      end: decoder.end(),
      reset: decoder.write(Buffer.from([0xa9, 0x6f, 0x6b])),
      secondEnd: decoder.end(),
    }) + "\n",
  );
  count += 1;
};

record("empty", []);
record("emptyReads", [new Uint8Array(), new Uint8Array()]);
record("burst", [Buffer.alloc(4096, 0x20)]);

for (let first = 0; first < 256; first += 1) {
  record(`byte/${first}`, [Uint8Array.of(first)]);
  for (let second = 0; second < 256; second += 1) {
    record(`pair/${first}/${second}/whole`, [Uint8Array.of(first, second)]);
    record(`pair/${first}/${second}/split`, [Uint8Array.of(first), Uint8Array.of(second)]);
  }
}

const samples: ReadonlyArray<readonly [string, ReadonlyArray<number>]> = [
  ["nulControls", [0, 0x1b, 0x5b, 0x33, 0x31, 0x6d]],
  ["two", [0xc3, 0xa9]],
  ["three", [0xe2, 0x82, 0xac]],
  ["four", [0xf0, 0x9f, 0x98, 0x80]],
  ["minThree", [0xe0, 0xa0, 0x80]],
  ["maxScalar", [0xf4, 0x8f, 0xbf, 0xbf]],
  ["beforeSurrogates", [0xed, 0x9f, 0xbf]],
  ["afterSurrogates", [0xee, 0x80, 0x80]],
  ["surrogate", [0xed, 0xa0, 0x80]],
  ["overlongTwo", [0xc0, 0x80]],
  ["overlongThree", [0xe0, 0x80, 0x80]],
  ["overlongFour", [0xf0, 0x80, 0x80, 0x80]],
  ["outOfRange", [0xf4, 0x90, 0x80, 0x80]],
  ["invalidFourLead", [0xf5, 0x80, 0x80, 0x80]],
  ["notALead", [0xf8, 0x80, 0x80, 0x80]],
  ["brokenThree", [0xe2, 0x82, 0x41]],
  ["brokenFour", [0xf0, 0x9f, 0x98, 0xff]],
  ["newLead", [0xe2, 0x82, 0xc3, 0xa9]],
  ["adjacent", [0xc3, 0xa9, 0xe2, 0x82, 0xac]],
];

for (const [name, sample] of samples) {
  const bytes = Uint8Array.from(sample);
  for (let length = 1; length <= bytes.length; length += 1) {
    for (let mask = 0; mask < 2 ** (length - 1); mask += 1) {
      const chunks: Uint8Array[] = [new Uint8Array()];
      let start = 0;
      for (let index = 1; index < length; index += 1) {
        if ((mask & (1 << (index - 1))) !== 0) {
          chunks.push(bytes.slice(start, index), new Uint8Array());
          start = index;
        }
      }
      chunks.push(bytes.slice(start, length), new Uint8Array());
      record(`sample/${name}/${length}/${mask}`, chunks);
    }
  }
}

let seed = 0x1234abcd;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed >>> 16;
};
for (let index = 0; index < 1024; index += 1) {
  const bytes = Uint8Array.from({ length: 1 + (random() % 64) }, () => random() & 0xff);
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length;) {
    const end = Math.min(bytes.length, start + 1 + (random() % 8));
    chunks.push(bytes.slice(start, end));
    start = end;
  }
  record(`random/${index}`, chunks);
}

process.stderr.write(`UTF-8 trace cases: ${count}\n`);
