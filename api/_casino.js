// Analysis behind api/casino-check.js: everything that can be judged from what a
// gambling site hands to any visitor (its HTML, its certificate, its domain record,
// its address) is turned into named findings with evidence, so the user sees why a
// site is flagged, not only that it is. No network here; the handler collects the
// raw material and this file reads it.
//
// Finding: { id, severity: 'high' | 'medium' | 'low' | 'info' | 'ok', ar, en, evidence }

const SEVERITY_WEIGHT = { high: 25, medium: 12, low: 5, info: 0, ok: 0 };

// Licence claims a visitor can find on the page, and what each is worth in the UAE.
const LICENCES = [
  { id: 'gcgra', re: /\b(GCGRA|General Commercial Gaming Regulatory Authority)\b|الهيئة العامة لتنظيم الألعاب التجارية/i, name: 'GCGRA (UAE)', uae: true },
  { id: 'curacao', re: /cura[cç]ao|antillephone|cyberluck|gaming services provider n\.?v\.?|\b(8048|1668|365|5536)\/JAZ\b|\bCEG\b.*licen|OGL\/\d{4}\/\d+/i, name: 'Curaçao', uae: false },
  { id: 'anjouan', re: /anjouan|ALSI-\d{6}-FI\d/i, name: 'Anjouan (Comoros)', uae: false },
  { id: 'kahnawake', re: /kahnawake/i, name: 'Kahnawake', uae: false },
  { id: 'mga', re: /\bMGA\b|malta gaming authority|MGA\/(B2C|CRP)\/\d+/i, name: 'Malta (MGA)', uae: false },
  { id: 'ukgc', re: /gambling commission|\bUKGC\b/i, name: 'UK Gambling Commission', uae: false },
  { id: 'pagcor', re: /\bPAGCOR\b/i, name: 'PAGCOR (Philippines)', uae: false },
  { id: 'costarica', re: /costa rica/i, name: 'Costa Rica', uae: false },
];

const PROVIDERS = [
  ['Pragmatic Play', /pragmatic ?play/i], ['Evolution', /\bevolution( gaming)?\b/i], ['NetEnt', /\bnetent\b/i],
  ['Hacksaw Gaming', /hacksaw/i], ["Play'n GO", /play.?n.?go/i], ['Spribe', /\bspribe\b|aviator/i],
  ['Turbo Games', /turbo ?games/i], ['SmartSoft', /smartsoft|\bjetx\b/i], ['Nolimit City', /nolimit/i],
  ['Push Gaming', /push ?gaming/i], ['Red Tiger', /red ?tiger/i], ['Playtech', /playtech/i],
  ['Microgaming', /microgaming|games global/i], ['Ezugi', /\bezugi\b/i], ['Amusnet / EGT', /amusnet|\bEGT\b/],
  ['BGaming', /\bbgaming\b/i], ['Endorphina', /endorphina/i], ['Habanero', /habanero/i],
];

// Hosts the real providers serve their games from; a site that names a provider but
// loads nothing from them cannot be confirmed to run the genuine game.
const PROVIDER_HOSTS = /pragmaticplay\.net|ppgames\.net|evo-games\.com|evolution\.com|netent\.com|casinomodule\.com|hacksawgaming\.com|playngonetwork\.com|spribegaming\.com|spribe\.io|turbogames\.io|smartsoftgaming\.com|nolimitcity\.com|pushgaming\.com|redtiger\.com|playtech\.com|microgaming\.com|ezugi\.com|bgaming\.com|endorphina\.com|habanerosystems\.com/i;

