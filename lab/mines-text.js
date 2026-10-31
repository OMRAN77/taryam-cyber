// Strings for mines.html. Language follows the main app's setting (aiapp_lang).
const T = {
  pageTitle: ['Mines من أ إلى ي', 'Mines from A to Z'],
  subtitle: ['اللعبة الحقيقية، بأرقامها هي: كيف تُحسم الجولة قبل نقرتك، وكم يأخذ منك في كل نقرة، وماذا بقي لك', 'The real game, on its own numbers: how the round is settled before your click, what each click costs, and what is left'],
  back: ['العودة للتطبيق', 'Back to the app'],
  checkLink: ['فحص الكازينو', 'Casino check'],
  casinoLink: ['كيف يكسب الكازينو', 'How the casino wins'],
  language: ['English', 'العربية'],
  privacy: ['كل شيء هنا يُحسب في متصفحك ولا يُرسل شيء. سياسة الصفحة تمنع أي اتصال.', 'Everything here is computed in your browser and nothing is sent. The page policy blocks every connection.'],

  // Storyline
  storyTitle: ['القصة في أربع خطوات', 'The story in four steps'],
  story1: ['١ — قبل أن تضغط «ابدأ» تكون مواقع الألغام محسومة ومختومة ببصمة. لا نقرتك ولا «حظّك» يغيّرانها.', '1 — Before you press Start the mine layout is already fixed and sealed with a hash. Neither your click nor your "luck" changes it.'],
  story2: ['٢ — في كل نقرة تخاطر باحتمال معروف، واللعبة تدفع لك أقل من ذلك الاحتمال. الفرق هو أجرها، وتأخذه في كل نقرة سواء ربحت أو خسرت.', '2 — Every click risks a known probability, and the game pays you less than that probability is worth. The gap is its fee, taken on every click whether you win or lose.'],
  story3: ['٣ — جلستك الحقيقية تُظهر الأجر وقد تجمّع: المعلن 96٪، وما رجع لك فعلًا أقل أو أكثر — بالأرقام.', '3 — Your real session shows the fee once it has piled up: 96% declared, and what actually came back — in numbers.'],
  story4: ['٤ — اللعبة نفسها أصلية ومرخّصة؛ النصب في الموقع الذي يشغّلها بلا ترخيص في الإمارات: رصيدك عنده بلا أي حق قانوني.', '4 — The game itself is genuine and licensed; the fraud is the site running it unlicensed in the UAE: your balance sits there with no legal right.'],

  // 1 commitment
  commitTitle: ['١. الجولة محسومة قبل نقرتك', '1. The round is settled before your click'],
  commitIntro: ['افتح «العدالة / Provably fair» داخل اللعبة. قبل الجولة تعرض بصمة (hash)، وبعدها تكشف البذرة (seed). الصقهما هنا: إن كانت SHA-256 للبذرة هي البصمة نفسها، فالتخطيط كان مكتوبًا قبل أن تلمس شيئًا.', 'Open "Fairness / Provably fair" inside the game. Before the round it shows a hash; after it reveals the seed. Paste both: if SHA-256 of the seed equals the hash, the layout was written before you touched anything.'],
  hashIn: ['البصمة المعروضة قبل الجولة', 'Hash shown before the round'],
  seedIn: ['البذرة المكشوفة بعد الجولة', 'Seed revealed after the round'],
  verify: ['تحقّق', 'Verify'],
  example: ['مثال', 'Example'],
  cMatch: ['مطابقة: نتيجة الجولة كانت مختومة قبل رهانك. لا نقرة ولا توقيت ولا «أداة تنبؤ» تغيّرها.', 'Match: the round\'s outcome was sealed before your bet. No click, timing or "predictor" changes it.'],
  cMismatch: ['لا تطابق: البذرة ليست هي التي التُزم بها، أو أحد الحقلين منسوخ خطأ. راجع النسخ؛ إن تكرر، فهذا دليل تلاعب يُقدَّم.', 'No match: the seed is not the one committed to, or one field was copied wrong. Recheck the copy; if it repeats, this is evidence of tampering.'],
  cNeed: ['أدخل البصمة والبذرة.', 'Enter both the hash and the seed.'],
  commitNote: ['ما يعنيه هذا للاعب: اللعبة لا «تراك» ولا تردّ على رهانك الكبير بلغم؛ القرار سبق رهانك. والخسارة ليست من الغش في الجولة، بل من الحساب في الخطوة التالية.', 'What this means for the player: the game does not "see you" or answer a big bet with a mine; the decision preceded your bet. The loss does not come from cheating in the round but from the arithmetic in the next step.'],

  // 2 ladder
  ladderTitle: ['٢. كم يأخذ منك في كل نقرة', '2. What each click takes from you'],
  ladderIntro: ['اختر عدد الألغام كما في اللعبة، واكتب المضاعِفات التي تعرضها اللعبة على الشاشة إن أردت (أو اتركها فنحسبها من 96٪). الجدول يقارن ما تدفعه اللعبة بما يساويه احتمالك فعلًا.', 'Pick the number of mines as in the game, and type the multipliers the game shows on screen if you like (or leave them and we use 96%). The table compares what the game pays with what your odds are actually worth.'],
  minesIn: ['عدد الألغام', 'Mines'],
  betIn: ['الرهان', 'Bet'],
  rtpIn: ['العائد المعلن ٪', 'Declared RTP %'],
  multsIn: ['مضاعِفات اللعبة بالترتيب (اختياري)', 'The game\'s multipliers in order (optional)'],
  multsHint: ['مثال: 1.09 1.24 1.43 1.66 — كما تظهر فوق الشبكة بعد كل نقرة.', 'e.g. 1.09 1.24 1.43 1.66 — as shown above the grid after each click.'],
  compute: ['احسب', 'Compute'],
  colK: ['النقرة', 'Click'],
  colBomb: ['فرصة الانفجار الآن', 'Chance of a bomb now'],
  colSurvive: ['الوصول إلى هنا', 'Reaching this point'],
  colFair: ['المضاعِف العادل', 'Fair multiplier'],
  colOffered: ['ما تدفعه اللعبة', 'What the game pays'],
  colTake: ['أجر اللعبة', 'The game\'s cut'],
  colEv: ['قيمة رهانك هنا', 'Your bet is worth here'],
  fromGame: ['من اللعبة', 'from the game'],
  ladderHeadline: ['عند كل نقرة تتوقف فيها، رهانك يساوي {ev} من {bet}. الفرق — {take} — هو أجر اللعبة، ثابت لا يتغير بمهارتك.', 'Wherever you stop, your bet is worth {ev} of {bet}. The gap — {take} — is the game\'s fee, fixed regardless of skill.'],
  ladderImplied: ['العائد الذي تدل عليه مضاعِفات اللعبة التي كتبتها: {rtp}', 'The return implied by the multipliers you typed: {rtp}'],
  ladderImpliedLow: ['— أقل من المعلن بوضوح: هذه ليست الجدول الأصلي للعبة.', '— clearly below the declared figure: this is not the game\'s original table.'],
  ladderImpliedOk: ['— متسق مع 96٪ المعلنة: الجدول الأصلي.', '— consistent with the declared 96%: the original table.'],
  walkTitle: ['جرّب نقرة نقرة', 'Try it click by click'],
  walkSafe: ['نقرة آمنة', 'Safe click'],
  walkReset: ['من جديد', 'Start over'],
  walkState: ['بعد {k} نقرة: الشاشة تعرض ×{mult} ({payout}). فرصة الانفجار في النقرة التالية {bomb}. القيمة الحقيقية لما تحمله الآن {ev} لا {payout}.', 'After {k} clicks: the screen shows ×{mult} ({payout}). The chance of a bomb on the next click is {bomb}. What you hold is really worth {ev}, not {payout}.'],
  walkStart: ['اضغط «نقرة آمنة» لتتبع ما يعرضه الشاشة مقابل ما يساويه.', 'Press "Safe click" to follow what the screen shows against what it is worth.'],
  sessionTitle: ['ماذا يعني هذا بعد {n} جولة', 'What this means after {n} rounds'],
  roundsIn: ['عدد الجولات', 'Rounds'],
  sWagered: ['مجموع ما تراهن به', 'Total wagered'],
  sLoss: ['الخسارة المتوقعة', 'Expected loss'],
  sAhead: ['فرصة أن تخرج رابحًا (توقف بعد نقرة واحدة كل مرة)', 'Chance to finish ahead (cashing out after one click each time)'],

  // 3 history
  histTitle: ['٣. رهاناتك الحقيقية على هذه اللعبة', '3. Your real bets on this game'],
  histIntro: ['انسخ جدول «رهاناتي» من الموقع والصقه. نقرأ الرهان والمكسب من كل سطر ونقارن ما رجع لك فعلًا بالـ96٪ المعلنة.', 'Copy the "My bets" table from the site and paste it. We read the bet and payout from every line and compare what actually came back with the declared 96%.'],
  histIn: ['السجل', 'The log'],
  analyse: ['حلّل', 'Analyse'],
  hRounds: ['الجولات', 'Rounds'], hBets: ['مجموع الرهانات', 'Total bets'], hWins: ['مجموع المكاسب', 'Total payouts'], hNet: ['النتيجة', 'Net'],
  hReturn: ['رجع لك من كل 100', 'Back to you per 100'], hTake: ['أخذت اللعبة من كل 100', 'The game kept per 100'],
  hCi: ['العائد الحقيقي (ثقة 95٪) بين', 'True return (95% confidence) between'], hZ: ['الفرق عن 96٪', 'Difference from 96%'],
  parsedRows: ['أسطر مقروءة', 'Lines read'], skippedRows: ['أسطر متجاهلة', 'Lines skipped'],
  vNormal: ['ضمن المعتاد: خسارتك هي أجر اللعبة المعلن وقد تجمّع — لا أكثر ولا أقل.', 'Within the usual: your loss is the declared fee, piled up — no more, no less.'],
  vReview: ['يستحق المراجعة: خسارتك أعلى من المعلن بشكل غير معتاد.', 'Worth reviewing: your loss is unusually above the declared figure.'],
  vSuspicious: ['مريب: خسارتك أعلى من المعلن بفارق يصعب تفسيره بالصدفة.', 'Suspicious: your loss exceeds the declared figure by a margin hard to explain by chance.'],
  histNeed: ['نحتاج سطرين على الأقل فيهما رهان ومكسب.', 'At least two lines with a bet and a payout are needed.'],

  // 4 operator
  siteTitle: ['٤. الطبقة الثانية: الموقع لا اللعبة', '4. The second layer: the site, not the game'],
  siteText1: ['Mines هذه من مزوّد أصلي (مرخّص في مالطا ورومانيا ولدى GCGRA الإماراتية). المزوّد يبيع اللعبة لأي موقع يدفع — والموقع الذي تلعب عليه هو من يحمل رصيدك.', 'This Mines comes from a genuine provider (licensed in Malta, Romania and with the UAE\'s GCGRA). The provider sells the game to any site that pays — and the site you play on is the one holding your balance.'],
  siteText2: ['موقع غير مرخّص في الإمارات يستطيع تجميد حسابك، ورفض السحب بحجة «شرط البونص»، وإغلاق النطاق والعودة باسم جديد — ولا جهة تلزمه بشيء. افحص الموقع نفسه:', 'A site unlicensed in the UAE can freeze your account, refuse a withdrawal citing a "bonus condition", and close the domain to return under a new name — with nobody to hold it to anything. Check the site itself:'],
  siteBtn: ['افحص الموقع الذي تلعب عليه', 'Check the site you play on'],
};

export function text(key, lang) {
  const v = T[key];
  if (!v) return key;
  return lang === 'en' ? v[1] : v[0];
}

export function fmt(s, vars) {
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : '{' + k + '}'));
}
