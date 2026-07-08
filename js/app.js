// ============================================================
// 自主学习刷题应用 — 支持单选题/多选题/判断题 + 错题本
// ============================================================

// ===== Constants =====
const WRONG_KEY = 'ms_wrong_questions';
const PROGRESS_KEY = 'ms_quiz_progress';
const TYPE_LABELS = { single: '单选题', multi: '多选题', judge: '判断题', fill: '填空题' };
const TYPE_COLORS = { single: '#6366f1', multi: '#10b981', judge: '#f59e0b', fill: '#ec4899' };
const TYPE_BADGE = {
  single: '<span class="badge badge-single">单选题</span>',
  multi:  '<span class="badge badge-multi">多选题</span>',
  judge:  '<span class="badge badge-judge">判断题</span>',
  fill:   '<span class="badge badge-fill">填空题</span>',
};
const LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

// ===== State =====
const state = {
  screen: 'welcome',   // welcome | quiz | result | review
  mode: null,           // sequential | shuffle | typeOnly | wrong
  subject: 'all',      // all | english | microservice
  typeFilter: 'all',   // all | single | multi | judge

  questions: [],
  currentIdx: 0,
  answers: [],
  
  // Multi selection buffer (not yet confirmed)
  multiSelected: {},
  // Fill answers buffer
  fillAnswers: {},  // { [questionIdx]: { [blankIdx]: "user answer" } }

  // Timer
  startTime: 0,
  timerInterval: null,

  // Settings
  totalQ: 0,
  showImg: true,

  // Whether options are shuffled per question (cached answer mapping)
  _shuffledMap: {},  // { [qId]: { options, answer } }
};

const app = document.getElementById('app');
const $ = s => document.querySelector(s);

// ===== Utility =====
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + s.toString().padStart(2, '0');
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function countBy(arr, keyFn) {
  const c = {};
  arr.forEach(x => { const k = keyFn(x); c[k] = (c[k] || 0) + 1; });
  return c;
}

// ===== Option Shuffling =====
function getShuffled(q) {
  // Judge: never shuffle (正确/错误 are fixed)
  if (q.type === 'judge') return q;
  const key = String(q.id);
  if (state._shuffledMap[key]) return state._shuffledMap[key];

  const opts = q.options;
  const n = opts.length;
  const indices = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const origLabels = opts.map(o => o.label);
  const shuffledOpts = indices.map((oldIdx, newIdx) => ({
    label: LABELS[newIdx],
    text: opts[oldIdx].text,
  }));

  // Remap answer to new labels
  const newAnswer = q.answer.split('').map(oldLabel => {
    const oldIdx = origLabels.indexOf(oldLabel);
    const newIdx = indices.indexOf(oldIdx);
    return LABELS[newIdx];
  }).sort().join('');

  const sq = { options: shuffledOpts, answer: newAnswer };
  state._shuffledMap[key] = sq;
  return sq;
}

function clearShuffledCache() {
  state._shuffledMap = {};
}
function cleanupKeyboard() {
  if (state._keydownHandler) {
    document.removeEventListener('keydown', state._keydownHandler);
    state._keydownHandler = null;
  }
}

// ===== Progress Persistence =====
function saveQuizProgress() {
  if (state.questions.length === 0) return;
  const progress = {
    mode: state.mode,
    subject: state.subject,
    typeFilter: state.typeFilter,
    currentIdx: state.currentIdx,
    totalQ: state.totalQ,
    showImg: state.showImg,
    questionIds: state.questions.map(q => q.id),
    answers: state.answers,
    startTime: state.startTime,
    elapsed: Math.floor((Date.now() - state.startTime) / 1000),
    timestamp: Date.now(),
  };
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch(e) { /* ignore */ }
}

function loadQuizProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function clearQuizProgress() {
  localStorage.removeItem(PROGRESS_KEY);
}

