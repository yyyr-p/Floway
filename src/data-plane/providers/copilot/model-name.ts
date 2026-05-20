const CLAUDE_MINOR_VERSION_DATE_SUFFIX = /^(.*(?:\d+\.\d+|\d+-\d+))-\d{8}$/;
const CLAUDE_VARIANT_SUFFIX = /-(?:high|xhigh|1m(?:-internal)?)$/;
const CLAUDE_DATE_SUFFIX = /-\d{8}$/;

export const copilotRawModelId = (id: string): string => {
  if (!id.startsWith("claude-")) return id;
  return id.replace(/(?<=-)(\d+)-(\d+)(?=-|$)/g, "$1.$2");
};

export const copilotDateSuffixedRawModelAliasTarget = (
  id: string,
): string | undefined => {
  if (!id.startsWith("claude-")) return undefined;
  const match = id.match(CLAUDE_MINOR_VERSION_DATE_SUFFIX);
  return match ? copilotRawModelId(match[1]) : undefined;
};

export const copilotPublicModelId = (id: string): string => {
  if (!id.startsWith("claude-")) return id;
  return copilotRawModelId(id)
    .replace(CLAUDE_DATE_SUFFIX, "")
    .replace(CLAUDE_VARIANT_SUFFIX, "")
    .replace(/(\d)\.(\d)/g, "$1-$2");
};

export const copilotRequestedModelAliasTarget = (
  id: string,
): string | undefined => {
  if (!id.startsWith("claude-")) return undefined;
  const withoutDate = id.replace(CLAUDE_DATE_SUFFIX, "");
  const publicId = copilotPublicModelId(id);
  if (withoutDate !== id) return copilotPublicModelId(withoutDate);
  return publicId !== id ? publicId : undefined;
};