const CRYPTO = /\b(USDT|TRC-?20|ERC-?20|BEP-?20|bitcoin|BTC|ethereum|ETH|tether|binance|crypto(currency)?|litecoin|tron)\b|يو ?إس ?دي ?تي|بيتكوين|عملات رقمية|كريبتو/i;
const CARDS = /\b(visa|mastercard|mada|apple ?pay|google ?pay)\b|فيزا|ماستر ?كارد/i;
const AGENT_PAY = /cash agent|local agent|وكيل (ال)?(دفع|محلي|معتمد)|إيداع عن طريق (الوكيل|التحويل)|(ال)?تحويل (ال)?بنكي|bank transfer|vodafone cash|فودافون كاش/i;
const MESSENGER = /t\.me\/|telegram\.me\/|wa\.me\/|api\.whatsapp\.com|whatsapp:\/\/|تلغرام|تيليجرام|تلجرام|واتس ?اب|واتساب/i;
const BONUS = /\b(1|2|3)00% (welcome|deposit|first)|welcome bonus|بونص|مكافأة (ترحيبية|الإيداع)|free spins|لفات مجانية|cashback|كاش ?باك/i;
const WAGERING = /wager(ing)?\s*(requirement)?s?\s*(x|×)?\s*\d{2}|(x|×)\s*\d{2}\s*(wager|rollover)|شرط (الرهان|التداول)|تدوير|rollover/i;
const RESPONSIBLE = /responsible (gaming|gambling)|self.?exclusion|gamcare|begambleaware|gamstop|اللعب المسؤول|إقصاء ذاتي|18\+|\+18|21\+/i;
const MIRROR = /mirror|alternative (link|domain)|new domain|رابط بديل|موقع بديل|النطاق الجديد|use (a )?vpn|استخدم vpn|في حال (حجب|الحظر)/i;
const UAE = /\b(UAE|U\.A\.E|United Arab Emirates|Dubai|Abu Dhabi|AED|dirham)\b|الإمارات|الامارات|دبي|أبوظبي|ابوظبي|درهم/i;
const GAMBLING = /casino|slots?|roulette|blackjack|baccarat|poker|bet(ting)?|sportsbook|jackpot|aviator|crash|كازينو|سلوتس|روليت|بلاك ?جاك|باكاراه|بوكر|مراهنات|رهان|جاكبوت/i;
const HOST_UAE = /uae|emirat|dubai|dubi|abudhabi|sharjah|khaleej|gulf|arab/i;
const DEMO = /demo|free play|play for fun|نسخة تجريبية|العب مجان|وضع تجريبي|تجريبي/i;
const SUPPORT_HOURS = /24\s*\/\s*7|24h|على مدار الساعة/i;

