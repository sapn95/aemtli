import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSwissQr, ibanValid, isQrIban, qrrValid, scorValid } from '../src/run/swissqr.mjs';
import { buildPain001 } from '../src/run/pain001.mjs';

// The sample accounts and references of the Swiss QR-bill guidelines (SIX),
// and the example IBAN of the Swiss banks: public test values, nobody's.
const QR_IBAN = 'CH4431999123000889012';
const IBAN = 'CH5800791123000889012';
const QRR = '210000000003139471430009017';
const SCOR = 'RF18539007547034';
const DEBTOR = { name: 'Example Debtor', iban: 'CH9300762011623852957' };

/** An IBAN with correct check digits around any account number (ISO 13616). */
function ibanWith(country, bban) {
  const digits = `${bban}${country}00`.replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return `${country}${String(98 - rest).padStart(2, '0')}${bban}`;
}

/** A QR bill's text, line by line as the guidelines order it. */
function payload({ iban = QR_IBAN, amount = '1949.75', currency = 'CHF', refType = 'QRR', ref = QRR, message = 'Order of 15 June', creditor = ['S', 'Example Robert Schneider AG', 'Rue du Lac', '1268', '2501', 'Biel', 'CH'], trailer = 'EPD', billInfo = '//S1/10/10201409/11/190512' } = {}) {
  return ['SPC', '0200', '1', iban, ...creditor, '', '', '', '', '', '', '', amount, currency,
    'S', 'Example Pia-Maria Rutschmann-Schnyder', 'Grosse Marktgasse', '28', '9400', 'Rorschach', 'CH',
    refType, ref, message, trailer, billInfo].join('\r\n');
}

test('the check digits: IBAN, QR-IBAN, QR reference, creditor reference', () => {
  assert.equal(ibanValid(QR_IBAN), true);
  assert.equal(ibanValid('CH4431999123000889013'), false);
  assert.equal(ibanValid(QR_IBAN.replace(/.{4}/g, '$& ').trim()), true, 'spaces as printed');
  assert.equal(ibanValid('not an iban'), false);
  assert.equal(isQrIban(QR_IBAN), true);
  assert.equal(isQrIban(IBAN), false);
  assert.equal(isQrIban('DE89370400440532013000'), false);
  // Only the bank id counts here, not the check digits.
  const withBank = iid => `CH00${iid}${QR_IBAN.slice(9)}`;
  assert.equal(isQrIban(withBank('31999')), true, 'the last bank id of the range');
  assert.equal(isQrIban(withBank('32000')), false, 'past it');
  assert.equal(isQrIban(withBank('29999')), false, 'before it');
  assert.equal(qrrValid(QRR), true);
  assert.equal(qrrValid(`${QRR.slice(0, 26)}8`), false);
  assert.equal(qrrValid('12345'), false);
  assert.equal(scorValid(SCOR), true);
  assert.equal(scorValid('RF18539007547035'), false);
  assert.equal(scorValid('XX18539007547034'), false);
});

test('a QR bill reads field by field, CRLF or not', () => {
  const { ok, bill } = parseSwissQr(payload());
  assert.equal(ok, true);
  assert.deepEqual(bill, {
    iban: QR_IBAN,
    creditor: { type: 'S', name: 'Example Robert Schneider AG', street: 'Rue du Lac', number: '1268', postCode: '2501', town: 'Biel', country: 'CH' },
    amount: '1949.75',
    currency: 'CHF',
    debtor: { type: 'S', name: 'Example Pia-Maria Rutschmann-Schnyder', street: 'Grosse Marktgasse', number: '28', postCode: '9400', town: 'Rorschach', country: 'CH' },
    reference: { type: 'QRR', value: QRR },
    message: 'Order of 15 June',
    billInfo: '//S1/10/10201409/11/190512',
  });
  assert.equal(parseSwissQr(payload().replace(/\r\n/g, '\n')).ok, true);
  const k = parseSwissQr(payload({ creditor: ['K', 'Example AG', 'Rue Example 1', '3000 Bern', '', '', 'CH'] }));
  assert.deepEqual(k.bill.creditor, { type: 'K', name: 'Example AG', line1: 'Rue Example 1', line2: '3000 Bern', country: 'CH' });
  assert.equal(parseSwissQr(payload({ amount: '' })).bill.amount, null, 'the payer fills it in');
  assert.equal(parseSwissQr(payload({ amount: '50' })).bill.amount, '50.00');
  assert.deepEqual(parseSwissQr(payload({ iban: IBAN, refType: 'SCOR', ref: 'RF18 5390 0754 7034' })).bill.reference, { type: 'SCOR', value: SCOR });
  assert.deepEqual(parseSwissQr(payload({ iban: IBAN, refType: 'NON', ref: '' })).bill.reference, { type: 'NON', value: null });
});