// ===== Wrong Question Persistence =====
function loadWrongQuestions() {
  try {
    const raw = localStorage.getItem(WRONG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveWrongQuestions(wrongMap) {
  localStorage.setItem(WRONG_KEY, JSON.stringify(wrongMap));
}

function recordWrong(q, userAnswer) {
  const wrongMap = loadWrongQuestions();
  const key = String(q.id);
  if (wrongMap[key]) {
    wrongMap[key].count += 1;
    wrongMap[key].lastTime = Date.now();
    wrongMap[key].userAnswer = userAnswer;
  } else {
    wrongMap[key] = {
      id: q.id, type: q.type, text: q.text,
      options: q.options, answer: q.answer, source: q.source, image: q.image,
      count: 1, lastTime: Date.now(), userAnswer: userAnswer,
    };
  }
  saveWrongQuestions(wrongMap);
}

function removeWrongQuestion(qId) {
  const wrongMap = loadWrongQuestions();
  delete wrongMap[String(qId)];
  saveWrongQuestions(wrongMap);
}

function clearWrongQuestions() {
  localStorage.removeItem(WRONG_KEY);
}

// ===== Answer Validation =====
function checkAnswer(q, selectedLabels, shuffledQ) {
  const answer = shuffledQ ? shuffledQ.answer : q.answer;
  if (q.type === 'single' || q.type === 'judge') {
    return selectedLabels.length === 1 && selectedLabels[0] === answer;
  }
  if (q.type === 'multi') {
    const userSet = [...selectedLabels].sort().join('');
    const correctSet = [...answer].sort().join('');
    return userSet === correctSet;
  }
  return false;
}

function checkPartialCorrect(q, selectedLabels, shuffledQ) {
  if (q.type !== 'multi') return false;
  const answer = shuffledQ ? shuffledQ.answer : q.answer;
  const userSet = [...selectedLabels].sort().join('');
  const correctSet = [...answer].sort().join('');
  if (userSet === correctSet) return false;
  for (const l of selectedLabels) {
    if (!correctSet.includes(l)) return false;
  }
  return selectedLabels.length > 0 && selectedLabels.length < answer.length;
}

// ============================================================
// SCREEN: Welcome
// ============================================================
function renderWelcome() {
  state.screen = 'welcome';
  state.currentIdx = 0;
  state.answers = [];
  state.multiSelected = {};
  clearShuffledCache();
  cleanupKeyboard();
  clearInterval(state.timerInterval);

  const total = ALL_QUESTIONS.length;
  const sourceCounts = countBy(ALL_QUESTIONS, q => q.source);
  const wrongCount = Object.keys(loadWrongQuestions()).length;
  const savedProgress = loadQuizProgress();

  const wrongBtnHtml = wrongCount > 0
    ? `<button class="mode-card" data-mode="wrong" style="margin-bottom:.5rem;">
        <div class="mode-icon">📕</div>
        <div class="mode-title">错题重练 (${wrongCount}题)</div>
        <div class="mode-desc">针对薄弱环节巩固练习</div>
       </button>`
    : '';
  
  const browseWrongHtml = wrongCount > 0
    ? `<button class="btn btn-resume" id="browseWrongBtn" style="margin-bottom:1rem;">📖 浏览全部错题</button>`
    : '';

  const resumeHtml = savedProgress
    ? `<button class="btn btn-resume" id="resumeBtn">⏯ 继续上次练习 (${savedProgress.currentIdx+1}/${savedProgress.questionIds.length})</button>`
    : '';

  app.innerHTML = `
    <div class="welcome fade-in">
      <div class="welcome-icon">
        <svg viewBox="0 0 24 24"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
      </div>
      <h1>自主检测刷题</h1>
      <p>支持单选题 · 多选题 · 判断题三种题型<br>涵盖英语、微服务应用开发技术与面向对象程序设计</p>
      <div class="stats-row">
        <div class="stat-item"><div class="num">${total}</div><div class="label">总题数</div></div>
        <div class="stat-item"><div class="num">${sourceCounts.english||0}</div><div class="label">英语</div></div>
        <div class="stat-item"><div class="num">${sourceCounts.microservice||0}</div><div class="label">微服务</div></div>
        <div class="stat-item"><div class="num">${sourceCounts.oop||0}</div><div class="label">面向对象</div></div>
      </div>

      ${resumeHtml}

      <div class="section-label">选择题库</div>
      <div class="filter-row">
        <button class="filter-btn active" data-subject="all">全部 (${total})</button>
        <button class="filter-btn" data-subject="english">英语 (${sourceCounts.english||0})</button>
        <button class="filter-btn" data-subject="microservice">微服务 (${sourceCounts.microservice||0})</button>
        <button class="filter-btn" data-subject="oop">面向对象 (${sourceCounts.oop||0})</button>
      </div>

      <div class="section-label">题型筛选</div>
      <div class="filter-row">
        <button class="filter-btn active" data-type="all">全部 (${total})</button>
        <button class="filter-btn" data-type="single">单选题 (${ALL_QUESTIONS.filter(q=>q.type==='single').length})</button>
        <button class="filter-btn" data-type="multi">多选题 (${ALL_QUESTIONS.filter(q=>q.type==='multi').length})</button>
        <button class="filter-btn" data-type="judge">判断题 (${ALL_QUESTIONS.filter(q=>q.type==='judge').length})</button>
        <button class="filter-btn" data-type="fill">填空题 (${ALL_QUESTIONS.filter(q=>q.type==='fill').length})</button>
      </div>

      <div class="settings-panel">
        <div class="setting-row">
          <span class="setting-label">显示图片</span>
          <div class="setting-control">
            <input type="checkbox" id="toggleImg" ${state.showImg?'checked':''} style="width:18px;height:18px;accent-color:#6366f1;">
          </div>
        </div>
        <div class="setting-row">
          <span class="setting-label">刷题数量</span>
          <div class="setting-control">
            <input type="range" id="qCountRange" min="5" max="${total}" step="5" value="${Math.min(total,50)}">
            <span class="range-val" id="qCountVal">${Math.min(total,50)}</span>
          </div>
        </div>
        <div class="setting-row">
          <span class="setting-label">选项顺序随机</span>
          <div class="setting-control">
            <input type="checkbox" id="toggleShuffle" checked style="width:18px;height:18px;accent-color:#6366f1;">
          </div>
        </div>
      </div>

      <div class="section-label">练习模式</div>
      <div class="mode-grid">
        <div class="mode-card" data-mode="sequential">
          <div class="mode-icon">📝</div>
          <div class="mode-title">顺序刷题</div>
          <div class="mode-desc">按筛选条件顺序作答，选项乱序</div>
        </div>
        <div class="mode-card" data-mode="shuffle">
          <div class="mode-icon">🔀</div>
          <div class="mode-title">随机练习</div>
          <div class="mode-desc">题目乱序 + 选项乱序</div>
        </div>
        <div class="mode-card" data-mode="typeOnly">
          <div class="mode-icon">🎯</div>
          <div class="mode-title">专项练习</div>
          <div class="mode-desc">按题型筛选，题目乱序 + 选项乱序</div>
        </div>
        ${wrongBtnHtml}
      </div>

      ${browseWrongHtml}

      <button class="btn btn-primary" id="startBtn" disabled>选择模式开始</button>
    </div>
  `;

  // Resume
  const resumeBtn = document.getElementById('resumeBtn');
  if (resumeBtn) {
    resumeBtn.addEventListener('click', resumeQuiz);
  }

  // ===== Dynamic type count update =====
  function updateTypeCounts() {
    const subj = document.querySelector('[data-subject].active')?.dataset?.subject || 'all';
    const typeF = document.querySelector('[data-type].active')?.dataset?.type || 'all';
    const filtered = subj === 'all' ? ALL_QUESTIONS : ALL_QUESTIONS.filter(q => q.source === subj);
    const singleCount = filtered.filter(q => q.type === 'single').length;
    const multiCount = filtered.filter(q => q.type === 'multi').length;
    const judgeCount = filtered.filter(q => q.type === 'judge').length;
    const fillCount = filtered.filter(q => q.type === 'fill').length;
    document.querySelector('[data-type="all"]').textContent = `全部 (${filtered.length})`;
    document.querySelector('[data-type="single"]').textContent = `单选题 (${singleCount})`;
    document.querySelector('[data-type="multi"]').textContent = `多选题 (${multiCount})`;
    document.querySelector('[data-type="judge"]').textContent = `判断题 (${judgeCount})`;
    document.querySelector('[data-type="fill"]').textContent = `填空题 (${fillCount})`;
    // Compute slider max: apply both subject AND type filter
    let pool = subj === 'all' ? ALL_QUESTIONS : ALL_QUESTIONS.filter(q => q.source === subj);
    if (typeF !== 'all') pool = pool.filter(q => q.type === typeF);
    const totalCount = pool.length;
    // Update the range max & value
    const range = document.getElementById('qCountRange');
    if (range) {
      const val = document.getElementById('qCountVal');
      const effectiveMax = Math.max(totalCount, 5);
      // "全部"题型用步长1（可精确选到每位数的题量），具体题型用步长1或5
      const newStep = (typeF === 'all') ? '1' : (effectiveMax <= 50 ? '1' : '5');
      range.step = newStep;
      range.max = effectiveMax;
      let newVal;
      if (typeF === 'all') {
        newVal = effectiveMax;
      } else {
        newVal = parseInt(range.value);
        if (newVal > effectiveMax) newVal = effectiveMax;
        const stepNum = parseInt(newStep);
        newVal = Math.max(5, Math.min(effectiveMax, Math.round(newVal / stepNum) * stepNum));
      }
      range.value = String(newVal);
      state.totalQ = newVal;
      val.textContent = String(newVal);
    }
  }

  // Subject filter with dynamic type update
  document.querySelectorAll('[data-subject]').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('[data-subject]').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      state.subject = el.dataset.subject;
      updateTypeCounts();
    });
  });

  // Type filter
  document.querySelectorAll('[data-type]').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('[data-type]').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      state.typeFilter = el.dataset.type;
      updateTypeCounts();
    });
  });

  $('#toggleImg').addEventListener('change', e => { state.showImg = e.target.checked; });

  const range = $('#qCountRange');
  const val = $('#qCountVal');
  range.addEventListener('input', () => {
    val.textContent = range.value;
    state.totalQ = parseInt(range.value);
  });
  state.totalQ = parseInt(range.value);

  document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      state.mode = card.dataset.mode;
      $('#startBtn').disabled = false;
      const title = card.querySelector('.mode-title').textContent;
      $('#startBtn').textContent = '开始 ' + title.replace(/\(\d+题\)/, '').trim();
    });
  });

  $('#startBtn').addEventListener('click', startQuiz);

  // Browse wrong questions
  const browseBtn = document.getElementById('browseWrongBtn');
  if (browseBtn) {
    browseBtn.addEventListener('click', renderWrongPage);
  }
}

