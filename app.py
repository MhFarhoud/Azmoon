import gevent.monkey
gevent.monkey.patch_all()

import os
import json
import uuid
import threading
from datetime import datetime
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room
from flask_cors import CORS
import pandas as pd

def normalize_digits(text):
    if not text: return text
    return str(text).translate(str.maketrans('۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789'))

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY') or uuid.uuid4().hex
STAFF_PASSWORD = os.environ.get('STAFF_PASSWORD')
if not STAFF_PASSWORD:
    raise RuntimeError('Set STAFF_PASSWORD before starting the server')
DATA_DIR = os.path.abspath(os.environ.get('DATA_DIR', os.path.dirname(__file__)))
os.makedirs(DATA_DIR, exist_ok=True)
CANDIDATES_FILE = os.path.join(DATA_DIR, 'پایگاه داده ازمون دهنگاه رمز عبود یوزر نیم و اطلاعات جهت ورود به ازمون و پذیرش.json')
if not os.path.exists(CANDIDATES_FILE):
    with open(CANDIDATES_FILE, 'w', encoding='utf-8') as f:
        json.dump([], f)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# Create records directory
RECORDS_DIR = os.path.join(DATA_DIR, 'records')
os.makedirs(RECORDS_DIR, exist_ok=True)

# --- Data Loading ---
candidates = {}
admin_settings = {'exam_duration_minutes': 35}

def load_data():
    global candidates
    base_dir = os.path.dirname(__file__)
    
    # Load Settings
    try:
        with open(os.path.join(DATA_DIR, 'settings.json'), 'r') as f:
            saved_settings = json.load(f)
            if 'exam_duration_minutes' in saved_settings:
                admin_settings['exam_duration_minutes'] = saved_settings['exam_duration_minutes']
    except Exception:
        pass

    # Load Candidates
    try:
        with open(CANDIDATES_FILE, 'r', encoding='utf-8') as f:
            cands_data = json.load(f)
            for c in cands_data:
                uname = str(c['username']).zfill(10)
                candidates[uname] = {
                    'id': uname,
                    'username': uname,
                    'password': str(c['password']),
                    'first_name': c.get('first_name') or (c.get('name_fa', '').split()[0] if c.get('name_fa') else ''),
                    'last_name': c.get('last_name') or (' '.join(c.get('name_fa', '').split()[1:]) if c.get('name_fa') else ''),
                    'national_id': uname,
                    'phone': str(c.get('phone', '')),
                    'day': c.get('day', ''),
                    'exam_group': c.get('exam_group', ''),
                    'exam_start': c.get('exam_start', ''),
                    'interview_start': c.get('interview_start', ''),
                    'status': 'offline',
                    'credentials_score': 80,  # Default or updateable
                    'experience_score': 80,
                    'certifications_score': 80,
                    'appearance_score': 80,
                    'teaching_spirit_score': 80,
                    'results': None
                }
    except Exception as e:
        print("Error loading candidates:", e)

    # Restore Results from records
    import glob
    if os.path.exists(RECORDS_DIR):
        for item in os.listdir(RECORDS_DIR):
            cand_dir = os.path.join(RECORDS_DIR, item)
            if os.path.isdir(cand_dir):
                parts = item.split('_')
                if not parts: continue
                cand_id = parts[0]
                if cand_id in candidates:
                    results_files = glob.glob(os.path.join(cand_dir, "results_*.json"))
                    if results_files:
                        latest = sorted(results_files)[-1]
                        try:
                            with open(latest, 'r', encoding='utf-8') as f:
                                res = json.load(f)
                                candidates[cand_id]['results'] = res
                                candidates[cand_id]['status'] = 'finished'
                        except Exception as e:
                            print(f"Error loading result for {cand_id}: e")

    # Load Exam Configuration (80 Items, 15 Scales, Descriptions)
    global exam_config, exam_items, exam_scales, exam_desc
    exam_config = {}
    exam_items = []
    exam_scales = []
    exam_desc = {}
    try:
        with open(os.path.join(base_dir, 'exam_config.json'), 'r', encoding='utf-8') as f:
            exam_config = json.load(f)
            exam_items = exam_config.get('items', [])
            exam_scales = exam_config.get('scales', [])
            exam_desc = exam_config.get('desc', {})
    except Exception as e:
        print("Error loading exam_config.json:", e)

    return {"items": exam_items, "scales": exam_scales, "desc": exam_desc}