test('a bill a bank would refuse is refused, with the reason', () => {
  for (const [text, why] of [
    ['hello', /no SPC header/],
    [payload().replace('0200', '0100'), /version 0100/],
    [payload({ trailer: 'END' }), /no EPD trailer/],
    [payload({ iban: 'CH4431999123000889013' }), /fails its check digits/],
    [payload({ iban: 'DE89370400440532013000' }), /not Swiss or Liechtenstein/],
    [payload({ iban: ibanWith('CH', '007620000001234567') }), /has 22 characters/],
    [payload({ currency: 'USD' }), /currency USD/],
    [payload({ amount: '12.345' }), /amount 12.345/],
    [payload({ amount: '0.00' }), /amount 0.00/],
    [payload({ ref: `${QRR.slice(0, 26)}8` }), /QR reference .* fails its check digit/],
    [payload({ iban: IBAN }), /QR reference needs a QR-IBAN/],
    [payload({ refType: 'SCOR', ref: SCOR }), /QR-IBAN needs a QR reference/],
    [payload({ refType: 'NON', ref: '' }), /QR-IBAN needs a QR reference/],
    [payload({ iban: IBAN, refType: 'SCOR', ref: 'RF18539007547035' }), /creditor reference .* fails/],
    [payload({ iban: IBAN, refType: 'NON', ref: '123' }), /NON with a reference/],
    [payload({ iban: IBAN, refType: 'XYZ', ref: '' }), /reference type XYZ/],
    [payload({ creditor: ['S', '', '', '', '', '', ''] }), /no creditor name/],
  ]) {
    const r = parseSwissQr(text);
    assert.equal(r.ok, false, String(why));
    assert.match(r.why, why);
  }
  // A message line that says EPD is not the trailer.
  assert.equal(parseSwissQr(payload({ message: 'EPD', trailer: 'x' })).ok, false);
});

const bill = overrides => parseSwissQr(payload(overrides)).bill;