// ============================================================
// Resume from saved progress
// ============================================================
function resumeQuiz() {
  const saved = loadQuizProgress();
  if (!saved) { renderWelcome(); return; }

  // Rebuild questions array from saved IDs
  const qMap = {};
  ALL_QUESTIONS.forEach(q => { qMap[q.id] = q; });
  const questions = saved.questionIds.map(id => qMap[id]).filter(Boolean);
  if (questions.length === 0) { renderWelcome(); return; }

  state.mode = saved.mode;
  state.subject = saved.subject;
  state.typeFilter = saved.typeFilter;
  state.totalQ = saved.totalQ;
  state.showImg = saved.showImg;
  state.questions = questions;
  state.currentIdx = saved.currentIdx;
  state.answers = saved.answers || [];
  state.multiSelected = {};

  // Rebuild shuffled cache so options appear same as before
  clearShuffledCache();

  state.startTime = Date.now() - (saved.elapsed || 0) * 1000;

  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(updateTimer, 1000);
  state.screen = 'quiz';
  renderQuiz();
}

// ============================================================
// SCREEN: Quiz Start
// ============================================================
function startQuiz() {
  state.currentIdx = 0;
  state.answers = [];
  state.multiSelected = {};
  clearShuffledCache();
  clearQuizProgress();
  state.startTime = Date.now();

  // Filter by subject
  let pool = [...ALL_QUESTIONS];
  if (state.subject !== 'all') {
    pool = pool.filter(q => q.source === state.subject);
  }
  // Filter by type
  if (state.typeFilter !== 'all') {
    pool = pool.filter(q => q.type === state.typeFilter);
  }
  // Wrong mode: use wrong questions
  if (state.mode === 'wrong') {
    // Auto-clean stale entries (questions that no longer exist)
    const allIds = new Set(ALL_QUESTIONS.map(q => String(q.id)));
    const wrongMap = loadWrongQuestions();
    let changed = false;
    Object.keys(wrongMap).forEach(k => {
      if (!allIds.has(k)) { delete wrongMap[k]; changed = true; }
    });
    if (changed) saveWrongQuestions(wrongMap);
    
    const wrongIds = new Set(Object.keys(wrongMap));
    pool = pool.filter(q => wrongIds.has(String(q.id)));
    if (pool.length === 0) {
      renderWelcome();
      return;
    }
  }

  // Determine question order
  if (state.mode === 'shuffle' || state.mode === 'typeOnly') {
    state.questions = shuffle(pool).slice(0, state.totalQ);
  } else {
    // Sequential mode: sort by type (单选→多选→判断→填空) within each subject
    const typeOrder = { single: 0, multi: 1, judge: 2, fill: 3 };
    pool.sort((a, b) => (typeOrder[a.type] || 99) - (typeOrder[b.type] || 99));
    state.questions = pool.slice(0, state.totalQ);
  }

  if (state.questions.length === 0) { renderWelcome(); return; }

  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(updateTimer, 1000);
  state.screen = 'quiz';
  renderQuiz();
}

// ===== Timer =====
function updateTimer() {
  const el = document.getElementById('timerDisplay');
  if (!el) return;
  el.textContent = formatTime(Math.floor((Date.now() - state.startTime) / 1000));
}

