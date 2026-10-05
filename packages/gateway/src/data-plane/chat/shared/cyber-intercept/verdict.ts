// Parse the judge model's XML-tagged verdict. Fail-closed by contract:
// anything other than an explicit <verdict>SAFE</verdict> is unsafe.
export interface CyberInterceptVerdict {
  readonly unsafe: boolean;
  readonly reason: string;
}

const VERDICT_PATTERN = /<verdict>\s*(SAFE|UNSAFE)\s*<\/verdict>/i;
const REASON_PATTERN = /<reason>\s*([\s\S]*?)\s*<\/reason>/i;

export const SAFE_VERDICT: CyberInterceptVerdict = { unsafe: false, reason: '' };

const unsafeVerdict = (reason: string): CyberInterceptVerdict => ({ unsafe: true, reason });

export const parseCyberInterceptVerdict = (output: string): CyberInterceptVerdict => {
  const verdictMatch = VERDICT_PATTERN.exec(output);
  if (verdictMatch === null) {
    // Missing or malformed verdict tag — the judge did not follow the
    // output format, so the request is treated as unsafe (fail-closed).
    return unsafeVerdict('judge output unparseable (fail-closed)');
  }
  if (verdictMatch[1].toUpperCase() === 'SAFE') {
    // Convention: a SAFE verdict carries no <reason> tag.
    return SAFE_VERDICT;
  }
  const reasonMatch = REASON_PATTERN.exec(output);
  const reason = reasonMatch?.[1].trim();
  return unsafeVerdict(reason && reason.length > 0 ? reason : 'unsafe content detected');
};