test('a payment file: one block per date, references as the standards want them', () => {
  const xml = buildPain001({
    debtor: DEBTOR,
    messageId: 'AEMTLI-20261012-0001',
    now: new Date('2026-10-12T10:00:00Z'),
    payments: [
      { bill: bill(), date: '2026-10-31', id: 'E2E-1' },
      { bill: bill({ iban: IBAN, refType: 'SCOR', ref: SCOR, amount: '10.5', message: '' }), date: '2026-10-20', id: 'E2E-2' },
      { bill: bill({ iban: IBAN, refType: 'NON', ref: '', amount: '1', message: 'Rechnung <42> & "mehr"', creditor: ['K', 'Example AG', 'Rue Example 1', '3000 Bern', '', '', 'CH'] }), date: '2026-10-31', id: 'E2E-3' },
    ],
  });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"/);
  assert.match(xml, /<GrpHdr><MsgId>AEMTLI-20261012-0001<\/MsgId><CreDtTm>2026-10-12T10:00:00<\/CreDtTm><NbOfTxs>3<\/NbOfTxs><CtrlSum>1961.25<\/CtrlSum><InitgPty><Nm>Example Debtor<\/Nm><\/InitgPty><\/GrpHdr>/);
  const blocks = xml.match(/<PmtInf>.*?<\/PmtInf>/g);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /<PmtInfId>AEMTLI-20261012-0001-001<\/PmtInfId><PmtMtd>TRF<\/PmtMtd><NbOfTxs>1<\/NbOfTxs><CtrlSum>10.50<\/CtrlSum><ReqdExctnDt><Dt>2026-10-20<\/Dt><\/ReqdExctnDt>/);
  assert.match(blocks[1], /<NbOfTxs>2<\/NbOfTxs><CtrlSum>1950.75<\/CtrlSum><ReqdExctnDt><Dt>2026-10-31<\/Dt>/);
  assert.match(blocks[0], /<DbtrAgt><FinInstnId><ClrSysMmbId><ClrSysId><Cd>CHBCC<\/Cd><\/ClrSysId><MmbId>762<\/MmbId><\/ClrSysMmbId><\/FinInstnId><\/DbtrAgt>/, 'the bank id from the IBAN, without its zeros');
  assert.match(xml, /<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Prtry>QRR<\/Prtry><\/CdOrPrtry><\/Tp><Ref>210000000003139471430009017<\/Ref><\/CdtrRefInf><AddtlRmtInf>Order of 15 June<\/AddtlRmtInf><\/Strd><\/RmtInf>/);
  assert.match(xml, /<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR<\/Cd><\/CdOrPrtry><\/Tp><Ref>RF18539007547034<\/Ref><\/CdtrRefInf><\/Strd><\/RmtInf>/);
  assert.match(xml, /<RmtInf><Ustrd>Rechnung &lt;42&gt; &amp; &quot;mehr&quot;<\/Ustrd><\/RmtInf>/);
  assert.match(xml, /<Cdtr><Nm>Example Robert Schneider AG<\/Nm><PstlAdr><StrtNm>Rue du Lac<\/StrtNm><BldgNb>1268<\/BldgNb><PstCd>2501<\/PstCd><TwnNm>Biel<\/TwnNm><Ctry>CH<\/Ctry><\/PstlAdr><\/Cdtr>/);
  assert.match(xml, /<Cdtr><Nm>Example AG<\/Nm><PstlAdr><Ctry>CH<\/Ctry><AdrLine>Rue Example 1<\/AdrLine><AdrLine>3000 Bern<\/AdrLine><\/PstlAdr><\/Cdtr>/);
  assert.match(xml, /<PmtId><InstrId>E2E-2<\/InstrId><EndToEndId>E2E-2<\/EndToEndId><\/PmtId><Amt><InstdAmt Ccy="CHF">10.50<\/InstdAmt><\/Amt>/);
  const odd = buildPain001({ debtor: DEBTOR, messageId: 'M', payments: [{ bill: bill({ iban: IBAN, refType: 'NON', ref: '', message: 'Rechnung \u2013 \u201cOktober\u201d\u00a0\u{1F600} Zürich \u20ac\tok' }), date: '2026-10-31', id: 'X' }] });
  assert.match(odd, /<Ustrd>Rechnung - &quot;Oktober&quot; Zürich € ok<\/Ustrd>/, 'plain dashes and quotes, nothing outside the set');
  assert.match(buildPain001({ debtor: { ...DEBTOR, bic: 'EXAMCHBBXXX' }, messageId: 'M', payments: [{ bill: bill(), date: '2026-10-31', id: 'X' }] }), /<DbtrAgt><FinInstnId><BICFI>EXAMCHBBXXX<\/BICFI><\/FinInstnId><\/DbtrAgt>/);
});

test('a file the bank would refuse is not written', () => {
  const ok = { bill: bill(), date: '2026-10-31', id: 'X' };
  for (const [args, why] of [
    [{ payments: [] }, /no payments/],
    [{ debtor: { name: 'x', iban: 'DE89370400440532013000' } }, /Swiss IBAN/],
    [{ debtor: { name: 'x', iban: 'CH9300762011623852958' } }, /Swiss IBAN/],
    [{ debtor: { name: ' ', iban: DEBTOR.iban } }, /the debtor: the name/],
    [{ payments: [{ ...ok, bill: bill({ currency: 'EUR' }) }] }, /only CHF/],
    [{ payments: [{ ...ok, bill: bill({ amount: '' }) }] }, /no amount/],
    [{ payments: [{ ...ok, date: '31.10.2026' }] }, /no execution date/],
    [{ payments: [{ ...ok, id: 'has space' }] }, /an id is/],
    [{ messageId: 'x'.repeat(36) }, /a message id is/],
    [{ payments: [{ ...ok, date: '2026-02-31' }] }, /no execution date/],
    [{ payments: [{ ...ok, bill: bill({ creditor: ['S', '\u2606\u2606', 'Rue du Lac', '1', '2501', 'Biel', 'CH'] }) }] }, /the creditor: the name .* cannot be written/],
    [{ payments: [{ ...ok, bill: bill({ creditor: ['S', '\u0395\u03bb\u03bb\u03ac\u03c2 AG', 'Rue du Lac', '1', '2501', 'Biel', 'CH'] }) }] }, /cannot be written as it is/],
    [{ debtor: { ...DEBTOR, bic: 'EXAMCHBBXXXX' } }, /is not a BIC/],
    [{ debtor: { ...DEBTOR, name: 'x'.repeat(71) } }, /the debtor: the name/],
  ]) {
    assert.throws(() => buildPain001({ debtor: DEBTOR, messageId: 'M', payments: [ok], ...args }), why);
  }
});