// ============================================================
// SCREEN: Quiz
// ============================================================
function renderQuiz() {
  const idx = state.currentIdx;
  const q = state.questions[idx];
  const total = state.questions.length;
  const correctCount = state.answers.filter(a => a && a.correct).length;
  const pct = total > 0 ? (idx / total) * 100 : 0;
  const isLast = idx >= total - 1;

  const existingAnswer = state.answers[idx];
  const isRevealed = !!(existingAnswer && existingAnswer.submitted);

  // Apply shuffled options (unless judge)
  const useShuffle = document.getElementById('toggleShuffle')?.checked ?? true;
  const shuffledQ = (useShuffle && q.type !== 'judge') ? getShuffled(q) : q;

  // Multi selection buffer
  if (!isRevealed && q.type === 'multi' && !state.multiSelected[idx]) {
    state.multiSelected[idx] = {};
  }

  // Image
  let imgHtml = '';
  if (q.image && state.showImg) {
    imgHtml = '<img src="img/' + q.image + '" alt="配图" class="question-image">';
  }

  // Options rendering (pass shuffledQ which may differ from q)
  let optionsHtml = '';
  let fillInputHtml = '';
  if (q.type === 'single') {
    optionsHtml = renderSingleOptions(shuffledQ, existingAnswer, isRevealed);
  } else if (q.type === 'multi') {
    optionsHtml = renderMultiOptions(shuffledQ, existingAnswer, isRevealed, idx);
  } else if (q.type === 'judge') {
    optionsHtml = renderJudgeOptions(q, existingAnswer, isRevealed);
  } else if (q.type === 'fill') {
    fillInputHtml = renderFillInputs(q, existingAnswer, isRevealed, idx);
  }

  // Explanation area
  let explanationHtml = '';
  if (isRevealed) {
    const isCorrect = existingAnswer.correct;
    let correctAnswerLabel;
    if (q.type === 'judge') {
      correctAnswerLabel = q.answer;
    } else if (q.type === 'multi') {
      correctAnswerLabel = shuffledQ.answer.split('').map(l => {
        const opt = shuffledQ.options.find(o => o.label === l);
        return l + (opt ? '. ' + opt.text : '');
      }).join('、');
    } else if (q.type === 'fill') {
      correctAnswerLabel = q.answer;
    } else {
      correctAnswerLabel = shuffledQ.answer + '. ' + (shuffledQ.options.find(o => o.label === shuffledQ.answer)?.text || '');
    }
    // For fill, show per-blank detail
    let fillDetail = '';
    if (q.type === 'fill' && existingAnswer.perBlank) {
      const answers = q.answer.split('、');
      fillDetail = '<div style="margin-top:.5rem;font-size:.85rem;">';
      existingAnswer.perBlank.forEach((b, i) => {
        const ans = answers[i] || '';
        const ok = b.correct;
        fillDetail += `<div style="margin-bottom:.25rem;color:${ok?'#16a34a':'#dc2626'};">
          <span style="font-weight:600;">空${i+1}：</span>
          <span>你的答案「${escapeHtml(b.answer)}」</span>
          <span> → ${ok ? '✓' : '✗'} 正确答案：${escapeHtml(ans)}</span>
        </div>`;
      });
      fillDetail += '</div>';
    }
    explanationHtml = `
      <div class="explanation show ${isCorrect ? 'exp-correct' : 'exp-wrong'}">
        <div class="exp-icon">${isCorrect ? '✅' : '❌'}</div>
        <div>
          <strong>${isCorrect ? '回答正确' : '回答错误'}</strong><br>
          <span style="color:#888;font-size:.85rem;">正确答案：${escapeHtml(correctAnswerLabel)}</span>
          ${fillDetail}
        </div>
      </div>`;
  }

  const sourceLabel = q.source === 'english' ? '英语' : q.source === 'microservice' ? '微服务' : q.source === 'oop' ? '面向对象' : q.source;

  // Navigation - always show prev + save-exit, and next/skip
  let navHtml;
  if (!isRevealed) {
    navHtml = `
      <div class="nav-bar">
        <button class="btn btn-ghost btn-sm" id="prevBtn" ${idx===0?'disabled':''}>← 上一题</button>
        <button class="btn btn-ghost btn-sm" id="skipBtn">跳过 →</button>
        <button class="btn btn-ghost btn-sm" id="exitSaveBtn" style="margin-left:auto;color:#ef4444;">✕ 退出保存</button>
      </div>`;
  } else {
    navHtml = `
      <div class="nav-bar">
        <button class="btn btn-ghost btn-sm" id="prevBtn" ${idx===0?'disabled':''}>← 上一题</button>
        <button class="btn btn-primary btn-sm" id="nextBtn">${isLast ? '📊 查看结果' : '下一题 →'}</button>
        <button class="btn btn-ghost btn-sm" id="exitSaveBtn" style="margin-left:auto;color:#ef4444;">✕ 退出保存</button>
      </div>`;
  }

  // Submit button for multi / fill
  let multiSubmitHtml = '';
  if (q.type === 'multi' && !isRevealed) {
    const selectedCount = Object.keys(state.multiSelected[idx] || {}).length;
    multiSubmitHtml = `
      <div style="text-align:center;margin-top:.8rem;">
        <span style="font-size:.8rem;color:#888;">已选 ${selectedCount} 项</span>
        <button class="btn btn-primary btn-sm" id="confirmMultiBtn" style="margin-left:.5rem;"
          ${selectedCount===0?'disabled':''}>✓ 确认提交</button>
      </div>`;
  } else if (q.type === 'fill' && !isRevealed) {
    multiSubmitHtml = `
      <div style="text-align:center;margin-top:.8rem;">
        <button class="btn btn-primary btn-sm" id="confirmFillBtn">✓ 确认提交</button>
      </div>`;
  }

  // Use persistent container to avoid full DOM rebuild (prevents flash)
  var qc = document.getElementById('quizContainer');
  if (!qc) {
    qc = document.createElement('div');
    qc.id = 'quizContainer';
    qc.className = 'fade-in';
    app.innerHTML = '';
    app.appendChild(qc);
  }
  qc.innerHTML = `
    <div class="quiz-header">
      <div class="progress-bar-container">
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <span class="progress-text">${idx+1} / ${total}</span>
        <span class="score-badge">✓ ${correctCount}</span>
        <span class="timer" id="timerDisplay">${formatTime(Math.floor((Date.now()-state.startTime)/1000))}</span>
      </div>
    </div>
    <div class="question-area">
      <div class="question-card">
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem;">
          <span class="question-number">第 ${idx+1} 题</span>
          ${TYPE_BADGE[q.type]}
          <span style="font-size:.75rem;color:#999;">${sourceLabel}</span>
        ${q.image ? `<span style="font-size:.7rem;color:#aaa;margin-left:auto;">含配图</span>` : ''}
        </div>
        ${imgHtml}
        <div class="question-text">${escapeHtml(q.text)}</div>
        <div class="options-list" id="optionsList">
          ${optionsHtml}
        </div>
        ${fillInputHtml}
        ${multiSubmitHtml}
        ${explanationHtml}
      </div>
    </div>
    ${navHtml}
  `;

  // ===== Event binding =====
  if (!isRevealed) {
    if (q.type === 'single') {
      document.querySelectorAll('#optionsList .option-btn').forEach(btn => {
        btn.addEventListener('click', () => selectSingle(q, shuffledQ, btn.dataset.opt, idx));
      });
    } else if (q.type === 'multi') {
      document.querySelectorAll('#optionsList .option-btn').forEach(btn => {
        btn.addEventListener('click', () => toggleMultiOption(btn, idx));
      });
      const confirmBtn = document.getElementById('confirmMultiBtn');
      if (confirmBtn) {
        confirmBtn.addEventListener('click', () => submitMulti(q, shuffledQ, idx));
      }
    } else if (q.type === 'judge') {
      document.querySelectorAll('#optionsList .option-btn').forEach(btn => {
        btn.addEventListener('click', () => selectJudge(q, btn.dataset.opt, idx));
      });
    } else if (q.type === 'fill') {
      const submitBtn = document.getElementById('confirmFillBtn');
      if (submitBtn) {
        submitBtn.addEventListener('click', () => submitFill(q, idx));
      }
      // Enter key in last input also submits
      const inputs = document.querySelectorAll('.fill-input');
      if (inputs.length > 0) {
        inputs[inputs.length - 1].addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submitBtn?.click();
        });
      }
    }
  }

  document.getElementById('prevBtn').addEventListener('click', () => {
    if (state.currentIdx > 0) { state.currentIdx--; renderQuiz(); }
  });

  const skipBtn = document.getElementById('skipBtn');
  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      if (state.currentIdx < state.questions.length - 1) {
        state.currentIdx++;
        renderQuiz();
      } else { renderResult(); }
    });
  }

  const nextBtn = document.getElementById('nextBtn');
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (isLast) { renderResult(); }
      else { state.currentIdx++; renderQuiz(); }
    });
  }

  // Fill input tracking (save to state on input)
  if (q.type === 'fill' && !isRevealed) {
    document.querySelectorAll('.fill-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const qIdx = parseInt(inp.dataset.idx);
        const bIdx = parseInt(inp.dataset.blank);
        if (!state.fillAnswers[qIdx]) state.fillAnswers[qIdx] = {};
        state.fillAnswers[qIdx][bIdx] = inp.value;
      });
    });
  }

  // ===== Keyboard navigation =====
  if (state._keydownHandler) {
    document.removeEventListener('keydown', state._keydownHandler);
  }
  state._keydownHandler = (e) => {
    // Enter → next (only if answered / revealed)
    if (e.key === 'Enter') {
      const nextBtn = document.getElementById('nextBtn');
      if (nextBtn) { nextBtn.click(); e.preventDefault(); return; }
      // Fill: if confirm button exists, click it
      const confirmFill = document.getElementById('confirmFillBtn');
      if (confirmFill && !confirmFill.disabled) { confirmFill.click(); e.preventDefault(); return; }
      const confirmMulti = document.getElementById('confirmMultiBtn');
      if (confirmMulti && !confirmMulti.disabled) { confirmMulti.click(); e.preventDefault(); return; }
    }
    // Tab: focus nav buttons in order (prev → next → exitSave)
    if (e.key === 'Tab') {
      const focused = document.activeElement;
      const navBtns = [];
      const p = document.getElementById('prevBtn');
      const n = document.getElementById('nextBtn');
      const s = document.getElementById('skipBtn');
      const x = document.getElementById('exitSaveBtn');
      if (p && !p.disabled) navBtns.push(p);
      if (n) navBtns.push(n);
      if (s) navBtns.push(s);
      if (x) navBtns.push(x);
      if (navBtns.length === 0) return;
      const curIdx = navBtns.indexOf(focused);
      if (e.shiftKey) {
        // Tab+Shift: previous button
        if (curIdx > 0) { navBtns[curIdx - 1].focus(); e.preventDefault(); }
      } else {
        // Tab: next button, or first from non-button
        if (curIdx >= 0 && curIdx < navBtns.length - 1) { navBtns[curIdx + 1].focus(); e.preventDefault(); }
        else if (curIdx < 0) { navBtns[0].focus(); e.preventDefault(); }
      }
    }
  };
  document.addEventListener('keydown', state._keydownHandler);

  // Exit & Save
  document.getElementById('exitSaveBtn').addEventListener('click', () => {
    saveQuizProgress();
    renderWelcome();
  });

  window.scrollTo(0, 0);
}

