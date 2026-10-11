// What a gateway does with each tool of its MCP server: pass the call
// through ("allow"), hold it until the owner approves it ("approve"), or hide
// the tool altogether ("deny"). Names match exactly or with "*" as a
// wildcard. A tool that no list names gets the default, which is "approve":
// a new tool in an MCP update waits for a decision instead of running.
//
//   default: approve
//   allow: [epost_list_*, epost_get_letter]
//   approve: [epost_delete_letter]
//   deny: [epost_login]
import { parse as parseYaml } from 'yaml';

const DECISIONS = ['allow', 'approve', 'deny'];
const PATTERN = /^[A-Za-z0-9_.*-]+$/;

/** A matcher for one pattern; "*" matches any run of characters. */
function matcher(pattern) {
  const source = pattern.split('*').map(part => part.replace(/[.-]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`);
}

/**
 * Reads a policy from YAML text. Throws on anything it does not understand,
 * so a typo stops the gateway rather than quietly changing what runs.
 */
export function parsePolicy(text) {
  const doc = parseYaml(text) ?? {};
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('the policy must be a mapping');
  for (const key of Object.keys(doc)) {
    if (key !== 'default' && !DECISIONS.includes(key)) throw new Error(`unknown policy key "${key}"`);
  }
  const fallback = doc.default ?? 'approve';
  if (!DECISIONS.includes(fallback)) throw new Error(`default must be one of ${DECISIONS.join(', ')}`);
  const lists = {};
  for (const decision of DECISIONS) {
    const list = doc[decision] ?? [];
    if (!Array.isArray(list) || !list.every(p => typeof p === 'string' && PATTERN.test(p))) {
      throw new Error(`${decision} must be a list of tool names, "*" allowed`);
    }
    lists[decision] = list.map(matcher);
  }
  return {
    /** "allow", "approve" or "deny" for a tool name. Deny wins over approve, approve over allow. */
    decide(tool) {
      for (const decision of ['deny', 'approve', 'allow']) {
        if (lists[decision].some(m => m.test(tool))) return decision;
      }
      return fallback;
    },
  };
}
