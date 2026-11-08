import * as TerminalManager from "../src/terminal/Manager.ts";

const FRAGMENTS = [
  "",
  "a",
  "\n",
  "\n\n",
  "\r",
  "\r\n",
  "café",
  "名",
  "🚀",
  "\u001b[31m",
  "\u001b[0m",
  "\u001b]8;;url\u0007",
];

const retainedHistory = (text: string, maxLines: number, maxBytes: number): string => {
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) lines.pop();
  const retained = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  const capped = terminated ? `${retained}\n` : retained;
  if (Buffer.byteLength(capped) <= maxBytes) return capped;
  const points = Array.from(capped);
  let start = points.length;
  let bytes = 0;
  while (start > 0) {
    const next = Buffer.byteLength(points[start - 1]!);
    if (bytes + next > maxBytes) break;
    bytes += next;
    start -= 1;
  }
  return points.slice(start).join("");
};

const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
const out: string[] = [];

for (const maxBytes of [0, 3, 8, 64, Number.POSITIVE_INFINITY]) {
  for (const maxLines of [0, 1, 3, 5, 5_000]) {
    let seed = 0x2026_0904;
    const nextFragment = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return FRAGMENTS[seed % FRAGMENTS.length]!;
    };

    out.push(`C ${maxLines} ${Number.isFinite(maxBytes) ? maxBytes : "INF"}`);
    out.push(`I ${hex("before\ninitial\n")}`);

    const history = new TerminalManager.BoundedTerminalHistory(
      maxLines,
      "before\ninitial\n",
      maxBytes,
    );
    let expected = retainedHistory("before\ninitial\n", maxLines, maxBytes);
    const oracle = (value: string, label: string) => {
      if (value !== expected) {
        throw new Error(
          `oracle disagrees with the shipped class: ${label} ${maxLines}/${maxBytes}`,
        );
      }
      out.push(`E ${hex(value)}`);
    };
    oracle(history.value(), "initial");

    for (let step = 0; step < 300; step += 1) {
      if (step % 73 === 0) {
        history.clear();
        expected = "";
        out.push("L");
        oracle(history.value(), "clear");
      }
      const chunk = nextFragment() + nextFragment();
      history.append(chunk);
      expected = retainedHistory(expected + chunk, maxLines, maxBytes);
      out.push(`S ${hex(chunk)}`);
      oracle(history.value(), "append");
    }
  }
}

process.stderr.write(`trace records: ${out.length}\n`);
process.stdout.write(`${out.join("\n")}\n`);