// ============================================================
// Option Renderers
// ============================================================

function renderSingleOptions(q, existingAnswer, isRevealed) {
  return q.options.map((opt, i) => {
    const letter = opt.label;
    let cls = 'option-btn option-single';
    if (isRevealed) {
      cls += ' disabled';
      if (letter === q.answer) cls += ' correct';
      if (existingAnswer && existingAnswer.selected === letter && letter !== q.answer) cls += ' wrong';
      if (existingAnswer && existingAnswer.selected === letter) cls += ' selected';
    }
    return `<button class="${cls}" data-opt="${letter}">
      <span class="option-letter option-letter-single">${letter}</span>
      <span>${escapeHtml(opt.text)}</span>
    </button>`;
  }).join('');
}

function renderMultiOptions(q, existingAnswer, isRevealed, idx) {
  return q.options.map((opt, i) => {
    const letter = opt.label;
    const isSelected = existingAnswer
      ? (existingAnswer.selected || '').includes(letter)
      : !!(state.multiSelected[idx] || {})[letter];
    let cls = 'option-btn option-multi';
    if (isRevealed) {
      cls += ' disabled';
      const isCorrectOpt = q.answer.includes(letter);
      if (isSelected && isCorrectOpt) cls += ' correct';
      else if (isSelected && !isCorrectOpt) cls += ' wrong';
      else if (!isSelected && isCorrectOpt) cls += ' missed';
    } else if (isSelected) {
      cls += ' selected';
    }
    return `<button class="${cls}" data-opt="${letter}">
      <span class="option-letter option-letter-multi">${letter}</span>
      <span>${escapeHtml(opt.text)}</span>
    </button>`;
  }).join('');
}

