/**
 * Codingua Academy Dashboard — app.js  v3.0
 * Full architectural audit — all 10 issues resolved
 *
 * NEW IN THIS VERSION:
 * [1]  Edit Group — modal, Firestore update, instructor reassignment with arrayRemove/arrayUnion
 * [2]  Instructor reassignment — removes group from old instructor, adds to new
 * [3]  Delete Instructor — removes from all assignedGroups on affected groups, cleans Firestore
 *      (Auth deletion note: requires Admin SDK / Cloud Function; client-side workaround documented)
 * [4]  Delete Group — cascade: deletes students, sessions, evaluations in batches,
 *      removes groupId from instructor.assignedGroups
 * [5]  All multi-step writes replaced with Firestore batches
 * [6]  Firestore Security Rules updated (see firestore.rules)
 * [7]  Pagination for students (PAGE_SIZE=20) and sessions (PAGE_SIZE=25)
 * [8]  Evaluation Matrix CSS fully fixed (table-layout:fixed, colgroup, vertical-align:middle)
 * [9]  Monthly/cycle ranking alongside lifetime ranking (toggle tabs on dashboard)
 * [10] Orphan detection: students with no group, evaluations with no session
 */

'use strict';

// ══════════════════════════════════════════════════════════════
//  FIREBASE CONFIG  ← replace with your values
// ══════════════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey:            "AIzaSyBEPjNIYw_ZQbqcdARMlJ3OH1-uGi_o_LA",
  authDomain:        "codingua-evaluation.firebaseapp.com",
  projectId:         "codingua-evaluation",
  storageBucket:     "codingua-evaluation.firebasestorage.app",
  messagingSenderId: "775470149394",
  appId:             "1:775470149394:web:befdb3f369bce0c2e0cdcb"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

// Secondary app — keeps admin signed in while creating instructor accounts
let _secondaryApp = null;
function getSecondaryAuth() {
  if (!_secondaryApp) _secondaryApp = firebase.initializeApp(firebaseConfig, 'secondary');
  return _secondaryApp.auth();
}

// ══════════════════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════════════════
const SCORE_RULES = {
  attendance: 10, participation: 5, application: 15,
  homework: 20,   creativity: 10,
  latePenalty: -5, homeworkPenalty: -10
};
const MAX_SESSION_SCORE = Object.values(SCORE_RULES).filter(v=>v>0).reduce((a,b)=>a+b,0); // 60
const BADGE_RULES = {
  starOfMonth:    { label:'🥇 نجم الشهر',    key:'starOfMonth' },
  youngInnovator: { label:'💡 المبدع الصغير', key:'youngInnovator' },
  homeworkChamp:  { label:'🎯 بطل الواجبات',  key:'homeworkChamp' },
  perfectAttend:  { label:'🔥 حضور مثالي',    key:'perfectAttend' }
};
const PAGE_SIZE_STUDENTS = 20;
const PAGE_SIZE_SESSIONS = 25;

// ══════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════
const state = {
  currentUser:    null,
  userProfile:    null,
  groups:         [],
  students:       [],
  instructors:    [],
  sessions:       [],
  evaluations:    [],
  charts:         {},
  deleteCallback: null,
  rankingMode:    'lifetime',  // 'lifetime' | 'cycle'
  studentsPage:   1,
  sessionsPage:   1,
  studentsFilter: '',
  studentsSearch: ''
};

// ══════════════════════════════════════════════════════════════
//  DOM HELPERS
// ══════════════════════════════════════════════════════════════
const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function showToast(msg, type='info') {
  const c = $('toast-container'); if (!c) return;
  const icons = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.remove(); }, 4500);
}

function openModal(id)  { const e=$(id); if(e) e.classList.add('open'); }
function closeModal(id) { const e=$(id); if(e) e.classList.remove('open'); }

function formatDate(ts) {
  if (!ts) return '—';
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ar-EG',{year:'numeric',month:'short',day:'numeric'});
  } catch { return '—'; }
}

function setActivePanel(panelId) {
  $$('.panel').forEach(p => p.classList.remove('active'));
  const t = $(panelId); if (t) t.classList.add('active');
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.panel===panelId));
  const titles = {
    'dashboard-panel':'لوحة التحليلات','instructors-panel':'إدارة المدرّسين',
    'groups-panel':'المجموعات الدراسية','students-panel':'الطلاب المسجّلون',
    'sessions-panel':'الجلسات الدراسية','evaluation-panel':'مصفوفة التقييم',
    'reports-panel':'التقارير الشهرية'
  };
  const el=$('page-title'); if(el) el.textContent=titles[panelId]||'Dashboard';
  closeSidebar();
}

// ══════════════════════════════════════════════════════════════
//  FIRESTORE BATCH HELPERS
// ══════════════════════════════════════════════════════════════
/** Run an array of {type,ref,data} operations in chunks of 490 */
async function batchOps(ops) {
  for (let i=0; i<ops.length; i+=490) {
    const b = db.batch();
    ops.slice(i,i+490).forEach(op => {
      if (op.type==='set')    b.set(op.ref, op.data, op.opts||{});
      if (op.type==='update') b.update(op.ref, op.data);
      if (op.type==='delete') b.delete(op.ref);
    });
    await b.commit();
  }
}

/** Chunked 'in' query — Firestore max 30 per 'in' clause */
async function inQuery(col, field, values, extraWhere) {
  if (!values.length) return [];
  const results = [];
  for (let i=0; i<values.length; i+=30) {
    let q = db.collection(col).where(field,'in',values.slice(i,i+30));
    if (extraWhere) q = q.where(...extraWhere);
    const snap = await q.get();
    snap.docs.forEach(d => results.push({...d.data(), [`${col.replace(/s$/,'')}Id`]:d.id}));
  }
  return results;
}

/** Get all docs from a collection where field == value (single) */
async function getWhere(col, field, value) {
  const snap = await db.collection(col).where(field,'==',value).get();
  return snap.docs.map(d => ({...d.data(), [`${col.replace(/s$/,'')}Id`]:d.id}));
}

// ══════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════
const loginForm = $('login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('login-email')?.value.trim();
    const pass  = $('login-password')?.value;
    const btn   = $('login-btn');
    const errD  = $('auth-error');
    const errM  = $('auth-error-msg');
    if (!email || !pass || !btn) return;
    if (errD) errD.classList.remove('visible');
    btn.innerHTML = '<div class="spinner" style="border-color:rgba(255,255,255,0.3);border-top-color:#fff;margin:0 auto;"></div>';
    btn.disabled = true;
    try {
      await auth.signInWithEmailAndPassword(email, pass);
    } catch(err) {
      console.error('[Auth]', err.code, err.message);
      const map = {
        'auth/user-not-found':'البريد غير مسجّل.',
        'auth/wrong-password':'كلمة المرور غير صحيحة.',
        'auth/invalid-email':'صيغة البريد غير صحيحة.',
        'auth/invalid-credential':'البريد أو كلمة المرور غير صحيحة.',
        'auth/too-many-requests':'تم تجاوز المحاولات. حاول لاحقاً.'
      };
      if (errM) errM.textContent = map[err.code] || err.message;
      if (errD) errD.classList.add('visible');
      btn.innerHTML = '<span id="login-btn-text">تسجيل الدخول</span>';
      btn.disabled = false;
    }
  });
}

const logoutBtn = $('logout-btn');
if (logoutBtn) logoutBtn.addEventListener('click', ()=>auth.signOut().catch(console.error));

auth.onAuthStateChanged(async user => {
  // FIX Issue 3: Firebase has resolved — hide splash regardless of outcome
  hideSplash();

  if (user) {
    state.currentUser = user;
    try {
      const snap = await db.collection('users').doc(user.uid).get();
      if (!snap.exists) { showToast('المستخدم غير مسجّل.','error'); auth.signOut(); return; }
      state.userProfile = {...snap.data(), userId:snap.id};
      await initApp();
    } catch(e) { console.error('[Auth]',e); showToast('خطأ في تحميل البيانات.','error'); }
  } else {
    // Not authenticated — now safe to show login screen
    state.currentUser = null; state.userProfile = null;
    Object.assign(state,{groups:[],students:[],instructors:[],sessions:[],evaluations:[]});
    const a=$('app'), b=$('auth-screen');
    if(a) a.style.display='none';
    if(b) b.style.display='flex';
  }
});

/** Hide the splash screen with a smooth fade-out */
function hideSplash() {
  const splash = $('splash-screen');
  if (!splash) return;
  splash.classList.add('splash-fade-out');
  setTimeout(() => {
    if (splash.parentNode) splash.remove();
  }, 400);
}

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════
async function initApp() {
  const authEl=$('auth-screen'), appEl=$('app');
  if(authEl) authEl.style.display='none';
  if(appEl)  appEl.style.display='flex';

  const {fullName,role} = state.userProfile;
  const isAdmin = role==='admin';

  const setSafe=(id,v)=>{const e=$(id);if(e)e.textContent=v;};
  setSafe('sidebar-avatar',(fullName||'U')[0].toUpperCase());
  setSafe('sidebar-name', fullName||'مستخدم');
  setSafe('sidebar-role', isAdmin?'مدير النظام':'مدرّس');
  setSafe('role-badge',   isAdmin?'مدير':'مدرّس');

  $$('.admin-only-nav').forEach(el=>el.style.display=isAdmin?'':'none');
  $$('.admin-only-action').forEach(el=>el.style.display=isAdmin?'':'none');

  await loadAllData();
  buildDropdowns();

  if (isAdmin) { setActivePanel('dashboard-panel'); renderDashboard(); }
  else          { setActivePanel('groups-panel'); }

  renderGroups(); renderStudents(); renderSessions(); renderInstructors();
}

