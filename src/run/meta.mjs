// A job's title and description, for the UI, without loading the job.

/** "Release watch" from a job file's first lines: `// title: …` and `// description: …`. */
export function jobMeta(text) {
  const head = text.split('\n').slice(0, 20);
  const field = key => head.map(l => l.match(new RegExp(`^//\\s*${key}:\\s*(.+)$`))).find(Boolean)?.[1].trim();
  return { title: field('title'), description: field('description') };
}