function renderJudgeOptions(q, existingAnswer, isRevealed) {
  return q.options.map((opt, i) => {
    const label = opt.label;
    let cls = 'option-btn option-judge';
    if (isRevealed) {
      cls += ' disabled';
      if (label === q.answer) cls += ' correct';
      if (existingAnswer && existingAnswer.selected === label && label !== q.answer) cls += ' wrong';
      if (existingAnswer && existingAnswer.selected === label) cls += ' selected';
    }
    const icon = label === '正确' ? '✓' : '✗';
    return `<button class="${cls}" data-opt="${label}">
      <span class="judge-icon ${label === '正确' ? 'jc-true' : 'jc-false'}">${icon}</span>
      <span>${label}</span>
    </button>`;
  }).join('');
}

// ===== Fill Input Renderer =====
function renderFillInputs(q, existingAnswer, isRevealed, idx) {
  // Replace ______ with input fields
  const blankPattern = /_{2,}/g;
  const parts = q.text.split(blankPattern);
  const answers = q.answer.split('、');
  const blankCount = parts.length - 1;

  // For revealed state, show user answers with per-blank highlighting
  let html = '<div class="fill-container">';
  parts.forEach((part, i) => {
    html += escapeHtml(part);
    if (i < blankCount) {
      if (isRevealed) {
        const userAns = (existingAnswer.perBlank && existingAnswer.perBlank[i]?.answer) || '';
        const isCorrect = (existingAnswer.perBlank && existingAnswer.perBlank[i]?.correct) || false;
        const correctAns = answers[i] || '';
        html += `<span class="fill-result ${isCorrect ? 'fill-correct' : 'fill-wrong'}">
          ${escapeHtml(userAns || '___')}
          <span class="fill-answer-hint">${escapeHtml(correctAns)}</span>
        </span>`;
      } else {
        const val = (state.fillAnswers && state.fillAnswers[idx] && state.fillAnswers[idx][i]) || '';
        html += `<input type="text" class="fill-input" data-idx="${idx}" data-blank="${i}"
          value="${escapeHtml(val)}" placeholder="填写答案" autocomplete="off">`;
      }
    }
  });
  html += '</div>';
  return html;
}

// ============================================================
// Answer Handlers
// ============================================================

function selectSingle(q, shuffledQ, selectedLetter, idx) {
  const correct = selectedLetter === shuffledQ.answer;
  state.answers[idx] = {
    submitted: true, correct: correct,
    selected: selectedLetter,
    time: Math.floor((Date.now() - state.startTime) / 1000)
  };
  if (!correct) recordWrong(q, selectedLetter);
  renderQuiz();
}

function selectJudge(q, selectedLabel, idx) {
  const correct = selectedLabel === q.answer;
  state.answers[idx] = {
    submitted: true, correct: correct,
    selected: selectedLabel,
    time: Math.floor((Date.now() - state.startTime) / 1000)
  };
  if (!correct) recordWrong(q, selectedLabel);
  renderQuiz();
}

function toggleMultiOption(btn, idx) {
  const letter = btn.dataset.opt;
  if (!state.multiSelected[idx]) state.multiSelected[idx] = {};
  if (state.multiSelected[idx][letter]) {
    delete state.multiSelected[idx][letter];
  } else {
    state.multiSelected[idx][letter] = true;
  }
  renderQuiz();
}

function submitMulti(q, shuffledQ, idx) {
  const selected = Object.keys(state.multiSelected[idx] || {});
  if (selected.length === 0) return;
  const correct = checkAnswer(q, selected, shuffledQ);
  const partial = checkPartialCorrect(q, selected, shuffledQ);
  state.answers[idx] = {
    submitted: true, correct: correct, partial: partial,
    selected: selected.sort().join(''),
    time: Math.floor((Date.now() - state.startTime) / 1000)
  };
  if (!correct) recordWrong(q, selected.sort().join(''));
  renderQuiz();
}

function submitFill(q, idx) {
  const answers = q.answer.split('、');
  const blankCount = answers.length;
  const userFill = state.fillAnswers[idx] || {};
  
  // Read from DOM inputs as fallback
  const inputs = document.querySelectorAll('.fill-input');
  inputs.forEach(inp => {
    const blankIdx = parseInt(inp.dataset.blank);
    const val = inp.value.trim();
    if (val) userFill[blankIdx] = val;
  });
  state.fillAnswers[idx] = userFill;

  // Check each blank
  const perBlank = [];
  let allCorrect = true;
  let anyFilled = false;
  for (let i = 0; i < blankCount; i++) {
    const userAns = (userFill[i] || '').trim();
    const correctAns = (answers[i] || '').trim();
    // 支持 "/" 分隔的可选答案（如"实例化/创建"，填其中任意一个即正确）
    // 支持大小写不敏感比较
    const alternatives = correctAns.split('/').map(s => s.trim().toLowerCase());
    const isCorrect = alternatives.some(alt => userAns.toLowerCase() === alt);
    perBlank.push({ answer: userAns, correct: isCorrect });
    if (!isCorrect) allCorrect = false;
    if (userAns) anyFilled = true;
  }

  if (!anyFilled) return; // No input at all, don't submit

  const allUserAnswers = perBlank.map(b => b.answer).join('、');
  state.answers[idx] = {
    submitted: true, correct: allCorrect,
    selected: allUserAnswers,
    perBlank: perBlank,
    time: Math.floor((Date.now() - state.startTime) / 1000)
  };
  if (!allCorrect) recordWrong(q, allUserAnswers);
  renderQuiz();
}

