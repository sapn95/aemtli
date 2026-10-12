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
//   hold_if:
//     create-calendar-event: [body.attendees]
//
// hold_if holds an allowed call when one of the named arguments is there and
// not empty. Creating a calendar entry is private, but one with attendees
// makes Outlook send invitations: the same tool, once inward and once
// outward, and only its arguments tell which.
import { parse as parseYaml } from 'yaml';

const DECISIONS = ['allow', 'approve', 'deny'];
const PATTERN = /^[A-Za-z0-9_.*-]+$/;
const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/**
 * The value at a dotted path, matching each key without regard to case: a
 * server that reads "Attendees" as well as "attendees" must not let the one
 * the policy did not name slip through.
 */
function at(value, path) {
  let here = value;
  for (const key of path.split('.')) {
    if (!here || typeof here !== 'object' || Array.isArray(here)) return undefined;
    const found = Object.keys(here).filter(k => k.toLowerCase() === key.toLowerCase());
    // Two spellings of one key: whichever is filled decides.
    const filled = found.map(k => here[k]).find(present);
    here = filled ?? here[found[0]];
  }
  return here;
}

/** Present and not empty: no array, object or string without content, no null, no false. */
function present(value) {
  if (value === undefined || value === null || value === false || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

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
    if (key !== 'default' && key !== 'hold_if' && !DECISIONS.includes(key)) throw new Error(`unknown policy key "${key}"`);
  }
  const holdIf = doc.hold_if ?? {};
  if (typeof holdIf !== 'object' || Array.isArray(holdIf)) throw new Error('hold_if must map tool names to argument paths');
  const conditions = Object.entries(holdIf).map(([tool, paths]) => {
    if (!PATTERN.test(tool)) throw new Error(`hold_if: "${tool}" is not a tool name`);
    if (!Array.isArray(paths) || !paths.length || !paths.every(x => typeof x === 'string' && PATH.test(x))) {
      throw new Error(`hold_if.${tool} must be a list of argument paths such as body.attendees`);
    }
    return { match: matcher(tool), paths };
  });
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
  /** The argument paths that hold an allowed call to this tool. */
  const pathsFor = tool => conditions.filter(c => c.match.test(tool)).flatMap(c => c.paths);
  return {
    /**
     * "allow", "approve" or "deny" for a tool and the arguments it is called
     * with. Deny wins over approve, approve over allow; an allowed call with
     * a hold_if argument filled is held.
     */
    decide(tool, args) {
      for (const decision of ['deny', 'approve', 'allow']) {
        if (!lists[decision].some(m => m.test(tool))) continue;
        if (decision === 'allow' && args !== undefined && pathsFor(tool).some(p => present(at(args, p)))) return 'approve';
        return decision;
      }
      if (fallback === 'allow' && args !== undefined && pathsFor(tool).some(p => present(at(args, p)))) return 'approve';
      return fallback;
    },
    /** What makes an allowed call to this tool wait, for its description. */
    holdsWhen: tool => pathsFor(tool),
  };
}
