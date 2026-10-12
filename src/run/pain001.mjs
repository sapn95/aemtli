// A payment file for the bank: ISO 20022 pain.001.001.09, as the Swiss
// Payment Standards 2022 describe it for credit transfers from a Swiss
// account. One file holds the bills read from QR codes; e-banking shows it
// before anything is paid, and the owner releases it there.
//
// Only what the standards need is written, in the schema's own order. CHF
// only: a bill in another currency is left for a person.
import { ibanValid } from './swissqr.mjs';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// The characters the standards allow: Basic Latin, Latin-1, Latin
// Extended-A, the euro sign and four Romanian letters. Typographic dashes and
// quotes become their plain forms; anything else is left out, because one
// character outside the set makes the bank refuse the whole file.
const PLAIN = { '\u2013': '-', '\u2014': '-', '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u2026': '...', '\u00a0': ' ' };
const ALLOWED = /[\u0020-\u007e\u00a1-\u017f\u20ac\u0218-\u021b]/u;
const control = c => c.codePointAt(0) < 32 || c.codePointAt(0) === 127;
const latin = s => [...s].map(c => (control(c) ? ' ' : PLAIN[c] ?? (ALLOWED.test(c) ? c : ''))).join('');
/** Whether every character of `s` survives: allowed, a plain form, or a space. */
const writable = s => [...String(s ?? '')].every(c => control(c) || PLAIN[c] || ALLOWED.test(c));

/** Text the standards allow in a field: their characters only, at most `max` long. */
const fit = (s, max) => latin(String(s ?? '')).replace(/\s+/g, ' ').trim().slice(0, max);

const tag = (name, inner) => `<${name}>${inner}</${name}>`;
const text = (name, value, max) => (fit(value, max) ? tag(name, esc(fit(value, max))) : '');

/** A name the bank gets as it is on the bill, or an error: never one with letters dropped. */
function name(value, what) {
  const written = fit(value, 70);
  if (!written || !writable(value) || fit(value, 1000).length > 70) throw new Error(`${what}: the name "${String(value ?? '').slice(0, 80)}" cannot be written as it is`);
  return tag('Nm', esc(written));
}

/** A real calendar date, YYYY-MM-DD. */
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;
const BIC = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** An address as pain.001 wants it: structured when the bill had it so, else lines. */
function postal(a) {
  if (!a) return '';
  if (a.type === 'K') {
    return tag('PstlAdr', text('Ctry', a.country, 2) + text('AdrLine', a.line1, 70) + text('AdrLine', a.line2, 70));
  }
  return tag('PstlAdr', text('StrtNm', a.street, 70) + text('BldgNb', a.number, 16) + text('PstCd', a.postCode, 16) + text('TwnNm', a.town, 35) + text('Ctry', a.country, 2));
}

/** What the payee sees with the money: their reference, and the bill's message. */
function remittance(bill) {
  const { type, value } = bill.reference;
  const message = fit(bill.message, 140);
  if (type === 'NON') return message ? tag('RmtInf', text('Ustrd', message, 140)) : '';
  const kind = type === 'QRR' ? tag('Prtry', 'QRR') : tag('Cd', 'SCOR');
  return tag('RmtInf', tag('Strd',
    tag('CdtrRefInf', tag('Tp', tag('CdOrPrtry', kind)) + text('Ref', value, 35))
    + (message ? text('AddtlRmtInf', message, 140) : '')));
}

/** The debtor's bank: by BIC when known, else by the bank id in a Swiss IBAN. */
function debtorAgent(iban, bic) {
  if (bic) return tag('DbtrAgt', tag('FinInstnId', tag('BICFI', bic)));
  const iid = String(Number(iban.slice(4, 9)));
  return tag('DbtrAgt', tag('FinInstnId', tag('ClrSysMmbId', tag('ClrSysId', tag('Cd', 'CHBCC')) + tag('MmbId', iid))));
}

const cents = amount => Math.round(Number(amount) * 100);
const money = c => (c / 100).toFixed(2);

/**
 * Builds the file. `debtor` is { name, iban, bic? }. `payments` are
 * { bill, date, id }: a bill from parseSwissQr with an amount in CHF, the
 * execution date (YYYY-MM-DD) and an id of at most 35 characters that comes
 * back on the statement. `messageId` names the file (at most 35), `now` is
 * its creation time. Throws on anything the bank would refuse.
 */
export function buildPain001({ debtor, payments, messageId, now = new Date() }) {
  if (!payments.length) throw new Error('no payments');
  if (!/^CH\d{7}[A-Z0-9]{12}$/.test(String(debtor.iban ?? '')) || !ibanValid(debtor.iban)) throw new Error('the debtor account must be a Swiss IBAN');
  name(debtor.name, 'the debtor');
  if (debtor.bic !== undefined && !BIC.test(debtor.bic)) throw new Error(`the debtor's BIC ${debtor.bic} is not a BIC`);
  for (const p of payments) {
    if (p.bill.currency !== 'CHF') throw new Error(`${p.id}: only CHF goes into this file`);
    if (!ibanValid(p.bill.iban)) throw new Error(`${p.id}: the creditor IBAN ${p.bill.iban} fails its check digits`);
    if (!(cents(p.bill.amount) > 0)) throw new Error(`${p.id}: no amount`);
    if (!isDate(p.date)) throw new Error(`${p.id}: no execution date`);
    name(p.bill.creditor?.name, `${p.id}: the creditor`);
    if (!/^[A-Za-z0-9-]{1,35}$/.test(p.id)) throw new Error(`${p.id}: an id is 1 to 35 letters, digits or dashes`);
  }
  if (!/^[A-Za-z0-9-]{1,35}$/.test(messageId)) throw new Error('a message id is 1 to 35 letters, digits or dashes');

  const total = payments.reduce((sum, p) => sum + cents(p.bill.amount), 0);
  // One block per execution date, in date order.
  const dates = [...new Set(payments.map(p => p.date))].sort();
  const blocks = dates.map((date, i) => {
    const these = payments.filter(p => p.date === date);
    const sum = these.reduce((s, p) => s + cents(p.bill.amount), 0);
    const tx = these.map(({ bill, id }) => tag('CdtTrfTxInf',
      tag('PmtId', tag('InstrId', id) + tag('EndToEndId', id))
      + tag('Amt', `<InstdAmt Ccy="CHF">${money(cents(bill.amount))}</InstdAmt>`)
      + tag('Cdtr', name(bill.creditor.name, id) + postal(bill.creditor))
      + tag('CdtrAcct', tag('Id', tag('IBAN', bill.iban)))
      + remittance(bill))).join('');
    return tag('PmtInf',
      tag('PmtInfId', `${messageId.slice(0, 31)}-${String(i + 1).padStart(3, '0')}`)
      + tag('PmtMtd', 'TRF')
      + tag('NbOfTxs', String(these.length))
      + tag('CtrlSum', money(sum))
      + tag('ReqdExctnDt', tag('Dt', date))
      + tag('Dbtr', name(debtor.name, 'the debtor'))
      + tag('DbtrAcct', tag('Id', tag('IBAN', debtor.iban)))
      + debtorAgent(debtor.iban, debtor.bic)
      + tx);
  }).join('');

  const created = now.toISOString().slice(0, 19);
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + tag('CstmrCdtTrfInitn',
      tag('GrpHdr', tag('MsgId', messageId) + tag('CreDtTm', created) + tag('NbOfTxs', String(payments.length)) + tag('CtrlSum', money(total)) + tag('InitgPty', name(debtor.name, 'the debtor')))
      + blocks)
    + '</Document>\n';
}