// ============================================================
// SCREEN: Result
// ============================================================
function renderResult() {
  state.screen = 'result';
  cleanupKeyboard();
  clearInterval(state.timerInterval);
  clearQuizProgress();
  const total = state.questions.length;
  const answered = state.answers.filter(a => a && a.submitted).length;
  const correct = state.answers.filter(a => a && a.correct).length;
  const wrong = answered - correct;
  const partialCount = state.answers.filter(a => a && a.partial).length;
  const scorePct = answered > 0 ? Math.round((correct / answered) * 100) : 0;
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  const circumference = 2 * Math.PI * 65;
  const offset = circumference - (scorePct / 100) * circumference;

  // Per-type stats
  const typeStats = {};
  ['single', 'multi', 'judge', 'fill'].forEach(t => {
    const qs = state.questions.filter(q => q.type === t);
    if (qs.length === 0) return;
    const corr = qs.map(q => {
      const realIdx = state.questions.indexOf(q);
      const a = state.answers[realIdx];
      return a && a.correct;
    }).filter(Boolean).length;
    typeStats[t] = { total: qs.length, correct: corr, rate: qs.length > 0 ? Math.round(corr/qs.length*100) : 0 };
  });

  let color = '#ef4444';
  if (scorePct >= 80) color = '#22c55e';
  else if (scorePct >= 60) color = '#f59e0b';

  let typeStatsHtml = '';
  Object.keys(typeStats).forEach(t => {
    const s = typeStats[t];
    const c = TYPE_COLORS[t];
    typeStatsHtml += `
      <div class="ts-row">
        <span class="ts-label">${TYPE_LABELS[t]}</span>
        <div class="ts-track"><div class="ts-fill" style="width:${s.rate}%;background:${c};"></div></div>
        <span class="ts-val">${s.correct}/${s.total} (${s.rate}%)</span>
      </div>`;
  });

  const wrongQCount = Object.keys(loadWrongQuestions()).length;

  app.innerHTML = `
    <div class="result-screen fade-in">
      <h2 style="margin-bottom:.3rem;">测试完成</h2>
      <p style="color:#888;font-size:.85rem;margin-bottom:1rem;">
        用时 ${formatTime(elapsed)} · ${answered}/${total} 已答
        ${partialCount > 0 ? `· ${partialCount} 题部分正确` : ''}
      </p>
      <div class="result-circle-wrap">
        <svg width="160" height="160" viewBox="0 0 160 160">
          <circle class="result-circle-bg" cx="80" cy="80" r="65"/>
          <circle class="result-circle-fg" cx="80" cy="80" r="65"
            stroke="${color}" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
        </svg>
        <div class="result-score-text">
          <div class="big">${scorePct}</div>
          <div class="small">正确率</div>
        </div>
      </div>
      <div class="result-stats">
        <div class="result-stat"><div class="val" style="color:#22c55e">${correct}</div><div class="lbl">答对</div></div>
        <div class="result-stat"><div class="val" style="color:#ef4444">${wrong}</div><div class="lbl">答错</div></div>
        <div class="result-stat"><div class="val" style="color:#6366f1">${answered}</div><div class="lbl">已答</div></div>
      </div>
      ${typeStatsHtml ? `<div class="type-stats">${typeStatsHtml}</div>` : ''}
      <div class="result-actions">
        <button class="btn btn-primary" id="reviewBtn">📋 答题回顾</button>
        <button class="btn btn-secondary" id="retryBtn">🔄 再来一次</button>
        <button class="btn btn-ghost" id="wrongBtn">📕 错题本 (${wrongQCount})</button>
        <button class="btn btn-ghost" id="homeBtn">🏠 返回首页</button>
      </div>
    </div>
  `;

  document.getElementById('reviewBtn').addEventListener('click', renderReview);
  document.getElementById('retryBtn').addEventListener('click', startQuiz);
  document.getElementById('homeBtn').addEventListener('click', renderWelcome);
  document.getElementById('wrongBtn').addEventListener('click', renderWrongPage);
}

