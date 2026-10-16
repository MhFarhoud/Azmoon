// ===== سامانه سنجش و ارزیابی مربیان اردویی نوجوانان =====
const socket = io();
let currentRole = '';
let currentCandidate = null;
let currentCandidateId = null;
let examDuration = 35;
let examTimerInterval = null;

// Exam Configuration Cache
let examItems = [];
let examScales = [];
let examDesc = {};

const PAGES = [
    [0, 10], [10, 20], [20, 30], [30, 40], [40, 50],
    [50, 60], [60, 65], [65, 70], [70, 75], [75, 80]
];
let currentStep = 0;
let candidateAnswers = Array(80).fill('');

// Offline resilience
let isOnline = navigator.onLine;
window.addEventListener('online', () => updateOnlineStatus(true));
window.addEventListener('offline', () => updateOnlineStatus(false));

function updateOnlineStatus(status) {
    isOnline = status;
    const banner = document.getElementById('offline-banner');
    if (banner) {
        if (isOnline) banner.classList.add('hidden');
        else banner.classList.remove('hidden');
    }
}

// Utility Helpers
function norm(v) {
    if (v == null) return '';
    return String(v).trim().replace(/[\u0660-\u0669\u06F0-\u06F9]/g, d => '0123456789'['۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩'.indexOf(d)]);
}

function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pct(v, max = 5) {
    return Math.max(0, Math.min(100, Math.round((Number(v) || 0) / max * 100)));
}

