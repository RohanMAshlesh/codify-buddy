/**
 * Minimal unified-style line diff for previews. Uses LCS for inputs up to
 * ~4M cell comparisons and falls back to a coarse replace hunk beyond that.
 */
export function lineDiff(before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  if (before === after) return "";
  let ops: Array<[" " | "-" | "+", string]>;
  if (a.length * b.length > 4_000_000) {
    ops = [...a.map((l) => ["-", l] as ["-", string]), ...b.map((l) => ["+", l] as ["+", string])];
  } else {
    const n = a.length;
    const m = b.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push([" ", a[i]!]);
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push(["-", a[i++]!]);
      else ops.push(["+", b[j++]!]);
    }
    while (i < n) ops.push(["-", a[i++]!]);
    while (j < m) ops.push(["+", b[j++]!]);
  }

  // Emit hunks with surrounding context.
  const keep = new Array(ops.length).fill(false);
  ops.forEach(([t], k) => {
    if (t !== " ") for (let d = -context; d <= context; d++) if (ops[k + d]) keep[k + d] = true;
  });
  const out: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let inHunk = false;
  ops.forEach(([t, line], k) => {
    if (keep[k]) {
      if (!inHunk) {
        out.push(`@@ -${oldLine} +${newLine} @@`);
        inHunk = true;
      }
      out.push(`${t}${line}`);
    } else inHunk = false;
    if (t !== "+") oldLine++;
    if (t !== "-") newLine++;
  });
  return out.join("\n");
}
