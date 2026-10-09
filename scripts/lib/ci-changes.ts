/** Only known documentation paths can skip browser and real-server checks. */
export function isCodePath(path: string): boolean {
  if (/^(?:src|scripts|tests|deploy|security|public|config|\.github)\//.test(path)) return true;
  if (/^(?:docs|agent-setup)\//.test(path)) return false;
  if (!path.includes("/") && /(?:\.md$|^(?:LICENSE|NOTICE|CHANGELOG)(?:\..*)?$)/i.test(path)) return false;
  return true;
}