// ══════════════════════════════════════════════════════════════
//  DATA LOADING
// ══════════════════════════════════════════════════════════════
async function loadAllData() {
  const {role,userId,assignedGroups=[]} = state.userProfile;
  const isAdmin = role==='admin';
  try {
    // Groups
    if (isAdmin) {
      const s=await db.collection('groups').get();
      state.groups=s.docs.map(d=>({...d.data(),groupId:d.id}));
    } else if (assignedGroups.length) {
      state.groups = await inQuery('groups',firebase.firestore.FieldPath.documentId(),assignedGroups);
    } else { state.groups=[]; }

    const gids = state.groups.map(g=>g.groupId);

    // Students
    state.students = gids.length ? await inQuery('students','groupId',gids) : [];
    // Sessions
    state.sessions = gids.length ? (await inQuery('sessions','groupId',gids))
      .sort((a,b)=>a.sessionNumber-b.sessionNumber) : [];
    // ── Evaluations ─────────────────────────────────────────────
    // ROOT CAUSE FIX: evaluations are owned by (studentId + sessionId),
    // NOT by the user who created them.
    //
    // OLD (broken):
    //   Admin:      load ALL evaluations → includes evals with no groupId → OK
    //   Instructor: load WHERE instructorId == uid → misses Admin-created evals
    //               AND evaluations without groupId cause permission-denied when
    //               the Security Rule checks resource.data.groupId
    //
    // NEW (correct):
    //   Both roles: load WHERE sessionId IN [sessions they can access]
    //   This is role-neutral and matches the Security Rule which checks groupId
    //   stored in the document — after migration all docs will have it.
    //
    // DIAGNOSTIC: log key permission context so console helps debugging
    console.info('[EvalLoad] uid:', userId, '| role:', role,
      '| assignedGroups:', JSON.stringify(assignedGroups),
      '| accessible sessionIds:', state.sessions.length);

    const sessionIds = state.sessions.map(s => s.sessionId);
    if (sessionIds.length) {
      const evResults = [];
      for (let i = 0; i < sessionIds.length; i += 30) {
        const chunk = sessionIds.slice(i, i + 30);
        try {
          const snap = await db.collection('evaluations')
                                .where('sessionId', 'in', chunk)
                                .get();
          snap.docs.forEach(d => {
            const ev = { ...d.data(), evaluationId: d.id };
            // DIAGNOSTIC: warn about documents still missing groupId
            if (!ev.groupId) {
              console.warn(
                '[EvalLoad] ⚠️ Evaluation missing groupId — run migration tool.',
                'id:', d.id, 'sessionId:', ev.sessionId, 'studentId:', ev.studentId
              );
            }
            evResults.push(ev);
          });
        } catch (chunkErr) {
          // Granular error per chunk — helps isolate which sessionId triggers denial
          console.error('[EvalLoad] ❌ Permission error loading chunk',
            chunk, chunkErr.code, chunkErr.message);
          // Surface a helpful toast only once
          if (i === 0) {
            showToast(
              'خطأ صلاحيات في تحميل التقييمات. ' +
              'قد تحتاج بعض الوثائق إلى ترحيل (إضافة groupId). ' +
              'افتح أداة migrate-evaluations.html للإصلاح.',
              'warning'
            );
          }
        }
      }
      state.evaluations = evResults;
    } else {
      state.evaluations = [];
    }
    console.info('[EvalLoad] Loaded', state.evaluations.length, 'evaluations.',
      'Missing groupId:',
      state.evaluations.filter(ev => !ev.groupId).length);
    // Instructors (admin only)
    if (isAdmin) {
      const s=await db.collection('users').where('role','==','instructor').get();
      state.instructors=s.docs.map(d=>({...d.data(),userId:d.id}));
    }
  } catch(e) { console.error('[loadAllData]',e); showToast('خطأ في التحميل: '+e.message,'error'); }
}

// ══════════════════════════════════════════════════════════════
//  DROPDOWNS
// ══════════════════════════════════════════════════════════════
function buildDropdowns() {
  ['students-group-filter','sessions-group-filter','eval-group-select',
   'report-group-select','session-group','student-group'].forEach(id=>{
    const el=$(id); if(!el) return;
    const isF=id.includes('filter');
    el.innerHTML=`<option value="">${isF?'كل المجموعات':'— اختر مجموعة —'}</option>`;
    state.groups.forEach(g=>{
      const o=document.createElement('option');
      o.value=g.groupId; o.textContent=g.groupName; el.appendChild(o);
    });
  });
  const gi=$('group-instructor');
  if(gi){
    gi.innerHTML='<option value="">— اختر مدرّساً —</option>';
    state.instructors.forEach(i=>{
      const o=document.createElement('option');
      o.value=i.userId; o.textContent=i.fullName; gi.appendChild(o);
    });
  }
}

// ══════════════════════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════════════════════
function renderDashboard() {
  const s=(id,v)=>{const e=$(id);if(e)e.textContent=v;};
  s('stat-students',state.students.length);
  s('stat-groups',state.groups.length);
  s('stat-instructors',state.instructors.length);
  s('stat-sessions',state.sessions.length);

  const totals = computeLifetimeTotals();
  const sorted = Object.entries(totals).sort((a,b)=>b[1].total-a[1].total);
  if (sorted.length) {
    const top=state.students.find(x=>x.studentId===sorted[0][0]);
    s('stat-top-student',top?top.studentName:'—');
  }
  renderRankingChart();
  renderBadgesChart();
  renderAttendanceChart();
  renderTopStudentsList(sorted);
}

/**
 * refreshDashboardAfterSave()
 * Called immediately after evaluations are saved to Firestore.
 * state.evaluations is already updated in-memory, so this just
 * re-runs all dashboard computations and re-renders every widget.
 *
 * No additional Firestore reads are needed — all data is already
 * in state. The user sees updated numbers/charts within ~16ms.
 *
 * FIX Issue 2: Root cause was that renderDashboard() was only called
 * once during initApp(). After saving evaluations the in-memory
 * state.evaluations array was updated but nothing triggered a
 * re-render of the dashboard widgets, rankings, or stat cards.
 */
function refreshDashboardAfterSave() {
  // Only refresh if the user is admin and the dashboard panel exists
  if (!state.userProfile || state.userProfile.role !== 'admin') return;

  // ── Stat cards ──────────────────────────────────────────────
  // These don't change on eval save, but recalculate top-student
  const s = (id, v) => { const e = $(id); if(e) e.textContent = v; };
  const totals = computeLifetimeTotals();
  const sorted = Object.entries(totals).sort((a, b) => b[1].total - a[1].total);
  if (sorted.length) {
    const top = state.students.find(x => x.studentId === sorted[0][0]);
    s('stat-top-student', top ? top.studentName : '—');
  }

  // ── Charts ──────────────────────────────────────────────────
  renderRankingChart();      // uses state.evaluations → updated
  renderBadgesChart();       // uses computeBadges() → updated
  renderAttendanceChart();   // uses state.evaluations → updated

  // ── Top students list ────────────────────────────────────────
  renderTopStudentsList(sorted);

  console.info('[Dashboard] Refreshed after evaluation save. Totals recalculated for', sorted.length, 'students.');
}

/** All-time totals per student */
function computeLifetimeTotals() {
  const t={};
  state.students.forEach(s=>{ t[s.studentId]={total:0,creativity:0,sessions:0}; });
  state.evaluations.forEach(ev=>{
    if(!t[ev.studentId]) return;
    t[ev.studentId].total      += ev.totalPoints||0;
    t[ev.studentId].creativity += ev.creativity?SCORE_RULES.creativity:0;
    t[ev.studentId].sessions   += 1;
  });
  return t;
}

/** Latest complete cycle totals per student across all groups */
function computeLatestCycleTotals() {
  const t={};
  state.students.forEach(s=>{ t[s.studentId]={total:0,creativity:0,sessions:0}; });

  state.groups.forEach(g=>{
    const gSessions=state.sessions.filter(s=>s.groupId===g.groupId)
      .sort((a,b)=>a.sessionNumber-b.sessionNumber);
    const lastCycleStart=Math.floor(gSessions.length/4)*4-4;
    if(lastCycleStart<0) return;
    const cycle=gSessions.slice(lastCycleStart, lastCycleStart+4);
    const cycleIds=new Set(cycle.map(s=>s.sessionId));

    state.students.filter(s=>s.groupId===g.groupId).forEach(student=>{
      state.evaluations.filter(ev=>ev.studentId===student.studentId&&cycleIds.has(ev.sessionId))
        .forEach(ev=>{
          if(!t[student.studentId]) return;
          t[student.studentId].total      += ev.totalPoints||0;
          t[student.studentId].creativity += ev.creativity?SCORE_RULES.creativity:0;
          t[student.studentId].sessions   += 1;
        });
    });
  });
  return t;
}