function strip(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function snippet(text, re, width = 70) {
  const m = re.exec(text);
  if (!m) return null;
  const a = Math.max(0, m.index - width), b = Math.min(text.length, m.index + m[0].length + width);
  return (a ? '…' : '') + text.slice(a, b).trim() + (b < text.length ? '…' : '');
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch (e) { return null; }
}

function registrable(host) {
  const parts = String(host || '').split('.');
  if (parts.length <= 2) return host;
  const two = /^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/i;
  return two.test(parts.slice(-2).join('.')) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

// External hosts referenced by src/href/action attributes, with how many times each.
function externalHosts(html, pageHost) {
  const counts = new Map();
  const re = /(?:src|href|action|data-src)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi;
  let m;
  const base = registrable(pageHost);
  while ((m = re.exec(html))) {
    const h = hostOf(m[1]);
    if (!h || registrable(h) === base) continue;
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([host, count]) => ({ host, count }));
}

function analyzeHtml(html, finalUrl) {
  const text = strip(html);
  const lower = html.toLowerCase();
  const host = hostOf(finalUrl) || '';
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [, ''])[1].replace(/\s+/g, ' ').trim().slice(0, 160);
  const lang = (/<html[^>]*\blang\s*=\s*["']?([a-zA-Z-]+)/i.exec(html) || [, null])[1];
  const findings = [];

  const challenge = /just a moment|checking your browser|cf-challenge|_cf_chl|attention required|enable javascript and cookies|ddos-guard|access denied/i.test(title + ' ' + lower.slice(0, 4000));
  if (challenge) {
    findings.push({ id: 'bot-challenge', severity: 'info', ar: 'الموقع يعرض صفحة تحقّق من الروبوتات (مثل Cloudflare) ولم يُظهر محتواه للفاحص. الصق مصدر الصفحة من متصفحك في الخانة أدناه ليُفحص المحتوى الحقيقي؛ الباقي من النطاق والشهادة والخادم.', en: 'The site shows a bot challenge page (such as Cloudflare) and did not reveal its content to the checker. Paste the page source from your browser below to check the real content; the rest comes from the domain, certificate and server.', evidence: title });
    // The name still tells: "bet", "casino", "dubai" in the host are the site's own words.
    const hostGambling = GAMBLING.test(host);
    const hostUae = HOST_UAE.test(host);
    if (hostGambling) findings.push({ id: 'no-uae-licence', severity: 'high', ar: 'اسم النطاق نفسه يعلن القمار، ولا ترخيص إماراتيًا (GCGRA) معروفًا له: القمار عبر الإنترنت في الإمارات غير قانوني بدونه، وأي خسارة أو نزاع بلا حماية قانونية.', en: 'The domain name itself announces gambling, and no UAE (GCGRA) licence is known for it: online gambling in the UAE is illegal without one, and any loss or dispute has no legal protection.', evidence: host });
    if (hostGambling && hostUae) findings.push({ id: 'targets-uae', severity: 'high', ar: 'اسم النطاق يستهدف الإمارات بالاسم مع أنه غير مرخص فيها.', en: 'The domain name targets the UAE by name while unlicensed there.', evidence: host });
    return { title, lang, host, isGambling: hostGambling || null, targetsUae: hostGambling && hostUae, licences: [], providers: [], providerHosts: [], externalHosts: [], payments: { crypto: false, cards: false, agents: false }, textLength: text.length, findings, challenge: true };
  }
  if (text.length < 400) findings.push({ id: 'thin-page', severity: 'info', ar: 'الصفحة شبه فارغة بلا جافاسكربت (تطبيق أحادي الصفحة): فحص المحتوى محدود، وباقي الفحوص من النطاق والشهادة والخادم.', en: 'The page is almost empty without JavaScript (a single-page app): content checks are limited; the rest come from the domain, certificate and server.', evidence: title || null });
  const isGambling = GAMBLING.test(text) || GAMBLING.test(title) || GAMBLING.test(host);
  if (!isGambling) {
    findings.push({ id: 'not-gambling', severity: 'info', ar: 'لم نجد على الصفحة كلمات كازينو أو مراهنات؛ قد لا يكون موقع قمار، أو يحمّل محتواه بالجافاسكربت بعد التحميل.', en: 'No casino or betting words on the page; it may not be a gambling site, or it renders its content with JavaScript after load.', evidence: title || host });
  }

  // Licence
  const licences = LICENCES.filter((l) => l.re.test(text) || l.re.test(lower)).map((l) => ({ id: l.id, name: l.name, uae: l.uae, evidence: snippet(text, l.re) || snippet(lower, l.re) }));
  const uaeLicence = licences.some((l) => l.uae);
  if (uaeLicence) {
    findings.push({ id: 'licence-uae-claim', severity: 'medium', ar: 'الصفحة تذكر هيئة GCGRA الإماراتية. تحقق من الاسم في سجل الهيئة الرسمي؛ الذكر وحده لا يثبت الترخيص.', en: 'The page mentions the UAE regulator GCGRA. Check the name in the authority\'s official register; a mention alone proves nothing.', evidence: licences.find((l) => l.uae).evidence });
  } else if (isGambling) {
    findings.push({ id: 'no-uae-licence', severity: 'high', ar: 'لا ترخيص إماراتيًا: القمار عبر الإنترنت في الإمارات غير قانوني إلا بترخيص من GCGRA، ولا أثر له هنا. أي خسارة أو نزاع بلا حماية قانونية.', en: 'No UAE licence: online gambling in the UAE is illegal without a GCGRA licence, and there is no trace of one here. Any loss or dispute has no legal protection.', evidence: null });
  }
  const offshore = licences.filter((l) => !l.uae);
  if (offshore.length) {
    findings.push({ id: 'licence-offshore', severity: 'medium', ar: `ترخيص خارجي معلن (${offshore.map((l) => l.name).join('، ')}): لا يلزم الموقع بشيء تجاه لاعب في الإمارات، ورخص كوراساو وأنجوان تُشترى بسهولة ولا تفتّش العدالة.`, en: `Offshore licence claimed (${offshore.map((l) => l.name).join(', ')}): it binds the site to nothing toward a player in the UAE, and Curaçao and Anjouan licences are cheap to buy and do not audit fairness.`, evidence: offshore[0].evidence });
  } else if (isGambling && /licen[cs]ed|regulated|مرخص|مرخّص|مرخصة|خاضع للرقابة/i.test(text)) {
    findings.push({ id: 'licence-vague', severity: 'high', ar: 'يقول «مرخّص» بلا اسم جهة ولا رقم رخصة.', en: 'Says "licensed" with no authority name and no licence number.', evidence: snippet(text, /licen[cs]ed|regulated|مرخص|مرخّص|مرخصة|خاضع للرقابة/i) });
  } else if (isGambling) {
    findings.push({ id: 'licence-none', severity: 'high', ar: 'لا ذكر لأي ترخيص على الصفحة.', en: 'No licence of any kind is mentioned on the page.', evidence: null });
  }

  // Payments
  const crypto = CRYPTO.test(text) || CRYPTO.test(lower);
  const cards = CARDS.test(text);
  const agents = AGENT_PAY.test(text);
  if (crypto && !cards) findings.push({ id: 'crypto-only', severity: 'high', ar: 'الدفع بالعملات الرقمية فقط (لا فيزا/ماستركارد): لا استرداد ولا تتبّع، وهي طريقة المواقع التي تهرب من البنوك.', en: 'Crypto payments only (no Visa/Mastercard): no chargeback and no trail, the method of sites avoiding banks.', evidence: snippet(text, CRYPTO) || snippet(lower, CRYPTO) });
  else if (crypto) findings.push({ id: 'crypto', severity: 'low', ar: 'يقبل العملات الرقمية: الإيداع بها لا يُسترد.', en: 'Accepts cryptocurrency: deposits made with it cannot be recovered.', evidence: snippet(text, CRYPTO) || snippet(lower, CRYPTO) });
  if (agents) findings.push({ id: 'agents', severity: 'high', ar: 'إيداع عبر «وكيل» أو تحويل لشخص: أموالك تذهب لحساب فرد لا لشركة.', en: 'Deposits through an "agent" or a transfer to a person: your money goes to an individual\'s account, not a company\'s.', evidence: snippet(text, AGENT_PAY) });

  // Contact
  if (MESSENGER.test(html)) findings.push({ id: 'messenger', severity: 'medium', ar: 'الدعم عبر تلغرام/واتساب بدل بريد وعنوان شركة: لا جهة يمكن ملاحقتها.', en: 'Support through Telegram/WhatsApp instead of a company email and address: nobody to pursue.', evidence: snippet(html, MESSENGER, 40) });
  if (MIRROR.test(text)) findings.push({ id: 'mirror', severity: 'high', ar: 'يعلن «روابط بديلة» أو يطلب VPN: الموقع محجوب ويتوقع الحجب، وهذا سلوك موقع غير قانوني.', en: 'Advertises "mirror links" or asks for a VPN: the site is blocked and expects to be, the behaviour of an illegal site.', evidence: snippet(text, MIRROR) });

  // Bonus traps
  if (BONUS.test(text)) {
    const wager = WAGERING.test(text);
    findings.push({ id: 'bonus', severity: wager ? 'medium' : 'low', ar: wager ? 'بونص بشرط رهان مضاعف: يجب أن تراهن بالبونص عشرات المرات قبل السحب، وهذا يعيده للكازينو.' : 'بونص ترحيبي معلن: اقرأ شرط الرهان قبل القبول؛ عادة x30–x50.', en: wager ? 'Bonus with a wagering multiple: it must be bet dozens of times before withdrawal, which hands it back to the casino.' : 'Welcome bonus advertised: read the wagering requirement before accepting; usually x30–x50.', evidence: snippet(text, wager ? WAGERING : BONUS) });
  }
  if (DEMO.test(text) && isGambling) findings.push({ id: 'demo', severity: 'low', ar: 'وضع تجريبي برصيد وهمي: احذر، كثير من المواقع تضبط الديمو ليدفع أكثر من اللعب الحقيقي.', en: 'Demo mode with pretend money: beware, many sites tune the demo to pay more than real play.', evidence: snippet(text, DEMO) });

  // Responsible gaming
  if (isGambling) {
    if (!RESPONSIBLE.test(text)) findings.push({ id: 'no-responsible', severity: 'medium', ar: 'لا أثر لأدوات اللعب المسؤول (حدود إيداع، إقصاء ذاتي، 18+).', en: 'No sign of responsible-gaming tools (deposit limits, self-exclusion, 18+).', evidence: null });
    else findings.push({ id: 'responsible', severity: 'ok', ar: 'يذكر اللعب المسؤول أو 18+.', en: 'Mentions responsible gaming or 18+.', evidence: snippet(text, RESPONSIBLE) });
  }

  // Providers and where the games come from
  const providers = PROVIDERS.filter(([, re]) => re.test(text)).map(([name]) => name);
  const hosts = externalHosts(html, host);
  const providerHosts = hosts.filter((h) => PROVIDER_HOSTS.test(h.host));
  if (providers.length && !providerHosts.length) {
    findings.push({ id: 'providers-unverified', severity: 'medium', ar: `يذكر مزودي ألعاب معروفين (${providers.slice(0, 4).join('، ')}) لكن الصفحة لا تحمّل شيئًا من خوادمهم. الألعاب المقلدة تحمل الأسماء نفسها بنتائج مضبوطة.`, en: `Names known game providers (${providers.slice(0, 4).join(', ')}) but loads nothing from their servers. Cloned games carry the same names with rigged results.`, evidence: null });
  } else if (providerHosts.length) {
    findings.push({ id: 'providers-hosts', severity: 'ok', ar: `يحمّل محتوى من خوادم مزوّد: ${providerHosts.map((h) => h.host).join('، ')}`, en: `Loads content from provider servers: ${providerHosts.map((h) => h.host).join(', ')}`, evidence: null });
  }

  // Targeting
  const targetsUae = UAE.test(text) || UAE.test(title);
  if (targetsUae && isGambling && !uaeLicence) findings.push({ id: 'targets-uae', severity: 'high', ar: 'يستهدف الإمارات بالاسم أو بالدرهم مع أنه غير مرخص فيها.', en: 'Targets the UAE by name or in dirhams while unlicensed there.', evidence: snippet(text, UAE) });

  return {
    title, lang, host,
    isGambling, targetsUae,
    licences, providers, providerHosts: providerHosts.map((h) => h.host),
    externalHosts: hosts.slice(0, 25),
    payments: { crypto, cards, agents },
    textLength: text.length,
    findings,
  };
}

// The registration record (RDAP) and certificate tell how long the site has existed.
function ageFindings({ registered, certFrom, certIssuer, certAuthorized }) {
  const out = [];
  const days = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);
  const domainAge = days(registered);
  if (domainAge !== null) {
    if (domainAge < 180) out.push({ id: 'domain-new', severity: 'high', ar: `النطاق مسجّل منذ ${domainAge} يومًا فقط. مواقع النصب تُنشأ وتختفي خلال أشهر.`, en: `The domain is only ${domainAge} days old. Scam sites appear and vanish within months.`, evidence: registered });
    else if (domainAge < 730) out.push({ id: 'domain-young', severity: 'medium', ar: `عمر النطاق ${Math.round(domainAge / 30)} شهرًا.`, en: `The domain is ${Math.round(domainAge / 30)} months old.`, evidence: registered });
    else out.push({ id: 'domain-age', severity: 'ok', ar: `عمر النطاق ${(domainAge / 365).toFixed(1)} سنة.`, en: `The domain is ${(domainAge / 365).toFixed(1)} years old.`, evidence: registered });
  } else {
    out.push({ id: 'domain-unknown', severity: 'low', ar: 'تعذّر قراءة تاريخ تسجيل النطاق (السجل مخفي أو الامتداد لا يدعم RDAP).', en: 'Could not read the domain registration date (hidden record or a TLD without RDAP).', evidence: null });
  }
  if (certAuthorized === false) out.push({ id: 'cert-invalid', severity: 'high', ar: 'شهادة TLS غير صالحة أو غير موثوقة.', en: 'The TLS certificate is invalid or untrusted.', evidence: certIssuer });
  const certAge = days(certFrom);
  if (certAge !== null && certAge < 30 && domainAge !== null && domainAge < 365) out.push({ id: 'cert-new', severity: 'low', ar: `الشهادة صادرة منذ ${certAge} يومًا.`, en: `The certificate was issued ${certAge} days ago.`, evidence: certIssuer });
  return out;
}

function hostingFindings(geo) {
  const out = [];
  if (!geo) return out;
  const where = [geo.country, geo.isp || geo.org].filter(Boolean).join(' · ');
  if (geo.countryCode === 'AE') out.push({ id: 'host-uae', severity: 'info', ar: `الخادم في الإمارات (${where}).`, en: `Server in the UAE (${where}).`, evidence: geo.ip });
  else out.push({ id: 'host-abroad', severity: 'info', ar: `الخادم خارج الإمارات: ${where || geo.ip}.`, en: `Server outside the UAE: ${where || geo.ip}.`, evidence: geo.ip });
  if (geo.cdn) out.push({ id: 'host-cdn', severity: 'low', ar: `خلف شبكة ${geo.cdn}: العنوان الحقيقي للخادم مخفي.`, en: `Behind ${geo.cdn}: the real server address is hidden.`, evidence: geo.ip });
  return out;
}

function score(findings) {
  let points = 0;
  for (const f of findings) points += SEVERITY_WEIGHT[f.severity] || 0;
  const risk = Math.min(100, points);
  const level = risk >= 60 ? 'danger' : risk >= 30 ? 'warning' : 'caution';
  return { risk, level };
}

// Also copied into lab/core/site.js by scripts/make-site-core.mjs so the page can
// analyse a source the user pasted from their own browser, offline.
module.exports = { analyzeHtml, ageFindings, hostingFindings, score, strip, externalHosts, registrable, SEVERITY_WEIGHT };