// ============================================================
// SCREEN: Review
// ============================================================
function renderReview() {
  state.screen = 'review';

  app.innerHTML = `
    <div class="review-screen fade-in">
      <div class="review-header">
        <h2>📋 答题回顾</h2>
        <div style="display:flex;gap:.5rem;">
          <button class="btn btn-ghost btn-sm" id="wrongFromReviewBtn">📕 错题本</button>
          <button class="btn btn-ghost btn-sm" id="backHomeBtn">🏠 返回</button>
        </div>
      </div>
      <div class="review-filter-bar">
        <button class="rf-btn active" data-rf="all">全部 (${state.questions.length})</button>
        <button class="rf-btn" data-rf="correct">正确 (${state.answers.filter(a=>a&&a.correct).length})</button>
        <button class="rf-btn" data-rf="wrong">错误 (${state.answers.filter(a=>a&&!a.correct).length})</button>
        <button class="rf-btn" data-rf="unanswered">未答 (${state.answers.filter(a=>!a||!a.submitted).length})</button>
      </div>
      <div id="reviewList"></div>
    </div>
  `;

  function renderReviewList(filter) {
    const list = document.getElementById('reviewList');
    let html = '';
    state.questions.forEach((q, i) => {
      const ans = state.answers[i];
      const isSubmitted = ans && ans.submitted;
      const isCorrect = ans && ans.correct;
      const isPartial = ans && ans.partial;

      if (filter === 'correct' && !isCorrect) return;
      if (filter === 'wrong' && !(isSubmitted && !isCorrect)) return;
      if (filter === 'unanswered' && isSubmitted) return;

      let statusClass = 'unanswered';
      let statusText = '未答';
      if (isSubmitted) {
        if (isCorrect) { statusClass = 'correct'; statusText = '正确'; }
        else if (isPartial) { statusClass = 'partial'; statusText = '部分正确'; }
        else { statusClass = 'wrong'; statusText = '错误'; }
      }

      let answerDetail = '';
      if (isSubmitted) {
        const userAnswer = q.type === 'judge' ? ans.selected
          : q.type === 'multi'
            ? ans.selected.split('').map(l => {
                const opt = q.options.find(o => o.label === l);
                return l + (opt ? '. ' + opt.text : '');
              }).join('、')
            : q.type === 'fill' ? (ans.selected || '')
            : ans.selected + '. ' + (q.options.find(o => o.label === ans.selected)?.text || '');
        const correctAnswer = q.type === 'judge' ? q.answer
          : q.type === 'multi'
            ? q.answer.split('').map(l => {
                const opt = q.options.find(o => o.label === l);
                return l + (opt ? '. ' + opt.text : '');
              }).join('、')
            : q.type === 'fill' ? q.answer
            : q.answer + '. ' + (q.options.find(o => o.label === q.answer)?.text || '');
        answerDetail = `
          <div class="ri-detail">
            <span style="color:#22c55e;">✓ 正确答案：${escapeHtml(correctAnswer)}</span>
            ${!isCorrect ? `<br><span style="color:#ef4444;">✗ 你的答案：${escapeHtml(userAnswer)}</span>` : ''}
          </div>`;
      }

      html += `<div class="review-item ${statusClass}">
        <div class="ri-header">
          <span class="ri-q">第 ${q.id} 题</span>
          ${TYPE_BADGE[q.type]}
          <span class="ri-status ${statusClass}">${statusText}</span>
        </div>
        <div class="question-text" style="font-size:.9rem;margin-bottom:.3rem;">${escapeHtml(q.text)}</div>
        ${answerDetail}
      </div>`;
    });
    list.innerHTML = html || '<p style="text-align:center;color:#888;padding:2rem;">暂无匹配的记录</p>';
  }

  document.querySelectorAll('.rf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderReviewList(btn.dataset.rf);
    });
  });

  renderReviewList('all');
  document.getElementById('backHomeBtn').addEventListener('click', renderWelcome);
  document.getElementById('wrongFromReviewBtn').addEventListener('click', renderWrongPage);
}

// ============================================================
// SCREEN: Wrong Question Book
// ============================================================
function renderWrongPage() {
  state.screen = 'wrong';
  const wrongMap = loadWrongQuestions();
  const ids = Object.keys(wrongMap);
  const wrongList = ids.map(k => wrongMap[k]).sort((a, b) => b.lastTime - a.lastTime);
  const empty = ids.length === 0;

  // Persistent container to avoid flash
  var wc = document.getElementById('wrongContainer');
  if (!wc) {
    wc = document.createElement('div');
    wc.id = 'wrongContainer';
    wc.className = 'fade-in';
    app.innerHTML = '';
    app.appendChild(wc);
  }

  wc.innerHTML = `
    <div class="wrong-screen">
      <div class="wrong-header">
        <h2>📕 错题本</h2>
        <div style="display:flex;gap:.5rem;">
          <button class="btn btn-ghost btn-sm" id="wrongPracticeBtn" ${empty?'disabled':''}>练习错题</button>
          <button class="btn btn-ghost btn-sm" id="wrongClearBtn" ${empty?'disabled':''}>清空</button>
          <button class="btn btn-ghost btn-sm" id="backFromWrongBtn">返回</button>
        </div>
      </div>
      ${empty
        ? '<div style="text-align:center;padding:3rem;color:#888;"><div style="font-size:3rem;margin-bottom:1rem;">🎉</div><p>暂无错题，继续保持！</p></div>'
        : `<div style="margin-bottom:1rem;">
            <p style="font-size:.85rem;color:#888;">共 ${ids.length} 道错题 · 点击 ✕ 可移出</p>
           </div>
           <div id="wrongList"></div>`
      }
    </div>
  `;

  if (!empty) {
    const list = document.getElementById('wrongList');
    if (list) {
      let html = '';
      wrongList.forEach(w => {
        const time = new Date(w.lastTime).toLocaleString('zh-CN');
        html += `<div class="wrong-item">
          <div class="wi-header">
            <span class="ri-q">第 ${w.id} 题</span>
            ${TYPE_BADGE[w.type] || ''}
            <span class="wi-count">错误 ${w.count} 次</span>
          </div>
          <div class="question-text" style="font-size:.9rem;margin-bottom:.3rem;">${escapeHtml(w.text)}</div>
          <div class="ri-detail">
            正确答案：<span style="color:#22c55e;font-weight:600;">${escapeHtml(w.answer)}</span>
            <span style="color:#888;margin-left:1rem;">${time}</span>
          </div>
          <button class="wi-remove" data-qid="${w.id}">✕ 移出</button>
        </div>`;
      });
      list.innerHTML = html;

      list.querySelectorAll('.wi-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          removeWrongQuestion(parseInt(btn.dataset.qid));
          // Update the wrong list only, not the whole page
          renderWrongPage();
        });
      });
    }
  }

  document.getElementById('wrongPracticeBtn')?.addEventListener('click', () => {
    state.mode = 'wrong';
    state.subject = 'all';
    state.typeFilter = 'all';
    state.totalQ = 999;
    startQuiz();
  });

  document.getElementById('wrongClearBtn')?.addEventListener('click', () => {
    if (confirm('确定清空所有错题记录？')) {
      clearWrongQuestions();
      renderWrongPage();
    }
  });

  document.getElementById('backFromWrongBtn')?.addEventListener('click', renderWelcome);
}

// ============================================================
// Init
// ============================================================
renderWelcome();