exam_data = load_data()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/questions', methods=['GET'])
def get_questions():
    return jsonify({
        "items": exam_items,
        "scales": exam_scales,
        "desc": exam_desc,
        "duration": admin_settings['exam_duration_minutes']
    })

@app.route('/api/login', methods=['POST'])
def candidate_login():
    data = request.json
    username = normalize_digits(str(data.get('username')))
    password = normalize_digits(str(data.get('password')))
    device_info = data.get('device_info', '')
    
    cand = candidates.get(username)
    if cand and cand['password'] == password:
        # Check if candidate has already finished the exam
        if cand.get('status') == 'finished' or cand.get('results') is not None:
            return jsonify({
                "success": False,
                "error": "این کد ملی قبلاً در آزمون شرکت کرده و پاسخ‌نامه آن ثبت نهایی شده است. هر داوطلب فقط یک بار مجاز به شرکت در آزمون می‌باشد."
            }), 403
            
        # Save device info on login
        if device_info:
            if 'Windows' in device_info: cand['device_info'] = 'Windows'
            elif 'Macintosh' in device_info: cand['device_info'] = 'Mac'
            elif 'iPhone' in device_info: cand['device_info'] = 'iPhone'
            elif 'Android' in device_info: cand['device_info'] = 'Android'
            elif 'Linux' in device_info: cand['device_info'] = 'Linux'
            else: cand['device_info'] = 'سایر دستگاه‌ها'
        return jsonify({"success": True, "candidate": {"id": cand['id'], "name": cand['first_name'] + ' ' + cand['last_name']}})
    return jsonify({"success": False, "error": "نام کاربری یا رمز عبور اشتباه است."}), 401

@app.route('/api/staff_login', methods=['POST'])
def staff_login():
    data = request.json
    password = normalize_digits(str(data.get('password')))
    if password == STAFF_PASSWORD:
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "رمز عبور اشتباه است."}), 401

