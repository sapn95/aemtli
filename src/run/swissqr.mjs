// The Swiss QR bill: what its code says, read field by field and checked.
//
// The payload is lines of text in a fixed order (Swiss Implementation
// Guidelines for the QR-bill, version 2.x). Every check here is one a bank
// would make before it books the payment, so a bill that fails one is set
// aside for a person instead of going into a payment file.

/** IBAN check digits (ISO 13616, mod 97). */
export function ibanValid(iban) {
  const s = String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = `${s.slice(4)}${s.slice(0, 4)}`.replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const digit of moved) rest = (rest * 10 + Number(digit)) % 97;
  return rest === 1;
}

/** A QR-IBAN: a Swiss or Liechtenstein IBAN whose bank id is 30000 to 31999. */
export function isQrIban(iban) {
  const s = String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  const iid = Number(s.slice(4, 9));
  return /^(CH|LI)/.test(s) && iid >= 30000 && iid <= 31999;
}

/** The QR reference: 27 digits, the last a recursive mod-10 check digit. */
export function qrrValid(ref) {
  const s = String(ref ?? '');
  if (!/^\d{27}$/.test(s)) return false;
  const table = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];
  let carry = 0;
  for (const d of s.slice(0, 26)) carry = table[(carry + Number(d)) % 10];
  return (10 - carry) % 10 === Number(s[26]);
}

/** The creditor reference (ISO 11649): RF, two check digits, up to 21 characters. */
export function scorValid(ref) {
  const s = String(ref ?? '').toUpperCase();
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(s)) return false;
  const moved = `${s.slice(4)}${s.slice(0, 4)}`.replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const digit of moved) rest = (rest * 10 + Number(digit)) % 97;
  return rest === 1;
}

/** An address of the QR bill: structured (S) or two free lines (K). */
function address(lines, at) {
  const [type, name, a, b, postCode, town, country] = lines.slice(at, at + 7).map(l => (l ?? '').trim());
  if (!name) return null;
  return type === 'K'
    ? { type, name, line1: a, line2: b, country }
    : { type: 'S', name, street: a, number: b, postCode, town, country };
}

/**
 * Reads one QR code's text. Resolves to { ok: true, bill } or
 * { ok: false, why }; `bill` has iban, creditor, amount (a string with two
 * decimals, or null when the payer fills it in), currency, debtor,
 * reference { type: 'QRR'|'SCOR'|'NON', value }, message and billInfo.
 */
export function parseSwissQr(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== 'SPC') return { ok: false, why: 'not a Swiss QR bill (no SPC header)' };
  if (!/^02\d\d$/.test(lines[1] ?? '')) return { ok: false, why: `version ${lines[1]} is not 2.x` };
  if (lines[2] !== '1') return { ok: false, why: 'coding type is not 1 (UTF-8)' };
  // The trailer has a fixed place: line 31. A message line that says "EPD"
  // must not be taken for it.
  const trailer = 30;
  if (lines[trailer] !== 'EPD') return { ok: false, why: 'no EPD trailer on line 31' };

  const iban = (lines[3] ?? '').replace(/\s+/g, '').toUpperCase();
  const creditor = address(lines, 4);
  const amountText = (lines[18] ?? '').trim();
  const currency = (lines[19] ?? '').trim();
  const debtor = address(lines, 20);
  const refType = (lines[27] ?? '').trim();
  const ref = (lines[28] ?? '').replace(/\s+/g, '');
  const message = (lines[29] ?? '').trim();
  const billInfo = (lines[trailer + 1] ?? '').trim();

  if (!ibanValid(iban)) return { ok: false, why: `IBAN ${iban || '(none)'} fails its check digits` };
  if (!/^(CH|LI)/.test(iban)) return { ok: false, why: `IBAN ${iban} is not Swiss or Liechtenstein` };
  if (iban.length !== 21) return { ok: false, why: `IBAN ${iban} has ${iban.length} characters; a Swiss one has 21` };
  if (!creditor) return { ok: false, why: 'no creditor name' };
  if (!['CHF', 'EUR'].includes(currency)) return { ok: false, why: `currency ${currency || '(none)'} is not CHF or EUR` };
  let amount = null;
  if (amountText) {
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(amountText) || Number(amountText) < 0.01) return { ok: false, why: `amount ${amountText} is not between 0.01 and 999999999.99` };
    amount = Number(amountText).toFixed(2);
  }
  const qrIban = isQrIban(iban);
  if (refType === 'QRR') {
    if (!qrIban) return { ok: false, why: 'a QR reference needs a QR-IBAN' };
    if (!qrrValid(ref)) return { ok: false, why: `QR reference ${ref} fails its check digit` };
  } else if (refType === 'SCOR') {
    if (qrIban) return { ok: false, why: 'a QR-IBAN needs a QR reference' };
    if (!scorValid(ref)) return { ok: false, why: `creditor reference ${ref} fails its check digits` };
  } else if (refType === 'NON') {
    if (qrIban) return { ok: false, why: 'a QR-IBAN needs a QR reference' };
    if (ref) return { ok: false, why: 'reference type NON with a reference' };
  } else {
    return { ok: false, why: `reference type ${refType || '(none)'} is not QRR, SCOR or NON` };
  }
  return {
    ok: true,
    bill: { iban, creditor, amount, currency, debtor, reference: { type: refType, value: ref || null }, message, billInfo },
  };
}