const app = {
    init: async function() {
        await this.loadExamConfig();
        this.setupSocketListeners();
        this.checkLocalCandidateState();
    },

    loadExamConfig: async function() {
        try {
            const res = await fetch('/api/questions');
            const data = await res.json();
            examItems = data.items || [];
            examScales = data.scales || [];
            examDesc = data.desc || {};
            examDuration = data.duration || 35;
        } catch (e) {
            console.error('Error loading exam config:', e);
        }
    },

    setRole: function(role) {
        currentRole = role;
        document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'));
        
        const exitBtn = document.getElementById('exit-role-btn');
        if (exitBtn) {
            exitBtn.style.display = (role ? 'inline-block' : 'none');
        }

        if (role === 'receptionist') {
            document.getElementById('receptionist-view').classList.remove('hidden');
            this.fetchCandidates();
        } else if (role === 'candidate') {
            document.getElementById('candidate-view').classList.remove('hidden');
            this.checkLocalCandidateState();
        } else if (role === 'admin') {
            document.getElementById('admin-view').classList.remove('hidden');
            this.fetchCandidates();
        } else {
            document.getElementById('role-selection').classList.remove('hidden');
        }
    },

    // --- Staff Login Modal ---
    requestStaffLogin: function(role) {
        this.pendingStaffRole = role;
        document.getElementById('staff-password').value = '';
        document.getElementById('staff-login-error').style.display = 'none';
        document.getElementById('staff-login-modal').classList.remove('hidden');
        document.getElementById('staff-password').focus();
    },

    closeStaffLogin: function() {
        document.getElementById('staff-login-modal').classList.add('hidden');
        this.pendingStaffRole = null;
    },

    submitStaffLogin: async function() {
        const pass = document.getElementById('staff-password').value;
        try {
            const res = await fetch('/api/staff_login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({password: pass})
            });
            const data = await res.json();
            if (data.success) {
                const targetRole = this.pendingStaffRole;
                this.closeStaffLogin();
                this.setRole(targetRole);
            } else {
                document.getElementById('staff-login-error').style.display = 'block';
            }
        } catch (e) {
            document.getElementById('staff-login-error').innerText = 'خطا در ارتباط با سرور';
            document.getElementById('staff-login-error').style.display = 'block';
        }
    },

    filterCandidates: function(inputId, tbodyId) {
        const input = document.getElementById(inputId);
        const filter = input.value.trim().toLowerCase();
        const tbody = document.getElementById(tbodyId);
        if (!tbody) return;
        const trs = tbody.getElementsByTagName('tr');
        for (let i = 0; i < trs.length; i++) {
            const txt = (trs[i].textContent || trs[i].innerText).toLowerCase();
            trs[i].style.display = (txt.indexOf(filter) > -1 ? '' : 'none');
        }
    },

    // --- Candidate Authentication ---
    submitCandidateLogin: async function() {
        const nidInput = document.getElementById('cand-nid');
        const passInput = document.getElementById('cand-pass');
        const errorEl = document.getElementById('cand-login-error');

        const user = norm(nidInput.value);
        const pass = norm(passInput.value);

        if (!user || !pass) {
            errorEl.innerText = 'لطفاً کد ملی و رمز عبور را وارد کنید.';
            errorEl.style.display = 'block';
            return;
        }

        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username: user, password: pass, device_info: navigator.userAgent})
            });
            const data = await res.json();
            if (data.success) {
                errorEl.style.display = 'none';
                currentCandidateId = data.candidate.id;
                currentCandidate = data.candidate;
                
                let localData = JSON.parse(localStorage.getItem('shahr_candidate') || '{}');
                if (localData.id !== currentCandidateId) {
                    localData = {
                        id: currentCandidateId,
                        name: data.candidate.name,
                        status: 'waiting',
                        step: 0,
                        answers: Array(80).fill('')
                    };
                    localStorage.setItem('shahr_candidate', JSON.stringify(localData));
                }
                
                this.joinWaitingRoom(currentCandidateId);
            } else {
                errorEl.innerText = data.error || 'نام کاربری یا رمز عبور اشتباه است.';
                errorEl.style.display = 'block';
            }
        } catch (e) {
            errorEl.innerText = 'خطای اتصال به سرور';
            errorEl.style.display = 'block';
        }
    },

    joinWaitingRoom: function(id) {
        document.getElementById('candidate-login').classList.add('hidden');
        document.getElementById('candidate-waiting').classList.remove('hidden');
        socket.emit('candidate_join', { candidate_id: id });
    },

    logoutCandidate: function() {
        localStorage.removeItem('shahr_candidate');
        currentCandidateId = null;
        currentCandidate = null;
        if (examTimerInterval) clearInterval(examTimerInterval);
        document.getElementById('candidate-waiting').classList.add('hidden');
        document.getElementById('candidate-exam').classList.add('hidden');
        document.getElementById('candidate-finished').classList.add('hidden');
        document.getElementById('candidate-login').classList.remove('hidden');
    },

    checkLocalCandidateState: function() {
        const localData = JSON.parse(localStorage.getItem('shahr_candidate') || '{}');
        if (!localData.id) {
            document.getElementById('candidate-login').classList.remove('hidden');
            document.getElementById('candidate-waiting').classList.add('hidden');
            document.getElementById('candidate-exam').classList.add('hidden');
            document.getElementById('candidate-finished').classList.add('hidden');
            return;
        }

        currentCandidateId = localData.id;
        currentCandidate = { id: localData.id, name: localData.name || 'داوطلب' };
        candidateAnswers = localData.answers && localData.answers.length === 80 ? localData.answers : Array(80).fill('');
        currentStep = localData.step || 0;

        if (localData.status === 'finished') {
            this.showCandidateFinished();
        } else if (localData.status === 'exam') {
            this.showExamView();
        } else {
            this.joinWaitingRoom(currentCandidateId);
        }
    },

    // --- Multi-Step Exam Flow ---
    showExamView: async function() {
        document.getElementById('candidate-waiting').classList.add('hidden');
        document.getElementById('candidate-login').classList.add('hidden');
        document.getElementById('candidate-finished').classList.add('hidden');
        document.getElementById('candidate-exam').classList.remove('hidden');

        let localData = JSON.parse(localStorage.getItem('shahr_candidate') || '{}');
        localData.status = 'exam';
        if (!localData.startTime) localData.startTime = Date.now();
        localStorage.setItem('shahr_candidate', JSON.stringify(localData));

        if (!examItems.length) {
            await this.loadExamConfig();
        }

        const nameEl = document.getElementById('exam-candidate-name');
        const metaEl = document.getElementById('exam-candidate-meta');
        if (nameEl) nameEl.innerText = localData.name || 'داوطلب ارزیابی مربیان';
        if (metaEl) metaEl.innerText = `کد داوطلب / کد ملی: ${localData.id || '—'}`;

        this.renderPortalStep();
        this.startTimer();
        this.monitorLocation();
    },

    monitorLocation: function() {
        const statusEl = document.getElementById('location-live-status');
        if (!statusEl) return;
        
        // Coordinates for Farhangsaraye Andisheh (Tehran)
        const targetLat = 35.7412;
        const targetLon = 51.4428;
        
        if ('geolocation' in navigator) {
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const lat = pos.coords.latitude;
                    const lon = pos.coords.longitude;
                    // Approximate distance using haversine formula
                    const R = 6371; // Earth radius in km
                    const dLat = (lat - targetLat) * Math.PI / 180;
                    const dLon = (lon - targetLon) * Math.PI / 180;
                    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                              Math.cos(targetLat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) *
                              Math.sin(dLon/2) * Math.sin(dLon/2);
                    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                    const distKm = R * c;
                    
                    if (distKm <= 12) { // Within Farhangsara / Tehran area
                        statusEl.className = 'location-status-badge';
                        statusEl.innerHTML = '<span style="font-size: 8px;">🟢</span> موقعیت مکانی تأیید شد: در محدوده مجاز فرهنگسرای اندیشه';
                    } else {
                        statusEl.className = 'location-status-badge danger';
                        statusEl.innerHTML = `<span style="font-size: 8px;">⛔</span> هشدار تقلب: موقعیت شما خارج از فرهنگسرای اندیشه تشخیص داده شد! (${distKm.toFixed(1)} کیلومتر)`;
                        alert('هشدار امنیتی: موقعیت مکانی شما خارج از محدوده فرهنگسرای اندیشه است. هرگونه خروج از محدوده موجب ابطال قطعی آزمون خواهد شد.');
                    }
                },
                (err) => {
                    statusEl.className = 'location-status-badge';
                    statusEl.innerHTML = '<span style="font-size: 8px;">📍</span> پایش لحظه‌ای فعال: آزمون منحصراً در فرهنگسرای اندیشه معتبر است';
                },
                { enableHighAccuracy: true, timeout: 7000 }
            );
        } else {
            statusEl.className = 'location-status-badge';
            statusEl.innerHTML = '<span style="font-size: 8px;">📍</span> پایش مکانی شبکه فعال در فرهنگسرای اندیشه';
        }
    },

    renderPortalStep: function(msg = '') {
        const root = document.getElementById('portalBody');
        if (!root) return;

        const [start, end] = PAGES[currentStep];
        const isSjt = start >= 65;
        const title = isSjt ? 'بخش دوم: قضاوت موقعیتی و تصمیم‌گیری اردویی (سناریوها)' : 'بخش اول: گزاره‌های شخصیت و رفتارهای مربیگری';

        const badgeEl = document.getElementById('exam-section-badge');
        if (badgeEl) badgeEl.innerText = isSjt ? 'سناریوهای موقعیتی (۶۶ تا ۸۰)' : 'گزاره‌های شخصیتی و رفتاری (۱ تا ۶۵)';

        const filledCount = candidateAnswers.filter(x => x !== '').length;
        const progressPct = Math.round((filledCount / 80) * 100);

        // Build question cards
        let questionsHTML = '';
        for (let j = start; j < end; j++) {
            const q = examItems[j];
            if (!q) continue;
            const currentAns = candidateAnswers[j] || '';
            const labels = isSjt ? ['الف', 'ب', 'پ', 'ت'] : ['کاملاً مخالفم', 'مخالفم', 'نظری ندارم', 'موافقم', 'کاملاً موافقم'];
            const values = isSjt ? ['الف', 'ب', 'پ', 'ت'] : ['1', '2', '3', '4', '5'];
            const texts = isSjt ? q.options : labels;

            let optionsHTML = '';
            for (let i = 0; i < values.length; i++) {
                const checked = (currentAns === values[i] ? 'checked' : '');
                optionsHTML += `<label class="portal-option">
                    <input type="radio" name="portalQ${j}" value="${values[i]}" onchange="app.saveAnswer(${j}, '${values[i]}')" ${checked}>
                    <span>${isSjt ? '<b>' + labels[i] + ') </b>' : ''}${esc(texts[i])}</span>
                </label>`;
            }

            questionsHTML += `<div class="portal-question" id="pq${j}">
                <h3>${q.n}. ${esc(q.text)}</h3>
                <div class="portal-options ${isSjt ? 'sjt' : ''}">
                    ${optionsHTML}
                </div>
            </div>`;
        }

        // Steps navigation pills
        let stepsHTML = '';
        PAGES.forEach((_, idx) => {
            stepsHTML += `<span class="portal-step ${idx === currentStep ? 'active' : ''}">${idx + 1}</span>`;
        });

        root.innerHTML = `
            <div class="portal-steps">${stepsHTML}</div>
            <div class="portal-progress"><div style="width: ${progressPct}%"></div></div>
            <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin: 6px 0 14px;">
                <span>${filledCount} پاسخ ثبت‌شده از ۸۰</span>
                <span>مرحله ${currentStep + 1} از ${PAGES.length}</span>
            </div>
            ${msg ? `<div class="portal-error">${esc(msg)}</div>` : ''}
            <h2 style="font-size: 16px; color: var(--navy); margin: 15px 0 10px;">${title}</h2>
            ${questionsHTML}
            <div class="portal-actions">
                <button class="secondary" id="portalPrev" onclick="app.prevPortalStep()" ${currentStep === 0 ? 'disabled' : ''}>مرحله قبل</button>
                <button class="btn-success" id="portalNext" onclick="app.nextPortalStep()">
                    ${currentStep === PAGES.length - 1 ? 'ثبت نهایی پاسخ‌نامه ✓' : 'مرحله بعد ←'}
                </button>
            </div>
        `;
    },

    saveAnswer: function(index, val) {
        candidateAnswers[index] = val;
        let localData = JSON.parse(localStorage.getItem('shahr_candidate') || '{}');
        localData.answers = candidateAnswers;
        localData.step = currentStep;
        localStorage.setItem('shahr_candidate', JSON.stringify(localData));

        const filledCount = candidateAnswers.filter(x => x !== '').length;
        const progressEl = document.querySelector('.portal-progress div');
        if (progressEl) progressEl.style.width = Math.round((filledCount / 80) * 100) + '%';
    },

    nextPortalStep: function() {
        const [start, end] = PAGES[currentStep];
        // Validate unanswered in current page
        const missing = [];
        for (let i = start; i < end; i++) {
            if (!candidateAnswers[i]) missing.push(i);
        }

        if (missing.length > 0) {
            const firstMissEl = document.getElementById('pq' + missing[0]);
            if (firstMissEl) firstMissEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            this.renderPortalStep(`لطفاً به تمام سؤال‌های این بخش پاسخ دهید. اولین مورد بی‌پاسخ: سؤال شماره ${missing[0] + 1}`);
            return;
        }

        if (currentStep === PAGES.length - 1) {
            // Check all 80 questions
            const anyMiss = candidateAnswers.findIndex(x => !x);
            if (anyMiss !== -1) {
                alert(`سؤال شماره ${anyMiss + 1} بی‌پاسخ است. لطفاً تکمیل نمایید.`);
                return;
            }
            if (confirm('آیا از ثبت نهایی پاسخ‌نامه و پایان آزمون اطمینان دارید؟')) {
                this.submitExam();
            }
        } else {
            currentStep++;
            let localData = JSON.parse(localStorage.getItem('shahr_candidate') || '{}');
            localData.step = currentStep;
            localStorage.setItem('shahr_candidate', JSON.stringify(localData));
            this.renderPortalStep();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    },

    prevPortalStep: function() {
        if (currentStep > 0) {
            currentStep--;
            let localData = JSON.parse(localStorage.getItem('shahr_candidate') || '{}');
            localData.step = currentStep;
            localStorage.setItem('shahr_candidate', JSON.stringify(localData));
            this.renderPortalStep();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    },

    startTimer: function() {
        if (examTimerInterval) clearInterval(examTimerInterval);
        const localData = JSON.parse(localStorage.getItem('shahr_candidate') || '{}');
        const endTime = (localData.startTime || Date.now()) + (examDuration * 60 * 1000);

        examTimerInterval = setInterval(() => {
            const now = Date.now();
            const diff = endTime - now;

            if (diff <= 0) {
                clearInterval(examTimerInterval);
                alert('زمان آزمون به پایان رسید. پاسخ‌های شما ثبت نهایی می‌شود.');
                this.submitExam();
                return;
            }

            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);
            const timerEl = document.getElementById('exam-timer');
            if (timerEl) {
                timerEl.innerText = `زمان باقی‌مانده: ${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`;
                if (m < 5) {
                    timerEl.style.color = '#dc2626';
                    timerEl.style.background = '#fef2f2';
                    timerEl.style.borderColor = '#fecaca';
                }
            }
        }, 1000);
    },

    submitExam: async function() {
        const localData = JSON.parse(localStorage.getItem('shahr_candidate') || '{}');

        try {
            const res = await fetch('/api/submit_exam', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    candidate_id: currentCandidateId,
                    answers: candidateAnswers
                })
            });
            const result = await res.json();
            if (result.success) {
                if (examTimerInterval) clearInterval(examTimerInterval);
                localData.status = 'finished';
                localStorage.setItem('shahr_candidate', JSON.stringify(localData));
                this.showCandidateFinished();
            } else {
                alert(result.error || 'خطا در ثبت پاسخ‌ها');
            }
        } catch (e) {
            alert('ارتباط با سرور برقرار نشد، اما پاسخ‌های شما به صورت محلی ذخیره شده است. صفحه را نبندید.');
        }
    },

    showCandidateFinished: function() {
        document.getElementById('candidate-exam').classList.add('hidden');
        document.getElementById('candidate-waiting').classList.add('hidden');
        document.getElementById('candidate-login').classList.add('hidden');
        document.getElementById('candidate-finished').classList.remove('hidden');

        const infoEl = document.getElementById('receipt-candidate-info');
        if (infoEl) infoEl.innerHTML = `کد داوطلب: <b>${esc(currentCandidateId || '—')}</b>`;
    },

    finishCandidateSession: function() {
        this.logoutCandidate();
        this.setRole('');
    },

    // --- Receptionist & Admin Operations ---
    fetchCandidates: async function() {
        try {
            const res = await fetch('/api/candidates');
            const data = await res.json();
            this.renderCandidateList(data);
        } catch (e) {
            console.error('Error fetching candidates:', e);
        }
    },

    renderCandidateList: function(cList) {
        this.updateStats(cList);
        const tbody = document.getElementById('candidate-list-body');
        const adminTbody = document.getElementById('admin-candidate-list');

        if (tbody) tbody.innerHTML = '';
        if (adminTbody) adminTbody.innerHTML = '';

        const statusMap = {
            'offline': 'آفلاین',
            'waiting': 'در انتظار تایید',
            'approved': 'در حال آزمون',
            'finished': 'پایان یافته'
        };

        cList.forEach(c => {
            // Receptionist Table Row
            if (tbody) {
                let actionBtn = '';
                if (c.status === 'waiting') {
                    actionBtn = `<button class="btn-success" style="padding: 6px 12px; font-size: 11px;" onclick="app.approveCandidate('${c.id}')">تأیید ورود ✓</button>`;
                }
                actionBtn += ` <button class="btn-danger" style="padding: 6px 10px; font-size: 11px;" onclick="app.resetExam('${c.id}')">ریست</button>`;

                const groupInfo = `${c.day || '—'} ${c.exam_group ? '(گروه ' + c.exam_group + ')' : ''}`;

                const tr = `<tr>
                    <td><b>${esc(c.first_name)} ${esc(c.last_name)}</b></td>
                    <td><code>${esc(c.username)}</code></td>
                    <td><strong style="color: #00878a; letter-spacing: 1px;">${esc(c.password || '—')}</strong></td>
                    <td><span style="font-size: 11px; color: var(--muted);">${groupInfo}</span></td>
                    <td><span style="direction: ltr; display: inline-block;">${esc(c.phone || '—')}</span></td>
                    <td><span style="font-size: 11px; color: var(--muted);">${esc(c.device_info || 'نامشخص')}</span></td>
                    <td><span class="status status-${c.status}">${statusMap[c.status] || c.status}</span></td>
                    <td>${actionBtn}</td>
                </tr>`;
                tbody.innerHTML += tr;
            }

            // Admin Table Row
            if (adminTbody) {
                let sjtDisplay = '—';
                let validCount = '—';
                let viewBtn = '<span style="color: var(--muted);">—</span>';

                if (c.results) {
                    sjtDisplay = `<b>${c.results.sjt_total || 0}</b> / ۴۵`;
                    validCount = `${c.results.self_valid || 0} خودگزارشی | ${c.results.sjt_valid || 0} سناریو`;
                    viewBtn = `<button class="btn-success" style="padding: 6px 12px; font-size: 11px;" onclick="app.viewReport('${c.id}')">📄 مشاهده کارنامه جامع</button>`;
                }

                const tr = `<tr>
                    <td><b>${esc(c.first_name)} ${esc(c.last_name)}</b></td>
                    <td><code>${esc(c.username)}</code></td>
                    <td><span style="font-size: 11px;">${validCount}</span></td>
                    <td><span style="font-size: 12px; color: #087b8a;">${sjtDisplay}</span></td>
                    <td><span style="font-size: 11px; color: var(--muted);">${esc(c.device_info || 'نامشخص')}</span></td>
                    <td><span class="status status-${c.status}">${statusMap[c.status] || c.status}</span></td>
                    <td>${viewBtn}</td>
                </tr>`;
                adminTbody.innerHTML += tr;
            }
        });
    },

    updateStats: function(cList) {
        const total = cList.length;
        const waiting = cList.filter(c => c.status === 'waiting').length;
        const active = cList.filter(c => c.status === 'approved').length;
        const finished = cList.filter(c => c.status === 'finished').length;
        const offline = total - waiting - active - finished;

        // Receptionist Stats
        const recStats = document.getElementById('receptionist-stats');
        if (recStats) {
            recStats.innerHTML = `
                <div class="stat-card"><h3>کل متقاضیان</h3><h2>${total}</h2></div>
                <div class="stat-card"><h3>در انتظار پذیرش</h3><h2 style="color: #b45309;">${waiting}</h2></div>
                <div class="stat-card"><h3>در حال آزمون</h3><h2 style="color: #1e40af;">${active}</h2></div>
                <div class="stat-card"><h3>پایان‌یافته</h3><h2 style="color: #15803d;">${finished}</h2></div>
                <div class="stat-card"><h3>آفلاین</h3><h2 style="color: #6b7280;">${offline}</h2></div>
            `;
        }

        // Admin Stats
        const adminStats = document.getElementById('admin-stats');
        if (adminStats) {
            adminStats.innerHTML = `
                <div class="stat-card"><h3>کل ثبت‌نامی‌ها</h3><h2>${total}</h2></div>
                <div class="stat-card"><h3>اتمام آزمون</h3><h2 style="color: #15803d;">${finished}</h2></div>
                <div class="stat-card"><h3>در حال آزمون</h3><h2 style="color: #1e40af;">${active}</h2></div>
                <div class="stat-card"><h3>در انتظار</h3><h2 style="color: #b45309;">${waiting}</h2></div>
            `;
        }
    },

    approveCandidate: function(id) {
        socket.emit('approve_candidate', { candidate_id: id });
    },

    resetExam: function(id) {
        if (confirm('آیا از ریست کردن آزمون این داوطلب اطمینان دارید؟ تمام پاسخ‌ها پاک خواهد شد.')) {
            socket.emit('reset_exam', { candidate_id: id });
        }
    },

    updateSettings: function() {
        const val = document.getElementById('admin_duration').value;
        socket.emit('update_settings', { duration: val });
        alert('تنظیمات زمان آزمون به‌روز شد.');
    },

    // --- Add Candidate Modal ---
    openAddCandidateModal: function() {
        document.getElementById('new-cand-fname').value = '';
        document.getElementById('new-cand-lname').value = '';
        document.getElementById('new-cand-nid').value = '';
        document.getElementById('new-cand-pass').value = '';
        document.getElementById('new-cand-phone').value = '';
        document.getElementById('add-cand-error').style.display = 'none';
        document.getElementById('add-candidate-modal').classList.remove('hidden');
    },

    closeAddCandidateModal: function() {
        document.getElementById('add-candidate-modal').classList.add('hidden');
    },

    submitNewCandidate: async function() {
        const fn = document.getElementById('new-cand-fname').value.trim();
        const ln = document.getElementById('new-cand-lname').value.trim();
        const nid = norm(document.getElementById('new-cand-nid').value);
        let pass = norm(document.getElementById('new-cand-pass').value);
        const phone = norm(document.getElementById('new-cand-phone').value);

        if (!fn || !ln || !nid) {
            const err = document.getElementById('add-cand-error');
            err.innerText = 'نام، نام خانوادگی و کد ملی الزامی است.';
            err.style.display = 'block';
            return;
        }

        if (!pass) {
            pass = String(Math.floor(10000 + Math.random() * 90000));
        }

        try {
            const res = await fetch('/api/add_candidate', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    first_name: fn,
                    last_name: ln,
                    national_id: nid,
                    username: nid,
                    password: pass,
                    phone: phone
                })
            });
            const data = await res.json();
            if (data.success) {
                this.closeAddCandidateModal();
                alert(`داوطلب با موفقیت افزوده شد.\nرمز عبور: ${pass}`);
            } else {
                const err = document.getElementById('add-cand-error');
                err.innerText = data.error || 'خطا در ثبت داوطلب';
                err.style.display = 'block';
            }
        } catch (e) {
            const err = document.getElementById('add-cand-error');
            err.innerText = 'خطای اتصال به سرور';
            err.style.display = 'block';
        }
    },

    // ===== 6-Page Comprehensive Report Generation =====
    viewReport: async function(id) {
        const res = await fetch('/api/candidates');
        const cList = await res.json();
        const cand = cList.find(c => c.id === id);
        if (!cand || !cand.results) {
            alert('کارنامه‌ای برای این داوطلب ثبت نشده است.');
            return;
        }

        const reportHTML = this.generateReportHTML(cand);
        const reportBody = document.getElementById('report-body');
        if (reportBody) reportBody.innerHTML = reportHTML;

        document.getElementById('report-modal').classList.remove('hidden');
    },

    closeReport: function() {
        document.getElementById('report-modal').classList.add('hidden');
    },

    printReport: function() {
        window.print();
    },

    generateReportHTML: function(c) {
        const s = c.results || {};
        const m = s.means || {};
        const fullName = `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.name || 'داوطلب';
        const code = c.username || c.national_id || c.id || '—';
        const age = c.age || '—';
        const dateStr = c.day || new Date().toLocaleDateString('fa-IR');

        const big = s.big || [];
        const less = s.less || [];
        const interview = s.interview || (less.length ? less.slice(0, 3) : ['قاطعیت و مرزها', 'مسئولیت و حفاظت']);
        const flags = (s.flags || []).slice(0, 8);
        const pts = s.pts || { 0: 0, 1: 0, 3: 0 };

        // Helper closures for rendering
        const bar = (name, val) => `
            <div class="bars">
                <span>${esc(name)}</span>
                <div class="bar-bg"><div class="bar-fill" style="width: ${val == null ? 0 : pct(val, 5)}%"></div></div>
                <span style="direction: ltr; text-align: left">${val == null ? '—' : Number(val).toFixed(2)}</span>
            </div>`;

        const head = (title, num) => `
            <div class="masthead">
                <div>
                    <div class="eyebrow">مرکز ارزیابی مربیان اردویی نوجوانان | گزارش ساختاریافته</div>
                    <h2>${title}</h2>
                    <div class="sub">نام: ${esc(fullName)} | کد داوطلب: ${esc(code)} | آزمون غربالگری نسخه ۱.۰</div>
                </div>
                <div class="report-headright">
                    <div class="brand-logos">
                        <span class="brand-logo"><img alt="نشان نخست" src="/static/logo1.svg"></span>
                        <span class="brand-logo"><img alt="نشان دوم" src="/static/logo2.svg"></span>
                    </div>
                    <div class="page-tag">صفحه ${num} از ۶</div>
                </div>
            </div>`;

        const page = (inner, num, common = false) => `
            <section class="page" data-footer="${common ? 'پیوست ثابت: راهنمای مشترک شاخص‌ها و تفسیر نتایج' : 'محرمانه ـ ویژه مسئول ارزیاب'} | آزمون ارزیابی شایستگی‌های مربیان اردویی">${inner}</section>`;

        const defs = (list) => list.map(n => {
            const a = examDesc[n] || ['—', '—', '—'];
            return `<div class="definition">
                <h4>${esc(n)}</h4>
                <p><b>تعریف:</b> ${esc(a[0])}</p>
                <p><b>تفسیر:</b> ${esc(a[1])}</p>
                <div class="prompt"><b>پیشنهاد برای ارزیاب:</b> ${esc(a[2])}</div>
            </div>`;
        }).join('');

        // Page 1: نمای مدیریتی
        const p1 = page(head('کارنامه فردی | نمای مدیریتی', 1) + `
            <div class="infogrid">
                <div class="info"><small>نام و نام خانوادگی</small><strong>${esc(fullName)}</strong></div>
                <div class="info"><small>کد داوطلب (کد ملی)</small><strong>${esc(code)}</strong></div>
                <div class="info"><small>گروه / روز</small><strong>${esc(c.day || '—')}</strong></div>
                <div class="info"><small>شماره تماس</small><strong>${esc(c.phone || '—')}</strong></div>
            </div>
            <div class="kpis">
                <div class="kpi"><div class="num">${s.self_valid || 0}/۶۵</div><small>پاسخ معتبر خودگزارشی</small></div>
                <div class="kpi"><div class="num">${s.sjt_valid || 0}/۱۵</div><small>سناریوی پاسخ‌داده‌شده</small></div>
                <div class="kpi"><div class="num">${s.sjt_total != null ? s.sjt_total + '/۴۵' : '—'}</div><small>امتیاز موقعیتی (از ۴۵)</small></div>
            </div>
            <h3>نیمرخ ویژگی‌های شخصیتی | میانگین ۱ تا ۵</h3>
            ${examScales.slice(0, 10).map(x => bar(x, m[x])).join('')}
            <h3>نیمرخ شایستگی‌های هیجانی و تربیتی | میانگین ۱ تا ۵</h3>
            ${examScales.slice(10, 15).map(x => bar(x, m[x])).join('')}
            <div class="callout">
                <b>برداشت مقدماتی:</b> ${s.self_valid === 65 && s.sjt_valid === 15 ? 'اطلاعات کامل ثبت شده است.' : 'پاسخ‌ها در حال تکمیل یا ناقص‌اند؛ تفسیر صرفاً برای مقیاس‌های تکمیل‌شده است.'}
                ${big.length ? 'خرده‌مقیاس‌های دارای میانگین بالاتر: ' + esc(big.slice(0, 3).join('، ')) + '؛ ' : ''}
                ${less.length ? 'مواردی که در نیمرخ شخصی نمره پایین‌تری دارند: ' + esc(less.slice(0, 3).join('، ')) + '؛ ' : ''}
                هیچ‌یک از این موارد به‌تنهایی معیار پذیرش یا رد نیستند.
            </div>
            <div class="print-note">میله‌ها نمرات خودگزارشی را نشان می‌دهند؛ مقایسه با هنجار جمعیتی یا درصد صلاحیت نیستند.</div>
        `, 1);

        // Page 2: تحلیل فردی و اقدامات تکمیلی
        const discussionRows = interview.map((x, i) => {
            const prompt = (examDesc[x] && examDesc[x][2]) ? examDesc[x][2] : 'بررسی شواهد رفتاری در سناریوی شبیه‌سازی‌شده';
            return `<tr><td>${i + 1}</td><td><b>${esc(x)}</b></td><td>${esc(prompt)}</td></tr>`;
        }).join('');

        const flagsHTML = flags.length
            ? flags.map(x => `<div class="scenario"><span class="tag">سؤال ${x.n}</span><span><b>${esc(x.scale)}</b></span><span class="dim">گزینه انتخابی: ${esc(x.selected)} (امتیاز: ${x.p})</span></div>`).join('')
            : '<div class="callout">مورد غیرترجیحی در سناریوها ثبت نشده است؛ برای سنجش واقعی مهارت، مصاحبه و مشاهده عملی لازم است.</div>';

        const p2 = page(head('تحلیل فردی و اقدامات تکمیلی', 2) + `
            <div class="analysis">
                <div class="tile">
                    <h4>الگوهای برجسته در پاسخ‌ها</h4>
                    <p>${big.length ? 'میانگین بالاتر نسبت به مقیاس‌های دیگرِ همین فرد در: ' + esc(big.slice(0, 4).join('، ')) : 'در این نسخه داده کافی برای توصیف یک الگوی برجسته وجود ندارد.'}</p>
                    <p class="dim">این گزاره شواهد رفتاری مستقل یا هنجاری محسوب نمی‌شود.</p>
                </div>
                <div class="tile">
                    <h4>موضوعات نیازمند بررسی</h4>
                    <p>${less.length ? esc(less.slice(0, 4).join('، ')) : 'به‌طور پیش‌فرض مرزبندی حرفه‌ای و اقدامات حفاظتی در ارزیابی عملی سنجیده شوند.'}</p>
                    <p class="dim">«نیازمند بررسی» به‌معنای ضعف قطعی نیست.</p>
                </div>
            </div>
            <h3>کیفیت پاسخ‌های موقعیتی (سناریوها)</h3>
            <div class="kpis">
                <div class="kpi"><div class="num">${pts[3] || 0}</div><small>پاسخ ترجیحی (۳ امتیاز)</small></div>
                <div class="kpi"><div class="num">${pts[1] || 0}</div><small>پاسخ ناقص (۱ امتیاز)</small></div>
                <div class="kpi"><div class="num">${pts[0] || 0}</div><small>پاسخ بدون امتیاز (۰ امتیاز)</small></div>
            </div>
            <h3>سناریوهایی که بهتر است در مصاحبه باز شوند</h3>
            ${flagsHTML}
            <h3>پرسش‌های پیشنهادی مصاحبه ساختاریافته</h3>
            <table class="table">
                <thead><tr><th>ردیف</th><th>محور</th><th>تکلیف پیشنهادی برای مصاحبه‌گر</th></tr></thead>
                <tbody>${discussionRows}</tbody>
            </table>
            <div class="callout warn">
                <b>وضعیت نهایی پرونده:</b> صرفاً ارزیابی مقدماتی؛ پیشنهاد می‌شود مصاحبه ساختاریافته و شبیه‌سازی عملی اجرا شود. به دلیل نداشتن نقطه برش مطلق، قبولی یا رد قطعی صادر نمی‌شود.
            </div>
            <div class="two-col">
                <div><h4>یادداشت مسئول ارزیاب:</h4><div style="height: 55px; border-bottom: 1px dashed #a9bfc8;"></div></div>
                <div><h4>امضا و تأیید نهایی:</h4><div style="height: 55px; border-bottom: 1px dashed #a9bfc8;"></div></div>
            </div>
        `, 2);

        // Page 3: راهنمای شاخص‌ها ۱
        const p3 = page(head('راهنمای شاخص‌ها | ویژگی‌های فردی (۱)', 3) + `
            <div class="callout">تعریف هر شاخص، برداشت مجاز از نمره و یک پیشنهاد عملی برای بررسی آن ارائه شده است. این صفحات برای همه داوطلبان مشترک‌اند.</div>
            ${defs(examScales.slice(0, 5))}
        `, 3, true);

        // Page 4: راهنمای شاخص‌ها ۲
        const p4 = page(head('راهنمای شاخص‌ها | ویژگی‌های فردی (۲)', 4) + `
            ${defs(examScales.slice(5, 10))}
        `, 4, true);

        // Page 5: راهنمای شایستگی‌های تربیتی
        const p5 = page(head('راهنمای شاخص‌ها | شایستگی‌های تربیتی', 5) + `
            ${defs(examScales.slice(10, 15))}
        `, 5, true);

        // Page 6: راهنمای تفسیر و حدود اعتبار
        const p6 = page(head('راهنمای تفسیر و حدود اعتبار', 6) + `
            <h3>این نمرات دقیقاً چه می‌گویند؟</h3>
            <div class="note-grid">
                <div><h4>سؤالات ۱ تا ۶۵</h4>گزینه‌ها از ۱ تا ۵ ثبت می‌شوند. سؤال‌های معکوس با فرمول «۶ منهای پاسخ» تصحیح می‌شوند. سؤال ۱۰ توصیفی و بدون امتیاز است. میانگین هر خرده‌مقیاس فقط با تکمیل تمام مواد نمره‌دار آن نمایش داده می‌شود.</div>
                <div><h4>سناریوهای ۶۶ تا ۸۰</h4>به هر پاسخ امتیاز ۰، ۱ یا ۳ داده می‌شود. مجموع کامل از ۴۵ محاسبه می‌شود. کلید سناریوها مقدماتی است و باید با پروتکل‌های رسمی ایمنی اردو و نظر متخصصان تطبیق داده شود.</div>
                <div><h4>نمره بالاتر یا پایین‌تر</h4>یک میانگین ۴ صرفاً نشان می‌دهد فرد در آن شاخص گزینه‌های موافق‌تری انتخاب کرده است. این عدد به‌معنای ۸۰ درصد توانایی یا صلاحیت نیست. میانگین‌ها هنجاری نیستند.</div>
                <div><h4>پاسخ ناقص و اعتبار نتایج</h4>پاسخ‌های ناقص به صفر تبدیل نمی‌شوند. هیچ نمره کلی صلاحیت، نقطه برش تأیید/رد یا برچسب شخصیتی و بالینی صادر نمی‌شود.</div>
            </div>
            <h3>مراحل تفسیر مسئولانه</h3>
            <table class="table">
                <thead><tr><th>گام</th><th>اقدام</th></tr></thead>
                <tbody>
                    <tr><td>۱</td><td>کنترل کامل بودن پاسخ‌ها و تطبیق شناسه داوطلب با برگه آزمون.</td></tr>
                    <tr><td>۲</td><td>خواندن ۱۵ خرده‌مقیاس به‌طور جداگانه؛ بدون جمع‌زدن همه در یک شاخص کل.</td></tr>
                    <tr><td>۳</td><td>بررسی سناریوهای دارای امتیاز کمتر از ۳، خصوصاً در حفاظت از نوجوانان.</td></tr>
                    <tr><td>۴</td><td>مقایسه یافته‌ها با مصاحبه ساختاریافته، ارزیابی عملی و مستندات شغلی.</td></tr>
                    <tr><td>۵</td><td>ثبت قضاوت نهایی توسط ارزیاب صلاحیت‌دار بر اساس شواهد چندمنبعی.</td></tr>
                </tbody>
            </table>
            <h3>محدودیت‌های علمی و اخلاقی</h3>
            <div class="callout warn">ابزار حاضر در مرحله آزمایشی است. روایی، پایایی، هنجارها و اعتبار پیش‌بینی عملکرد آن باید همواره همراه با مشاهده میدانی ارزیابی شود. صرف نمره پرسشنامه نه تشخیص سلامت روان است و نه مجوز سپردن مسئولیت ایمنی نوجوانان. نتایج محرمانه است.</div>
            <h3>مشخصات نسخه و نگهداری پرونده</h3>
            <div class="note-grid">
                <div><b>نسخه پرسشنامه:</b> سنجش مربیان اردویی ۱.۰<br><b>ساختار:</b> ۶۵ سؤال خودگزارشی + ۱۵ سناریو<br><b>نمره‌گذاری:</b> طبق کلید مصوب علمی</div>
                <div><b>محرمانگی:</b> پرونده صرفاً در اختیار مراجع ارزیاب قرار گیرد.<br><b>تأیید نهایی:</b> بر عهده ارزیاب و نهاد برگزارکننده</div>
            </div>
        `, 6, true);

        return p1 + p2 + p3 + p4 + p5 + p6;
    },

    // --- Socket Listeners ---
    setupSocketListeners: function() {
        socket.on('candidate_list_update', candidates => {
            this.renderCandidateList(candidates);
        });

        socket.on('unlock_exam', () => {
            let localData = JSON.parse(localStorage.getItem('shahr_candidate') || '{}');
            localData.status = 'exam';
            localStorage.setItem('shahr_candidate', JSON.stringify(localData));
            this.showExamView();
        });

        socket.on('candidate_status_update', data => {
            if (data.status === 'approved') {
                this.showExamView();
            }
        });

        socket.on('force_logout', () => {
            this.logoutCandidate();
        });
    }
};

// Initialize on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
    app.init();
});
