export function estimateOutputUnits(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2a6df}\uac00-\ud7af]/u.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk + other / 4));
}