@app.route('/api/add_candidate', methods=['POST'])
def add_candidate():
    data = request.json
    fname = data.get('first_name', '').strip()
    lname = data.get('last_name', '').strip()
    nid = normalize_digits(str(data.get('national_id', '')))
    username = nid
    password = normalize_digits(str(data.get('password', '')))
    
    if not fname or not lname or not nid or not password:
        return jsonify({"success": False, "error": "اطلاعات ناقص است."}), 400
        
    if username in candidates:
        return jsonify({"success": False, "error": "این کد ملی قبلا ثبت شده است."}), 400
        
    new_cand = {
        "first_name": fname,
        "last_name": lname,
        "national_id": nid,
        "username": username,
        "password": password,
        "credentials_score": 0,
        "experience_score": 0,
        "certifications_score": 0,
        "id": username,
        "status": "offline",
        "results": None
    }
    candidates[username] = new_cand
    
    # Save to JSON
    try:
        db_path = CANDIDATES_FILE
        import json
        with open(db_path, "r", encoding="utf-8") as f:
            db_data = json.load(f)
        if not any(c.get("username") == username for c in db_data):
            db_data.append({
                "first_name": fname,
                "last_name": lname,
                "national_id": nid,
                "username": username,
                "password": password,
                "credentials_score": 0,
                "experience_score": 0,
                "certifications_score": 0
            })
            with open(db_path, "w", encoding="utf-8") as f:
                json.dump(db_data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print("Error saving to DB:", e)
        
    socketio.emit('candidate_list_update', get_all_candidates())
    return jsonify({"success": True})


@app.route('/api/candidates', methods=['GET'])
def list_candidates():
    # Return minimal data for performance
    return jsonify(get_all_candidates())

def get_all_candidates():
    return list(candidates.values())

@app.route('/api/submit_exam', methods=['POST'])
def submit_exam():
    data = request.json
    cand_id = data.get('candidate_id')
    answers = data.get('answers', {})
    
    if cand_id not in candidates:
        return jsonify({"error": "Candidate not found"}), 404
        
    candidate = candidates[cand_id]
    if candidate.get('status') == 'finished' or candidate.get('results') is not None:
        return jsonify({
            "success": False,
            "error": "آزمون این کد ملی قبلاً ثبت نهایی شده است و امکان ثبت مجدد وجود ندارد."
        }), 400
        
    candidate['status'] = 'finished'
    
    # Calculate Scores based on 80 items and 15 scales
    results = calculate_eval_results(answers)
    candidate['results'] = results
    
    # Run file saving in a separate thread to avoid blocking
    threading.Thread(target=save_candidate_records, args=(candidate, answers, results)).start()
    
    socketio.emit('candidate_list_update', get_all_candidates())
    
    return jsonify({"success": True, "results": results})

def calculate_eval_results(answers):
    by = {}
    self_valid = 0
    sjt_valid = 0
    sjt_total = 0
    pts = {0: 0, 1: 0, 3: 0}
    miss = []
    flags = []
    
    for i in range(80):
        if i >= len(exam_items): break
        q = exam_items[i]
        ans = answers[i] if isinstance(answers, list) else answers.get(str(i), answers.get(i, ''))
        ans_str = str(ans).strip()
        
        if i < 65:
            if ans_str in ['1', '2', '3', '4', '5']:
                self_valid += 1
                n = int(ans_str)
                if not q.get('unscored'):
                    sc = (6 - n) if q.get('reverse') else n
                    by.setdefault(q['scale'], []).append(sc)
            else:
                miss.append(q['n'])
        else:
            opt_labels = ['الف', 'ب', 'پ', 'ت']
            if ans_str in opt_labels:
                idx = opt_labels.index(ans_str)
                sjt_valid += 1
                p = q['points'][idx]
                sjt_total += p
                pts[p] = pts.get(p, 0) + 1
                if p != 3:
                    flags.append({
                        'n': q['n'],
                        'scale': q['scale'],
                        'p': p,
                        'selected': ans_str
                    })
            else:
                miss.append(q['n'])
                
    means = {}
    for s in exam_scales:
        target = len([q for q in exam_items[:65] if q['scale'] == s and not q.get('unscored')])
        scale_scores = by.get(s, [])
        if len(scale_scores) == target:
            means[s] = round(sum(scale_scores) / target, 2)
        else:
            means[s] = None
            
    big = [k for k, v in means.items() if v is not None and v >= 4.1]
    less = [k for k, v in means.items() if v is not None and v <= 3.25]
    big.sort(key=lambda k: means[k], reverse=True)
    less.sort(key=lambda k: means[k])
    
    interview = less[:3] if less else ['قاطعیت و مرزها', 'مسئولیت و حفاظت']
    
    return {
        'means': means,
        'self_valid': self_valid,
        'sjt_valid': sjt_valid,
        'sjt_total': sjt_total,
        'pts': pts,
        'miss': miss,
        'flags': flags,
        'big': big,
        'less': less,
        'interview': interview
    }

def save_candidate_records(candidate, answers, results):
    cand_dir = os.path.join(RECORDS_DIR, f"{candidate['id']}_{candidate['first_name']}_{candidate['last_name']}")
    os.makedirs(cand_dir, exist_ok=True)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    
    # 1. Raw answers JSON
    with open(os.path.join(cand_dir, f"raw_answers_{timestamp}.json"), 'w', encoding='utf-8') as f:
        json.dump(answers, f, ensure_ascii=False, indent=4)
        
    # 2. Results JSON
    with open(os.path.join(cand_dir, f"results_{timestamp}.json"), 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=4)
        
    # 3. Exam Log
    with open(os.path.join(cand_dir, f"exam_log_{timestamp}.txt"), 'w', encoding='utf-8') as f:
        f.write(f"Exam Evaluation Log for Candidate: {candidate['id']} - {candidate['first_name']} {candidate['last_name']}\n")
        f.write(f"Self-report Valid: {results['self_valid']}/65 | SJT Valid: {results['sjt_valid']}/15 | SJT Total: {results['sjt_total']}/45\n\n")
        for i, q in enumerate(exam_items):
            ans = answers[i] if isinstance(answers, list) else answers.get(str(i), answers.get(i, 'بی‌پاسخ'))
            f.write(f"Q{q['n']} [{q['scale']}]: {q['text']}\n  Answer: {ans}\n\n")
            
    # 4. Excel Report
    try:
        data_rows = []
        for s in exam_scales:
            data_rows.append({"مقیاس / شایستگی": s, "میانگین نمره (۱ تا ۵)": results['means'].get(s, "—")})
        data_rows.append({"مقیاس / شایستگی": "مجموع امتیاز موقعیتی (از ۴۵)", "میانگین نمره (۱ تا ۵)": results['sjt_total']})
        data_rows.append({"مقیاس / شایستگی": "پاسخ‌های معتبر خودگزارشی", "میانگین نمره (۱ تا ۵)": f"{results['self_valid']}/65"})
        df = pd.DataFrame(data_rows)
        df.to_excel(os.path.join(cand_dir, f"report_{timestamp}.xlsx"), index=False)
    except Exception as e:
        print("Excel report error:", e)


# --- WebSockets ---

@socketio.on('candidate_join')
def on_candidate_join(data):
    cand_id = data.get('candidate_id')
    if cand_id in candidates:
        join_room(cand_id)
        if candidates[cand_id]['status'] not in ['approved', 'finished']:
            candidates[cand_id]['status'] = 'waiting'
        emit('candidate_status_update', {'status': candidates[cand_id]['status']}, room=cand_id)
        socketio.emit('candidate_list_update', get_all_candidates())

@socketio.on('approve_candidate')
def on_approve_candidate(data):
    cand_id = data.get('candidate_id')
    if cand_id in candidates:
        candidates[cand_id]['status'] = 'approved'
        socketio.emit('unlock_exam', {}, room=cand_id)
        socketio.emit('candidate_list_update', get_all_candidates())

@socketio.on('reset_exam')
def on_reset_exam(data):
    cand_id = data.get('candidate_id')
    if cand_id in candidates:
        candidates[cand_id]['status'] = 'offline'
        candidates[cand_id]['results'] = None
        # Archive results files so restart does not re-mark candidate as finished
        import glob
        cand_pattern = os.path.join(RECORDS_DIR, f"{cand_id}_*")
        for cdir in glob.glob(cand_pattern):
            for rf in glob.glob(os.path.join(cdir, "results_*.json")):
                try:
                    os.rename(rf, rf + ".archived")
                except:
                    pass
        socketio.emit('force_logout', {}, room=cand_id)
        socketio.emit('candidate_list_update', get_all_candidates())

@socketio.on('update_settings')
def on_update_settings(data):
    duration = data.get('duration')
    if duration:
        admin_settings['exam_duration_minutes'] = int(duration)
        try:
            base_dir = os.path.dirname(__file__)
            with open(os.path.join(DATA_DIR, 'settings.json'), 'w') as f:
                json.dump(admin_settings, f)
        except:
            pass
        emit('settings_updated', {'exam_duration_minutes': admin_settings['exam_duration_minutes']}, broadcast=True)

if __name__ == '__main__':
    socketio.run(app, debug=False, host='0.0.0.0', port=int(os.environ.get('PORT', '5001')))