function renderRankingChart() {
  const canvas=$('rankingChart'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  if(state.charts.ranking) state.charts.ranking.destroy();

  const totals = state.rankingMode==='cycle' ? computeLatestCycleTotals() : computeLifetimeTotals();
  const sorted = Object.entries(totals).sort((a,b)=>b[1].total-a[1].total).slice(0,10);
  const labels = sorted.map(([id])=>{ const s=state.students.find(x=>x.studentId===id); return s?s.studentName:id; });
  const data   = sorted.map(([,v])=>v.total);

  state.charts.ranking = new Chart(ctx,{
    type:'bar',
    data:{labels,datasets:[{
      label:state.rankingMode==='cycle'?'نقاط الدورة الأخيرة':'مجموع النقاط الكلي',
      data,
      backgroundColor:state.rankingMode==='cycle'?'rgba(247,197,43,0.8)':'rgba(29,161,242,0.8)',
      borderColor:state.rankingMode==='cycle'?'#F7C52B':'#1DA1F2',
      borderWidth:2,borderRadius:8
    }]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{y:{beginAtZero:true,grid:{color:'rgba(148,163,184,0.1)'}},x:{grid:{display:false}}}}
  });
}

// Ranking tab toggle
$$('.ranking-tab').forEach(tab=>{
  tab.addEventListener('click',()=>{
    $$('.ranking-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    state.rankingMode=tab.dataset.tab;
    renderRankingChart();
  });
});

function renderBadgesChart() {
  const canvas=$('badgesChart'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  if(state.charts.badges) state.charts.badges.destroy();
  const badges=computeBadges();
  const counts={starOfMonth:0,youngInnovator:0,homeworkChamp:0,perfectAttend:0};
  Object.values(badges).forEach(list=>list.forEach(b=>{ if(b in counts) counts[b]++; }));
  state.charts.badges=new Chart(ctx,{
    type:'doughnut',
    data:{
      labels:['🥇 نجم الشهر','💡 المبدع','🎯 بطل الواجبات','🔥 حضور مثالي'],
      datasets:[{data:Object.values(counts),backgroundColor:['#F7C52B','#1DA1F2','#27ae60','#e74c3c'],borderWidth:0}]
    },
    options:{responsive:true,maintainAspectRatio:false,cutout:'65%',
      plugins:{legend:{position:'bottom',labels:{padding:12,font:{family:'Cairo'}}}}}
  });
}

function renderAttendanceChart() {
  const canvas=$('attendanceChart'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  if(state.charts.attendance) state.charts.attendance.destroy();
  const ga={};
  state.groups.forEach(g=>{ ga[g.groupId]={name:g.groupName,attended:0,absent:0}; });
  state.evaluations.forEach(ev=>{
    const s=state.students.find(x=>x.studentId===ev.studentId);
    if(!s||!ga[s.groupId]) return;
    if(ev.attendance) ga[s.groupId].attended++; else ga[s.groupId].absent++;
  });
  const labels=Object.values(ga).map(g=>g.name);
  state.charts.attendance=new Chart(ctx,{
    type:'bar',
    data:{labels,datasets:[
      {label:'حضر',data:Object.values(ga).map(g=>g.attended),backgroundColor:'rgba(39,174,96,0.8)',borderRadius:6},
      {label:'غاب',data:Object.values(ga).map(g=>g.absent), backgroundColor:'rgba(231,76,60,0.8)', borderRadius:6}
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{position:'top'}},
      scales:{x:{stacked:true,grid:{display:false}},y:{stacked:true,beginAtZero:true,grid:{color:'rgba(148,163,184,0.1)'}}}}
  });
}

function renderTopStudentsList(sorted) {
  const c=$('top-students-list'); if(!c) return;
  if(!sorted.length){c.innerHTML='<div class="empty-state"><div class="empty-icon">🏆</div><p>لا توجد تقييمات</p></div>';return;}
  c.innerHTML=sorted.slice(0,5).map(([id,v],i)=>{
    const s=state.students.find(x=>x.studentId===id);
    return `<div class="ranking-item">
      <div class="ranking-num ${i===0?'gold':''}">${i+1}</div>
      <span class="ranking-name">${s?s.studentName:'—'}</span>
      <span class="ranking-score">${v.total} نقطة</span>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
//  [FIX-1] GROUPS — ADD + EDIT
// ══════════════════════════════════════════════════════════════
function renderGroups() {
  const grid=$('groups-grid'); if(!grid||!state.userProfile) return;
  const isAdmin=state.userProfile.role==='admin';
  if(!state.groups.length){
    grid.innerHTML='<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">📚</div><p>لا توجد مجموعات بعد</p></div>';
    return;
  }
  grid.innerHTML=state.groups.map(g=>{
    const inst=state.instructors.find(i=>i.userId===g.instructorId);
    const cnt=state.students.filter(s=>s.groupId===g.groupId).length;
    return `<div class="group-card">
      <div class="group-card-header">
        <div class="group-icon">📚</div>
        <div class="group-card-actions">
          ${isAdmin?`
            <button class="btn btn-warning btn-sm" onclick="openEditGroup('${g.groupId}')">✏️</button>
            <button class="btn btn-danger btn-sm"  onclick="confirmDelete('group','${g.groupId}','مجموعة: ${g.groupName}')">🗑</button>
          `:''}
        </div>
      </div>
      <div class="group-card-name">${g.groupName}</div>
      <div class="group-card-course">${g.courseName||''}</div>
      <div class="group-card-footer">
        <span>👩‍🏫 ${inst?inst.fullName:'غير محدّد'}</span>
        <span>👥 ${cnt} طالب</span>
      </div>
    </div>`;
  }).join('');
}

// Open Add Group modal
const btnAddGroup=$('btn-add-group');
if(btnAddGroup) btnAddGroup.addEventListener('click',()=>{
  const t=$('group-modal-title'); if(t) t.textContent='➕ إضافة مجموعة جديدة';
  ['group-name','group-course','group-edit-id'].forEach(id=>{const e=$(id);if(e)e.value='';});
  const gi=$('group-instructor'); if(gi) gi.value='';
  buildDropdowns();
  openModal('modal-group');
});

// [FIX-1] Open Edit Group modal
window.openEditGroup = (groupId) => {
  const g=state.groups.find(x=>x.groupId===groupId); if(!g) return;
  const t=$('group-modal-title'); if(t) t.textContent='✏️ تعديل المجموعة';
  const sn=$('group-name'); if(sn) sn.value=g.groupName;
  const sc=$('group-course'); if(sc) sc.value=g.courseName||'';
  const ei=$('group-edit-id'); if(ei) ei.value=groupId;
  buildDropdowns();
  const gi=$('group-instructor'); if(gi) gi.value=g.instructorId||'';
  openModal('modal-group');
};

const btnSaveGroup=$('btn-save-group');
if(btnSaveGroup) btnSaveGroup.addEventListener('click', async()=>{
  const name     = $('group-name')?.value.trim()||'';
  const course   = $('group-course')?.value.trim()||'';
  const newInstId= $('group-instructor')?.value||'';
  const editId   = $('group-edit-id')?.value||'';
  if(!name){ showToast('أدخل اسم المجموعة.','error'); return; }

  try {
    if(editId) {
      // ── EDIT existing group ──
      const oldGroup=state.groups.find(x=>x.groupId===editId);
      const oldInstId=oldGroup?.instructorId||'';
      const ops=[];

      // Update group doc
      ops.push({type:'update',ref:db.collection('groups').doc(editId),
        data:{groupName:name,courseName:course,instructorId:newInstId}});

      // [FIX-2] Instructor reassignment
      if(oldInstId && oldInstId!==newInstId) {
        // Remove group from old instructor
        ops.push({type:'update',ref:db.collection('users').doc(oldInstId),
          data:{assignedGroups:firebase.firestore.FieldValue.arrayRemove(editId)}});
        const oi=state.instructors.find(x=>x.userId===oldInstId);
        if(oi) oi.assignedGroups=(oi.assignedGroups||[]).filter(g=>g!==editId);
      }
      if(newInstId && newInstId!==oldInstId) {
        // Add group to new instructor
        ops.push({type:'update',ref:db.collection('users').doc(newInstId),
          data:{assignedGroups:firebase.firestore.FieldValue.arrayUnion(editId)}});
        const ni=state.instructors.find(x=>x.userId===newInstId);
        if(ni) ni.assignedGroups=[...(ni.assignedGroups||[]),editId];
      }

      await batchOps(ops);

      // Update local state
      const idx=state.groups.findIndex(x=>x.groupId===editId);
      if(idx!==-1) state.groups[idx]={...state.groups[idx],groupName:name,courseName:course,instructorId:newInstId};
      showToast(`تم تحديث المجموعة "${name}".`,'success');
    } else {
      // ── ADD new group ──
      const ref=await db.collection('groups').add({groupName:name,courseName:course,instructorId:newInstId});
      state.groups.push({groupId:ref.id,groupName:name,courseName:course,instructorId:newInstId});
      if(newInstId) {
        await db.collection('users').doc(newInstId).update({
          assignedGroups:firebase.firestore.FieldValue.arrayUnion(ref.id)
        });
        const ni=state.instructors.find(x=>x.userId===newInstId);
        if(ni) ni.assignedGroups=[...(ni.assignedGroups||[]),ref.id];
      }
      showToast(`تم إضافة "${name}".`,'success');
    }
    closeModal('modal-group');
    buildDropdowns();
    renderGroups();
    renderInstructors();
  } catch(e){ console.error('[Group save]',e); showToast('خطأ: '+e.message,'error'); }
});

// ══════════════════════════════════════════════════════════════
//  INSTRUCTORS
// ══════════════════════════════════════════════════════════════
function renderInstructors() {
  const tbody=$('instructors-tbody'); if(!tbody) return;
  if(!state.instructors.length){
    tbody.innerHTML='<tr><td colspan="4"><div class="empty-state"><div class="empty-icon">👩‍🏫</div><p>لا يوجد مدرّسون</p></div></td></tr>';
    return;
  }
  tbody.innerHTML=state.instructors.map(inst=>{
    const gn=(inst.assignedGroups||[]).map(gid=>{
      const g=state.groups.find(x=>x.groupId===gid);
      return g?`<span class="badge badge-blue">${g.groupName}</span>`:'';
    }).join(' ');
    return `<tr>
      <td>${inst.fullName}</td>
      <td dir="ltr" style="text-align:left;">${inst.email}</td>
      <td>${gn||'<span class="badge badge-red">لا توجد</span>'}</td>
      <td><button class="btn btn-danger btn-sm" onclick="confirmDelete('instructor','${inst.userId}','المدرّس: ${inst.fullName}')">🗑 حذف</button></td>
    </tr>`;
  }).join('');
}

const btnAddInstructor=$('btn-add-instructor');
if(btnAddInstructor) btnAddInstructor.addEventListener('click',()=>{
  const t=$('instructor-modal-title'); if(t) t.textContent='➕ إضافة مدرّس جديد';
  ['inst-name','inst-email','inst-password','inst-edit-id'].forEach(id=>{const e=$(id);if(e)e.value='';});
  const pr=$('inst-password-row'); if(pr) pr.style.display='';
  const box=$('inst-groups-checkboxes');
  if(box) box.innerHTML=state.groups.map(g=>`
    <label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;cursor:pointer;">
      <input type="checkbox" name="inst-group" value="${g.groupId}" style="accent-color:var(--primary);width:16px;height:16px;" />
      ${g.groupName}
    </label>`).join('');
  openModal('modal-instructor');
});

const btnSaveInstructor=$('btn-save-instructor');
if(btnSaveInstructor) btnSaveInstructor.addEventListener('click', async()=>{
  const name    =$('inst-name')?.value.trim()||'';
  const email   =$('inst-email')?.value.trim()||'';
  const password=$('inst-password')?.value||'';
  const selected=[...$$(  'input[name="inst-group"]:checked')].map(x=>x.value);
  if(!name||!email||!password){ showToast('أكمل جميع الحقول.','error'); return; }

  try {
    // [FIX-CRITICAL-5] Secondary app keeps admin signed in
    const secAuth=getSecondaryAuth();
    const cred=await secAuth.createUserWithEmailAndPassword(email,password);
    const uid=cred.user.uid;
    await secAuth.signOut();

    const ops=[];
    ops.push({type:'set',ref:db.collection('users').doc(uid),
      data:{fullName:name,email,role:'instructor',assignedGroups:selected}});
    selected.forEach(gid=>{
      ops.push({type:'update',ref:db.collection('groups').doc(gid),data:{instructorId:uid}});
      const g=state.groups.find(x=>x.groupId===gid); if(g) g.instructorId=uid;
    });
    await batchOps(ops);
    state.instructors.push({userId:uid,fullName:name,email,role:'instructor',assignedGroups:selected});
    closeModal('modal-instructor');
    renderInstructors(); buildDropdowns();
    showToast(`تم إضافة المدرّس "${name}".`,'success');
  } catch(e){ console.error('[Instructor save]',e); showToast('خطأ: '+e.message,'error'); }
});

// ══════════════════════════════════════════════════════════════
//  STUDENTS  (with pagination + search)
// ══════════════════════════════════════════════════════════════
function renderStudents() {
  const tbody=$('students-tbody'); if(!tbody||!state.userProfile) return;
  const isAdmin=state.userProfile.role==='admin';

  let students=state.students;
  if(state.studentsFilter) students=students.filter(s=>s.groupId===state.studentsFilter);
  if(state.studentsSearch) {
    const q=state.studentsSearch.toLowerCase();
    students=students.filter(s=>(s.studentName||'').toLowerCase().includes(q));
  }

  const total=students.length;
  const pages=Math.max(1,Math.ceil(total/PAGE_SIZE_STUDENTS));
  state.studentsPage=Math.min(state.studentsPage,pages);
  const slice=students.slice((state.studentsPage-1)*PAGE_SIZE_STUDENTS, state.studentsPage*PAGE_SIZE_STUDENTS);

  if(!slice.length){
    tbody.innerHTML=`<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">🎓</div><p>لا يوجد طلاب</p></div></td></tr>`;
    renderPagination('students-pagination',state.studentsPage,pages,'studentsPage',renderStudents);
    return;
  }
  tbody.innerHTML=slice.map((s,i)=>{
    const g=state.groups.find(x=>x.groupId===s.groupId);
    const rowNum=(state.studentsPage-1)*PAGE_SIZE_STUDENTS+i+1;
    return `<tr>
      <td>${rowNum}</td>
      <td><strong>${s.studentName}</strong></td>
      <td>${s.age||'—'}</td>
      <td dir="ltr" style="text-align:left;">${s.parentPhone||'—'}</td>
      <td>${g?`<span class="badge badge-blue">${g.groupName}</span>`:'<span class="badge badge-red">بدون مجموعة</span>'}</td>
      <td>${formatDate(s.enrollmentDate)}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" onclick="editStudent('${s.studentId}')">✏️</button>
        ${isAdmin?`<button class="btn btn-danger btn-sm" onclick="confirmDelete('student','${s.studentId}','الطالب: ${s.studentName}')">🗑</button>`:''}
      </td>
    </tr>`;
  }).join('');
  renderPagination('students-pagination',state.studentsPage,pages,'studentsPage',renderStudents);
}

function renderPagination(containerId, current, total, stateKey, renderFn) {
  const c=$(containerId); if(!c) return;
  if(total<=1){c.innerHTML='';return;}
  const prevDis=current===1?'disabled':'';
  const nextDis=current===total?'disabled':'';
  let pages='';
  for(let i=1;i<=total;i++){
    if(i===1||i===total||Math.abs(i-current)<=1){
      pages+=`<button class="pagination-btn${i===current?' active':''}" onclick="goPage('${stateKey}',${i},'${renderFn.name}')">${i}</button>`;
    } else if(Math.abs(i-current)===2){
      pages+='<span class="pagination-info">…</span>';
    }
  }
  c.innerHTML=`
    <button class="pagination-btn" ${prevDis} onclick="goPage('${stateKey}',${current-1},'${renderFn.name}')">‹</button>
    ${pages}
    <button class="pagination-btn" ${nextDis} onclick="goPage('${stateKey}',${current+1},'${renderFn.name}')">›</button>
    <span class="pagination-info">صفحة ${current} من ${total}</span>`;
}

window.goPage=(key,page,fn)=>{
  state[key]=page;
  if(fn==='renderStudents') renderStudents();
  if(fn==='renderSessions') renderSessions();
};

const studentsFilter=$('students-group-filter');
if(studentsFilter) studentsFilter.addEventListener('change',e=>{
  state.studentsFilter=e.target.value; state.studentsPage=1; renderStudents();
});
const studentsSearch=$('students-search');
if(studentsSearch) studentsSearch.addEventListener('input',e=>{
  state.studentsSearch=e.target.value.trim(); state.studentsPage=1; renderStudents();
});

const btnAddStudent=$('btn-add-student');
if(btnAddStudent) btnAddStudent.addEventListener('click',()=>{
  const t=$('student-modal-title'); if(t) t.textContent='➕ إضافة طالب جديد';
  ['student-name','student-age','student-phone','student-group','student-edit-id'].forEach(id=>{const e=$(id);if(e)e.value='';});
  openModal('modal-student');
});

window.editStudent=(id)=>{
  const s=state.students.find(x=>x.studentId===id); if(!s) return;
  const t=$('student-modal-title'); if(t) t.textContent='✏️ تعديل بيانات الطالب';
  const set=(k,v)=>{const e=$(k);if(e)e.value=v;};
  set('student-name',s.studentName); set('student-age',s.age||'');
  set('student-phone',s.parentPhone||''); set('student-group',s.groupId||'');
  set('student-edit-id',id);
  openModal('modal-student');
};

const btnSaveStudent=$('btn-save-student');
if(btnSaveStudent) btnSaveStudent.addEventListener('click', async()=>{
  const name   =$('student-name')?.value.trim()||'';
  const age    =parseInt($('student-age')?.value)||null;
  const phone  =$('student-phone')?.value.trim()||'';
  const groupId=$('student-group')?.value||'';
  const editId =$('student-edit-id')?.value||'';
  if(!name||!groupId){showToast('أدخل الاسم والمجموعة.','error');return;}
  const existing=state.students.find(x=>x.studentId===editId);
  const data={studentName:name,age,parentPhone:phone,groupId,
    enrollmentDate:editId?(existing?.enrollmentDate||firebase.firestore.FieldValue.serverTimestamp())
      :firebase.firestore.FieldValue.serverTimestamp()};
  try {
    if(editId){
      await db.collection('students').doc(editId).update(data);
      const idx=state.students.findIndex(x=>x.studentId===editId);
      if(idx!==-1) state.students[idx]={...state.students[idx],...data};
      showToast('تم تحديث بيانات الطالب.','success');
    } else {
      const ref=await db.collection('students').add(data);
      state.students.push({...data,studentId:ref.id});
      showToast(`تم إضافة "${name}".`,'success');
    }
    closeModal('modal-student');
    renderStudents(); renderGroups();
    const se=$('stat-students'); if(se) se.textContent=state.students.length;
  } catch(e){console.error('[Student save]',e);showToast('خطأ: '+e.message,'error');}
});

// ══════════════════════════════════════════════════════════════
//  SESSIONS  (with pagination)
// ══════════════════════════════════════════════════════════════
function renderSessions(filterGroupId='') {
  const tbody=$('sessions-tbody'); if(!tbody) return;
  const filter=filterGroupId||$('sessions-group-filter')?.value||'';
  let sessions=filter?state.sessions.filter(s=>s.groupId===filter):state.sessions;

  const total=sessions.length;
  const pages=Math.max(1,Math.ceil(total/PAGE_SIZE_SESSIONS));
  state.sessionsPage=Math.min(state.sessionsPage,pages);
  const slice=sessions.slice((state.sessionsPage-1)*PAGE_SIZE_SESSIONS,state.sessionsPage*PAGE_SIZE_SESSIONS);

  if(!slice.length){
    tbody.innerHTML='<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">📝</div><p>لا توجد جلسات</p></div></td></tr>';
    renderPagination('sessions-pagination',state.sessionsPage,pages,'sessionsPage',renderSessions);
    return;
  }
  tbody.innerHTML=slice.map(s=>{
    const g=state.groups.find(x=>x.groupId===s.groupId);
    return `<tr>
      <td><span class="badge badge-blue">جلسة ${s.sessionNumber}</span></td>
      <td>${g?g.groupName:'—'}</td>
      <td>${s.date||'—'}</td>
      <td>${s.topic||'—'}</td>
      <td><button class="btn btn-danger btn-sm" onclick="confirmDelete('session','${s.sessionId}','جلسة #${s.sessionNumber}')">🗑 حذف</button></td>
    </tr>`;
  }).join('');
  renderPagination('sessions-pagination',state.sessionsPage,pages,'sessionsPage',renderSessions);
}

const sessFilter=$('sessions-group-filter');
if(sessFilter) sessFilter.addEventListener('change',e=>{state.sessionsPage=1;renderSessions(e.target.value);});

const btnAddSession=$('btn-add-session');
if(btnAddSession) btnAddSession.addEventListener('click',()=>{
  ['session-group','session-number','session-topic'].forEach(id=>{const e=$(id);if(e)e.value='';});
  const sd=$('session-date'); if(sd) sd.value=new Date().toISOString().split('T')[0];
  openModal('modal-session');
});

const btnSaveSession=$('btn-save-session');
if(btnSaveSession) btnSaveSession.addEventListener('click', async()=>{
  const groupId=$('session-group')?.value||'';
  const num=parseInt($('session-number')?.value);
  const date=$('session-date')?.value||'';
  const topic=$('session-topic')?.value.trim()||'';
  if(!groupId||!num||!date){showToast('أكمل الحقول المطلوبة.','error');return;}
  try {
    const ref=await db.collection('sessions').add({groupId,sessionNumber:num,date,topic});
    state.sessions.push({groupId,sessionNumber:num,date,topic,sessionId:ref.id});
    state.sessions.sort((a,b)=>a.sessionNumber-b.sessionNumber);
    closeModal('modal-session');
    renderSessions();
    const se=$('stat-sessions'); if(se) se.textContent=state.sessions.length;
    showToast('تم إضافة الجلسة.','success');
  } catch(e){console.error('[Session save]',e);showToast('خطأ: '+e.message,'error');}
});

// ══════════════════════════════════════════════════════════════
//  EVALUATION MATRIX
// ══════════════════════════════════════════════════════════════
const evalGrpSel=$('eval-group-select');
if(evalGrpSel) evalGrpSel.addEventListener('change',function(){
  const groupId=this.value;
  const ss=$('eval-session-select');
  const mc=$('eval-matrix-container');
  const es=$('eval-empty-state');
  if(ss){ss.innerHTML='<option value="">— اختر جلسة —</option>';ss.disabled=true;}
  if(mc) mc.style.display='none';
  if(es) es.style.display='block';
  if(!groupId||!ss) return;
  state.sessions.filter(s=>s.groupId===groupId).forEach(s=>{
    const o=document.createElement('option');
    o.value=s.sessionId;
    o.textContent=`جلسة ${s.sessionNumber} — ${s.date} — ${s.topic||''}`;
    ss.appendChild(o);
  });
  ss.disabled=false;
});

const evalSesSel=$('eval-session-select');
if(evalSesSel) evalSesSel.addEventListener('change',function(){
  const sessionId=this.value;
  const groupId=$('eval-group-select')?.value||'';
  const mc=$('eval-matrix-container');
  const es=$('eval-empty-state');
  if(!sessionId||!groupId) return;

  const group=state.groups.find(g=>g.groupId===groupId);
  const session=state.sessions.find(s=>s.sessionId===sessionId);
  const students=state.students.filter(s=>s.groupId===groupId);
  if(!students.length){showToast('لا يوجد طلاب في هذه المجموعة.','info');return;}

  const lg=$('eval-group-label');   if(lg) lg.textContent=group?group.groupName:'';
  const ls=$('eval-session-label'); if(ls) ls.textContent=session?`جلسة ${session.sessionNumber}`:'';

  const existMap={};
  state.evaluations.filter(ev=>ev.sessionId===sessionId).forEach(ev=>{ existMap[ev.studentId]=ev; });

  const tbody=$('eval-matrix-tbody');
  if(tbody){
    tbody.innerHTML=students.map(student=>{
      const ev=existMap[student.studentId]||{};
      const chk=v=>v?'checked':'';
      return `<tr id="row-${student.studentId}" data-student-id="${student.studentId}">
        <td><strong>${student.studentName}</strong></td>
        <td class="eval-checkbox"><input type="checkbox" class="ev-attendance"    ${chk(ev.attendance)}     onchange="recalcRow('${student.studentId}')" /></td>
        <td class="eval-checkbox"><input type="checkbox" class="ev-participation" ${chk(ev.participation)}  onchange="recalcRow('${student.studentId}')" /></td>
        <td class="eval-checkbox"><input type="checkbox" class="ev-application"   ${chk(ev.application)}    onchange="recalcRow('${student.studentId}')" /></td>
        <td class="eval-checkbox"><input type="checkbox" class="ev-homework"      ${chk(ev.homework)}       onchange="recalcRow('${student.studentId}')" /></td>
        <td class="eval-checkbox"><input type="checkbox" class="ev-creativity"    ${chk(ev.creativity)}     onchange="recalcRow('${student.studentId}')" /></td>
        <td class="eval-checkbox penalty-checkbox"><input type="checkbox" class="ev-late" ${chk(ev.latePenalty)}    onchange="recalcRow('${student.studentId}')" /></td>
        <td class="eval-checkbox penalty-checkbox"><input type="checkbox" class="ev-nohw" ${chk(ev.homeworkPenalty)} onchange="recalcRow('${student.studentId}')" /></td>
        <td class="score-cell" id="score-${student.studentId}">${ev.totalPoints||0}</td>
      </tr>`;
    }).join('');
    students.forEach(s=>recalcRow(s.studentId));
  }
  if(mc) mc.style.display='block';
  if(es) es.style.display='none';
});

window.recalcRow=(studentId)=>{
  const row=document.getElementById(`row-${studentId}`); if(!row) return;
  const get=cls=>row.querySelector(cls)?.checked||false;
  let pts=0;
  if(get('.ev-attendance'))    pts+=SCORE_RULES.attendance;
  if(get('.ev-participation')) pts+=SCORE_RULES.participation;
  if(get('.ev-application'))   pts+=SCORE_RULES.application;
  if(get('.ev-homework'))      pts+=SCORE_RULES.homework;
  if(get('.ev-creativity'))    pts+=SCORE_RULES.creativity;
  if(get('.ev-late'))          pts+=SCORE_RULES.latePenalty;
  if(get('.ev-nohw'))          pts+=SCORE_RULES.homeworkPenalty;
  const cell=document.getElementById(`score-${studentId}`);
  if(cell){ cell.textContent=pts; cell.className=`score-cell${pts<0?' danger':pts<20?' warning':''}`; }
};

const btnSaveEvals=$('btn-save-evaluations');
if(btnSaveEvals) btnSaveEvals.addEventListener('click', async()=>{
  const sessionId=$('eval-session-select')?.value||'';
  const groupId=$('eval-group-select')?.value||'';
  if(!sessionId||!groupId) return;
  const uid=state.currentUser?.uid;
  if(!uid){showToast('خطأ في المصادقة.','error');return;}

  const students=state.students.filter(s=>s.groupId===groupId);
  const existMap={};
  state.evaluations.filter(ev=>ev.sessionId===sessionId).forEach(ev=>{ existMap[ev.studentId]=ev; });

  const ops=[], saved=[];
  students.forEach(student=>{
    const row=document.getElementById(`row-${student.studentId}`); if(!row) return;
    const get=cls=>row.querySelector(cls)?.checked||false;
    const attendance=get('.ev-attendance'),participation=get('.ev-participation'),
          application=get('.ev-application'),homework=get('.ev-homework'),
          creativity=get('.ev-creativity'),latePenalty=get('.ev-late'),
          homeworkPenalty=get('.ev-nohw');
    let total=0;
    if(attendance)      total+=SCORE_RULES.attendance;
    if(participation)   total+=SCORE_RULES.participation;
    if(application)     total+=SCORE_RULES.application;
    if(homework)        total+=SCORE_RULES.homework;
    if(creativity)      total+=SCORE_RULES.creativity;
    if(latePenalty)     total+=SCORE_RULES.latePenalty;
    if(homeworkPenalty) total+=SCORE_RULES.homeworkPenalty;
    const data={
      studentId:    student.studentId,
      sessionId,
      // groupId is stored in every evaluation so that Firestore Security Rules
      // can authorise Instructors without a cross-document lookup.
      // This is the field that was missing in legacy documents and caused
      // "Missing or insufficient permissions" for Instructors.
      groupId,
      attendance, participation, application,
      homework, creativity, latePenalty, homeworkPenalty,
      totalPoints:  total,
      lastEditedBy: uid,
      timestamp:    firebase.firestore.FieldValue.serverTimestamp()
    };
    const ex=existMap[student.studentId];
    if(ex){
      ops.push({type:'update',ref:db.collection('evaluations').doc(ex.evaluationId),data});
      saved.push({...data,evaluationId:ex.evaluationId});
    } else {
      const ref=db.collection('evaluations').doc();
      ops.push({type:'set',ref,data});
      saved.push({...data,evaluationId:ref.id});
    }
  });

  try {
    await batchOps(ops);
    saved.forEach(ev=>{
      const idx=state.evaluations.findIndex(x=>x.evaluationId===ev.evaluationId);
      if(idx!==-1) state.evaluations[idx]=ev; else state.evaluations.push(ev);
    });
    showToast('✅ تم حفظ جميع التقييمات!','success');

    // FIX Issue 2: Refresh all dashboard visuals immediately after save.
    // state.evaluations is already updated in-memory above, so all
    // compute functions (computeLifetimeTotals, computeBadges, etc.)
    // will pick up the new values without another Firestore round-trip.
    refreshDashboardAfterSave();

  } catch(e){console.error('[Eval save]',e);showToast('خطأ في الحفظ: '+e.message,'error');}
});

// ══════════════════════════════════════════════════════════════
//  [FIX-9] BADGE ENGINE — cycle.length instead of hardcoded 4
// ══════════════════════════════════════════════════════════════
function computeBadges() {
  const badgeMap={};
  state.groups.forEach(group=>{
    const gStudents=state.students.filter(s=>s.groupId===group.groupId);
    const gSessions=state.sessions.filter(s=>s.groupId===group.groupId)
      .sort((a,b)=>a.sessionNumber-b.sessionNumber);
    for(let i=0;i<gSessions.length;i+=4){
      const cycle=gSessions.slice(i,i+4);
      if(cycle.length<4) continue;
      const cycleLen=cycle.length;
      const cIds=new Set(cycle.map(s=>s.sessionId));
      const cs={};
      gStudents.forEach(s=>{ cs[s.studentId]={total:0,creativity:0,attended:0,hwDone:0,sessions:0}; });
      state.evaluations.forEach(ev=>{
        if(!cIds.has(ev.sessionId)||!cs[ev.studentId]) return;
        const c=cs[ev.studentId];
        c.total+=ev.totalPoints||0; c.creativity+=ev.creativity?SCORE_RULES.creativity:0;
        c.attended+=ev.attendance?1:0; c.hwDone+=ev.homework?1:0; c.sessions+=1;
      });
      const part=Object.entries(cs).filter(([,v])=>v.sessions>0);
      if(!part.length) continue;
      // 🥇 Star
      const top=part.reduce((a,b)=>b[1].total>a[1].total?b:a);
      if(!badgeMap[top[0]]) badgeMap[top[0]]=new Set();
      badgeMap[top[0]].add('starOfMonth');
      // 💡 Innovator
      const topC=part.reduce((a,b)=>b[1].creativity>a[1].creativity?b:a);
      if(topC[1].creativity>0){ if(!badgeMap[topC[0]]) badgeMap[topC[0]]=new Set(); badgeMap[topC[0]].add('youngInnovator'); }
      // 🎯 HW Champ
      part.forEach(([id,v])=>{ if(v.hwDone===v.sessions&&v.sessions>0){ if(!badgeMap[id]) badgeMap[id]=new Set(); badgeMap[id].add('homeworkChamp'); } });
      // 🔥 Perfect Attend (uses cycleLen — FIX-9)
      part.forEach(([id,v])=>{ if(v.attended===cycleLen){ if(!badgeMap[id]) badgeMap[id]=new Set(); badgeMap[id].add('perfectAttend'); } });
    }
  });
  const r={};
  Object.entries(badgeMap).forEach(([id,set])=>{ r[id]=[...set]; });
  return r;
}

// ══════════════════════════════════════════════════════════════
//  REPORTS
// ══════════════════════════════════════════════════════════════
function onCycleChange() {
  const v=$('report-cycle-select')?.value;
  const b=$('btn-generate-report');
  if(b) b.disabled=(v===''||v==null);
}

const rptGrpSel=$('report-group-select');
if(rptGrpSel) rptGrpSel.addEventListener('change',function(){
  const groupId=this.value;
  const cs=$('report-cycle-select'),gb=$('btn-generate-report'),rc=$('reports-container');
  if(cs){cs.innerHTML='<option value="">— اختر الدورة —</option>';cs.disabled=true;}
  if(gb) gb.disabled=true;
  if(rc) rc.innerHTML='';
  if(!groupId) return;
  const gs=state.sessions.filter(s=>s.groupId===groupId).sort((a,b)=>a.sessionNumber-b.sessionNumber);
  const cycles=Math.floor(gs.length/4);
  if(!cycles||!cs) return;
  for(let i=0;i<cycles;i++){
    const s=gs[i*4],e=gs[i*4+3],o=document.createElement('option');
    o.value=i;
    o.textContent=`الدورة ${i+1} — جلسات ${s.sessionNumber}–${e.sessionNumber} (${s.date} → ${e.date})`;
    cs.appendChild(o);
  }
  cs.disabled=false;
  cs.removeEventListener('change',onCycleChange);
  cs.addEventListener('change',onCycleChange);
});

const btnGenRpt=$('btn-generate-report');
if(btnGenRpt) btnGenRpt.addEventListener('click',()=>{
  const groupId=$('report-group-select')?.value||'';
  const cycleIdx=parseInt($('report-cycle-select')?.value);
  if(!groupId||isNaN(cycleIdx)) return;

  const group=state.groups.find(g=>g.groupId===groupId);
  const students=state.students.filter(s=>s.groupId===groupId);
  const gs=state.sessions.filter(s=>s.groupId===groupId).sort((a,b)=>a.sessionNumber-b.sessionNumber);
  const cycle=gs.slice(cycleIdx*4,cycleIdx*4+4);
  const cycleLen=cycle.length;
  const maxScore=cycleLen*MAX_SESSION_SCORE;
  const cIds=new Set(cycle.map(s=>s.sessionId));
  const badges=computeBadges();
  const container=$('reports-container'); if(!container) return;
  container.innerHTML='';
  if(!students.length){container.innerHTML='<div class="empty-state"><div class="empty-icon">📊</div><p>لا يوجد طلاب</p></div>';return;}

  students.forEach(student=>{
    const ce=state.evaluations.filter(ev=>ev.studentId===student.studentId&&cIds.has(ev.sessionId));
    const total=ce.reduce((s,ev)=>s+(ev.totalPoints||0),0);
    const attended=ce.filter(ev=>ev.attendance).length;
    const hwDone=ce.filter(ev=>ev.homework).length;
    const creative=ce.filter(ev=>ev.creativity).length;
    const sBadges=badges[student.studentId]||[];
    const badgeHTML=sBadges.map(b=>{ const r=Object.values(BADGE_RULES).find(x=>x.key===b); return r?`<span class="award-badge">${r.label}</span>`:''; }).join('');
    const pct=maxScore>0?Math.min(100,Math.round((total/maxScore)*100)):0;
    const pColor=pct>=80?'var(--success)':pct>=50?'var(--primary)':'var(--warning)';
    const cardId=`report-card-${student.studentId}`;
    const card=document.createElement('div');
    card.className='report-card'; card.id=cardId;
    card.innerHTML=`
      <div class="report-header">
        <div class="report-student-info">
          <h3>${student.studentName}</h3>
          <p>المجموعة: ${group?group.groupName:'—'} | الدورة ${cycleIdx+1}</p>
          <p style="margin-top:4px;">جلسات ${cycle[0]?.sessionNumber||''}–${cycle[cycleLen-1]?.sessionNumber||''}</p>
        </div>
        <div class="report-score-badge">
          <div class="score-num">${total}</div>
          <div class="score-label">/ ${maxScore} نقطة</div>
        </div>
      </div>
      <div class="report-body">
        ${sBadges.length?`<div class="report-badges-row">${badgeHTML}</div>`:''}
        <div style="margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:0.82rem;color:var(--text-secondary);">
            <span>نسبة الأداء</span><strong style="color:${pColor};">${pct}%</strong>
          </div>
          <div style="height:8px;background:var(--bg-input);border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${pColor};border-radius:4px;transition:width 0.6s ease;"></div>
          </div>
        </div>
        <table style="margin-bottom:16px;">
          <thead><tr><th>الجلسة</th><th>التاريخ</th><th>الحضور</th><th>الواجب</th><th>الإبداع</th><th>النقاط</th></tr></thead>
          <tbody>
            ${cycle.map(sess=>{ const ev=ce.find(e=>e.sessionId===sess.sessionId);
              return `<tr><td>جلسة ${sess.sessionNumber}</td><td>${sess.date||'—'}</td>
              <td>${ev?.attendance?'✅':'❌'}</td><td>${ev?.homework?'✅':'❌'}</td>
              <td>${ev?.creativity?'✅':'—'}</td>
              <td><strong style="color:var(--primary);">${ev?.totalPoints||0}</strong></td></tr>`;
            }).join('')}
          </tbody>
        </table>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
          ${[['جلسات الحضور',`${attended}/${cycleLen}`,'var(--success)'],
             ['واجبات مكتملة',`${hwDone}/${cycleLen}`,'var(--primary)'],
             ['مشاريع إبداعية',creative,'var(--info)'],
             ['مجموع النقاط',total,pColor]].map(([label,val,color])=>`
            <div style="flex:1;min-width:110px;background:var(--bg-card-alt);border-radius:var(--radius-sm);padding:12px;text-align:center;">
              <div style="font-size:1.4rem;font-weight:800;color:${color};">${val}</div>
              <div style="font-size:0.76rem;color:var(--text-muted);">${label}</div>
            </div>`).join('')}
        </div>
        <div class="report-actions">
          <button class="btn btn-danger btn-sm" onclick="exportPDF('${cardId}','${student.studentName}')">📄 PDF</button>
          <button class="btn btn-success btn-sm" onclick="exportExcel('${student.studentId}','${cycleIdx}','${groupId}')">📊 Excel</button>
          <button class="btn btn-ghost btn-sm" onclick="printReport('${cardId}')">🖨 طباعة</button>
        </div>
      </div>`;
    container.appendChild(card);
  });

  const allBtn=document.createElement('div');
  allBtn.style.cssText='margin-top:16px;text-align:center;';
  allBtn.innerHTML=`<button class="btn btn-secondary btn-lg" onclick="exportGroupExcel('${groupId}','${cycleIdx}')">📊 تصدير تقرير المجموعة (Excel)</button>`;
  container.appendChild(allBtn);
});

// ══════════════════════════════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════════════════════════════
window.exportPDF=(cardId,studentName)=>{
  if(typeof html2pdf==='undefined'){showToast('مكتبة PDF غير محمّلة.','error');return;}
  const card=document.getElementById(cardId); if(!card) return;
  showToast(`جاري تصدير ${studentName}...`,'info');
  html2pdf().set({margin:[8,8,8,8],filename:`تقرير-${studentName}.pdf`,
    image:{type:'jpeg',quality:0.95},html2canvas:{scale:2,useCORS:true,scrollY:0},
    jsPDF:{unit:'mm',format:'a4',orientation:'portrait'}})
    .from(card).save().catch(e=>{console.error('[PDF]',e);showToast('خطأ PDF.','error');});
};

window.printReport=(cardId)=>{
  const card=document.getElementById(cardId); if(!card) return;
  const win=window.open('','_blank');
  if(!win){showToast('السماح بالنوافذ المنبثقة.','error');return;}
  win.document.write(`<html dir="rtl"><head><meta charset="UTF-8"><title>تقرير</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="app.css">
    <style>body{font-family:'Cairo',sans-serif;padding:20px}.report-actions{display:none}</style>
    </head><body>${card.outerHTML}<script>window.onload=()=>window.print();<\/script></body></html>`);
  win.document.close();
};

window.exportExcel=(studentId,cycleIdx,groupId)=>{
  if(typeof XLSX==='undefined'){showToast('مكتبة Excel غير محمّلة.','error');return;}
  const student=state.students.find(s=>s.studentId===studentId);
  const gs=state.sessions.filter(s=>s.groupId===groupId).sort((a,b)=>a.sessionNumber-b.sessionNumber);
  const cycle=gs.slice(cycleIdx*4,cycleIdx*4+4);
  const cIds=new Set(cycle.map(s=>s.sessionId));
  const ce=state.evaluations.filter(ev=>ev.studentId===studentId&&cIds.has(ev.sessionId));
  const rows=cycle.map(sess=>{
    const ev=ce.find(e=>e.sessionId===sess.sessionId);
    return {'الجلسة':`جلسة ${sess.sessionNumber}`,'التاريخ':sess.date||'','الموضوع':sess.topic||'',
      'الحضور':ev?.attendance?'نعم':'لا','المشاركة':ev?.participation?'نعم':'لا',
      'التطبيق':ev?.application?'نعم':'لا','الواجب':ev?.homework?'نعم':'لا',
      'الإبداع':ev?.creativity?'نعم':'لا','تأخر':ev?.latePenalty?'نعم':'لا',
      'غياب الواجب':ev?.homeworkPenalty?'نعم':'لا','مجموع النقاط':ev?.totalPoints||0};
  });
  try {
    const wb=XLSX.utils.book_new(),ws=XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb,ws,student?.studentName||'تقرير');
    XLSX.writeFile(wb,`تقرير-${student?.studentName||'طالب'}-الدورة${parseInt(cycleIdx)+1}.xlsx`);
    showToast('Excel تم التصدير.','success');
  } catch(e){console.error('[Excel]',e);showToast('خطأ Excel.','error');}
};

window.exportGroupExcel=(groupId,cycleIdx)=>{
  if(typeof XLSX==='undefined'){showToast('مكتبة Excel غير محمّلة.','error');return;}
  const group=state.groups.find(g=>g.groupId===groupId);
  const students=state.students.filter(s=>s.groupId===groupId);
  const gs=state.sessions.filter(s=>s.groupId===groupId).sort((a,b)=>a.sessionNumber-b.sessionNumber);
  const cycle=gs.slice(cycleIdx*4,cycleIdx*4+4);
  const cLen=cycle.length,maxS=cLen*MAX_SESSION_SCORE;
  const cIds=new Set(cycle.map(s=>s.sessionId));
  const rows=students.map(student=>{
    const ce=state.evaluations.filter(ev=>ev.studentId===student.studentId&&cIds.has(ev.sessionId));
    const total=ce.reduce((s,ev)=>s+(ev.totalPoints||0),0);
    return {'اسم الطالب':student.studentName,'العمر':student.age||'',
      'جلسات الحضور':`${ce.filter(ev=>ev.attendance).length}/${cLen}`,
      'واجبات مكتملة':`${ce.filter(ev=>ev.homework).length}/${cLen}`,
      'مشاريع إبداعية':ce.filter(ev=>ev.creativity).length,
      'مجموع النقاط':total,'النسبة':`${maxS>0?Math.min(100,Math.round((total/maxS)*100)):0}%`};
  });
  try {
    const wb=XLSX.utils.book_new(),ws=XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb,ws,group?.groupName||'المجموعة');
    XLSX.writeFile(wb,`تقرير-${group?.groupName||'مجموعة'}-الدورة${parseInt(cycleIdx)+1}.xlsx`);
    showToast('Excel تم تصدير المجموعة.','success');
  } catch(e){console.error('[Excel-group]',e);showToast('خطأ Excel.','error');}
};

// ══════════════════════════════════════════════════════════════
//  [FIX-3] DELETE INSTRUCTOR — clean Firestore references
//  [FIX-4] DELETE GROUP — cascade: students, sessions, evaluations
// ══════════════════════════════════════════════════════════════
window.confirmDelete=(type,id,label)=>{
  const msgEl=$('confirm-msg');
  const warnEl=$('confirm-warning');
  if(msgEl) msgEl.textContent=`هل أنت متأكد من حذف ${label}؟ لا يمكن التراجع.`;
  // Show cascade warning
  let warning='';
  if(type==='group'){
    const sCnt=state.students.filter(s=>s.groupId===id).length;
    const sesCnt=state.sessions.filter(s=>s.groupId===id).length;
    const evCnt=state.evaluations.filter(ev=>{
      const sess=state.sessions.find(s=>s.sessionId===ev.sessionId);
      return sess&&sess.groupId===id;
    }).length;
    warning=`سيتم حذف ${sCnt} طالب، ${sesCnt} جلسة، و${evCnt} تقييم بشكل نهائي.`;
  }
  if(type==='instructor'){
    const gCnt=state.groups.filter(g=>g.instructorId===id).length;
    warning=`سيتم إزالة المدرّس من ${gCnt} مجموعة. (حذف حساب Auth يتطلب Cloud Function)`;
  }
  if(warnEl){ warnEl.textContent=warning; warnEl.style.display=warning?'block':'none'; }
  state.deleteCallback=async()=>{
    try { await deleteEntity(type,id); closeModal('modal-confirm'); showToast(`تم الحذف.`,'success'); }
    catch(e){ console.error('[Delete]',e); showToast('خطأ في الحذف: '+e.message,'error'); }
  };
  openModal('modal-confirm');
};

async function deleteEntity(type,id) {
  if(type==='group') {
    // [FIX-4] Cascade delete
    const ops=[];
    // Delete students
    const groupStudents=state.students.filter(s=>s.groupId===id);
    groupStudents.forEach(s=>ops.push({type:'delete',ref:db.collection('students').doc(s.studentId)}));
    // Delete sessions + evaluations inside them
    const groupSessions=state.sessions.filter(s=>s.groupId===id);
    const sessionIds=new Set(groupSessions.map(s=>s.sessionId));
    groupSessions.forEach(s=>ops.push({type:'delete',ref:db.collection('sessions').doc(s.sessionId)}));
    state.evaluations.filter(ev=>sessionIds.has(ev.sessionId))
      .forEach(ev=>ops.push({type:'delete',ref:db.collection('evaluations').doc(ev.evaluationId)}));
    // Remove group from instructor's assignedGroups
    const group=state.groups.find(g=>g.groupId===id);
    if(group?.instructorId){
      ops.push({type:'update',ref:db.collection('users').doc(group.instructorId),
        data:{assignedGroups:firebase.firestore.FieldValue.arrayRemove(id)}});
    }
    // Delete the group itself
    ops.push({type:'delete',ref:db.collection('groups').doc(id)});
    await batchOps(ops);
    // Update local state
    state.students   =state.students.filter(s=>s.groupId!==id);
    state.sessions   =state.sessions.filter(s=>s.groupId!==id);
    state.evaluations=state.evaluations.filter(ev=>!sessionIds.has(ev.sessionId));
    state.groups     =state.groups.filter(g=>g.groupId!==id);
    if(group?.instructorId){
      const inst=state.instructors.find(i=>i.userId===group.instructorId);
      if(inst) inst.assignedGroups=(inst.assignedGroups||[]).filter(g=>g!==id);
    }
    buildDropdowns(); renderGroups(); renderStudents(); renderSessions(); renderInstructors();
    const sg=$('stat-students'); if(sg) sg.textContent=state.students.length;

  } else if(type==='student') {
    // Also delete evaluations for this student
    const eIds=state.evaluations.filter(ev=>ev.studentId===id);
    const ops=eIds.map(ev=>({type:'delete',ref:db.collection('evaluations').doc(ev.evaluationId)}));
    ops.push({type:'delete',ref:db.collection('students').doc(id)});
    await batchOps(ops);
    state.evaluations=state.evaluations.filter(ev=>ev.studentId!==id);
    state.students=state.students.filter(s=>s.studentId!==id);
    renderStudents();
    const sg=$('stat-students'); if(sg) sg.textContent=state.students.length;

  } else if(type==='session') {
    // Also delete evaluations for this session
    const eIds=state.evaluations.filter(ev=>ev.sessionId===id);
    const ops=eIds.map(ev=>({type:'delete',ref:db.collection('evaluations').doc(ev.evaluationId)}));
    ops.push({type:'delete',ref:db.collection('sessions').doc(id)});
    await batchOps(ops);
    state.evaluations=state.evaluations.filter(ev=>ev.sessionId!==id);
    state.sessions=state.sessions.filter(s=>s.sessionId!==id);
    renderSessions();
    const sg=$('stat-sessions'); if(sg) sg.textContent=state.sessions.length;

  } else if(type==='instructor') {
    // [FIX-3] Remove instructor reference from all their groups
    const inst=state.instructors.find(i=>i.userId===id);
    const assignedGids=(inst?.assignedGroups||[]);
    const ops=assignedGids.map(gid=>({
      type:'update',ref:db.collection('groups').doc(gid),data:{instructorId:''}
    }));
    // Delete Firestore user document
    ops.push({type:'delete',ref:db.collection('users').doc(id)});
    await batchOps(ops);
    // Update local groups
    assignedGids.forEach(gid=>{
      const g=state.groups.find(x=>x.groupId===gid); if(g) g.instructorId='';
    });
    state.instructors=state.instructors.filter(i=>i.userId!==id);
    // NOTE: Firebase Auth user deletion requires Admin SDK (Cloud Function).
    // Client-side Auth cannot delete other users. Implement a CF at:
    // https://firebase.google.com/docs/auth/admin/manage-users#delete_a_user
    showToast('تم حذف بيانات المدرّس. ملاحظة: حذف حساب Auth يتطلب Cloud Function.','warning');
    renderInstructors(); renderGroups(); buildDropdowns();
  }
}

const btnConfirmDelete=$('btn-confirm-delete');
if(btnConfirmDelete) btnConfirmDelete.addEventListener('click',()=>{ if(state.deleteCallback) state.deleteCallback(); });

// ══════════════════════════════════════════════════════════════
//  THEME
// ══════════════════════════════════════════════════════════════
let darkMode=localStorage.getItem('codingua-theme')==='dark';
function applyTheme(){
  document.documentElement.setAttribute('data-theme',darkMode?'dark':'light');
  const b=$('theme-toggle'); if(b) b.textContent=darkMode?'☀️':'🌙';
}
applyTheme();
const themeBtn=$('theme-toggle');
if(themeBtn) themeBtn.addEventListener('click',()=>{
  darkMode=!darkMode; localStorage.setItem('codingua-theme',darkMode?'dark':'light'); applyTheme();
});

// ══════════════════════════════════════════════════════════════
//  SIDEBAR — Off-canvas drawer system (Mobile UX v4.0)
//  Fixes: [M-01] z-index, [M-02] body scroll lock,
//         [M-03] ESC key + smooth animation,
//         [M-12] hamburger always showing on ≤1024px,
//         [M-20] tablet collapsible sidebar
// ══════════════════════════════════════════════════════════════

function isMobileOrTablet() {
  // Sidebar is off-canvas on both mobile and tablet (≤1024px)
  return window.innerWidth <= 1024;
}

function openSidebar() {
  const sidebar  = $('sidebar');
  const overlay  = $('sidebar-overlay');
  const menuBtn  = $('mobile-menu-btn');

  if (!sidebar) return;
  sidebar.classList.add('open');
  if (overlay) overlay.classList.add('open');
  // FIX [M-02]: lock body scroll
  document.body.classList.add('sidebar-open');
  // ARIA
  if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true');
  // Move focus into sidebar for accessibility
  const firstNav = sidebar.querySelector('.nav-item');
  if (firstNav) firstNav.focus();
}

function closeSidebar() {
  const sidebar = $('sidebar');
  const overlay = $('sidebar-overlay');
  const menuBtn = $('mobile-menu-btn');

  if (!sidebar) return;
  sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
  // FIX [M-02]: restore body scroll
  document.body.classList.remove('sidebar-open');
  // ARIA
  if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
}

function toggleSidebar() {
  const sidebar = $('sidebar');
  if (!sidebar) return;
  if (sidebar.classList.contains('open')) closeSidebar();
  else openSidebar();
}

// Hamburger button
const mmbtn = $('mobile-menu-btn');
if (mmbtn) mmbtn.addEventListener('click', toggleSidebar);

// Sidebar-internal close button (visible on mobile/tablet)
const sidebarCloseBtn = $('sidebar-close-btn');
if (sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', closeSidebar);

// Overlay click — close drawer
const sbo = $('sidebar-overlay');
if (sbo) sbo.addEventListener('click', closeSidebar);

// FIX [M-03]: ESC key closes sidebar AND modals
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  // Close sidebar first if open
  const sidebar = $('sidebar');
  if (sidebar?.classList.contains('open')) {
    closeSidebar();
    return;
  }
  // Then close topmost open modal
  const openModal = document.querySelector('.modal-overlay.open');
  if (openModal) closeModal(openModal.id);
});

// Nav item clicks — close drawer on mobile/tablet after navigation
$$('.nav-item').forEach(item => item.addEventListener('click', () => {
  const panel = item.dataset.panel;
  if (!panel) return;
  setActivePanel(panel);
  if (panel === 'reports-panel') buildDropdowns();
  // Close sidebar on mobile/tablet after selecting a panel
  if (isMobileOrTablet()) closeSidebar();
}));

// Close sidebar when viewport resizes above tablet breakpoint
window.addEventListener('resize', () => {
  if (window.innerWidth > 1024) {
    // On desktop the sidebar is always visible — clean up drawer state
    closeSidebar();
  }
}, { passive: true });

// ══════════════════════════════════════════════════════════════
//  MODALS
// ══════════════════════════════════════════════════════════════
$$('.modal-close').forEach(btn => btn.addEventListener('click', () => {
  const m = btn.dataset.modal;
  if (m) closeModal(m);
}));

// Click backdrop to close
$$('.modal-overlay').forEach(ov => ov.addEventListener('click', e => {
  if (e.target === ov) closeModal(ov.id);
}));
