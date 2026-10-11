// What a goose run produced, read from `goose run --output-format json`.
//
// goose exits 0 and reports `"status": "completed"` even when the model
// provider could not be reached: the failure is only in the text of the last
// assistant message ("Network error: ..."). So a run counts as successful
// only when a model actually answered, which shows in two places: tokens were
// used, and the last assistant message carries `metadata.inference`.

/** Joins the text parts of one goose message. */
function textOf(message) {
  return (message?.content ?? [])
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim();
}

/**
 * Parses goose's JSON output.
 *
 * Returns `{ ok, text, error, tokens }`: `text` is the last assistant
 * message, `error` is set exactly when `ok` is false.
 */
export function readGooseResult(stdout) {
  const start = stdout.indexOf('{');
  let doc;
  try {
    doc = JSON.parse(start >= 0 ? stdout.slice(start) : '');
  } catch {
    return { ok: false, text: '', error: 'goose printed no JSON result', tokens: { input: 0, output: 0, total: 0 } };
  }
  const meta = doc.metadata ?? {};
  const tokens = {
    input: meta.input_tokens ?? 0,
    output: meta.output_tokens ?? 0,
    total: meta.total_tokens ?? 0,
  };
  const last = [...(doc.messages ?? [])].reverse().find(m => m.role === 'assistant');
  const text = textOf(last);
  const answered = Boolean(last?.metadata?.inference) && tokens.total > 0;
  const ok = meta.status === 'completed' && answered;
  let error = null;
  if (!ok) error = text || `goose finished with status "${meta.status ?? 'unknown'}" and no answer`;
  return { ok, text, error, tokens };
}
