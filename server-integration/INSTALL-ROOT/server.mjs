import { registerPushDevice, unregisterPushDevice, sendPushToStudents, isPushEnabled } from "./shared/mobile-push.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AUTH_ROLE_LABELS, AUTH_ROLE_SESSION_POLICY, STAFF_ROLES, isAdminRole, canResetPassword } from "./shared/auth-core.mjs";
import { SCHOOL_GRADES as SCHOOL_GRADES_CORE, TEACHING_PERMISSION_DEFAULTS as TEACHING_PERMISSION_DEFAULTS_CORE, normalizeAcademicYears, normalizeEnrollments, assignmentCompositeKey } from "./shared/school-core.mjs";
import { ensureAcademicYearModel, validateAcademicYearConfig, validateCalendarEvent, normalizeCalendarEvent, activeCalendarForDate, calendarAffectsStudent, closeAndCreateEnrollment, enrollmentHistoryForStudent } from "./shared/academic-year-core.mjs";
import { normalizeQuestionCore, validateQuestionCore, questionFingerprintCore } from "./shared/question-bank-core.mjs";
import { normalizeExamCore, validateExamCore } from "./shared/exam-core.mjs";
import { isAutoGradableCore, autoGradeQuestionCore, buildAutoGradingCore, validatePublishedGradeCore } from "./shared/grading-core.mjs";
import { validateSpecialScoresCore } from "./shared/report-card-core.mjs";
import { normalizeAcademicPeriod, periodizedTermKey, combineAnnualSubjectRows } from "./shared/term-period-core.mjs";
import { normalizeTermPolicyCore, continuousAverage20Core, termComponentsCore } from "./shared/term-scoring-core.mjs";
import { studentDailySnapshot09 } from "./shared/stage09-daily-core.mjs";
import { riskScore10 } from "./shared/stage10-risk-core.mjs";
import { workflowHealth11, workflowPhases11 } from "./shared/stage11-workflow-core.mjs";
import { betaReadiness12 } from "./shared/stage12-beta-readiness-core.mjs";

const APP_VERSION = 69;
const APP_RELEASE = "72.35-p21-ADMIN-CLASS-ACTIONS";
const RELEASE_CHANNEL = "Beta 1";
const STUDENT_ANDROID_VERSION = "1.3.0";
const STUDENT_ANDROID_VERSION_CODE = 6;
const STUDENT_ANDROID_MIN_VERSION_CODE = 5;
const STUDENT_ANDROID_APK_URL = String(process.env.MADRESEYAR_STUDENT_APK_URL || "").trim();
const SCHOOL_NAME = "مدرسه دوره اول متوسطه پروین اعتصامی جوانرود";
function normalizeBasePath(value) {
  const clean = String(value || "").trim().replace(/^https?:\/\/[^/]+/i, "").replace(/\/+$/, "");
  if (!clean || clean === "/") return "";
  return clean.startsWith("/") ? clean : `/${clean}`;
}
const APP_BASE_PATH = normalizeBasePath(process.env.APP_BASE_PATH || process.env.PASSENGER_BASE_URI || "");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 48 * 1024 * 1024;
const DATA_DIR = process.env.MADRESEYAR_DATA_DIR ? path.resolve(process.env.MADRESEYAR_DATA_DIR) : path.join(ROOT, "data");
const FILES_DIR = path.join(DATA_DIR, "files");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SECURITY_FILE = path.join(DATA_DIR, "security.json");
const SECURITY_MIRROR_FILE = path.join(DATA_DIR, "security.mirror.json");
const SECURITY_AUDIT_FILE = path.join(DATA_DIR, "security-audit.jsonl");
const LOGIN_ATTEMPTS_FILE = path.join(DATA_DIR, "login-attempts.json");
const BACKUPS_DIR = path.join(DATA_DIR, "backups");
const STATE_PREVIOUS_FILE = path.join(DATA_DIR, "state.previous.json");
const STATE_MIRROR_FILE = path.join(DATA_DIR, "state.mirror.json");
const RECOVERY_LOG_FILE = path.join(DATA_DIR, "recovery-log.jsonl");
const scryptAsync = promisify(crypto.scrypt);


function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function faNow() {
  try { return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date()); }
  catch { return new Date().toISOString(); }
}

// v74 — Online / hybrid school helpers. The conferencing engine is provider-agnostic;
// schools can use any HTTPS classroom provider while Madreseyar owns schedule, identity,
// check-in, attendance, homework, exams and audit data.
const DELIVERY_MODES_V74 = new Set(["inherit", "in_person", "online", "hybrid"]);
function normalizeDeliveryModeV74(value, fallback = "inherit") {
  const mode = String(value || "").trim();
  return DELIVERY_MODES_V74.has(mode) ? mode : fallback;
}
function normalizeWebUrlV74(value, { allowEmpty = true } = {}) {
  const raw = String(value || "").trim();
  if (!raw && allowEmpty) return "";
  if (!raw) throw Object.assign(new Error("آدرس کلاس آنلاین لازم است."), { status: 400 });
  if (raw.length > 2048) throw Object.assign(new Error("آدرس کلاس آنلاین بیش از حد طولانی است."), { status: 400 });
  let u; try { u = new URL(raw); } catch { throw Object.assign(new Error("آدرس کلاس آنلاین معتبر نیست."), { status: 400 }); }
  if (!["http:", "https:"].includes(u.protocol)) throw Object.assign(new Error("آدرس کلاس آنلاین باید با http یا https باشد."), { status: 400 });
  return u.toString();
}
function onlineLearningSettingsV74(db) {
  const raw = db?.school?.onlineLearning || {};
  const op = normalizeDeliveryModeV74(raw.operationMode, "in_person");
  const operationMode = op === "inherit" ? "in_person" : op;
  return {
    enabled: raw.enabled === true || operationMode !== "in_person",
    operationMode,
    defaultProvider: String(raw.defaultProvider || "custom").trim().slice(0, 60) || "custom",
    defaultMeetingUrl: normalizeWebUrlV74(raw.defaultMeetingUrl || ""),
    instructions: String(raw.instructions || "").trim().slice(0, 1500),
    joinWindowMinutes: Math.max(0, Math.min(180, Number(raw.joinWindowMinutes ?? 15) || 0)),
    lateAfterMinutes: Math.max(0, Math.min(180, Number(raw.lateAfterMinutes ?? 10) || 0)),
    teacherCanEditLinks: raw.teacherCanEditLinks !== false,
    requireStudentCheckIn: raw.requireStudentCheckIn !== false
  };
}
function effectiveDeliveryModeV74(db, entry) {
  const settings = onlineLearningSettingsV74(db);
  const local = normalizeDeliveryModeV74(entry?.deliveryMode, "inherit");
  return local === "inherit" ? settings.operationMode : local;
}
function publicOnlineSettingsV74(db) {
  const s = onlineLearningSettingsV74(db);
  return { enabled:s.enabled, operationMode:s.operationMode, defaultProvider:s.defaultProvider, instructions:s.instructions, joinWindowMinutes:s.joinWindowMinutes, lateAfterMinutes:s.lateAfterMinutes, requireStudentCheckIn:s.requireStudentCheckIn };
}

function schoolClockV74(){
  const timeZone=String(process.env.MADRESEYAR_TIMEZONE||"Asia/Tehran");
  let parts;
  try{parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23",weekday:"short"}).formatToParts(new Date()).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));}
  catch{parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"UTC",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23",weekday:"short"}).formatToParts(new Date()).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));}
  const dayMap={Sat:"شنبه",Sun:"یکشنبه",Mon:"دوشنبه",Tue:"سه‌شنبه",Wed:"چهارشنبه",Thu:"پنجشنبه",Fri:"جمعه"};
  return {date:`${parts.year}-${parts.month}-${parts.day}`,dayName:dayMap[parts.weekday]||"",minutes:Number(parts.hour||0)*60+Number(parts.minute||0),timeZone};
}
function hmMinutesV74(value){const m=String(value||"").match(/^(\d{1,2}):(\d{2})$/);if(!m)return null;const h=Number(m[1]),min=Number(m[2]);return h>=0&&h<24&&min>=0&&min<60?h*60+min:null;}
function publicOnlineScheduleEntryV74(db, entry) {
  const settings = onlineLearningSettingsV74(db), effectiveMode = effectiveDeliveryModeV74(db, entry);
  const onlineCapable = settings.enabled && ["online","hybrid"].includes(effectiveMode);
  return {
    ...entry,
    deliveryMode: normalizeDeliveryModeV74(entry?.deliveryMode, "inherit"),
    effectiveMode,
    meetingProvider: String(entry?.meetingProvider || settings.defaultProvider || "custom").slice(0,60),
    meetingUrl: onlineCapable ? normalizeWebUrlV74(entry?.meetingUrl || settings.defaultMeetingUrl || "") : "",
    onlineInstructions: onlineCapable ? String(entry?.onlineInstructions || settings.instructions || "").slice(0,1500) : ""
  };
}



const ROLE_LABELS = AUTH_ROLE_LABELS;
const ROLE_SESSION_POLICY = AUTH_ROLE_SESSION_POLICY;
const CREDENTIAL_PRESET_VERSION = 16;
const DEFAULT_CREDENTIALS = {
  tea1: {
    username: process.env.MADRESEYAR_TEACHER_USERNAME || "admin",
    password: process.env.MADRESEYAR_TEACHER_PASSWORD || "admin",
    mustChangePassword: true
  },
  sys1: {
    username: process.env.MADRESEYAR_SUPERADMIN_USERNAME || "admin405",
    password: process.env.MADRESEYAR_SUPERADMIN_PASSWORD || "admin405",
    mustChangePassword: true
  }
};
const COMMON_PASSWORDS = new Set(["12345678", "123456789", "password", "qwerty123", "11111111", "admin123", "student", "teacher"]);
let securityWriteQueue = Promise.resolve();
let securityOperationQueue = Promise.resolve();
let stateOperationQueue = Promise.resolve();
const loginAttempts = new Map();

const TRUST_PROXY = /^(?:1|true|yes)$/i.test(String(process.env.MADRESEYAR_TRUST_PROXY || ""));
function clientIp(req) {
  const remote = String(req.socket?.remoteAddress || "unknown");
  if (!TRUST_PROXY) return remote;
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || remote;
}
function tokenHash(token) { return crypto.createHash("sha256").update(String(token || "")).digest("hex"); }
function safeEqualText(a, b) {
  const aa = Buffer.from(String(a || "")); const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
async function passwordHash(password, salt = crypto.randomBytes(16).toString("base64url")) {
  const derived = await scryptAsync(String(password), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt}$${Buffer.from(derived).toString("base64url")}`;
}
async function passwordVerify(password, encoded) {
  try {
    const [kind, n, r, p, salt, expected] = String(encoded || "").split("$");
    if (kind !== "scrypt" || !salt || !expected) return false;
    const derived = await scryptAsync(String(password), salt, 64, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return safeEqualText(Buffer.from(derived).toString("base64url"), expected);
  } catch { return false; }
}
function passwordPolicy(password, role) {
  const value = String(password || "");
  const min = role === "student" ? 8 : 12;
  if (value.length < min) return `رمز عبور باید حداقل ${min} نویسه باشد.`;
  if (value.length > 128) return "رمز عبور بیش از حد طولانی است.";
  if (COMMON_PASSWORDS.has(value.toLowerCase()) || /^\d+$/.test(value) || /(.)\1{5,}/.test(value)) return "این رمز عبور بسیار ساده و قابل حدس است.";
  if (role !== "student" && !(/[A-Za-z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value))) return "رمز کارکنان باید شامل حرف، عدد و نشانه باشد.";
  return "";
}
function initialStaffPasswordPolicy(password) {
  const value = String(password || "");
  if (value.length < 8) return "رمز اولیه باید حداقل ۸ نویسه باشد.";
  if (value.length > 64) return "رمز اولیه بیش از حد طولانی است.";
  if (!/\p{L}/u.test(value) || !/\p{N}/u.test(value)) return "رمز اولیه باید دست‌کم یک حرف و یک عدد داشته باشد.";
  if (COMMON_PASSWORDS.has(value.toLowerCase()) || /^\p{N}+$/u.test(value) || /(.)\1{5,}/u.test(value)) return "این رمز اولیه بسیار ساده و قابل حدس است.";
  return "";
}

function guardianPasswordPolicy(password) {
  const value = String(password || "");
  if (value.length < 8) return "رمز ولی باید حداقل ۸ نویسه باشد.";
  if (value.length > 128) return "رمز ولی بیش از حد طولانی است.";
  if (!/\p{L}/u.test(value) || !/\p{N}/u.test(value)) return "رمز ولی باید دست‌کم یک حرف و یک عدد داشته باشد.";
  if (COMMON_PASSWORDS.has(value.toLowerCase()) || /^\p{N}+$/u.test(value) || /(.)\1{5,}/u.test(value)) return "این رمز بسیار ساده و قابل حدس است.";
  return "";
}

function validSecurityShape(security) {
  return Boolean(security && typeof security === "object" && security.serverSecret && typeof security.credentials === "object" && typeof security.guardianCredentials === "object");
}
async function recoverCorruptSecurity() {
  let mirror=null;
  try { const candidate=JSON.parse(await fs.readFile(SECURITY_MIRROR_FILE,"utf8")); if(validSecurityShape(candidate))mirror=candidate; } catch {}
  if(!mirror){
    await appendRecoveryLog({type:"security_recovery_failed",reason:"no_valid_mirror"});
    const error=new Error("فایل امنیتی سامانه آسیب دیده و نسخه mirror سالمی وجود ندارد؛ برای جلوگیری از بازنشانی رمزها سرویس متوقف شد.");error.code="SECURITY_RECOVERY_UNAVAILABLE";throw error;
  }
  const stamp=new Date().toISOString().replace(/[:.]/g,"-");const quarantine=path.join(DATA_DIR,`security.corrupt-${stamp}-${crypto.randomBytes(3).toString("hex")}.json`);
  try{await fs.rename(SECURITY_FILE,quarantine);}catch{}
  await atomicWriteText(SECURITY_FILE,JSON.stringify(mirror),0o600);
  await appendRecoveryLog({type:"security_auto_recovered",source:"security.mirror",quarantine:path.basename(quarantine)});
  return mirror;
}
async function readSecurity() {
  try {
    return JSON.parse(await fs.readFile(SECURITY_FILE, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 2, credentialPresetVersion: 0, serverSecret: crypto.randomBytes(32).toString("base64url"), credentials: {}, guardianCredentials: {}, sessions: {}, examGrants: {}, createdAt: new Date().toISOString() };
    return recoverCorruptSecurity();
  }
}
async function writeSecurity(security) {
  securityWriteQueue = securityWriteQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    try { await fs.chmod(DATA_DIR, 0o700); } catch {}
    if(!validSecurityShape(security))throw new Error("ساختار فایل امنیتی معتبر نیست.");
    const serialized=JSON.stringify(security);
    await atomicWriteText(SECURITY_FILE,serialized,0o600);
    // Mirror is written only after the primary commit; it therefore never intentionally rolls credentials backward.
    await atomicWriteText(SECURITY_MIRROR_FILE,serialized,0o600);
  });
  await securityWriteQueue;
  return security;
}
function enqueueSecurityOperation(operation) {
  const task = securityOperationQueue.then(operation, operation);
  securityOperationQueue = task.then(() => undefined, () => undefined);
  return task;
}
async function mutateSecurity(operation) {
  return enqueueSecurityOperation(async () => {
    const security = await readSecurity();
    security.credentials ||= {};
    security.guardianCredentials ||= {};
    security.sessions ||= {};
    security.examGrants ||= {};
    const result = await operation(security);
    await writeSecurity(security);
    return { security, result };
  });
}
let securityAuditWritesSinceTrim = 0;
async function trimJsonlFile(filePath, maxRows = 20000) {
  try {
    const text=await fs.readFile(filePath,"utf8"), lines=text.trim().split(/\r?\n/).filter(Boolean);
    if(lines.length>maxRows) await atomicWriteText(filePath,`${lines.slice(-maxRows).join("\n")}\n`,0o600);
  } catch(error){ if(error?.code!=="ENOENT") console.warn("Audit retention trim failed:",error.message); }
}
async function readJsonlTail(filePath, limit=500) {
  try {
    const wanted=Math.max(1,Math.min(Number(limit)||500,2000)),handle=await fs.open(filePath,"r");
    try{
      const stat=await handle.stat(),bytes=Math.min(stat.size,Math.max(256*1024,wanted*1400)),buffer=Buffer.alloc(bytes);
      await handle.read(buffer,0,bytes,Math.max(0,stat.size-bytes));
      return buffer.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-wanted).reverse().map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
    }finally{await handle.close();}
  }catch{return [];}
}
async function securityAudit(event) {
  const clean={id:makeId("sec"),at:new Date().toISOString(),type:String(event.type||"event"),userId:event.userId||null,role:event.role||null,ip:event.ip||null,success:event.success!==false,details:String(event.details||"").slice(0,500)};
  await fs.mkdir(DATA_DIR,{recursive:true,mode:0o700});try{await fs.chmod(DATA_DIR,0o700);}catch{}
  await fs.appendFile(SECURITY_AUDIT_FILE,`${JSON.stringify(clean)}\n`,{encoding:"utf8",mode:0o600});try{await fs.chmod(SECURITY_AUDIT_FILE,0o600);}catch{}
  if(++securityAuditWritesSinceTrim>=100){securityAuditWritesSinceTrim=0;await trimJsonlFile(SECURITY_AUDIT_FILE,20000);}
  return clean;
}
async function readSecurityAudit(limit=500){return readJsonlTail(SECURITY_AUDIT_FILE,limit);}
async function ensureSecurityInitializedUnlocked(db) {
  const security = await readSecurity();
  security.version = 2;
  security.credentials ||= {};
  security.guardianCredentials ||= {};
  security.sessions ||= {};
  security.examGrants ||= {};
  let changed = false;
  const applyPreset = Number(security.credentialPresetVersion || 0) < CREDENTIAL_PRESET_VERSION;

  // v194: bulk enrollment used to hash every new user's bootstrap credential serially.
  // Pre-compute missing hashes concurrently; credential semantics and hash strength stay unchanged.
  const missingCredentialUsersV194 = (db.users || []).filter(user => !security.credentials[user.id]);
  if (missingCredentialUsersV194.length) {
    const preparedCredentialsV194 = await Promise.all(missingCredentialUsersV194.map(async user => {
      const preset = DEFAULT_CREDENTIALS[user.id];
      const fallback = {
        username: user.studentCode || user.nationalId || user.id,
        password: `Msy#${String(user.id).slice(-4)}1405`,
        mustChangePassword: true
      };
      const source = preset || fallback;
      return [user.id, {
        username: String(user.username || source.username).toLowerCase(),
        passwordHash: await passwordHash(source.password),
        mustChangePassword: Boolean(source.mustChangePassword),
        failedLoginCount: 0,
        lockedUntil: 0,
        passwordChangedAt: null,
        credentialVersion: 1
      }];
    }));
    for (const [userId, credential] of preparedCredentialsV194) security.credentials[userId] = credential;
    changed = true;
  }

  for (const user of db.users || []) {
    const preset = DEFAULT_CREDENTIALS[user.id];
    const credential = security.credentials[user.id];
    if (process.env.NODE_ENV === "production" && user.role !== "student" && !credential.passwordChangedAt && !credential.mustChangePassword) {
      credential.mustChangePassword = true;
      changed = true;
    }
    // 72.11: preset-version upgrades must NEVER overwrite an existing credential.
    // Presets are used only when a credential is first created in missingCredentialUsersV194 above.
    if (user.role !== "student" && user.username) {
      const explicitUsername = String(user.username).trim().toLowerCase();
      if (explicitUsername && credential.username !== explicitUsername) {
        credential.username = explicitUsername;
        changed = true;
      }
    }
    const allowedCredentialKeys = new Set(["username", "passwordHash", "mustChangePassword", "failedLoginCount", "lockedUntil", "passwordChangedAt", "credentialVersion", "lastLoginAt", "lastLoginIp", "lastLoginUserAgent"]);
    for (const key of Object.keys(credential)) {
      if (!allowedCredentialKeys.has(key)) { delete credential[key]; changed = true; }
    }
    if (user.role === "student") {
      const nationalUsername = normalizeNationalId(user.nationalId);
      if (!credential.passwordChangedAt && credential.mustChangePassword !== true) { credential.mustChangePassword = true; changed = true; }
      if (nationalUsername && credential.username !== nationalUsername) { credential.username = nationalUsername; changed = true; }
    }
  }

  const allowedSecurityKeys = new Set(["version", "credentialPresetVersion", "serverSecret", "credentials", "guardianCredentials", "sessions", "examGrants", "createdAt"]);
  for (const key of Object.keys(security)) {
    if (!allowedSecurityKeys.has(key)) { delete security[key]; changed = true; }
  }
  if (applyPreset) {
    // Record the schema/preset generation only. Do not rotate passwords or invalidate
    // healthy staff sessions just because the application version was upgraded.
    security.credentialPresetVersion = CREDENTIAL_PRESET_VERSION;
    changed = true;
  }
  const validIds = new Set((db.users || []).map(u => u.id));
  for (const userId of Object.keys(security.credentials)) if (!validIds.has(userId)) { delete security.credentials[userId]; changed = true; }
  const validGuardianIds = new Set((db.guardians || []).filter(g=>g.active!==false).map(g=>g.id));
  for (const guardianId of Object.keys(security.guardianCredentials || {})) if (!validGuardianIds.has(guardianId)) { delete security.guardianCredentials[guardianId]; changed = true; }
  const now = Date.now();
  for (const [hash, session] of Object.entries(security.sessions)) if (!session || session.expiresAt < now || session.idleExpiresAt < now || !validIds.has(session.userId)) { delete security.sessions[hash]; changed = true; }
  for (const [id, grant] of Object.entries(security.examGrants)) if (!grant || grant.expiresAt < now || grant.used) { delete security.examGrants[id]; changed = true; }
  if (changed) await writeSecurity(security);
  return security;
}
async function ensureSecurityInitialized(db) {
  return enqueueSecurityOperation(() => ensureSecurityInitializedUnlocked(db));
}
function normalizeIdentifier(value) { return String(value || "").trim().toLowerCase().replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))); }
function normalizeBirthValue(value) { return normalizeNationalId(value).slice(0, 8); }
function birthValueMatches(storedValue, enteredValue) {
  const stored = normalizeBirthValue(storedValue); const entered = normalizeBirthValue(enteredValue);
  if (!/^\d{8}$/.test(stored) || !/^\d{8}$/.test(entered)) return false;
  return safeEqualText(stored, entered);
}
function normalizeStoredBirthDate(value) {
  const digits = normalizeBirthValue(value);
  if (/^\d{4}$/.test(digits)) return digits;
  if (!/^\d{8}$/.test(digits)) return "";
  const year = Number(digits.slice(0, 4)); const month = Number(digits.slice(4, 6)); const day = Number(digits.slice(6, 8));
  if (year < 1300 || year > 1500 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${digits.slice(0, 4)}/${digits.slice(4, 6)}/${digits.slice(6, 8)}`;
}
function findUserByIdentifier(db, security, identifier, roleKind) {
  const id = normalizeIdentifier(identifier); const digits = normalizeNationalId(id);
  return (db.users || []).find(user => {
    if (!user.active) return false;
    if (roleKind === "student" && user.role !== "student") return false;
    if (roleKind === "staff" && user.role === "student") return false;
    const cred = security.credentials?.[user.id];
    return String(cred?.username || "").toLowerCase() === id || normalizeNationalId(user.nationalId) === digits || (user.role === "student" && normalizeNationalId(user.studentCode) === digits);
  });
}
function loginRateKey(req, identifier) { return `${clientIp(req)}|${normalizeIdentifier(identifier)}`; }
let loginAttemptsLoaded = false;
let loginAttemptsWriteQueue = Promise.resolve();
const LOGIN_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_ATTEMPT_MAX_KEYS = 5000;
async function loadLoginAttempts() {
  if (loginAttemptsLoaded) return;
  loginAttemptsLoaded = true;
  try {
    const raw = JSON.parse(await fs.readFile(LOGIN_ATTEMPTS_FILE, "utf8"));
    const now = Date.now();
    for (const [key, row] of Object.entries(raw?.attempts || {})) {
      if (!row || now - Number(row.lastAt || 0) > LOGIN_ATTEMPT_TTL_MS) continue;
      loginAttempts.set(key, { count:Number(row.count||0), blockedUntil:Number(row.blockedUntil||0), lastAt:Number(row.lastAt||0) });
    }
  } catch (error) { if (error?.code !== "ENOENT") console.warn("Login-attempt store could not be read:", error.message); }
}
function pruneLoginAttempts(now = Date.now()) {
  for (const [key, row] of loginAttempts) if (!row || now - Number(row.lastAt || 0) > LOGIN_ATTEMPT_TTL_MS) loginAttempts.delete(key);
  if (loginAttempts.size <= LOGIN_ATTEMPT_MAX_KEYS) return;
  const oldest = [...loginAttempts.entries()].sort((a,b)=>Number(a[1]?.lastAt||0)-Number(b[1]?.lastAt||0));
  for (let i=0;i<oldest.length-LOGIN_ATTEMPT_MAX_KEYS;i++) loginAttempts.delete(oldest[i][0]);
}
async function persistLoginAttempts() {
  pruneLoginAttempts();
  const payload = { version:1, updatedAt:new Date().toISOString(), attempts:Object.fromEntries(loginAttempts) };
  loginAttemptsWriteQueue = loginAttemptsWriteQueue.then(async()=>{
    await fs.mkdir(DATA_DIR,{recursive:true,mode:0o700});
    await atomicWriteText(LOGIN_ATTEMPTS_FILE, JSON.stringify(payload), 0o600);
  });
  await loginAttemptsWriteQueue;
}
async function loginRateStatus(req, identifier) {
  await loadLoginAttempts();
  const key = loginRateKey(req, identifier), row = loginAttempts.get(key), now = Date.now();
  if (!row) return { key, blocked:false };
  if (row.blockedUntil > now) return { key, blocked:true, retryAfter:Math.ceil((row.blockedUntil-now)/1000) };
  if (now-row.lastAt > 30*60*1000) { loginAttempts.delete(key); await persistLoginAttempts(); }
  return { key, blocked:false };
}
async function recordLoginFailure(key) {
  await loadLoginAttempts();
  const now=Date.now(), row=loginAttempts.get(key)||{count:0,blockedUntil:0,lastAt:now};
  row.count+=1; row.lastAt=now;
  if(row.count>=5) row.blockedUntil=now+Math.min(60*60*1000,5*60*1000*2**Math.floor((row.count-5)/2));
  loginAttempts.set(key,row); pruneLoginAttempts(now); await persistLoginAttempts(); return row;
}
async function recordLoginSuccess(key) { await loadLoginAttempts(); if(loginAttempts.delete(key)) await persistLoginAttempts(); }
function publicAuthUser(user, security) {
  const cred = security.credentials?.[user.id] || {};
  return { id: user.id, role: user.role, firstName: user.firstName, lastName: user.lastName, username: cred.username || "", classId: user.classId || null, classIds: user.classIds || [], subjects: user.subjects || [], mustChangePassword: Boolean(cred.mustChangePassword), lastLoginAt: cred.lastLoginAt || "" };
}
async function issueSession(user, req, _security = null) {
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = tokenHash(token);
  const now = Date.now();
  const policy = ROLE_SESSION_POLICY[user.role] || ROLE_SESSION_POLICY.teacher;
  await mutateSecurity(security => {
    security.sessions[hash] = { userId: user.id, role: user.role, createdAt: now, lastSeenAt: now, expiresAt: now + policy.absoluteMs, idleExpiresAt: now + policy.idleMs, ip: clientIp(req), userAgent: String(req.headers["user-agent"] || "").slice(0, 250) };
  });
  return token;
}
function requestAuthToken(req) {
  const header = String(req.headers.authorization || "");
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  // Android virtual-host compatibility: Content-Language is a CORS-safelisted
  // request header, so the WebView can authenticate without an OPTIONS preflight.
  const compat = String(req.headers["content-language"] || "");
  if (compat.startsWith("msy-")) return compat.slice(4).trim();
  return "";
}
async function authenticate(req, allowedRoles = null, options = {}) {
  const token = requestAuthToken(req);
  if (!token) throw Object.assign(new Error("برای ادامه دوباره وارد سامانه شوید."), { status: 401 });
  const envelope = await ensureStateInitialized();
  await ensureSecurityInitialized(envelope.db);
  const hash = tokenHash(token); const now = Date.now();
  const updated = await mutateSecurity(security => {
    const session = security.sessions[hash];
    if (!session || session.expiresAt < now || session.idleExpiresAt < now) {
      if (session) delete security.sessions[hash];
      return { error: "expired" };
    }
    const user = (envelope.db.users || []).find(u => u.id === session.userId && u.active);
    if (!user) { delete security.sessions[hash]; return { error: "disabled" }; }
    if (allowedRoles && !allowedRoles.includes(user.role)) return { error: "forbidden", user };
    const cred = security.credentials[user.id] || {};
    if (cred.mustChangePassword && !options.allowPasswordChange) return { error: "password", user, session };
    const policy = ROLE_SESSION_POLICY[user.role] || ROLE_SESSION_POLICY.teacher;
    session.lastSeenAt = now; session.idleExpiresAt = Math.min(session.expiresAt, now + policy.idleMs);
    return { user, session };
  });
  const result = updated.result || {};
  if (result.error === "expired") throw Object.assign(new Error("نشست شما پایان یافته است؛ دوباره وارد شوید."), { status: 401 });
  if (result.error === "disabled") throw Object.assign(new Error("حساب کاربری فعال نیست."), { status: 403 });
  if (result.error === "forbidden") throw Object.assign(new Error("برای این عملیات دسترسی کافی ندارید."), { status: 403 });
  if (result.error === "password") throw Object.assign(new Error("پیش از ادامه باید رمز اولیه را تغییر دهید."), { status: 428, code: "PASSWORD_CHANGE_REQUIRED" });
  return { token, tokenHash: hash, user: result.user, session: result.session, security: updated.security, db: envelope.db };
}
async function revokeUserSessions(userId, exceptHash = "") {
  await mutateSecurity(security => {
    for (const [hash, session] of Object.entries(security.sessions || {})) if (session.userId === userId && hash !== exceptHash) delete security.sessions[hash];
  });
}
async function createExamGrant(user, exam, packageVersion, allowedDurationSeconds = 0) {
  const attemptId = makeId("try");
  // v63: مجوز دریافت سؤال از مهلت پاسخ‌دهی جداست. تحویل شبکه‌ای ممکن است پس از پایان آزمون انجام شود.
  const expiresAt = Date.now() + Math.max(72 * 60 * 60 * 1000, Number(exam.duration || 0) * 60 * 1000 + 72 * 60 * 60 * 1000);
  const issuedAt = Date.now();
  const result = await mutateSecurity(security => {
    const payload = `${attemptId}|${user.id}|${exam.id}|${packageVersion}|${expiresAt}`;
    const signature = crypto.createHmac("sha256", security.serverSecret).update(payload).digest("base64url");
    security.examGrants[attemptId] = { userId: user.id, examId: exam.id, packageVersion, expiresAt, signature, used: false, createdAt: issuedAt, issuedWhileRunning: true, allowedDurationSeconds: Math.max(0, Number(allowedDurationSeconds||0)) };
    return signature;
  });
  return { attemptId, packageSignature: result.result, expiresAt };
}
async function validateExamGrantV63(user, exam, body) {
  const attemptId = String(body.attemptId || ""); const signature = String(body.packageSignature || "");
  const result = await mutateSecurity(security => {
    const grant = security.examGrants?.[attemptId];
    if (!grant || grant.used || grant.expiresAt < Date.now() || grant.userId !== user.id || grant.examId !== exam.id || grant.packageVersion !== examPackageVersion(exam) || !safeEqualText(grant.signature, signature)) return null;
    return { ...grant };
  });
  if (!result.result) throw Object.assign(new Error("مجوز آزمون معتبر نیست؛ سؤال‌ها را دوباره دانلود کنید."), { status: 409 });
  const grant=result.result;
  const durationSeconds=Math.max(0,Number(body.durationSeconds||0));
  const allowedSeconds=Math.max(60,Number(grant.allowedDurationSeconds||0)||Number(exam.duration||0)*60)+90;
  if(durationSeconds>allowedSeconds) throw Object.assign(new Error("مدت پاسخ‌دهی ثبت‌شده از زمان مجاز آزمون بیشتر است."),{status:409,code:"EXAM_DURATION_EXCEEDED"});
  return grant;
}
async function markExamGrantUsedV63(attemptId, submissionKey="") {
  if(!attemptId)return;
  await mutateSecurity(security=>{const grant=security.examGrants?.[String(attemptId)];if(grant&&!grant.used){grant.used=true;grant.usedAt=Date.now();grant.submissionKey=String(submissionKey||"");}});
}
// سازگاری برای مسیرهای قدیمی خارج از موتور آزمون.
async function validateExamGrant(user, exam, body) {
  const grant=await validateExamGrantV63(user,exam,body);await markExamGrantUsedV63(body.attemptId,body.submissionKey||"");return grant;
}
function submissionKeyV63(body){return String(body?.submissionKey||"").trim().slice(0,160);}
function existingExamSubmissionV63(db, exam, student, key){
  if(!key)return null;
  const attempt=(db.attempts||[]).find(x=>x.examId===exam.id&&x.studentId===student.id&&x.submissionKey===key);
  if(attempt)return {kind:"mcq",record:attempt};
  const submission=(db.submissions||[]).find(x=>x.examId===exam.id&&x.studentId===student.id&&x.submissionKey===key);
  return submission?{kind:exam.type,record:submission}:null;
}
function duplicateReceiptV63(existing, exam, db){
  if(!existing)return null;const r=existing.record;
  if(existing.kind==="mcq")return {ok:true,idempotent:true,receiptId:r.id,submittedAt:r.submittedAt,gradingStatus:"final",result:{status:"final",score:Number(r.score||0),total:Number(r.total||examTotalScore(exam)),percent:Number(r.percent||0),correctCount:Number(r.correctCount||0),answeredCount:Number(r.answeredCount||0),questionCount:Number(r.questionCount||(exam.questions||[]).length)}};
  const grade=(db.grades||[]).find(g=>g.submissionId===r.id);
  return {ok:true,idempotent:true,receiptId:r.id,submittedAt:r.submittedAt,gradingStatus:grade?"final":(exam.type==="mixed"?"pending_manual":"awaiting_package_export"),sheetCode:r.sheetCode||"",result:grade?{status:"final",score:Number(grade.finalScore||0),total:examTotalScore(exam)}:{status:"pending",score:null,total:examTotalScore(exam)}};
}

// v64 — diagnostic metadata for offline/retry delivery. No answer content is duplicated.
function deliveryDiagnosticsV64(body,exam){
  const d=body?.deliveryDiagnostics&&typeof body.deliveryDiagnostics==="object"?body.deliveryDiagnostics:{};
  return {clientQueuedAt:Number(d.clientQueuedAt||0),clientFinalizedAt:Number(d.clientFinalizedAt||body?.finalizedAt||0),clientRetryCount:Math.max(0,Number(d.clientRetryCount||0)),clientLastTriedAt:Number(d.clientLastTriedAt||0),serverFirstReceivedAt:Date.now(),serverDuplicateCount:0,serverLastDuplicateAt:0,deliveryMode:examScheduleStateV6111(exam)==="running"?"live":"offline_late"};
}
async function noteDuplicateDeliveryV64(examId,studentId,key){
  if(!key)return;
  await mutateDb(async mutable=>{const record=(mutable.attempts||[]).find(x=>x.examId===examId&&x.studentId===studentId&&x.submissionKey===key)||(mutable.submissions||[]).find(x=>x.examId===examId&&x.studentId===studentId&&x.submissionKey===key);if(record){record.deliveryDiagnostics ||= {};record.deliveryDiagnostics.serverDuplicateCount=Number(record.deliveryDiagnostics.serverDuplicateCount||0)+1;record.deliveryDiagnostics.serverLastDuplicateAt=Date.now();}return true;});
}

// v65 — controlled recovery for sealed offline submissions.
function deliveryRecoveryRowsV65(db){ return Array.isArray(db.examDeliveryRecoveryRequests)?db.examDeliveryRecoveryRequests:[]; }
function recoveryRequestV65(db,student,exam,key,requestId=""){
  const now=Date.now();
  return deliveryRecoveryRowsV65(db).find(r=>r.studentId===student.id&&r.examId===exam.id&&r.submissionKey===key&&(!requestId||r.id===requestId)&&r.status==="approved"&&Number(r.expiresAt||0)>now&&!r.consumedAt)||null;
}
function recoveryCanRetryV65(request,exam,body){
  if(!request)return false;
  const pv=String(body?.packageVersion||"");
  if(!pv||pv!==String(request.packageVersion||"")||pv!==String(examPackageVersion(exam)))return false;
  if(Number(request.clientFinalizedAt||0)&&Number(body?.finalizedAt||0)!==Number(request.clientFinalizedAt||0))return false;
  return true;
}
async function validateExamGrantOrRecoveryV65(user,exam,body,dbSnapshot){
  try{return {mode:"grant",grant:await validateExamGrantV63(user,exam,body),request:null};}
  catch(error){
    const key=submissionKeyV63(body),request=recoveryRequestV65(dbSnapshot||((await ensureStateInitialized()).db),user,exam,key,String(body?.recoveryRequestId||""));
    if(!recoveryCanRetryV65(request,exam,body))throw error;
    const durationSeconds=Math.max(0,Number(body.durationSeconds||0)),allowedSeconds=Math.max(60,Number(exam.duration||0)*60)+90;
    if(durationSeconds>allowedSeconds)throw Object.assign(new Error("مدت پاسخ‌دهی ثبت‌شده از زمان مجاز آزمون بیشتر است."),{status:409,code:"EXAM_DURATION_EXCEEDED"});
    return {mode:"recovery",grant:null,request};
  }
}
async function consumeRecoveryV65(requestId,submissionKey){
  if(!requestId)return;
  await mutateDb(async mutable=>{const r=deliveryRecoveryRowsV65(mutable).find(x=>x.id===requestId&&x.status==="approved"&&!x.consumedAt&&x.submissionKey===submissionKey);if(r){r.consumedAt=Date.now();r.status="consumed";}return true;});
}


// v66 — technical incident reporting and controlled fairness windows.
const V66_INCIDENT_TYPES=new Set(["network_disconnect","app_restart","package_error","submission_error","other"]);
function examIncidentRowsV66(db){return Array.isArray(db.examIncidents)?db.examIncidents:[];}
function fairnessRowsV66(db){return Array.isArray(db.examFairnessAdjustments)?db.examFairnessAdjustments:[];}
function activeFairnessV66(db,studentId,examId,now=Date.now()){
  return fairnessRowsV66(db).filter(x=>x.studentId===studentId&&x.examId===examId&&x.status==="active"&&Number(x.expiresAt||0)>now).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0))[0]||null;
}
function examAvailabilityForStudentV66(db,exam,student,now=Date.now()){
  const base=examAvailabilityV62(exam,now),adj=activeFairnessV66(db,student?.id,exam?.id,now);
  if(!adj)return {...base,fairnessAdjustment:null};
  const state=studentExamStatus(db,exam,student.id)==="submitted"?"ended":"running";
  return {...base,availabilityState:state,canStart:state==="running",endAt:new Date(Number(adj.expiresAt)).toISOString(),fairnessAdjustment:{id:adj.id,minutes:Number(adj.minutes||0),expiresAt:Number(adj.expiresAt),reason:adj.reason||"",incidentId:adj.incidentId||""}};
}


const SCHOOL_GRADES = SCHOOL_GRADES_CORE;
function gradeMeta(grade) { return SCHOOL_GRADES.find(g => g.grade === Number(grade)) || SCHOOL_GRADES[0]; }
const SCIENCE_CHAPTER_NAMES_BY_GRADE = {"7": ["تفکر و تجربه", "اندازه‌گیری در علوم و ابزارهای آن", "اتم‌ها، الفبای مواد", "مواد پیرامون ما", "از معدن تا خانه", "سفر آب روی زمین", "سفر آب درون زمین", "انرژی و تبدیل‌های آن", "منابع انرژی", "گرما و بهینه‌سازی مصرف انرژی", "یاخته و سازمان‌بندی آن", "سفره سلامت", "سفر غذا", "گردش مواد", "تبادل با محیط"], "8": ["مخلوط و جداسازی مواد", "تغییرهای شیمیایی در خدمت زندگی", "از درون اتم چه خبر", "تنظیم عصبی", "حس و حرکت", "تنظیم هورمونی", "الفبای زیست فناوری", "تولید مثل در جانداران", "الکتریسیته", "مغناطیس", "کانی‌ها", "سنگ‌ها", "هوازدگی", "نور و ویژگی‌های آن", "شکست نور"], "9": ["مواد و نقش آنها در زندگی", "رفتار اتم‌ها با یکدیگر", "به دنبال محیطی بهتر برای زندگی", "حرکت چیست", "نیرو", "زمین‌ساخت ورقه‌ای", "آثاری از گذشته زمین", "فشار و آثار آن", "ماشین‌ها", "نگاهی به فضا", "گوناگونی جانداران", "دنیای گیاهان", "جانوران بی‌مهره", "جانوران مهره‌دار", "با هم زیستن"]};
function ensureScienceChaptersServer(grade, existing = []) {
  const names = SCIENCE_CHAPTER_NAMES_BY_GRADE[Number(grade)] || [];
  const rows = Array.isArray(existing) ? existing : [];
  const prefix = Number(grade) === 7 ? "science" : `science${Number(grade)}`;
  const used = new Set();
  const standard = names.map((name, index) => {
    const order = index + 1;
    const priorIndex = rows.findIndex((c, i) => !used.has(i) && (Number(c?.order) === order || String(c?.id || "") === `${prefix}_${order}`));
    const prior = priorIndex >= 0 ? rows[priorIndex] : null;
    if (priorIndex >= 0) used.add(priorIndex);
    return {
      id: prior?.id || `${prefix}_${order}`,
      title: prior?.title || `فصل ${order}`,
      name: prior?.name || name,
      displayTitle: prior?.displayTitle || `فصل ${order} — ${name}`,
      order,
      topics: Array.isArray(prior?.topics) ? prior.topics : [],
      objectives: Array.isArray(prior?.objectives) ? prior.objectives : [],
      active: prior?.active !== false,
      ...(prior || {})
    };
  });
  return [...standard, ...rows.filter((_, i) => !used.has(i) && Number(rows[i]?.order || 0) > names.length)];
}
function scienceCurriculumNeedsUpgradeServer(curriculum) {
  return [7,8,9].some(grade => {
    const book = (curriculum || []).find(b => Number(b.grade) === grade && b.subject === "علوم تجربی");
    return !book || !Array.isArray(book.chapters) || book.chapters.length < 15 || book.chapters.some((c,i)=>!c?.name || Number(c?.order||0)!==i+1);
  });
}
function ensureMultiGradeCurriculumServer(curriculum) {
  const rows = Array.isArray(curriculum) ? curriculum.map(book => {
    const inferred = Number(book.grade || (/9(?:\D|$)/.test(String(book.id||"")) ? 9 : /8(?:\D|$)/.test(String(book.id||"")) ? 8 : 7));
    const meta = gradeMeta(inferred);
    return { ...book, grade: meta.grade, gradeId: meta.id, gradeName: meta.name };
  }) : [];
  const grade7 = rows.filter(b => Number(b.grade) === 7);
  for (const grade of [8,9]) {
    const meta = gradeMeta(grade);
    for (const source of grade7) {
      if (rows.some(b => Number(b.grade) === grade && b.subject === source.subject)) continue;
      const baseId = String(source.id || `book_${source.subject}`).replace(/7$/, "").replace(/[^A-Za-z0-9_\-]/g, "_");
      rows.push({ id: `${baseId}${grade}`, subject: source.subject, title: `${source.subject} ${meta.name} (${meta.commonName})`, edition: source.edition || "", grade, gradeId: meta.id, gradeName: meta.name, active: true, chapters: [] });
    }
  }
  for (const grade of [7,8,9]) {
    const science = rows.find(b => Number(b.grade) === grade && b.subject === "علوم تجربی");
    if (science) {
      science.chapters = ensureScienceChaptersServer(grade, science.chapters);
      science.officialBookCode = String({7:706,8:806,9:906}[grade]);
    }
  }
  return rows;
}

function serverChapterList(prefix, count, label = "فصل") {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}_${i + 1}`, title: `${label} ${i + 1}`, order: i + 1, topics: [], objectives: [], active: true }));
}
function serverDefaultCurriculum() {
  return ensureMultiGradeCurriculumServer([
    { id: "book_science7", subject: "علوم تجربی", title: "علوم تجربی پایه اول متوسطه اول (هفتم)", edition: "۱۴۰۵–۱۴۰۶", chapters: serverChapterList("science", 15, "فصل") },
    { id: "book_math7", subject: "ریاضی", title: "ریاضی پایه اول متوسطه اول (هفتم)", edition: "۱۴۰۵–۱۴۰۶", chapters: serverChapterList("math", 9, "فصل") },
    { id: "book_social7", subject: "مطالعات اجتماعی", title: "مطالعات اجتماعی پایه اول متوسطه اول (هفتم)", edition: "۱۴۰۵–۱۴۰۶", chapters: serverChapterList("social", 12, "فصل") },
    { id: "book_persian7", subject: "فارسی", title: "فارسی پایه اول متوسطه اول (هفتم)", edition: "۱۴۰۵–۱۴۰۶", chapters: serverChapterList("persian", 17, "درس") },
    { id: "book_writing7", subject: "نگارش", title: "نگارش پایه اول متوسطه اول (هفتم)", edition: "۱۴۰۵–۱۴۰۶", chapters: serverChapterList("writing", 8, "درس") },
    { id: "book_arabic7", subject: "عربی", title: "عربی پایه اول متوسطه اول (هفتم)", edition: "۱۴۰۵–۱۴۰۶", chapters: serverChapterList("arabic", 10, "درس") },
    { id: "book_english7", subject: "زبان انگلیسی", title: "زبان انگلیسی پایه اول متوسطه اول (هفتم)", edition: "۱۴۰۵–۱۴۰۶", chapters: serverChapterList("english", 8, "درس") },
    { id: "book_quran7", subject: "قرآن", title: "آموزش قرآن پایه اول متوسطه اول (هفتم)", edition: "۱۴۰۵–۱۴۰۶", chapters: serverChapterList("quran", 12, "درس") },
    { id: "book_religion7", subject: "پیام‌های آسمان", title: "پیام‌های آسمان پایه اول متوسطه اول (هفتم)", edition: "۱۴۰۵–۱۴۰۶", chapters: serverChapterList("religion", 12, "درس") },
    { id: "book_tech7", subject: "کار و فناوری", title: "کار و فناوری پایه اول متوسطه اول (هفتم)", edition: "۱۴۰۵–۱۴۰۶", chapters: serverChapterList("tech", 12, "پودمان") },
    { id: "book_thinking7", subject: "تفکر و سبک زندگی", title: "تفکر و سبک زندگی پایه اول متوسطه اول (هفتم)", edition: "۱۴۰۵–۱۴۰۶", chapters: serverChapterList("thinking", 10, "درس") },
    { id: "book_art7", subject: "فرهنگ و هنر", title: "فرهنگ و هنر پایه اول متوسطه اول (هفتم)", edition: "۱۴۰۵–۱۴۰۶", chapters: serverChapterList("art", 8, "بخش") }
  ]);
}
function serverSeedLearningPoints() {
  return [
    { id: "lp_sc_1_1", bookId: "book_science7", chapterId: "science_1", subject: "علوم تجربی", title: "کمیت و اندازه‌گیری", statement: "کمیت ویژگی‌ای است که بتوان آن را با عدد و یکا اندازه‌گیری کرد.", keywords: ["کمیت", "عدد", "یکا"], examples: ["طول", "جرم", "زمان"], sourcePage: "فصل ۱" },
    { id: "lp_sc_1_2", bookId: "book_science7", chapterId: "science_1", subject: "علوم تجربی", title: "یکای طول", statement: "یکای اصلی طول در دستگاه SI متر است.", keywords: ["متر", "طول", "SI"], examples: ["اندازه‌گیری طول میز"], sourcePage: "فصل ۱" },
    { id: "lp_sc_1_3", bookId: "book_science7", chapterId: "science_1", subject: "علوم تجربی", title: "حجم مایع", statement: "برای اندازه‌گیری حجم مایعات از استوانه مدرج استفاده می‌شود.", keywords: ["حجم", "استوانه مدرج"], examples: ["اندازه‌گیری آب"], sourcePage: "فصل ۱" },
    { id: "lp_sc_1_4", bookId: "book_science7", chapterId: "science_1", subject: "علوم تجربی", title: "چگالی", statement: "چگالی از تقسیم جرم ماده بر حجم آن به دست می‌آید.", keywords: ["چگالی", "جرم", "حجم"], examples: ["مقایسه چگالی دو جسم"], sourcePage: "فصل ۱" },
    { id: "lp_so_2_1", bookId: "book_social7", chapterId: "social_2", subject: "مطالعات اجتماعی", title: "حقوق شهروندی", statement: "هر شهروند از حقوقی مانند آموزش، امنیت و برخورداری از قانون عادلانه بهره‌مند است.", keywords: ["حقوق", "شهروند"], examples: ["حق تحصیل"], sourcePage: "فصل ۲" },
    { id: "lp_so_2_2", bookId: "book_social7", chapterId: "social_2", subject: "مطالعات اجتماعی", title: "مسئولیت شهروندی", statement: "شهروندان در کنار حقوق خود مسئولیت‌هایی مانند رعایت قانون و احترام به حقوق دیگران دارند.", keywords: ["مسئولیت", "قانون"], examples: ["رعایت مقررات"], sourcePage: "فصل ۲" }
  ];
}

function serverSeedQuestionBank() {
  const base = [
    { id: "bank_sc_e1", type: "mcq", subject: "علوم تجربی", bookId: "book_science7", chapterId: "science_1", chapter: "فصل 1", difficulty: "easy", status: "approved", text: "کدام گزینه یک کمیت اندازه‌گیری‌پذیر است؟", score: 1, choices: ["زیبایی", "جرم", "مهربانی", "شجاعت"], answer: 1, explanation: "جرم با عدد و یکا اندازه‌گیری می‌شود.", tags: ["کمیت", "اندازه‌گیری"] },
    { id: "bank_sc_e2", type: "mcq", subject: "علوم تجربی", bookId: "book_science7", chapterId: "science_1", chapter: "فصل 1", difficulty: "easy", status: "approved", text: "یکای اصلی طول در دستگاه SI چیست؟", score: 1, choices: ["کیلوگرم", "ثانیه", "متر", "لیتر"], answer: 2, explanation: "متر یکای اصلی طول است.", tags: ["طول", "متر"] },
    { id: "bank_sc_m1", type: "mcq", subject: "علوم تجربی", bookId: "book_science7", chapterId: "science_1", chapter: "فصل 1", difficulty: "medium", status: "approved", text: "دانش‌آموزی می‌خواهد حجم آب داخل ظرف را اندازه بگیرد. کدام ابزار مناسب‌تر است؟", score: 2, choices: ["نیروسنج", "استوانه مدرج", "دماسنج", "خط‌کش"], answer: 1, explanation: "استوانه مدرج برای اندازه‌گیری حجم مایعات است.", tags: ["حجم", "ابزار"] },
    { id: "bank_sc_m2", type: "mcq", subject: "علوم تجربی", bookId: "book_science7", chapterId: "science_1", chapter: "فصل 1", difficulty: "medium", status: "approved", text: "دو جسم حجم یکسان دارند اما جرم جسم اول بیشتر است. کدام نتیجه درست است؟", score: 2, choices: ["چگالی جسم اول بیشتر است", "چگالی دو جسم برابر است", "چگالی جسم دوم بیشتر است", "هیچ نتیجه‌ای نمی‌توان گرفت"], answer: 0, explanation: "در حجم برابر، جرم بیشتر به معنی چگالی بیشتر است.", tags: ["چگالی", "جرم", "حجم"] },
    { id: "bank_sc_a1", type: "descriptive", subject: "علوم تجربی", bookId: "book_science7", chapterId: "science_1", chapter: "فصل 1", difficulty: "advanced", status: "approved", text: "روش اندازه‌گیری چگالی یک جسم جامد نامنظم را مرحله‌به‌مرحله توضیح دهید.", score: 6, referenceAnswer: "جرم با ترازو اندازه‌گیری می‌شود، حجم با جابه‌جایی آب در استوانه مدرج به دست می‌آید و سپس جرم بر حجم تقسیم می‌شود.", rubric: [{ title: "اندازه‌گیری جرم", score: 2 }, { title: "اندازه‌گیری حجم", score: 2 }, { title: "محاسبه چگالی", score: 2 }], explanation: "پاسخ باید هر سه مرحله را پوشش دهد.", tags: ["چگالی", "حل مسئله"] },
    { id: "bank_so_e1", type: "mcq", subject: "مطالعات اجتماعی", bookId: "book_social7", chapterId: "social_2", chapter: "فصل 2", difficulty: "easy", status: "approved", text: "کدام مورد نمونه‌ای از حق شهروندی است؟", score: 1, choices: ["حق آموزش", "بی‌توجهی به قانون", "آسیب به اموال عمومی", "نادیده‌گرفتن حقوق دیگران"], answer: 0, explanation: "آموزش از حقوق شهروندی است.", tags: ["حقوق شهروندی"] },
    { id: "bank_so_m1", type: "mcq", subject: "مطالعات اجتماعی", bookId: "book_social7", chapterId: "social_2", chapter: "فصل 2", difficulty: "medium", status: "approved", text: "اگر افراد جامعه قوانین راهنمایی را رعایت نکنند، مهم‌ترین پیامد چیست؟", score: 2, choices: ["افزایش نظم", "کاهش خطر", "افزایش بی‌نظمی و آسیب", "بهبود حقوق دیگران"], answer: 2, explanation: "قانون برای نظم و حفظ حقوق افراد است.", tags: ["قانون", "مسئولیت"] },
    { id: "bank_so_a1", type: "descriptive", subject: "مطالعات اجتماعی", bookId: "book_social7", chapterId: "social_2", chapter: "فصل 2", difficulty: "advanced", status: "approved", text: "رابطه حقوق و مسئولیت‌های شهروندی را با یک مثال واقعی تحلیل کنید.", score: 6, referenceAnswer: "هر حق با مسئولیتی همراه است؛ مثلاً حق استفاده از فضای عمومی با مسئولیت حفظ آن همراه است.", rubric: [{ title: "بیان رابطه حق و مسئولیت", score: 2 }, { title: "مثال واقعی", score: 2 }, { title: "تحلیل و جمع‌بندی", score: 2 }], explanation: "پاسخ باید رابطه دوطرفه حق و مسئولیت را نشان دهد.", tags: ["تحلیل", "شهروندی"] }
  ];
  return base.map(q => ({ ...q, topic: q.tags?.[0] || "", cognitiveLevel: q.difficulty === "advanced" ? "analyze" : q.difficulty === "medium" ? "apply" : "remember", estimatedSeconds: q.type === "descriptive" ? 300 : 75, learningOutcome: q.explanation || "", sourcePage: q.chapter || "", reviewCycleDays: 180, shared: true, sourceType: "seed", createdBy: "tea1", createdAt: faNow(), updatedAt: faNow(), stats: { usedCount: 0, answerCount: 0, correctCount: 0, appealCount: 0, avgSeconds: 0 } }));
}


// v75 — Gradebook, term locking, homework review and notification center.
const GRADEBOOK_CATEGORY_DEFAULTS_V75 = [
  {id:"exam",title:"آزمون‌های مستمر",weight:60,source:"exam"},
  {id:"homework",title:"تکلیف",weight:15,source:"manual"},
  {id:"oral",title:"پرسش شفاهی",weight:10,source:"manual"},
  {id:"project",title:"پروژه",weight:10,source:"manual"},
  {id:"participation",title:"مشارکت کلاسی",weight:5,source:"manual"}
];
function gradebookKeyV75({classId="",subject="",academicYear="",academicPeriod="semester2"}={}){return `${classId}__${subject}__${academicYear}__${academicPeriod}`;}
function normalizeGradebookConfigV75(raw,{classId="",subject="",academicYear="",academicPeriod="semester2"}={}){
  const base=Array.isArray(raw?.categories)&&raw.categories.length?raw.categories:GRADEBOOK_CATEGORY_DEFAULTS_V75;
  const cats=base.slice(0,12).map((c,i)=>({id:String(c.id||`cat_${i+1}`).replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,40),title:String(c.title||`مولفه ${i+1}`).trim().slice(0,80),weight:Math.max(0,Math.min(100,Number(c.weight)||0)),source:String(c.source)==="exam"?"exam":"manual"})).filter(c=>c.id&&c.title);
  const total=Math.round(cats.reduce((n,c)=>n+c.weight,0)*100)/100;
  if(Math.abs(total-100)>.001)throw Object.assign(new Error("مجموع وزن مولفه‌های دفتر نمره باید دقیقاً ۱۰۰ درصد باشد."),{status:400});
  if(!cats.some(c=>c.source==="exam"))throw Object.assign(new Error("حداقل یک مولفه آزمون در دفتر نمره لازم است."),{status:400});
  const outputMaxScore = raw?.outputMaxScore === undefined || raw?.outputMaxScore === null ? 5 : Number(raw.outputMaxScore);
  if (!Number.isFinite(outputMaxScore) || outputMaxScore <= 0 || outputMaxScore > 20) throw Object.assign(new Error("بارم مستمر باید بیشتر از صفر و حداکثر ۲۰ باشد."),{status:400});
  return {key:gradebookKeyV75({classId,subject,academicYear,academicPeriod}),classId,subject,academicYear,academicPeriod,enabled:raw?.enabled!==false,categories:cats,outputMaxScore};
}
// P67.19 — The saved teacher-selected continuous maximum determines BOTH term maxima.
// Approved student scores never change the permitted final maximum.
function gradebookSharesV6719(db,{classId="",subject="",academicYear="",academicPeriod="semester2"}={}){
  const key=gradebookKeyV75({classId,subject,academicYear,academicPeriod});
  const cfg=(db.gradebookConfigs||[]).find(c=>c.key===key);
  const raw=cfg?Number(cfg.outputMaxScore):5;
  const continuousMax=Number.isFinite(raw)&&raw>0&&raw<=20?Math.round(raw*100)/100:5;
  return {continuousMax,finalMax:Math.round((20-continuousMax)*100)/100};
}
function invalidTermFinalV6719(row,max){
  if(!row||row.active===false)return false;
  if(row.score===null||row.score===undefined||String(row.score).trim()==="")return true;
  const n=Number(row.score);
  return !Number.isFinite(n)||n<0||n>max+0.000001;
}
function termLockV75(db,{classId="",subject="",academicYear="",academicPeriod="semester2"}={}){
  return (db.termLocks||[]).filter(x=>x.active!==false&&x.classId===classId&&x.subject===subject&&String(x.academicYear||"")===String(academicYear)&&String(x.academicPeriod||x.period||"semester2")===String(academicPeriod)).sort((a,b)=>String(b.lockedAtIso||b.updatedAt||"").localeCompare(String(a.lockedAtIso||a.updatedAt||"")))[0]||null;
}
function isTermLockedV75(db,scope){return !!termLockV75(db,scope);}
function gradebookManualAverageV75(db,{studentId,classId,subject,academicYear,academicPeriod,categoryId}){
  const rows=(db.gradebookEntries||[]).filter(r=>r.active!==false&&r.studentId===studentId&&r.classId===classId&&r.subject===subject&&String(r.academicYear||academicYear)===String(academicYear)&&String(r.academicPeriod||r.period||"semester2")===String(academicPeriod)&&r.categoryId===categoryId&&Number(r.maxScore)>0&&Number.isFinite(Number(r.score)));
  if(!rows.length)return {average:null,count:0};
  const values=rows.map(r=>Math.max(0,Math.min(20,Number(r.score)/Number(r.maxScore)*20)));
  return {average:Math.round(values.reduce((n,v)=>n+v,0)/values.length*100)/100,count:values.length};
}
function gradebookContinuousV75(db,{studentId="",classId="",subject="",academicYear="",academicPeriod="semester2"}={}){
  const cfg=(db.gradebookConfigs||[]).find(c=>c.key===gradebookKeyV75({classId,subject,academicYear,academicPeriod})&&c.enabled!==false);
  const exam=ongoingExamAverageV73(db,{studentId,classId,subject,academicYear,academicPeriod});
  if(!cfg)return {score:exam.average,examAverage:exam.average,examCount:exam.count,scheduledExamCount:exam.scheduledCount,components:exam.average===null?[]:[{id:"exam",title:"آزمون‌های مستمر",weight:100,score:exam.average,count:exam.count}],configured:false};
  let weighted=0,availableWeight=0;const components=[];
  for(const cat of cfg.categories||[]){let result;if(cat.source==="exam")result={average:exam.average,count:exam.count};else result=gradebookManualAverageV75(db,{studentId,classId,subject,academicYear,academicPeriod,categoryId:cat.id});const score=result.average;if(score!==null){weighted+=score*Number(cat.weight||0);availableWeight+=Number(cat.weight||0);}components.push({id:cat.id,title:cat.title,weight:Number(cat.weight||0),source:cat.source,score,count:result.count});}
  const score=availableWeight>0?Math.round(weighted/availableWeight*100)/100:null;
  return {score,examAverage:exam.average,examCount:exam.count,scheduledExamCount:exam.scheduledCount,components,configured:true,configuredWeight:100,availableWeight};
}
function gradebookPayloadV75(db,{classId,subject,academicYear,academicPeriod}){
  const config=(db.gradebookConfigs||[]).find(c=>c.key===gradebookKeyV75({classId,subject,academicYear,academicPeriod}))||{...normalizeGradebookConfigV75({}, {classId,subject,academicYear,academicPeriod}),enabled:false};
  const students=(db.users||[]).filter(u=>u.role==="student"&&u.active!==false&&u.profileStatus!=="deleted"&&u.classId===classId).map(st=>({id:st.id,firstName:st.firstName,lastName:st.lastName,studentCode:st.studentCode||"",result:gradebookContinuousV75(db,{studentId:st.id,classId,subject,academicYear,academicPeriod})}));
  return {config,students,entries:(db.gradebookEntries||[]).filter(r=>r.classId===classId&&r.subject===subject&&String(r.academicYear||academicYear)===String(academicYear)&&String(r.academicPeriod||r.period||"semester2")===String(academicPeriod)&&r.active!==false),lock:termLockV75(db,{classId,subject,academicYear,academicPeriod})};
}
function notificationRecipientsV75(db,user,{targetType="user",targetId="",classId=""}={}){
  if(targetType==="user"){const u=(db.users||[]).find(x=>x.id===targetId&&x.active!==false&&x.profileStatus!=="deleted");if(!u)return [];if(user.role==="teacher"&&u.role==="student"&&!teacherCanAssigned(db,user,{classId:u.classId}))return [];return [u.id];}
  if(targetType==="class"){const cid=String(classId||targetId);if(user.role==="teacher"&&!teacherCanAssigned(db,user,{classId:cid}))return [];return (db.users||[]).filter(x=>x.role==="student"&&x.classId===cid&&x.active!==false&&x.profileStatus!=="deleted").map(x=>x.id);}
  if(targetType==="staff"&&["admin","superadmin"].includes(user.role))return (db.users||[]).filter(x=>["teacher","admin","superadmin"].includes(x.role)&&x.active!==false&&x.profileStatus!=="deleted").map(x=>x.id);
  if(targetType==="all"&&["admin","superadmin"].includes(user.role))return (db.users||[]).filter(x=>x.active!==false&&x.profileStatus!=="deleted").map(x=>x.id);
  return [];
}

// v79 — distribute the authoritative weekly schedule to students.
function scheduleSemanticRowV79(row){
  return [row.day||"",row.shiftId||"",Number(row.periodNo||0),row.subject||"",row.teacherId||"",row.startTime||"",row.endTime||"",row.room||"",row.deliveryMode||"inherit",row.meetingProvider||"",row.meetingUrl||""].join("|");
}
function scheduleSignatureByClassV79(db){
  const year=String(db?.school?.year||"");const grouped=new Map();
  for(const row of db?.weeklySchedule||[]){if(row.active===false||String(row.academicYear||year)!==year)continue;const cid=String(row.classId||"");if(!cid)continue;if(!grouped.has(cid))grouped.set(cid,[]);grouped.get(cid).push(scheduleSemanticRowV79(row));}
  const out=new Map();for(const [cid,rows] of grouped)out.set(cid,rows.slice().sort().join("\n"));return out;
}
function distributeScheduleChangesV79(oldDb,nextDb,actorId){
  const before=scheduleSignatureByClassV79(oldDb),after=scheduleSignatureByClassV79(nextDb),classIds=new Set([...before.keys(),...after.keys()]);
  const changed=[...classIds].filter(cid=>(before.get(cid)||"")!==(after.get(cid)||""));if(!changed.length)return [];
  nextDb.notifications=Array.isArray(nextDb.notifications)?nextDb.notifications:[];nextDb.scheduleRevisions=Array.isArray(nextDb.scheduleRevisions)?nextDb.scheduleRevisions:[];
  const at=faNow(),iso=new Date().toISOString(),year=String(nextDb.school?.year||"");
  for(const classId of changed){
    const cls=(nextDb.school?.classes||[]).find(c=>c.id===classId),students=(nextDb.users||[]).filter(u=>u.role==="student"&&u.classId===classId&&u.active!==false&&u.profileStatus!=="deleted");
    const revisionId=makeId("schrev"),title="برنامه هفتگی به‌روزرسانی شد",body=`برنامه هفتگی ${cls?.name||"کلاس شما"} تغییر کرد. آخرین برنامه را از بخش «برنامه هفتگی» مشاهده کنید.`;
    for(const st of students)nextDb.notifications.unshift({id:makeId("not"),userId:st.id,title,body,read:false,at,kind:"schedule_updated",target:"schedule",targetId:classId,revisionId,createdBy:actorId});
    nextDb.scheduleRevisions.unshift({id:revisionId,classId,academicYear:year,changedAt:iso,changedBy:actorId,recipientCount:students.length});
  }
  nextDb.scheduleRevisions=nextDb.scheduleRevisions.slice(0,500);return changed;
}

function upgradeRoadmapDb(db) {
  db.school ||= {};
  db.school.code ||= ""; db.school.district ||= ""; db.school.schoolType ||= "دولتی";
  db.school.semesters = Array.isArray(db.school.semesters) && db.school.semesters.length ? db.school.semesters : [{id:"sem1",title:"نیم‌سال اول",active:true},{id:"sem2",title:"نیم‌سال دوم",active:false}];
  db.school.rooms = Array.isArray(db.school.rooms) ? db.school.rooms : [];
  db.school.departments = Array.isArray(db.school.departments) ? db.school.departments : [];
  db.school.calendar = Array.isArray(db.school.calendar) ? db.school.calendar : [];
  db.enrollments = Array.isArray(db.enrollments) ? db.enrollments : [];
  db.studentDocuments = Array.isArray(db.studentDocuments) ? db.studentDocuments : [];
  db.studentExtendedProfiles = Array.isArray(db.studentExtendedProfiles) ? db.studentExtendedProfiles : [];
  db.recordHistory = Array.isArray(db.recordHistory) ? db.recordHistory : [];
  db.adminTasks = Array.isArray(db.adminTasks) ? db.adminTasks : [];
  db.userAccessReviews = Array.isArray(db.userAccessReviews) ? db.userAccessReviews : [];
  db.yearArchives = Array.isArray(db.yearArchives) ? db.yearArchives : [];
  db.changeRequests = Array.isArray(db.changeRequests) ? db.changeRequests : [];
  db.schoolAlerts = Array.isArray(db.schoolAlerts) ? db.schoolAlerts : [];
  db.roleDefinitions = Array.isArray(db.roleDefinitions) && db.roleDefinitions.length ? db.roleDefinitions : [
  {id:"superadmin",title:"ادمین فنی",permissions:["*"]},
  {id:"admin",title:"مدیر مدرسه",permissions:["students","staff","school","reports","calendar","family","operations"]},
  {id:"teacher",title:"معلم",permissions:["ownClasses","attendance","homework","assessment","reports"]},
  {id:"exam_officer",title:"مسئول آزمون",permissions:["assessment","questionBank","reports"]},
  {id:"counselor",title:"مشاور",permissions:["studentSupport","family","limitedReports"]},
  {id:"viewer",title:"مشاهده‌گر آموزشی",permissions:["reports"]}
];
  db.users = (db.users||[]).map(u=>({...u,active:u.active!==false,jobTitle:u.jobTitle||({teacher:"معلم",admin:"مدیر",superadmin:"ادمین فنی",student:"دانش‌آموز"}[u.role]||u.role),profileStatus:u.profileStatus||"active",createdAt:u.createdAt||faNow()}));
  db.school.dataRetention = {auditDays:3650,archiveYears:10,studentFilesYears:10,...(db.school.dataRetention||{})};
  db.classSessions = Array.isArray(db.classSessions) ? db.classSessions : [];
  db.timetableExceptions = Array.isArray(db.timetableExceptions) ? db.timetableExceptions : [];
  db.makeupSessions = Array.isArray(db.makeupSessions) ? db.makeupSessions : [];
  db.homeworkAttachments = Array.isArray(db.homeworkAttachments) ? db.homeworkAttachments : [];
  db.assignmentRubrics = Array.isArray(db.assignmentRubrics) ? db.assignmentRubrics : [];
  db.teacherDailyTasks = Array.isArray(db.teacherDailyTasks) ? db.teacherDailyTasks : [];
  db.teachingPlans = Array.isArray(db.teachingPlans) ? db.teachingPlans : [];
  db.calendarEvents = Array.isArray(db.calendarEvents) ? db.calendarEvents : [];
  db.school.academicYears = ensureAcademicYearModel(db.school);
  db.calendarEvents = db.calendarEvents.map(row=>normalizeCalendarEvent(row,db.school?.year||""));
  db.classroomResources = Array.isArray(db.classroomResources) ? db.classroomResources : [];
  db.substitutionPlans = Array.isArray(db.substitutionPlans) ? db.substitutionPlans : [];
  db.attendanceReasons = Array.isArray(db.attendanceReasons) && db.attendanceReasons.length ? db.attendanceReasons : [{id:"illness",title:"بیماری",excused:true},{id:"family",title:"موضوع خانوادگی",excused:true},{id:"unknown",title:"بدون توضیح",excused:false}];
  db.attendancePolicies = {lateMinutes:10,notifyAfterAbsences:2,notifyAfterLates:3,...(db.attendancePolicies||{})};
  db.examVersions = Array.isArray(db.examVersions) ? db.examVersions : [];
  db.examPublicationHistory = Array.isArray(db.examPublicationHistory) ? db.examPublicationHistory : [];
  db.answerSheets = Array.isArray(db.answerSheets) ? db.answerSheets : [];
  db.gradingRubrics = Array.isArray(db.gradingRubrics) ? db.gradingRubrics : [];
  db.questionUsage = Array.isArray(db.questionUsage) ? db.questionUsage : [];
  db.questionReviews = Array.isArray(db.questionReviews) ? db.questionReviews : [];
  db.assessmentIncidents = Array.isArray(db.assessmentIncidents) ? db.assessmentIncidents : [];
  db.questionTypeConfig = {mcq:true,descriptive:true,trueFalse:true,fillBlank:true,multipart:true,...(db.questionTypeConfig||{})};
  db.assessmentPolicies = {requirePreviewBeforePublish:true,allowDraftPdf:true,requireTeacherFinalApproval:true,shuffleOptionsAllowed:true,...(db.assessmentPolicies||{})};
  const lifecycleStatesV4515=new Set(["draft","ready","published","in_progress","ended","graded","final","archived"]);
  db.exams=(db.exams||[]).map(e=>{const derived=e.status==="active"?"published":e.status==="archived"?"archived":"draft";const publicationState=lifecycleStatesV4515.has(e.publicationState)?e.publicationState:derived;return {...e,versionNo:Number(e.versionNo||1),publicationState,preflight:e.preflight||{checked:false,issues:[]}};});
  db.studentGoals = Array.isArray(db.studentGoals) ? db.studentGoals : [];
  db.masteryRecords = Array.isArray(db.masteryRecords) ? db.masteryRecords : [];
  db.studyPlans = Array.isArray(db.studyPlans) ? db.studyPlans : [];
  db.offlineSyncQueue = Array.isArray(db.offlineSyncQueue) ? db.offlineSyncQueue : [];
  db.studentFiles = Array.isArray(db.studentFiles) ? db.studentFiles : [];
  db.lessonMaterials = Array.isArray(db.lessonMaterials) ? db.lessonMaterials : [];
  db.achievements = Array.isArray(db.achievements) ? db.achievements : [];
  db.studentReceipts = Array.isArray(db.studentReceipts) ? db.studentReceipts : [];
  db.studentBookmarks = Array.isArray(db.studentBookmarks) ? db.studentBookmarks : [];
  db.studentPreferences = db.studentPreferences && typeof db.studentPreferences==="object" ? db.studentPreferences : {};
  db.guardians = (Array.isArray(db.guardians) ? db.guardians : []).map(g=>({...g,nationalId:normalizeNationalId(g.nationalId||g.guardianNationalId),active:g.active!==false,createdAt:g.createdAt||faNow()}));
  db.guardianLinks = Array.isArray(db.guardianLinks) ? db.guardianLinks : [];
  db.guardianMessages = Array.isArray(db.guardianMessages) ? db.guardianMessages : [];
  db.counselingCases = Array.isArray(db.counselingCases) ? db.counselingCases : [];
  db.counselingSessions = Array.isArray(db.counselingSessions) ? db.counselingSessions : [];
  db.familyMeetings = Array.isArray(db.familyMeetings) ? db.familyMeetings : [];
  db.behaviorCategories = Array.isArray(db.behaviorCategories) ? db.behaviorCategories : [];
  db.disciplinaryCases = Array.isArray(db.disciplinaryCases) ? db.disciplinaryCases : [];
  db.consentTemplates = Array.isArray(db.consentTemplates) ? db.consentTemplates : [];
  db.parentRequests = Array.isArray(db.parentRequests) ? db.parentRequests : [];
  db.familyPolicies = {guardianAccessDays:30,allowMeetingRequests:true,showPrivateCounseling:false,...(db.familyPolicies||{})};
  db.reportTemplates = Array.isArray(db.reportTemplates) ? db.reportTemplates : [];
  db.savedReports = Array.isArray(db.savedReports) ? db.savedReports : [];
  db.analyticsSnapshots = Array.isArray(db.analyticsSnapshots) ? db.analyticsSnapshots : [];
  db.interventionRules = Array.isArray(db.interventionRules) ? db.interventionRules : [];
  db.gradebookConfigs = Array.isArray(db.gradebookConfigs) ? db.gradebookConfigs : [];
  db.gradebookEntries = Array.isArray(db.gradebookEntries) ? db.gradebookEntries : [];
  db.termFinalOverrides = Array.isArray(db.termFinalOverrides) ? db.termFinalOverrides : [];
  db.termLocks = Array.isArray(db.termLocks) ? db.termLocks : [];
  db.notificationBroadcasts = Array.isArray(db.notificationBroadcasts) ? db.notificationBroadcasts : [];
  db.scheduleRevisions = Array.isArray(db.scheduleRevisions) ? db.scheduleRevisions : [];
  db.reportCards = Array.isArray(db.reportCards) ? db.reportCards : [];
  db.gradingPolicyHistory = Array.isArray(db.gradingPolicyHistory) ? db.gradingPolicyHistory : [];
  db.schoolKpis = Array.isArray(db.schoolKpis) ? db.schoolKpis : [];
  db.questionAnalytics = Array.isArray(db.questionAnalytics) ? db.questionAnalytics : [];
  db.comparisonPeriods = Array.isArray(db.comparisonPeriods) ? db.comparisonPeriods : [];
  db.analyticsSettings = {riskAbsenceWeight:0.25,riskHomeworkWeight:0.25,riskGradeWeight:0.5,passingScore:10,...(db.analyticsSettings||{})};
  db.admissions = Array.isArray(db.admissions) ? db.admissions : [];
  db.certificates = Array.isArray(db.certificates) ? db.certificates : [];
  db.letters = Array.isArray(db.letters) ? db.letters : [];
  db.libraryBooks = Array.isArray(db.libraryBooks) ? db.libraryBooks : [];
  db.libraryLoans = Array.isArray(db.libraryLoans) ? db.libraryLoans : [];
  db.assets = Array.isArray(db.assets) ? db.assets : [];
  db.maintenanceRequests = Array.isArray(db.maintenanceRequests) ? db.maintenanceRequests : [];
  db.labs = Array.isArray(db.labs) ? db.labs : [];
  db.labBookings = Array.isArray(db.labBookings) ? db.labBookings : [];
  db.trips = Array.isArray(db.trips) ? db.trips : [];
  db.transportation = Array.isArray(db.transportation) ? db.transportation : [];
  db.schoolForms = Array.isArray(db.schoolForms) ? db.schoolForms : [];
  db.formSubmissions = Array.isArray(db.formSubmissions) ? db.formSubmissions : [];
  db.inventoryMovements = Array.isArray(db.inventoryMovements) ? db.inventoryMovements : [];
  db.feeAccounts = Array.isArray(db.feeAccounts) ? db.feeAccounts : [];
  db.operationsSettings = {financeModuleEnabled:false,libraryEnabled:true,assetsEnabled:true,labsEnabled:true,tripsEnabled:true,...(db.operationsSettings||{})};
  db.migrationHistory = Array.isArray(db.migrationHistory) ? db.migrationHistory : [];
  db.integrityChecks = Array.isArray(db.integrityChecks) ? db.integrityChecks : [];
  db.healthChecks = Array.isArray(db.healthChecks) ? db.healthChecks : [];
  db.updateHistory = Array.isArray(db.updateHistory) ? db.updateHistory : [];
  db.releaseTests = Array.isArray(db.releaseTests) ? db.releaseTests : [];
  db.releaseInfo = {version:APP_VERSION,release:APP_RELEASE,channel:RELEASE_CHANNEL,schemaVersion:69,releasedAt:db.releaseInfo?.release===APP_RELEASE?db.releaseInfo.releasedAt:new Date().toISOString(),...(db.releaseInfo||{}),version:APP_VERSION,release:APP_RELEASE,schemaVersion:69};
  db.systemPolicies = {requireBackupBeforeUpgrade:true,requireRestorePointBeforeRepair:true,allowLanOnly:true,maxAuditRows:20000,...(db.systemPolicies||{})};
  db.storagePolicies = {maxUploadMb:Number(db.school?.settings?.maxUploadMb||12),orphanCleanup:true,quotaWarnPercent:85,...(db.storagePolicies||{})};
  db.offlinePolicies = {studentAutosave:true,retryQueue:true,idempotentSubmissions:true,cacheExamDrafts:true,...(db.offlinePolicies||{})};
  db.installationConfig = {mode:"lan",host:"0.0.0.0",port:8787,updateChannel:"stable",...(db.installationConfig||{})};
  return db;
}

function upgradeServerDb(db) {
  db.curriculum = Array.isArray(db.curriculum) && db.curriculum.length ? db.curriculum : serverDefaultCurriculum();
  db.chapterProgress = Array.isArray(db.chapterProgress) ? db.chapterProgress : [];
  db.learningPoints = Array.isArray(db.learningPoints) && db.learningPoints.length ? db.learningPoints : serverSeedLearningPoints();
  db.questionGenerationJobs = Array.isArray(db.questionGenerationJobs) ? db.questionGenerationJobs : [];
  db.questionBank = Array.isArray(db.questionBank) ? db.questionBank : [];
  // P66: isolated admin-only question repository, no auto-copy from legacy pools.
  db.adminQuestionBank = Array.isArray(db.adminQuestionBank) ? db.adminQuestionBank : [];
  db.questionVersions = Array.isArray(db.questionVersions) ? db.questionVersions : [];
  db.questionCollections = Array.isArray(db.questionCollections) ? db.questionCollections : [];
  db.examBlueprints = Array.isArray(db.examBlueprints) ? db.examBlueprints : [];
  db.repositoryTargets = db.repositoryTargets && typeof db.repositoryTargets === "object" ? db.repositoryTargets : {};
  db.qualityRules = { minSampleSize: 10, tooEasyPercent: 90, tooHardPercent: 25, maxAppealRate: 0.15, ...(db.qualityRules || {}) };
  const findBook = subject => db.curriculum.find(b => b.subject === subject);
  db.questionBank = db.questionBank.map((raw, index) => {
    const q = { ...raw }; const book = findBook(q.subject); const chapter = (book?.chapters || []).find(c => c.id === q.chapterId || c.title === q.chapter) || book?.chapters?.[0];
    q.bookId ||= book?.id || ""; q.chapterId ||= chapter?.id || ""; q.chapter ||= chapter?.title || ""; q.difficulty ||= ["easy", "medium", "advanced"][index % 3]; q.status ||= "approved"; q.sourceType ||= "teacher";
    q.topic = String(q.topic || q.topicTitle || q.tags?.[0] || "").trim(); q.cognitiveLevel ||= q.difficulty === "advanced" ? "analyze" : q.difficulty === "medium" ? "apply" : "remember";
    q.estimatedSeconds = Math.max(15, Number(q.estimatedSeconds || (q.type === "descriptive" ? 240 : 75))); q.learningOutcome = String(q.learningOutcome || q.explanation || "").trim(); q.sourcePage = String(q.sourcePage || q.sourceRef || q.chapter || "").trim();
    q.reviewCycleDays = Math.max(30, Number(q.reviewCycleDays || 180)); q.shared = q.shared !== false; q.stats = { usedCount: 0, answerCount: 0, correctCount: 0, appealCount: 0, avgSeconds: 0, ...(q.stats || {}) }; return q;
  });
  if (!db.chapterProgress.length) db.chapterProgress.push({ id: "prog_sc1", classId: "cls1", bookId: "book_science7", chapterId: "science_1", status: "completed", completedAt: faNow(), completedBy: "tea1" }, { id: "prog_so2", classId: "cls1", bookId: "book_social7", chapterId: "social_2", status: "completed", completedAt: faNow(), completedBy: "tea1" });
  db.exams = (db.exams || []).map(exam => { const meta = examCurriculumMeta(db, exam); const questions=(exam.questions || []).map(q => exam.type === "descriptive" ? normalizeDescriptiveQuestion(q) : q); const total=questions.reduce((a,q)=>a+Number(q.score||0),0); return { ...exam, ...meta, chapter: exam.chapter || meta.chapterTitle, academicYear: exam.academicYear || db.school?.year || "", targetScore:Number(exam.targetScore)>0?Number(exam.targetScore):total, questions }; });
  db.questionBank = db.questionBank.map(q => q.type === "descriptive" ? normalizeDescriptiveQuestion(q) : q);
  const bundledIds = new Set(["stu1", "stu2", "stu3", "adm1"]);
  db.users = (db.users || []).filter(u => !bundledIds.has(u.id));
  // معلم اولیه فقط هنگام ساخت دیتابیس تازه ایجاد می‌شود؛ پس از حذف توسط ادمین دوباره ساخته نمی‌شود.
  if (!db.users.some(u => u.role === "superadmin" && u.active !== false && String(u.profileStatus || "active") !== "deleted")) db.users.push({ id: "sys1", role: "superadmin", username: "admin405", nationalId: "0099999999", firstName: "ادمین", lastName: "فنی", active: true });
  db.users = db.users.map(u => ({ ...u, birthDate: u.role === "student" ? normalizeStoredBirthDate(u.birthDate || u.birthYear) : u.birthDate, username: u.id === "tea1" ? "admin" : u.id === "sys1" ? "admin405" : (u.username || normalizeNationalId(u.nationalId) || u.studentCode || "") }));
  db.notifications = (db.notifications || []).filter(x => !bundledIds.has(x.userId));
  db.attendance = (db.attendance || []).filter(x => !bundledIds.has(x.studentId));
  db.attempts = (db.attempts || []).filter(x => !bundledIds.has(x.studentId));
  db.submissions = (db.submissions || []).filter(x => !bundledIds.has(x.studentId));
  db.appeals = (db.appeals || []).filter(x => !bundledIds.has(x.studentId));
  const validSubmissionIds = new Set((db.submissions || []).map(x => x.id));
  db.grades = (db.grades || []).filter(x => validSubmissionIds.has(x.submissionId));
  db.school ||= {};
  db.school.name = db.school.name === "مدرسه پایه اول متوسطه پروین اعتصامی جوانرود" ? "مدرسه دوره اول متوسطه پروین اعتصامی جوانرود" : (db.school.name || SCHOOL_NAME);
  db.school.grades = SCHOOL_GRADES.map(g => ({...g}));
  db.school.classes = (Array.isArray(db.school.classes) ? db.school.classes : []).map(c => { const meta=gradeMeta(c.grade); return {...c, grade:meta.grade, gradeId:meta.id, gradeName:meta.name}; });
  for (const grade of [7,8,9]) if (!db.school.classes.some(c => Number(c.grade) === grade)) { const meta=gradeMeta(grade); db.school.classes.push({id:`cls${grade}a`,name:`${meta.name} - الف`,grade,gradeId:meta.id,gradeName:meta.name,active:true,academicYear:db.school.year||""}); }
  db.curriculum = ensureMultiGradeCurriculumServer(db.curriculum);
  const bookById = new Map((db.curriculum||[]).map(b=>[b.id,b]));
  db.questionBank = (db.questionBank||[]).map(q=>{ const b=bookById.get(q.bookId); const grade=Number(q.grade||b?.grade||7); const meta=gradeMeta(grade); return {...q,grade:meta.grade,gradeId:meta.id,gradeName:meta.name}; });
  db.exams = (db.exams||[]).map(e=>{ const cls=(db.school.classes||[]).find(c=>c.id===e.classId), b=bookById.get(e.bookId); const grade=Number(e.grade||cls?.grade||b?.grade||7), meta=gradeMeta(grade); return {...e,grade:meta.grade,gradeId:meta.id,gradeName:meta.name}; });
  db.school.academicYears = ensureAcademicYearModel(db.school);
  db.school.settings = { maxUploadMb: 12, autoBackupMinutes: 5, backupRetention: 20, dailyBackupRetention: 7, weeklyBackupRetention: 4, recycleRetentionDays: 30, scoreScale: 20, passingScore: 10, gradingPolicy: { mode: "additive", continuousWeight: 40, finalWeight: 60 }, allowAppeals: true, allowStudentResubmit: false, schoolManager: "", phone: "", address: "", ...(db.school.settings || {}) };
  {
    const rawPolicy = db.school.settings?.gradingPolicy || {};
    const mode = rawPolicy.mode === "weighted" ? "weighted" : "additive";
    let continuousWeight = Number(rawPolicy.continuousWeight);
    let finalWeight = Number(rawPolicy.finalWeight);
    if (!Number.isFinite(continuousWeight) || continuousWeight < 0 || continuousWeight > 100) continuousWeight = 40;
    if (!Number.isFinite(finalWeight) || finalWeight < 0 || finalWeight > 100) finalWeight = 60;
    if (mode === "weighted" && Math.abs((continuousWeight + finalWeight) - 100) > 0.001) {
      continuousWeight = 40; finalWeight = 60;
    }
    db.school.settings.gradingPolicy = { mode, continuousWeight, finalWeight };
  }
  db.school.reportBranding = { organization: "وزارت آموزش و پرورش", schoolName: db.school.name || "مدرسه", district: "", address: db.school.settings.address || "", phone: db.school.settings.phone || "", managerName: db.school.settings.schoolManager || "", headerNote: "", footerNote: "این گزارش از سامانه مدرسه‌یار تهیه شده است.", headerImageDataUrl: "", headerImageUpdatedAt: "", managerSignatureDataUrl: "", managerSignatureUpdatedAt: "", ...(db.school.reportBranding || {}) };
  db.school.uiBranding = {
    primaryColor: "#14233f", accentColor: "#4f7cff", logoDataUrl: "", logoUpdatedAt: "", updatedAt: "",
    headers: {
      admin: {template:"modern",imageDataUrl:"",imageUpdatedAt:"",height:132,fit:"cover",textTone:"light",showImage:true,showLogo:true,showSchoolName:true,showSubtitle:true,showYear:true,subtitle:"مرکز مدیریت مدرسه"},
      teacher: {template:"modern",imageDataUrl:"",imageUpdatedAt:"",height:126,fit:"cover",textTone:"light",showImage:true,showLogo:true,showSchoolName:true,showSubtitle:true,showYear:true,subtitle:"پنل حرفه‌ای معلم"},
      student: {template:"compact",imageDataUrl:"",imageUpdatedAt:"",height:78,fit:"cover",textTone:"light",showImage:true,showLogo:true,showSchoolName:true,showSubtitle:false,showYear:false,subtitle:"پنل دانش‌آموز"},
      guardian: {template:"compact",imageDataUrl:"",imageUpdatedAt:"",height:84,fit:"cover",textTone:"light",showImage:true,showLogo:true,showSchoolName:true,showSubtitle:true,showYear:false,subtitle:"پنل خانواده و والدین"}
    },
    history: [],
    ...(db.school.uiBranding || {})
  };
  db.school.uiBranding.headers = {
    admin:{template:"modern",imageDataUrl:"",imageUpdatedAt:"",height:132,fit:"cover",textTone:"light",showImage:true,showLogo:true,showSchoolName:true,showSubtitle:true,showYear:true,subtitle:"مرکز مدیریت مدرسه",...(db.school.uiBranding.headers?.admin||{})},
    teacher:{template:"modern",imageDataUrl:"",imageUpdatedAt:"",height:126,fit:"cover",textTone:"light",showImage:true,showLogo:true,showSchoolName:true,showSubtitle:true,showYear:true,subtitle:"پنل حرفه‌ای معلم",...(db.school.uiBranding.headers?.teacher||{})},
    student:{template:"compact",imageDataUrl:"",imageUpdatedAt:"",height:78,fit:"cover",textTone:"light",showImage:true,showLogo:true,showSchoolName:true,showSubtitle:false,showYear:false,subtitle:"پنل دانش‌آموز",...(db.school.uiBranding.headers?.student||{})},
    guardian:{template:"compact",imageDataUrl:"",imageUpdatedAt:"",height:84,fit:"cover",textTone:"light",showImage:true,showLogo:true,showSchoolName:true,showSubtitle:true,showYear:false,subtitle:"پنل خانواده و والدین",...(db.school.uiBranding.headers?.guardian||{})}
  };
  // v43: apply the supplied school artwork as the default header once on upgrade.
  if (Number(db.school.uiBranding.defaultHeaderVersion || 0) < 43) {
    const sharedHeader = "/assets/school-header-v43.jpg";
    const defaultsV43 = {
      admin:{template:"image",imageDataUrl:sharedHeader,imageUpdatedAt:faNow(),height:210,fit:"cover",textTone:"light",showImage:true,showLogo:false,showSchoolName:false,showSubtitle:false,showYear:false,subtitle:""},
      teacher:{template:"image",imageDataUrl:sharedHeader,imageUpdatedAt:faNow(),height:210,fit:"cover",textTone:"light",showImage:true,showLogo:false,showSchoolName:false,showSubtitle:false,showYear:false,subtitle:""},
      student:{template:"image",imageDataUrl:sharedHeader,imageUpdatedAt:faNow(),height:165,fit:"cover",textTone:"light",showImage:true,showLogo:false,showSchoolName:false,showSubtitle:false,showYear:false,subtitle:""},
      guardian:{template:"image",imageDataUrl:sharedHeader,imageUpdatedAt:faNow(),height:185,fit:"cover",textTone:"light",showImage:true,showLogo:false,showSchoolName:false,showSubtitle:false,showYear:false,subtitle:""}
    };
    for (const [key, value] of Object.entries(defaultsV43)) db.school.uiBranding.headers[key] = {...db.school.uiBranding.headers[key], ...value};
    db.school.uiBranding.defaultHeaderVersion = 43;
    db.school.uiBranding.updatedAt = faNow();
  }

  db = normalizeTeachingAssignments(db);
  db.accessProfiles = Array.isArray(db.accessProfiles) && db.accessProfiles.length ? db.accessProfiles : [
    { id: "teacher_full", title: "معلم کامل", permissions: ["curriculum", "questionBank", "examManagement", "grading", "appeals", "reports", "classroom"] },
    { id: "teacher_exam", title: "مسئول آزمون", permissions: ["questionBank", "examManagement", "grading", "appeals", "reports"] },
    { id: "teacher_report", title: "مشاهده‌گر آموزشی", permissions: ["reports"] }
  ];
  db.users = (db.users || []).map(u => u.role === "teacher" ? { permissionProfile: u.permissionProfile || "teacher_full", jobTitle: u.jobTitle || "معلم", ...u } : u);
  db.adminNotes = Array.isArray(db.adminNotes) ? db.adminNotes : [];
  db.attendanceSessions = (Array.isArray(db.attendanceSessions) ? db.attendanceSessions : []).map(x=>({...x,academicYear:x.academicYear||db.school?.year||"",academicPeriod:x.academicPeriod||x.period||"semester2"}));
  db.attendance = (Array.isArray(db.attendance) ? db.attendance : []).map(x=>{
    const legacyStatus=String(x.status||"");
    const status=legacyStatus==="absent"?"absent_pending":legacyStatus==="excused"?"absent_excused":legacyStatus;
    return {...x,status:status||"present",academicYear:x.academicYear||db.school?.year||"",academicPeriod:x.academicPeriod||x.period||"semester2"};
  });
  db.homeworkSubmissions = (Array.isArray(db.homeworkSubmissions) ? db.homeworkSubmissions : []).map(x=>({...x,academicYear:x.academicYear||db.school?.year||"",academicPeriod:x.academicPeriod||x.period||"semester2"}));
  db.continuousAssessments = (Array.isArray(db.continuousAssessments) ? db.continuousAssessments : []).map(x=>({...x,academicYear:x.academicYear||db.school?.year||""}));
  db.continuousGradeOverrides = (Array.isArray(db.continuousGradeOverrides) ? db.continuousGradeOverrides : []).map(x=>({...x,academicYear:x.academicYear||db.school?.year||"",academicPeriod:["semester1","semester2"].includes(String(x.academicPeriod||x.period))?String(x.academicPeriod||x.period):"semester2",history:Array.isArray(x.history)?x.history:[]}));
  db.termPolicies = Array.isArray(db.termPolicies) ? db.termPolicies : [];
  db.behaviorRecords = (Array.isArray(db.behaviorRecords) ? db.behaviorRecords : []).map(x=>({...x,academicYear:x.academicYear||db.school?.year||"",academicPeriod:x.academicPeriod||x.period||"semester2"}));
  db.announcements = Array.isArray(db.announcements) ? db.announcements : [];
  db.interventions = Array.isArray(db.interventions) ? db.interventions : [];
  db.gradeRevisions = Array.isArray(db.gradeRevisions) ? db.gradeRevisions : [];
  db.lessonLogs = (Array.isArray(db.lessonLogs) ? db.lessonLogs : []).map(x=>({...x,academicYear:x.academicYear||db.school?.year||"",academicPeriod:x.academicPeriod||x.period||"semester2"}));
  db.guardianContacts = Array.isArray(db.guardianContacts) ? db.guardianContacts : [];
  db.consentForms = Array.isArray(db.consentForms) ? db.consentForms : [];
  db.progressReports = Array.isArray(db.progressReports) ? db.progressReports : [];
  const defaultClassId = db.school?.classes?.find(c => c.active)?.id || db.school?.classes?.[0]?.id || "";
  db.school.shiftDefinitions = Array.isArray(db.school.shiftDefinitions) && db.school.shiftDefinitions.length ? db.school.shiftDefinitions : [
    {id:"morning",name:"شیفت صبح",periods:[{no:1,start:"07:30",end:"08:15"},{no:2,start:"08:25",end:"09:10"},{no:3,start:"09:25",end:"10:10"},{no:4,start:"10:20",end:"11:05"},{no:5,start:"11:15",end:"12:00"},{no:6,start:"12:10",end:"12:55"}]},
    {id:"afternoon",name:"شیفت بعدازظهر",periods:[{no:1,start:"13:00",end:"13:45"},{no:2,start:"13:55",end:"14:40"},{no:3,start:"14:50",end:"15:35"},{no:4,start:"15:45",end:"16:30"},{no:5,start:"16:40",end:"17:25"},{no:6,start:"17:35",end:"18:20"}]}
  ];
  db.school.classes=(db.school.classes||[]).map(c=>({...c,shiftId:c.shiftId||"morning"}));
  db.enrollments = normalizeEnrollments(db);
  db.school.onlineLearning = onlineLearningSettingsV74(db);
  db.weeklySchedule = (Array.isArray(db.weeklySchedule) ? db.weeklySchedule : []).map(row=>{
    const mode=normalizeDeliveryModeV74(row.deliveryMode,"inherit");
    return {...row,deliveryMode:mode,meetingProvider:String(row.meetingProvider||"").slice(0,60),meetingUrl:normalizeWebUrlV74(row.meetingUrl||""),onlineInstructions:String(row.onlineInstructions||"").slice(0,1500)};
  });
  db.onlineClassSessions = (Array.isArray(db.onlineClassSessions) ? db.onlineClassSessions : []).map(row=>({...row,deliveryMode:normalizeDeliveryModeV74(row.deliveryMode,"online"),meetingUrl:normalizeWebUrlV74(row.meetingUrl||""),meetingProvider:String(row.meetingProvider||"").slice(0,60),academicYear:String(row.academicYear||db.school?.year||"")}));
  db.onlineJoinEvents = (Array.isArray(db.onlineJoinEvents) ? db.onlineJoinEvents : []).map(row=>({...row,academicYear:String(row.academicYear||db.school?.year||"")}));
  db.schedule = (Array.isArray(db.schedule) ? db.schedule : []).map((row, index) => ({ id: row.id || `sch_${index + 1}`, classId: row.classId || defaultClassId, day: row.day || "", periods: Array.from({ length: 6 }, (_, i) => String(row.periods?.[i] || "")) }));
  // v73: migrate legacy subject-only timetable rows when a valid teaching assignment exists.
  if (!db.weeklySchedule.length && db.schedule.length) {
    const classSlotKeys = new Set();
    const teacherSlotKeys = new Set();
    const year = String(db.school?.year || "");
    for (const row of db.schedule) {
      const cls = (db.school?.classes || []).find(c => c.id === row.classId);
      if (!cls) continue;
      const shiftId = cls.shiftId || "morning";
      const shift = (db.school.shiftDefinitions || []).find(x => x.id === shiftId);
      for (let i = 0; i < (row.periods || []).length; i++) {
        const subject = String(row.periods[i] || "").trim();
        if (!subject) continue;
        const assignment = (db.teachingAssignments || []).find(a => a.active !== false && a.classId === row.classId && String(a.subject || "").trim() === subject && (!a.academicYear || !year || a.academicYear === year));
        if (!assignment) continue;
        const periodNo = i + 1;
        const classKey = `${row.classId}|${row.day}|${shiftId}|${periodNo}`;
        const teacherKey = `${assignment.teacherId}|${row.day}|${shiftId}|${periodNo}`;
        if (classSlotKeys.has(classKey) || teacherSlotKeys.has(teacherKey)) continue;
        classSlotKeys.add(classKey); teacherSlotKeys.add(teacherKey);
        const period = shift?.periods?.[i] || {};
        db.weeklySchedule.push({
          id: `wsch_mig_${String(row.id || "row")}_${periodNo}`, classId: row.classId, academicYear: year, day: row.day, shiftId, periodNo,
          assignmentId: assignment.id, teacherId: assignment.teacherId, subject: assignment.subject, bookId: assignment.bookId || "",
          startTime: String(period.start || "").slice(0,5), endTime: String(period.end || "").slice(0,5), room: "", active: true,
          deliveryMode:"inherit", meetingProvider:"", meetingUrl:"", onlineInstructions:"",
          updatedAt: faNow(), updatedBy: "migration-v73"
        });
      }
    }
  }
  db.appeals = (db.appeals || []).map(a => ({ ...a, history: Array.isArray(a.history) && a.history.length ? a.history : [{ status: a.status || "open", note: "ثبت اولیه درخواست", at: a.at || faNow(), by: a.studentId || null }] }));
  db.homework = (db.homework || []).map(h => ({ allowLate: true, totalScore: 20, createdAt: h.createdAt || faNow(), createdBy: h.createdBy || "tea1", ...h, academicYear: h.academicYear || db.school?.year || "" }));
  db.accessProfiles = (db.accessProfiles || []).map(p => ({ ...p, permissions: Array.from(new Set([...(p.permissions || []), ...(p.id === "teacher_full" ? ["classroom"] : [])])) }));
  db = upgradeRoadmapDb(db);
  db.users=(db.users||[]).map(u=>({...u,profileStatus:u.profileStatus||((u.active===false)?"inactive":"active")}));
  const usageCountsV4515=new Map();
  for(const exam of db.exams||[]){const state=String(exam.publicationState||"").toLowerCase(),status=String(exam.status||"").toLowerCase();const used=["published","in_progress","ended","graded","final","archived"].includes(state)||status==="active"||status==="archived";if(!used)continue;for(const q of exam.questions||[])if(q.sourceQuestionId)usageCountsV4515.set(q.sourceQuestionId,(usageCountsV4515.get(q.sourceQuestionId)||0)+1);}
  db.questionUsage=[...usageCountsV4515.entries()].map(([questionId,usedCount])=>({questionId,usedCount,updatedAt:new Date().toISOString()}));
  db.questionBank=(db.questionBank||[]).map(q=>({...q,stats:{...(q.stats||{}),usedCount:Number(usageCountsV4515.get(q.id)||0)}}));
  db.releaseInfo={...(db.releaseInfo||{}),version:APP_VERSION,release:APP_RELEASE,schemaVersion:69,channel:RELEASE_CHANNEL};
  db = normalizeTeachingAssignments(db); db.securityVersion = APP_VERSION; db.version = APP_VERSION; return db;
}

function upgradeServerDbRespectingReset(db) {
  const preserve = db?.resetState?.mode === "superadmin-only" && db?.resetState?.preserveEmptyOperationalData === true;
  if (!preserve) return upgradeServerDb(db);

  const emptyTopLevel = new Set(Object.entries(db).filter(([,value])=>Array.isArray(value)&&value.length===0).map(([key])=>key));
  const classesWereEmpty = Array.isArray(db.school?.classes) && db.school.classes.length === 0;
  const academicYearsWereEmpty = Array.isArray(db.school?.academicYears) && db.school.academicYears.length === 0;
  const out = upgradeServerDb(db);

  // Schema upgrades may seed demo/reference rows. A factory-reset state explicitly
  // records which operational collections were empty, so those collections stay
  // empty while still receiving non-destructive schema/object migrations.
  for (const key of emptyTopLevel) if (Array.isArray(out[key])) out[key] = [];
  if (classesWereEmpty) out.school.classes = [];
  if (academicYearsWereEmpty) out.school.academicYears = [];
  out.resetState = {...db.resetState};
  return out;
}

function defaultServerDb() {
  return {
    version: APP_VERSION,
    createdAt: faNow(),
    school: {
      name: "مدرسه دوره اول متوسطه پروین اعتصامی جوانرود",
      year: "۱۴۰۵–۱۴۰۶",
      grades: SCHOOL_GRADES.map(g => ({...g})),
      classes: [
        { id: "cls1", name: "پایه اول متوسطه اول - الف", grade: 7, gradeId:"grade7", gradeName:"پایه اول متوسطه اول", active: true },
        { id: "cls8a", name: "پایه دوم متوسطه اول - الف", grade: 8, gradeId:"grade8", gradeName:"پایه دوم متوسطه اول", active: true },
        { id: "cls9a", name: "پایه سوم متوسطه اول - الف", grade: 9, gradeId:"grade9", gradeName:"پایه سوم متوسطه اول", active: true }
      ],
      subjects: ["علوم تجربی", "مطالعات اجتماعی", "ریاضی", "فارسی", "عربی", "زبان انگلیسی"],
      academicYears: [{ id: "year_1405_1406", label: "۱۴۰۵–۱۴۰۶", active: true, createdAt: faNow() }],
      settings: { maxUploadMb: 12, autoBackupMinutes: 5, backupRetention: 20 },
      onlineLearning: { enabled:false, operationMode:"in_person", defaultProvider:"custom", defaultMeetingUrl:"", instructions:"", joinWindowMinutes:15, lateAfterMinutes:10, teacherCanEditLinks:true, requireStudentCheckIn:true },
      reportBranding: { organization: "وزارت آموزش و پرورش", schoolName: "مدرسه دوره اول متوسطه پروین اعتصامی جوانرود", district: "", address: "", phone: "", managerName: "", headerNote: "", footerNote: "این گزارش از سامانه مدرسه‌یار تهیه شده است.", headerImageDataUrl: "", headerImageUpdatedAt: "", managerSignatureDataUrl: "", managerSignatureUpdatedAt: "" },
      uiBranding: {primaryColor:"#14233f",accentColor:"#4f7cff",logoDataUrl:"",logoUpdatedAt:"",updatedAt:faNow(),defaultHeaderVersion:43,headers:{admin:{template:"image",imageDataUrl:"/assets/school-header-v43.jpg",imageUpdatedAt:faNow(),height:210,fit:"cover",textTone:"light",showImage:true,showLogo:false,showSchoolName:false,showSubtitle:false,showYear:false,subtitle:""},teacher:{template:"image",imageDataUrl:"/assets/school-header-v43.jpg",imageUpdatedAt:faNow(),height:210,fit:"cover",textTone:"light",showImage:true,showLogo:false,showSchoolName:false,showSubtitle:false,showYear:false,subtitle:""},student:{template:"image",imageDataUrl:"/assets/school-header-v43.jpg",imageUpdatedAt:faNow(),height:165,fit:"cover",textTone:"light",showImage:true,showLogo:false,showSchoolName:false,showSubtitle:false,showYear:false,subtitle:""},guardian:{template:"image",imageDataUrl:"/assets/school-header-v43.jpg",imageUpdatedAt:faNow(),height:185,fit:"cover",textTone:"light",showImage:true,showLogo:false,showSchoolName:false,showSubtitle:false,showYear:false,subtitle:""}},history:[]}
    },
    users: [
      { id: "tea1", role: "teacher", username: "admin", nationalId: "0024387568", firstName: "معلم", lastName: "مدرسه", classIds: ["cls1"], subjects: ["علوم تجربی", "مطالعات اجتماعی"], active: true },
      { id: "sys1", role: "superadmin", username: "admin405", nationalId: "0099999999", firstName: "ادمین", lastName: "فنی", active: true }
    ],
    curriculum: serverDefaultCurriculum(),
    chapterProgress: [{ id: "prog_sc1", classId: "cls1", bookId: "book_science7", chapterId: "science_1", status: "completed", completedAt: faNow(), completedBy: "tea1" }, { id: "prog_so2", classId: "cls1", bookId: "book_social7", chapterId: "social_2", status: "completed", completedAt: faNow(), completedBy: "tea1" }],
    learningPoints: serverSeedLearningPoints(),
    questionGenerationJobs: [],
    questionVersions: [],
    questionCollections: [],
    examBlueprints: [],
    repositoryTargets: {},
    qualityRules: { minSampleSize: 10, tooEasyPercent: 90, tooHardPercent: 25, maxAppealRate: 0.15 },
    questionBank: serverSeedQuestionBank(),
    exams: [
      { id: "ex1", title: "آزمون فصل اول علوم", type: "mcq", subject: "علوم تجربی", bookId: "book_science7", chapterId: "science_1", chapter: "فصل اول", classId: "cls1", duration: 12, status: "active", showInstantResult: true, createdBy: "tea1", createdAt: faNow(), questions: [
        { id: "q1", sourceQuestionId: "bank_sc_e1", text: "کدام گزینه یک کمیت اندازه‌گیری‌پذیر است؟", score: 2.5, choices: ["زیبایی", "جرم", "مهربانی", "شجاعت"], answer: 1 },
        { id: "q2", sourceQuestionId: "bank_sc_e2", text: "یکای اصلی طول در دستگاه SI چیست؟", score: 2.5, choices: ["کیلوگرم", "ثانیه", "متر", "لیتر"], answer: 2 },
        { id: "q3", sourceQuestionId: "bank_sc_m1", text: "برای اندازه‌گیری حجم مایعات معمولاً از چه وسیله‌ای استفاده می‌شود؟", score: 2.5, choices: ["نیروسنج", "استوانه مدرج", "دماسنج", "ترازو"], answer: 1 },
        { id: "q4", sourceQuestionId: "bank_sc_m2", text: "چگالی از تقسیم کدام دو کمیت به دست می‌آید؟", score: 2.5, choices: ["جرم بر حجم", "حجم بر جرم", "طول بر زمان", "زمان بر طول"], answer: 0 }
      ]},
      { id: "ex2", title: "آزمون تشریحی فصل دوم مطالعات", type: "descriptive", subject: "مطالعات اجتماعی", bookId: "book_social7", chapterId: "social_2", chapter: "فصل دوم", classId: "cls1", duration: 40, status: "active", examCode: "MSY-STUDY-02", createdBy: "tea1", createdAt: faNow(), questions: [
        { id: "dq1", text: "دو مورد از حقوق شهروندی را توضیح دهید.", score: 10, referenceAnswer: "حق آموزش و حق برخورداری از امنیت، همراه با توضیح روشن.", rubric: [{ title: "ذکر دو حق معتبر", score: 4 }, { title: "توضیح روشن هر مورد", score: 4 }, { title: "نگارش و نتیجه‌گیری", score: 2 }] },
        { id: "dq2", text: "چرا رعایت قانون در جامعه اهمیت دارد؟", score: 10, referenceAnswer: "رعایت قانون باعث نظم اجتماعی، حفظ حقوق دیگران و کاهش اختلاف می‌شود.", rubric: [{ title: "اشاره به نظم اجتماعی", score: 3 }, { title: "حفظ حقوق دیگران", score: 3 }, { title: "مثال مناسب", score: 2 }, { title: "جمع‌بندی", score: 2 }] }
      ]}
    ],
    attempts: [], submissions: [], grades: [], appeals: [],
    notifications: [],
    audit: [],
    homework: [
      { id: "hw1", classId: "cls1", subject: "علوم تجربی", title: "تمرین فصل اول", description: "سؤال‌های ۱ تا ۶ صفحه ۲۱ را پاسخ دهید.", dueAt: "۱۴۰۵/۰۵/۲۰", status: "active" },
      { id: "hw2", classId: "cls1", subject: "فارسی", title: "خلاصه درس دوم", description: "یک خلاصه ده‌خطی در دفتر نگارش بنویسید.", dueAt: "۱۴۰۵/۰۵/۲۲", status: "active" }
    ],
    schedule: [
      { day: "شنبه", periods: ["ریاضی", "علوم تجربی", "فارسی", "ورزش"] },
      { day: "یکشنبه", periods: ["مطالعات اجتماعی", "عربی", "ریاضی", "هنر"] },
      { day: "دوشنبه", periods: ["فارسی", "علوم تجربی", "کار و فناوری", "زبان انگلیسی"] },
      { day: "سه‌شنبه", periods: ["ریاضی", "قرآن", "مطالعات اجتماعی", "نگارش"] },
      { day: "چهارشنبه", periods: ["زبان انگلیسی", "فارسی", "علوم تجربی", "تفکر"] }
    ],
    resources: [
      { id: "res1", classId: "cls1", subject: "علوم تجربی", title: "راهنمای اندازه‌گیری", type: "جزوه", url: "", description: "مرور مفاهیم فصل اول" },
      { id: "res2", classId: "cls1", subject: "مطالعات اجتماعی", title: "حقوق شهروندی", type: "خلاصه درس", url: "", description: "نکات مهم فصل دوم" }
    ],
    attendance: [],
    attendanceSessions: [],
    onlineClassSessions: [],
    onlineJoinEvents: [],
    homeworkSubmissions: [],
    continuousAssessments: [],
    termPolicies: [],
    behaviorRecords: [],
    announcements: [],
    interventions: [],
    gradeRevisions: [],
    lessonLogs: [],
    guardianContacts: [],
    consentForms: [],
    progressReports: []
  };
}

function enqueueStateOperation(operation) {
  const task = stateOperationQueue.then(operation, operation);
  stateOperationQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function ensureStateInitialized() {
  let current;
  try { current = await readStateEnvelope(); }
  catch (error) {
    if (error?.code !== "STATE_DATA_CORRUPT") throw error;
    current = await recoverCorruptState();
  }
  if (current.initialized && current.db) {
    const intentionalEmptyReset = current.db.resetState?.mode === "superadmin-only" && current.db.resetState?.preserveEmptyOperationalData === true;
    const needsUpgrade = Number(current.db.version || 0) < APP_VERSION || String(current.db.releaseInfo?.release || "") !== APP_RELEASE || !Array.isArray(current.db.curriculum) || !Array.isArray(current.db.chapterProgress) || !Array.isArray(current.db.learningPoints) || !Array.isArray(current.db.questionCollections) || !Array.isArray(current.db.school?.grades) || (current.db.school?.classes||[]).some(c=>!c.gradeId) || (current.db.curriculum||[]).some(b=>!b.gradeId) || (!intentionalEmptyReset && scienceCurriculumNeedsUpgradeServer(current.db.curriculum)) || (current.db.questionBank || []).some(q => !q.cognitiveLevel || !q.estimatedSeconds || !q.gradeId);
    if (needsUpgrade) return writeStateEnvelope(upgradeServerDbRespectingReset(current.db));
    return current;
  }
  return writeStateEnvelope(upgradeServerDb(defaultServerDb()));
}

async function mutateDb(mutator) {
  return enqueueStateOperation(async () => {
    const envelope = await ensureStateInitialized();
    const db = envelope.db;
    const result = await mutator(db);
    await writeStateEnvelope(db);
    return { db, result };
  });
}

function normalizeNationalId(value) {
  return String(value || "")
    .replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/\D/g, "");
}

async function studentAuth(req, options = {}) {
  return authenticate(req, ["student"], options);
}

function publicStudent(user, db) {
  const cls = (db.school?.classes || []).find(c => c.id === user.classId);
  return {
    id: user.id, firstName: user.firstName, lastName: user.lastName,
    nationalId: user.nationalId || "", birthDate: user.birthDate || "",
    studentCode: user.studentCode || "", classId: user.classId,
    className: cls?.name || "پایه اول متوسطه اول", grade: Number(cls?.grade||7), gradeName: cls?.gradeName || gradeMeta(cls?.grade||7).name, schoolName: db.school?.name || "مدرسه",
    academicYear: db.school?.year || "",
    studentMobile: user.studentMobile || "", email: user.email || "",
    guardianMobile: user.guardianMobile || "", homePhone: user.homePhone || "",
    emergencyGuardianName: user.emergencyGuardianName || "",
    emergencyGuardianRelation: user.emergencyGuardianRelation || "",
    emergencyGuardianMobile: user.emergencyGuardianMobile || "",
    address: user.address || "", postalCode: user.postalCode || "",
    fatherName: user.fatherName || "", motherName: user.motherName || "", placeOfBirth: user.placeOfBirth || "", identityNumber: user.identityNumber || "",
    profileUpdatedAt: user.profileUpdatedAt || "", profilePhotoUpdatedAt: user.profilePhotoUpdatedAt || ""
  };
}

function normalizePhone(value) {
  return String(value || "").replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^0-9+]/g, "").slice(0, 16);
}
function validateStudentProfilePayload(body) {
  const out = {
    studentMobile: normalizePhone(body.studentMobile),
    email: String(body.email || "").trim().toLowerCase().slice(0, 160),
    guardianMobile: normalizePhone(body.guardianMobile),
    homePhone: normalizePhone(body.homePhone),
    emergencyGuardianName: String(body.emergencyGuardianName || "").trim().slice(0, 120),
    emergencyGuardianRelation: String(body.emergencyGuardianRelation || "").trim().slice(0, 60),
    emergencyGuardianMobile: normalizePhone(body.emergencyGuardianMobile),
    address: String(body.address || "").trim().slice(0, 600),
    postalCode: normalizeNationalId(body.postalCode).slice(0, 10)
  };
  const mobileOk = value => !value || /^(?:\+98|0)?9\d{9}$/.test(value);
  const phoneOk = value => !value || /^\+?\d{8,15}$/.test(value);
  if (!mobileOk(out.studentMobile)) throw Object.assign(new Error("شماره موبایل دانش‌آموز معتبر نیست."), { status: 400 });
  if (!mobileOk(out.guardianMobile)) throw Object.assign(new Error("شماره موبایل ولی معتبر نیست."), { status: 400 });
  if (!mobileOk(out.emergencyGuardianMobile)) throw Object.assign(new Error("شماره تماس اضطراری ولی معتبر نیست."), { status: 400 });
  if (!phoneOk(out.homePhone)) throw Object.assign(new Error("تلفن منزل معتبر نیست."), { status: 400 });
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw Object.assign(new Error("ایمیل معتبر نیست."), { status: 400 });
  if (out.postalCode && !/^\d{10}$/.test(out.postalCode)) throw Object.assign(new Error("کد پستی باید ۱۰ رقم باشد."), { status: 400 });
  if (!out.emergencyGuardianMobile) throw Object.assign(new Error("شماره تماس اضطراری ولی الزامی است."), { status: 400 });
  return out;
}
async function saveStudentProfilePhoto(studentId, dataUrl) {
  await ensureDataDirs();
  const value = String(dataUrl || "");
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw Object.assign(new Error("فرمت عکس پروفایل معتبر نیست."), { status: 400 });
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 1.5 * 1024 * 1024) throw Object.assign(new Error("حجم عکس پروفایل باید کمتر از ۱.۵ مگابایت باشد."), { status: 413 });
  const key = safeKey(`student_profile_${studentId}`);
  const record = { key, studentId, type: match[1], size: bytes.length, dataUrl: value, savedAt: Date.now() };
  await atomicWriteText(path.join(FILES_DIR, `${key}.json`), JSON.stringify(record), 0o600);
  return record;
}
async function readStudentProfilePhoto(studentId) {
  try {
    const key = safeKey(`student_profile_${studentId}`);
    const record = JSON.parse(await fs.readFile(path.join(FILES_DIR, `${key}.json`), "utf8"));
    return String(record.dataUrl || "");
  } catch { return ""; }
}

function examTotalScore(exam) {
  return (exam.questions || []).reduce((total, q) => total + Number(q.score || 0), 0);
}

// v61 — authoritative pre-publish exam package validation. Mirrors Student runtime guard.
const SUPPORTED_STUDENT_QUESTION_TYPES_V61 = new Set(["mcq","true_false","descriptive","short_answer","fill_blank"]);
function validateExamForStudentV61(exam) {
  const problems = [];
  if (!exam || typeof exam !== "object") return ["ساختار آزمون نامعتبر است."];
  if (!String(exam.title || "").trim()) problems.push("عنوان آزمون خالی است.");
  if (!String(exam.classId || "").trim()) problems.push("کلاس آزمون مشخص نشده است.");
  if (!(Number(exam.duration) > 0)) problems.push("زمان آزمون معتبر نیست.");
  if (!Array.isArray(exam.questions) || !exam.questions.length) problems.push("آزمون سؤال قابل اجرا ندارد.");
  const ids = new Set();
  for (let i = 0; i < (exam.questions || []).length; i++) {
    const q = exam.questions[i] || {};
    const n = i + 1;
    const type = String(q.type || (exam.type === "mcq" ? "mcq" : "descriptive"));
    const id = String(q.id || "").trim();
    if (!id) problems.push(`سؤال ${n} شناسه ندارد.`);
    else if (ids.has(id)) problems.push(`شناسه سؤال ${n} تکراری است.`);
    else ids.add(id);
    if (!String(q.text || "").trim()) problems.push(`متن سؤال ${n} خالی است.`);
    if (!(Number(q.score) > 0)) problems.push(`نمره سؤال ${n} معتبر نیست.`);
    if (!SUPPORTED_STUDENT_QUESTION_TYPES_V61.has(type)) problems.push(`نوع سؤال ${n} برای Student پشتیبانی نمی‌شود.`);
    if (type === "mcq" && (!Array.isArray(q.choices) || q.choices.length < 2)) problems.push(`گزینه‌های سؤال ${n} ناقص است.`);
  }
  return problems;
}

// v54 — helpers for hybrid/mixed exams. Authentication is intentionally untouched.
function mixedAnswerMapV54(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "number") out[String(key)] = raw;
    else { const text = String(raw).trim(); if (text) out[String(key)] = text; }
  }
  return out;
}
function isAutoGradableQuestionV54(q) { return Boolean(q?.autoGradable || isAutoGradableCore(q)); }
function autoGradeQuestionV54(q, answers) {
  return autoGradeQuestionCore(q, answers);
}

function examCurriculumMeta(db, exam) {
  const book = (db.curriculum || []).find(item => item.id === exam.bookId || item.subject === exam.subject);
  const chapter = (book?.chapters || []).find(item => item.id === exam.chapterId || item.title === exam.chapter);
  return { bookId: exam.bookId || book?.id || "", bookTitle: book?.title || exam.subject || "کتاب درسی", chapterId: exam.chapterId || chapter?.id || "", chapterTitle: exam.chapter || chapter?.title || "بدون فصل" };
}

function sanitizeExam(exam) {
  return {
    id: exam.id, title: exam.title, type: exam.type, subject: exam.subject,
    bookId: exam.bookId || "", bookTitle: exam.bookTitle || exam.subject || "", chapterId: exam.chapterId || "",
    chapter: exam.chapter || "", duration: Number(exam.duration || 0),
    status: exam.status, publicationState: exam.publicationState || "",
    startAt: exam.startAt || exam.scheduledAt || exam.startTime || "", endAt: exam.endAt || exam.endTime || exam.deadline || "",
    availabilityRevision: Number(exam.availabilityRevision || 1),
    examCode: exam.examCode || "", formCode: exam.formCode || "",
    blueprintId: exam.blueprintId || "", packageRevision: Number(exam.packageRevision || 1), createdAt: exam.createdAt || "",
    totalScore: examTotalScore(exam), showInstantResult: Boolean(exam.showInstantResult),
    questions: (exam.questions || []).map((q, index) => ({
      id: q.id, number: index + 1, text: q.text, score: Number(q.score || 0), type: q.type || (exam.type === "mcq" ? "mcq" : "descriptive"),
      gradingFamily: q.gradingFamily || (isAutoGradableCore(q) ? "objective" : "subjective"), autoGradable: Boolean(q.autoGradable || isAutoGradableCore(q)),
      choices: Array.isArray(q.choices) ? q.choices.map(String) : []
    }))
  };
}

function examPackageVersion(exam) {
  return crypto.createHash("sha256").update(JSON.stringify(sanitizeExam(exam))).digest("hex").slice(0, 20);
}

function studentSheetCode(serverSecret, student, exam) {
  const studentPart = normalizeNationalId(student?.nationalId).slice(-4).padStart(4, "0");
  const examPart = String(exam?.examCode || exam?.id || "EXAM").replace(/[^A-Za-z0-9]/g, "").slice(-5).toUpperCase().padStart(5, "X");
  const digest = crypto.createHmac("sha256", String(serverSecret || "madreseyar")).update(`${student?.id}|${exam?.id}`).digest("hex").slice(0, 8).toUpperCase();
  return `MSY-${studentPart}-${examPart}-${digest}`;
}

function studentClassIds(db, student) {
  const ids = new Set();
  if (student?.classId) ids.add(String(student.classId));
  for (const e of db.enrollments || []) {
    if (String(e.studentId || "") === String(student?.id || "") && e.status !== "inactive" && e.status !== "archived" && e.classId) ids.add(String(e.classId));
  }
  return ids;
}

/* v61.12.0.0 — server-side exam schedule enforcement */
function examScheduleStateV6111(exam, now=Date.now()) {
  const raw=String(exam?.status||exam?.state||"").toLowerCase();
  const startRaw=exam?.startAt||exam?.startedAt||exam?.startTime||exam?.scheduledAt;
  const endRaw=exam?.endAt||exam?.finishedAt||exam?.completedAt||exam?.closedAt||exam?.endedAt||exam?.endTime;
  const start=startRaw?new Date(startRaw).getTime():NaN;
  const end=endRaw?new Date(endRaw).getTime():NaN;
  if(Number.isFinite(end)&&now>=end)return "ended";
  if(Number.isFinite(start)&&now<start)return "scheduled";
  if(["active","published","in_progress","running"].includes(raw))return "running";
  return raw||"draft";
}
function studentCanStartExamV6111(exam, now=Date.now()) {
  return examScheduleStateV6111(exam,now)==="running";
}
/* v62 — explicit availability contract shared with Student */
function examAvailabilityV62(exam, now=Date.now()) {
  const scheduleState=examScheduleStateV6111(exam,now);
  const publicationState=String(exam?.publicationState||"").toLowerCase();
  const visible=String(exam?.status||"").toLowerCase()==="active" || ["published","in_progress","ended","graded","final"].includes(publicationState);
  let state=scheduleState;
  if(!visible) state="withdrawn";
  else if(["ended","graded","final","archived"].includes(publicationState)) state="ended";
  const startAt=exam?.startAt||exam?.scheduledAt||exam?.startTime||"";
  const endAt=exam?.endAt||exam?.endTime||exam?.deadline||exam?.finishedAt||exam?.closedAt||"";
  return {availabilityState:state,startAt,endAt,publicationState,availabilityRevision:Number(exam?.availabilityRevision||1),canStart:state==="running",packageVersion:examPackageVersion(exam),serverTime:now};
}
function studentCanSeeExam(db, exam, student) {
  if (!exam || !student || exam.status === "archived") return false;
  const state = String(exam.publicationState || "").toLowerCase();
  const published = exam.status === "active" || ["published", "in_progress", "ended", "graded", "final"].includes(state);
  if (!published) return false;
  const classIds = studentClassIds(db, student);
  const explicitStudents = [exam.studentIds, exam.recipientStudentIds, exam.assignedStudentIds].flatMap(x => Array.isArray(x) ? x : []);
  if (explicitStudents.length) return explicitStudents.map(String).includes(String(student.id));
  const explicitClasses = [exam.classIds, exam.recipientClassIds, exam.assignedClassIds].flatMap(x => Array.isArray(x) ? x : []);
  if (explicitClasses.length) return explicitClasses.map(String).some(id => classIds.has(String(id)));
  return classIds.has(String(exam.classId || ""));
}
function studentCanSeeHomework(db, homework, student) {
  if (!homework || !student || homework.status === "archived" || homework.status === "closed") return false;
  const activeYear=String(db.school?.year||"");
  if (homework.academicYear && String(homework.academicYear)!==activeYear) return false;
  const state = String(homework.publicationState || homework.state || "").toLowerCase();
  if (["draft", "archived", "closed"].includes(state) || homework.published === false) return false;
  const classIds = studentClassIds(db, student);
  const explicitStudents = [homework.studentIds, homework.recipientStudentIds, homework.assignedStudentIds].flatMap(x => Array.isArray(x) ? x : []);
  if (explicitStudents.length) return explicitStudents.map(String).includes(String(student.id));
  const explicitClasses = [homework.classIds, homework.recipientClassIds, homework.assignedClassIds].flatMap(x => Array.isArray(x) ? x : []);
  if (explicitClasses.length) return explicitClasses.map(String).some(id => classIds.has(String(id)));
  return classIds.has(String(homework.classId || ""));
}

function studentExamStatus(db, exam, studentId) {
  if ((db.attempts || []).some(a => a.examId === exam.id && a.studentId === studentId)) return "submitted";
  if ((db.submissions || []).some(s => s.examId === exam.id && s.studentId === studentId)) return "submitted";
  return exam.status === "active" ? "available" : exam.status;
}

function studentSubmissionInfo(db, exam, studentId) {
  const attempt = (db.attempts || []).find(a => a.examId === exam.id && a.studentId === studentId);
  if (attempt) return { status:"submitted", kind:"mcq", receiptId:attempt.id, submittedAt:Number(attempt.submittedAt||0), gradingStatus:"final", score:Number(attempt.score||0), total:Number(attempt.total||examTotalScore(exam)) };
  const submission = (db.submissions || []).find(s => s.examId === exam.id && s.studentId === studentId);
  if (!submission) return null;
  const grade = (db.grades || []).find(g => g.submissionId === submission.id && String(g.publishStatus || "published") === "published");
  return { status:"submitted", kind:exam.type==="mixed"?"mixed":"descriptive", receiptId:submission.id, submittedAt:Number(submission.submittedAt||0), gradingStatus:grade?"final":"pending", score:grade?Number(grade.finalScore||0):null, total:Number(examTotalScore(exam)), autoScore:Number(submission.autoGrading?.score||0), autoTotal:Number(submission.autoGrading?.total||0) };
}

function studentReport(db, studentId) {
  const activeYear = String(db.school?.year || "");
  const bySubject = new Map();
  for (const attempt of db.attempts || []) {
    if (attempt.studentId !== studentId) continue;
    const exam = (db.exams || []).find(e => e.id === attempt.examId);
    if (!exam || String(exam.academicYear || activeYear) !== activeYear) continue;
    const row = bySubject.get(exam.subject) || { subject: exam.subject, earned: 0, possible: 0, count: 0 };
    row.earned += Number(attempt.score || 0); row.possible += Number(attempt.total || examTotalScore(exam)); row.count += 1; bySubject.set(exam.subject, row);
  }
  for (const grade of db.grades || []) {
    if (String(grade.publishStatus || "published") !== "published") continue;
    const submission = (db.submissions || []).find(s => s.id === grade.submissionId);
    if (!submission || submission.studentId !== studentId) continue;
    const exam = (db.exams || []).find(e => e.id === submission.examId);
    if (!exam || String(exam.academicYear || activeYear) !== activeYear) continue;
    const row = bySubject.get(exam.subject) || { subject: exam.subject, earned: 0, possible: 0, count: 0 };
    row.earned += Number(grade.finalScore || 0); row.possible += examTotalScore(exam); row.count += 1; bySubject.set(exam.subject, row);
  }
  return [...bySubject.values()].map(row => ({ ...row, percent: row.possible ? Math.round(row.earned / row.possible * 1000) / 10 : 0 }));
}


// ===== v185: student-visible final-term report =====
function gradingPolicyV200(db) {
  const settings = db.school?.settings || {};
  const scoreScaleRaw = Number(settings.scoreScale || 20);
  const scoreScale = Number.isFinite(scoreScaleRaw) && scoreScaleRaw > 0 ? scoreScaleRaw : 20;
  const raw = settings.gradingPolicy || {};
  const mode = raw.mode === "weighted" ? "weighted" : "additive";
  let continuousWeight = Number(raw.continuousWeight), finalWeight = Number(raw.finalWeight);
  if (!Number.isFinite(continuousWeight) || continuousWeight < 0 || continuousWeight > 100) continuousWeight = 40;
  if (!Number.isFinite(finalWeight) || finalWeight < 0 || finalWeight > 100) finalWeight = 60;
  if (mode === "weighted" && Math.abs(continuousWeight + finalWeight - 100) > 0.001) { continuousWeight = 40; finalWeight = 60; }
  return { mode, continuousWeight, finalWeight, scoreScale };
}
function calculateTermFinalV200(db, continuousScore, finalExamScore, finalExamPossible) {
  const p = gradingPolicyV200(db);
  const boundedContinuous = Math.min(p.scoreScale, Math.max(0, Number(continuousScore) || 0));
  const earned = Math.max(0, Number(finalExamScore) || 0);
  const possible = Math.max(0, Number(finalExamPossible) || 0);
  if (p.mode === "weighted") {
    const examNormalized = possible > 0 ? Math.min(p.scoreScale, (Math.min(earned, possible) / possible) * p.scoreScale) : 0;
    const raw = boundedContinuous * (p.continuousWeight / 100) + examNormalized * (p.finalWeight / 100);
    return { finalScore: Math.min(p.scoreScale, Math.max(0, Math.round(raw * 100) / 100)), rawFinalScore: raw, examNormalized: Math.round(examNormalized * 100) / 100, ...p, isCapped: false };
  }
  const raw = boundedContinuous + earned;
  return { finalScore: Math.min(p.scoreScale, Math.max(0, Math.round(raw * 100) / 100)), rawFinalScore: raw, examNormalized: possible > 0 ? Math.round((Math.min(earned, possible) / possible) * p.scoreScale * 100) / 100 : 0, ...p, isCapped: raw > p.scoreScale };
}

function termPolicyForV686(db,{classId="",subject="",academicYear="",academicPeriod="semester2"}={}){
  const scale=Number(db.school?.settings?.scoreScale||20)||20;
  const row=(db.termPolicies||[]).filter(p=>p.classId===classId&&p.subject===subject&&String(p.academicYear||"")===String(academicYear)&&String(p.academicPeriod||"semester2")===String(academicPeriod)).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")))[0];
  return normalizeTermPolicyCore(row||{continuousEnabled:false,continuousShare:0},scale);
}
function ongoingExamAverageV73(db,{studentId="",classId="",subject="",academicYear="",academicPeriod="semester2"}={}){
  const exams=(db.exams||[]).filter(e=>e.classId===classId&&e.subject===subject&&(e.examCategory||"ongoing")!=="final"&&String(e.academicYear||academicYear)===String(academicYear)&&String(e.academicPeriod||e.period||"semester2")===String(academicPeriod)&&e.status!=="draft");
  const scores=[];
  for(const exam of exams){
    const possible=Math.max(0,Number(examTotalScore(exam))||0);if(!possible)continue;let earned=null;
    if(exam.type==="mcq"){
      const att=(db.attempts||[]).filter(a=>a.examId===exam.id&&a.studentId===studentId&&(!a.status||["final","submitted","graded"].includes(String(a.status))||a.submittedAt)).sort((a,b)=>Number(b.submittedAt||b.updatedAt||0)-Number(a.submittedAt||a.updatedAt||0))[0];
      if(att&&Number.isFinite(Number(att.score)))earned=Math.min(possible,Math.max(0,Number(att.score)));
    }else{
      const sub=(db.submissions||[]).find(x=>x.examId===exam.id&&x.studentId===studentId);
      const grade=sub&&(db.grades||[]).filter(g=>g.submissionId===sub.id&&String(g.publishStatus||"published")==="published").sort((a,b)=>Number(b.gradedAt||b.updatedAt||0)-Number(a.gradedAt||a.updatedAt||0))[0];
      if(grade&&Number.isFinite(Number(grade.finalScore)))earned=Math.min(possible,Math.max(0,Number(grade.finalScore)));
    }
    if(earned!==null)scores.push(Math.min(20,Math.max(0,earned/possible*20)));
  }
  return scores.length?{average:Math.round(scores.reduce((n,v)=>n+v,0)/scores.length*100)/100,count:scores.length,scheduledCount:exams.length}: {average:null,count:0,scheduledCount:exams.length};
}
function continuousDetailForV732(db,{studentId="",classId="",subject="",academicYear="",academicPeriod="semester2"}={}){
  const exam=ongoingExamAverageV73(db,{studentId,classId,subject,academicYear,academicPeriod});
  const gradebook=gradebookContinuousV75(db,{studentId,classId,subject,academicYear,academicPeriod});
  const calculatedScore=exam.average!==null?exam.average:gradebook.score;
  const override=(db.continuousGradeOverrides||[]).filter(r=>r.studentId===studentId&&r.classId===classId&&r.subject===subject&&String(r.academicYear||academicYear)===String(academicYear)&&String(r.academicPeriod||r.period||"semester2")===String(academicPeriod)&&r.active!==false).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")))[0]||null;
  const finalScore=override&&Number.isFinite(Number(override.finalScore))?Math.min(20,Math.max(0,Number(override.finalScore))):calculatedScore;
  return {calculatedScore,finalScore,manual:!!override,overrideReason:override?.reason||"",examAverage:exam.average,examCount:exam.count,scheduledExamCount:exam.scheduledCount,gradebookFallback:exam.average===null&&gradebook.score!==null,override};
}
function continuousAverageForV686(db,{studentId="",classId="",subject="",academicYear="",academicPeriod="semester2"}={}){
  const detail=continuousDetailForV732(db,{studentId,classId,subject,academicYear,academicPeriod});
  if(detail.finalScore!==null)return detail.finalScore;
  // Backward-compatible fallback for schools that already have manual continuous-assessment records.
  const rows=(db.continuousAssessments||[]).filter(r=>r.studentId===studentId&&r.classId===classId&&r.subject===subject&&String(r.academicYear||academicYear)===String(academicYear)&&String(r.academicPeriod||r.period||"semester2")===String(academicPeriod));
  return continuousAverage20Core(rows);
}
function termAttendanceSummaryV733(db,studentId,academicPeriod="semester2",academicYear=String(db.school?.year||"")){
  const period=academicPeriod==="semester1"?"semester1":"semester2";
  const rows=(db.attendance||[]).filter(r=>r.studentId===studentId&&String(r.academicYear||academicYear)===String(academicYear)&&String(r.academicPeriod||r.period||"semester2")===period);
  const out={present:0,late:0,absent:0,pending:0,excused:0,unexcused:0,total:rows.length};
  for(const r of rows){const st=normalizeAttendanceStatusV81(r.status);if(st==="present")out.present++;else if(st==="late")out.late++;else{out.absent++;if(st==="absent_excused")out.excused++;else if(st==="absent_unexcused")out.unexcused++;else out.pending++;}}
  return out;
}
// compatibility contract: termReport: studentTermReportV185(db, student.id)
// compatibility v199: (e.examCategory || "ongoing") === "final"
function studentTermReportV185(db, studentId, academicPeriod="semester2") {
  const normalizePeriodLocal=v=>["semester1","semester2","annual"].includes(String(v))?String(v):"semester2";
  academicPeriod=normalizePeriodLocal(academicPeriod);
  if(academicPeriod==="annual"){
    const first=studentTermReportV185(db,studentId,"semester1"),second=studentTermReportV185(db,studentId,"semester2");
    const settings=db.school?.settings||{},subjects=combineAnnualSubjectRows(first.completeSubjects||[],second.completeSubjects||[],settings);
    const graded=subjects.filter(r=>r.finalScore!==null),average=graded.length?Math.round(graded.reduce((n,r)=>n+Number(r.finalScore),0)/graded.length*100)/100:null;
    const passing=Number(settings.passingScore||10),failedCount=graded.filter(r=>Number(r.finalScore)<passing).length,pendingCount=subjects.length-graded.length;
    const official=(db.reportCards||[]).filter(r=>r.studentId===studentId&&String(r.academicYear||"")===String(db.school?.year||"")&&normalizePeriodLocal(r.academicPeriod||r.period)==="annual").sort((a,b)=>String(b.updatedAt||b.createdAt||"").localeCompare(String(a.updatedAt||a.createdAt||"")))[0]||null;
    const published=official?.status==="published"?official:null;
    return {subjects,completeSubjects:subjects,average,subjectAverage:average,academicYear:db.school?.year||"",academicPeriod:"annual",scoreScale:Number(settings.scoreScale||20),passingScore:passing,gradingPolicy:first.gradingPolicy||second.gradingPolicy,
      disciplineScore:published?.disciplineScore??null,cultivationScore:published?.cultivationScore??null,teacherComment:published?.teacherComment||"",managerComment:published?.managerComment||"",reportCardStatus:published?"published":"unpublished",officialCard:published||null,
      attendanceSummary:{present:Number(first.attendanceSummary?.present||0)+Number(second.attendanceSummary?.present||0),late:Number(first.attendanceSummary?.late||0)+Number(second.attendanceSummary?.late||0),absent:Number(first.attendanceSummary?.absent||0)+Number(second.attendanceSummary?.absent||0),pending:Number(first.attendanceSummary?.pending||0)+Number(second.attendanceSummary?.pending||0),excused:Number(first.attendanceSummary?.excused||0)+Number(second.attendanceSummary?.excused||0),unexcused:Number(first.attendanceSummary?.unexcused||0)+Number(second.attendanceSummary?.unexcused||0),total:Number(first.attendanceSummary?.total||0)+Number(second.attendanceSummary?.total||0)},
      summary:{gradedSubjects:graded.length,totalSubjects:subjects.length,failedCount,pendingCount,overallStatus:pendingCount?"incomplete":failedCount?"needs_followup":"passed"}};
  }
  const student = (db.users || []).find(u => u.id === studentId && u.role === "student");
  const academicYear = db.school?.year || "";
  const scoreScaleRaw = Number(db.school?.settings?.scoreScale || 20);
  const scoreScale = Number.isFinite(scoreScaleRaw) && scoreScaleRaw > 0 ? scoreScaleRaw : 20;
  const passingScoreRaw=Number(db.school?.settings?.passingScore||10),passingScore=Number.isFinite(passingScoreRaw)?passingScoreRaw:10;
  const rawPolicy = db.school?.settings?.gradingPolicy || {};
  const policy = { mode: rawPolicy.mode === "weighted" ? "weighted" : "additive", continuousWeight: Number(rawPolicy.continuousWeight), finalWeight: Number(rawPolicy.finalWeight), scoreScale };
  if (!Number.isFinite(policy.continuousWeight) || policy.continuousWeight < 0 || policy.continuousWeight > 100) policy.continuousWeight = 40;
  if (!Number.isFinite(policy.finalWeight) || policy.finalWeight < 0 || policy.finalWeight > 100) policy.finalWeight = 60;
  if (policy.mode === "weighted" && Math.abs(policy.continuousWeight + policy.finalWeight - 100) > 0.001) { policy.continuousWeight = 40; policy.finalWeight = 60; }
  const boundedScore = value => Math.min(scoreScale, Math.max(0, Number(value) || 0));
  if (!student) return { subjects: [], completeSubjects:[], average: null, academicYear, scoreScale, gradingPolicy:policy, officialCard:null };
  const activeTermGrades = (db.termGrades || []).filter(r => {
    if(r.studentId!==studentId)return false;
    const rowYear=String(r.academicYear||academicYear);
    const rowPeriod=(r.academicPeriod||r.period)?(normalizePeriodLocal(r.academicPeriod||r.period)==="annual"?"semester2":normalizePeriodLocal(r.academicPeriod||r.period)):"semester2";
    return rowYear===String(academicYear)&&rowPeriod===academicPeriod;
  });
  const gradeNum=Number(student.grade || (db.school?.classes||[]).find(c=>c.id===student.classId)?.grade || 0);
  const curriculumSubjects=(db.curriculum||[]).filter(b=>!gradeNum||Number(b.grade)===gradeNum||String(b.gradeId||"")===String((db.school?.grades||[]).find(g=>Number(g.grade)===gradeNum)?.id||"")).map(b=>b.subject).filter(Boolean);
  const subjects = Array.from(new Set([...(db.school?.subjects || []), ...curriculumSubjects, ...activeTermGrades.map(r => r.subject).filter(Boolean)]));
  const rows = [],completeRows=[];
  for (const subject of subjects) {
    const key = `${studentId}__${subject}__${academicYear}__${academicPeriod}`;
    const rec = activeTermGrades.find(r => r.key === key) || activeTermGrades.find(r => r.studentId === studentId && r.subject === subject);
    const continuousDetail=continuousDetailForV732(db,{studentId,classId:student.classId,subject,academicYear,academicPeriod});
    const calculatedContinuous=continuousAverageForV686(db,{studentId,classId:student.classId,subject,academicYear,academicPeriod});
    const approvedContinuous=(db.continuousGradeOverrides||[]).filter(r=>r.active!==false&&r.studentId===studentId&&r.classId===student.classId&&r.subject===subject&&String(r.academicYear||academicYear)===String(academicYear)&&String(r.academicPeriod||r.period||"semester2")===academicPeriod&&Number.isFinite(Number(r.approvedRawScore))&&Number(r.approvedMaxScore)>0).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")))[0]||null;
    const legacyContinuous=rec&&rec.continuousScore!==null&&rec.continuousScore!==undefined&&rec.continuousScore!==""?boundedScore(rec.continuousScore):null;
    const continuousScore=calculatedContinuous!==null?calculatedContinuous:legacyContinuous;
    const hasContinuous=continuousScore!==null||!!approvedContinuous;
    const exams = (db.exams || []).filter(e => {
      if(e.subject!==subject||(e.examCategory||"ongoing")!=="final"||e.classId!==student.classId||String(e.academicYear||academicYear)!==String(academicYear))return false;
      const ep=(e.academicPeriod||e.period)?normalizePeriodLocal(e.academicPeriod||e.period):"semester2";
      return (ep==="annual"?"semester2":ep)===academicPeriod;
    });
    let finalExamScore = 0, finalExamPossible = 0, publishedExamCount = 0;
    for (const exam of exams) {
      let score = null;
      const examPossible = Math.max(0, Number(examTotalScore(exam)) || 0);
      if (exam.type === "mcq") {
        const attempt = (db.attempts || []).filter(a => a.examId === exam.id && a.studentId === studentId && (!a.status || a.status === "final" || a.status === "submitted" || a.submittedAt)).sort((a,b)=>Number(b.submittedAt||b.updatedAt||0)-Number(a.submittedAt||a.updatedAt||0))[0];
        if (attempt && Number.isFinite(Number(attempt.score))) score = Math.min(examPossible, Math.max(0, Number(attempt.score)));
      } else {
        const submission = (db.submissions || []).find(x => x.examId === exam.id && x.studentId === studentId);
        const grade = submission && (db.grades || []).filter(g => g.submissionId === submission.id && String(g.publishStatus || "published") === "published").sort((a,b)=>Number(b.gradedAt||0)-Number(a.gradedAt||0))[0];
        if (grade && Number.isFinite(Number(grade.finalScore))) score = Math.min(examPossible, Math.max(0, Number(grade.finalScore)));
      }
      if (score !== null) { finalExamScore += score; finalExamPossible += examPossible; publishedExamCount++; }
    }
    // P67.19 — share is defined by gradebook config, not the student's approved score.
    const {continuousMax,finalMax}=gradebookSharesV6719(db,{classId:student.classId,subject,academicYear,academicPeriod});
    const manualFinal=(db.termFinalOverrides||[]).filter(r=>r.active!==false&&r.studentId===studentId&&r.classId===student.classId&&r.subject===subject&&String(r.academicYear||academicYear)===String(academicYear)&&String(r.academicPeriod||"semester2")===academicPeriod).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")))[0]||null;
    const finalMarkNeedsReview=invalidTermFinalV6719(manualFinal,finalMax);
    if(manualFinal&&!finalMarkNeedsReview){
      // A teacher-entered final mark is already an absolute mark; do not re-scale using an old maxScore.
      finalExamScore=Number(manualFinal.score);finalExamPossible=finalMax;publishedExamCount=1;
    }
    const continuousPart=approvedContinuous
      ? Math.min(continuousMax,Math.max(0,Number(approvedContinuous.approvedRawScore)/Number(approvedContinuous.approvedMaxScore)*continuousMax))
      : continuousScore!==null?Math.min(continuousMax,Math.max(0,Number(continuousScore)/20*continuousMax)):0;
    const finalPart=manualFinal&&!finalMarkNeedsReview
      ? Number(manualFinal.score)
      : finalExamPossible>0?Math.round(Math.min(1,Math.max(0,finalExamScore/finalExamPossible))*finalMax*100)/100:0;
    const parts={continuousComponent:Math.round(continuousPart*100)/100,finalComponent:Math.round(finalPart*100)/100,
      total:Math.round(Math.min(20,Math.max(0,continuousPart+finalPart))*100)/100,
      continuousShare:continuousMax,finalShare:finalMax,formula:`مستمر (از ${continuousMax}) + پایانی (از ${finalMax})`};
    const hasFinal=publishedExamCount>0&&!finalMarkNeedsReview;
    // Old out-of-range approvals are preserved for review, but cannot silently enter the report card.
    const finalScore=finalMarkNeedsReview?null:(hasContinuous||hasFinal)?Math.round(Math.min(20,Math.max(0,Number(parts.total)||0))*100)/100:null;
    const examNormalized=hasFinal&&finalExamPossible>0?Math.round((Math.min(finalExamScore,finalExamPossible)/finalExamPossible)*20*100)/100:0,isCapped=false;
    if(finalScore!==null){
      rows.push({subject,continuousScore:parts.continuousComponent,continuousAverage20:continuousScore,continuousCalculatedScore:continuousDetail.calculatedScore,continuousManual:continuousDetail.manual,continuousOverrideReason:continuousDetail.overrideReason,continuousExamCount:continuousDetail.examCount,continuousScheduledExamCount:continuousDetail.scheduledExamCount,continuousComponent:parts.continuousComponent,continuousShare:parts.continuousShare,finalShare:parts.finalShare,finalExamScore,finalExamPossible,finalExamNormalized:examNormalized,finalComponent:parts.finalComponent,finalScore,examCount:publishedExamCount,scoreScale,isCapped,gradingMode:"share20",continuousWeight:parts.continuousShare*5,finalWeight:parts.finalShare*5,formula:parts.formula,passed:finalScore>=passingScore});
    }
    completeRows.push({subject,continuousScore:hasContinuous?parts.continuousComponent:null,continuousAverage20:hasContinuous?continuousScore:null,continuousCalculatedScore:continuousDetail.calculatedScore,continuousManual:continuousDetail.manual,continuousOverrideReason:continuousDetail.overrideReason,continuousExamCount:continuousDetail.examCount,continuousScheduledExamCount:continuousDetail.scheduledExamCount,continuousComponent:hasContinuous?parts.continuousComponent:null,continuousShare:parts.continuousShare,finalShare:parts.finalShare,finalExamScore:hasFinal?finalExamScore:null,finalExamPossible:hasFinal?finalExamPossible:null,finalExamNormalized:hasFinal?examNormalized:null,finalComponent:hasFinal?parts.finalComponent:null,finalScore,examCount:publishedExamCount,scoreScale,gradingMode:"share20",continuousWeight:parts.continuousShare*5,finalWeight:parts.finalShare*5,formula:parts.formula,finalMarkNeedsReview,status:finalMarkNeedsReview?"needs_review":finalScore===null?"pending":finalScore>=passingScore?"passed":"failed"});
  }
  const average = rows.length ? Math.round((rows.reduce((n,r)=>n+Number(r.finalScore||0),0) / rows.length) * 100) / 100 : null;
  const official=(db.reportCards||[]).filter(r=>r.studentId===studentId&&String(r.academicYear||"")===String(academicYear)&&((r.academicPeriod||r.period)?normalizePeriodLocal(r.academicPeriod||r.period):"semester2")===academicPeriod).sort((a,b)=>String(b.updatedAt||b.createdAt||"").localeCompare(String(a.updatedAt||a.createdAt||"")))[0]||null;
  const publishedOfficial=official?.status==="published"?official:null;
  const disciplineScore=publishedOfficial&&Number.isFinite(Number(publishedOfficial.disciplineScore))?boundedScore(publishedOfficial.disciplineScore):null;
  const cultivationScore=publishedOfficial&&Number.isFinite(Number(publishedOfficial.cultivationScore))?boundedScore(publishedOfficial.cultivationScore):null;
  const failedCount=completeRows.filter(r=>r.finalScore!==null&&r.finalScore<passingScore).length,pendingCount=completeRows.filter(r=>r.finalScore===null).length;
  const overallStatus=pendingCount>0?"incomplete":failedCount>0?"needs_followup":"passed";
  return { subjects: rows, completeSubjects:completeRows, average, subjectAverage:average, academicYear, academicPeriod, scoreScale, passingScore, gradingPolicy: policy,
    disciplineScore,cultivationScore,teacherComment:publishedOfficial?.teacherComment||"",managerComment:publishedOfficial?.managerComment||"",reportCardStatus:publishedOfficial?"published":"unpublished",
    officialCard:publishedOfficial?{id:publishedOfficial.id,status:"published",disciplineScore,cultivationScore,teacherComment:publishedOfficial.teacherComment||"",managerComment:publishedOfficial.managerComment||"",publishedAt:publishedOfficial.publishedAt||null,updatedAt:publishedOfficial.updatedAt||publishedOfficial.createdAt||null}:null,
    attendanceSummary:termAttendanceSummaryV733(db,studentId,academicPeriod,academicYear),
    summary:{gradedSubjects:rows.length,totalSubjects:completeRows.length,failedCount,pendingCount,overallStatus}
  };
}

// ===== v45.18: پرونده تحلیلی دانش‌آموز برای معلم و اولیا =====
const ACADEMIC_PERIODS_V4518 = {
  week: { label: "هفتگی", days: 7 },
  month: { label: "ماهانه", days: 30 },
  quarter: { label: "سه‌ماهه", days: 90 },
  semester: { label: "نیم‌سال", days: 180 },
  year: { label: "پایان سال", days: 365 }
};
function timestampV4518(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const n = Number(value); if (Number.isFinite(n) && n > 1e9) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(value)); return Number.isFinite(parsed) ? parsed : 0;
}
function rowTimestampV4518(row, keys=["submittedAt","gradedAt","updatedAt","createdAt","date","at"]) {
  for (const key of keys) { const t=timestampV4518(row?.[key]); if(t) return t; }
  return 0;
}
function periodWindowV4518(period="month", now=Date.now()) {
  const key=ACADEMIC_PERIODS_V4518[period]?period:"month", cfg=ACADEMIC_PERIODS_V4518[key], span=cfg.days*86400000;
  return { key, label:cfg.label, days:cfg.days, start:now-span, end:now, previousStart:now-span*2, previousEnd:now-span };
}
function finalExamOutcomesV4518(db, studentId) {
  const activeYear=String(db.school?.year||"");
  const out=[];
  for(const attempt of db.attempts||[]){
    if(attempt.studentId!==studentId)continue; const exam=(db.exams||[]).find(e=>e.id===attempt.examId); if(!exam||String(exam.academicYear||activeYear)!==activeYear)continue;
    const total=Number(attempt.total||examTotalScore(exam)||0), score=Number(attempt.score||0), ts=rowTimestampV4518(attempt);
    out.push({id:attempt.id,examId:exam.id,title:exam.title,subject:exam.subject||"",chapter:exam.chapter||"",type:"mcq",score,total,percent:total?Math.round(score/total*1000)/10:0,timestamp:ts,submittedAt:attempt.submittedAt||0,status:"final"});
  }
  for(const grade of db.grades||[]){
    if(String(grade.publishStatus||"published")!=="published")continue;
    const sub=(db.submissions||[]).find(x=>x.id===grade.submissionId); if(!sub||sub.studentId!==studentId)continue; const exam=(db.exams||[]).find(e=>e.id===sub.examId); if(!exam||String(exam.academicYear||activeYear)!==activeYear)continue;
    const total=Number(examTotalScore(exam)||0), score=Number(grade.finalScore||0), ts=rowTimestampV4518(grade)||rowTimestampV4518(sub);
    out.push({id:grade.id,examId:exam.id,title:exam.title,subject:exam.subject||"",chapter:exam.chapter||"",type:"descriptive",score,total,percent:total?Math.round(score/total*1000)/10:0,timestamp:ts,submittedAt:sub.submittedAt||0,status:"final"});
  }
  return out.sort((a,b)=>b.timestamp-a.timestamp);
}
function weightedPercentV4518(rows){const earned=rows.reduce((a,x)=>a+Number(x.score||0),0),possible=rows.reduce((a,x)=>a+Number(x.total||0),0);return possible?Math.round(earned/possible*1000)/10:null;}
function academicStatusV4518(avg){if(avg===null||avg===undefined)return {key:"no_data",label:"بدون داده کافی"};if(avg>=85)return {key:"excellent",label:"عالی"};if(avg>=70)return {key:"good",label:"خوب"};if(avg>=50)return {key:"needs_practice",label:"نیازمند تقویت"};return {key:"needs_attention",label:"نیازمند پیگیری"};}
function trendStatusV4518(current,previous){if(current===null||previous===null)return {key:"no_data",label:"داده کافی برای مقایسه نیست",delta:null};const delta=Math.round((current-previous)*10)/10;if(delta>=5)return {key:"progress",label:"پیشرفت",delta};if(delta<=-5)return {key:"regression",label:"پسرفت",delta};return {key:"stable",label:"تقریباً ثابت",delta};}
function academicAnalyticsV4518(db, studentId, period="month", subject="", options={}) {
  const student=(db.users||[]).find(u=>u.id===studentId&&u.role==="student"); if(!student)return null;
  const activeYear=String(db.school?.year||"");
  const w=periodWindowV4518(period), all=finalExamOutcomesV4518(db,studentId).filter(x=>!subject||x.subject===subject);
  const current=all.filter(x=>x.timestamp>=w.start&&x.timestamp<=w.end), previous=all.filter(x=>x.timestamp>=w.previousStart&&x.timestamp<w.previousEnd);
  const currentAvg=weightedPercentV4518(current), previousAvg=weightedPercentV4518(previous), status=academicStatusV4518(currentAvg), trend=trendStatusV4518(currentAvg,previousAvg);
  const subjectMap=new Map(); for(const row of current){const x=subjectMap.get(row.subject)||{subject:row.subject,earned:0,possible:0,count:0,chapters:new Map()};x.earned+=row.score;x.possible+=row.total;x.count++;const ch=x.chapters.get(row.chapter||"بدون فصل")||{chapter:row.chapter||"بدون فصل",earned:0,possible:0,count:0};ch.earned+=row.score;ch.possible+=row.total;ch.count++;x.chapters.set(ch.chapter,ch);subjectMap.set(row.subject,x);}
  const subjects=[...subjectMap.values()].map(x=>({subject:x.subject,count:x.count,percent:x.possible?Math.round(x.earned/x.possible*1000)/10:0,chapters:[...x.chapters.values()].map(c=>({...c,percent:c.possible?Math.round(c.earned/c.possible*1000)/10:0})).sort((a,b)=>a.percent-b.percent)})).sort((a,b)=>b.percent-a.percent);
  const weakAreas=subjects.flatMap(x=>x.chapters.filter(c=>c.percent<60).map(c=>({subject:x.subject,chapter:c.chapter,percent:c.percent,count:c.count}))).sort((a,b)=>a.percent-b.percent).slice(0,8);
  const attendance=(db.attendance||[]).filter(a=>a.studentId===studentId&&String(a.academicYear||activeYear)===activeYear).filter(a=>{const t=rowTimestampV4518(a);if(!t)return period==="year";return t>=w.start&&t<=w.end;});
  const attendanceSummary={present:attendance.filter(a=>normalizeAttendanceStatusV81(a.status)==="present").length,absent:attendance.filter(a=>isAbsentStatusV81(a.status)).length,pending:attendance.filter(a=>normalizeAttendanceStatusV81(a.status)==="absent_pending").length,late:attendance.filter(a=>normalizeAttendanceStatusV81(a.status)==="late").length,excused:attendance.filter(a=>normalizeAttendanceStatusV81(a.status)==="absent_excused").length,unexcused:attendance.filter(a=>normalizeAttendanceStatusV81(a.status)==="absent_unexcused").length,total:attendance.length};
  const homeworks=(db.homework||[]).filter(h=>h.classId===student.classId&&String(h.academicYear||activeYear)===activeYear&&(!subject||h.subject===subject)); const hwIds=new Set(homeworks.map(h=>h.id));
  const hwSub=(db.homeworkSubmissions||[]).filter(x=>x.studentId===studentId&&hwIds.has(x.homeworkId)).filter(x=>{const t=rowTimestampV4518(x);if(!t)return period==="year";return t>=w.start&&t<=w.end;});
  const hwScored=hwSub.filter(x=>Number.isFinite(Number(x.score))); const homeworkSummary={submitted:hwSub.length,graded:hwScored.length,averageScore:hwScored.length?Math.round(hwScored.reduce((a,x)=>a+Number(x.score||0),0)/hwScored.length*10)/10:null};
  const notes=(db.progressReports||[]).filter(r=>r.studentId===studentId&&String(r.academicYear||activeYear)===activeYear&&r.type==="academic_analysis"&&(!subject||!r.subject||r.subject===subject)&&(!options.guardianOnly||r.guardianVisible!==false)&&r.status==="published").sort((a,b)=>rowTimestampV4518(b,["createdAtIso","publishedAtIso","createdAt","publishedAt"])-rowTimestampV4518(a,["createdAtIso","publishedAtIso","createdAt","publishedAt"]));
  const currentPeriodNotes=notes.filter(r=>r.period===w.key).slice(0,10);
  const availableSubjects=[...new Set([...(db.exams||[]).filter(e=>e.classId===student.classId&&String(e.academicYear||activeYear)===activeYear).map(e=>e.subject).filter(Boolean),...all.map(x=>x.subject).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,"fa"));
  return {student:publicStudent(student,db),period:w,subject:subject||"",availableSubjects,current:{averagePercent:currentAvg,examCount:current.length,earned:current.reduce((a,x)=>a+x.score,0),possible:current.reduce((a,x)=>a+x.total,0)},previous:{averagePercent:previousAvg,examCount:previous.length},status,trend,exams:current.slice(0,30),subjects,weakAreas,attendance:attendanceSummary,homework:homeworkSummary,teacherNotes:currentPeriodNotes.map(r=>({id:r.id,teacherName:r.teacherName||"معلم",teacherComment:r.teacherComment||r.summary||"",subject:r.subject||"",period:r.period||"",periodLabel:r.periodLabel||"",createdAt:r.publishedAt||r.createdAt||"",guardianVisible:r.guardianVisible!==false})),generatedAt:new Date().toISOString()};
}
function staffCanViewAnalysisV4518(db,user,studentId,subject="") {
  if(["admin","superadmin"].includes(user?.role))return true; if(user?.role!=="teacher")return false;
  const student=(db.users||[]).find(u=>u.id===studentId&&u.role==="student"); if(!student)return false; const scope=teacherScope(db,user); if(!scope.studentIds.has(studentId))return false;
  if(subject&&!activeTeachingAssignments(db,user,"reports").some(a=>a.classId===student.classId&&(!a.subject||a.subject===subject)))return false; return true;
}


// ===== v45.21: پرونده جامع دانش‌آموز و داده PDF رسمی =====
function maskGuardianNationalIdV4521(value){const s=normalizeNationalId(value);return /^\d{10}$/.test(s)?`${s.slice(0,3)}****${s.slice(-3)}`:"";}
function disciplineSummaryV4521(db,studentId){
  const activeYear=String(db.school?.year||"");
  const rows=(db.behaviorRecords||[]).filter(x=>x.studentId===studentId&&String(x.academicYear||activeYear)===activeYear),negative=rows.filter(x=>x.kind==="negative"||x.type==="negative").length,positive=rows.filter(x=>x.kind==="positive"||x.type==="positive").length;
  const points=rows.reduce((a,x)=>a+Number(x.points||0),0);let label="خیلی خوب";if(negative>=5||points<=-10)label="نیازمند پیگیری";else if(negative>=2||points<0)label="خوب";
  return {label,positive,negative,points,total:rows.length};
}
// ===== 72.35-p1 — پرونده حرفه‌ای و ساختاریافته دانش‌آموز =====
const STUDENT_DOC_CHECKLIST_V734 = [
  {type:"identity",label:"مدرک هویتی دانش‌آموز"},
  {type:"guardian_identity",label:"مدرک هویتی ولی"},
  {type:"photo",label:"عکس پرسنلی"},
  {type:"enrollment",label:"فرم/مدرک ثبت‌نام"},
  {type:"consent",label:"رضایت‌نامه‌های مدرسه"}
];
function emptyStudentExtendedProfileV734(studentId=""){
  return {studentId,
    administrative:{admissionDate:"",registrationNo:"",enrollmentStatus:"active",previousSchool:"",previousSchoolCode:"",transferStatus:"new",shiftPreference:"",transportMode:"family",busRoute:"",lockerNo:""},
    identity:{preferredName:"",placeOfIssue:"",identitySerial:"",nationality:"ایرانی"},
    contact:{secondaryMobile:"",secondaryPhone:""},
    emergency:{secondaryName:"",secondaryRelation:"",secondaryMobile:""},
    health:{bloodType:"",allergies:"",medicalAlerts:"",medications:"",physicianName:"",physicianPhone:"",insuranceProvider:"",insuranceNo:"",emergencyInstructions:""},
    support:{learningSupport:"",accommodations:"",counselorFollowup:"",strengths:"",interests:""},
    logistics:{pickupAuthorization:"",dismissalNotes:""},
    consents:{photo:"pending",trip:"pending",onlineClass:"pending",emergencyTreatment:"pending"},
    internal:{registrationNote:"",confidentialNote:""},updatedAt:"",updatedBy:""};
}
function studentExtendedProfileV734(db,studentId){
  const row=(db.studentExtendedProfiles||[]).find(x=>x.studentId===studentId&&x.active!==false)||{};
  const base=emptyStudentExtendedProfileV734(studentId);
  for(const k of ["administrative","identity","contact","emergency","health","support","logistics","consents","internal"]) base[k]={...base[k],...(row[k]||{})};
  base.updatedAt=row.updatedAt||row.createdAt||"";base.updatedBy=row.updatedBy||row.createdBy||"";return base;
}
function textV734(value,max=300){return String(value??"").trim().slice(0,max);}
function consentV734(value){const v=String(value||"pending");return ["yes","no","pending"].includes(v)?v:"pending";}
function normalizeExtendedProfileV734(body={},studentId=""){
  const src=body&&typeof body==="object"?body:{};const a=src.administrative||{},i=src.identity||{},c=src.contact||{},e=src.emergency||{},h=src.health||{},sp=src.support||{},l=src.logistics||{},co=src.consents||{},n=src.internal||{};
  return {studentId,
    administrative:{admissionDate:textV734(a.admissionDate,20),registrationNo:textV734(a.registrationNo,50),enrollmentStatus:["active","conditional","inactive","transferred","graduated"].includes(String(a.enrollmentStatus))?String(a.enrollmentStatus):"active",previousSchool:textV734(a.previousSchool,160),previousSchoolCode:textV734(a.previousSchoolCode,60),transferStatus:["new","transferred_in","transferred_out","returning"].includes(String(a.transferStatus))?String(a.transferStatus):"new",shiftPreference:textV734(a.shiftPreference,40),transportMode:["family","walk","school_bus","public","other"].includes(String(a.transportMode))?String(a.transportMode):"family",busRoute:textV734(a.busRoute,100),lockerNo:textV734(a.lockerNo,40)},
    identity:{preferredName:textV734(i.preferredName,100),placeOfIssue:textV734(i.placeOfIssue,120),identitySerial:textV734(i.identitySerial,60),nationality:textV734(i.nationality,80)},
    contact:{secondaryMobile:normalizePhone(c.secondaryMobile),secondaryPhone:normalizePhone(c.secondaryPhone)},
    emergency:{secondaryName:textV734(e.secondaryName,120),secondaryRelation:textV734(e.secondaryRelation,60),secondaryMobile:normalizePhone(e.secondaryMobile)},
    health:{bloodType:textV734(h.bloodType,8),allergies:textV734(h.allergies,1200),medicalAlerts:textV734(h.medicalAlerts,1200),medications:textV734(h.medications,1200),physicianName:textV734(h.physicianName,120),physicianPhone:normalizePhone(h.physicianPhone),insuranceProvider:textV734(h.insuranceProvider,160),insuranceNo:textV734(h.insuranceNo,80),emergencyInstructions:textV734(h.emergencyInstructions,1600)},
    support:{learningSupport:textV734(sp.learningSupport,1800),accommodations:textV734(sp.accommodations,1800),counselorFollowup:textV734(sp.counselorFollowup,1800),strengths:textV734(sp.strengths,1200),interests:textV734(sp.interests,1200)},
    logistics:{pickupAuthorization:textV734(l.pickupAuthorization,1200),dismissalNotes:textV734(l.dismissalNotes,1200)},
    consents:{photo:consentV734(co.photo),trip:consentV734(co.trip),onlineClass:consentV734(co.onlineClass),emergencyTreatment:consentV734(co.emergencyTreatment)},
    internal:{registrationNote:textV734(n.registrationNote,2200),confidentialNote:textV734(n.confidentialNote,2200)}};
}
function safeExtendedProfileV734(profile,{includeSensitive=false,guardianOnly=false}={}){
  const out={administrative:{...profile.administrative},identity:{...profile.identity},contact:{...profile.contact},emergency:{...profile.emergency},support:{strengths:profile.support?.strengths||"",interests:profile.support?.interests||""},logistics:{...profile.logistics},consents:{...profile.consents},updatedAt:profile.updatedAt||""};
  if(includeSensitive&&!guardianOnly){out.health={...profile.health};out.support={...profile.support};out.internal={...profile.internal};}
  return out;
}
function profileCompletenessV734(db,student,profile){
  const checks=[student.firstName,student.lastName,student.nationalId,student.birthDate,student.studentCode,student.classId,student.fatherName||student.guardianMobile,student.emergencyGuardianMobile,student.address,profile.administrative?.admissionDate,profile.administrative?.registrationNo,profile.identity?.nationality];
  const coreDone=checks.filter(Boolean).length,docs=(db.studentDocuments||[]).filter(x=>x.studentId===student.id&&x.active!==false),types=new Set(docs.map(x=>x.documentType));
  const documentChecklist=STUDENT_DOC_CHECKLIST_V734.map(x=>({...x,present:types.has(x.type)}));const docsDone=documentChecklist.filter(x=>x.present).length;
  const score=Math.round(((coreDone/checks.length)*80)+((docsDone/documentChecklist.length)*20));
  return {score,level:score>=90?"complete":score>=70?"good":score>=45?"needs_attention":"incomplete",core:{done:coreDone,total:checks.length},documents:{done:docsDone,total:documentChecklist.length,items:documentChecklist}};
}
function profileDiffV734(before,after,prefix="",out=[]){
  const keys=new Set([...Object.keys(before||{}),...Object.keys(after||{})]);for(const key of keys){if(["updatedAt","updatedBy","createdAt","createdBy"].includes(key))continue;const a=before?.[key],b=after?.[key],path=prefix?`${prefix}.${key}`:key;if(a&&b&&typeof a==="object"&&typeof b==="object"&&!Array.isArray(a)&&!Array.isArray(b))profileDiffV734(a,b,path,out);else if(String(a??"")!==String(b??""))out.push({field:path,before:String(a??"").slice(0,300),after:String(b??"").slice(0,300)});}return out;
}

function buildStudentDossierV4521(db,studentId,{guardianOnly=false,includeSensitive=false}={}){
  const student=(db.users||[]).find(u=>u.id===studentId&&u.role==="student"&&u.profileStatus!=="deleted");if(!student)return null;
  const analysis=academicAnalyticsV4518(db,studentId,"year","",{guardianOnly});
  const finals=finalExamOutcomesV4518(db,studentId).slice().sort((a,b)=>a.timestamp-b.timestamp);
  const guardians=(db.guardianLinks||[]).filter(x=>x.studentId===studentId&&x.active!==false).map(link=>{const g=(db.guardians||[]).find(x=>x.id===link.guardianId)||{};return {id:g.id||link.guardianId||link.id,name:g.guardianName||g.name||link.guardianName||"ولی دانش‌آموز",relation:link.relation||"ولی",mobile:g.mobile||link.mobile||student.guardianMobile||"",nationalIdMasked:maskGuardianNationalIdV4521(g.nationalId||link.guardianNationalId||"")};});
  if(!guardians.length&&(student.guardianMobile||student.emergencyGuardianName))guardians.push({id:"legacy",name:student.emergencyGuardianName||"ولی دانش‌آموز",relation:student.emergencyGuardianRelation||"ولی",mobile:student.guardianMobile||student.emergencyGuardianMobile||"",nationalIdMasked:""});
  const activeYear=String(db.school?.year||"");
  const teacherNotes=(db.progressReports||[]).filter(r=>r.studentId===studentId&&String(r.academicYear||activeYear)===activeYear&&r.type==="academic_analysis"&&r.status==="published"&&(!guardianOnly||r.guardianVisible!==false)).slice().sort((a,b)=>rowTimestampV4518(b,["createdAtIso","publishedAtIso","createdAt","publishedAt"])-rowTimestampV4518(a,["createdAtIso","publishedAtIso","createdAt","publishedAt"])).slice(0,12).map(r=>({id:r.id,teacherId:r.teacherId||"",teacherName:r.teacherName||"معلم",teacherComment:r.teacherComment||r.summary||"",subject:r.subject||"",periodLabel:r.periodLabel||"",createdAt:r.publishedAt||r.createdAt||""}));
  const attendance=attendanceSummaryForStudent(db,studentId),discipline=disciplineSummaryV4521(db,studentId);
  const subjectRows=(analysis?.subjects||[]).slice().sort((a,b)=>b.percent-a.percent),strengths=subjectRows.filter(x=>x.percent>=75).slice(0,3),needs=subjectRows.filter(x=>x.percent<70).slice().sort((a,b)=>a.percent-b.percent).slice(0,3);
  const overall=weightedPercentV4518(finals),trend=analysis?.trend||{key:"no_data",label:"داده کافی نیست",delta:null},status=academicStatusV4518(overall);
  const classExams=(db.exams||[]).filter(e=>e.classId===student.classId&&String(e.academicYear||activeYear)===activeYear&&e.status!=="archived");
  const examRows=classExams.map(ex=>{const sub=studentSubmissionInfo(db,ex,studentId),total=Number(sub?.total||examTotalScore(ex)||0),score=sub?.gradingStatus==="final"?Number(sub.score||0):null,percent=score!==null&&total?Math.round(score/total*1000)/10:null;return {examId:ex.id,title:ex.title,subject:ex.subject||"",chapter:ex.chapter||"",type:ex.type||"",score,total,percent,status:sub?.gradingStatus==="final"?"final":sub?"pending":"missing",date:sub?.submittedAt?new Date(sub.submittedAt).toISOString():(ex.deadline||ex.createdAt||"")};}).sort((a,b)=>timestampV4518(b.date)-timestampV4518(a.date));
  const latestTeacherId=teacherNotes.find(n=>n.teacherId)?.teacherId||"",latestTeacher=(db.users||[]).find(u=>u.id===latestTeacherId&&u.role==="teacher");
  const termReport=studentTermReportV185(db,studentId);
  const enrollmentHistory=enrollmentHistoryForStudent(db,studentId);
  const documents=(db.studentDocuments||[]).filter(x=>x.studentId===studentId&&x.active!==false).slice().sort((a,b)=>String(b.createdAtIso||b.createdAt||"").localeCompare(String(a.createdAtIso||a.createdAt||""))).map(x=>({id:x.id,title:x.title||"مدرک",documentType:x.documentType||"other",fileKey:x.fileKey||"",issuedAt:x.issuedAt||"",expiresAt:x.expiresAt||"",note:x.note||"",verificationStatus:x.verificationStatus||"pending",verifiedAt:x.verifiedAt||"",createdAt:x.createdAt||x.createdAtIso||""}));
  const achievements=(db.achievements||[]).filter(x=>x.studentId===studentId&&x.active!==false).slice().sort((a,b)=>String(b.date||b.createdAt||"").localeCompare(String(a.date||a.createdAt||""))).slice(0,30);
  const extendedRaw=studentExtendedProfileV734(db,studentId),extendedProfile=safeExtendedProfileV734(extendedRaw,{includeSensitive,guardianOnly}),profileCompleteness=profileCompletenessV734(db,student,extendedRaw);
  const recordHistory=guardianOnly?[]:(db.recordHistory||[]).filter(x=>x.studentId===studentId).slice().sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||""))).slice(0,80);
  const termReports={semester1:studentTermReportV185(db,studentId,"semester1"),semester2:studentTermReportV185(db,studentId,"semester2"),annual:studentTermReportV185(db,studentId,"annual")};
  return {release:APP_RELEASE,school:{name:db.school?.name||SCHOOL_NAME,year:db.school?.year||"",academicYears:ensureAcademicYearModel(db.school),reportBranding:{organization:db.school?.reportBranding?.organization||"وزارت آموزش و پرورش",schoolName:db.school?.reportBranding?.schoolName||db.school?.name||SCHOOL_NAME,district:db.school?.reportBranding?.district||"",address:db.school?.reportBranding?.address||"",phone:db.school?.reportBranding?.phone||"",managerName:db.school?.reportBranding?.managerName||"",footerNote:db.school?.reportBranding?.footerNote||"",headerImageDataUrl:db.school?.reportBranding?.headerImageDataUrl||"",managerSignatureDataUrl:db.school?.reportBranding?.managerSignatureDataUrl||""}},student:publicStudent(student,db),extendedProfile,profileCompleteness,guardians,enrollmentHistory,documents,achievements,recordHistory,exams:examRows,analysis:{overallAveragePercent:overall,status,trend,subjects:subjectRows,weakAreas:analysis?.weakAreas||[],strengths,needs,attendance:analysis?.attendance||attendance,homework:analysis?.homework||{},teacherNotes},attendance,discipline,teacherNotes,termReport,termReports,signatures:{teacherName:latestTeacher?`${latestTeacher.firstName||""} ${latestTeacher.lastName||""}`.trim():(teacherNotes[0]?.teacherName||"معلم"),teacherSignatureDataUrl:latestTeacher?.signatureDataUrl||"",managerName:db.school?.reportBranding?.managerName||"مدیر مدرسه",managerSignatureDataUrl:db.school?.reportBranding?.managerSignatureDataUrl||""},generatedAt:new Date().toISOString()};
}


async function saveStudentFiles(submissionId, files) {
  await ensureDataDirs();
  const records = [];
  for (let i = 0; i < files.length; i++) {
    const source = files[i];
    if (!String(source.dataUrl || "").startsWith("data:")) throw Object.assign(new Error("فایل پاسخ معتبر نیست."), { status: 400 });
    const key = safeKey(`${submissionId}_${i}`);
    const record = { key, submissionId, name: String(source.name || `page-${i + 1}.jpg`), type: String(source.type || "image/jpeg"), size: Number(source.size || 0), dataUrl: source.dataUrl, savedAt: Date.now() };
    await atomicWriteText(path.join(FILES_DIR, `${key}.json`), JSON.stringify(record), 0o600);
    records.push({ key, name: record.name, type: record.type, size: record.size });
  }
  return records;
}


// ===== نسخه ۳۸: کارتابل مرکزی، جست‌وجوی سراسری و Timeline جامع دانش‌آموز =====
function v38Text(value){ return String(value ?? "").trim(); }
function v38Hay(...parts){ return parts.flat().map(v38Text).join(" ").toLocaleLowerCase("fa"); }
function v38DateValue(row){
  const raw=row?.submittedAt ?? row?.updatedAt ?? row?.createdAt ?? row?.date ?? row?.at ?? row?.savedAt ?? 0;
  if(typeof raw==="number") return raw;
  const text=String(raw||""); const parsed=Date.parse(text); if(Number.isFinite(parsed)) return parsed;
  const latin=text.replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const m=latin.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})(?:\D+(\d{1,2}))?(?:\D+(\d{1,2}))?/);
  return m ? Number(`${m[1]}${String(m[2]).padStart(2,"0")}${String(m[3]).padStart(2,"0")}${String(m[4]||0).padStart(2,"0")}${String(m[5]||0).padStart(2,"0")}`) : 0;
}
function v38StudentName(db,id){ const u=(db.users||[]).find(x=>x.id===id); return u?`${u.firstName||""} ${u.lastName||""}`.trim():"دانش‌آموز"; }
function v38ClassName(db,id){ return (db.school?.classes||[]).find(c=>c.id===id)?.name || "—"; }
function buildActionCenterV38(db,user){
  const items=[];
  const push=(kind,title,detail,target,priority="normal",refId="",studentId="")=>items.push({id:`${kind}:${refId||items.length}`,kind,title,detail,target,priority,refId,studentId});
  const gradesBySubmission=new Set((db.grades||[]).map(g=>g.submissionId));
  for(const sub of db.submissions||[]){
    if(sub.status==="final" || gradesBySubmission.has(sub.id)) continue;
    const ex=(db.exams||[]).find(e=>e.id===sub.examId); push("grading","برگه تشریحی در انتظار تصحیح",`${v38StudentName(db,sub.studentId)} · ${ex?.title||"آزمون"}`,user.role==="teacher"?"grading":"gradingCenter","high",sub.id,sub.studentId);
  }
  for(const a of db.appeals||[]){ if(!["open","reviewing"].includes(a.status)) continue; const ex=(db.exams||[]).find(e=>e.id===a.examId); push("appeal","اعتراض نیازمند رسیدگی",`${v38StudentName(db,a.studentId)} · ${ex?.title||"آزمون"}`,user.role==="teacher"?"appeals":"gradingCenter","high",a.id,a.studentId); }
  for(const hs of db.homeworkSubmissions||[]){ if(["graded","final"].includes(hs.status)) continue; const hw=(db.homework||[]).find(h=>h.id===hs.homeworkId); push("homework","تکلیف در انتظار بررسی",`${v38StudentName(db,hs.studentId)} · ${hw?.title||"تکلیف"}`,"classroom","normal",hs.id,hs.studentId); }
  for(const q of db.questionBank||[]){ if(!["draft","review","pending","needs_review"].includes(String(q.status||""))) continue; push("question","سؤال در انتظار تأیید",`${q.subject||""} · ${String(q.text||"").slice(0,70)}`,user.role==="teacher"?"bank":"questionCenter","normal",q.id); }
  for(const r of db.parentRequests||[]){ if(["closed","resolved","done","rejected"].includes(String(r.status||""))) continue; push("parent","درخواست خانواده",`${v38StudentName(db,r.studentId)} · ${r.title||r.type||"درخواست جدید"}`,user.role==="teacher"?"support":"familyadmin","normal",r.id,r.studentId); }
  for(const i of db.interventions||[]){ if(!["open","in_progress","urgent"].includes(String(i.status||""))) continue; push("intervention","پیگیری آموزشی باز",`${v38StudentName(db,i.studentId)} · ${i.action||i.reason||"نیازمند پیگیری"}`,user.role==="teacher"?"support":"riskCenter",i.status==="urgent"?"high":"normal",i.id,i.studentId); }
  if(["admin","superadmin"].includes(user.role)) for(const t of db.adminTasks||[]){ if(["done","closed"].includes(String(t.status||""))) continue; push("admin","کار مدیریتی باز",t.title||t.note||"کار مدیریتی","platform",t.priority==="urgent"?"high":"normal",t.id); }
  const order={high:0,normal:1,low:2}; items.sort((a,b)=>(order[a.priority]??9)-(order[b.priority]??9));
  const counts=items.reduce((m,x)=>(m[x.kind]=(m[x.kind]||0)+1,m),{});
  return {generatedAt:new Date().toISOString(),total:items.length,high:items.filter(x=>x.priority==="high").length,counts,items:items.slice(0,250)};
}
function globalSearchV38(db,user,query){
  const q=v38Text(query).toLocaleLowerCase("fa"); if(q.length<2) return [];
  const out=[]; const add=(type,id,title,subtitle,target,studentId="")=>out.push({type,id,title,subtitle,target,studentId});
  for(const u of db.users||[]){ if(v38Hay(u.firstName,u.lastName,u.studentCode,u.nationalId,u.username).includes(q)){ add(u.role==="student"?"student":"user",u.id,`${u.firstName||""} ${u.lastName||""}`.trim(),u.role==="student"?`${v38ClassName(db,u.classId)} · ${u.studentCode||u.nationalId||""}`:(u.username||u.role),u.role==="student"?"studentTimeline":"users",u.role==="student"?u.id:""); } }
  for(const e of db.exams||[]){ if(v38Hay(e.title,e.subject,e.chapter,e.examCode).includes(q)) add("exam",e.id,e.title||"آزمون",`${e.subject||""} · ${v38ClassName(db,e.classId)}`,user.role==="teacher"?"exams":"assessment"); }
  for(const h of db.homework||[]){ if(v38Hay(h.title,h.subject,h.description).includes(q)) add("homework",h.id,h.title||"تکلیف",`${h.subject||""} · ${v38ClassName(db,h.classId)}`,user.role==="teacher"?"classroom":"academic"); }
  for(const b of db.curriculum||[]){ if(v38Hay(b.title,b.subject,b.edition).includes(q)) add("book",b.id,b.title||b.subject,b.edition||"کتاب درسی",user.role==="teacher"?"curriculum":"academic"); }
  for(const qb of db.questionBank||[]){ if(v38Hay(qb.text,qb.subject,qb.chapter,qb.topic,qb.tags).includes(q)) add("question",qb.id,String(qb.text||"سؤال").slice(0,100),`${qb.subject||""} · ${qb.chapter||""}`,"bank"); }
  for(const c of db.school?.classes||[]){ if(v38Hay(c.name,c.grade).includes(q)) add("class",c.id,c.name||"کلاس",`پایه ${c.grade||"—"}`,user.role==="teacher"?"classroom":"school"); }
  return out.slice(0,80);
}
function studentTimelineV38(db,student){
  const rows=[]; const add=(type,title,detail,raw,meta={})=>rows.push({id:`${type}_${rows.length}_${meta.id||""}`,type,title,detail,at:raw||"",sort:v38DateValue({at:raw,...meta}),...meta});
  for(const a of db.attempts||[]){ if(a.studentId!==student.id)continue; const e=(db.exams||[]).find(x=>x.id===a.examId); add("exam","تحویل آزمون تستی",`${e?.title||"آزمون"} · نمره ${a.score??"—"} از ${a.total??examTotalScore(e||{})}`,a.at||a.submittedAt,{id:a.id,subject:e?.subject||""}); }
  for(const s of db.submissions||[]){ if(s.studentId!==student.id)continue; const e=(db.exams||[]).find(x=>x.id===s.examId),g=(db.grades||[]).find(x=>x.submissionId===s.id); add("exam","تحویل آزمون تشریحی",`${e?.title||"آزمون"}${g?` · نمره نهایی ${g.finalScore??g.score??"—"}`:" · در انتظار نمره"}`,s.at||s.submittedAt||g?.at,{id:s.id,subject:e?.subject||""}); }
  for(const a of db.appeals||[]){ if(a.studentId!==student.id)continue; const e=(db.exams||[]).find(x=>x.id===a.examId); add("appeal","اعتراض نمره",`${e?.title||"آزمون"} · وضعیت ${a.status||"open"}`,a.at||a.updatedAt,{id:a.id}); }
  for(const a of db.attendance||[]){ if(a.studentId!==student.id)continue; const label={present:"حاضر",absent:"غایب",late:"تأخیر",excused:"موجه"}[a.status]||a.status||"ثبت حضور"; add("attendance",`حضور و غیاب: ${label}`,`${a.subject||""}${a.note?` · ${a.note}`:""}`,a.date||a.at,{id:a.id}); }
  for(const hs of db.homeworkSubmissions||[]){ if(hs.studentId!==student.id)continue; const h=(db.homework||[]).find(x=>x.id===hs.homeworkId); add("homework","تحویل تکلیف",`${h?.title||"تکلیف"} · ${hs.status||"submitted"}${hs.score!==undefined?` · نمره ${hs.score}`:""}`,hs.submittedAt||hs.at||hs.updatedAt,{id:hs.id,subject:h?.subject||""}); }
  for(const c of db.continuousAssessments||[]){ if(c.studentId!==student.id)continue; add("continuous",c.title||"ارزشیابی مستمر",`${c.subject||""}${c.score!==undefined?` · نمره ${c.score}`:""}`,c.date||c.at||c.createdAt,{id:c.id}); }
  for(const b of db.behaviorRecords||[]){ if(b.studentId!==student.id)continue; add("behavior",b.type==="positive"?"تشویق/بازخورد مثبت":"ثبت رفتاری",b.title||b.note||b.category||"",b.date||b.at||b.createdAt,{id:b.id}); }
  for(const g of db.guardianContacts||[]){ if(g.studentId!==student.id)continue; add("family","ارتباط با خانواده",`${g.type||"تماس"} · ${g.outcome||g.note||""}`,g.date||g.at||g.createdAt,{id:g.id}); }
  for(const i of db.interventions||[]){ if(i.studentId!==student.id)continue; add("intervention","پیگیری آموزشی",`${i.status||"open"} · ${i.action||i.reason||""}`,i.createdAt||i.at||i.updatedAt,{id:i.id}); }
  for(const r of db.progressReports||[]){ if(r.studentId!==student.id)continue; add("report","گزارش پیشرفت",r.summary||r.title||"گزارش منتشر شده",r.publishedAt||r.createdAt||r.at,{id:r.id}); }
  rows.sort((a,b)=>b.sort-a.sort); return rows.slice(0,500);
}
async function handleWorkbenchV38Api(req,res,url){
  try{
    const auth=await authenticate(req,["teacher","admin","superadmin"]); const scoped=scopedDbForStaff(auth.db,auth.user);
    if(req.method==="GET"&&url.pathname==="/api/workbench/actions") return sendJson(res,200,buildActionCenterV38(scoped,auth.user));
    if(req.method==="GET"&&url.pathname==="/api/workbench/search") return sendJson(res,200,{query:url.searchParams.get("q")||"",results:globalSearchV38(scoped,auth.user,url.searchParams.get("q")||"")});
    const p=url.pathname.match(/^\/api\/workbench\/students\/([^/]+)\/profile$/);
    if(req.method==="GET"&&p){
      const id=decodeURIComponent(p[1]); const student=(scoped.users||[]).find(u=>u.id===id&&u.role==="student");
      if(!student)throw Object.assign(new Error("دانش‌آموز در محدوده دسترسی شما نیست."),{status:403});
      return sendJson(res,200,{student:publicStudent(student,scoped),photoDataUrl:await readStudentProfilePhoto(student.id),sync:{profileUpdatedAt:student.profileUpdatedAt||"",profilePhotoUpdatedAt:student.profilePhotoUpdatedAt||"",source:"server"}});
    }
    const d=url.pathname.match(/^\/api\/workbench\/students\/([^/]+)\/dossier$/);
    if(req.method==="GET"&&d){ const id=decodeURIComponent(d[1]); const student=(scoped.users||[]).find(u=>u.id===id&&u.role==="student"); if(!student)throw Object.assign(new Error("دانش‌آموز در محدوده دسترسی شما نیست."),{status:403}); const dossier=buildStudentDossierV4521(scoped,id,{includeSensitive:["admin","superadmin"].includes(auth.user.role)}); if(!dossier)throw Object.assign(new Error("پرونده دانش‌آموز پیدا نشد."),{status:404}); dossier.photoDataUrl=await readStudentProfilePhoto(id); return sendJson(res,200,{ok:true,dossier}); }
    const m=url.pathname.match(/^\/api\/workbench\/students\/([^/]+)\/timeline$/);
    if(req.method==="GET"&&m){ const id=decodeURIComponent(m[1]); const student=(scoped.users||[]).find(u=>u.id===id&&u.role==="student"); if(!student)throw Object.assign(new Error("دانش‌آموز در محدوده دسترسی شما نیست."),{status:403}); return sendJson(res,200,{student:{id:student.id,firstName:student.firstName,lastName:student.lastName,studentCode:student.studentCode||"",classId:student.classId,className:v38ClassName(scoped,student.classId)},events:studentTimelineV38(scoped,student)}); }
    return sendJson(res,404,{error:"مسیر مرکز کار پیدا نشد."});
  }catch(error){ return sendJson(res,error.status||500,{error:error.message||"خطای مرکز کار"}); }
}

function purgeUserFromStateV4516(db, target) {
  const id = target.id;
  const next = JSON.parse(JSON.stringify(db));
  if (target.role === "student") {
    const submissionIds = new Set((next.submissions || []).filter(x => x.studentId === id).map(x => x.id));
    const appealIds = new Set((next.appeals || []).filter(x => x.studentId === id).map(x => x.id));
    const linkIds = new Set((next.guardianLinks || []).filter(x => x.studentId === id || x.userId === id).map(x => x.id));
    const directCollections = [
      "attempts","submissions","appeals","notifications","attendance","homeworkSubmissions","continuousAssessments","behaviorRecords","interventions","guardianContacts","progressReports","termGrades",
      "enrollments","studentDocuments","studentExtendedProfiles","recordHistory","answerSheets","studentGoals","masteryRecords","studyPlans","offlineSyncQueue","studentFiles","achievements","studentReceipts","studentBookmarks",
      "counselingCases","counselingSessions","familyMeetings","disciplinaryCases","parentRequests","reportCards","admissions","certificates","libraryLoans","transportation","formSubmissions","feeAccounts","assessmentIncidents"
    ];
    for (const key of directCollections) if (Array.isArray(next[key])) next[key] = next[key].filter(row => !(row && (row.studentId === id || row.userId === id || row.studentUserId === id || row.targetUserId === id)));
    if (Array.isArray(next.grades)) next.grades = next.grades.filter(row => !submissionIds.has(row.submissionId || row.uploadId));
    if (Array.isArray(next.gradeRevisions)) next.gradeRevisions = next.gradeRevisions.filter(row => row.studentId !== id && !appealIds.has(row.appealId));
    if (Array.isArray(next.guardianLinks)) next.guardianLinks = next.guardianLinks.filter(row => row.studentId !== id && row.userId !== id);
    if (Array.isArray(next.guardianMessages)) next.guardianMessages = next.guardianMessages.filter(row => !linkIds.has(row.linkId || row.guardianLinkId));
  } else if (target.role === "teacher") {
    next.teachingAssignments = (next.teachingAssignments || []).filter(row => row.teacherId !== id);
    next.notifications = (next.notifications || []).filter(row => row.userId !== id);
    if (Array.isArray(next.teacherDailyTasks)) next.teacherDailyTasks = next.teacherDailyTasks.filter(row => row.teacherId !== id && row.userId !== id);
    if (Array.isArray(next.userAccessReviews)) next.userAccessReviews = next.userAccessReviews.filter(row => row.userId !== id && row.targetUserId !== id);
  }
  next.users = (next.users || []).filter(user => user.id !== id);
  return next;
}

async function handleStaffApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/staff/login") {
      const body = await readJson(req); const identifier = body.identifier || body.username || body.nationalId;
      const rate = await loginRateStatus(req, identifier);
      if (rate.blocked) throw Object.assign(new Error(`تلاش‌های ناموفق زیاد بوده است؛ ${rate.retryAfter} ثانیه بعد دوباره امتحان کنید.`), { status: 429 });
      const envelope = await ensureStateInitialized(); const security = await ensureSecurityInitialized(envelope.db);
      const user = findUserByIdentifier(envelope.db, security, identifier, "staff"); const credential = user ? security.credentials[user.id] : null;
      const ok = user && credential && await passwordVerify(String(body.password || ""), credential.passwordHash);
      if (!ok) {
        await recordLoginFailure(rate.key); await securityAudit({ type: "staff_login", success: false, ip: clientIp(req), details: "اطلاعات ورود نادرست" });
        throw Object.assign(new Error("کد ملی/نام کاربری یا رمز عبور صحیح نیست."), { status: 401 });
      }
      await recordLoginSuccess(rate.key);
      await mutateSecurity(sec=>{const c=sec.credentials?.[user.id];if(c){c.lastLoginAt=new Date().toISOString();c.lastLoginIp=clientIp(req);c.lastLoginUserAgent=String(req.headers["user-agent"]||"").slice(0,250);}});
      const token = await issueSession(user, req, security);
      await securityAudit({ type: "staff_login", userId: user.id, role: user.role, success: true, ip: clientIp(req) });
      return sendJson(res, 200, { token, user: publicAuthUser(user, security), mustChangePassword: Boolean(credential.mustChangePassword) });
    }

    const passwordChangeRoute = req.method === "POST" && url.pathname === "/api/staff/change-password";
    const auth = await authenticate(req, STAFF_ROLES, { allowPasswordChange: passwordChangeRoute });
    if (req.method === "GET" && url.pathname === "/api/staff/me") return sendJson(res, 200, { user: publicAuthUser(auth.user, auth.security) });
    // P67.11: read-only, class/subject-scoped view of the exact final
    // results used by /api/student/results. No grades/state are written here.
    if (req.method === "GET" && url.pathname === "/api/staff/student-exam-report/p6711") {
      if (auth.user.role !== "teacher") throw Object.assign(new Error("فقط معلم می‌تواند کارنامه تفصیلی را بخواند."),{status:403});
      const schoolDb = auth.db;
      const studentId = String(url.searchParams.get("studentId")||"").trim();
      const student = (schoolDb.users||[]).find(x=>x.id===studentId && x.role==="student" && x.active!==false);
      const scope = teacherScope(schoolDb,auth.user);
      if (!student || !scope.studentIds.has(student.id))
        throw Object.assign(new Error("دانش‌آموز در کلاس‌های مجاز این معلم نیست."),{status:403});
      const exams = (schoolDb.exams||[]).filter(e=>
        e.classId===student.classId && scope.examIds.has(e.id) &&
        teacherCanAssigned(schoolDb,auth.user,{classId:e.classId,subject:e.subject||"",bookId:e.bookId||""}));
      const byId=new Map(exams.map(e=>[String(e.id),e]));
      const data=[];
      for(const a of schoolDb.attempts||[]){
        if(String(a.studentId)!==String(student.id))continue;
        const e=byId.get(String(a.examId));if(!e)continue;
        const score=Number(a.score),total=Number(a.total||examTotalScore(e));
        if(!Number.isFinite(score)||!Number.isFinite(total)||total<=0)continue;
        data.push({examId:e.id,title:e.title,subject:e.subject||"درس نامشخص",type:e.type||"mcq",score,total,status:"final",submittedAt:Number(a.submittedAt||0)});
      }
      for(const sub of schoolDb.submissions||[]){
        if(String(sub.studentId)!==String(student.id))continue;
        const e=byId.get(String(sub.examId));if(!e)continue;
        const grade=(schoolDb.grades||[]).find(g=>String(g.submissionId)===String(sub.id));
        if(!grade)continue; // Exactly as the student app: ungraded work is not final.
        const score=Number(grade.finalScore),total=Number(examTotalScore(e));
        if(!Number.isFinite(score)||!Number.isFinite(total)||total<=0)continue;
        data.push({examId:e.id,title:e.title,subject:e.subject||"درس نامشخص",type:e.type||"descriptive",score,total,status:"final",submittedAt:Number(sub.submittedAt||0)});
      }
      // Keep the latest result for any repeated exam record, rather than double counting.
      const unique=new Map();
      for(const r of data){const k=String(r.examId);const prev=unique.get(k);if(!prev||Number(r.submittedAt||0)>=Number(prev.submittedAt||0))unique.set(k,r);}
      const results=[...unique.values()].sort((a,b)=>Number(b.submittedAt||0)-Number(a.submittedAt||0));
      const grouped=new Map();
      for(const r of results){const key=String(r.subject||"درس نامشخص").trim();if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(r);}
      const subjects=[...grouped].map(([subject,rows])=>({subject,count:rows.length,average20:Math.round(rows.reduce((n,r)=>n+20*r.score/r.total,0)/rows.length*100)/100,exams:rows}))
        .sort((a,b)=>a.subject.localeCompare(b.subject,"fa"));
      const average20=results.length?Math.round(results.reduce((n,r)=>n+20*r.score/r.total,0)/results.length*100)/100:null;
      return sendJson(res,200,{ok:true,version:"P67.11",readOnly:true,student:{id:student.id,name:[student.firstName,student.lastName].filter(Boolean).join(" ")||student.name||"دانش‌آموز",classId:student.classId},count:results.length,average20,subjects});
    }
    // P67.8: authenticated, read-only validation of the continuous-exam publication rule.
    if (req.method === "GET" && url.pathname === "/api/staff/teacher-exams/p678/health") {
      if (auth.user.role !== "teacher") throw Object.assign(new Error("این بررسی فقط برای معلم مجاز است."), {status:403});
      return sendJson(res, 200, {ok:true,version:"P67.8",continuousExamsBeforeChapterCompletion:true,publicationEndpoint:"/api/staff/teacher-exams/p676"});
    }
    // P67.7: authenticated, read-only deployment test for teacher publishing.
    if (req.method === "GET" && url.pathname === "/api/staff/teacher-exams/p677/health") {
      if (auth.user.role !== "teacher") throw Object.assign(new Error("این بررسی فقط برای معلم مجاز است."), {status:403});
      return sendJson(res, 200, {ok:true,version:"P67.7",publicationEndpoint:"/api/staff/teacher-exams/p676", calendar:"jalali-ui-iso-storage"});
    }
    // P67.6: atomic update/publish of EXISTING exam — never create a new exam.
    // Read-back route provides independent server-confirmation after commit.
    if (url.pathname === "/api/staff/teacher-exams/p676" && req.method === "GET") {
      if(auth.user.role!=="teacher")throw Object.assign(new Error("فقط معلم مجاز است."),{status:403});
      const id=String(url.searchParams.get("examId")||"");
      const env=await ensureStateInitialized();const ex=(env.db.exams||[]).find(e=>e.id===id);
      if(!ex||ex.createdBy!==auth.user.id||!teacherCanAssigned(env.db,auth.user,{classId:ex.classId,subject:ex.subject,bookId:ex.bookId,feature:"examCreate"}))throw Object.assign(new Error("آزمون در دسترس نیست."),{status:404});
      return sendJson(res,200,{ok:true,exam:{id:ex.id,title:ex.title,status:ex.status,publicationState:ex.publicationState||"draft",updatedAt:ex.updatedAt||"",startAt:ex.startAt||"",endAt:ex.endAt||"",questionCount:(ex.questions||[]).length,classId:ex.classId,bookId:ex.bookId}});
    }
    if (url.pathname === "/api/staff/teacher-exams/p676" && req.method === "POST") {
      if(auth.user.role!=="teacher")throw Object.assign(new Error("فقط معلم مجاز به انتشار است."),{status:403});
      const body=await readJson(req),action=String(body?.action||""),examId=String(body?.examId||""),fields=body?.fields;
      if(!["save","publish"].includes(action)||!/^ex_[a-z0-9_-]{5,90}$/i.test(examId)||!fields||typeof fields!=="object"||Array.isArray(fields))throw Object.assign(new Error("درخواست و شناسه آزمون معتبر نیست."),{status:400});
      const result=await mutateDb(async schoolDb=>{
        const ex=(schoolDb.exams||[]).find(x=>x.id===examId);
        if(!ex||ex.createdBy!==auth.user.id)throw Object.assign(new Error("آزمون متعلق به معلم فعلی نیست."),{status:403});
        if(ex.status!=="draft"||["published","in_progress","ended","graded","final","archived"].includes(ex.publicationState)){
          if(action==="publish"&&ex.status==="active")return {examId:ex.id,alreadyPublished:true};
          throw Object.assign(new Error("این آزمون پیش‌نویس نیست و قابل ویرایش/انتشار مجدد نیست."),{status:409});
        }
        if((schoolDb.attempts||[]).some(x=>x.examId===ex.id)||(schoolDb.submissions||[]).some(x=>x.examId===ex.id))throw Object.assign(new Error("آزمونی که دانش‌آموز در آن شرکت کرده قابل ویرایش نیست."),{status:409});
        const book=(schoolDb.curriculum||[]).find(b=>b.id===ex.bookId&&b.active!==false);
        const cls=(schoolDb.school?.classes||[]).find(c=>c.id===fields.classId&&c.active!==false);
        if(!book||!cls||book.id!==fields.bookId||Number(cls.grade)!==Number(book.grade))throw Object.assign(new Error("پایه، کتاب یا کلاس انتخاب‌شده ناهماهنگ است."),{status:400});
        if(!teacherCanAssigned(schoolDb,auth.user,{classId:cls.id,subject:book.subject,bookId:book.id,feature:"examCreate"}))throw Object.assign(new Error("اجازه ویرایش این کلاس را ندارید."),{status:403});
        if(action==="publish"&&!teacherCanAssigned(schoolDb,auth.user,{classId:cls.id,subject:book.subject,bookId:book.id,feature:"examPublish"}))throw Object.assign(new Error("مجوز انتشار برای این کلاس ندارید؛ از مدیریت درخواست کنید."),{status:403});
        const title=String(fields.title||"").trim(),duration=Number(fields.duration),category=String(fields.examCategory||"ongoing"),period=String(fields.academicPeriod||"semester1");
        if(!title||title.length>160||!Number.isInteger(duration)||duration<1||duration>300||!["ongoing","final"].includes(category)||!["semester1","semester2"].includes(period))throw Object.assign(new Error("عنوان، مدت یا نوع آزمون معتبر نیست."),{status:400});
        const chapters=(book.chapters||[]).map(c=>String(c.id));const selected=[...new Set((Array.isArray(fields.selectedChapterIds)?fields.selectedChapterIds:[]).map(String))];
        if(!selected.length||selected.some(id=>!chapters.includes(id)))throw Object.assign(new Error("فصل‌های انتخاب‌شده به این کتاب تعلق ندارند."),{status:400});
        const chosen=Array.isArray(fields.studentIds)?[...new Set(fields.studentIds.map(String))]:[];
        const allowedStudents=(schoolDb.users||[]).filter(u=>u.role==="student"&&u.active!==false&&studentClassIds(schoolDb,u).has(String(cls.id)));
        const allowedIds=new Set(allowedStudents.map(u=>String(u.id)));
        if(action==="publish"&&!allowedStudents.length)throw Object.assign(new Error("این کلاس دانش‌آموز فعالی ندارد؛ انتشار به هیچ‌کس نمی‌رسد."),{status:400});
        if(chosen.some(id=>!allowedIds.has(id)))throw Object.assign(new Error("دانش‌آموز انتخابی در این کلاس مجاز نیست."),{status:403});
        const allowedAdmin=new Map((schoolDb.adminQuestionBank||[]).filter(q=>q.status==="approved"&&q.bookId===book.id&&teacherCanAssigned(schoolDb,auth.user,{bookId:q.bookId,subject:q.subject,feature:"questionBank"})).map(q=>[String(q.id),q]));
        const personal=new Map((schoolDb.questionBank||[]).filter(q=>teacherCanReadQuestion(schoolDb,auth.user,q)).map(q=>[String(q.id),q]));
        const rows=fields.questions;
        if(!Array.isArray(rows)||rows.length<1||rows.length>150)throw Object.assign(new Error("تعداد سؤال باید بین ۱ تا ۱۵۰ باشد."),{status:400});
        const questionIds=new Set(),prepared=[];
        for(const rawQ of rows){
          if(!rawQ||typeof rawQ!=="object")throw Object.assign(new Error("یک سؤال ساختار معتبر ندارد."),{status:400});
          const q={...rawQ},id=String(q.id||""),src=String(q.sourceQuestionId||"");
          if(!id||questionIds.has(id))throw Object.assign(new Error("شناسه سؤال خالی یا تکراری است."),{status:400});questionIds.add(id);
          if(!["mcq","descriptive"].includes(q.type)||!String(q.text||"").trim()||!(Number(q.score)>0)||Number(q.score)>20)throw Object.assign(new Error("نوع، متن یا بارم سؤال معتبر نیست."),{status:400});
          if(q.chapterId&&!selected.includes(String(q.chapterId)))throw Object.assign(new Error("فصل یکی از سؤالات خارج از فصل‌های آزمون است."),{status:400});
          if(src){const source=allowedAdmin.get(src)||personal.get(src);if(!source||source.bookId!==book.id)throw Object.assign(new Error("منبع یک سؤال دیگر تأییدشده یا مجاز نیست."),{status:403});
            if(allowedAdmin.has(src)&&String(source.chapterId)!==String(q.sourceChapterId||q.chapterId||""))throw Object.assign(new Error("فصل سؤال مخزن تطبیق ندارد."),{status:403});}
          if(q.type==="mcq"&&(!Array.isArray(q.choices)||q.choices.length!==4||q.choices.some(c=>!String(c||"").trim())||!Number.isInteger(Number(q.answer))||Number(q.answer)<0||Number(q.answer)>3))throw Object.assign(new Error("گزینه‌های صحیح یک سؤال تستی ناقص‌اند."),{status:400});
          prepared.push({...q,score:Number(q.score)});
        }
        const startAt=String(fields.startAt||""),endAt=String(fields.endAt||"");const a=Date.parse(startAt),b=Date.parse(endAt);
        if(action==="publish"&&(!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b<=Date.now()||b-a<duration*60000))throw Object.assign(new Error("شروع/پایان آزمون معتبر نیست یا مهلت کافی ندارد."),{status:400});
        if((startAt&&!Number.isFinite(a))||(endAt&&!Number.isFinite(b)))throw Object.assign(new Error("فرمت زمان‌بندی معتبر نیست."),{status:400});
        const total=prepared.reduce((n,q)=>n+Number(q.score),0);const status=action==="publish"?"active":"draft";
        const updated={...ex,title,classId:cls.id,bookId:book.id,subject:book.subject,examCategory:category,academicPeriod:period,duration,questions:prepared,
          type:[...new Set(prepared.map(q=>q.type))].length>1?"mixed":prepared[0].type,chapterId:selected[0],chapter:selected.map(id=>book.chapters.find(c=>String(c.id)===id)?.title||id).join("، "),
          selectedChapterIds:selected,questionPoolChapterIds:selected,status,publicationState:action==="publish"?"published":"draft",
          studentIds:chosen,recipientStudentIds:chosen,assignedStudentIds:[],classIds:[],recipientClassIds:[],assignedClassIds:[],showInstantResult:Boolean(fields.showInstantResult),startAt,endAt,targetScore:total,
          updatedAt:new Date().toISOString(),updatedBy:auth.user.id,publicationRevision:Number(ex.publicationRevision||0)+(action==="publish"?1:0),
          publishedAt:action==="publish"?new Date().toISOString():ex.publishedAt||null};
        const structural=validateExamForStudentV61(updated);
        if(action==="publish"&&structural.length)throw Object.assign(new Error(`آزمون برای دانش‌آموز آماده نیست: ${structural.slice(0,4).join(" | ")}`),{status:400});
        const coreProblems=validateExamCore(normalizeExamCore(updated,cls,book),{cls,book,questionBank:[...allowedAdmin.values(),...personal.values()]});
        if(coreProblems.length)throw Object.assign(new Error(coreProblems.slice(0,6).join(" | ")),{status:400});
        if(category==="final"){
          const policy=(schoolDb.termPolicies||[]).find(p=>p.classId===cls.id&&p.subject===book.subject&&String(p.academicYear||"")===String(schoolDb.school?.year||"")&&String(p.academicPeriod||"semester2")===period);
          if(policy){const p=normalizeTermPolicyCore(policy,Number(schoolDb.school?.settings?.scoreScale||20));if(Math.abs(total-Number(p.finalShare))>0.001)throw Object.assign(new Error(`بارم امتحان پایان‌ترم باید ${p.finalShare} باشد.`),{status:400});}
        }
        Object.assign(ex,updated);
        schoolDb.audit=Array.isArray(schoolDb.audit)?schoolDb.audit:[];
        schoolDb.audit.unshift({id:makeId("log"),userId:auth.user.id,action:action==="publish"?"انتشار آزمون P67.6":"ویرایش پیش‌نویس P67.6",details:`${ex.id}: ${ex.title}`,at:faNow()});
        if(action==="publish"){
          schoolDb.notifications=Array.isArray(schoolDb.notifications)?schoolDb.notifications:[];
          const recipients=chosen.length?allowedStudents.filter(u=>chosen.includes(String(u.id))):allowedStudents;
          for(const student of recipients)schoolDb.notifications.unshift({id:makeId("not"),userId:student.id,title:"آزمون جدید",body:`آزمون «${title}» منتشر شد.`,read:false,at:faNow()});
        }
        return {examId:ex.id,action,studentCount:chosen.length||allowedStudents.length};
      });
      const finalState=await ensureStateInitialized();const saved=(finalState.db.exams||[]).find(e=>e.id===result.result.examId);
      if(!saved||saved.status!==(action==="publish"?"active":"draft"))throw Object.assign(new Error("تأیید ذخیره واقعی آزمون دریافت نشد."),{status:500});
      if(action==="publish"&&!result.result.alreadyPublished){
        const targets=(finalState.db.users||[]).filter(u=>u.role==="student"&&u.active!==false&&studentCanSeeExam(finalState.db,saved,u)).map(u=>u.id);
        void sendAuthorizedPush(targets,{title:"آزمون جدید",body:"آزمون جدید برای شما منتشر شده است.",screen:"exams",eventId:saved.id}).catch(e=>console.warn('FCM exam:',e.message));
      }
      try{await securityAudit({type:"p676_teacher_exam",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:`${action}:${examId}`});}catch(error){console.warn("P67.6 audit:",error.message);}
      return sendJson(res,200,{ok:true,committed:true,action,examId:saved.id,studentCount:result.result.studentCount,updatedAt:finalState.updatedAt,db:scopedDbForStaff(finalState.db,auth.user)});
    }

    // P67 — authorized, read-only teacher view of approved admin questions.
    // Never merge or synchronize these rows into the personal teacher question bank.
    if (url.pathname === "/api/staff/teacher-approved-questions/p67" && req.method === "GET") {
      if (auth.user.role !== "teacher") throw Object.assign(new Error("کتابخانه سؤال فقط برای معلم فعال است."), {status:403});
      const env = await ensureStateInitialized(), schoolDb = env.db;
      const eligibleBooks = (schoolDb.curriculum || []).filter(book =>
        teacherCanAssigned(schoolDb, auth.user, {bookId:book.id,subject:book.subject,feature:"questionBank"}));
      const ids = new Set(eligibleBooks.map(b=>String(b.id)));
      const books = eligibleBooks.map(b=>({id:b.id,subject:b.subject,grade:Number(b.grade||0),title:b.title||b.subject,
        chapters:(b.chapters||[]).map(c=>({id:c.id,title:c.displayTitle||c.name||c.title||`فصل ${c.order||""}`}))}));
      const questions = (schoolDb.adminQuestionBank||[]).filter(q=>q.status==="approved"&&ids.has(String(q.bookId))&&
        teacherCanAssigned(schoolDb,auth.user,{bookId:q.bookId,subject:q.subject,feature:"questionBank"}))
        .map(q=>({id:q.id,bookId:q.bookId,chapterId:q.chapterId,subject:q.subject,grade:Number(q.grade||0),
          type:q.type,difficulty:q.difficulty,score:Number(q.score||1),text:q.text,
          // Teacher-only solution metadata. Student-facing exam APIs never use this route.
          choices:Array.isArray(q.choices)?q.choices:[],answer:Number.isInteger(q.answer)?q.answer:null,
          referenceAnswer:q.referenceAnswer||"",explanation:q.explanation||"",tags:q.tags||[]}));
      return sendJson(res,200,{ok:true,feature:"P67-TEACHER-APPROVED-LIBRARY",books,questions,count:questions.length,updatedAt:env.updatedAt});
    }
    // P67.3 — Save one teacher exam atomically instead of POSTing the full school state.
    // This route preserves admin/teacher/student question-bank separation and classroom permissions.
    if (url.pathname === "/api/staff/teacher-exams/p673" && req.method === "POST") {
      if (auth.user.role !== "teacher") throw Object.assign(new Error("ثبت آزمون از این مسیر فقط برای معلم مجاز است."), {status:403});
      const body = await readJson(req), raw = body?.exam;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error("اطلاعات آزمون ارسال نشده است."), {status:400});
      const examId = String(raw.id||"").trim();
      if (!/^ex_[a-z0-9_-]{5,90}$/i.test(examId)) throw Object.assign(new Error("شناسه آزمون معتبر نیست."), {status:400});
      if (!Array.isArray(raw.questions) || raw.questions.length<1 || raw.questions.length>150) throw Object.assign(new Error("تعداد سؤال‌های آزمون باید بین ۱ تا ۱۵۰ باشد."), {status:400});
      const result = await mutateDb(async schoolDb => {
        const cls = (schoolDb.school?.classes||[]).find(x=>x.id===raw.classId && x.active!==false);
        const book = (schoolDb.curriculum||[]).find(x=>x.id===raw.bookId && x.active!==false);
        if (!cls || !book || Number(cls.grade)!==Number(book.grade)) throw Object.assign(new Error("کلاس و کتاب آزمون معتبر یا هم‌پایه نیستند."), {status:400});
        if (!teacherCanAssigned(schoolDb,auth.user,{classId:cls.id,subject:book.subject,bookId:book.id,feature:"examCreate"}))
          throw Object.assign(new Error("مجوز ساخت آزمون برای این کلاس و کتاب فعال نیست؛ از مدیر مدرسه بخواهید تخصیص تدریس را بررسی کند."),{status:403});
        if (raw.status==="active" && !teacherCanAssigned(schoolDb,auth.user,{classId:cls.id,subject:book.subject,bookId:book.id,feature:"examPublish"}))
          throw Object.assign(new Error("مجوز انتشار آزمون برای این کلاس فعال نیست؛ آن را پیش‌نویس ذخیره کنید."),{status:403});
        const existing=(schoolDb.exams||[]).find(x=>x.id===examId);
        if (existing) {
          if (existing.createdBy!==auth.user.id) throw Object.assign(new Error("شناسه آزمون متعلق به کاربر دیگری است."),{status:409});
          const sameQuestions=JSON.stringify((existing.questions||[]).map(q=>[q.id,q.text,Number(q.score),q.sourceQuestionId||""]))===
            JSON.stringify((raw.questions||[]).map(q=>[q.id,q.text,Number(q.score),q.sourceQuestionId||""]));
          if(String(existing.title||"").trim()!==String(raw.title||"").trim()||existing.classId!==raw.classId||existing.bookId!==raw.bookId||!sameQuestions)
            throw Object.assign(new Error("این شناسه قبلاً برای نسخه دیگری از آزمون ذخیره شده است؛ آزمون ثبت‌شده را بررسی کنید."),{status:409});
          return {examId:existing.id,alreadySaved:true}; // Retried identical request after a lost response.
        }
        const approvedAdmin = (schoolDb.adminQuestionBank||[]).filter(q=>q.status==="approved" && q.bookId===book.id &&
          teacherCanAssigned(schoolDb,auth.user,{bookId:q.bookId,subject:q.subject,feature:"questionBank"}));
        const adminIds=new Map(approvedAdmin.map(q=>[String(q.id),q]));
        const allAdminIds=new Set((schoolDb.adminQuestionBank||[]).map(q=>String(q.id)));
        const teacherBank = (schoolDb.questionBank||[]).filter(q=>teacherCanReadQuestion(schoolDb,auth.user,q));
        const teacherById=new Map(teacherBank.map(q=>[String(q.id),q]));
        const prepared=[];
        for(const rawQ of raw.questions){
          if(!rawQ || typeof rawQ!=="object")throw Object.assign(new Error("ساختار یکی از سؤال‌ها معتبر نیست."),{status:400});
          const q={...rawQ},srcId=String(q.sourceQuestionId||"").trim();
          if(srcId){
            const source=adminIds.get(srcId)||teacherById.get(srcId);
            if(!source)throw Object.assign(new Error("سؤال منبع تأییدشده یا مجاز نیست؛ ابتدا فهرست مخزن را تازه‌سازی کنید."),{status:403});
            if(source.bookId!==book.id)throw Object.assign(new Error("کتاب سؤال انتخاب‌شده با کتاب آزمون مطابقت ندارد."),{status:400});
            if(allAdminIds.has(srcId)){
              if(!adminIds.has(srcId)||String(source.chapterId)!==String(q.sourceChapterId||q.chapterId||""))
                throw Object.assign(new Error("فصل یا تأیید سؤال مخزن ادمین معتبر نیست."),{status:403});
              q.chapterId=source.chapterId;q.sourceChapterId=source.chapterId;
            }
          }
          if(!String(q.text||"").trim() || !(Number(q.score)>0))throw Object.assign(new Error("متن و نمره همه سؤالات باید معتبر باشند."),{status:400});
          if(q.type==="mcq"){
            if(!Array.isArray(q.choices)||q.choices.length!==4||q.choices.some(x=>!String(x||"").trim()) || !Number.isInteger(Number(q.answer))||Number(q.answer)<0||Number(q.answer)>3)
              throw Object.assign(new Error("یکی از سؤال‌های تستی چهار گزینه یا کلید صحیح معتبر ندارد."),{status:400});
            q.answer=Number(q.answer);
          }
          if(!["mcq","descriptive"].includes(String(q.type)))throw Object.assign(new Error("نوع سؤال برای این آزمون پشتیبانی نمی‌شود."),{status:400});
          prepared.push(q);
        }
        const normalized=normalizeExamCore({...raw,id:examId,bookId:book.id,classId:cls.id,subject:book.subject,createdBy:auth.user.id,
          academicYear:String(schoolDb.school?.year||""),questions:prepared,status:raw.status==="active"?"active":"draft"},cls,book);
        const errors=validateExamCore(normalized,{cls,book,questionBank:[...teacherBank,...approvedAdmin]});
        if((normalized.examCategory||"ongoing")==="final"){
          const period=normalizeAcademicPeriod(normalized.academicPeriod||normalized.period,{allowAnnual:false});
          const policy=(schoolDb.termPolicies||[]).find(x=>x.classId===cls.id&&x.subject===book.subject&&
            String(x.academicYear||"")===String(schoolDb.school?.year||"")&&String(x.academicPeriod||"semester2")===period);
          if(policy){const p=normalizeTermPolicyCore(policy,Number(schoolDb.school?.settings?.scoreScale||20));
            if(Math.abs(Number(normalized.targetScore||0)-Number(p.finalShare))>.001)
              errors.push(`بارم آزمون پایان‌ترم باید ${p.finalShare} باشد.`);}
        }
        if(normalized.status==="active"){
          errors.push(...validateExamForStudentV61(normalized));
        }
        if(errors.length)throw Object.assign(new Error([...new Set(errors)].join(" ")),{status:400});
        schoolDb.exams=Array.isArray(schoolDb.exams)?schoolDb.exams:[];
        schoolDb.exams.push(normalized);
        schoolDb.audit=Array.isArray(schoolDb.audit)?schoolDb.audit:[];
        schoolDb.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"ساخت آزمون P67.3",details:`${normalized.id}: ${normalized.title}`,at:faNow()});
        if(normalized.status==="active"){
          schoolDb.notifications=Array.isArray(schoolDb.notifications)?schoolDb.notifications:[];
          for(const student of (schoolDb.users||[]).filter(u=>u.role==="student"&&u.classId===cls.id&&u.active!==false))
            schoolDb.notifications.unshift({id:makeId("not"),userId:student.id,title:"آزمون جدید",body:`آزمون «${normalized.title}» منتشر شد.`,read:false,at:faNow()});
        }
        return {examId:normalized.id,alreadySaved:false};
      });
      const savedExam=(result.db.exams||[]).find(e=>e.id===result.result.examId);
      if(!savedExam)throw Object.assign(new Error("ثبت آزمون در داده سرور تأیید نشد."),{status:500});
      try{await securityAudit({type:"p673_exam_created",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:result.result.examId});}
      catch(e){console.warn("P67.3 noncritical audit failure",e.message);}
      const finalState=await ensureStateInitialized();
      return sendJson(res,200,{ok:true,committed:true,examId:savedExam.id,alreadySaved:result.result.alreadySaved,
        updatedAt:finalState.updatedAt,db:scopedDbForStaff(finalState.db,auth.user)});
    }
    // P66.3: atomic, isolated admin-question import. Never POST the entire school db.
    // P66.4: read-only health probe and authoritative CRUD for *only* the admin bank.
    if (url.pathname === "/api/staff/admin-question-bank/p664/health" && req.method === "GET") {
      if (!isAdminRole(auth.user.role)) throw Object.assign(new Error("این مخزن فقط برای مدیر قابل بررسی است."), {status:403});
      const env=await ensureStateInitialized();let stateIssue="";
      try{validateServerState(upgradeServerDbRespectingReset(structuredClone(env.db)));}
      catch(e){stateIssue=String(e.message||e).slice(0,350);}
      const rows=Array.isArray(env.db.adminQuestionBank)?env.db.adminQuestionBank:[];
      const math=Array.isArray(env.db.curriculum)?env.db.curriculum.filter(b=>Number(b.grade)===7&&String(b.subject).includes("ریاضی")):[];
      return sendJson(res,200,{ok:true,feature:"P66.4-ADMIN-BANK-HEALTH",bankCount:rows.length,mathGrade7Books:math.map(b=>({id:b.id,chapters:(b.chapters||[]).length})),stateIssue,updatedAt:env.updatedAt,rows});
    }
    if (url.pathname === "/api/staff/admin-question-bank/p664/changes" && req.method === "POST") {
      if (!isAdminRole(auth.user.role)) throw Object.assign(new Error("ثبت در مخزن ادمین فقط برای مدیر مجاز است."),{status:403});
      const body=await readJson(req),changes=body?.changes,deleteIds=body?.deleteIds;
      if(!Array.isArray(changes)||!Array.isArray(deleteIds)||changes.length+deleteIds.length>300)throw Object.assign(new Error("ساختار درخواست تغییرات مخزن نامعتبر است."),{status:400});
      if(!changes.length&&!deleteIds.length)return sendJson(res,200,{ok:true,feature:"P66.4-ADMIN-BANK-CHANGES",committed:false,changed:0,deleted:0});
      const result=await enqueueStateOperation(async()=>{
        const env=await ensureStateInitialized(),state=upgradeServerDbRespectingReset(structuredClone(env.db));
        const rows=Array.isArray(state.adminQuestionBank)?state.adminQuestionBank:[];
        const deleted=new Set(deleteIds.map(String)),deletedCount=rows.filter(q=>deleted.has(String(q.id))).length,seen=new Set(),books=new Map((state.curriculum||[]).map(b=>[String(b.id),b]));
        const normalize=s=>String(s||"").replace(/[ي]/g,"ی").replace(/[ك]/g,"ک").replace(/\s+/g," ").trim().toLowerCase();
        let next=rows.filter(q=>!deleted.has(String(q.id)));let changed=0;
        for(let i=0;i<changes.length;i++){
          const raw=changes[i];if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Object.assign(new Error(`رکورد ${i+1} نامعتبر است.`),{status:400});
          const id=String(raw.id||"").trim(),text=String(raw.text||"").trim(),score=Number(raw.score),book=books.get(String(raw.bookId));
          const chapter=(book?.chapters||[]).find(c=>String(c.id)===String(raw.chapterId));
          if(!id||id.length>150||seen.has(id))throw Object.assign(new Error(`شناسه سؤال ${i+1} نامعتبر یا تکراری است.`),{status:400});
          if(!book||!chapter)throw Object.assign(new Error(`کتاب یا فصل سؤال ${i+1} روی سرور موجود نیست.`),{status:400});
          if(text.length<5||text.length>10000)throw Object.assign(new Error(`متن سؤال ${i+1} نامعتبر است.`),{status:400});
          if(!["mcq","descriptive","truefalse","fillblank","short","image"].includes(String(raw.type||"")))throw Object.assign(new Error(`نوع سؤال ${i+1} نامعتبر است.`),{status:400});
          if(!["easy","medium","advanced"].includes(String(raw.difficulty||"")))throw Object.assign(new Error(`سطح سختی سؤال ${i+1} نامعتبر است.`),{status:400});
          if(!["draft","needs_review","approved","retired"].includes(String(raw.status||"")))throw Object.assign(new Error(`وضعیت سؤال ${i+1} نامعتبر است.`),{status:400});
          if(!Number.isFinite(score)||score<=0||score>100)throw Object.assign(new Error(`بارم سؤال ${i+1} نامعتبر است.`),{status:400});
          const fp=[String(book.id),String(chapter.id),normalize(text)].join("|");
          if(next.some(q=>String(q.id)!==id&&[String(q.bookId),String(q.chapterId),normalize(q.text)].join("|")===fp))throw Object.assign(new Error(`سؤال مشابه سؤال ${i+1} از قبل وجود دارد.`),{status:409});
          const previous=rows.find(q=>String(q.id)===id),now=new Date().toISOString();
          const row={id,bookId:book.id,chapterId:chapter.id,grade:Number(book.grade),subject:book.subject,chapter:chapter.title,
            text,type:String(raw.type),difficulty:String(raw.difficulty),score,status:String(raw.status),
            referenceAnswer:String(raw.referenceAnswer||"").slice(0,10000),explanation:String(raw.explanation||"").slice(0,10000),
            tags:Array.isArray(raw.tags)?raw.tags.slice(0,30).map(v=>String(v).slice(0,100)):[],
            stats:previous?.stats||{usedCount:0},createdAt:previous?.createdAt||now,createdBy:previous?.createdBy||auth.user.id,
            updatedAt:now,updatedBy:auth.user.id};
          next=next.filter(q=>String(q.id)!==id);next.push(row);seen.add(id);changed++;
        }
        state.adminQuestionBank=next;
        state.audit=Array.isArray(state.audit)?state.audit:[];
        state.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"ویرایش مخزن مستقل ادمین P66.4",details:`changed=${changed},deleted=${deletedCount}`,at:faNow()});
        const saved=await writeStateEnvelope(state);
        return {changed,deleted:deletedCount,rows:saved.db.adminQuestionBank,updatedAt:saved.updatedAt};
      });
      return sendJson(res,200,{ok:true,feature:"P66.4-ADMIN-BANK-CHANGES",committed:true,...result});
    }
    if (url.pathname === "/api/staff/admin-question-bank/p663" && req.method === "GET") {
      if (!isAdminRole(auth.user.role)) throw Object.assign(new Error("دسترسی به مخزن ادمین مجاز نیست."),{status:403});
      const env=await ensureStateInitialized();
      const rows=Array.isArray(env.db.adminQuestionBank)?env.db.adminQuestionBank:[];
      const books=(env.db.curriculum||[]).map(b=>({id:b.id,subject:b.subject,grade:b.grade,chapters:(b.chapters||[]).map(c=>({id:c.id,title:c.title}))}));
      return sendJson(res,200,{ok:true,feature:"P66.3-ATOMIC-ADMIN-IMPORT",count:rows.length,
        existing:rows.map(q=>({id:q.id,bookId:q.bookId,chapterId:q.chapterId,text:q.text})),books,updatedAt:env.updatedAt});
    }
    if (url.pathname === "/api/staff/admin-question-bank/p663" && req.method === "POST") {
      if (!isAdminRole(auth.user.role)) throw Object.assign(new Error("درون‌ریزی فقط برای مدیر یا ادمین مجاز است."),{status:403});
      const body=await readJson(req);
      const items=body?.questions;
      if(!Array.isArray(items)||!items.length||items.length>2000)throw Object.assign(new Error("پک باید بین ۱ و ۲۰۰۰ سؤال داشته باشد."),{status:400});
      const result=await enqueueStateOperation(async()=>{
        const env=await ensureStateInitialized(),state=structuredClone(env.db);
        state.adminQuestionBank=Array.isArray(state.adminQuestionBank)?state.adminQuestionBank:[];
        const books=new Map((state.curriculum||[]).map(b=>[String(b.id),b]));
        const normalize=s=>String(s||"").replace(/[ي]/g,"ی").replace(/[ك]/g,"ک").replace(/\s+/g," ").trim().toLowerCase();
        const key=(q)=>[String(q.bookId),String(q.chapterId),normalize(q.text)].join("|");
        const fingerprints=new Set(state.adminQuestionBank.map(key));
        const ids=new Set(state.adminQuestionBank.map(q=>String(q.id)));
        const summary={total:items.length,added:0,duplicates:0,invalid:0,issues:[]},now=new Date().toISOString();
        for(let i=0;i<items.length;i++){
          const raw=items[i];
          const report=message=>{summary.invalid++;if(summary.issues.length<20)summary.issues.push({row:i+1,message});};
          if(!raw||typeof raw!=="object"||Array.isArray(raw)){report("ساختار سؤال نامعتبر است.");continue;}
          const book=books.get(String(raw.bookId)),chapter=(book?.chapters||[]).find(c=>String(c.id)===String(raw.chapterId));
          if(!book||!chapter){report("کتاب یا فصل در سرور وجود ندارد. ابتدا فهرست کتاب‌ها را به‌روز کنید.");continue;}
          const text=String(raw.text||"").trim(),score=Number(raw.score),type=String(raw.type||""),difficulty=String(raw.difficulty||""),status=String(raw.status||"draft");
          if(text.length<5||text.length>10000){report("متن سؤال باید بین ۵ تا ۱۰۰۰۰ نویسه باشد.");continue;}
          if(!["mcq","descriptive","truefalse","fillblank","short","image"].includes(type)){report("نوع سؤال نامعتبر است.");continue;}
          if(!["easy","medium","advanced"].includes(difficulty)){report("سطح دشواری نامعتبر است.");continue;}
          if(!["draft","needs_review","approved","retired"].includes(status)){report("وضعیت سؤال نامعتبر است.");continue;}
          if(!Number.isFinite(score)||score<=0||score>100){report("بارم سؤال باید بیش از صفر و حداکثر ۱۰۰ باشد.");continue;}
          const fp=key({bookId:book.id,chapterId:chapter.id,text});
          if(fingerprints.has(fp)){summary.duplicates++;continue;}
          let id=String(raw.id||"");if(!id||ids.has(id))id=makeId("adminqb");
          const row={id,bookId:book.id,chapterId:chapter.id,grade:Number(book.grade),subject:book.subject,chapter:chapter.title,
            text,type,difficulty,score,status,referenceAnswer:String(raw.referenceAnswer||"").slice(0,10000),
            explanation:String(raw.explanation||"").slice(0,10000),tags:Array.isArray(raw.tags)?raw.tags.slice(0,30).map(v=>String(v).slice(0,100)):[],
            stats:{usedCount:0},createdAt:now,updatedAt:now,createdBy:auth.user.id,updatedBy:auth.user.id};
          state.adminQuestionBank.push(row);fingerprints.add(fp);ids.add(id);summary.added++;
        }
        if(!summary.added){return {summary,updatedAt:env.updatedAt,rows:state.adminQuestionBank,committed:false};}
        // Limit scope: no changes to teacher/exam/student question collections.
        state.audit=Array.isArray(state.audit)?state.audit:[];
        state.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"درون‌ریزی مخزن مستقل ادمین P66.3",details:`added=${summary.added},duplicate=${summary.duplicates},invalid=${summary.invalid}`,at:faNow()});
        const saved=await writeStateEnvelope(state);
        return {summary,updatedAt:saved.updatedAt,rows:saved.db.adminQuestionBank,committed:true};
      });
      // Security-audit failure must not turn a successful commit into a fake failure.
      try{await securityAudit({type:"p663_admin_question_import",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:JSON.stringify(result.summary)});}
      catch(e){console.warn("P66.3 noncritical audit failure",e.message);}
      return sendJson(res,200,{ok:true,feature:"P66.3-ATOMIC-ADMIN-IMPORT",...result.summary,
        committed:result.committed,updatedAt:result.updatedAt,rows:result.rows});
    }
    if (req.method === "GET" && url.pathname === "/api/staff/workflow-health") {
      const health=workflowHealth11(auth.db,auth.user.role,auth.user.id);
      return sendJson(res,200,{ok:true,health,phases:workflowPhases11(health),generatedAt:new Date().toISOString()});
    }
    if (req.method === "GET" && url.pathname === "/api/staff/beta-readiness") {
      if(!["admin","superadmin"].includes(auth.user.role))throw Object.assign(new Error("وضعیت انتشار Beta فقط برای مدیر قابل مشاهده است."),{status:403});
      const health=workflowHealth11(auth.db,auth.user.role,auth.user.id),readiness=betaReadiness12(auth.db,health);
      return sendJson(res,200,{ok:true,release:"Beta 1",readiness,workflowHealth:health,generatedAt:new Date().toISOString()});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/term-policy") {
      const body=await readJson(req),classId=String(body.classId||""),subject=String(body.subject||""),academicPeriod=normalizeAcademicPeriod(body.academicPeriod||body.period,{allowAnnual:false}),academicYear=String(auth.db.school?.year||"");
      if(!classId||!subject)throw Object.assign(new Error("کلاس و درس الزامی است."),{status:400});
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId,subject,feature:"continuous"}))throw Object.assign(new Error("برای تنظیم فرمول این کلاس/درس دسترسی ندارید."),{status:403});
      const policy=normalizeTermPolicyCore({continuousEnabled:body.continuousEnabled!==false,continuousShare:body.continuousShare},Number(auth.db.school?.settings?.scoreScale||20));
      const conflictingFinal=(auth.db.exams||[]).find(e=>e.classId===classId&&e.subject===subject&&(e.examCategory||"ongoing")==="final"&&String(e.academicYear||academicYear)===academicYear&&normalizeAcademicPeriod(e.academicPeriod||e.period,{allowAnnual:false})===academicPeriod&&Math.abs(Number(e.targetScore||0)-Number(policy.finalShare))>.001);
      if(conflictingFinal)throw Object.assign(new Error(`برای این دوره آزمون پایانی «${conflictingFinal.title||"بدون عنوان"}» با بارم ${Number(conflictingFinal.targetScore||0)} وجود دارد. برای این فرمول بارم پایانی باید ${policy.finalShare} باشد؛ ابتدا آزمون را اصلاح کنید.`),{status:409});
      const saved=await enqueueStateOperation(async()=>{const env=await ensureStateInitialized(),latest=env.db,now=new Date().toISOString(),key=`${classId}__${subject}__${academicYear}__${academicPeriod}`;
        latest.termPolicies=Array.isArray(latest.termPolicies)?latest.termPolicies:[];
        const existing=latest.termPolicies.find(x=>x.key===key);
        const row={id:existing?.id||makeId("tp"),key,classId,subject,academicYear,academicPeriod,...policy,teacherId:auth.user.id,updatedAt:now,createdAt:existing?.createdAt||now};
        latest.termPolicies=latest.termPolicies.filter(x=>x.key!==key);latest.termPolicies.push(row);
        return writeStateEnvelope(latest);
      });
      return sendJson(res,200,{ok:true,policy:(saved.db.termPolicies||[]).find(x=>x.key===`${classId}__${subject}__${academicYear}__${academicPeriod}`)});
    }

    if (req.method === "POST" && url.pathname === "/api/staff/report-card") {
      const body=await readJson(req),studentId=String(body.studentId||""),academicPeriod=normalizeAcademicPeriod(body.academicPeriod||body.period,{allowAnnual:true}),student=(auth.db.users||[]).find(u=>u.id===studentId&&u.role==="student");
      if(!student)throw Object.assign(new Error("دانش‌آموز پیدا نشد."),{status:404});
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId:student.classId,feature:"reports"}))throw Object.assign(new Error("مجوز ثبت کارنامه این دانش‌آموز را ندارید."),{status:403});
      const year=String(auth.db.school?.year||"");
      const existingOfficial=(auth.db.reportCards||[]).find(r=>r.studentId===studentId&&String(r.academicYear||"")===year&&normalizeAcademicPeriod(r.academicPeriod||r.period,{allowAnnual:true})===academicPeriod);
      if(existingOfficial?.status==="published")throw Object.assign(new Error("این کارنامه نهایی و قفل شده است؛ مدیر باید ابتدا آن را بازگشایی کند."),{status:409,code:"REPORT_CARD_LOCKED"});
      const disciplineScore=body.disciplineScore===null||body.disciplineScore===""?null:Number(body.disciplineScore),cultivationScore=body.cultivationScore===null||body.cultivationScore===""?null:Number(body.cultivationScore);
      const specialErrors=validateSpecialScoresCore({disciplineScore,cultivationScore,settings:auth.db.school?.settings||{}});
      if(specialErrors.length)throw Object.assign(new Error(specialErrors.map(x=>x.message).join(" ")),{status:400});
      const canPublish=["admin","superadmin"].includes(auth.user.role);
      if(body.status==="published"&&!canPublish)throw Object.assign(new Error("انتشار نهایی کارنامه فقط توسط مدیر مجاز است؛ معلم می‌تواند پیش‌نویس را تکمیل کند."),{status:403});
      const status=body.status==="published"?"published":"draft";
      const saved=await enqueueStateOperation(async()=>{const env=await ensureStateInitialized(),latest=env.db,existing=(latest.reportCards||[]).find(r=>r.studentId===studentId&&String(r.academicYear||"")===year&&normalizeAcademicPeriod(r.academicPeriod||r.period,{allowAnnual:true})===academicPeriod),now=new Date().toISOString();
        const row={id:existing?.id||makeId("rc"),studentId,classId:student.classId,academicYear:year,academicPeriod,disciplineScore,cultivationScore,teacherComment:String(body.teacherComment??existing?.teacherComment??"").slice(0,2000),managerComment:auth.user.role==="teacher"?String(existing?.managerComment||""):String(body.managerComment??existing?.managerComment??"").slice(0,2000),status,createdAt:existing?.createdAt||now,updatedAt:now,updatedBy:auth.user.id,publishedAt:status==="published"?now:null,publishedBy:status==="published"?auth.user.id:null,lockedAt:status==="published"?now:null,lockedBy:status==="published"?auth.user.id:null};
        latest.reportCards=(latest.reportCards||[]).filter(r=>r.id!==row.id&&!(r.studentId===studentId&&String(r.academicYear||"")===year&&normalizeAcademicPeriod(r.academicPeriod||r.period,{allowAnnual:true})===academicPeriod));latest.reportCards.push(row);return writeStateEnvelope(latest);});
      return sendJson(res,200,{ok:true,reportCard:(saved.db.reportCards||[]).find(r=>r.studentId===studentId&&String(r.academicYear||"")===year&&normalizeAcademicPeriod(r.academicPeriod||r.period,{allowAnnual:true})===academicPeriod),termReport:studentTermReportV185(saved.db,studentId,academicPeriod)});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/exam-sheet-codes") {
      const body = await readJson(req), examId = String(body.examId || ""), requested = Array.isArray(body.studentIds) ? body.studentIds.map(String) : [];
      const exam = (auth.db.exams || []).find(e => String(e.id) === examId);
      if (!exam) throw Object.assign(new Error("آزمون پیدا نشد."), { status: 404 });
      if (auth.user.role === "teacher" && !teacherCanAssigned(auth.db, auth.user, { classId: exam.classId, subject: exam.subject, bookId: exam.bookId, feature: "examCreate" })) {
        throw Object.assign(new Error("به برگه‌های این آزمون دسترسی ندارید."), { status: 403 });
      }
      const scope = auth.user.role === "teacher" ? teacherScope(auth.db, auth.user) : null;
      const students = (auth.db.users || []).filter(u => u.role === "student" && (!requested.length || requested.includes(String(u.id))) && (!exam.classId || String(u.classId) === String(exam.classId)));
      const codes = {};
      for (const student of students) {
        if (scope && !scope.studentIds.has(student.id)) continue;
        codes[student.id] = studentSheetCode(auth.security.serverSecret, student, exam);
      }
      if (requested.some(id => !codes[id])) throw Object.assign(new Error("حداقل یکی از دانش‌آموزان خارج از محدوده این آزمون است."), { status: 403 });
      return sendJson(res, 200, { ok: true, examId: exam.id, codes });
    }
    if (req.method === "POST" && url.pathname === "/api/staff/logout") {
      await mutateSecurity(security => { delete security.sessions[auth.tokenHash]; });
      await securityAudit({ type: "staff_logout", userId: auth.user.id, role: auth.user.role, ip: clientIp(req) });
      return sendJson(res, 200, { ok: true });
    }
    if (passwordChangeRoute) {
      const body = await readJson(req);
      const policyError = passwordPolicy(body.newPassword, auth.user.role); if (policyError) throw Object.assign(new Error(policyError), { status: 400 });
      const updated = await mutateSecurity(async security => {
        const credential = security.credentials[auth.user.id];
        if (!credential || !await passwordVerify(String(body.currentPassword || ""), credential.passwordHash)) return { error: "current" };
        if (await passwordVerify(String(body.newPassword), credential.passwordHash)) return { error: "same" };
        credential.passwordHash = await passwordHash(body.newPassword); credential.mustChangePassword = false; credential.passwordChangedAt = new Date().toISOString(); credential.credentialVersion = Number(credential.credentialVersion || 1) + 1;
        for (const [hash, sess] of Object.entries(security.sessions)) if (sess.userId === auth.user.id && hash !== auth.tokenHash) delete security.sessions[hash];
        return { ok: true };
      });
      if (updated.result?.error === "current") throw Object.assign(new Error("رمز فعلی صحیح نیست."), { status: 401 });
      if (updated.result?.error === "same") throw Object.assign(new Error("رمز جدید باید با رمز قبلی متفاوت باشد."), { status: 400 });
      await securityAudit({ type: "password_change", userId: auth.user.id, role: auth.user.role, ip: clientIp(req) });
      return sendJson(res, 200, { ok: true, token: auth.token, user: publicAuthUser(auth.user, updated.security), release: "72.35-p7-TEACHER-SAVE-FIX" });
    }
    if (req.method === "GET" && url.pathname === "/api/staff/sessions") {
      const rows = Object.entries(auth.security.sessions || {}).filter(([, s]) => s.userId === auth.user.id).map(([hash, s]) => ({ id: hash.slice(0, 16), current: hash === auth.tokenHash, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, ip: s.ip, userAgent: s.userAgent }));
      return sendJson(res, 200, { sessions: rows });
    }
    if (req.method === "POST" && url.pathname === "/api/staff/sessions/revoke-others") {
      await mutateSecurity(security => { for (const [hash, sess] of Object.entries(security.sessions)) if (sess.userId === auth.user.id && hash !== auth.tokenHash) delete security.sessions[hash]; });
      await securityAudit({ type: "session_revoke_others", userId: auth.user.id, role: auth.user.role, ip: clientIp(req) }); return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/security/audit") {
      if (!["admin", "superadmin"].includes(auth.user.role)) throw Object.assign(new Error("دسترسی به گزارش امنیتی فقط برای مدیر و ادمین مجاز است."), { status: 403 });
      return sendJson(res, 200, { events: await readSecurityAudit(url.searchParams.get("limit") || 500) });
    }
    if (req.method === "POST" && url.pathname === "/api/staff/users/create-student") {
      if (!isAdminRole(auth.user.role)) throw Object.assign(new Error("ثبت دانش‌آموز فقط برای مدیر یا ادمین مجاز است."), { status: 403 });
      const body=await readJson(req),firstName=String(body.firstName||"").trim(),lastName=String(body.lastName||"").trim(),nationalId=normalizeNationalId(body.nationalId),birthDate=normalizeStoredBirthDate(body.birthDate),classId=String(body.classId||""),guardianMobile=String(body.guardianMobile||"").trim();
      if(!firstName||!lastName)throw Object.assign(new Error("نام و نام خانوادگی دانش‌آموز الزامی است."),{status:400});
      if(!/^\d{10}$/.test(nationalId))throw Object.assign(new Error("کد ملی دانش‌آموز باید ۱۰ رقم باشد."),{status:400});
      if(!birthDate)throw Object.assign(new Error("تاریخ تولد دانش‌آموز معتبر نیست."),{status:400});
      const saved=await enqueueStateOperation(async()=>{
        const envelope=await ensureStateInitialized(),db=envelope.db;
        const sameNational=(db.users||[]).filter(u=>normalizeNationalId(u.nationalId)===nationalId);
if(sameNational.some(u=>u.profileStatus!=="deleted"))throw Object.assign(new Error("این کد ملی قبلاً برای یک کاربر فعال ثبت شده است."),{status:409});
if(sameNational.some(u=>u.profileStatus==="deleted"))throw Object.assign(new Error("این کاربر قبلاً حذف شده است؛ ابتدا از سطل بازیافت بازیابی کنید."),{status:409});
        const cls=(db.school?.classes||[]).find(c=>c.id===classId&&c.active!==false);
        if(!cls)throw Object.assign(new Error("کلاس انتخاب‌شده معتبر یا فعال نیست."),{status:400});
        const grade=Number(cls.grade||7),meta=gradeMeta(grade),base=`${grade}${nationalId.slice(-6)}`;let studentCode=base,n=1;
        while((db.users||[]).some(u=>String(u.studentCode||"")===studentCode))studentCode=`${base}${n++}`;
        const student={id:makeId("stu"),role:"student",nationalId,username:nationalId,firstName,lastName,active:true,birthDate,studentCode,classId,grade:meta.grade,gradeId:meta.id,gradeName:meta.name,guardianMobile:guardianMobile||"ثبت نشده",enrollmentYear:db.school?.year||"",academicYear:db.school?.year||""};
        db.users=Array.isArray(db.users)?db.users:[];db.users.push(student);
        db.audit=Array.isArray(db.audit)?db.audit:[];db.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"افزودن دانش‌آموز",details:`${firstName} ${lastName} — ${nationalId}`,at:faNow()});
        const written=await writeStateEnvelope(db);
        return {written,student};
      });
      // دانش‌آموز با کد ملی و تاریخ تولد وارد می‌شود؛ ساخت Credential سنگین در مسیر ثبت لازم نیست.
      await securityAudit({type:"student_create",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:saved.student.id});
      return sendJson(res,201,{ok:true,student:saved.student,updatedAt:saved.written.updatedAt,db:scopedDbForStaff(saved.written.db,auth.user)});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/classes/create") {
      if (!isAdminRole(auth.user.role)) throw Object.assign(new Error("ساخت کلاس فقط برای مدیر یا ادمین مجاز است."), { status: 403 });
      const body = await readJson(req);
      const name = String(body.name || "").trim().slice(0, 120);
      const grade = Number(body.grade);
      if (!name) throw Object.assign(new Error("نام کلاس الزامی است."), { status: 400 });
      if (![7,8,9].includes(grade)) throw Object.assign(new Error("پایه کلاس باید هفتم، هشتم یا نهم باشد."), { status: 400 });
      const saved = await enqueueStateOperation(async () => {
        const envelope = await ensureStateInitialized();
        const db = upgradeServerDbRespectingReset(structuredClone(envelope.db));
        db.school = db.school || {};
        db.school.classes = Array.isArray(db.school.classes) ? db.school.classes : [];
        if (db.school.classes.some(c => c.active !== false && String(c.name || "").trim() === name)) {
          throw Object.assign(new Error("کلاسی با این نام قبلاً ثبت شده است."), { status: 409 });
        }
        const meta = gradeMeta(grade);
        const row = {
          id: makeId("cls"), name, grade, gradeId: meta.id, gradeName: meta.name,
          active: true, academicYear: String(db.school.year || ""),
          createdAt: faNow(), createdBy: auth.user.id, updatedAt: faNow(), updatedBy: auth.user.id
        };
        db.school.classes.push(row);
        db.audit = Array.isArray(db.audit) ? db.audit : [];
        db.audit.unshift({id: makeId("log"), userId: auth.user.id, action: "افزودن کلاس", details: `${name} — ${meta.name}`, at: faNow()});
        const written = await writeStateEnvelope(db);
        return { written, row };
      });
      await securityAudit({type:"class_create",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:saved.row.id});
      return sendJson(res,201,{ok:true,class:saved.row,updatedAt:saved.written.updatedAt,db:scopedDbForStaff(saved.written.db,auth.user)});
    }

    if (req.method === "POST" && url.pathname === "/api/staff/users/create-teacher") {
      if (!isAdminRole(auth.user.role)) throw Object.assign(new Error("ثبت معلم فقط برای مدیر یا ادمین مجاز است."), { status: 403 });
      const body=await readJson(req),firstName=String(body.firstName||"").trim(),lastName=String(body.lastName||"").trim(),nationalId=normalizeNationalId(body.nationalId),subjects=Array.from(new Set((Array.isArray(body.subjects)?body.subjects:[]).map(x=>String(x||"").trim()).filter(Boolean))),classIds=Array.from(new Set((Array.isArray(body.classIds)?body.classIds:[]).map(x=>String(x||"").trim()).filter(Boolean)));
      if(!firstName||!lastName)throw Object.assign(new Error("نام و نام خانوادگی معلم الزامی است."),{status:400});if(!/^\d{10}$/.test(nationalId))throw Object.assign(new Error("کد ملی معلم باید ۱۰ رقم باشد."),{status:400});if(!subjects.length)throw Object.assign(new Error("حداقل یک درس برای معلم انتخاب کنید."),{status:400});
      const temporaryPassword=`Teach#${crypto.randomBytes(4).toString("hex")}A1`;
      const saved=await enqueueStateOperation(async()=>{const envelope=await ensureStateInitialized(),db=envelope.db;if((db.users||[]).some(u=>normalizeNationalId(u.nationalId)===nationalId))throw Object.assign(new Error("این کد ملی قبلاً ثبت شده است."),{status:409});const validClasses=new Set((db.school?.classes||[]).filter(c=>c.active!==false).map(c=>String(c.id))),validSubjects=new Set((db.school?.subjects||[]).map(x=>String(x||"").trim()).filter(Boolean)),teacher={id:makeId("tea"),role:"teacher",nationalId,username:nationalId,firstName,lastName,active:true,subjects:subjects.filter(x=>!validSubjects.size||validSubjects.has(x)),classIds:classIds.filter(x=>validClasses.has(x))};if(!teacher.subjects.length)throw Object.assign(new Error("درس انتخاب‌شده معتبر نیست."),{status:400});db.users=Array.isArray(db.users)?db.users:[];db.users.push(teacher);db.audit=Array.isArray(db.audit)?db.audit:[];db.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"افزودن معلم",details:`${firstName} ${lastName}`,at:faNow()});const written=await writeStateEnvelope(db);return {written,teacher};});
      await ensureSecurityInitialized(saved.written.db);
      await mutateSecurity(async security=>{const existing=security.credentials[saved.teacher.id]||{};security.credentials[saved.teacher.id]={...existing,username:nationalId,passwordHash:await passwordHash(temporaryPassword),mustChangePassword:true,failedLoginCount:0,lockedUntil:0,passwordChangedAt:null,credentialVersion:Number(existing.credentialVersion||0)+1};});
      await securityAudit({type:"teacher_create",userId:saved.teacher.id,role:"teacher",success:true,ip:clientIp(req),details:nationalId});
      return sendJson(res,201,{ok:true,teacher:saved.teacher,username:nationalId,temporaryPassword,updatedAt:saved.written.updatedAt,db:scopedDbForStaff(saved.written.db,auth.user)});
    }

    if (req.method === "POST" && url.pathname === "/api/staff/question-bank/delete") {
      if (!isAdminRole(auth.user.role)) throw Object.assign(new Error("حذف دائمی سؤال فقط برای مدیر یا ادمین مجاز است."), { status: 403 });
      const body=await readJson(req),ids=Array.from(new Set((Array.isArray(body.ids)?body.ids:[body.id]).map(x=>String(x||"").trim()).filter(Boolean)));
      if(!ids.length)throw Object.assign(new Error("شناسه سؤال برای حذف ارسال نشده است."),{status:400});
      if(ids.length>1000)throw Object.assign(new Error("حداکثر ۱۰۰۰ سؤال در هر عملیات حذف مجاز است."),{status:400});
      const saved=await enqueueStateOperation(async()=>{
        const envelope=await ensureStateInitialized(),db=upgradeServerDbRespectingReset(structuredClone(envelope.db)),wanted=new Set(ids);
        db.questionBank=Array.isArray(db.questionBank)?db.questionBank:[];
        const existing=db.questionBank.filter(q=>wanted.has(String(q.id)));
        if(!existing.length)throw Object.assign(new Error("سؤال انتخاب‌شده در مخزن پیدا نشد."),{status:404});
        const usedIds=new Set();
        for(const exam of db.exams||[])for(const q of exam.questions||[]){
          const sourceId=String(q.sourceQuestionId||q.questionId||"");
          if(wanted.has(sourceId))usedIds.add(sourceId);
        }
        for(const usage of db.questionUsage||[]){
          const qid=String(usage.questionId||usage.sourceQuestionId||"");
          if(wanted.has(qid))usedIds.add(qid);
        }
        if(usedIds.size)throw Object.assign(new Error(`${usedIds.size} سؤال در آزمون/سوابق استفاده شده‌اند و حذف دائمی آن‌ها برای حفظ صحت نتایج مجاز نیست. ابتدا وابستگی آن‌ها را بررسی کنید.`),{status:409});
        db.questionBank=db.questionBank.filter(q=>!wanted.has(String(q.id)));
        db.questionReviews=(db.questionReviews||[]).filter(r=>!wanted.has(String(r.questionId||"")));
        const removed=existing.length;
        db.audit=Array.isArray(db.audit)?db.audit:[];
        db.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"حذف دائمی سؤال از دیتابیس",details:`${removed} سؤال`,at:faNow()});
        const written=await writeStateEnvelope(db);
        return {written,removed};
      });
      await securityAudit({type:"question_bank_hard_delete",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:`removed=${saved.removed}`});
      return sendJson(res,200,{ok:true,removed:saved.removed,updatedAt:saved.written.updatedAt,db:scopedDbForStaff(saved.written.db,auth.user)});
    }


    if (req.method === "POST" && url.pathname === "/api/staff/question-bank/clear") {
      if (!isAdminRole(auth.user.role)) throw Object.assign(new Error("پاک‌سازی کامل مخزن فقط برای مدیر یا ادمین مجاز است."), { status: 403 });
      const body=await readJson(req);
      if(String(body.confirm||"").trim()!=="پاک کردن مخزن")throw Object.assign(new Error("عبارت تأیید پاک‌سازی صحیح نیست."),{status:400});

      const saved=await enqueueStateOperation(async()=>{
        const envelope=await ensureStateInitialized(),db=upgradeServerDbRespectingReset(structuredClone(envelope.db));
        db.questionBank=Array.isArray(db.questionBank)?db.questionBank:[];
        const allIds=new Set(db.questionBank.map(q=>String(q.id)));
        const protectedIds=new Set();

        for(const exam of db.exams||[])for(const q of exam.questions||[]){
          const sourceId=String(q.sourceQuestionId||q.questionId||"").trim();
          if(sourceId&&allIds.has(sourceId))protectedIds.add(sourceId);
        }
        for(const usage of db.questionUsage||[]){
          const qid=String(usage.questionId||usage.sourceQuestionId||"").trim();
          if(qid&&allIds.has(qid)&&Number(usage.usedCount||1)>0)protectedIds.add(qid);
        }

        const removableIds=new Set([...allIds].filter(id=>!protectedIds.has(id)));
        const beforeCount=db.questionBank.length;
        db.questionBank=db.questionBank.filter(q=>!removableIds.has(String(q.id)));

        // Remove dependent metadata only for questions that were actually deleted.
        db.questionReviews=(db.questionReviews||[]).filter(r=>!removableIds.has(String(r.questionId||"")));
        db.questionVersions=(db.questionVersions||[]).filter(v=>!removableIds.has(String(v.questionId||"")));
        db.questionAnalytics=(db.questionAnalytics||[]).filter(v=>!removableIds.has(String(v.questionId||v.id||"")));
        db.questionUsage=(db.questionUsage||[]).filter(v=>!removableIds.has(String(v.questionId||v.sourceQuestionId||"")));
        db.questionCollections=(db.questionCollections||[]).map(c=>{
          const ids=Array.isArray(c.questionIds)?c.questionIds.filter(id=>!removableIds.has(String(id))):c.questionIds;
          const questions=Array.isArray(c.questions)?c.questions.filter(x=>!removableIds.has(String(x?.questionId||x?.id||x))):c.questions;
          return {...c,questionIds:ids,questions};
        });

        const removed=beforeCount-db.questionBank.length,protectedCount=protectedIds.size,remaining=db.questionBank.length;
        db.audit=Array.isArray(db.audit)?db.audit:[];
        db.audit.unshift({
          id:makeId("log"),userId:auth.user.id,action:"پاک‌سازی کامل مخزن سؤال",
          details:`حذف‌شده=${removed} | محافظت‌شده=${protectedCount} | باقی‌مانده=${remaining}`,at:faNow()
        });
        const written=await writeStateEnvelope(db);
        return {written,removed,protectedCount,remaining,protectedIds:[...protectedIds].slice(0,100)};
      });

      await securityAudit({
        type:"question_bank_clear",
        userId:auth.user.id,role:auth.user.role,ip:clientIp(req),
        details:`removed=${saved.removed}; protected=${saved.protectedCount}; remaining=${saved.remaining}`
      });
      return sendJson(res,200,{
        ok:true,removed:saved.removed,protected:saved.protectedCount,remaining:saved.remaining,
        protectedIds:saved.protectedIds,updatedAt:saved.written.updatedAt,
        db:scopedDbForStaff(saved.written.db,auth.user)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/staff/question-bank/import") {
      if (!isAdminRole(auth.user.role)) throw Object.assign(new Error("ورود گروهی مخزن سؤال فقط برای مدیر یا ادمین مجاز است."), { status: 403 });
      const body=await readJson(req);
      const items=Array.isArray(body)?body:(body.questions||body.items||body.questionBank);
      if(!Array.isArray(items))throw Object.assign(new Error("ساختار JSON باید آرایه questions/items/questionBank داشته باشد."),{status:400});
      if(items.length>5000)throw Object.assign(new Error("حداکثر ۵۰۰۰ سؤال در هر فایل مجاز است."),{status:400});

      const saved=await enqueueStateOperation(async()=>{
        const envelope=await ensureStateInitialized(),db=upgradeServerDbRespectingReset(structuredClone(envelope.db));
        db.curriculum=Array.isArray(db.curriculum)?db.curriculum:[];
        db.questionBank=Array.isArray(db.questionBank)?db.questionBank:[];
        const existingIds=new Set(db.questionBank.map(q=>String(q.id)));
        const existingFp=new Set(db.questionBank.map(q=>q.fingerprint||questionFingerprintCore(q)));
        let added=0,duplicates=0,invalid=0,booksAdded=0,chaptersAdded=0;
        const invalidRows=[];

        for(let i=0;i<items.length;i++){
          const raw=items[i]||{},grade=Number(raw.grade||raw.gradeLevel||0),subject=String(raw.subject||"").trim();
          const bookId=String(raw.bookId||"").trim(),chapterId=String(raw.chapterId||"").trim(),chapterTitle=String(raw.chapter||"فصل 1").trim()||"فصل 1";
          if(!bookId||!subject||![7,8,9].includes(grade)){invalid++;invalidRows.push(`${i+1}: پایه/درس/کتاب نامعتبر`);continue;}

          let book=db.curriculum.find(b=>String(b.id)===bookId);
          if(!book){
            const code=bookId.replace(/^seed-book-/,"")||`${subject}-${grade}`;
            book={id:bookId,title:String(raw.bookTitle||`${subject} پایه ${grade}`),subject,grade,code,academicYear:db.school?.year||"",edition:"",description:"",status:"published",active:true,chapters:[],createdAt:faNow(),createdBy:"qbank-import"};
            db.curriculum.push(book);booksAdded++;
          }
          if(Number(book.grade)!==grade||String(book.subject)!==subject){invalid++;invalidRows.push(`${i+1}: کتاب با پایه/درس سؤال سازگار نیست`);continue;}
          book.chapters=Array.isArray(book.chapters)?book.chapters:[];
          let chapter=book.chapters.find(c=>String(c.id)===chapterId);
          if(!chapter){
            const order=Number(String(chapterTitle).match(/\d+/)?.[0]||1);
            chapter={id:chapterId||`${book.id}-ch-${order}`,order,title:chapterTitle,description:"",active:true,topics:[]};
            book.chapters.push(chapter);chaptersAdded++;
          }

          const prepared={...raw,bookId:book.id,chapterId:chapter.id,chapter:chapterTitle,subject:book.subject,grade,status:"needs_review",
            submittedForReviewAt:raw.submittedForReviewAt||faNow(),submittedForReviewBy:auth.user.id,
            createdBy:raw.createdBy||auth.user.id,createdAt:raw.createdAt||faNow()};
          if(!prepared.id)prepared.id=makeId("q");
          const q=normalizeQuestionCore(prepared,book),errors=validateQuestionCore(q,book);
          if(errors.length){invalid++;invalidRows.push(`${i+1}: ${errors.join(" ")}`);continue;}
          const fp=questionFingerprintCore(q);
          if(existingIds.has(String(q.id))||existingFp.has(fp)){duplicates++;continue;}
          const meta=gradeMeta(book.grade);
          db.questionBank.push({...q,fingerprint:fp,subject:book.subject,grade:meta.grade,gradeId:meta.id,gradeName:meta.name,
            submittedForReviewAt:prepared.submittedForReviewAt,submittedForReviewBy:auth.user.id});
          existingIds.add(String(q.id));existingFp.add(fp);added++;
        }

        if(!added&&invalid)throw Object.assign(new Error(`هیچ سؤالی وارد نشد. ${invalidRows.slice(0,5).join(" | ")}`),{status:400});
        const written=await writeStateEnvelope(db);
        return {written,summary:{added,duplicates,invalid,booksAdded,chaptersAdded,invalidRows:invalidRows.slice(0,20)}};
      });
      await securityAudit({type:"question_bank_import",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:JSON.stringify(saved.summary)});
      return sendJson(res,200,{ok:true,...saved.summary,updatedAt:saved.written.updatedAt,db:scopedDbForStaff(saved.written.db,auth.user)});
    }

    if (req.method === "POST" && url.pathname === "/api/staff/users/reset-password") {
      if (!isAdminRole(auth.user.role)) throw Object.assign(new Error("بازنشانی رمز فقط برای مدیر یا ادمین مجاز است."), { status: 403 });
      const body = await readJson(req); const target = (auth.db.users || []).find(u => u.id === body.userId && u.active);
      if (!target) throw Object.assign(new Error("کاربر فعال پیدا نشد."), { status: 404 });
      if (target.id === auth.user.id) throw Object.assign(new Error("برای حساب خودتان از بخش تغییر رمز استفاده کنید."), { status: 400 });
      if (!canResetPassword(auth.user.role,target.role)) {
        if(target.role==="student") throw Object.assign(new Error("دانش‌آموز رمز عبور ندارد؛ کد ملی و تاریخ تولد او را ویرایش کنید."), { status: 400 });
        throw Object.assign(new Error("اجازه بازنشانی رمز این حساب را ندارید."), { status: 403 });
      }
      await ensureSecurityInitialized(auth.db);
      const requestedInitialPassword = String(body.initialPassword || body.newPassword || "");
      if (target.role === "teacher" && requestedInitialPassword) {
        const initialError = initialStaffPasswordPolicy(requestedInitialPassword);
        if (initialError) throw Object.assign(new Error(initialError), { status: 400 });
      }
      const prefix = target.role === "teacher" ? "Teach" : target.role === "admin" ? "Manager" : "Admin";
      const temporaryPassword = requestedInitialPassword || `${prefix}#${crypto.randomBytes(4).toString("hex")}A1`;
      const updated = await mutateSecurity(async security => {
        const credential = security.credentials[target.id];
        if (!credential) return { error: "missing" };
        credential.passwordHash = await passwordHash(temporaryPassword); credential.mustChangePassword = true; credential.passwordChangedAt = new Date().toISOString(); credential.credentialVersion = Number(credential.credentialVersion || 1) + 1;
        for (const [hash, sess] of Object.entries(security.sessions || {})) if (sess.userId === target.id) delete security.sessions[hash];
        return { username: credential.username };
      });
      if (updated.result?.error) throw Object.assign(new Error("اطلاعات امنیتی کاربر پیدا نشد."), { status: 500 });
      await securityAudit({ type: "password_reset", userId: target.id, role: target.role, ip: clientIp(req), details: `توسط ${auth.user.id}` });
      return sendJson(res, 200, { ok: true, username: updated.result.username, temporaryPassword, mustChangePassword: true });
    }
    if (req.method === "GET" && url.pathname === "/api/staff/users/security-overview") {
      if (!["admin", "superadmin"].includes(auth.user.role)) throw Object.assign(new Error("این بخش فقط برای ادمین مجاز است."), { status: 403 });
      const security=await readSecurity();
      const sessionCounts={}; for(const sess of Object.values(security.sessions||{}))sessionCounts[sess.userId]=(sessionCounts[sess.userId]||0)+1;
      const users=(auth.db.users||[]).filter(u=>u.role!=="student").filter(u=>auth.user.role==="superadmin"||u.role!=="superadmin").map(u=>{const c=security.credentials?.[u.id]||{};return {id:u.id,role:u.role,name:`${u.firstName||""} ${u.lastName||""}`.trim(),nationalId:u.nationalId||"",active:u.active!==false,profileStatus:u.profileStatus||"active",username:c.username||"",mustChangePassword:Boolean(c.mustChangePassword),lastLoginAt:c.lastLoginAt||"",lastLoginIp:c.lastLoginIp||"",sessionCount:Number(sessionCounts[u.id]||0)};});
      return sendJson(res,200,{users});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/users/security-action") {
      if (!["admin", "superadmin"].includes(auth.user.role)) throw Object.assign(new Error("این عملیات فقط برای ادمین مجاز است."), { status: 403 });
      const body=await readJson(req), action=String(body.action||""), target=(auth.db.users||[]).find(u=>u.id===body.userId);
      if(!target)throw Object.assign(new Error("کاربر پیدا نشد."),{status:404});
      if(target.id===auth.user.id&&action==="lock")throw Object.assign(new Error("حساب خودتان را نمی‌توانید قفل کنید."),{status:400});
      if(target.role==="superadmin"&&auth.user.role!=="superadmin")throw Object.assign(new Error("مدیر مدرسه اجازه تغییر حساب ادمین فنی را ندارد."),{status:403});
      if(["deleted","graduated"].includes(target.profileStatus)&&["lock","unlock"].includes(action))throw Object.assign(new Error("ابتدا وضعیت کاربر را از سطل بازیافت/بایگانی اصلاح کنید."),{status:400});
      if(action==="revokeSessions"){
        const result=await mutateSecurity(sec=>{let n=0;for(const [h,x] of Object.entries(sec.sessions||{}))if(x.userId===target.id){delete sec.sessions[h];n++;}return n;});
        await securityAudit({type:"user_sessions_revoke",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:`target=${target.id};count=${result.result||0}`});
        return sendJson(res,200,{ok:true,revoked:Number(result.result||0)});
      }
      if(!["lock","unlock"].includes(action))throw Object.assign(new Error("عملیات امنیتی معتبر نیست."),{status:400});
      const saved=await enqueueStateOperation(async()=>{const latest=(await ensureStateInitialized()).db;const t=(latest.users||[]).find(u=>u.id===target.id);if(!t)throw Object.assign(new Error("کاربر پیدا نشد."),{status:404});t.active=action==="unlock";t.profileStatus=action==="lock"?"locked":"active";t.accountStatusUpdatedAt=new Date().toISOString();t.accountStatusUpdatedBy=auth.user.id;latest.audit=Array.isArray(latest.audit)?latest.audit:[];latest.audit.unshift({id:makeId("log"),userId:auth.user.id,action:action==="lock"?"قفل حساب":"فعال‌سازی حساب",details:`${t.role}:${t.id}`,at:faNow()});return writeStateEnvelope(latest);});
      if(action==="lock")await mutateSecurity(sec=>{for(const [h,x] of Object.entries(sec.sessions||{}))if(x.userId===target.id)delete sec.sessions[h];});
      await securityAudit({type:`user_${action}`,userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:target.id});
      return sendJson(res,200,{ok:true,db:scopedDbForStaff(saved.db,auth.user)});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/users/delete") {
      if (!["admin", "superadmin"].includes(auth.user.role)) throw Object.assign(new Error("حذف کاربر فقط برای مدیر یا ادمین فنی مجاز است."), { status: 403 });
      const body = await readJson(req); const target = (auth.db.users || []).find(u => u.id === body.userId);
      if (!target) throw Object.assign(new Error("کاربر پیدا نشد."), { status: 404 });
      if (!["student", "teacher"].includes(target.role)) throw Object.assign(new Error("فقط معلم یا دانش‌آموز از این بخش قابل حذف است."), { status: 400 });
      const confirmNationalId = normalizeNationalId(body.nationalId);
      if (!confirmNationalId || !safeEqualText(confirmNationalId, normalizeNationalId(target.nationalId))) throw Object.assign(new Error("کد ملی تأیید حذف صحیح نیست."), { status: 400 });
      const saved = await enqueueStateOperation(async () => {const envelope=await ensureStateInitialized();const latest=envelope.db;const live=(latest.users||[]).find(u=>u.id===target.id);if(!live)throw Object.assign(new Error("کاربر پیدا نشد."),{status:404});if(live.profileStatus==="deleted")return {...envelope,alreadyRecycled:true};await createStateSnapshot(`before-recycle-${live.role}`);live.active=false;live.profileStatus="deleted";live.deletedAt=new Date().toISOString();live.deletedAtFa=faNow();live.deletedBy=auth.user.id;latest.audit=Array.isArray(latest.audit)?latest.audit:[];latest.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"انتقال کاربر به سطل بازیافت",details:`${live.role}:${live.id}`,at:faNow()});const written=await writeStateEnvelope(latest,{skipSnapshot:true});return {...written,alreadyRecycled:false};});
      await mutateSecurity(sec=>{for(const [h,x] of Object.entries(sec.sessions||{}))if(x.userId===target.id)delete sec.sessions[h];});
      await securityAudit({ type: saved.alreadyRecycled?"user_recycle_idempotent":"user_recycle", userId: auth.user.id, role: auth.user.role, ip: clientIp(req), details: `${target.role}:${target.id}` });
      return sendJson(res, 200, { ok: true, alreadyRecycled:Boolean(saved.alreadyRecycled), recycledUserId: target.id, retentionDays:Number(saved.db.school?.settings?.recycleRetentionDays||30), updatedAt: saved.updatedAt, db: scopedDbForStaff(saved.db, auth.user) });
    }
    if (req.method === "POST" && url.pathname === "/api/staff/users/restore") {
      if (!["admin","superadmin"].includes(auth.user.role)) throw Object.assign(new Error("بازیابی کاربر فقط برای ادمین مجاز است."),{status:403});
      const body=await readJson(req);const saved=await enqueueStateOperation(async()=>{const latest=(await ensureStateInitialized()).db;const t=(latest.users||[]).find(u=>u.id===body.userId&&u.profileStatus==="deleted");if(!t)throw Object.assign(new Error("کاربر در سطل بازیافت پیدا نشد."),{status:404});t.active=true;t.profileStatus="active";delete t.deletedAt;delete t.deletedAtFa;delete t.deletedBy;t.restoredAt=new Date().toISOString();t.restoredBy=auth.user.id;latest.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"بازیابی کاربر از سطل بازیافت",details:`${t.role}:${t.id}`,at:faNow()});return writeStateEnvelope(latest);});
      await securityAudit({type:"user_restore",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:String(body.userId||"")});return sendJson(res,200,{ok:true,db:scopedDbForStaff(saved.db,auth.user)});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/users/delete-permanent") {
      if (auth.user.role !== "superadmin") throw Object.assign(new Error("حذف دائمی فقط برای ادمین فنی مجاز است."),{status:403});
      const body=await readJson(req),target=(auth.db.users||[]).find(u=>u.id===body.userId&&u.profileStatus==="deleted");if(!target)throw Object.assign(new Error("کاربر در سطل بازیافت پیدا نشد."),{status:404});
      const nid=normalizeNationalId(body.nationalId);if(!nid||!safeEqualText(nid,normalizeNationalId(target.nationalId)))throw Object.assign(new Error("کد ملی تأیید حذف دائمی صحیح نیست."),{status:400});
      const saved=await enqueueStateOperation(async()=>{const latest=(await ensureStateInitialized()).db;const live=(latest.users||[]).find(u=>u.id===target.id&&u.profileStatus==="deleted");if(!live)throw Object.assign(new Error("کاربر در سطل بازیافت پیدا نشد."),{status:404});await createStateSnapshot(`before-permanent-delete-${live.role}`);const purged=purgeUserFromStateV4516(latest,live);purged.audit=Array.isArray(purged.audit)?purged.audit:[];purged.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"حذف دائمی کاربر",details:`${live.role}:${live.id}`,at:faNow()});return writeStateEnvelope(purged,{skipSnapshot:true});});
      await mutateSecurity(sec=>{delete sec.credentials[target.id];for(const [h,x] of Object.entries(sec.sessions||{}))if(x.userId===target.id)delete sec.sessions[h];});
      await securityAudit({type:"user_delete_permanent",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:`${target.role}:${target.id}`});return sendJson(res,200,{ok:true,db:scopedDbForStaff(saved.db,auth.user)});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/exam-delivery-recovery") {
      const body=await readJson(req),requestId=String(body.requestId||""),action=String(body.action||"");
      if(!["approve","reject","resolve"].includes(action))throw Object.assign(new Error("عملیات بازیابی معتبر نیست."),{status:400});
      const reason=String(body.reason||"").trim().slice(0,600);
      if(reason.length<5)throw Object.assign(new Error("دلیل تصمیم را کامل وارد کنید."),{status:400});
      const current=deliveryRecoveryRowsV65(auth.db).find(r=>r.id===requestId);
      if(!current)throw Object.assign(new Error("درخواست بازیابی پیدا نشد."),{status:404});
      const exam=(auth.db.exams||[]).find(e=>e.id===current.examId);
      if(!exam)throw Object.assign(new Error("آزمون مرتبط پیدا نشد."),{status:404});
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId:exam.classId,subject:exam.subject,bookId:exam.bookId,feature:"examCreate"}))throw Object.assign(new Error("این درخواست خارج از محدوده دسترسی شماست."),{status:403});
      if(action==="approve"&&String(current.packageVersion||"")!==String(examPackageVersion(exam)))throw Object.assign(new Error("نسخه بسته دانش‌آموز با آزمون فعلی یکی نیست؛ Retry خودکار امن نیست و باید دستی بررسی شود."),{status:409,code:"RECOVERY_PACKAGE_STALE"});
      const saved=await mutateDb(async mutable=>{
        const r=deliveryRecoveryRowsV65(mutable).find(x=>x.id===requestId);if(!r)throw Object.assign(new Error("درخواست بازیابی پیدا نشد."),{status:404});
        const liveExam=(mutable.exams||[]).find(e=>e.id===r.examId);if(!liveExam)throw Object.assign(new Error("آزمون مرتبط پیدا نشد."),{status:404});
        if(action==="approve"&&String(r.packageVersion||"")!==String(examPackageVersion(liveExam)))throw Object.assign(new Error("نسخه آزمون در زمان بررسی تغییر کرده است؛ Retry خودکار امن نیست."),{status:409,code:"RECOVERY_PACKAGE_STALE"});
        if(auth.user.role==="teacher"&&!teacherCanAssigned(mutable,auth.user,{classId:liveExam.classId,subject:liveExam.subject,bookId:liveExam.bookId,feature:"examCreate"}))throw Object.assign(new Error("دسترسی شما به این آزمون تغییر کرده است."),{status:403});
        r.reviewedBy=auth.user.id;r.reviewedAt=Date.now();r.reviewReason=reason;
        if(action==="approve"){r.status="approved";r.expiresAt=Date.now()+24*60*60*1000;r.approvedAt=Date.now();}
        else if(action==="reject"){r.status="rejected";r.rejectedAt=Date.now();}
        else {r.status="resolved";r.resolvedAt=Date.now();}
        mutable.notifications ||= []; mutable.notifications.unshift({id:makeId("not"),userId:r.studentId,title:action==="approve"?"مجوز ارسال مجدد آزمون":"نتیجه بررسی تحویل آزمون",body:action==="approve"?"مدرسه برای همان پاسخ نهایی‌شده مجوز ارسال مجدد صادر کرد. از بخش وضعیت تحویل، ارسال مجدد را بزنید.":reason,read:false,at:faNow()});
        mutable.audit ||= []; mutable.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"تصمیم Recovery تحویل آزمون",details:`${requestId}:${action}`,at:faNow()});return r;
      });
      await securityAudit({type:"exam_delivery_recovery",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:`${requestId}:${action}`});
      return sendJson(res,200,{ok:true,request:saved.result});
    }

    if (req.method === "POST" && url.pathname === "/api/staff/exam-incidents") {
      const body=await readJson(req),incidentId=String(body.incidentId||""),action=String(body.action||""),reason=String(body.reason||"").trim();
      if(!["confirm_technical","no_adjustment","grant_window","reject"].includes(action))throw Object.assign(new Error("اقدام Incident معتبر نیست."),{status:400});
      if(reason.length<5)throw Object.assign(new Error("دلیل تصمیم باید کامل ثبت شود."),{status:400});
      const incident=examIncidentRowsV66(auth.db).find(x=>x.id===incidentId);if(!incident)throw Object.assign(new Error("Incident پیدا نشد."),{status:404});
      const exam=(auth.db.exams||[]).find(e=>e.id===incident.examId);if(!exam)throw Object.assign(new Error("آزمون پیدا نشد."),{status:404});
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId:exam.classId,subject:exam.subject,bookId:exam.bookId,feature:"examCreate"}))throw Object.assign(new Error("مجوز بررسی این Incident را ندارید."),{status:403});
      const minutes=action==="grant_window"?Math.max(5,Math.min(30,Number(body.minutes||0))):0;
      if(action==="grant_window"){
        if((auth.db.attempts||[]).some(x=>x.examId===exam.id&&x.studentId===incident.studentId)||(auth.db.submissions||[]).some(x=>x.examId===exam.id&&x.studentId===incident.studentId))throw Object.assign(new Error("دانش‌آموز قبلاً آزمون را تحویل داده است؛ پنجره جدید مجاز نیست."),{status:409});
        const pub=String(exam.publicationState||"").toLowerCase();if(!["published","in_progress","ended"].includes(pub)&&String(exam.status||"").toLowerCase()!=="active")throw Object.assign(new Error("این آزمون در مرحله‌ای نیست که بازگشایی محدود آن امن باشد."),{status:409});
      }
      const saved=await mutateDb(async mutable=>{mutable.examIncidents ||= [];const row=mutable.examIncidents.find(x=>x.id===incidentId);if(!row)throw Object.assign(new Error("Incident پیدا نشد."),{status:404});row.status=action==="reject"?"rejected":action==="grant_window"?"adjusted":action==="confirm_technical"?"technical_confirmed":"closed_no_adjustment";row.reviewedAt=Date.now();row.reviewedBy=auth.user.id;row.reviewReason=reason;row.reviewAction=action;if(action==="grant_window"){mutable.examFairnessAdjustments ||= [];for(const x of mutable.examFairnessAdjustments){if(x.studentId===row.studentId&&x.examId===row.examId&&x.status==="active")x.status="superseded";}const adj={id:makeId("fair"),incidentId:row.id,studentId:row.studentId,examId:row.examId,minutes,reason,createdAt:Date.now(),createdBy:auth.user.id,expiresAt:Date.now()+minutes*60*1000,status:"active"};mutable.examFairnessAdjustments.push(adj);row.fairnessAdjustmentId=adj.id;mutable.notifications ||= [];mutable.notifications.unshift({id:makeId("not"),userId:row.studentId,title:"فرصت محدود آزمون فعال شد",body:`برای آزمون «${exam.title}» یک پنجره ${minutes} دقیقه‌ای فعال شد. پس از همگام‌سازی وارد آزمون شوید.`,read:false,at:faNow()});}mutable.audit ||= [];mutable.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"تصمیم Incident آزمون",details:`${incidentId}:${action}`,at:faNow()});return row;});
      await securityAudit({type:"exam_incident_review",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:`${incidentId}:${action}`});
      return sendJson(res,200,{ok:true,incident:saved.result});
    }

    if (req.method === "POST" && url.pathname === "/api/staff/exams/lifecycle") {
      const body=await readJson(req),next=String(body.state||""),allowed=["draft","ready","published","in_progress","ended","graded","final","archived"];
      if(!allowed.includes(next))throw Object.assign(new Error("مرحله آزمون معتبر نیست."),{status:400});
      const transitions={draft:["ready"],ready:["draft","published"],published:["ready","in_progress"],in_progress:["ended"],ended:["graded"],graded:["final"],final:["archived"],archived:[]};
      const current=(auth.db.exams||[]).find(e=>e.id===body.examId);if(!current)throw Object.assign(new Error("آزمون پیدا نشد."),{status:404});
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId:current.classId,subject:current.subject,bookId:current.bookId,feature:next==="published"?"examPublish":"examCreate"}))throw Object.assign(new Error("مجوز تغییر مرحله این آزمون را ندارید."),{status:403});
      const from=current.publicationState||((current.status==="active")?"published":current.status==="archived"?"archived":"draft");if(!transitions[from]?.includes(next))throw Object.assign(new Error(`انتقال از ${from} به ${next} مجاز نیست.`),{status:400});
      if(next==="ready"&&!(current.questions||[]).length)throw Object.assign(new Error("آزمون بدون سؤال آماده انتشار نمی‌شود."),{status:400});
      if(["ready","published"].includes(next)){
        const studentProblems=validateExamForStudentV61(current);
        if(studentProblems.length)throw Object.assign(new Error(`آزمون برای پنل دانش‌آموز آماده نیست: ${studentProblems.slice(0,4).join(" | ")}`),{status:400,details:studentProblems});
        const total=examTotalScore(current),target=Number(current.targetScore)>0?Number(current.targetScore):total;if(target<=0||Math.abs(total-target)>0.001)throw Object.assign(new Error(`بارم آزمون کامل نیست؛ نمره کل ${target} و جمع سؤال‌ها ${total} است.`),{status:400});
      }
      if(next==="graded"){const pending=(auth.db.submissions||[]).filter(x=>x.examId===current.id&&!((auth.db.grades||[]).some(g=>g.submissionId===x.id)));if(pending.length)throw Object.assign(new Error(`${pending.length} برگه هنوز نمره نهایی ندارد.`),{status:400});}
      const saved=await enqueueStateOperation(async()=>{const latest=(await ensureStateInitialized()).db,ex=(latest.exams||[]).find(e=>e.id===current.id);if(!ex)throw Object.assign(new Error("آزمون پیدا نشد."),{status:404});ex.publicationState=next;ex.status=["published","in_progress"].includes(next)?"active":next==="archived"?"archived":"draft";ex.availabilityRevision=Number(ex.availabilityRevision||1)+1;ex.lifecycleUpdatedAt=new Date().toISOString();ex.lifecycleUpdatedBy=auth.user.id;if(next==="published"&&!ex.publishedAt)ex.publishedAt=new Date().toISOString();if(from==="published"&&next==="ready")ex.withdrawnAt=new Date().toISOString();if(next==="final")ex.finalizedAt=new Date().toISOString();latest.examPublicationHistory=Array.isArray(latest.examPublicationHistory)?latest.examPublicationHistory:[];latest.examPublicationHistory.unshift({id:makeId("eph"),examId:ex.id,from,to:next,by:auth.user.id,at:new Date().toISOString(),reason:String(body.reason||"").slice(0,500)});latest.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"تغییر چرخه آزمون",details:`${ex.title}:${from}->${next}`,at:faNow()});return writeStateEnvelope(latest);});
      await securityAudit({type:"exam_lifecycle",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:`${current.id}:${from}->${next}`});return sendJson(res,200,{ok:true,db:scopedDbForStaff(saved.db,auth.user)});
    }


    // v45.26 — معلم می‌تواند فقط در کلاس‌های تخصیص‌یافته خودش دانش‌آموز جدید ثبت کند.
    // این مسیر عمداً اجازه ویرایش/حذف کاربران موجود را به معلم نمی‌دهد.
    if (req.method === "POST" && url.pathname === "/api/staff/students") {
      const body = await readJson(req);
      const firstName = String(body.firstName || "").trim();
      const lastName = String(body.lastName || "").trim();
      const nationalId = normalizeNationalId(body.nationalId);
      const birthDate = normalizeStoredBirthDate(body.birthDate);
      const classId = String(body.classId || "").trim();
      const guardianMobile = String(body.guardianMobile || "").trim() || "ثبت نشده";
      if (!firstName || !lastName) throw Object.assign(new Error("نام و نام خانوادگی دانش‌آموز الزامی است."), { status: 400 });
      if (!/^\d{10}$/.test(nationalId)) throw Object.assign(new Error("کد ملی دانش‌آموز باید ۱۰ رقم باشد."), { status: 400 });
      if (!birthDate || birthDate.length !== 10) throw Object.assign(new Error("تاریخ تولد دانش‌آموز کامل و معتبر نیست."), { status: 400 });
      const classRow = (auth.db.school?.classes || []).find(c => c.id === classId && c.active !== false);
      if (!classRow) throw Object.assign(new Error("کلاس انتخاب‌شده معتبر یا فعال نیست."), { status: 400 });
      if (auth.user.role === "teacher" && !teacherCanAssigned(auth.db, auth.user, { classId, feature: "students" })) {
        throw Object.assign(new Error("ثبت دانش‌آموز فقط در کلاس‌های تخصیص‌یافته به شما مجاز است."), { status: 403 });
      }
      const saved = await enqueueStateOperation(async () => {
        const latest = (await ensureStateInitialized()).db;
        const liveClass = (latest.school?.classes || []).find(c => c.id === classId && c.active !== false);
        if (!liveClass) throw Object.assign(new Error("کلاس انتخاب‌شده دیگر فعال نیست."), { status: 409 });
        if (auth.user.role === "teacher" && !teacherCanAssigned(latest, auth.user, { classId, feature: "students" })) {
          throw Object.assign(new Error("تخصیص شما به این کلاس تغییر کرده است؛ صفحه را به‌روزرسانی کنید."), { status: 403 });
        }
        if ((latest.users || []).some(u => normalizeNationalId(u.nationalId) === nationalId && u.profileStatus !== "deleted")) {
          throw Object.assign(new Error("این کد ملی قبلاً در سامانه ثبت شده است."), { status: 409 });
        }
        const grade = Number(liveClass.grade || 0);
        const meta = gradeMeta(grade);
        let baseCode = `${grade || 7}${nationalId.slice(-6)}`;
        let studentCode = baseCode, suffix = 1;
        while ((latest.users || []).some(u => String(u.studentCode || "") === studentCode)) studentCode = `${baseCode}${suffix++}`;
        const student = {
          id: makeId("stu"),
          role: "student",
          username: nationalId,
          nationalId,
          firstName,
          lastName,
          birthDate,
          studentCode,
          classId,
          grade: meta.grade,
          gradeId: meta.id,
          gradeName: meta.name,
          guardianMobile,
          enrollmentYear: latest.school?.year || "",
          active: true,
          profileStatus: "active",
          createdAt: faNow(),
          createdAtIso: new Date().toISOString(),
          createdBy: auth.user.id
        };
        latest.users = Array.isArray(latest.users) ? latest.users : [];
        latest.users.push(student);
        latest.audit = Array.isArray(latest.audit) ? latest.audit : [];
        latest.audit.unshift({
          id: makeId("log"),
          userId: auth.user.id,
          action: auth.user.role === "teacher" ? "ثبت دانش‌آموز توسط معلم" : "ثبت دانش‌آموز",
          details: `${firstName} ${lastName} · ${liveClass.name || classId} · ${studentCode}`,
          at: faNow()
        });
        const env = await writeStateEnvelope(latest);
        return { env, student };
      });
      await securityAudit({
        type: "student_create",
        userId: auth.user.id,
        role: auth.user.role,
        ip: clientIp(req),
        details: `${saved.student.id}:${saved.student.classId}`
      });
      return sendJson(res, 201, {
        ok: true,
        student: publicStudent(saved.student, saved.env.db),
        updatedAt: saved.env.updatedAt,
        db: scopedDbForStaff(saved.env.db, auth.user)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/staff/student-analysis") {
      const studentId=String(url.searchParams.get("studentId")||""),period=String(url.searchParams.get("period")||"month"),subject=String(url.searchParams.get("subject")||"").trim();
      if(!staffCanViewAnalysisV4518(auth.db,auth.user,studentId,subject))throw Object.assign(new Error("به پرونده تحلیلی این دانش‌آموز دسترسی ندارید."),{status:403});
      const analysis=academicAnalyticsV4518(auth.db,studentId,period,subject);if(!analysis)throw Object.assign(new Error("دانش‌آموز پیدا نشد."),{status:404});
      return sendJson(res,200,{ok:true,analysis});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/student-analysis/note") {
      const body=await readJson(req),studentId=String(body.studentId||""),period=String(body.period||"month"),subject=String(body.subject||"").trim(),comment=String(body.teacherComment||body.comment||"").trim();
      if(!ACADEMIC_PERIODS_V4518[period])throw Object.assign(new Error("بازه گزارش معتبر نیست."),{status:400});
      if(!staffCanViewAnalysisV4518(auth.db,auth.user,studentId,subject))throw Object.assign(new Error("اجازه ثبت نظر برای این دانش‌آموز را ندارید."),{status:403});
      if(comment.length<3||comment.length>3000)throw Object.assign(new Error("نظر معلم باید بین ۳ تا ۳۰۰۰ نویسه باشد."),{status:400});
      const baseAnalysis=academicAnalyticsV4518(auth.db,studentId,period,subject); const saved=await enqueueStateOperation(async()=>{const latest=(await ensureStateInitialized()).db; if(!staffCanViewAnalysisV4518(latest,auth.user,studentId,subject))throw Object.assign(new Error("دسترسی شما به این دانش‌آموز تغییر کرده است."),{status:403}); latest.progressReports=Array.isArray(latest.progressReports)?latest.progressReports:[];const row={id:makeId("prg"),type:"academic_analysis",studentId,teacherId:auth.user.id,teacherName:`${auth.user.firstName||""} ${auth.user.lastName||""}`.trim()||"معلم",subject,period,periodLabel:ACADEMIC_PERIODS_V4518[period].label,teacherComment:comment,summary:comment,guardianVisible:body.guardianVisible!==false,status:"published",snapshot:{averagePercent:baseAnalysis?.current?.averagePercent??null,status:baseAnalysis?.status?.key||"no_data",trend:baseAnalysis?.trend?.key||"no_data",trendDelta:baseAnalysis?.trend?.delta??null,examCount:baseAnalysis?.current?.examCount||0,absent:baseAnalysis?.attendance?.absent||0,late:baseAnalysis?.attendance?.late||0},publishedAt:faNow(),publishedAtIso:new Date().toISOString(),createdAt:faNow(),createdAtIso:new Date().toISOString()};latest.progressReports.unshift(row);latest.audit=Array.isArray(latest.audit)?latest.audit:[];latest.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"ثبت نظر تحلیلی دانش‌آموز",details:`${studentId} · ${ACADEMIC_PERIODS_V4518[period].label}${subject?` · ${subject}`:""}`,at:faNow()});const env=await writeStateEnvelope(latest);return {env,row};});
      await securityAudit({type:"student_analysis_note",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:`${studentId}:${period}:${subject}`}); const analysis=academicAnalyticsV4518(saved.env.db,studentId,period,subject); return sendJson(res,200,{ok:true,report:saved.row,analysis});
    }

    // v75 professional gradebook
    if (req.method === "GET" && url.pathname === "/api/staff/gradebook") {
      const classId=String(url.searchParams.get("classId")||""),subject=String(url.searchParams.get("subject")||"").trim(),academicPeriod=normalizeAcademicPeriod(url.searchParams.get("academicPeriod")||"semester2",{allowAnnual:false}),academicYear=String(auth.db.school?.year||"");
      if(!classId||!subject)throw Object.assign(new Error("کلاس و درس الزامی است."),{status:400});
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId,subject,feature:"continuous"}))throw Object.assign(new Error("به دفتر نمره این کلاس دسترسی ندارید."),{status:403});
      return sendJson(res,200,{ok:true,...gradebookPayloadV75(auth.db,{classId,subject,academicYear,academicPeriod})});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/gradebook/config") {
      const body=await readJson(req),classId=String(body.classId||""),subject=String(body.subject||"").trim(),academicPeriod=normalizeAcademicPeriod(body.academicPeriod||"semester2",{allowAnnual:false}),academicYear=String(auth.db.school?.year||"");
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId,subject,feature:"continuous"}))throw Object.assign(new Error("مجوز تنظیم دفتر نمره را ندارید."),{status:403});
      if(isTermLockedV75(auth.db,{classId,subject,academicYear,academicPeriod}))throw Object.assign(new Error("نمرات این درس/نیم‌سال قفل شده‌اند."),{status:409,code:"TERM_LOCKED"});
      const normalized=normalizeGradebookConfigV75(body,{classId,subject,academicYear,academicPeriod});
      const saved=await mutateDb(m=>{m.gradebookConfigs||=[];const old=m.gradebookConfigs.find(x=>x.key===normalized.key);const row={id:old?.id||makeId("gbc"),...normalized,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),updatedBy:auth.user.id};m.gradebookConfigs=m.gradebookConfigs.filter(x=>x.key!==row.key);m.gradebookConfigs.push(row);m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"تنظیم دفتر نمره",details:`${classId} · ${subject} · ${academicPeriod}`,at:faNow()});return row;});
      return sendJson(res,200,{ok:true,config:saved.result});
    }
    // p31: explicit teacher-approved continuous mark, separate from calculated gradebook.
    if (req.method === "POST" && url.pathname === "/api/staff/gradebook/approve-continuous") {
      const body=await readJson(req),studentId=String(body.studentId||""),classId=String(body.classId||""),subject=String(body.subject||"").trim(),academicPeriod=normalizeAcademicPeriod(body.academicPeriod||"semester2",{allowAnnual:false}),academicYear=String(auth.db.school?.year||"");
      const student=(auth.db.users||[]).find(x=>x.id===studentId&&x.role==="student"&&x.classId===classId&&x.profileStatus!=="deleted");
      if(!student||!subject)throw Object.assign(new Error("دانش‌آموز یا درس معتبر نیست."),{status:404});
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId,subject,feature:"continuous"}))throw Object.assign(new Error("مجوز تأیید نمره این درس را ندارید."),{status:403});
      if(isTermLockedV75(auth.db,{classId,subject,academicYear,academicPeriod}))throw Object.assign(new Error("نمرات این درس/نیم‌سال قفل شده‌اند."),{status:409,code:"TERM_LOCKED"});
      const cfg=gradebookPayloadV75(auth.db,{classId,subject,academicYear,academicPeriod}).config;
      const maxScore=Number(cfg.outputMaxScore||5),score=Number(body.score);
      if(body.score===null||body.score===undefined||String(body.score).trim()===""||!Number.isFinite(score)||score<0||score>maxScore)throw Object.assign(new Error(`نمره نهایی معلم باید بین صفر تا ${maxScore} باشد.`),{status:400});
      const approvedFinal=(auth.db.termFinalOverrides||[]).filter(r=>r.active!==false&&r.studentId===studentId&&r.classId===classId&&r.subject===subject&&String(r.academicYear||academicYear)===academicYear&&String(r.academicPeriod||"semester2")===academicPeriod).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")))[0];
      const finalMax=Math.round((20-maxScore)*100)/100;
      if(invalidTermFinalV6719(approvedFinal,finalMax))throw Object.assign(new Error(`پایانی ثبت‌شده قبلی از سقف ${finalMax} بیشتر است؛ ابتدا آن را اصلاح یا حذف کنید.`),{status:400});
      const saved=await mutateDb(m=>{m.continuousGradeOverrides||=[];const old=m.continuousGradeOverrides.find(r=>r.studentId===studentId&&r.classId===classId&&r.subject===subject&&String(r.academicYear||academicYear)===academicYear&&String(r.academicPeriod||r.period||"semester2")===academicPeriod&&r.active!==false);
        const now=new Date().toISOString(),rounded=Math.round(score*100)/100,normalized=Math.round(score/maxScore*20*100)/100;
        const row={...(old||{}),id:old?.id||makeId("cgo"),studentId,classId,subject,academicYear,academicPeriod,active:true,finalScore:normalized,approvedRawScore:rounded,approvedMaxScore:maxScore,approvedBy:auth.user.id,approvedAt:now,reason:"تأیید نهایی معلم",updatedAt:now,history:[...(old?.history||[]),{from:old?.approvedRawScore??null,to:rounded,maxScore,by:auth.user.id,at:now,reason:"تأیید نهایی معلم"}].slice(-100)};
        m.continuousGradeOverrides=m.continuousGradeOverrides.filter(r=>r!==old);m.continuousGradeOverrides.push(row);
        m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"تأیید نمره نهایی مستمر",details:`${studentId} · ${subject} · ${academicPeriod} · ${rounded}/${maxScore}`,at:faNow()});return row;});
      return sendJson(res,200,{ok:true,approved:{score:saved.result.approvedRawScore,maxScore:saved.result.approvedMaxScore,updatedAt:saved.result.updatedAt}});
    }
    // p32: manual end-of-term mark, shared by the gradebook and report card.
    // p38: authoritative read-back for saved teacher-approved final marks.
    if (req.method === "GET" && url.pathname === "/api/staff/gradebook/final-mark") {
      const studentId=String(url.searchParams.get("studentId")||""),classId=String(url.searchParams.get("classId")||""),subject=String(url.searchParams.get("subject")||"").trim(),academicPeriod=normalizeAcademicPeriod(url.searchParams.get("academicPeriod")||"semester2",{allowAnnual:false}),academicYear=String(auth.db.school?.year||"");
      const student=(auth.db.users||[]).find(x=>x.id===studentId&&x.role==="student"&&x.classId===classId&&x.profileStatus!=="deleted");
      if(!student||!subject)throw Object.assign(new Error("دانش‌آموز یا درس معتبر نیست."),{status:404});
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId,subject,feature:"continuous"}))throw Object.assign(new Error("مجوز مشاهده نمره این درس را ندارید."),{status:403});
      const finalMark=(auth.db.termFinalOverrides||[]).filter(r=>r.active!==false&&r.studentId===studentId&&r.classId===classId&&r.subject===subject&&String(r.academicYear||academicYear)===academicYear&&String(r.academicPeriod||"semester2")===academicPeriod).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")))[0]||null;
      return sendJson(res,200,{ok:true,finalMark});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/gradebook/final-mark") {
      const body=await readJson(req),studentId=String(body.studentId||""),classId=String(body.classId||""),subject=String(body.subject||"").trim(),academicPeriod=normalizeAcademicPeriod(body.academicPeriod||"semester2",{allowAnnual:false}),academicYear=String(auth.db.school?.year||"");
      const student=(auth.db.users||[]).find(x=>x.id===studentId&&x.role==="student"&&x.classId===classId&&x.profileStatus!=="deleted");
      if(!student||!subject)throw Object.assign(new Error("دانش‌آموز یا درس معتبر نیست."),{status:404});
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId,subject,feature:"continuous"}))throw Object.assign(new Error("مجوز ثبت نمره این درس را ندارید."),{status:403});
      if(isTermLockedV75(auth.db,{classId,subject,academicYear,academicPeriod}))throw Object.assign(new Error("نمرات این درس/نیم‌سال قفل شده‌اند."),{status:409,code:"TERM_LOCKED"});
      const cfg=gradebookPayloadV75(auth.db,{classId,subject,academicYear,academicPeriod}).config;
      const maxScore=gradebookSharesV6719(auth.db,{classId,subject,academicYear,academicPeriod}).finalMax;
      if(maxScore<=0&&body.clear!==true)throw Object.assign(new Error("بارم مستمر ۲۰ است؛ امکان ثبت نمره پایانی وجود ندارد."),{status:400});
      const clear=body.clear===true,score=Number(body.score);
      if(!clear&&(body.score===null||body.score===undefined||String(body.score).trim()===""||!Number.isFinite(score)||score<0||score>maxScore))throw Object.assign(new Error(`نمره پایانی باید بین صفر تا ${maxScore} باشد.`),{status:400});
      // P67.19: validation uses only the persisted gradebook ceiling (20 - outputMaxScore).
      // Example: 10 continuous max, approved continuous 8, final 12 => reject.
      const saved=await mutateDb(m=>{
        const authoritativeMax=gradebookSharesV6719(m,{classId,subject,academicYear,academicPeriod}).finalMax;
        if(!clear&&(authoritativeMax<=0||score>authoritativeMax+0.000001))throw Object.assign(new Error(`نمره پایانی باید بین صفر تا ${authoritativeMax} باشد.`),{status:400});
        m.termFinalOverrides||=[];const old=m.termFinalOverrides.find(r=>r.active!==false&&r.studentId===studentId&&r.classId===classId&&r.subject===subject&&String(r.academicYear||academicYear)===academicYear&&String(r.academicPeriod||"semester2")===academicPeriod);
        if(clear){if(old)old.active=false;return null;}
        const now=new Date().toISOString(),row={...(old||{}),id:old?.id||makeId("tfo"),studentId,classId,subject,academicYear,academicPeriod,score:Math.round(score*100)/100,maxScore:authoritativeMax,active:true,updatedAt:now,updatedBy:auth.user.id,history:[...(old?.history||[]),{score:Math.round(score*100)/100,maxScore:authoritativeMax,by:auth.user.id,at:now}].slice(-100)};
        if(old)Object.assign(old,row);else m.termFinalOverrides.push(row);
        m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"ثبت دستی پایانی نیم‌سال",details:`${studentId} · ${subject} · ${academicPeriod} · ${row.score}/${maxScore}`,at:faNow()});return row;});
      return sendJson(res,200,{ok:true,finalMark:saved.result});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/gradebook/entry") {
      const body=await readJson(req),studentId=String(body.studentId||""),classId=String(body.classId||""),subject=String(body.subject||"").trim(),categoryId=String(body.categoryId||"").trim(),academicPeriod=normalizeAcademicPeriod(body.academicPeriod||"semester2",{allowAnnual:false}),academicYear=String(auth.db.school?.year||"");
      const student=(auth.db.users||[]).find(x=>x.id===studentId&&x.role==="student"&&x.classId===classId&&x.profileStatus!=="deleted");if(!student)throw Object.assign(new Error("دانش‌آموز معتبر نیست."),{status:404});
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId,subject,feature:"continuous"}))throw Object.assign(new Error("مجوز ثبت نمره این کلاس را ندارید."),{status:403});
      if(isTermLockedV75(auth.db,{classId,subject,academicYear,academicPeriod}))throw Object.assign(new Error("نمرات این درس/نیم‌سال قفل شده‌اند."),{status:409,code:"TERM_LOCKED"});
      const cfg=gradebookPayloadV75(auth.db,{classId,subject,academicYear,academicPeriod}).config,cat=(cfg.categories||[]).find(c=>c.id===categoryId&&c.source!=="exam");if(!cat)throw Object.assign(new Error("مولفه دفتر نمره معتبر نیست."),{status:400});
      const score=Number(body.score),maxScore=Number(body.maxScore||20);if(!Number.isFinite(score)||!Number.isFinite(maxScore)||maxScore<=0||score<0||score>maxScore)throw Object.assign(new Error("نمره و بارم معتبر نیست."),{status:400});
      const id=String(body.id||"");const saved=await mutateDb(m=>{m.gradebookEntries||=[];let row=id?m.gradebookEntries.find(x=>x.id===id):null;const payload={studentId,classId,subject,categoryId,title:String(body.title||cat.title).trim().slice(0,120),score:Math.round(score*100)/100,maxScore:Math.round(maxScore*100)/100,date:String(body.date||new Date().toISOString().slice(0,10)).slice(0,10),note:String(body.note||"").trim().slice(0,1000),academicYear,academicPeriod,active:true,updatedAt:new Date().toISOString(),updatedBy:auth.user.id};if(row)Object.assign(row,payload);else{row={id:makeId("gbe"),...payload,createdAt:new Date().toISOString(),createdBy:auth.user.id};m.gradebookEntries.push(row);}m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"ثبت دفتر نمره",details:`${studentId} · ${subject} · ${cat.title} · ${score}/${maxScore}`,at:faNow()});return row;});
      return sendJson(res,200,{ok:true,entry:saved.result,computed:gradebookContinuousV75(saved.db,{studentId,classId,subject,academicYear,academicPeriod})});
    }
    // P65.2 — Scoped, atomic homework creation/editing; does not write official grades.
    if (req.method === "POST" && url.pathname === "/api/staff/homework/p652/save") {
      const body=await readJson(req);
      const classId=String(body.classId||"").trim(),subject=String(body.subject||"").trim();
      const title=String(body.title||"").trim(),description=String(body.description||"").trim();
      const id=String(body.id||"").trim(),publicationState=String(body.publicationState||"draft");
      const dueAt=String(body.dueAt||"").trim(),dueTime=String(body.dueTime||"").trim();
      const year=String(auth.db.school?.year||"");
      const err=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
      if(!(auth.db.school?.classes||[]).some(c=>c.id===classId&&c.active!==false))err("کلاس انتخاب‌شده معتبر نیست.");
      if(!subject||subject.length>100)err("درس انتخاب‌شده معتبر نیست.");
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId,subject,feature:"homework"}))err("مجوز ثبت تکلیف برای این کلاس و درس را ندارید.",403);
      if(title.length<3||title.length>120)err("عنوان تکلیف باید بین ۳ تا ۱۲۰ نویسه باشد.");
      if(description.length<5||description.length>5000)err("توضیحات تکلیف باید بین ۵ تا ۵۰۰۰ نویسه باشد.");
      if(!["draft","published"].includes(publicationState))err("وضعیت انتشار معتبر نیست.");
      if(dueAt&&!/^\d{4}-\d{2}-\d{2}$/.test(dueAt))err("تاریخ تحویل معتبر نیست.");
      if(dueAt&&(Number.isNaN(new Date(dueAt+"T12:00:00Z").getTime())||new Date(dueAt+"T12:00:00Z").toISOString().slice(0,10)!==dueAt))err("تاریخ تحویل معتبر نیست.");
      if(dueTime&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime))err("ساعت تحویل معتبر نیست.");
      if(!dueAt&&dueTime)err("برای انتخاب ساعت ابتدا تاریخ تحویل را تعیین کنید.");
      const totalScore=Number(body.totalScore??20);
      if(!Number.isFinite(totalScore)||totalScore<=0||totalScore>20)err("بارم تکلیف باید بیشتر از صفر و حداکثر ۲۰ باشد.");
      const allStudents=(auth.db.users||[]).filter(s=>s.role==="student"&&s.classId===classId&&s.profileStatus!=="deleted"&&s.active!==false);
      const validIds=new Set(allStudents.map(s=>String(s.id)));
      const recipientMode=String(body.recipientMode||"all");
      if(!["all","selected"].includes(recipientMode))err("نوع انتخاب دانش‌آموزان معتبر نیست.");
      const selected=Array.isArray(body.studentIds)?[...new Set(body.studentIds.map(String))]:[];
      if(selected.some(s=>!validIds.has(s))||(recipientMode==="selected"&&!selected.length))err("دانش‌آموز انتخاب‌شده خارج از کلاس است یا گیرنده‌ای انتخاب نشده است.");
      const studentIds=recipientMode==="selected"?selected:[];
      const attachments=Array.isArray(body.attachments)?body.attachments:[];
      if(attachments.length>2)err("حداکثر دو فایل پیوست مجاز است.");
      const normalizedFiles=attachments.map((f,i)=>{
        const name=String(f?.name||`پیوست ${i+1}`).trim().slice(0,120),dataUrl=String(f?.dataUrl||"");
        const m=/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
        if(!m)err("فرمت فایل باید JPG، PNG، WebP یا PDF باشد.");
        const bytes=Buffer.from(m[2],"base64");
        if(bytes.length>650*1024)err("حجم هر فایل حداکثر ۶۵۰ کیلوبایت است.");
        if(bytes.toString("base64")!==m[2])err("محتوای پیوست معتبر نیست.");
        return {name,type:m[1].toLowerCase(),size:bytes.length,dataUrl};
      });
      const saved=await mutateDb(m=>{
        m.homework=Array.isArray(m.homework)?m.homework:[];
        const old=id?m.homework.find(h=>String(h.id)===id):null;
        if(id&&!old)err("تکلیف موردنظر دیگر وجود ندارد.",404);
        if(old&&auth.user.role==="teacher"&&!teacherCanAssigned(m,auth.user,{classId:old.classId,subject:old.subject,feature:"homework"}))err("مجوز ویرایش این تکلیف را ندارید.",403);
        if(auth.user.role==="teacher"&&!teacherCanAssigned(m,auth.user,{classId,subject,feature:"homework"}))err("دسترسی به این درس تغییر کرده است.",403);
        const dueAtJalali=String(body.dueAtJalali||"").slice(0,10);
        const nowIso=new Date().toISOString(),becamePublished=publicationState==="published"&&String(old?.publicationState|| (old?.published===false?"draft":"published"))!=="published";
        const shouldNotify=publicationState==="published"&&(!old||becamePublished);
        const row={...(old||{}),id:old?.id||makeId("hw"),classId,subject,title,description,
          dueAt,dueTime,dueAtJalali:String(body.dueAtJalali||"").slice(0,10),dueAtIso:dueAt?`${dueAt}T${dueTime||"23:59"}:00+03:30`:"",
          totalScore:Math.round(totalScore*4)/4,allowLate:body.allowLate===true,
          recipientMode,studentIds,attachments:normalizedFiles,status:"active",publicationState,published:publicationState==="published",
          academicYear:year,academicPeriod:String(body.academicPeriod||old?.academicPeriod||"semester2") === "semester1"?"semester1":"semester2",
          createdAt:old?.createdAt||faNow(),createdAtIso:old?.createdAtIso||nowIso,createdBy:old?.createdBy||auth.user.id,
          updatedAt:faNow(),updatedAtIso:nowIso,updatedBy:auth.user.id};
        if(shouldNotify)row.publishedAt=nowIso;
        if(old)Object.assign(old,row);else m.homework.unshift(row);
        if(shouldNotify){m.notifications=Array.isArray(m.notifications)?m.notifications:[];
          for(const st of allStudents){if(recipientMode==="selected"&&!studentIds.includes(String(st.id)))continue;
            m.notifications.unshift({id:makeId("not"),userId:st.id,title:"تکلیف جدید",body:`${subject}: ${title}${dueAt?` · مهلت ${dueAtJalali||dueAt}`:""}`,read:false,at:faNow(),kind:"homework",target:"homework",targetId:row.id});
          }
        }
        m.audit=Array.isArray(m.audit)?m.audit:[];
        m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:shouldNotify?"انتشار تکلیف P65.2":"ذخیره تکلیف P65.2",details:`${classId} · ${subject} · ${title} · ${publicationState}`,at:faNow()});
        return {id:row.id,title:row.title,publicationState:row.publicationState};
      });
      if(publicationState==="published" && saved.result.publicationState==="published"){
        const publishedNow = !id || !(auth.db.homework||[]).some(h=>String(h.id)===id&&String(h.publicationState||"published")==="published");
        if(publishedNow){
          const targets=allStudents.filter(s=>recipientMode!=="selected"||studentIds.includes(String(s.id))).map(s=>s.id);
          void sendAuthorizedPush(targets,{title:"تکلیف جدید",body:"تکلیف جدید برای شما منتشر شده است.",screen:"tasks",eventId:saved.result.id}).catch(e=>console.warn('FCM homework:',e.message));
        }
      }
      return sendJson(res,200,{ok:true,homework:saved.result});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/homework/grade") {
      const body=await readJson(req),submissionId=String(body.submissionId||"");const submission=(auth.db.homeworkSubmissions||[]).find(x=>x.id===submissionId),homework=submission&&(auth.db.homework||[]).find(h=>h.id===submission.homeworkId);if(!submission||!homework)throw Object.assign(new Error("تحویل تکلیف پیدا نشد."),{status:404});
      if(auth.user.role==="teacher"&&!teacherCanAssigned(auth.db,auth.user,{classId:homework.classId,subject:homework.subject,feature:"homework"}))throw Object.assign(new Error("مجوز تصحیح این تکلیف را ندارید."),{status:403});
      const maxScore=Number(homework.totalScore||20),score=Number(body.score);if(!Number.isFinite(score)||score<0||score>maxScore)throw Object.assign(new Error(`نمره باید بین صفر تا ${maxScore} باشد.`),{status:400});
      const saved=await mutateDb(m=>{const row=(m.homeworkSubmissions||[]).find(x=>x.id===submissionId);if(!row)throw Object.assign(new Error("تحویل تکلیف دیگر وجود ندارد."),{status:404});Object.assign(row,{score:Math.round(score*100)/100,maxScore,feedback:String(body.feedback||"").trim().slice(0,2000),status:"graded",gradedAt:faNow(),gradedAtIso:new Date().toISOString(),gradedBy:auth.user.id});m.notifications||=[];m.notifications.unshift({id:makeId("not"),userId:row.studentId,title:"تکلیف تصحیح شد",body:`${homework.title}: ${row.score} از ${maxScore}${row.feedback?` · ${row.feedback}`:""}`,read:false,at:faNow(),kind:"homework_graded"});m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"تصحیح تکلیف",details:`${homework.title} · ${row.studentId} · ${row.score}/${maxScore}`,at:faNow()});return row;});
      return sendJson(res,200,{ok:true,submission:saved.result});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/term-lock") {
      if(!["admin","superadmin"].includes(auth.user.role))throw Object.assign(new Error("قفل و بازگشایی نمرات فقط توسط مدیر مجاز است."),{status:403});
      const body=await readJson(req),classId=String(body.classId||""),subject=String(body.subject||"").trim(),academicPeriod=normalizeAcademicPeriod(body.academicPeriod||"semester2",{allowAnnual:false}),academicYear=String(auth.db.school?.year||""),action=String(body.action||"lock");if(!classId||!subject)throw Object.assign(new Error("کلاس و درس الزامی است."),{status:400});
      const saved=await mutateDb(m=>{m.termLocks||=[];m.termLocks=m.termLocks.filter(x=>!(x.classId===classId&&x.subject===subject&&String(x.academicYear||"")===academicYear&&String(x.academicPeriod||x.period||"semester2")===academicPeriod));let row=null;if(action!=="unlock"){row={id:makeId("tlock"),classId,subject,academicYear,academicPeriod,active:true,reason:String(body.reason||"تأیید نهایی مدیریت").trim().slice(0,500),lockedAt:faNow(),lockedAtIso:new Date().toISOString(),lockedBy:auth.user.id};m.termLocks.push(row);}m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:action==="unlock"?"بازگشایی نمرات":"قفل نمرات",details:`${classId} · ${subject} · ${academicPeriod}`,at:faNow()});return row;});return sendJson(res,200,{ok:true,lock:saved.result});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/report-card/unlock") {
      if(!["admin","superadmin"].includes(auth.user.role))throw Object.assign(new Error("بازگشایی کارنامه فقط توسط مدیر مجاز است."),{status:403});const body=await readJson(req),reportCardId=String(body.reportCardId||"");const saved=await mutateDb(m=>{const row=(m.reportCards||[]).find(x=>x.id===reportCardId);if(!row)throw Object.assign(new Error("کارنامه پیدا نشد."),{status:404});row.status="draft";row.unlockedAt=new Date().toISOString();row.unlockedBy=auth.user.id;row.unlockReason=String(body.reason||"").trim().slice(0,500);row.updatedAt=new Date().toISOString();m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"بازگشایی کارنامه",details:`${row.studentId} · ${row.academicPeriod}`,at:faNow()});return row;});return sendJson(res,200,{ok:true,reportCard:saved.result});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/notifications/send") {
      const body=await readJson(req),title=String(body.title||"").trim(),message=String(body.body||body.message||"").trim();if(title.length<2||message.length<2)throw Object.assign(new Error("عنوان و متن اعلان را کامل کنید."),{status:400});const recipients=notificationRecipientsV75(auth.db,auth.user,{targetType:String(body.targetType||"user"),targetId:String(body.targetId||""),classId:String(body.classId||"")});if(!recipients.length)throw Object.assign(new Error("گیرنده معتبری برای اعلان پیدا نشد یا دسترسی ندارید."),{status:403});
      const saved=await mutateDb(m=>{m.notifications||=[];m.notificationBroadcasts||=[];const bid=makeId("nb");const at=faNow();for(const userId of recipients)m.notifications.unshift({id:makeId("not"),userId,title:title.slice(0,160),body:message.slice(0,2000),read:false,at,kind:String(body.kind||"general").slice(0,50),broadcastId:bid,createdBy:auth.user.id});const row={id:bid,title:title.slice(0,160),body:message.slice(0,2000),targetType:String(body.targetType||"user"),targetId:String(body.targetId||body.classId||""),recipientCount:recipients.length,createdBy:auth.user.id,createdAt:new Date().toISOString()};m.notificationBroadcasts.unshift(row);m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"ارسال اعلان",details:`${title} · ${recipients.length} گیرنده`,at});return row;});void sendAuthorizedPush(recipients.filter(id=>(auth.db.users||[]).some(u=>u.id===id&&u.role==="student")),{title:"اطلاعیه جدید مدرسه",body:"اطلاعیه جدید را در مدرسه‌یار مشاهده کنید.",screen:"notifications",eventId:saved.result.id}).catch(e=>console.warn('FCM notice:',e.message));
      return sendJson(res,200,{ok:true,broadcast:saved.result,recipientCount:recipients.length});
    }
    if (req.method === "POST" && url.pathname === "/api/staff/notifications/read") {
      const body=await readJson(req),id=String(body.id||"");const saved=await mutateDb(m=>{let count=0;for(const n of m.notifications||[]){if(n.userId===auth.user.id&&(!id||n.id===id)){n.read=true;n.readAt=new Date().toISOString();count++;}}return count;});return sendJson(res,200,{ok:true,count:saved.result});
    }

    return sendJson(res, 404, { error: "مسیر امنیت کارکنان پیدا نشد." });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || "خطای احراز هویت", code: error.code || undefined });
  }
}


const TEACHING_PERMISSION_DEFAULTS = TEACHING_PERMISSION_DEFAULTS_CORE;
function teacherAssignmentIsActive(db, assignment) {
  if (!assignment || assignment.active === false) return false;
  const owner=(db.users||[]).find(u=>u.id===assignment.teacherId);
  if(!owner||owner.role!=="teacher"||owner.active===false||["deleted","locked","graduated"].includes(String(owner.profileStatus||"")))return false;
  const currentYear = String(db.school?.year || "").trim();
  if (assignment.academicYear && currentYear && String(assignment.academicYear) !== currentYear) return false;
  const today = new Date().toISOString().slice(0,10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(assignment.startDate||"")) && assignment.startDate > today) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(assignment.endDate||"")) && assignment.endDate < today) return false;
  return true;
}
function activeTeachingAssignments(db, user, feature = "") {
  return (db.teachingAssignments || []).filter(a => a.teacherId === user?.id && teacherAssignmentIsActive(db, a) && (!feature || (a.permissions || []).includes(feature)));
}
function assignmentBookFor(db, assignment) {
  return (db.curriculum || []).find(b => b.id === assignment?.bookId || b.subject === assignment?.subject);
}
function assignmentMatches(db, assignment, classId, subject, bookId = "") {
  if (!teacherAssignmentIsActive(db, assignment)) return false;
  if (classId && assignment.classId !== classId) return false;
  if (subject && assignment.subject !== subject) return false;
  const assignedBook = assignmentBookFor(db, assignment);
  if (bookId && assignment.bookId && assignment.bookId !== bookId) return false;
  if (bookId && !assignment.bookId && assignedBook?.id !== bookId) return false;
  return true;
}
function teacherCanAssigned(db, user, { classId = "", subject = "", bookId = "", feature = "" } = {}) {
  if (["admin","superadmin"].includes(user?.role)) return true;
  return activeTeachingAssignments(db, user, feature).some(a => assignmentMatches(db, a, classId, subject, bookId));
}

// v45.22 — سؤال‌های ثبت‌شده توسط مدیریت مدرسه برای معلمِ همان کتاب/درس قابل مشاهده‌اند.
// معلم فقط سؤال‌های خودش را ویرایش/حذف می‌کند؛ سؤال‌های مدرسه برای او فقط خواندنی/قابل استفاده و کپی هستند.
function questionCreatorRole(db, question) {
  if (!question?.createdBy) return "system";
  return (db.users || []).find(u => u.id === question.createdBy)?.role || "";
}
function teacherCanReadQuestion(db, user, question) {
  if (["admin","superadmin"].includes(user?.role)) return true;
  if (!question || !teacherCanAssigned(db, user, { subject:question.subject || "", bookId:question.bookId || "", feature:"questionBank" })) return false;
  if (question.createdBy === user.id) return true;
  if (question.shared === true || !question.createdBy) return true;
  return ["admin","superadmin"].includes(questionCreatorRole(db, question));
}
function teacherCanWriteQuestion(db, user, question) {
  if (["admin","superadmin"].includes(user?.role)) return true;
  return !!question && question.createdBy === user.id && teacherCanAssigned(db, user, { subject:question.subject || "", bookId:question.bookId || "", feature:"questionBank" });
}
function normalizeTeachingAssignments(db) {
  db.teachingAssignments = Array.isArray(db.teachingAssignments) ? db.teachingAssignments : [];
  const teachers = (db.users || []).filter(u => u.role === "teacher" && u.active !== false && !["deleted","locked","graduated"].includes(String(u.profileStatus || "")));
  for (const teacher of teachers) {
    const existing = db.teachingAssignments.filter(a => a.teacherId === teacher.id);
    if (!existing.length) {
      for (const classId of teacher.classIds || []) {
        for (const subject of teacher.subjects || []) {
          const classRow = (db.school?.classes || []).find(c => c.id === classId);
          const book = (db.curriculum || []).find(b => b.subject === subject && Number(b.grade || 0) === Number(classRow?.grade || 0)) || (db.curriculum || []).find(b => b.subject === subject);
          db.teachingAssignments.push({
            id: makeId("teach"), teacherId: teacher.id, academicYear: db.school?.year || "", grade: Number((db.school?.classes || []).find(c => c.id === classId)?.grade || 0),
            classId, subject, bookId: book?.id || "", responsibility: "primary", permissions: [...TEACHING_PERMISSION_DEFAULTS], active: true,
            startDate: "", endDate: "", createdAt: faNow(), createdBy: "migration-v33", history: [{ at: faNow(), by: "migration-v33", action: "ایجاد از دسترسی نسخه قبلی" }]
          });
        }
      }
    }
  }
  const validTeachers = new Set(teachers.map(t => t.id));
  const validClasses = new Set((db.school?.classes || []).map(c => c.id));
  const validBooks = new Set((db.curriculum || []).map(b => b.id));
  db.teachingAssignments = db.teachingAssignments.filter(a => validTeachers.has(a.teacherId) && validClasses.has(a.classId) && (!a.bookId || validBooks.has(a.bookId))).map(a => {
    const book = assignmentBookFor(db, a); const cls = (db.school?.classes || []).find(c => c.id === a.classId);
    return { ...a, academicYear: a.academicYear || db.school?.year || "", grade: Number(a.grade || cls?.grade || 0), subject: a.subject || book?.subject || "", bookId: a.bookId || book?.id || "", responsibility: a.responsibility || "primary", permissions: Array.from(new Set((Array.isArray(a.permissions) && a.permissions.length ? a.permissions : TEACHING_PERMISSION_DEFAULTS).filter(Boolean))), active: a.active !== false, history: Array.isArray(a.history) ? a.history : [] };
  });
  for (const teacher of teachers) {
    const active = db.teachingAssignments.filter(a => a.teacherId === teacher.id && teacherAssignmentIsActive(db, a));
    teacher.classIds = Array.from(new Set(active.map(a => a.classId)));
    teacher.subjects = Array.from(new Set(active.map(a => a.subject).filter(Boolean)));
  }
  return db;
}

function teacherScope(db, user) {
  const assignments = activeTeachingAssignments(db, user);
  const classIds = new Set(assignments.map(a => a.classId));
  const subjects = new Set(assignments.map(a => a.subject).filter(Boolean));
  const bookIds = new Set(assignments.map(a => a.bookId || assignmentBookFor(db, a)?.id).filter(Boolean));
  const studentIds = new Set((db.users || []).filter(u => u.role === "student" && classIds.has(u.classId)).map(u => u.id));
  const can = (row, feature = "") => teacherCanAssigned(db, user, { classId: row?.classId || "", subject: row?.subject || "", bookId: row?.bookId || "", feature });
  const examIds = new Set((db.exams || []).filter(e => can(e)).map(e => e.id));
  const submissionIds = new Set((db.submissions || []).filter(x => examIds.has(x.examId) && studentIds.has(x.studentId)).map(x => x.id));
  const questionIds = new Set((db.questionBank || []).filter(q => teacherCanReadQuestion(db, user, q)).map(q => q.id));
  return { assignments, classIds, subjects, bookIds, studentIds, examIds, submissionIds, questionIds, can };
}

// v45.23 — سابقه استفاده سؤال برای هر معلم مستقل است و فقط آزمون‌های واقعاً منتشر/اجراشده محاسبه می‌شوند.
const USED_EXAM_STATES_V4523 = new Set(["published","in_progress","ended","graded","final","archived"]);
function examCountsAsUsedV4523(exam) {
  const state=String(exam?.publicationState||"").toLowerCase(),status=String(exam?.status||"").toLowerCase();
  return USED_EXAM_STATES_V4523.has(state)||status==="active"||status==="archived";
}
function teacherQuestionUsageV4523(db, teacherId) {
  const tid=String(teacherId||""); const usage={}; if(!tid)return usage;
  for(const exam of db.exams||[]){
    if(String(exam.createdBy||exam.teacherId||"")!==tid||!examCountsAsUsedV4523(exam))continue;
    for(const item of exam.questions||[]){const qid=String(item.sourceQuestionId||"").trim();if(!qid)continue;usage[qid] ||= {count:0,examIds:[],lastUsedAt:null};usage[qid].count++;if(exam.id&&!usage[qid].examIds.includes(exam.id))usage[qid].examIds.push(exam.id);usage[qid].lastUsedAt=exam.updatedAt||exam.publishedAt||exam.createdAt||usage[qid].lastUsedAt;}
  }
  return usage;
}


// ===== 72.28-p1: Teacher mobile attendance app + live admin monitor =====
function schoolDayNameForDateV78(date){
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date||""));
  if(!m)return "";
  const day=new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`).getUTCDay();
  return ["یکشنبه","دوشنبه","سه‌شنبه","چهارشنبه","پنجشنبه","جمعه","شنبه"][day]||"";
}
function hmTextV78(minutes){const n=Math.max(0,Math.min(1439,Number(minutes||0)));return `${String(Math.floor(n/60)).padStart(2,"0")}:${String(n%60).padStart(2,"0")}`;}
function faDateV78(date){try{return new Intl.DateTimeFormat("fa-IR-u-ca-persian",{year:"numeric",month:"long",day:"numeric"}).format(new Date(`${date}T12:00:00Z`));}catch{return date;}}
function classInfoV78(db,classId){const c=(db.school?.classes||[]).find(x=>x.id===classId)||{};const shift=(db.school?.shiftDefinitions||[]).find(x=>x.id===c.shiftId)||{};return {id:c.id||classId,name:c.name||"کلاس",grade:Number(c.grade||0),gradeId:c.gradeId||"",gradeName:c.gradeName||c.gradeTitle||`پایه ${c.grade||""}`.trim(),shiftId:c.shiftId||"",shiftName:shift.name||""};}
function activePeriodForDateV78(db,date){
  const years=ensureAcademicYearModel(db.school||{}),year=years.find(x=>x.active)||years.find(x=>x.label===db.school?.year);
  const terms=year?.terms||[];const byDate=terms.find(t=>(!t.startDate||date>=t.startDate)&&(!t.endDate||date<=t.endDate));
  return byDate?.id||terms.find(t=>t.status==="active")?.id||"semester2";
}
function classAttendanceBlockV78(db,classId,date){
  const cls=classInfoV78(db,classId);const events=activeCalendarForDate(db,date).filter(e=>e.blocksAttendance===true).filter(e=>e.scope==="school"||(e.scope==="class"&&e.classId===classId)||(e.scope==="grade"&&Number(e.grade)===Number(cls.grade)));
  return events[0]||null;
}
function teacherScheduleV78(db,user,date,dayName=""){
  const year=String(db.school?.year||"");const day=dayName||schoolDayNameForDateV78(date);
  return (db.weeklySchedule||[]).filter(x=>x.active!==false&&x.teacherId===user.id&&String(x.academicYear||year)===year&&x.day===day&&teacherCanAssigned(db,user,{classId:x.classId,subject:x.subject||"",feature:"attendance"})).slice().sort((a,b)=>(hmMinutesV74(a.startTime)??9999)-(hmMinutesV74(b.startTime)??9999)||Number(a.periodNo||0)-Number(b.periodNo||0));
}
function teacherWindowV78(entry,clock){
  const start=hmMinutesV74(entry?.startTime),end=hmMinutesV74(entry?.endTime);if(start===null||end===null)return {open:false,state:"invalid"};
  const now=Number(clock.minutes||0);
  // p18: حضور و غیاب دقیقاً از ساعت شروع تا پایان همان کلاس فعال است؛ بدون بازه قبل/بعد.
  if(now>=start&&now<=end)return {open:true,state:"current",start,end};
  return {open:false,state:now<start?"upcoming":"ended",start,end};
}
function activeClassStudentsV78(db,classId){return (db.users||[]).filter(u=>u.role==="student"&&u.classId===classId&&u.active!==false&&!['deleted','locked','graduated'].includes(String(u.profileStatus||""))).slice().sort((a,b)=>`${a.lastName||""} ${a.firstName||""}`.localeCompare(`${b.lastName||""} ${b.firstName||""}`,"fa"));}
function maskedNationalV78(value){const s=String(value||"").replace(/\D/g,"");return s.length>=4?`${s.slice(0,3)}***${s.slice(-3)}`:"";}
function attendanceSnapshotV78(db,entry,date){
  const session=(db.attendanceSessions||[]).filter(x=>x.scheduleEntryId===entry.id&&x.date===date&&x.teacherId===entry.teacherId).slice().sort((a,b)=>String(b.updatedAt||b.createdAt||"").localeCompare(String(a.updatedAt||a.createdAt||"")))[0]||null;
  const records=session?(db.attendance||[]).filter(x=>x.sessionId===session.id):[];
  const normalized=records.map(r=>({...r,status:normalizeAttendanceStatusV81(r.status)}));
  return {session:session?{id:session.id,date:session.date,updatedAt:session.updatedAt||session.createdAt||""}:null,records:normalized.map(r=>({id:r.id,studentId:r.studentId,status:r.status,absenceReasonId:r.absenceReasonId||"",absenceReasonText:r.absenceReasonText||"",reviewedAt:r.reviewedAt||"",updatedAt:r.updatedAt||r.markedAt||""})),summary:{present:normalized.filter(x=>x.status==="present").length,absent:normalized.filter(x=>isAbsentStatusV81(x.status)).length,pending:normalized.filter(x=>x.status==="absent_pending").length,excused:normalized.filter(x=>x.status==="absent_excused").length,unexcused:normalized.filter(x=>x.status==="absent_unexcused").length,late:normalized.filter(x=>x.status==="late").length,total:normalized.length}};
}

function publicTeacherEntryV78(db,user,entry,date,clock){
  const cls=classInfoV78(db,entry.classId),shift=(db.school?.shiftDefinitions||[]).find(x=>x.id===entry.shiftId)||{},teacherName=`${user.firstName||""} ${user.lastName||""}`.trim(),win=teacherWindowV78(entry,clock),block=classAttendanceBlockV78(db,entry.classId,date),attendance=attendanceSnapshotV78(db,entry,date),students=activeClassStudentsV78(db,entry.classId).map(s=>({id:s.id,firstName:s.firstName||"",lastName:s.lastName||"",studentCode:s.studentCode||"",nationalIdMasked:maskedNationalV78(s.nationalId)}));
  return {id:entry.id,classId:entry.classId,className:cls.name,grade:cls.grade,gradeName:cls.gradeName,shiftId:entry.shiftId||cls.shiftId,shiftName:shift.name||cls.shiftName,periodNo:Number(entry.periodNo||0),subject:entry.subject||"",startTime:entry.startTime||"",endTime:entry.endTime||"",teacherId:user.id,teacherName,windowState:win.state,attendanceOpen:win.open&&!block,blockedReason:block?`${block.title||"تعطیلی"}: ثبت حضور برای این تاریخ بسته است.`:"",attendance,attendanceMarked:!!attendance.session,students};
}
function teacherDashboardV78(db,user){
  const clock=schoolClockV74(),today=teacherScheduleV78(db,user,clock.date,clock.dayName),entries=today.map(x=>publicTeacherEntryV78(db,user,x,clock.date,clock));
  const current=entries.find(x=>x.windowState==="current")||entries.find(x=>["starting","grace"].includes(x.windowState))||null;
  const next=entries.find(x=>{const start=hmMinutesV74(x.startTime);return start!==null&&start>clock.minutes;})||null;
  const weekSchedule=(db.weeklySchedule||[]).filter(x=>x.active!==false&&x.teacherId===user.id&&String(x.academicYear||db.school?.year||"")===String(db.school?.year||"")).map(x=>({id:x.id,day:x.day||"",classId:x.classId||"",className:classInfoV78(db,x.classId).name,subject:x.subject||"",periodNo:Number(x.periodNo||0),startTime:x.startTime||"",endTime:x.endTime||"",shiftId:x.shiftId||""}));
  return {release:APP_RELEASE,school:{name:db.school?.name||SCHOOL_NAME,year:db.school?.year||""},teacher:{id:user.id,firstName:user.firstName||"",lastName:user.lastName||"",nationalIdMasked:maskedNationalV78(user.nationalId)},clock:{date:clock.date,dateFa:faDateV78(clock.date),dayName:clock.dayName,time:hmTextV78(clock.minutes),minutes:clock.minutes,timeZone:clock.timeZone},currentClass:current,nextClass:next,todaySchedule:entries.map(({students,...x})=>x),weekSchedule};
}

// p11: read-only detailed continuous gradebook, no changes to grading data.
function continuousP11(db,sid,examId="",scope=null){
 const student=(db.users||[]).find(x=>x.id===sid&&x.role==="student"&&x.profileStatus!=="deleted");
 if(!student)throw Object.assign(new Error("دانش‌آموز پیدا نشد."),{status:404});
 const allowed=e=>!scope||scope(e);
 const rows=[];
 for(const exam of (db.exams||[])){
  if(exam.classId!==student.classId||!allowed(exam))continue;
  const attempt=(db.attempts||[]).find(a=>a.examId===exam.id&&a.studentId===sid);
  const sub=(db.submissions||[]).find(a=>a.examId===exam.id&&a.studentId===sid);
  const grade=sub?(db.grades||[]).find(g=>g.submissionId===sub.id&&String(g.publishStatus||"published")==="published"):null;
  if(!attempt&&!grade)continue;
  const total=Number(attempt?.total||examTotalScore(exam));const score=Number(attempt?attempt.score:grade.finalScore);
  if(!Number.isFinite(score)||!(total>0))continue;
  rows.push({examId:exam.id,subject:String(exam.subject||"درس نامشخص"),title:String(exam.title||"آزمون"),type:exam.type,score,total,score20:Math.round(score/total*2000)/100,submittedAt:attempt?.submittedAt||sub?.submittedAt||0});
 }
 if(!examId){const subjects=[...new Set(rows.map(x=>x.subject))].sort((a,b)=>a.localeCompare(b,"fa"));return {student:{id:student.id,name:`${student.firstName||""} ${student.lastName||""}`.trim(),classId:student.classId},subjects:subjects.map(subject=>{const exams=rows.filter(x=>x.subject===subject).sort((a,b)=>Number(a.submittedAt||0)-Number(b.submittedAt||0));return {subject,average:Math.round(exams.reduce((s,x)=>s+x.score20,0)/exams.length*100)/100,exams};})};}
 const row=rows.find(x=>x.examId===examId);if(!row)throw Object.assign(new Error("نتیجه منتشرشده‌ای برای این آزمون وجود ندارد."),{status:404});
 const exam=(db.exams||[]).find(x=>x.id===examId);const attempt=(db.attempts||[]).find(a=>a.examId===examId&&a.studentId===sid);const sub=(db.submissions||[]).find(a=>a.examId===examId&&a.studentId===sid);const grade=sub?(db.grades||[]).find(g=>g.submissionId===sub.id&&String(g.publishStatus||"published")==="published"):null;
 const questions=(exam.questions||[]).map((raw,i)=>{
  if(attempt){const ans=attempt.answers?.[raw.id];const answered=ans!==undefined&&ans!==null&&ans!=="";const index=Number(ans),correctIndex=Number(raw.answer);const correct=answered&&index===correctIndex;return {number:i+1,type:"mcq",text:raw.text||"",choices:raw.choices||[],selectedIndex:answered?index:null,correctIndex,studentAnswer:answered?String(raw.choices?.[index]??""):"بدون پاسخ",correctAnswer:String(raw.choices?.[correctIndex]??""),earnedScore:correct?Number(raw.score||0):0,maxScore:Number(raw.score||0),status:correct?"correct":"incorrect",feedback:raw.explanation||""};}
  const q=normalizeDescriptiveQuestion(raw),g=(grade?.questionScores||[]).find(x=>String(x.questionId)===String(q.id))||{},auto=(sub?.autoGrading?.questions||[]).find(x=>String(x.questionId)===String(q.id));const earned=Number(g.teacherScore??g.score??0),max=Number(q.score||0);const type=String(raw.type||q.type||"descriptive");
  if(auto?.autoGraded){const ci=Number(auto.correctAnswer),si=Number(auto.studentAnswer);return {number:i+1,type,text:q.text,choices:raw.choices||[],selectedIndex:auto.answered?si:null,correctIndex:ci,studentAnswer:type==="mcq"?String(raw.choices?.[si]??""):String(auto.studentAnswer??""),correctAnswer:type==="mcq"?String(raw.choices?.[ci]??""):String(auto.correctAnswer??""),earnedScore:earned,maxScore:max,status:auto.correct?"correct":"incorrect",feedback:raw.explanation||""};}
  return {number:i+1,type:"descriptive",text:q.text,studentAnswer:String(sub?.typedAnswers?.[q.id]||"")||(sub?.files?.length?"پاسخ در فایل ارسالی ثبت شده است.":"بدون پاسخ"),referenceAnswer:q.referenceAnswer||"",earnedScore:earned,maxScore:max,status:earned>=max-0.001?"correct":earned>0?"partial":"incorrect",feedback:g.feedback||"",criteria:(g.criterionScores||[]).map(x=>({title:x.title||"معیار",score:Number(x.teacherScore??x.score??0),maxScore:Number(x.maxScore||0)}))};
 });
 return {exam:row,questions,feedback:grade?.feedback||"",hasSubmissionFiles:Boolean(sub?.files?.length),fileNotice:sub?.files?.length?"فایل اصلی در پرونده پاسخ آزمون نگهداری می‌شود؛ نمایش مستقیم فایل نیازمند مسیر دانلود مجاز است.":""};
}

async function handleTeacherAppApi(req,res,url){
  try{
    const auth=await authenticate(req,["teacher"]);const db=auth.db;
    // P67.12: fix the ORIGINAL teacher continuous-p11 report, not a parallel report page.
    // Teacher's default permission is "reports" (not the legacy "examManagement").
    // Keep the existing response schema used by continuous-p11.js and scope by
    // assigned CLASS and SUBJECT. Read-only: no grades or student data are changed.
    if(req.method==="GET"&&url.pathname==="/api/teacher/continuous-p11"){
      const sid=String(url.searchParams.get("studentId")||""),eid=String(url.searchParams.get("examId")||"");
      const student=(db.users||[]).find(s=>String(s.id)===sid&&s.role==="student"&&s.profileStatus!=="deleted");
      if(!student)throw Object.assign(new Error("دانش‌آموز یافت نشد."),{status:404});
      const permitted=activeTeachingAssignments(db,auth.user,"reports").some(a=>String(a.classId)===String(student.classId));
      if(!permitted)throw Object.assign(new Error("دسترسی به کارنامه این دانش‌آموز مجاز نیست."),{status:403});
      const allowed=e=>String(e.classId)===String(student.classId)&&teacherCanAssigned(db,auth.user,{
        classId:e.classId,subject:e.subject||"",feature:"reports"
      });
      const report=continuousP11(db,sid,eid,allowed);
      return sendJson(res,200,report);
    }
    if(req.method==="GET"&&url.pathname==="/api/teacher/dashboard")return sendJson(res,200,teacherDashboardV78(db,auth.user));
    if(req.method==="GET"&&url.pathname==="/api/teacher/workspace"){
      const scoped=scopedDbForStaff(db,auth.user);
      const assignments=activeTeachingAssignments(db,auth.user).map(a=>({id:a.id,classId:a.classId,subject:a.subject||"",bookId:a.bookId||"",features:Array.isArray(a.features)?a.features:[]}));
      const classes=(scoped.school?.classes||[]).map(c=>({id:c.id,name:c.name||"",grade:c.grade||"",shiftId:c.shiftId||""}));
      const students=(scoped.users||[]).filter(u=>u.role==="student"&&u.active!==false&&u.profileStatus!=="deleted").map(u=>({id:u.id,firstName:u.firstName||"",lastName:u.lastName||"",studentCode:u.studentCode||"",classId:u.classId||""}));
      const exams=(scoped.exams||[]).filter(e=>e.createdBy===auth.user.id||teacherCanAssigned(db,auth.user,{classId:e.classId||"",subject:e.subject||"",bookId:e.bookId||"",feature:"examManagement"})).map(e=>({id:e.id,title:e.title||"",type:e.type||"",subject:e.subject||"",classId:e.classId||"",status:e.status||"",publicationState:e.publicationState||"",startAt:e.startAt||e.scheduledAt||"",endAt:e.endAt||e.deadline||"",totalScore:examTotalScore(e)}));
      const attempts=(scoped.attempts||[]).map(a=>({id:a.id,examId:a.examId,studentId:a.studentId,score:a.score,total:a.total,percent:a.percent,submittedAt:a.submittedAt||a.at||""}));
      const submissions=(scoped.submissions||[]).map(a=>({id:a.id,examId:a.examId,studentId:a.studentId,submittedAt:a.submittedAt||a.at||""}));
      const grades=(scoped.grades||[]).map(g=>({id:g.id,submissionId:g.submissionId,score:g.score,finalScore:g.finalScore,at:g.at||g.updatedAt||""}));
      return sendJson(res,200,{ok:true,school:{year:db.school?.year||""},assignments,classes,students,exams,attempts,submissions,grades});
    }
    if(req.method==="POST"&&url.pathname==="/api/teacher/attendance/submit"){
      const body=await readJson(req),scheduleEntryId=String(body.scheduleEntryId||""),clock=schoolClockV74();
      const entry=(db.weeklySchedule||[]).find(x=>x.id===scheduleEntryId&&x.active!==false&&x.teacherId===auth.user.id&&String(x.academicYear||db.school?.year||"")===String(db.school?.year||""));
      if(!entry||!teacherCanAssigned(db,auth.user,{classId:entry.classId,subject:entry.subject||"",feature:"attendance"}))throw Object.assign(new Error("این کلاس در محدوده تدریس شما نیست."),{status:403});
      if(entry.day!==clock.dayName)throw Object.assign(new Error("حضور این کلاس فقط در روز برنامه همان کلاس قابل ثبت است."),{status:409});
      const win=teacherWindowV78(entry,clock);if(!win.open)throw Object.assign(new Error("الان خارج از بازه ثبت حضور این کلاس هستید."),{status:409});
      const block=classAttendanceBlockV78(db,entry.classId,clock.date);if(block)throw Object.assign(new Error(`ثبت حضور امروز به علت «${block.title||"تعطیلی"}» بسته است.`),{status:409});
      const roster=activeClassStudentsV78(db,entry.classId),rosterIds=new Set(roster.map(s=>s.id)),presentIds=new Set((Array.isArray(body.presentStudentIds)?body.presentStudentIds:[]).map(String).filter(id=>rosterIds.has(id)));
      const saved=await mutateDb(m=>{
        m.attendanceSessions=Array.isArray(m.attendanceSessions)?m.attendanceSessions:[];m.attendance=Array.isArray(m.attendance)?m.attendance:[];m.audit=Array.isArray(m.audit)?m.audit:[];
        let session=m.attendanceSessions.find(x=>x.scheduleEntryId===entry.id&&x.date===clock.date&&x.teacherId===auth.user.id);
        const now=new Date().toISOString(),period=activePeriodForDateV78(m,clock.date);
        const payload={scheduleEntryId:entry.id,classId:entry.classId,subject:entry.subject||"",teacherId:auth.user.id,date:clock.date,period:`زنگ ${Number(entry.periodNo||0)}`,periodNo:Number(entry.periodNo||0),shiftId:entry.shiftId||"",startTime:entry.startTime||"",endTime:entry.endTime||"",academicYear:String(m.school?.year||""),academicPeriod:period,updatedAt:now,updatedBy:auth.user.id,source:"teacher-app-v81"};
        if(session)Object.assign(session,payload);else{session={id:makeId("ats"),...payload,createdAt:now,createdBy:auth.user.id};m.attendanceSessions.push(session);}
        const classStudents=activeClassStudentsV78(m,entry.classId),classIds=new Set(classStudents.map(x=>x.id));
        const existing=new Map(m.attendance.filter(x=>x.sessionId===session.id).map(x=>[x.studentId,x]));
        m.attendance=m.attendance.filter(x=>x.sessionId!==session.id||classIds.has(x.studentId));
        for(const stu of classStudents){
          const row=existing.get(stu.id);const was=normalizeAttendanceStatusV81(row?.status);const checked=presentIds.has(stu.id);
          const status=checked?"present":["absent_excused","absent_unexcused"].includes(was)?was:"absent_pending";
          const base={sessionId:session.id,scheduleEntryId:entry.id,studentId:stu.id,classId:entry.classId,subject:entry.subject||"",teacherId:auth.user.id,date:clock.date,periodNo:Number(entry.periodNo||0),shiftId:entry.shiftId||"",academicYear:String(m.school?.year||""),academicPeriod:period,status,markedBy:auth.user.id,markedAt:row?.markedAt||now,updatedAt:now,source:"teacher-app-v81"};
          if(row){Object.assign(row,base);if(checked){row.absenceReasonId="";row.absenceReasonText="";row.reviewedAt="";row.reviewedBy="";row.reviewNote="";}}
          else m.attendance.push({id:makeId("att"),...base,reviewHistory:[]});
        }
        const latest=m.attendance.filter(x=>x.sessionId===session.id&&classIds.has(x.studentId)),present=latest.filter(x=>normalizeAttendanceStatusV81(x.status)==="present").length,pending=latest.filter(x=>normalizeAttendanceStatusV81(x.status)==="absent_pending").length,excused=latest.filter(x=>normalizeAttendanceStatusV81(x.status)==="absent_excused").length,unexcused=latest.filter(x=>normalizeAttendanceStatusV81(x.status)==="absent_unexcused").length,absent=pending+excused+unexcused;
        m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"ثبت حضور از اپ معلم",details:`${entry.subject||"کلاس"} · ${classInfoV78(m,entry.classId).name} · حاضر ${present} · غایب ${absent} (در انتظار بررسی ${pending})`,at:faNow()});
        return {sessionId:session.id,present,absent,pending,excused,unexcused,total:classStudents.length,absentStudentIds:classStudents.filter(st=>!presentIds.has(st.id)).map(st=>st.id)};
      });
      await securityAudit({type:"teacher_attendance_submit",userId:auth.user.id,role:"teacher",success:true,ip:clientIp(req),details:`${entry.id}:${clock.date}:${saved.result.present}/${saved.result.total}`});
      return sendJson(res,200,{ok:true,summary:saved.result,dashboard:teacherDashboardV78(saved.db,auth.user)});
    }
    return sendJson(res,404,{error:"مسیر اپ معلم پیدا نشد."});
  }catch(error){return sendJson(res,error.status||500,{error:error.message||"خطای اپ معلم"});}
}
function adminAttendanceLiveV78(db,date){
  const todayClock=schoolClockV74(),target=String(date||todayClock.date),dayName=schoolDayNameForDateV78(target),isToday=target===todayClock.date,users=new Map((db.users||[]).map(u=>[u.id,u]));
  const rows=(db.weeklySchedule||[]).filter(x=>x.active!==false&&x.day===dayName&&String(x.academicYear||db.school?.year||"")===String(db.school?.year||""));
  const reasons=(db.attendanceReasons||[]).map(x=>({id:String(x.id||""),title:String(x.title||""),excused:x.excused!==false})).filter(x=>x.id&&x.title);
  const classes=(db.school?.classes||[]).filter(c=>c.active!==false).map(c=>{
    const ci=classInfoV78(db,c.id),sessions=rows.filter(x=>x.classId===c.id).sort((a,b)=>(hmMinutesV74(a.startTime)??9999)-(hmMinutesV74(b.startTime)??9999)).map(entry=>{
      const snap=attendanceSnapshotV78(db,entry,target),records=new Map(snap.records.map(r=>[r.studentId,r])),roster=activeClassStudentsV78(db,c.id),teacher=users.get(entry.teacherId),win=isToday?teacherWindowV78(entry,todayClock):{open:false,state:"history"};
      const students=roster.map(st=>{const r=records.get(st.id);return{id:st.id,name:`${st.firstName||""} ${st.lastName||""}`.trim(),attendanceId:r?.id||"",status:r?.status||"unmarked",absenceReasonId:r?.absenceReasonId||"",absenceReasonText:r?.absenceReasonText||"",reviewedAt:r?.reviewedAt||""};});
      const absentStudents=students.filter(x=>isAbsentStatusV81(x.status));
      return {id:entry.id,subject:entry.subject||"",periodNo:Number(entry.periodNo||0),startTime:entry.startTime||"",endTime:entry.endTime||"",teacherId:entry.teacherId,teacherName:teacher?`${teacher.firstName||""} ${teacher.lastName||""}`.trim():"",marked:!!snap.session,current:win.state==="current",windowState:win.state,presentCount:students.filter(x=>x.status==="present").length,lateCount:students.filter(x=>x.status==="late").length,absentCount:absentStudents.length,pendingCount:students.filter(x=>x.status==="absent_pending").length,excusedCount:students.filter(x=>x.status==="absent_excused").length,unexcusedCount:students.filter(x=>x.status==="absent_unexcused").length,presentStudents:students.filter(x=>x.status==="present"),absentStudents,students};
    });
    return {...ci,sessions,currentPending:sessions.some(s=>s.current&&!s.marked)};
  });
  const all=classes.flatMap(c=>c.sessions),marked=all.filter(x=>x.marked);
  return {release:APP_RELEASE,date:target,dateFa:faDateV78(target),dayName,school:{name:db.school?.name||SCHOOL_NAME,year:db.school?.year||""},reasons,summary:{classes:classes.length,scheduledSessions:all.length,markedSessions:marked.length,present:marked.reduce((n,x)=>n+x.presentCount,0),absent:marked.reduce((n,x)=>n+x.absentCount,0),pending:marked.reduce((n,x)=>n+x.pendingCount,0),excused:marked.reduce((n,x)=>n+x.excusedCount,0),unexcused:marked.reduce((n,x)=>n+x.unexcusedCount,0),late:marked.reduce((n,x)=>n+x.lateCount,0)},classes};
}
async function handleAdminAttendanceLiveV78(req,res,url){
  try{
    const auth=await authenticate(req,["admin","superadmin"]);
    if(req.method==="GET"&&url.pathname==="/api/admin/attendance/live")return sendJson(res,200,adminAttendanceLiveV78(auth.db,url.searchParams.get("date")||schoolClockV74().date));
    if(req.method==="POST"&&url.pathname==="/api/admin/attendance/review"){
      const body=await readJson(req),attendanceId=String(body.attendanceId||""),status=String(body.status||"");
      if(!["absent_pending","absent_excused","absent_unexcused"].includes(status))throw Object.assign(new Error("وضعیت بررسی غیبت معتبر نیست."),{status:400});
      const reasonId=String(body.reasonId||"").trim(),reasonText=String(body.reasonText||"").trim().slice(0,300),note=String(body.note||"").trim().slice(0,500);
      const found=(auth.db.attendance||[]).find(x=>x.id===attendanceId);if(!found)throw Object.assign(new Error("رکورد حضور و غیاب پیدا نشد."),{status:404});
      if(!isAbsentStatusV81(found.status))throw Object.assign(new Error("فقط رکورد غیبت قابل تعیین وضعیت است."),{status:409});
      const reason=(auth.db.attendanceReasons||[]).find(x=>String(x.id||"")===reasonId);
      if(status==="absent_excused"&&!reasonText&&!reason)throw Object.assign(new Error("برای غیبت موجه، علت غیبت را انتخاب یا وارد کنید."),{status:400});
      if(status==="absent_excused"&&reason&&reason.excused===false)throw Object.assign(new Error("علت انتخاب‌شده برای غیبت موجه مناسب نیست."),{status:400});
      const saved=await mutateDb(m=>{
        const row=(m.attendance||[]).find(x=>x.id===attendanceId);if(!row)throw Object.assign(new Error("رکورد حضور و غیاب پیدا نشد."),{status:404});
        const from=normalizeAttendanceStatusV81(row.status),now=new Date().toISOString(),student=(m.users||[]).find(x=>x.id===row.studentId),resolvedReason=reasonText||(m.attendanceReasons||[]).find(x=>String(x.id||"")===reasonId)?.title|| (status==="absent_unexcused"?"دلیل موجه تأیید نشد":"");
        row.reviewHistory=Array.isArray(row.reviewHistory)?row.reviewHistory:[];row.reviewHistory.push({from,to:status,reasonId,reasonText:resolvedReason,note,by:auth.user.id,at:now});
        Object.assign(row,{status,absenceReasonId:reasonId,absenceReasonText:resolvedReason,reviewNote:note,reviewedBy:auth.user.id,reviewedAt:now,updatedAt:now});
        m.audit=Array.isArray(m.audit)?m.audit:[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"بررسی غیبت دانش‌آموز",details:`${student?`${student.firstName||""} ${student.lastName||""}`.trim():row.studentId} · ${from} → ${status}${resolvedReason?` · ${resolvedReason}`:""}`,at:faNow()});
        return {id:row.id,status:row.status,studentId:row.studentId,date:row.date,reasonText:resolvedReason};
      });
      await securityAudit({type:"attendance_absence_review",userId:auth.user.id,role:auth.user.role,success:true,ip:clientIp(req),details:`${attendanceId}:${saved.result.status}`});
      return sendJson(res,200,{ok:true,attendance:saved.result,live:adminAttendanceLiveV78(saved.db,found.date||schoolClockV74().date)});
    }
    return sendJson(res,405,{error:"روش درخواست پشتیبانی نمی‌شود."});
  }catch(error){return sendJson(res,error.status||500,{error:error.message||"خطای مانیتور حضور"});}
}


function scopedDbForStaff(db, user) {
  const copy = JSON.parse(JSON.stringify(db));
  if (["admin", "superadmin"].includes(user.role)) return copy;
  // P66: do not expose admin-only questions to scoped teacher state.
  delete copy.adminQuestionBank;
  const s = teacherScope(db, user);
  const can = (row, feature="") => teacherCanAssigned(db, user, {classId:row?.classId||"",subject:row?.subject||"",bookId:row?.bookId||"",feature});
  copy.teachingAssignments = (copy.teachingAssignments || []).filter(a => a.teacherId === user.id);
  copy.school = { ...copy.school, classes: (copy.school.classes || []).filter(c => s.classIds.has(c.id)), subjects: [...s.subjects] };
  copy.users = (copy.users || []).filter(u => u.id === user.id || s.studentIds.has(u.id));
  copy.curriculum = (copy.curriculum || []).filter(b => s.bookIds.has(b.id));
  copy.chapterProgress = (copy.chapterProgress || []).filter(p => teacherCanAssigned(db,user,{classId:p.classId,bookId:p.bookId,feature:"classJournal"}));
  copy.learningPoints = (copy.learningPoints || []).filter(p => teacherCanAssigned(db,user,{bookId:p.bookId,subject:p.subject,feature:"questionBank"}));
  copy.questionBank = (copy.questionBank || []).filter(q => s.questionIds.has(q.id));
  copy.questionCollections = (copy.questionCollections || []).filter(c => c.createdBy === user.id || c.shared).map(c => ({ ...c, questionIds: (c.questionIds || []).filter(id => s.questionIds.has(id)) }));
  copy.questionVersions = (copy.questionVersions || []).filter(v => s.questionIds.has(v.questionId));
  copy.questionGenerationJobs = (copy.questionGenerationJobs || []).filter(j => teacherCanAssigned(db,user,{bookId:j.bookId,feature:"questionBank"}));
  copy.exams = (copy.exams || []).filter(e => s.examIds.has(e.id));
  const usageV4523 = teacherQuestionUsageV4523(db, user.id);
  copy.teacherQuestionUsage = usageV4523;
  copy.questionBank = (copy.questionBank || []).map(q => ({...q,teacherUsage:usageV4523[q.id]||{count:0,examIds:[],lastUsedAt:null},previouslyUsedByTeacher:Number(usageV4523[q.id]?.count||0)>0}));
  copy.examBlueprints = (copy.examBlueprints || []).filter(b => b.createdBy === user.id && teacherCanAssigned(db,user,{classId:b.classId,bookId:b.bookId,feature:"examCreate"}));
  copy.attempts = (copy.attempts || []).filter(a => s.examIds.has(a.examId) && s.studentIds.has(a.studentId));
  copy.submissions = (copy.submissions || []).filter(x => s.submissionIds.has(x.id));
  copy.grades = (copy.grades || []).filter(g => s.submissionIds.has(g.submissionId));
  copy.appeals = (copy.appeals || []).filter(a => s.examIds.has(a.examId) && s.studentIds.has(a.studentId));
  copy.notifications = (copy.notifications || []).filter(n => n.userId === user.id || s.studentIds.has(n.userId));
  copy.homework = (copy.homework || []).filter(h => can(h,"homework"));
  const homeworkIds = new Set(copy.homework.map(h => h.id));
  copy.homeworkSubmissions = (copy.homeworkSubmissions || []).filter(x => homeworkIds.has(x.homeworkId) && s.studentIds.has(x.studentId));
  copy.resources = (copy.resources || []).filter(r => can(r,"classJournal"));
  copy.attendanceSessions = (copy.attendanceSessions || []).filter(a => can(a,"attendance"));
  const attendanceSessionIds = new Set(copy.attendanceSessions.map(x => x.id));
  copy.attendance = (copy.attendance || []).filter(a => s.studentIds.has(a.studentId) && (!a.sessionId || attendanceSessionIds.has(a.sessionId)));
  copy.continuousAssessments = (copy.continuousAssessments || []).filter(a => s.studentIds.has(a.studentId) && can(a,"continuous"));
  copy.gradebookConfigs=(copy.gradebookConfigs||[]).filter(a=>teacherCanAssigned(db,user,{classId:a.classId,subject:a.subject||"",feature:"continuous"}));
  copy.gradebookEntries=(copy.gradebookEntries||[]).filter(a=>s.studentIds.has(a.studentId)&&teacherCanAssigned(db,user,{classId:a.classId,subject:a.subject||"",feature:"continuous"}));
  copy.termFinalOverrides=(copy.termFinalOverrides||[]).filter(a=>s.studentIds.has(a.studentId)&&teacherCanAssigned(db,user,{classId:a.classId,subject:a.subject||"",feature:"continuous"}));
  copy.termLocks=(copy.termLocks||[]).filter(a=>teacherCanAssigned(db,user,{classId:a.classId,subject:a.subject||"",feature:"continuous"}));
  copy.notificationBroadcasts=(copy.notificationBroadcasts||[]).filter(a=>a.createdBy===user.id);
  copy.continuousGradeOverrides=(copy.continuousGradeOverrides||[]).filter(a=>s.studentIds.has(a.studentId)&&teacherCanAssigned(db,user,{classId:a.classId,subject:a.subject||"",feature:"continuous"}));
  copy.termPolicies=(copy.termPolicies||[]).filter(p=>teacherCanAssigned(db,user,{classId:p.classId,subject:p.subject,feature:"continuous"}));
  // v193: نمره مستمر پایان‌ترم نیز باید در state محدودشده معلم دیده شود؛
  // در نسخه‌های قبل termGrades از مرز سرور حذف می‌شد و کارنامه دانش‌آموز مستمر را صفر می‌دید.
  copy.termGrades = (copy.termGrades || []).filter(a => {
    const student = (db.users || []).find(st => st.id === a.studentId && st.role === "student");
    return !!student && s.studentIds.has(a.studentId) && teacherCanAssigned(db,user,{classId:student.classId,subject:a.subject||"",feature:"continuous"});
  });
  copy.behaviorRecords = (copy.behaviorRecords || []).filter(a => s.studentIds.has(a.studentId) && teacherCanAssigned(db,user,{classId:a.classId,subject:a.subject||"",feature:"behavior"}));
  copy.lessonLogs = (copy.lessonLogs || []).filter(a => can(a,"classJournal"));
  copy.guardianContacts = (copy.guardianContacts || []).filter(a => s.studentIds.has(a.studentId) && teacherCanAssigned(db,user,{classId:a.classId,feature:"family"}));
  copy.guardianLinks = (copy.guardianLinks || []).filter(a => s.studentIds.has(a.studentId));
  const scopedGuardianIds = new Set(copy.guardianLinks.map(a=>a.guardianId).filter(Boolean));
  copy.guardians = (copy.guardians || []).filter(g => scopedGuardianIds.has(g.id));
  copy.consentForms = (copy.consentForms || []).filter(a => !a.classId || teacherCanAssigned(db,user,{classId:a.classId,feature:"family"}));
  copy.progressReports = (copy.progressReports || []).filter(a => s.studentIds.has(a.studentId) && activeTeachingAssignments(db,user,"reports").some(x=>x.classId===(db.users||[]).find(st=>st.id===a.studentId)?.classId));
  copy.schedule = (copy.schedule || []).filter(a => s.classIds.has(a.classId));
  copy.weeklySchedule=(copy.weeklySchedule||[]).filter(a=>s.classIds.has(a.classId)&&(a.teacherId===user.id||teacherCanAssigned(db,user,{classId:a.classId,subject:a.subject||""})));
  copy.onlineClassSessions=(copy.onlineClassSessions||[]).filter(a=>s.classIds.has(a.classId)&&(a.teacherId===user.id||teacherCanAssigned(db,user,{classId:a.classId,subject:a.subject||"",feature:"attendance"})));
  const onlineSessionIdsV74=new Set(copy.onlineClassSessions.map(x=>x.id));
  copy.onlineJoinEvents=(copy.onlineJoinEvents||[]).filter(a=>s.studentIds.has(a.studentId)&&(!a.onlineSessionId||onlineSessionIdsV74.has(a.onlineSessionId))&&(!a.classId||s.classIds.has(a.classId)));
  copy.announcements = (copy.announcements || []).filter(a => a.createdBy === user.id);
  copy.interventions = (copy.interventions || []).filter(a => s.studentIds.has(a.studentId) && activeTeachingAssignments(db,user,"interventions").some(x=>x.classId===(db.users||[]).find(st=>st.id===a.studentId)?.classId));
  copy.audit = (copy.audit || []).filter(a => a.userId === user.id).slice(0, 1000);
  return copy;
}
function mergeScopedCollection(oldRows, incomingRows, oldInScope, newInScope) {
  const incoming = Array.isArray(incomingRows) ? incomingRows : [];
  if (incoming.some(row => !newInScope(row))) throw Object.assign(new Error("تغییر خارج از تخصیص تدریس یا مجوز تعیین‌شده برای شما مجاز نیست."), { status: 403 });
  return [...(oldRows || []).filter(row => !oldInScope(row)), ...incoming];
}
function mergeTeacherDb(oldDb, incoming, user) {
  const scope = teacherScope(oldDb, user); const result = JSON.parse(JSON.stringify(oldDb));
  const can = (row, feature="") => teacherCanAssigned(oldDb,user,{classId:row?.classId||"",subject:row?.subject||"",bookId:row?.bookId||"",feature});
  const canExam = e => can(e,"examCreate");
  const books = new Map((oldDb.curriculum || []).map(b => [b.id, b]));
  const classes = new Map((oldDb.school?.classes || []).map(c => [c.id, c]));
  incoming.questionBank = (Array.isArray(incoming.questionBank) ? incoming.questionBank : []).map(raw => {
    const q={...raw},book=books.get(q.bookId);
    if(!book)throw Object.assign(new Error("کتاب سؤال معتبر نیست."),{status:400});
    if(q.subject&&q.subject!==book.subject)throw Object.assign(new Error("درس سؤال با کتاب انتخاب‌شده سازگار نیست."),{status:400});
    const meta=gradeMeta(book.grade);
    return {...q,subject:book.subject,grade:meta.grade,gradeId:meta.id,gradeName:meta.name};
  });
  const incomingExams = (Array.isArray(incoming.exams)?incoming.exams:[]).map(raw=>{
    const cls=classes.get(raw.classId),book=books.get(raw.bookId);
    const e=normalizeExamCore(raw,cls,book);
    // P67: a published exam may snapshot approved admin-bank questions by reference;
    // this validation is read-only and never migrates admin questions into questionBank.
    const oldExam=(oldDb.exams||[]).find(x=>String(x.id)===String(e.id));
    const priorRefs=new Set((oldExam?.questions||[]).map(x=>String(x.sourceQuestionId||"")));
    const authorizedAdmin=(oldDb.adminQuestionBank||[]).filter(q=>
      (q.status==="approved"||priorRefs.has(String(q.id))) &&
      teacherCanAssigned(oldDb,user,{bookId:q.bookId,subject:q.subject,feature:"questionBank"}));
    const adminById=new Map(authorizedAdmin.map(q=>[String(q.id),q]));
    for(const q of e.questions||[]){
      const sourceId=String(q.sourceQuestionId||"");
      const fromAdmin=(oldDb.adminQuestionBank||[]).some(x=>String(x.id)===sourceId);
      if(fromAdmin){
        const source=adminById.get(sourceId);
        if(!source||String(source.bookId)!==String(e.bookId)||String(source.chapterId)!==String(q.sourceChapterId||q.chapterId||""))
          throw Object.assign(new Error("سؤال انتخاب‌شده از مخزن ادمین تأیید نشده یا به کتاب/فصل مجاز تعلق ندارد."),{status:403});
      }
    }
    const errors=validateExamCore(e,{cls,book,questionBank:[...(incoming.questionBank||oldDb.questionBank||[]),...authorizedAdmin]});
    if((e.examCategory||"ongoing")==="final"){
      const period=normalizeAcademicPeriod(e.academicPeriod||e.period,{allowAnnual:false}),year=String(e.academicYear||incoming.school?.year||"");
      const explicitPolicy=(incoming.termPolicies||oldDb.termPolicies||[]).find(p=>p.classId===e.classId&&p.subject===(e.subject||book.subject)&&String(p.academicYear||"")===year&&String(p.academicPeriod||"semester2")===period);
      if(explicitPolicy){const policy=normalizeTermPolicyCore(explicitPolicy,Number(incoming.school?.settings?.scoreScale||20));if(Math.abs(Number(e.targetScore||0)-Number(policy.finalShare))>.001)errors.push(`بارم آزمون پایانی این دوره باید دقیقاً ${policy.finalShare} نمره باشد؛ سهم مستمر ${policy.continuousShare} نمره است.`);}
    }
    if(errors.length)throw Object.assign(new Error(errors.join(" ")),{status:400});
    const meta=gradeMeta(cls.grade);
    return {...e,subject:book.subject,grade:meta.grade,gradeId:meta.id,gradeName:meta.name};
  });
  // p20: exams visible to the teacher can be read-only (e.g. grading access
  // without examCreate). Never treat their presence in a scoped state as a write.
  // Preserve authoritative read-only records; only writable exams enter the merge.
  const writableIncomingExams = [];
  const oldExamsByIdP20 = new Map((oldDb.exams || []).map(e => [e.id, e]));
  for (const e of incomingExams) {
    if (!canExam(e)) {
      const previous = oldExamsByIdP20.get(e.id);
      // A newly injected/out-of-scope exam is never accepted.
      if (!previous || !scope.examIds.has(e.id)) throw Object.assign(new Error("این آزمون خارج از کلاس/درس/کتاب تخصیص‌یافته به شماست."),{status:403});
      // Read-only exam fields always come from the server, not the client.
      continue;
    }
    if (e.status === "active" && !can(e,"examPublish")) throw Object.assign(new Error("مجوز انتشار آزمون برای این تخصیص تدریس فعال نیست."),{status:403});
    writableIncomingExams.push(e);
  }
  const incomingExamIds = new Set(writableIncomingExams.map(e=>e.id)); const allExamIds = new Set([...scope.examIds,...incomingExamIds]);
  const incomingSubmissionIds = new Set((incoming.submissions||[]).filter(x=>allExamIds.has(x.examId)&&scope.studentIds.has(x.studentId)).map(x=>x.id));
  const allSubmissionIds = new Set([...scope.submissionIds,...incomingSubmissionIds]);
  result.chapterProgress = mergeScopedCollection(oldDb.chapterProgress,incoming.chapterProgress,p=>teacherCanAssigned(oldDb,user,{classId:p.classId,bookId:p.bookId,feature:"classJournal"}),p=>teacherCanAssigned(oldDb,user,{classId:p.classId,bookId:p.bookId,feature:"classJournal"}));
  result.learningPoints = mergeScopedCollection(oldDb.learningPoints,incoming.learningPoints,p=>teacherCanAssigned(oldDb,user,{bookId:p.bookId,subject:p.subject,feature:"questionBank"}),p=>teacherCanAssigned(oldDb,user,{bookId:p.bookId,subject:p.subject,feature:"questionBank"}));
  // بانک سؤال: سؤال‌های مدیریت/اشتراکی در state معلم دیده می‌شوند اما read-only باقی می‌مانند.
  const oldQuestionById = new Map((oldDb.questionBank || []).map(q => [q.id, q]));
  const writableOldQuestionIds = new Set((oldDb.questionBank || []).filter(q => teacherCanWriteQuestion(oldDb, user, q)).map(q => q.id));
  const teacherWritableQuestions = [];
  for (const qRaw of incoming.questionBank || []) {
    const existing = oldQuestionById.get(qRaw.id);
    if (existing && !teacherCanWriteQuestion(oldDb, user, existing)) continue; // نسخه مرکزی مدرسه را هرگز از payload معلم قبول نکن.
    const q = { ...qRaw, createdBy: existing?.createdBy || user.id };
    if (!teacherCanAssigned(oldDb,user,{bookId:q.bookId,subject:q.subject,feature:"questionBank"})) throw Object.assign(new Error("این سؤال خارج از کتاب/درس تخصیص‌یافته به شماست."),{status:403});
    teacherWritableQuestions.push(q);
  }
  result.questionBank = [
    ...(oldDb.questionBank || []).filter(q => !writableOldQuestionIds.has(q.id)),
    ...teacherWritableQuestions
  ];
  const qids=new Set(result.questionBank.filter(q=>teacherCanReadQuestion(result,user,q)).map(q=>q.id));
  const writableQids=new Set(result.questionBank.filter(q=>teacherCanWriteQuestion(result,user,q)).map(q=>q.id));
  result.questionCollections=[...(oldDb.questionCollections||[]).filter(c=>c.createdBy!==user.id),...(incoming.questionCollections||[]).filter(c=>c.createdBy===user.id).map(c=>({...c,questionIds:(c.questionIds||[]).filter(id=>qids.has(id))}))];
  // تاریخچه سؤال‌های مرکزی نیز read-only است؛ فقط تاریخچه سؤال‌های خود معلم از payload او ادغام می‌شود.
  result.questionVersions=[...(oldDb.questionVersions||[]).filter(v=>!writableQids.has(v.questionId)),...(incoming.questionVersions||[]).filter(v=>writableQids.has(v.questionId))];
  result.questionGenerationJobs=mergeScopedCollection(oldDb.questionGenerationJobs,incoming.questionGenerationJobs,j=>teacherCanAssigned(oldDb,user,{bookId:j.bookId,feature:"questionBank"}),j=>teacherCanAssigned(oldDb,user,{bookId:j.bookId,feature:"questionBank"}));
  result.exams=mergeScopedCollection(oldDb.exams,writableIncomingExams,e=>scope.examIds.has(e.id)&&canExam(e),e=>canExam(e)).map(e=>{
    const cls=(result.school?.classes||[]).find(c=>c.id===e.classId),book=(result.curriculum||[]).find(b=>b.id===e.bookId);
    return normalizeExamCore(e,cls,book);
  });
  result.examBlueprints=[...(oldDb.examBlueprints||[]).filter(b=>b.createdBy!==user.id),...(incoming.examBlueprints||[]).filter(b=>b.createdBy===user.id&&teacherCanAssigned(oldDb,user,{classId:b.classId,bookId:b.bookId,feature:"examCreate"}))];
  result.attempts=mergeScopedCollection(oldDb.attempts,incoming.attempts,a=>scope.examIds.has(a.examId)&&scope.studentIds.has(a.studentId),a=>allExamIds.has(a.examId)&&scope.studentIds.has(a.studentId));
  result.submissions=mergeScopedCollection(oldDb.submissions,incoming.submissions,x=>scope.examIds.has(x.examId)&&scope.studentIds.has(x.studentId),x=>allExamIds.has(x.examId)&&scope.studentIds.has(x.studentId));
  const submissionById=id=>(result.submissions||[]).find(x=>x.id===id)||(oldDb.submissions||[]).find(x=>x.id===id); const examById=id=>(result.exams||[]).find(x=>x.id===id)||(oldDb.exams||[]).find(x=>x.id===id);
  const canGradeSubmission=id=>{const sub=submissionById(id),ex=examById(sub?.examId);return !!sub&&!!ex&&scope.studentIds.has(sub.studentId)&&teacherCanAssigned(oldDb,user,{classId:ex.classId,subject:ex.subject,bookId:ex.bookId,feature:"grading"});};
  result.grades=mergeScopedCollection(oldDb.grades,incoming.grades,g=>scope.submissionIds.has(g.submissionId)&&canGradeSubmission(g.submissionId),g=>allSubmissionIds.has(g.submissionId)&&canGradeSubmission(g.submissionId));
  for(const grade of result.grades.filter(g=>(incoming.grades||[]).some(x=>x.id===g.id))){
    const sub=submissionById(grade.submissionId),ex=examById(sub?.examId||grade.examId);
    if(!ex)continue;
    const gradeErrors=validatePublishedGradeCore(grade,ex);
    if(gradeErrors.length)throw Object.assign(new Error(gradeErrors.join(" ")),{status:400});
  }
  result.appeals=mergeScopedCollection(oldDb.appeals,incoming.appeals,a=>scope.examIds.has(a.examId)&&scope.studentIds.has(a.studentId)&&teacherCanAssigned(oldDb,user,{classId:examById(a.examId)?.classId,subject:examById(a.examId)?.subject,bookId:examById(a.examId)?.bookId,feature:"grading"}),a=>allExamIds.has(a.examId)&&scope.studentIds.has(a.studentId)&&teacherCanAssigned(oldDb,user,{classId:examById(a.examId)?.classId,subject:examById(a.examId)?.subject,bookId:examById(a.examId)?.bookId,feature:"grading"}));
  result.notifications=mergeScopedCollection(oldDb.notifications,incoming.notifications,n=>n.userId===user.id||scope.studentIds.has(n.userId),n=>n.userId===user.id||scope.studentIds.has(n.userId));
  result.homework=mergeScopedCollection(oldDb.homework,incoming.homework,h=>can(h,"homework"),h=>can(h,"homework")); const hwIds=new Set(result.homework.filter(h=>can(h,"homework")).map(h=>h.id));
  result.homeworkSubmissions=mergeScopedCollection(oldDb.homeworkSubmissions,incoming.homeworkSubmissions,x=>hwIds.has(x.homeworkId)&&scope.studentIds.has(x.studentId),x=>hwIds.has(x.homeworkId)&&scope.studentIds.has(x.studentId));
  result.resources=mergeScopedCollection(oldDb.resources,incoming.resources,r=>can(r,"classJournal"),r=>can(r,"classJournal"));
  // p18: مسیر عمومی /api/state نیز حق دورزدن ساعت حضور و غیاب را ندارد.
  // فقط تغییرات جدید حضور/جلسه را بررسی می‌کنیم تا رکوردهای تاریخی موجود در state معلم مسدود نشوند.
  const attendanceClockV18=schoolClockV74(), oldSessionByIdV18=new Map((oldDb.attendanceSessions||[]).map(x=>[x.id,x]));
  const changedJsonV18=(a,b)=>JSON.stringify(a??null)!==JSON.stringify(b??null);
  const assertScheduledAttendanceWriteV18=(session)=>{
    const entry=(oldDb.weeklySchedule||[]).find(x=>x.id===session?.scheduleEntryId&&x.active!==false);
    if(!entry||entry.teacherId!==user.id||entry.classId!==session?.classId||String(entry.subject||"")!==String(session?.subject||""))throw Object.assign(new Error("ثبت حضور فقط از زنگ برنامه هفتگی همان معلم مجاز است."),{status:409});
    if(entry.day!==attendanceClockV18.dayName||String(session?.date||"")!==attendanceClockV18.date)throw Object.assign(new Error("حضور این کلاس فقط در روز برنامه همان کلاس قابل ثبت است."),{status:409});
    if(!teacherWindowV78(entry,attendanceClockV18).open)throw Object.assign(new Error(`حضور و غیاب این کلاس فقط از ساعت ${entry.startTime||""} تا ${entry.endTime||""} فعال است.`),{status:409});
    if(classAttendanceBlockV78(oldDb,entry.classId,attendanceClockV18.date))throw Object.assign(new Error("ثبت حضور امروز برای این کلاس بسته است."),{status:409});
    return entry;
  };
  for(const se of (Array.isArray(incoming.attendanceSessions)?incoming.attendanceSessions:[])){const old=oldSessionByIdV18.get(se.id);if(!old||changedJsonV18(se,old))assertScheduledAttendanceWriteV18(se);}
  result.attendanceSessions=mergeScopedCollection(oldDb.attendanceSessions,incoming.attendanceSessions,a=>can(a,"attendance"),a=>can(a,"attendance")); const sessIds=new Set(result.attendanceSessions.filter(a=>can(a,"attendance")).map(a=>a.id));
  const oldAttendanceByIdV81=new Map((oldDb.attendance||[]).map(x=>[x.id,x]));
  for(const ar of (Array.isArray(incoming.attendance)?incoming.attendance:[])){const old=oldAttendanceByIdV81.get(ar.id);if(!old||changedJsonV18(ar,old)){const se=(incoming.attendanceSessions||[]).find(x=>x.id===ar.sessionId)||oldSessionByIdV18.get(ar.sessionId);assertScheduledAttendanceWriteV18(se);}}
  incoming.attendance=(Array.isArray(incoming.attendance)?incoming.attendance:[]).map(raw=>{const row={...raw,status:normalizeAttendanceStatusV81(raw.status)};const old=oldAttendanceByIdV81.get(row.id),oldStatus=old?normalizeAttendanceStatusV81(old.status):"";if(["absent_excused","absent_unexcused"].includes(row.status)&&row.status!==oldStatus)throw Object.assign(new Error("تعیین موجه یا غیرموجه بودن غیبت فقط توسط مدیریت مجاز است."),{status:403});if(old&&["absenceReasonId","absenceReasonText","reviewedAt","reviewedBy","reviewNote","reviewHistory"].some(k=>JSON.stringify(row[k]??null)!==JSON.stringify(old[k]??null)))throw Object.assign(new Error("معلم اجازه تغییر نتیجه بررسی غیبت را ندارد."),{status:403});return row;});
  result.attendance=mergeScopedCollection(oldDb.attendance,incoming.attendance,a=>scope.studentIds.has(a.studentId)&&(!a.sessionId||sessIds.has(a.sessionId)),a=>scope.studentIds.has(a.studentId)&&(!a.sessionId||sessIds.has(a.sessionId)));
  const lockedScopesV75=(oldDb.termLocks||[]).filter(x=>x.active!==false&&teacherCanAssigned(oldDb,user,{classId:x.classId,subject:x.subject||"",feature:"continuous"}));
  const rowScopeKeyV75=row=>`${row?.classId||((oldDb.users||[]).find(st=>st.id===row?.studentId)?.classId||"")}__${row?.subject||""}__${String(row?.academicYear||oldDb.school?.year||"")}__${String(row?.academicPeriod||row?.period||"semester2")}`;
  const lockKeyV75=x=>`${x.classId}__${x.subject||""}__${String(x.academicYear||oldDb.school?.year||"")}__${String(x.academicPeriod||x.period||"semester2")}`;
  const lockedKeysV75=new Set(lockedScopesV75.map(lockKeyV75));
  const assertLockedCollectionUnchangedV75=(name,oldRows,newRows)=>{const normalize=rows=>(rows||[]).filter(r=>lockedKeysV75.has(rowScopeKeyV75(r))).map(r=>JSON.stringify(r)).sort();if(JSON.stringify(normalize(oldRows))!==JSON.stringify(normalize(newRows)))throw Object.assign(new Error("نمرات این درس/نیم‌سال توسط مدیریت قفل شده‌اند و از مسیر همگام‌سازی نیز قابل تغییر نیستند."),{status:409,code:"TERM_LOCKED"});};
  assertLockedCollectionUnchangedV75("continuousAssessments",oldDb.continuousAssessments,incoming.continuousAssessments);
  assertLockedCollectionUnchangedV75("continuousGradeOverrides",oldDb.continuousGradeOverrides,incoming.continuousGradeOverrides);
  assertLockedCollectionUnchangedV75("termGrades",oldDb.termGrades,incoming.termGrades);
  result.continuousAssessments=mergeScopedCollection(oldDb.continuousAssessments,incoming.continuousAssessments,a=>scope.studentIds.has(a.studentId)&&can(a,"continuous"),a=>scope.studentIds.has(a.studentId)&&can(a,"continuous"));
  // v75: دفتر نمره و تنظیمات آن فقط از API تخصصی نوشته می‌شوند؛ payload عمومی state برای معلم read-only است.
  result.gradebookEntries=oldDb.gradebookEntries||[];
  result.termFinalOverrides=oldDb.termFinalOverrides||[];
  result.gradebookConfigs=oldDb.gradebookConfigs||[];
  result.termLocks=oldDb.termLocks||[];
  const canContinuousOverrideV73=row=>{const st=(oldDb.users||[]).find(x=>x.id===row?.studentId&&x.role==="student");return !!st&&scope.studentIds.has(row.studentId)&&row.classId===st.classId&&teacherCanAssigned(oldDb,user,{classId:row.classId,subject:row.subject||"",feature:"continuous"})&&String(row.academicYear||oldDb.school?.year||"")===String(oldDb.school?.year||"")&&["semester1","semester2"].includes(String(row.academicPeriod||row.period||"semester2"))&&Number.isFinite(Number(row.finalScore))&&Number(row.finalScore)>=0&&Number(row.finalScore)<=20;};
  result.continuousGradeOverrides=mergeScopedCollection(oldDb.continuousGradeOverrides,incoming.continuousGradeOverrides,canContinuousOverrideV73,canContinuousOverrideV73);
  // v193: termGrades همان منبع رسمی نمره مستمر کارنامه پایان‌ترم است.
  // فقط معلم دارای تخصیص فعال همان دانش‌آموز/درس و فقط در سال تحصیلی فعال حق تغییر دارد.
  const activeYearV193 = String(oldDb.school?.year || "");
  const canTermGradeV193 = row => {
    const student = (oldDb.users || []).find(st => st.id === row?.studentId && st.role === "student");
    if (!student || !scope.studentIds.has(row.studentId)) return false;
    const rowYear = String(row.academicYear || (String(row.key || "").endsWith(`__${activeYearV193}`) ? activeYearV193 : ""));
    return rowYear === activeYearV193 && teacherCanAssigned(oldDb,user,{classId:student.classId,subject:row.subject||"",feature:"continuous"});
  };
  const normalizedIncomingTermGradesV193 = (Array.isArray(incoming.termGrades) ? incoming.termGrades : []).map(row => {
    const academicYear=row.academicYear||activeYearV193,academicPeriod=normalizeAcademicPeriod(row.academicPeriod||row.period,{allowAnnual:false});
    return {...row,academicYear,academicPeriod,key:periodizedTermKey(row.studentId,row.subject,academicYear,academicPeriod)};
  });
  result.termGrades=mergeScopedCollection(oldDb.termGrades,normalizedIncomingTermGradesV193,canTermGradeV193,canTermGradeV193);
  result.behaviorRecords=mergeScopedCollection(oldDb.behaviorRecords,incoming.behaviorRecords,a=>scope.studentIds.has(a.studentId)&&teacherCanAssigned(oldDb,user,{classId:a.classId,subject:a.subject||"",feature:"behavior"}),a=>scope.studentIds.has(a.studentId)&&teacherCanAssigned(oldDb,user,{classId:a.classId,subject:a.subject||"",feature:"behavior"}));
  result.lessonLogs=mergeScopedCollection(oldDb.lessonLogs,incoming.lessonLogs,a=>can(a,"classJournal"),a=>can(a,"classJournal"));
  result.guardianContacts=mergeScopedCollection(oldDb.guardianContacts,incoming.guardianContacts,a=>scope.studentIds.has(a.studentId)&&teacherCanAssigned(oldDb,user,{classId:a.classId,feature:"family"}),a=>scope.studentIds.has(a.studentId)&&teacherCanAssigned(oldDb,user,{classId:a.classId,feature:"family"}));
  result.consentForms=mergeScopedCollection(oldDb.consentForms,incoming.consentForms,a=>!a.classId||teacherCanAssigned(oldDb,user,{classId:a.classId,feature:"family"}),a=>!a.classId||teacherCanAssigned(oldDb,user,{classId:a.classId,feature:"family"}));
  result.progressReports=mergeScopedCollection(oldDb.progressReports,incoming.progressReports,a=>scope.studentIds.has(a.studentId),a=>scope.studentIds.has(a.studentId)&&activeTeachingAssignments(oldDb,user,"reports").length>0);
  const canReportCardV203 = row => {
    const student=(oldDb.users||[]).find(st=>st.id===row?.studentId&&st.role==="student");
    return !!student && scope.studentIds.has(row.studentId) && String(row.academicYear||oldDb.school?.year||"")===String(oldDb.school?.year||"") && activeTeachingAssignments(oldDb,user,"reports").some(a=>!a.classId||a.classId===student.classId);
  };
  result.reportCards=mergeScopedCollection(oldDb.reportCards,incoming.reportCards,canReportCardV203,canReportCardV203);
  // برنامه هفتگی فقط توسط مدیریت مدرسه قابل ویرایش است؛ معلم نسخه محدودشده را فقط می‌خواند.
  result.schedule=oldDb.schedule||[];
  result.weeklySchedule=oldDb.weeklySchedule||[];
  const scheduleByIdV74=new Map((oldDb.weeklySchedule||[]).map(x=>[x.id,x]));
  const onlineSettingsV74=onlineLearningSettingsV74(oldDb);
  const canOnlineSessionV74=row=>{
    const entry=scheduleByIdV74.get(row?.scheduleEntryId);
    if(!entry||entry.teacherId!==user.id||row.classId!==entry.classId||row.teacherId!==user.id)return false;
    if(!teacherCanAssigned(oldDb,user,{classId:entry.classId,subject:entry.subject||"",feature:"attendance"}))return false;
    if(String(row.academicYear||oldDb.school?.year||"")!==String(oldDb.school?.year||""))return false;
    const effective=effectiveDeliveryModeV74(oldDb,entry);
    if(!onlineSettingsV74.enabled||!["online","hybrid"].includes(effective))return false;
    let rowUrl=""; try{rowUrl=normalizeWebUrlV74(row.meetingUrl||entry.meetingUrl||onlineSettingsV74.defaultMeetingUrl||"");}catch{return false;}
    if(!rowUrl)return false;
    if(onlineSettingsV74.teacherCanEditLinks===false){
      let fixed=""; try{fixed=normalizeWebUrlV74(entry.meetingUrl||onlineSettingsV74.defaultMeetingUrl||"");}catch{return false;}
      if(!fixed||rowUrl!==fixed)return false;
    }
    return true;
  };
  const incomingOnlineSessionsV74=(Array.isArray(incoming.onlineClassSessions)?incoming.onlineClassSessions:[]).map(row=>{
    const entry=scheduleByIdV74.get(row?.scheduleEntryId);
    if(!entry)return row;
    const fixedUrl=entry.meetingUrl||onlineSettingsV74.defaultMeetingUrl||"";
    const meetingUrl=onlineSettingsV74.teacherCanEditLinks===false?fixedUrl:(row.meetingUrl||fixedUrl);
    return {...row,deliveryMode:effectiveDeliveryModeV74(oldDb,entry),meetingProvider:String(row.meetingProvider||entry.meetingProvider||onlineSettingsV74.defaultProvider||"custom").slice(0,60),meetingUrl:normalizeWebUrlV74(meetingUrl||""),subject:entry.subject,teacherId:entry.teacherId,classId:entry.classId,periodNo:entry.periodNo,shiftId:entry.shiftId,academicYear:String(oldDb.school?.year||"")};
  });
  result.onlineClassSessions=mergeScopedCollection(oldDb.onlineClassSessions,incomingOnlineSessionsV74,canOnlineSessionV74,canOnlineSessionV74);
  result.onlineJoinEvents=oldDb.onlineJoinEvents||[];
  result.announcements=mergeScopedCollection(oldDb.announcements,incoming.announcements,a=>a.createdBy===user.id,a=>a.createdBy===user.id);
  result.interventions=mergeScopedCollection(oldDb.interventions,incoming.interventions,a=>scope.studentIds.has(a.studentId)&&activeTeachingAssignments(oldDb,user,"interventions").length>0,a=>scope.studentIds.has(a.studentId)&&activeTeachingAssignments(oldDb,user,"interventions").length>0);
  const newAudit=(incoming.audit||[]).filter(a=>a.userId===user.id&&!(oldDb.audit||[]).some(old=>old.id===a.id)); result.audit=[...newAudit,...(oldDb.audit||[])].slice(0,5000);
  return normalizeTeachingAssignments(result);
}
function validateAdminState(oldDb, incoming, user) {
  const systemOld = (oldDb.users || []).find(u => u.id === "sys1"); const systemNew = (incoming.users || []).find(u => u.id === "sys1");
  if (user.role === "admin" && JSON.stringify(systemOld) !== JSON.stringify(systemNew)) throw Object.assign(new Error("مدیر مدرسه اجازه تغییر حساب ادمین فنی را ندارد."), { status: 403 });
  if (user.role === "admin" && (incoming.users || []).some(u => u.id !== "sys1" && u.role === "superadmin")) throw Object.assign(new Error("ایجاد ادمین فنی فقط توسط ادمین فنی مجاز است."), { status: 403 });

  incoming.school ||= {};
  incoming.school.year=String(incoming.school.year||oldDb.school?.year||"").trim();
  if(!incoming.school.year) throw Object.assign(new Error("سال تحصیلی فعال باید مشخص باشد."),{status:400});
  incoming.school.academicYears=normalizeAcademicYears(incoming.school);
  incoming.school.grades = SCHOOL_GRADES.map(g => ({ ...g }));
  const classIds = new Set(), classNames = new Set();
  incoming.school.classes = (incoming.school.classes || []).map(raw => {
    const c = { ...raw }, grade = Number(c.grade);
    if (!SCHOOL_GRADES.some(g => g.grade === grade)) throw Object.assign(new Error("پایه کلاس باید هفتم، هشتم یا نهم باشد."), { status: 400 });
    if (!c.id || classIds.has(c.id)) throw Object.assign(new Error("شناسه کلاس خالی یا تکراری است."), { status: 409 });
    if (!String(c.name || "").trim() || classNames.has(String(c.name).trim())) throw Object.assign(new Error("نام کلاس خالی یا تکراری است."), { status: 409 });
    classIds.add(c.id); classNames.add(String(c.name).trim());
    const meta = gradeMeta(grade);
    const enrolled=(incoming.users||[]).filter(u=>u.role==="student"&&u.classId===c.id&&u.active!==false).length;
    const capacity=Number(c.capacity??30);
    if(!Number.isInteger(capacity)||capacity<Math.max(1,enrolled)||capacity>200) throw Object.assign(new Error(`ظرفیت کلاس «${String(c.name||"").trim()}» باید بین ${Math.max(1,enrolled)} تا ۲۰۰ نفر باشد.`),{status:400});
    return { ...c, name: String(c.name).trim(), grade: meta.grade, gradeId: meta.id, gradeName: meta.name, capacity };
  });
  const classes = new Map(incoming.school.classes.map(c => [c.id, c]));

  const bookIds = new Set();
  incoming.curriculum = (incoming.curriculum || []).map(raw => {
    const b = { ...raw }, grade = Number(b.grade);
    if (!SCHOOL_GRADES.some(g => g.grade === grade)) throw Object.assign(new Error(`پایه کتاب «${b.title || b.subject || "بدون عنوان"}» معتبر نیست.`), { status: 400 });
    if (!b.id || bookIds.has(b.id)) throw Object.assign(new Error("شناسه کتاب خالی یا تکراری است."), { status: 409 });
    bookIds.add(b.id);
    const meta = gradeMeta(grade);
    return { ...b, grade: meta.grade, gradeId: meta.id, gradeName: meta.name };
  });
  const books = new Map(incoming.curriculum.map(b => [b.id, b]));

  const nationalIds = new Set();
  incoming.users = (incoming.users || []).map(raw => {
    const next={...raw}; const nationalId=normalizeNationalId(next.nationalId);
    if(!/^\d{10}$/.test(nationalId)) throw Object.assign(new Error(`کد ملی ${next.firstName||"کاربر"} معتبر نیست.`),{status:400});
    if(nationalIds.has(nationalId)) throw Object.assign(new Error("کد ملی تکراری در فهرست کاربران وجود دارد."),{status:409});
    nationalIds.add(nationalId); next.nationalId=nationalId;
    if(next.role==="student"){
      const birthDate=normalizeStoredBirthDate(next.birthDate||next.birthYear),previous=(oldDb.users||[]).find(u=>u.id===next.id);
      if(!birthDate&&!previous)throw Object.assign(new Error(`تاریخ تولد ${next.firstName||"دانش‌آموز"} معتبر نیست.`),{status:400});
      const cls=classes.get(next.classId); if(!cls)throw Object.assign(new Error(`کلاس ${next.firstName||"دانش‌آموز"} معتبر نیست.`),{status:400});
      next.birthDate=birthDate||previous?.birthDate||""; delete next.birthYear; next.username=nationalId;
      next.grade=Number(cls.grade); next.gradeId=cls.gradeId; next.gradeName=cls.gradeName;
    } else if(next.role==="teacher") {
      next.username=nationalId;
    }
    return next;
  });

  {
    const questionIds=new Set(),fingerprints=new Set();
    incoming.questionBank = (incoming.questionBank || []).map(raw => {
      const book=books.get(raw.bookId);
      if(!book)throw Object.assign(new Error("کتاب سؤال بانک سؤال معتبر نیست."),{status:400});
      const q=normalizeQuestionCore(raw,book);
      if(questionIds.has(q.id))throw Object.assign(new Error("شناسه سؤال تکراری است."),{status:409});
      questionIds.add(q.id);
      const errors=validateQuestionCore(q,book);
      if(errors.length)throw Object.assign(new Error(errors.join(" ")),{status:400});
      const fp=questionFingerprintCore(q);
      if(fingerprints.has(fp))throw Object.assign(new Error("سؤال تکراری در بانک سؤال وجود دارد."),{status:409});
      fingerprints.add(fp);
      const meta=gradeMeta(book.grade);
      return {...q,fingerprint:fp,subject:book.subject,grade:meta.grade,gradeId:meta.id,gradeName:meta.name};
    });
  }

  incoming.exams = (incoming.exams || []).map(raw => {
    const e={...raw}, cls=classes.get(e.classId), book=books.get(e.bookId);
    if(!cls)throw Object.assign(new Error("کلاس آزمون معتبر نیست."),{status:400});
    if(!book)throw Object.assign(new Error("کتاب آزمون معتبر نیست."),{status:400});
    if(Number(cls.grade)!==Number(book.grade))throw Object.assign(new Error("پایه کلاس و کتاب آزمون باید یکسان باشد."),{status:400});
    if(e.subject && e.subject!==book.subject)throw Object.assign(new Error("درس آزمون با کتاب انتخاب‌شده سازگار نیست."),{status:400});
    const meta=gradeMeta(cls.grade);
    return {...e,subject:book.subject,grade:meta.grade,gradeId:meta.id,gradeName:meta.name};
  });

  incoming.teachingAssignments = Array.isArray(incoming.teachingAssignments) ? incoming.teachingAssignments : [];
  const teacherIds=new Set(incoming.users.filter(u=>u.role==="teacher"&&u.active!==false&&!["deleted","locked","graduated"].includes(String(u.profileStatus||""))).map(u=>u.id)),composites=new Set();
  incoming.teachingAssignments=incoming.teachingAssignments.map(raw=>{const a={...raw};if(!teacherIds.has(a.teacherId))throw Object.assign(new Error("معلم تخصیص تدریس معتبر نیست."),{status:400});if(!classIds.has(a.classId))throw Object.assign(new Error("کلاس تخصیص تدریس معتبر نیست."),{status:400});const book=books.get(a.bookId);if(!book)throw Object.assign(new Error("کتاب تخصیص تدریس معتبر نیست."),{status:400});const cls=classes.get(a.classId);if(Number(book.grade||0)&&Number(cls?.grade||0)&&Number(book.grade)!==Number(cls.grade))throw Object.assign(new Error("پایه کتاب و کلاس تخصیص تدریس باید یکسان باشد."),{status:400});a.grade=Number(cls?.grade||book.grade||a.grade||0);a.gradeId=gradeMeta(a.grade).id;a.subject=a.subject||book.subject;if(a.subject!==book.subject)throw Object.assign(new Error("درس و کتاب تخصیص تدریس با هم سازگار نیستند."),{status:400});a.permissions=Array.from(new Set((Array.isArray(a.permissions)?a.permissions:[]).filter(p=>TEACHING_PERMISSION_DEFAULTS.includes(p))));if(!a.permissions.length)a.permissions=[...TEACHING_PERMISSION_DEFAULTS];a.academicYear=a.academicYear||incoming.school?.year||"";a.active=a.active!==false;a.history=Array.isArray(a.history)?a.history:[];const key=assignmentCompositeKey(a);if(a.active&&composites.has(key))throw Object.assign(new Error("برای این معلم، کلاس و کتاب یک تخصیص فعال تکراری وجود دارد."),{status:409});if(a.active)composites.add(key);return a;});
  incoming.school.shiftDefinitions=(Array.isArray(incoming.school.shiftDefinitions)&&incoming.school.shiftDefinitions.length?incoming.school.shiftDefinitions:[{id:"morning",name:"شیفت صبح",periods:[]},{id:"afternoon",name:"شیفت بعدازظهر",periods:[]}]).map(raw=>({id:String(raw.id||"").trim(),name:String(raw.name||"").trim(),periods:(Array.isArray(raw.periods)?raw.periods:[]).slice(0,10).map((p,i)=>({no:i+1,start:String(p.start||"").slice(0,5),end:String(p.end||"").slice(0,5)}))})).filter(x=>x.id&&x.name);
  const shiftIdsV73=new Set(incoming.school.shiftDefinitions.map(x=>x.id));if(!shiftIdsV73.size)throw Object.assign(new Error("حداقل یک شیفت مدرسه باید تعریف شود."),{status:400});
  incoming.school.classes=(incoming.school.classes||[]).map(c=>({...c,shiftId:shiftIdsV73.has(c.shiftId)?c.shiftId:incoming.school.shiftDefinitions[0].id}));
  incoming.school.onlineLearning = onlineLearningSettingsV74({school:{onlineLearning:incoming.school.onlineLearning||oldDb.school?.onlineLearning||{}}});
  const assignmentsV73=new Map((incoming.teachingAssignments||[]).filter(a=>a.active!==false).map(a=>[a.id,a])),daysV73=new Set(["شنبه","یکشنبه","دوشنبه","سه‌شنبه","چهارشنبه","پنجشنبه"]),classSlotsV73=new Set(),teacherSlotsV73=new Set(),scheduleIntervalsV77=[];
  const oldScheduleV74=new Map((oldDb.weeklySchedule||[]).map(x=>[x.id,x]));
  const timeMinutesV77=value=>{const m=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value||""));return m?Number(m[1])*60+Number(m[2]):-1;};
  const overlapsV77=(aStart,aEnd,bStart,bEnd)=>aStart<bEnd&&bStart<aEnd;
  incoming.weeklySchedule=(Array.isArray(incoming.weeklySchedule)?incoming.weeklySchedule:[]).map(raw=>{const a=assignmentsV73.get(raw.assignmentId),cls=(incoming.school.classes||[]).find(c=>c.id===raw.classId);if(!a||!cls||a.classId!==raw.classId)throw Object.assign(new Error("تخصیص تدریس برنامه هفتگی معتبر نیست."),{status:400});const day=String(raw.day||"");if(!daysV73.has(day))throw Object.assign(new Error("روز برنامه هفتگی معتبر نیست."),{status:400});const periodNo=Number(raw.periodNo);if(!Number.isInteger(periodNo)||periodNo<1||periodNo>10)throw Object.assign(new Error("شماره زنگ برنامه هفتگی معتبر نیست."),{status:400});const shiftId=shiftIdsV73.has(raw.shiftId)?raw.shiftId:(cls.shiftId||incoming.school.shiftDefinitions[0].id);const shift=incoming.school.shiftDefinitions.find(x=>x.id===shiftId),period=shift?.periods?.[periodNo-1]||{};const startTime=String(raw.startTime||period.start||"").slice(0,5),endTime=String(raw.endTime||period.end||"").slice(0,5),startMin=timeMinutesV77(startTime),endMin=timeMinutesV77(endTime);if(startMin<0||endMin<0||endMin<=startMin)throw Object.assign(new Error(`ساعت برنامه ${day} زنگ ${periodNo} معتبر نیست.`),{status:400});const classKey=`${raw.classId}|${day}|${shiftId}|${periodNo}`,teacherKey=`${a.teacherId}|${day}|${shiftId}|${periodNo}`;if(classSlotsV73.has(classKey))throw Object.assign(new Error("برای یک کلاس در یک زنگ و شیفت، دو درس برنامه‌ریزی شده است."),{status:409});if(teacherSlotsV73.has(teacherKey))throw Object.assign(new Error("یک معلم در یک زنگ و شیفت به دو کلاس تخصیص داده شده است."),{status:409});for(const prior of scheduleIntervalsV77){if(prior.day!==day||!overlapsV77(startMin,endMin,prior.startMin,prior.endMin))continue;if(prior.classId===raw.classId)throw Object.assign(new Error(`زمان دو درس کلاس ${cls.name||raw.classId} در ${day} با هم تداخل دارد.`),{status:409});if(prior.teacherId===a.teacherId)throw Object.assign(new Error(`برنامه دبیر در ${day} با کلاس دیگری تداخل زمانی دارد.`),{status:409});}classSlotsV73.add(classKey);teacherSlotsV73.add(teacherKey);scheduleIntervalsV77.push({classId:raw.classId,teacherId:a.teacherId,day,startMin,endMin});const old=oldScheduleV74.get(raw.id)||{};const deliveryMode=normalizeDeliveryModeV74(raw.deliveryMode??old.deliveryMode,"inherit"),meetingUrl=normalizeWebUrlV74(raw.meetingUrl??old.meetingUrl??""),meetingProvider=String(raw.meetingProvider??old.meetingProvider??"").trim().slice(0,60),onlineInstructions=String(raw.onlineInstructions??old.onlineInstructions??"").trim().slice(0,1500);return {id:raw.id||makeId("wsch"),classId:raw.classId,academicYear:String(raw.academicYear||incoming.school.year||""),day,shiftId,periodNo,assignmentId:a.id,teacherId:a.teacherId,subject:a.subject,bookId:a.bookId||"",startTime,endTime,room:String(raw.room||"").trim(),deliveryMode,meetingProvider,meetingUrl,onlineInstructions,active:raw.active!==false,updatedAt:raw.updatedAt||faNow(),updatedBy:raw.updatedBy||user.id};});
  const scheduleIdsV73=new Set(incoming.weeklySchedule.map(x=>x.id));
  incoming.attendanceSessions=(Array.isArray(incoming.attendanceSessions)?incoming.attendanceSessions:[]).map(row=>{if(row.scheduleEntryId&&!scheduleIdsV73.has(row.scheduleEntryId))throw Object.assign(new Error("جلسه حضور و غیاب به برنامه هفتگی نامعتبر متصل است."),{status:400});return row;});
  const oldAttendanceByIdV81=new Map((oldDb.attendance||[]).map(x=>[x.id,x]));
  incoming.attendance=(Array.isArray(incoming.attendance)?incoming.attendance:[]).map(raw=>{const row={...raw,status:normalizeAttendanceStatusV81(raw.status)},old=oldAttendanceByIdV81.get(raw.id),oldStatus=old?normalizeAttendanceStatusV81(old.status):"";if(row.status==="absent_excused"&&row.status!==oldStatus&&!String(row.absenceReasonText||row.note||"").trim())throw Object.assign(new Error("برای ثبت غیبت موجه، علت غیبت الزامی است."),{status:400});if(["absent_excused","absent_unexcused"].includes(row.status)&&row.status!==oldStatus){const now=new Date().toISOString(),reasonText=String(row.absenceReasonText||row.note||(row.status==="absent_unexcused"?"دلیل موجه تأیید نشد":"")).trim().slice(0,300);row.reviewHistory=Array.isArray(old?.reviewHistory)?[...old.reviewHistory]:[];row.reviewHistory.push({from:oldStatus||"absent_pending",to:row.status,reasonId:String(row.absenceReasonId||""),reasonText,note:String(row.reviewNote||row.note||"").trim().slice(0,500),by:user.id,at:now});row.absenceReasonText=reasonText;row.reviewedBy=user.id;row.reviewedAt=now;}return row;});
  const scheduleMapV74=new Map(incoming.weeklySchedule.map(x=>[x.id,x]));
  incoming.onlineClassSessions=(Array.isArray(incoming.onlineClassSessions)?incoming.onlineClassSessions:[]).map(raw=>{const entry=scheduleMapV74.get(raw.scheduleEntryId);if(!entry)throw Object.assign(new Error("جلسه آنلاین به زنگ برنامه هفتگی نامعتبر متصل است."),{status:400});const status=["scheduled","live","ended","cancelled"].includes(String(raw.status))?String(raw.status):"scheduled",deliveryMode=normalizeDeliveryModeV74(raw.deliveryMode,effectiveDeliveryModeV74({school:incoming.school},entry));if(!["online","hybrid"].includes(deliveryMode))throw Object.assign(new Error("جلسه آنلاین باید حالت آنلاین یا ترکیبی داشته باشد."),{status:400});return {...raw,id:raw.id||makeId("ols"),scheduleEntryId:entry.id,classId:entry.classId,subject:entry.subject,teacherId:entry.teacherId,date:String(raw.date||"").slice(0,10),periodNo:entry.periodNo,shiftId:entry.shiftId,academicYear:String(raw.academicYear||incoming.school.year||""),deliveryMode,meetingProvider:String(raw.meetingProvider||entry.meetingProvider||incoming.school.onlineLearning.defaultProvider||"custom").slice(0,60),meetingUrl:normalizeWebUrlV74(raw.meetingUrl||entry.meetingUrl||incoming.school.onlineLearning.defaultMeetingUrl||""),title:String(raw.title||entry.subject||"").slice(0,200),status,notes:String(raw.notes||"").slice(0,1500)};});
  incoming.onlineJoinEvents=oldDb.onlineJoinEvents||[];
  incoming.continuousGradeOverrides=(Array.isArray(incoming.continuousGradeOverrides)?incoming.continuousGradeOverrides:[]).map(row=>{const st=(incoming.users||[]).find(x=>x.id===row.studentId&&x.role==="student");if(!st||st.classId!==row.classId||!classIds.has(row.classId))throw Object.assign(new Error("دانش‌آموز نمره مستمر معتبر نیست."),{status:400});const score=Number(row.finalScore);if(!Number.isFinite(score)||score<0||score>20)throw Object.assign(new Error("نمره نهایی مستمر باید بین صفر تا ۲۰ باشد."),{status:400});return {...row,finalScore:Math.round(score*100)/100,academicYear:String(row.academicYear||incoming.school.year||""),academicPeriod:["semester1","semester2"].includes(String(row.academicPeriod||row.period))?String(row.academicPeriod||row.period):"semester2",history:Array.isArray(row.history)?row.history:[]};});
  incoming.school.settings ||= {};
  {
    const oldPolicy = gradingPolicyV200(oldDb), raw = incoming.school.settings.gradingPolicy || {};
    const mode = raw.mode === "weighted" ? "weighted" : "additive";
    let continuousWeight = Number(raw.continuousWeight), finalWeight = Number(raw.finalWeight);
    if (!Number.isFinite(continuousWeight) || continuousWeight < 0 || continuousWeight > 100) continuousWeight = 40;
    if (!Number.isFinite(finalWeight) || finalWeight < 0 || finalWeight > 100) finalWeight = 60;
    if (mode === "weighted" && Math.abs(continuousWeight + finalWeight - 100) > 0.001) throw Object.assign(new Error("در فرمول وزنی، مجموع وزن مستمر و آزمون پایانی باید ۱۰۰ باشد."), {status:400});
    incoming.school.settings.gradingPolicy = {mode, continuousWeight, finalWeight};
    const changed = oldPolicy.mode !== mode || Number(oldPolicy.continuousWeight) !== continuousWeight || Number(oldPolicy.finalWeight) !== finalWeight;
    incoming.gradingPolicyHistory = Array.isArray(oldDb.gradingPolicyHistory) ? [...oldDb.gradingPolicyHistory] : [];
    if (changed) incoming.gradingPolicyHistory.unshift({id:makeId("gph"),academicYear:String(incoming.school?.year||oldDb.school?.year||""),previous:{mode:oldPolicy.mode,continuousWeight:oldPolicy.continuousWeight,finalWeight:oldPolicy.finalWeight},next:{mode,continuousWeight,finalWeight},changedBy:user.id,changedAt:new Date().toISOString()});
    incoming.gradingPolicyHistory = incoming.gradingPolicyHistory.slice(0,200);
  }
  incoming.enrollments=normalizeEnrollments(incoming);
  incoming.exams=(incoming.exams||[]).map(raw=>{
    const cls=(incoming.school?.classes||[]).find(c=>c.id===raw.classId),book=(incoming.curriculum||[]).find(b=>b.id===raw.bookId);
    const checkExam=normalizeExamCore(raw,cls,book),errors=validateExamCore(checkExam,{cls,book,questionBank:incoming.questionBank||[]});
    if((checkExam.examCategory||"ongoing")==="final"){
      const period=normalizeAcademicPeriod(checkExam.academicPeriod||checkExam.period,{allowAnnual:false}),year=String(checkExam.academicYear||incoming.school?.year||"");
      const explicitPolicy=(incoming.termPolicies||[]).find(p=>p.classId===checkExam.classId&&p.subject===(checkExam.subject||book?.subject)&&String(p.academicYear||"")===year&&String(p.academicPeriod||"semester2")===period);
      if(explicitPolicy){const policy=normalizeTermPolicyCore(explicitPolicy,Number(incoming.school?.settings?.scoreScale||20));if(Math.abs(Number(checkExam.targetScore||0)-Number(policy.finalShare))>.001)errors.push(`بارم آزمون پایانی این دوره باید دقیقاً ${policy.finalShare} نمره باشد؛ سهم مستمر ${policy.continuousShare} نمره است.`);}
    }
    if(errors.length)throw Object.assign(new Error(errors.join(" ")),{status:400});
    return checkExam;
  }).map(e=>{
    const cls=(incoming.school?.classes||[]).find(c=>c.id===e.classId),book=(incoming.curriculum||[]).find(b=>b.id===e.bookId);
    return normalizeExamCore(e,cls,book);
  });
  // P66: Validate independent admin question bank before the staff state is committed.
  const p66SeenIds=new Set(),p66SeenContent=new Set();
  const p66Books=new Map((incoming.curriculum||[]).map(b=>[String(b.id),b]));
  if(!Array.isArray(incoming.adminQuestionBank))incoming.adminQuestionBank=Array.isArray(oldDb.adminQuestionBank)?structuredClone(oldDb.adminQuestionBank):[];
  if(incoming.adminQuestionBank.length>100000)throw Object.assign(new Error("تعداد سؤالات مخزن ادمین بیش از حد مجاز است."),{status:400});
  incoming.adminQuestionBank=incoming.adminQuestionBank.map(raw=>{
    const q={...raw},book=p66Books.get(String(q.bookId)),ch=(book?.chapters||[]).find(c=>String(c.id)===String(q.chapterId));
    if(!q.id||p66SeenIds.has(String(q.id)))throw Object.assign(new Error("شناسه سؤال در مخزن ادمین نامعتبر یا تکراری است."),{status:409});
    if(!book||!ch)throw Object.assign(new Error("کتاب یا فصل سؤال مخزن ادمین معتبر نیست."),{status:400});
    if(typeof q.text!=="string"||q.text.trim().length<5||q.text.length>10000)throw Object.assign(new Error("متن سؤال مخزن ادمین نامعتبر است."),{status:400});
    if(!["mcq","descriptive","truefalse","fillblank","short","image"].includes(q.type))throw Object.assign(new Error("نوع سؤال مخزن ادمین نامعتبر است."),{status:400});
    if(!["easy","medium","advanced"].includes(q.difficulty)||!["draft","needs_review","approved","retired"].includes(q.status))throw Object.assign(new Error("وضعیت یا سختی سؤال مخزن ادمین نامعتبر است."),{status:400});
    if(!Number.isFinite(Number(q.score))||Number(q.score)<=0||Number(q.score)>100)throw Object.assign(new Error("نمره سؤال مخزن ادمین نامعتبر است."),{status:400});
    const key=[book.id,ch.id,q.text.replace(/\s+/g," ").trim().toLowerCase()].join("|");
    if(p66SeenContent.has(key))throw Object.assign(new Error("سؤال تکراری در مخزن مستقل ادمین وجود دارد."),{status:409});
    p66SeenIds.add(String(q.id));p66SeenContent.add(key);
    return {...q,subject:book.subject,grade:Number(book.grade),chapter:ch.title,bookId:book.id,chapterId:ch.id};
  });
  distributeScheduleChangesV79(oldDb,incoming,user.id);
  return normalizeTeachingAssignments(incoming);
}

function normalizeAttendanceStatusV81(value){
  const s=String(value||"");
  if(s==="absent")return "absent_pending";
  if(s==="excused")return "absent_excused";
  return ["present","late","absent_pending","absent_excused","absent_unexcused"].includes(s)?s:"present";
}
function isAbsentStatusV81(value){return ["absent_pending","absent_excused","absent_unexcused","absent","excused"].includes(String(value||""));}
function attendanceSummaryForStudent(db, studentId) {
  const activeYear=String(db.school?.year||"");
  const records=(db.attendance||[]).filter(a=>a.studentId===studentId&&(!a.academicYear||String(a.academicYear)===activeYear));
  const summary={present:0,absent:0,pending:0,excused:0,unexcused:0,late:0,total:0,recent:[]};
  for(const item of records){
    if(!item.sessionId&&["present","absent","late"].some(k=>Number(item[k]||0)>0)){summary.present+=Number(item.present||0);summary.absent+=Number(item.absent||0);summary.pending+=Number(item.absent||0);summary.late+=Number(item.late||0);continue;}
    const status=normalizeAttendanceStatusV81(item.status);
    if(status==="present")summary.present+=1;else if(status==="late")summary.late+=1;else{summary.absent+=1;if(status==="absent_excused")summary.excused+=1;else if(status==="absent_unexcused")summary.unexcused+=1;else summary.pending+=1;}
    summary.total+=1;
  }
  summary.total=Math.max(summary.total,summary.present+summary.absent+summary.late);
  summary.recent=records.filter(x=>x.sessionId).slice().sort((a,b)=>String(b.date||b.at||"").localeCompare(String(a.date||a.at||""))).slice(0,20).map(x=>({...x,status:normalizeAttendanceStatusV81(x.status)}));
  return summary;
}


// ===== 72.33-p1: Guardian absence-review workflow + period timeline =====
function validSchoolDateV80(value){
  const raw=String(value||"").trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return "";
  const d=new Date(`${raw}T12:00:00Z`);
  return Number.isNaN(d.getTime())?"":raw;
}
function schoolIsoTimeV80(value){
  if(!value)return "";
  try{
    const d=new Date(value);if(Number.isNaN(d.getTime()))return "";
    return new Intl.DateTimeFormat("fa-IR",{timeZone:schoolClockV74().timeZone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(d);
  }catch{return "";}
}
function attendanceRowStateV80(date,startTime,endTime){
  const clock=schoolClockV74();
  if(date<clock.date)return "ended";
  if(date>clock.date)return "upcoming";
  const start=hmMinutesV74(startTime),end=hmMinutesV74(endTime);
  if(start===null||end===null)return "unknown";
  if(clock.minutes<start)return "upcoming";
  if(clock.minutes<=end)return "current";
  return "ended";
}
function guardianAttendanceDayV80(db,student,requestedDate=""){
  const clock=schoolClockV74(),date=validSchoolDateV80(requestedDate)||clock.date,activeYear=String(db.school?.year||""),dayName=schoolDayNameForDateV78(date),users=new Map((db.users||[]).map(u=>[u.id,u]));
  const schedule=(db.weeklySchedule||[]).filter(x=>x.active!==false&&x.classId===student.classId&&String(x.academicYear||activeYear)===activeYear&&x.day===dayName).slice().sort((a,b)=>(hmMinutesV74(a.startTime)??9999)-(hmMinutesV74(b.startTime)??9999)||Number(a.periodNo||0)-Number(b.periodNo||0));
  const sessions=(db.attendanceSessions||[]).filter(x=>x.date===date&&String(x.academicYear||activeYear)===activeYear),sessionById=new Map(sessions.map(x=>[x.id,x]));
  const records=(db.attendance||[]).filter(x=>x.studentId===student.id&&x.date===date&&String(x.academicYear||activeYear)===activeYear);
  const joins=(db.onlineJoinEvents||[]).filter(x=>x.studentId===student.id&&x.date===date&&String(x.academicYear||activeYear)===activeYear);
  const entriesById=new Map((db.weeklySchedule||[]).map(x=>[x.id,x]));
  const rows=new Map();
  const makeRow=(entry={},session=null)=>{
    const teacherId=String(session?.teacherId||entry.teacherId||""),teacher=users.get(teacherId),classId=String(session?.classId||entry.classId||student.classId||""),cls=classInfoV78(db,classId),online=entry?.id?publicOnlineScheduleEntryV74(db,entry):null;
    return {scheduleEntryId:String(session?.scheduleEntryId||entry.id||""),sessionId:session?.id||"",classId,className:cls.name,grade:cls.grade,gradeName:cls.gradeName,subject:String(session?.subject||entry.subject||""),teacherId,teacherName:teacher?`${teacher.firstName||""} ${teacher.lastName||""}`.trim():"",periodNo:Number(session?.periodNo||entry.periodNo||0),shiftId:String(session?.shiftId||entry.shiftId||""),startTime:String(session?.startTime||entry.startTime||""),endTime:String(session?.endTime||entry.endTime||""),deliveryMode:online?.effectiveMode||effectiveDeliveryModeV74(db,entry),status:"unmarked",markedAt:"",markedAtTime:"",onlineCheckInAt:"",onlineCheckInTime:"",punctuality:"",state:attendanceRowStateV80(date,session?.startTime||entry.startTime,session?.endTime||entry.endTime),source:session?"attendance":"schedule"};
  };
  for(const entry of schedule){
    const session=sessions.filter(x=>x.scheduleEntryId===entry.id&&x.classId===entry.classId).sort((a,b)=>String(b.updatedAt||b.createdAt||"").localeCompare(String(a.updatedAt||a.createdAt||"")))[0]||null;
    const key=entry.id||`schedule:${entry.periodNo}:${entry.startTime}`;rows.set(key,makeRow(entry,session));
  }
  for(const record of records){
    const session=sessionById.get(record.sessionId)||null,entry=entriesById.get(record.scheduleEntryId||session?.scheduleEntryId)||{};
    const key=String(record.scheduleEntryId||session?.scheduleEntryId||entry.id||`record:${record.id}`);
    const row=rows.get(key)||makeRow(entry,session);
    row.status=normalizeAttendanceStatusV81(record.status);row.absenceReasonId=String(record.absenceReasonId||"");row.absenceReasonText=String(record.absenceReasonText||"");row.reviewNote=String(record.reviewNote||"");row.reviewedAt=String(record.reviewedAt||"");
    row.markedAt=record.updatedAt||record.markedAt||session?.updatedAt||session?.createdAt||"";row.markedAtTime=schoolIsoTimeV80(row.markedAt);row.sessionId=record.sessionId||session?.id||row.sessionId;row.source="attendance";rows.set(key,row);
  }
  for(const join of joins){
    const key=String(join.scheduleEntryId||"");if(!key)continue;
    const entry=entriesById.get(key)||{},session=sessions.find(x=>x.scheduleEntryId===key)||null,row=rows.get(key)||makeRow(entry,session);
    row.onlineCheckInAt=join.firstJoinAt||join.lastJoinAt||"";row.onlineCheckInTime=schoolIsoTimeV80(row.onlineCheckInAt);row.punctuality=String(join.punctuality||"");rows.set(key,row);
  }
  const list=[...rows.values()].sort((a,b)=>(hmMinutesV74(a.startTime)??9999)-(hmMinutesV74(b.startTime)??9999)||a.periodNo-b.periodNo);
  const summary={scheduled:list.length,present:list.filter(x=>x.status==="present").length,absent:list.filter(x=>isAbsentStatusV81(x.status)).length,pending:list.filter(x=>x.status==="absent_pending").length,excused:list.filter(x=>x.status==="absent_excused").length,unexcused:list.filter(x=>x.status==="absent_unexcused").length,late:list.filter(x=>x.status==="late").length,unmarked:list.filter(x=>x.status==="unmarked").length};
  const presence=list.filter(x=>["present","late"].includes(x.status)&&hmMinutesV74(x.startTime)!==null&&hmMinutesV74(x.endTime)!==null);
  const first=presence.slice().sort((a,b)=>hmMinutesV74(a.startTime)-hmMinutesV74(b.startTime))[0]||null,last=presence.slice().sort((a,b)=>hmMinutesV74(b.endTime)-hmMinutesV74(a.endTime))[0]||null;
  const blocked=classAttendanceBlockV78(db,student.classId,date);
  return {date,dateFa:faDateV78(date),dayName,timeZone:clock.timeZone,isToday:date===clock.date,studentId:student.id,classId:student.classId,className:classInfoV78(db,student.classId).name,summary,firstPresentAt:first?.startTime||"",lastPresentUntil:last?.endTime||"",blockedReason:blocked?String(blocked.title||"تعطیلی آموزشی"):"",rows:list};
}

function visibleAnnouncementsForStudent(db, student) {
  const now = Date.now();
  return (db.announcements || []).filter(a => {
    if (a.status === "archived") return false;
    if (a.publishAt && new Date(a.publishAt).getTime() > now) return false;
    if (a.expiresAt && new Date(a.expiresAt).getTime() < now) return false;
    return a.audience === "all" || (a.audience === "class" && a.classId === student.classId) || (a.audience === "student" && a.studentId === student.id);
  }).slice().sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||""))).slice(0,30);
}


function systemIntegrityReport(db) {
  const users = db.users || [], exams = db.exams || [], submissions = db.submissions || [], grades = db.grades || [];
  const userIds = new Set(users.map(x => x.id)); const examIds = new Set(exams.map(x => x.id)); const submissionIds = new Set(submissions.map(x => x.id));
  const classIds = new Set((db.school?.classes || []).map(x => x.id)); const homeworkIds = new Set((db.homework || []).map(x => x.id));
  const nationalMap = new Map();
  for (const u of users.filter(x => x.role === "student")) { const n = normalizeNationalId(u.nationalId); if (n) nationalMap.set(n, (nationalMap.get(n) || 0) + 1); }
  const guardianIds = new Set((db.guardians || []).map(x=>x.id));
  const attendanceSessionIds = new Set((db.attendanceSessions || []).map(x=>x.id));
  const checks = {
    duplicateNationalIds: [...nationalMap.values()].filter(x => x > 1).length,
    missingBirthDates: users.filter(x => x.role === "student" && !normalizeStoredBirthDate(x.birthDate || x.birthYear)).length,
    invalidClassUsers: users.filter(x => x.role === "student" && !classIds.has(x.classId)).length,
    orphanAttempts: (db.attempts || []).filter(x => !userIds.has(x.studentId) || !examIds.has(x.examId)).length,
    orphanSubmissions: submissions.filter(x => !userIds.has(x.studentId) || !examIds.has(x.examId)).length,
    orphanGrades: grades.filter(x => !submissionIds.has(x.submissionId)).length,
    orphanAppeals: (db.appeals || []).filter(x => !userIds.has(x.studentId) || !examIds.has(x.examId)).length,
    orphanAttendance: (db.attendance || []).filter(x => !userIds.has(x.studentId) || (x.sessionId && !attendanceSessionIds.has(x.sessionId))).length,
    orphanHomeworkSubmissions: (db.homeworkSubmissions || []).filter(x => !userIds.has(x.studentId) || !homeworkIds.has(x.homeworkId)).length,
    orphanTermGrades: (db.termGrades || []).filter(x => !userIds.has(x.studentId) || (x.classId && !classIds.has(x.classId))).length,
    orphanContinuousAssessments: (db.continuousAssessments || []).filter(x => !userIds.has(x.studentId)).length,
    orphanContinuousGradeOverrides:(db.continuousGradeOverrides||[]).filter(x=>!userIds.has(x.studentId)||!classIds.has(x.classId)).length,
    brokenWeeklySchedule:(db.weeklySchedule||[]).filter(x=>!classIds.has(x.classId)||!(db.teachingAssignments||[]).some(a=>a.id===x.assignmentId&&a.active!==false&&a.classId===x.classId)).length,
    orphanOnlineSessions:(db.onlineClassSessions||[]).filter(x=>!(db.weeklySchedule||[]).some(e=>e.id===x.scheduleEntryId&&e.classId===x.classId)).length,
    orphanOnlineJoinEvents:(db.onlineJoinEvents||[]).filter(x=>!userIds.has(x.studentId)||!classIds.has(x.classId)||(x.scheduleEntryId&&!(db.weeklySchedule||[]).some(e=>e.id===x.scheduleEntryId))).length,
    orphanBehaviorRecords: (db.behaviorRecords || []).filter(x => x.studentId && !userIds.has(x.studentId)).length,
    orphanInterventions: (db.interventions || []).filter(x => x.studentId && !userIds.has(x.studentId)).length,
    orphanProgressReports: (db.progressReports || []).filter(x => x.studentId && !userIds.has(x.studentId)).length,
    orphanGuardianLinks: (db.guardianLinks || []).filter(x => !userIds.has(x.studentId) || (x.guardianId && !guardianIds.has(x.guardianId))).length,
    brokenTeachingAssignments:(db.teachingAssignments||[]).filter(x=>{const t=users.find(u=>u.id===x.teacherId);return !t||t.role!=="teacher"||t.active===false||["deleted","locked","graduated"].includes(String(t.profileStatus||""))||!classIds.has(x.classId);}).length,
    orphanEnrollments:(db.enrollments||[]).filter(x=>!userIds.has(x.studentId)||!classIds.has(x.classId)).length,
    activeEnrollmentMismatch:users.filter(u=>u.role==="student"&&u.active!==false&&u.profileStatus!=="deleted").filter(u=>{const y=String(db.school?.year||"");const rows=(db.enrollments||[]).filter(e=>e.studentId===u.id&&String(e.academicYear||"")===y&&e.active!==false);return rows.length!==1||String(rows[0]?.classId||"")!==String(u.classId||"");}).length,
    invalidCalendarEvents:(db.calendarEvents||[]).filter(x=>{const e=normalizeCalendarEvent(x,db.school?.year||"");return !e.startDate||(e.endDate&&e.endDate<e.startDate)||(e.scope==="class"&&!classIds.has(e.classId))||(e.scope==="grade"&&![7,8,9].includes(Number(e.grade)));}).length,
    openAppeals: (db.appeals || []).filter(x => ["open", "reviewing"].includes(x.status)).length,
    pendingGrades: submissions.filter(x => !grades.some(g => g.submissionId === x.id)).length
  };
  const issueCount = Object.entries(checks).filter(([k]) => !["openAppeals", "pendingGrades"].includes(k)).reduce((n,[,v]) => n + Number(v || 0), 0);
  return { ok: issueCount === 0, issueCount, checks };
}
async function folderStats(dir) {
  let count = 0, size = 0;
  try { for (const name of await fs.readdir(dir)) { const p = path.join(dir, name); const st = await fs.stat(p); if (st.isDirectory()) { const child = await folderStats(p); count += child.count; size += child.size; } else { count++; size += st.size; } } } catch {}
  return { count, size };
}
function repairServerDb(db, actorId) {
  db = upgradeServerDbRespectingReset(db); const actions = [];
  const userIds = new Set((db.users || []).map(x => x.id)); const examIds = new Set((db.exams || []).map(x => x.id));
  const classIds = new Set((db.school?.classes || []).map(x=>x.id));
  const keep = (key, predicate, label) => { const before = (db[key] || []).length; db[key] = (db[key] || []).filter(predicate); const removed = before - db[key].length; if (removed) actions.push(`${label}: ${removed}`); };
  const scheduleIdsV74 = new Set((db.weeklySchedule || []).map(x=>x.id));
  keep("onlineClassSessions", x => scheduleIdsV74.has(x.scheduleEntryId) && classIds.has(x.classId), "جلسه آنلاین یتیم");
  keep("onlineJoinEvents", x => userIds.has(x.studentId) && classIds.has(x.classId) && (!x.scheduleEntryId || scheduleIdsV74.has(x.scheduleEntryId)), "ورود آنلاین یتیم");
  keep("attempts", x => userIds.has(x.studentId) && examIds.has(x.examId), "پاسخ تستی یتیم حذف شد");
  keep("submissions", x => userIds.has(x.studentId) && examIds.has(x.examId), "برگه یتیم حذف شد");
  const submissionIds = new Set((db.submissions || []).map(x => x.id));
  keep("grades", x => submissionIds.has(x.submissionId), "نمره بدون برگه حذف شد");
  keep("appeals", x => userIds.has(x.studentId) && examIds.has(x.examId), "اعتراض یتیم حذف شد");
  const attendanceSessionIds = new Set((db.attendanceSessions || []).map(x=>x.id));
  keep("attendance", x => userIds.has(x.studentId) && (!x.sessionId || attendanceSessionIds.has(x.sessionId)), "حضور یتیم حذف شد");
  const homeworkIds = new Set((db.homework || []).map(x => x.id));
  keep("homeworkSubmissions", x => userIds.has(x.studentId) && homeworkIds.has(x.homeworkId), "تحویل تکلیف یتیم حذف شد");
  keep("termGrades", x => userIds.has(x.studentId) && (!x.classId || classIds.has(x.classId)), "نمره مستمر یتیم حذف شد");
  keep("continuousAssessments", x => userIds.has(x.studentId), "ارزشیابی مستمر یتیم حذف شد");
  keep("continuousGradeOverrides",x=>userIds.has(x.studentId)&&classIds.has(x.classId),"تنظیم نمره مستمر یتیم حذف شد");
  const assignmentIdsV73=new Set((db.teachingAssignments||[]).filter(a=>a.active!==false).map(a=>a.id));
  keep("weeklySchedule",x=>classIds.has(x.classId)&&assignmentIdsV73.has(x.assignmentId),"برنامه هفتگی نامعتبر حذف شد");
  keep("behaviorRecords", x => !x.studentId || userIds.has(x.studentId), "رکورد رفتاری یتیم حذف شد");
  keep("interventions", x => !x.studentId || userIds.has(x.studentId), "پیگیری آموزشی یتیم حذف شد");
  keep("progressReports", x => !x.studentId || userIds.has(x.studentId), "گزارش پیشرفت یتیم حذف شد");
  const guardianIds = new Set((db.guardians || []).map(x=>x.id));
  keep("guardianLinks", x => userIds.has(x.studentId) && (!x.guardianId || guardianIds.has(x.guardianId)), "اتصال ولی یتیم حذف شد");
  const activeTeacherIds=new Set((db.users||[]).filter(u=>u.role==="teacher"&&u.active!==false&&!["deleted","locked","graduated"].includes(String(u.profileStatus||""))).map(u=>u.id));
  keep("teachingAssignments",x=>activeTeacherIds.has(x.teacherId)&&classIds.has(x.classId),"تخصیص تدریس نامعتبر حذف شد");
  keep("notifications", x => !x.userId || userIds.has(x.userId), "اعلان بدون کاربر حذف شد");
  db.appeals = (db.appeals || []).map(a => ({ ...a, history: Array.isArray(a.history) && a.history.length ? a.history : [{ status: a.status || "open", note: "بازسازی تاریخچه", at: a.at || faNow(), by: a.studentId || null }] }));
  db.audit = Array.isArray(db.audit) ? db.audit.slice(0, Math.max(100, Number(db.systemPolicies?.maxAuditRows || 20000))) : [];
  db.audit.unshift({ id: makeId("log"), userId: actorId, action: "تعمیر ایمن ساختار اطلاعات", details: actions.length ? actions.join("؛ ") : "ساختار سالم بود؛ فقط نرمال‌سازی انجام شد", at: faNow() });
  return { db, actions };
}
function resetOperationalDataKeepingCurrentSuperadmin(db,actorId){
  const actor=(db.users||[]).find(u=>u.id===actorId&&u.role==="superadmin"&&u.active!==false&&String(u.profileStatus||"active")!=="deleted");
  if(!actor)throw Object.assign(new Error("حساب ادمین فنی جاری برای بازنشانی پیدا نشد."),{status:409});

  // Factory-style live-data reset: preserve only technical configuration needed
  // for the application to boot, plus the currently authenticated Superadmin.
  // All educational/operational arrays are cleared, including curriculum data.
  const next=JSON.parse(JSON.stringify(db));
  const technicalArrays=new Set(["migrationHistory","accessProfiles"]);
  for(const [key,value] of Object.entries(next)){
    if(Array.isArray(value)&&!technicalArrays.has(key))next[key]=[];
  }
  next.users=[{...actor,role:"superadmin",active:true,profileStatus:"active"}];
  next.guardians=[];
  next.guardianLinks=[];
  next.teachingAssignments=[];
  next.curriculum=[];
  next.chapterProgress=[];
  next.learningPoints=[];
  next.questionBank=[];
  next.questionVersions=[];
  next.questionCollections=[];
  next.examBlueprints=[];

  // Keep school/system configuration, but clear nested operational school data.
  next.school={...(db.school||{})};
  next.school.classes=[];
  next.school.academicYears=[];
  if(next.school.uiBranding&&typeof next.school.uiBranding==="object"){
    next.school.uiBranding={...next.school.uiBranding,history:[]};
  }

  next.version=APP_VERSION;
  next.securityVersion=APP_VERSION;
  next.resetState={mode:"superadmin-only",preserveEmptyOperationalData:true,resetAt:new Date().toISOString(),resetBy:actorId};
  next.releaseInfo={...(db.releaseInfo||{}),version:APP_VERSION,release:APP_RELEASE,schemaVersion:69,channel:RELEASE_CHANNEL,releasedAt:new Date().toISOString()};
  next.audit=[{id:makeId("log"),userId:actorId,action:"بازنشانی کامل و حفظ ادمین فنی جاری",details:"همه کاربران به‌جز ادمین فنی اجراکننده، داده‌های آموزشی و عملیاتی و فایل‌ها پاک شدند؛ فقط تنظیمات فنی/مدرسه لازم برای اجرای سامانه حفظ شد.",at:faNow()}];
  return next;
}
async function handleAdminResetData(req,res,auth){
  if(auth.user.role!=="superadmin")throw Object.assign(new Error("بازنشانی کامل فقط برای ادمین فنی مجاز است."),{status:403});
  if(req.method!=="POST")throw Object.assign(new Error("روش درخواست پشتیبانی نمی‌شود."),{status:405});
  const body=await readJson(req);if(String(body.confirmation||"")!=="RESET")throw Object.assign(new Error("عبارت تأیید RESET صحیح نیست."),{status:400});
  const credential=auth.security.credentials?.[auth.user.id];if(!credential||!await passwordVerify(String(body.currentPassword||""),credential.passwordHash))throw Object.assign(new Error("رمز فعلی ادمین صحیح نیست."),{status:401});
  const saved=await enqueueStateOperation(async()=>{await createStateSnapshot("before-full-reset");const current=await ensureStateInitialized();return writeStateEnvelope(resetOperationalDataKeepingCurrentSuperadmin(current.db,auth.user.id),{skipSnapshot:true});});
  await fs.rm(FILES_DIR,{recursive:true,force:true});await fs.mkdir(FILES_DIR,{recursive:true,mode:0o700});
  loginAttempts.clear();
  await fs.rm(LOGIN_ATTEMPTS_FILE,{force:true}).catch(()=>{});
  await ensureSecurityInitialized(saved.db);
  await mutateSecurity(sec=>{
    for(const userId of Object.keys(sec.credentials||{}))if(userId!==auth.user.id)delete sec.credentials[userId];
    for(const [hash,session] of Object.entries(sec.sessions||{}))if(session.userId!==auth.user.id||hash!==auth.tokenHash)delete sec.sessions[hash];
    sec.guardianCredentials={};
    sec.examGrants={};
  });
  await securityAudit({type:"full_data_reset",userId:auth.user.id,role:auth.user.role,success:true,ip:clientIp(req),details:"full reset completed; only current superadmin preserved"});
  return sendJson(res,200,{ok:true,updatedAt:saved.updatedAt,integrity:systemIntegrityReport(saved.db)});
}

async function systemHealthSnapshot(db) {
  const files=await folderStats(FILES_DIR),backups=await listStateSnapshots(),security=await readSecurity();let stateSize=0,disk=null;try{stateSize=(await fs.stat(STATE_FILE)).size;}catch{}try{const st=await fs.statfs(ROOT);disk={totalBytes:Number(st.blocks)*Number(st.bsize),freeBytes:Number(st.bavail)*Number(st.bsize)};}catch{}
  const users=db.users||[],events=await readSecurityAudit(20),recoveryEvents=await readRecoveryLog(10);let previousStateAvailable=false,stateMirrorAvailable=false,securityMirrorAvailable=false;try{previousStateAvailable=Boolean((await fs.stat(STATE_PREVIOUS_FILE)).isFile());}catch{}try{stateMirrorAvailable=Boolean((await fs.stat(STATE_MIRROR_FILE)).isFile());}catch{}try{securityMirrorAvailable=Boolean((await fs.stat(SECURITY_MIRROR_FILE)).isFile());}catch{}
  return {version:APP_VERSION,release:APP_RELEASE,uptimeSeconds:Math.round(process.uptime()),stateSize,files,disk,backupCount:backups.length,lastBackup:backups[0]||null,lastDailyBackup:backups.find(x=>String(x.label).startsWith("daily-"))||null,lastWeeklyBackup:backups.find(x=>String(x.label).startsWith("weekly-"))||null,previousStateAvailable,stateMirrorAvailable,securityMirrorAvailable,lastRecovery:recoveryEvents[0]||null,recoveryEvents,activeSessions:Object.keys(security.sessions||{}).length,userStats:{active:users.filter(u=>u.active!==false).length,locked:users.filter(u=>u.profileStatus==="locked").length,recycled:users.filter(u=>u.profileStatus==="deleted").length,graduated:users.filter(u=>u.profileStatus==="graduated").length},recentSecurityEvents:events.slice(0,10),integrity:systemIntegrityReport(db),serverTime:new Date().toISOString()};
}
async function handleSystemHealthApi(req, res, url, auth) {
  try {
    if (!["admin", "superadmin"].includes(auth.user.role)) throw Object.assign(new Error("این بخش فقط برای ادمین مجاز است."), { status: 403 });
    if (req.method === "GET" && url.pathname === "/api/admin/system-health") return sendJson(res, 200, await systemHealthSnapshot(auth.db));
    if (req.method === "POST" && url.pathname === "/api/admin/system-health/repair") {
      const operation = await enqueueStateOperation(async () => {
        await createStateSnapshot("before-health-repair");
        const current = await ensureStateInitialized();
        const fixed = repairServerDb(current.db, auth.user.id);
        const saved = await writeStateEnvelope(fixed.db, { skipSnapshot: true });
        return { fixed, saved };
      });
      await securityAudit({ type: "system_health_repair", userId: auth.user.id, role: auth.user.role, ip: clientIp(req), details: operation.fixed.actions.join("; ") || "normalize only" });
      return sendJson(res, 200, { ok: true, actions: operation.fixed.actions, health: await systemHealthSnapshot(operation.saved.db), updatedAt: operation.saved.updatedAt });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/sessions/revoke") {
      const authHeader = String(req.headers.authorization || ""); const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : ""; const keepHash = token ? tokenHash(token) : "";
      const updated = await mutateSecurity(security => { let revoked = 0; for (const hash of Object.keys(security.sessions || {})) if (hash !== keepHash) { delete security.sessions[hash]; revoked++; } return revoked; });
      const revoked = Number(updated.result || 0);
      await securityAudit({ type: "sessions_revoke", userId: auth.user.id, role: auth.user.role, ip: clientIp(req), details: `${revoked} session(s)` });
      return sendJson(res, 200, { ok: true, revoked });
    }
    return sendJson(res, 404, { error: "مسیر سلامت سامانه پیدا نشد." });
  } catch (error) { return sendJson(res, error.status || 500, { error: error.message || "خطای سلامت سامانه" }); }
}

function stage09SnapshotForStudent(db,studentId,academicPeriod="semester2"){
  const st=(db.users||[]).find(u=>u.id===studentId&&u.role==="student");if(!st)return null;
  const year=String(db.school?.year||""),period=academicPeriod==="semester1"?"semester1":"semester2";
  const attendance=(db.attendance||[]).filter(x=>x.studentId===studentId&&String(x.academicYear||year)===year&&String(x.academicPeriod||x.period||"semester2")===period);
  const homework=(db.homework||[]).filter(x=>x.classId===st.classId&&String(x.academicYear||year)===year&&String(x.academicPeriod||x.period||"semester2")===period&&x.status!=="archived");
  const ids=new Set(homework.map(x=>x.id)),homeworkSubmissions=(db.homeworkSubmissions||[]).filter(x=>x.studentId===studentId&&ids.has(x.homeworkId));
  const behavior=(db.behaviorRecords||[]).filter(x=>x.studentId===studentId&&String(x.academicYear||year)===year&&String(x.academicPeriod||x.period||"semester2")===period);
  const continuous=(db.continuousAssessments||[]).filter(x=>x.studentId===studentId&&String(x.academicYear||year)===year&&String(x.academicPeriod||x.period||"semester2")===period);
  return {academicPeriod:period,...studentDailySnapshot09({attendance,homework,homeworkSubmissions,behavior,continuous,studentId})};
}
function stage10RiskForStudent(db,studentId,academicPeriod="semester2"){
 const snapshot=stage09SnapshotForStudent(db,studentId,academicPeriod);
 if(!snapshot)return null;
 const risk=riskScore10(snapshot,db.school?.settings?.riskPolicy10||{});
 const open=(db.interventions||[]).filter(x=>x.studentId===studentId&&x.status!=="archived"&&x.status!=="closed"&&String(x.academicYear||db.school?.year||"")===String(db.school?.year||"")).length;
 return {...risk,openInterventions:open,academicPeriod:snapshot.academicPeriod};
}

// p58: secure student-teacher academic conversations. Stored in existing state envelope.

// p59 — Teacher-authored, non-graded self-practice. Answers never exposed before submission.
async function handlePracticeP59(req,res,url){
 try{
  const {db,user}=await authenticate(req,["student","teacher"]);
  const isTeacher=user.role==="teacher";
  const assignments=(state,student)=>(state.teachingAssignments||[]).filter(a=>a.classId===student.classId&&teacherAssignmentIsActive(state,a));
  const eligible=(state,student,quiz)=>student&&student.role==="student"&&student.active!==false&&student.classId===quiz.classId&&assignments(state,student).some(a=>a.teacherId===quiz.teacherId&&a.subject===quiz.subject);
  const all=(db.practiceQuizzesP59||[]);
  if(req.method==="GET"&&url.pathname.endsWith('/list')){
   const qs=isTeacher?all.filter(q=>q.teacherId===user.id):all.filter(q=>q.published&&eligible(db,user,q));
   const attempts=(db.practiceAttemptsP59||[]).filter(a=>a.studentId===user.id);
   return sendJson(res,200,{quizzes:qs.map(q=>({id:q.id,title:q.title,subject:q.subject,classId:q.classId,published:!!q.published,count:q.questions.length,createdAt:q.createdAt,attempts:attempts.filter(a=>a.quizId===q.id).length})),attempts:attempts.slice(-100).map(a=>({id:a.id,quizId:a.quizId,score:a.score,total:a.total,at:a.at}))});
  }
  if(req.method==="GET"&&url.pathname.endsWith('/contacts')){
   if(!isTeacher)return sendJson(res,403,{error:'فقط معلم'});
   const rows=(db.teachingAssignments||[]).filter(a=>a.teacherId===user.id&&teacherAssignmentIsActive(db,a));
   return sendJson(res,200,{assignments:rows.map(a=>({classId:a.classId,subject:a.subject}))});
  }
  if(req.method==="POST"&&url.pathname.endsWith('/create')){
   if(!isTeacher)return sendJson(res,403,{error:'فقط معلم می‌تواند تمرین ایجاد کند'});
   const b=await readJson(req),classId=String(b.classId||''),subject=String(b.subject||''),title=String(b.title||'').trim();
   if(!title||title.length>120||!subject||!classId||!(db.teachingAssignments||[]).some(a=>a.teacherId===user.id&&a.classId===classId&&a.subject===subject&&teacherAssignmentIsActive(db,a)))return sendJson(res,400,{error:'عنوان یا تخصیص درس نامعتبر است'});
   const questions=b.questions;
   if(!Array.isArray(questions)||questions.length<1||questions.length>30||questions.some(q=>!String(q.text||'').trim()||String(q.text).length>500||!Array.isArray(q.options)||q.options.length!==4||q.options.some(x=>!String(x||'').trim()||String(x).length>200)||!Number.isInteger(q.answer)||q.answer<0||q.answer>3))return sendJson(res,400,{error:'سؤال‌ها باید چهار گزینه و یک پاسخ صحیح داشته باشند (حداکثر ۳۰ سؤال).'});
   const result=await enqueueStateOperation(async()=>{const env=await ensureStateInitialized(),state=env.db;
    if(!(state.teachingAssignments||[]).some(a=>a.teacherId===user.id&&a.classId===classId&&a.subject===subject&&teacherAssignmentIsActive(state,a)))throw Object.assign(new Error('دسترسی به درس ندارید'),{status:403});
    const q={id:makeId('pr59'),teacherId:user.id,classId,subject,title,questions:questions.map(x=>({text:String(x.text).trim(),options:x.options.map(o=>String(o).trim()),answer:x.answer})),published:true,createdAt:new Date().toISOString()};
    state.practiceQuizzesP59||=[];state.practiceQuizzesP59.push(q);await writeStateEnvelope(state);return q.id;});
   return sendJson(res,200,{ok:true,id:result});
  }
  if(req.method==="GET"&&url.pathname.endsWith('/take')){
   if(isTeacher)return sendJson(res,403,{error:'این بخش ویژه دانش‌آموز است'});
   const q=all.find(q=>q.id===url.searchParams.get('id')&&q.published&&eligible(db,user,q));
   if(!q)return sendJson(res,404,{error:'تمرین یافت نشد'});
   return sendJson(res,200,{quiz:{id:q.id,title:q.title,subject:q.subject,questions:q.questions.map(x=>({text:x.text,options:x.options}))}});
  }
  if(req.method==="POST"&&url.pathname.endsWith('/submit')){
   if(isTeacher)return sendJson(res,403,{error:'این بخش ویژه دانش‌آموز است'});
   const b=await readJson(req),answers=b.answers;
   const q=all.find(q=>q.id===b.id&&q.published&&eligible(db,user,q));
   if(!q||!Array.isArray(answers)||answers.length!==q.questions.length||answers.some(a=>!Number.isInteger(a)||a<0||a>3))return sendJson(res,400,{error:'پاسخ‌ها نامعتبرند'});
   const result=await enqueueStateOperation(async()=>{const env=await ensureStateInitialized(),state=env.db;const fresh=(state.practiceQuizzesP59||[]).find(x=>x.id===q.id);
    if(!fresh||!fresh.published||!eligible(state,user,fresh))throw Object.assign(new Error('دسترسی به تمرین ندارید'),{status:403});
    const correct=fresh.questions.map(x=>x.answer),score=correct.filter((a,i)=>a===answers[i]).length;
    state.practiceAttemptsP59||=[];state.practiceAttemptsP59.push({id:makeId('pa59'),quizId:q.id,studentId:user.id,answers:answers.slice(),score,total:correct.length,at:new Date().toISOString()});await writeStateEnvelope(state);return {score,total:correct.length,correct};});
   return sendJson(res,200,{ok:true,...result});
  }
  return sendJson(res,404,{error:'مسیر نامعتبر'});
 }catch(e){return sendJson(res,e.status||500,{error:e.status?e.message:'خطای داخلی سرور'});}
}

// Push is authorized only for valid student sessions; revoked sessions receive nothing.
async function sendAuthorizedPush(ids,payload){
  if(!isPushEnabled())return;
  const current=(await ensureStateInitialized()).db;
  const sec=await ensureSecurityInitialized(current);
  const now=Date.now(),active=new Set(Object.entries(sec.sessions||{}).filter(([hash,s])=>s?.role==="student"&&s.expiresAt>now&&s.idleExpiresAt>now).map(([hash])=>hash));
  return sendPushToStudents(ids,payload,active);
}

async function handleAcademicMessagesP58(req,res,url){
 try{
  const auth=await authenticate(req,["student","teacher"]); const {db,user}=auth;
  const eligible=(state,student,teacher,subject)=> student?.role==="student"&&teacher?.role==="teacher"&&student.active!==false&&teacher.active!==false&&!!student.classId&&teacherCanAssigned(state,teacher,{classId:student.classId,subject});
  const assignments=(state,student)=>(state.teachingAssignments||[]).filter(a=>teacherAssignmentIsActive(state,a)&&a.classId===student.classId).map(a=>({teacherId:a.teacherId,subject:a.subject})).filter(a=>eligible(state,student,(state.users||[]).find(t=>t.id===a.teacherId),a.subject));
  const selfName=[user.firstName,user.lastName].filter(Boolean).join(" ").trim();
  if(req.method==="GET"&&url.pathname==="/api/academic-messages/p58/contacts"){
   if(user.role==="student")return sendJson(res,200,{selfName,contacts:assignments(db,user).map(a=>{const t=db.users.find(x=>x.id===a.teacherId);return {...a,name:[t?.firstName,t?.lastName].filter(Boolean).join(" ")};})});
   const rows=(db.teachingAssignments||[]).filter(a=>a.teacherId===user.id&&teacherAssignmentIsActive(db,a));
   const contacts=[];for(const a of rows)for(const s of db.users||[])if(s.role==="student"&&s.classId===a.classId&&eligible(db,s,user,a.subject))contacts.push({studentId:s.id,subject:a.subject,name:[s.firstName,s.lastName].filter(Boolean).join(" ")});
   return sendJson(res,200,{selfName,contacts});
  }
  if(req.method==="GET"&&url.pathname==="/api/academic-messages/p58/threads"){
   const rows=(db.academicMessagesP58||[]).filter(m=>m.studentId===user.id||m.teacherId===user.id).filter(m=>{const s=db.users.find(x=>x.id===m.studentId),t=db.users.find(x=>x.id===m.teacherId);return eligible(db,s,t,m.subject)}).slice(-500);
   return sendJson(res,200,{messages:rows});
  }
  if(req.method==="POST"&&url.pathname==="/api/academic-messages/p58/read"){
   const body=await readJson(req),studentId=user.role==="student"?user.id:String(body.studentId||""),teacherId=user.role==="teacher"?user.id:String(body.teacherId||""),subject=String(body.subject||"").trim();
   if(!studentId||!teacherId||!subject||subject.length>120)throw Object.assign(new Error("گفتگوی نامعتبر"),{status:400});
   if(user.role==="student"&&studentId!==user.id||user.role==="teacher"&&teacherId!==user.id)throw Object.assign(new Error("دسترسی غیرمجاز"),{status:403});
   const result=await enqueueStateOperation(async()=>{const env=await ensureStateInitialized(),state=env.db,s=(state.users||[]).find(x=>x.id===studentId),t=(state.users||[]).find(x=>x.id===teacherId);
    if(!eligible(state,s,t,subject))throw Object.assign(new Error("دسترسی غیرمجاز به گفتگو"),{status:403});
    let changed=0;const now=new Date().toISOString();for(const m of state.academicMessagesP58||[]){if(m.studentId===studentId&&m.teacherId===teacherId&&m.subject===subject&&m.fromRole!==user.role&&!m.readAt){m.readAt=now;changed++;}}
    if(changed)await writeStateEnvelope(state);return changed;});
   return sendJson(res,200,{ok:true,marked:result});
  }
  if(req.method==="POST"&&url.pathname==="/api/academic-messages/p58/send"){
   const body=await readJson(req),subject=String(body.subject||"").trim(),message=String(body.message||"").trim();
   const studentId=user.role==="student"?user.id:String(body.studentId||""),teacherId=user.role==="teacher"?user.id:String(body.teacherId||"");
   if(!message||message.length>2000||!subject||subject.length>120)throw Object.assign(new Error("متن پیام باید بین ۱ تا ۲۰۰۰ نویسه باشد."),{status:400});
   const saved=await enqueueStateOperation(async()=>{const env=await ensureStateInitialized(),state=env.db,s=state.users.find(x=>x.id===studentId),t=state.users.find(x=>x.id===teacherId);if(!eligible(state,s,t,subject))throw Object.assign(new Error("این معلم یا دانش‌آموز برای این درس مجاز نیست."),{status:403});
    state.academicMessagesP58=Array.isArray(state.academicMessagesP58)?state.academicMessagesP58:[];
    const row={id:makeId("msg"),studentId,teacherId,subject,fromRole:user.role,fromId:user.id,message,at:new Date().toISOString()};state.academicMessagesP58.push(row);await writeStateEnvelope(state);return row;});
   if(user.role==="teacher"){
     void sendAuthorizedPush([studentId],{title:"پیام جدید از معلم",body:"یک پیام درسی جدید دریافت کرده‌اید.",screen:"chat",eventId:saved.id}).catch(e=>console.warn('FCM chat:',e.message));
   }
   return sendJson(res,201,{message:saved});
  }
  return sendJson(res,404,{error:"مسیر یافت نشد."});
 }catch(error){return sendJson(res,error.status||500,{error:error.message||"خطای سرور"});}
}

async function handleStudentApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/student/app-version") {
      const currentCode=Math.max(0,Number(url.searchParams.get("versionCode")||0));
      return sendJson(res,200,{
        latestVersion:STUDENT_ANDROID_VERSION,
        latestVersionCode:STUDENT_ANDROID_VERSION_CODE,
        minSupportedVersionCode:STUDENT_ANDROID_MIN_VERSION_CODE,
        apkUrl:STUDENT_ANDROID_APK_URL,
        required:currentCode>0 && currentCode<STUDENT_ANDROID_MIN_VERSION_CODE,
        notes:"آیکون و Splash جدید، امنیت آزمون، اعلان‌های Android، تاریخ شمسی، مدیریت حافظه آفلاین و بهبود Navigation.",
        serverRelease:APP_RELEASE
      });
    }
    if (req.method === "POST" && url.pathname === "/api/student/login") {
      const body = await readJson(req);
      const nationalId = normalizeNationalId(body.nationalId || body.identifier || body.studentCode);
      const birthDate=body.birthDate||body.birthYear,password=String(body.password||"");
      const rate=await loginRateStatus(req,nationalId);
      if(rate.blocked)throw Object.assign(new Error(`تلاش‌های ناموفق زیاد بوده است؛ ${rate.retryAfter} ثانیه بعد دوباره امتحان کنید.`),{status:429});
      const envelope=await ensureStateInitialized(),security=await ensureSecurityInitialized(envelope.db);
      const student=(envelope.db.users||[]).find(u=>u.active&&u.role==="student"&&normalizeNationalId(u.nationalId)===nationalId);
      const credential=student?security.credentials?.[student.id]:null,bootstrap=Boolean(credential?.mustChangePassword&&!credential?.passwordChangedAt);
      let ok=false;
      if(/^\d{10}$/.test(nationalId)&&student&&credential)ok=bootstrap?Boolean((password&&await passwordVerify(password,credential.passwordHash))||birthValueMatches(student.birthDate||student.birthYear,birthDate)):Boolean(password)&&await passwordVerify(password,credential.passwordHash);
      if(!ok){await recordLoginFailure(rate.key);await securityAudit({type:"student_login",success:false,ip:clientIp(req),details:"اطلاعات ورود دانش‌آموز نادرست"});throw Object.assign(new Error(bootstrap?"رمز عبور یا تاریخ تولد صحیح نیست.":"کد ملی یا رمز عبور صحیح نیست."),{status:401});}
      await recordLoginSuccess(rate.key);
      await mutateSecurity(sec=>{const c=sec.credentials?.[student.id];if(c){c.lastLoginAt=new Date().toISOString();c.lastLoginIp=clientIp(req);c.lastLoginUserAgent=String(req.headers["user-agent"]||"").slice(0,250);}});
      const token=await issueSession(student,req,security);
      await securityAudit({type:"student_login",userId:student.id,role:student.role,success:true,ip:clientIp(req),details:bootstrap?"bootstrap":"password"});
      return sendJson(res,200,{token,student:publicStudent(student,envelope.db),mustChangePassword:Boolean(credential.mustChangePassword),bootstrap,serverTime:Date.now()});
    }

    const passwordChangeRoute = req.method === "POST" && url.pathname === "/api/student/change-password";
    const auth = await studentAuth(req, { allowPasswordChange: passwordChangeRoute });
    const db = auth.db; const student = auth.user;

    // Native Android FCM registration. Student identity is derived only from the authorized session.
    if(req.method==="POST"&&url.pathname==="/api/student/mobile-push/register"){
      const b=await readJson(req);
      return sendJson(res,200,await registerPushDevice(student.id,String(b.deviceId||""),String(b.token||""),auth.tokenHash));
    }
    if(req.method==="POST"&&url.pathname==="/api/student/mobile-push/unregister"){
      const b=await readJson(req);
      return sendJson(res,200,await unregisterPushDevice(student.id,String(b.deviceId||"")));
    }
    if (req.method === "POST" && url.pathname === "/api/student/logout") {
      await mutateSecurity(security => { delete security.sessions[auth.tokenHash]; });
      await securityAudit({ type: "student_logout", userId: student.id, role: student.role, ip: clientIp(req) });
      return sendJson(res, 200, { ok: true });
    }
    if (passwordChangeRoute) {
      const body = await readJson(req);
      const policyError = passwordPolicy(body.newPassword, student.role); if (policyError) throw Object.assign(new Error(policyError), { status: 400 });
      const updated = await mutateSecurity(async security => {
        const credential=security.credentials[student.id];
        if(!credential)return {error:"current"};
        const bootstrapChange=Boolean(credential.mustChangePassword&&!credential.passwordChangedAt);
        if(!bootstrapChange&&!await passwordVerify(String(body.currentPassword||""),credential.passwordHash))return {error:"current"};
        if(await passwordVerify(String(body.newPassword),credential.passwordHash))return {error:"same"};
        credential.passwordHash = await passwordHash(body.newPassword); credential.mustChangePassword = false; credential.passwordChangedAt = new Date().toISOString(); credential.credentialVersion = Number(credential.credentialVersion || 1) + 1;
        for (const [hash, sess] of Object.entries(security.sessions)) if (sess.userId === student.id && hash !== auth.tokenHash) delete security.sessions[hash];
        return { ok: true };
      });
      if (updated.result?.error === "current") throw Object.assign(new Error("رمز فعلی صحیح نیست."), { status: 401 });
      if (updated.result?.error === "same") throw Object.assign(new Error("رمز جدید باید با رمز قبلی متفاوت باشد."), { status: 400 });
      await securityAudit({ type: "password_change", userId: student.id, role: student.role, ip: clientIp(req) });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/student/me") return sendJson(res, 200, { student: publicStudent(student, db), auth: publicAuthUser(student, auth.security) });

    if (req.method === "GET" && url.pathname === "/api/student/profile/photo") {
      return sendJson(res, 200, { photoDataUrl: await readStudentProfilePhoto(student.id), updatedAt: student.profilePhotoUpdatedAt || "" });
    }

    if (req.method === "POST" && url.pathname === "/api/student/profile") {
      const body = await readJson(req);
      const clean = validateStudentProfilePayload(body);
      let photoUpdatedAt = student.profilePhotoUpdatedAt || "";
      if (body.removePhoto === true) {
        const key = safeKey(`student_profile_${student.id}`);
        await fs.rm(path.join(FILES_DIR, `${key}.json`), { force: true });
        photoUpdatedAt = "";
      } else if (body.photoDataUrl) {
        await saveStudentProfilePhoto(student.id, body.photoDataUrl);
        photoUpdatedAt = new Date().toISOString();
      }
      const result = await mutateDb(db2 => {
        const target = (db2.users || []).find(u => u.id === student.id && u.role === "student");
        if (!target) throw Object.assign(new Error("دانش‌آموز پیدا نشد."), { status: 404 });
        Object.assign(target, clean, { profileUpdatedAt: new Date().toISOString(), profilePhotoUpdatedAt: photoUpdatedAt });
        db2.audit ||= []; db2.audit.unshift({ id: makeId("log"), userId: student.id, action: "ویرایش پروفایل دانش‌آموز", details: "اطلاعات تماس و پروفایل توسط دانش‌آموز به‌روزرسانی شد", at: faNow() });
        return publicStudent(target, db2);
      });
      await securityAudit({ type: "student_profile_update", userId: student.id, role: student.role, ip: clientIp(req), details: "student profile synchronized" });
      return sendJson(res, 200, { ok: true, student: result.result, photoDataUrl: body.removePhoto === true ? "" : (body.photoDataUrl || await readStudentProfilePhoto(student.id)), savedAt: new Date().toISOString() });
    }

    if (req.method === "POST" && url.pathname === "/api/student/exam-incidents") {
      const body=await readJson(req),examId=String(body.examId||""),type=String(body.type||"other");
      if(!V66_INCIDENT_TYPES.has(type))throw Object.assign(new Error("نوع رخداد فنی معتبر نیست."),{status:400});
      const exam=(db.exams||[]).find(e=>e.id===examId&&studentCanSeeExam(db,e,student));if(!exam)throw Object.assign(new Error("آزمون مرتبط پیدا نشد."),{status:404});
      const clientEventId=String(body.clientEventId||"").slice(0,120);if(!clientEventId)throw Object.assign(new Error("شناسه رخداد لازم است."),{status:400});
      const saved=await mutateDb(async mutable=>{mutable.examIncidents ||= [];const exact=mutable.examIncidents.find(x=>x.studentId===student.id&&x.clientEventId===clientEventId);if(exact)return exact;const clientAt=Number(body.clientAt||Date.now()),sessionKey=String(body.sessionKey||"").slice(0,120);const recent=mutable.examIncidents.filter(x=>x.studentId===student.id&&x.examId===examId&&x.type===type&&x.status==="pending"&&Math.abs(clientAt-Number(x.lastClientAt||x.clientAt||0))<=5*60*1000&&(sessionKey?String(x.sessionKey||"")===sessionKey:true)).sort((a,b)=>Number(b.lastClientAt||b.clientAt||0)-Number(a.lastClientAt||a.clientAt||0))[0];if(recent){recent.evidenceCount=Number(recent.evidenceCount||1)+1;recent.lastClientAt=clientAt;recent.clientEventIds=Array.from(new Set([...(recent.clientEventIds||[recent.clientEventId]),clientEventId])).slice(-20);recent.lastDescription=String(body.description||"").slice(0,600);return recent;}const row={id:makeId("inc"),clientEventId,clientEventIds:[clientEventId],evidenceCount:1,studentId:student.id,examId,type,description:String(body.description||"").slice(0,600),clientAt,lastClientAt:clientAt,createdAt:Date.now(),networkOnline:body.networkOnline!==false,visibility:String(body.visibility||"").slice(0,30),appVersion:String(body.appVersion||"v67").slice(0,80),sessionKey,status:"pending",source:"student-app-v67"};mutable.examIncidents.push(row);mutable.notifications ||= [];mutable.notifications.unshift({id:makeId("not"),userId:exam.createdBy,title:"Incident فنی آزمون",body:`برای آزمون «${exam.title}» یک رخداد فنی دانش‌آموز ثبت شد.`,read:false,at:faNow()});return row;});
      await securityAudit({type:"student_exam_incident",userId:student.id,role:student.role,ip:clientIp(req),details:`${examId}:${type}`});
      return sendJson(res,201,{ok:true,incident:saved.result});
    }

    if (req.method === "POST" && url.pathname === "/api/student/exam-delivery-recovery/request") {
      const body=await readJson(req),examId=String(body.examId||""),submissionKey=submissionKeyV63(body);
      const exam=(db.exams||[]).find(e=>e.id===examId&&studentClassIds(db,student).has(String(e.classId||"")));
      if(!exam)throw Object.assign(new Error("آزمون مرتبط پیدا نشد."),{status:404});
      if(!submissionKey)throw Object.assign(new Error("کلید تحویل برای بررسی لازم است."),{status:400});
      if(existingExamSubmissionV63(db,exam,student,submissionKey))throw Object.assign(new Error("این تحویل قبلاً روی Server ثبت شده است و نیازی به Recovery ندارد."),{status:409});
      const packageVersion=String(body.packageVersion||"").slice(0,200),clientFinalizedAt=Number(body.finalizedAt||0);
      if(!packageVersion||!clientFinalizedAt)throw Object.assign(new Error("اطلاعات بسته نهایی‌شده برای Recovery کامل نیست."),{status:400});
      const saved=await mutateDb(async mutable=>{mutable.examDeliveryRecoveryRequests ||= [];const old=mutable.examDeliveryRecoveryRequests.find(r=>r.studentId===student.id&&r.examId===examId&&r.submissionKey===submissionKey&&["pending","approved"].includes(r.status));if(old){old.lastRequestedAt=Date.now();old.lastError=String(body.lastError||"").slice(0,500);old.lastErrorStatus=Number(body.lastErrorStatus||0);return old;}const r={id:makeId("rec"),studentId:student.id,examId,submissionKey,packageVersion,clientFinalizedAt,clientQueuedAt:Number(body.queuedAt||0),clientRetryCount:Math.max(0,Number(body.retryCount||0)),lastError:String(body.lastError||"").slice(0,500),lastErrorStatus:Number(body.lastErrorStatus||0),status:"pending",createdAt:Date.now(),source:"student-app-v65"};mutable.examDeliveryRecoveryRequests.push(r);mutable.notifications ||= [];mutable.notifications.unshift({id:makeId("not"),userId:exam.createdBy,title:"درخواست بررسی تحویل آزمون",body:`${student.firstName} ${student.lastName} برای آزمون «${exam.title}» درخواست بررسی ارسال ثبت کرد.`,read:false,at:faNow()});return r;});
      await securityAudit({type:"exam_delivery_recovery_request",userId:student.id,role:student.role,ip:clientIp(req),details:`${examId}:${submissionKey.slice(0,24)}`});
      return sendJson(res,201,{ok:true,request:saved.result});
    }

    if (req.method === "POST" && url.pathname === "/api/student/online-class/join") {
      const body=await readJson(req),scheduleEntryId=String(body.scheduleEntryId||""),clock=schoolClockV74(),date=clock.date,requestedDate=String(body.date||"").slice(0,10);
      if(requestedDate&&requestedDate!==date)throw Object.assign(new Error("Check-in کلاس آنلاین فقط برای تاریخ جاری مدرسه مجاز است."),{status:409});
      const entry=(db.weeklySchedule||[]).find(e=>e.id===scheduleEntryId&&e.active!==false&&e.classId===student.classId&&String(e.academicYear||db.school?.year||"")===String(db.school?.year||""));
      if(!entry)throw Object.assign(new Error("کلاس آنلاین برای شما پیدا نشد."),{status:404});
      const publicEntry=publicOnlineScheduleEntryV74(db,entry),settings=onlineLearningSettingsV74(db);
      if(!settings.enabled||!["online","hybrid"].includes(publicEntry.effectiveMode))throw Object.assign(new Error("این زنگ در حالت آنلاین فعال نیست."),{status:409});
      const datedSessions=(db.onlineClassSessions||[]).filter(x=>x.scheduleEntryId===entry.id&&x.date===date&&x.status!=="cancelled");
      const activeSession=datedSessions.find(x=>x.status==="live")||datedSessions.find(x=>x.status==="scheduled")||null;
      if(entry.day!==clock.dayName&&!activeSession)throw Object.assign(new Error("این کلاس برای امروز در برنامه شما قرار ندارد."),{status:409});
      if(!activeSession&&datedSessions.some(x=>x.status==="ended"))throw Object.assign(new Error("جلسه آنلاین امروز پایان یافته است."),{status:409});
      const startMinute=hmMinutesV74(entry.startTime),endMinute=hmMinutesV74(entry.endTime),joinWindow=Math.max(0,Number(settings.joinWindowMinutes||0));
      if(!activeSession&&startMinute!==null&&clock.minutes<startMinute-joinWindow)throw Object.assign(new Error(`زمان ورود به این کلاس هنوز نرسیده است؛ ورود از ${entry.startTime} با ${joinWindow} دقیقه فرصت پیش از شروع فعال می‌شود.`),{status:409});
      if(!activeSession&&endMinute!==null&&clock.minutes>endMinute+60)throw Object.assign(new Error("زمان این کلاس برای امروز به پایان رسیده است."),{status:409});
      const meetingUrl=normalizeWebUrlV74(activeSession?.meetingUrl||publicEntry.meetingUrl||""),meetingProvider=String(activeSession?.meetingProvider||publicEntry.meetingProvider||settings.defaultProvider||"custom").slice(0,60),lateAfter=Math.max(0,Number(settings.lateAfterMinutes||0)),delayMinutes=startMinute===null?null:clock.minutes-startMinute,punctuality=delayMinutes===null?"unknown":delayMinutes>lateAfter?"late":"on_time";
      if(!meetingUrl)throw Object.assign(new Error("لینک کلاس آنلاین هنوز توسط مدرسه یا معلم ثبت نشده است."),{status:409});
      const saved=await mutateDb(m=>{m.onlineJoinEvents=Array.isArray(m.onlineJoinEvents)?m.onlineJoinEvents:[];let row=m.onlineJoinEvents.find(x=>x.studentId===student.id&&x.scheduleEntryId===entry.id&&x.date===date);const now=new Date().toISOString();if(row){row.lastJoinAt=now;row.joinCount=Number(row.joinCount||1)+1;row.lastIp=clientIp(req);row.onlineSessionId=activeSession?.id||row.onlineSessionId||"";row.meetingProvider=meetingProvider;}else{row={id:makeId("olj"),studentId:student.id,classId:student.classId,scheduleEntryId:entry.id,onlineSessionId:activeSession?.id||"",teacherId:entry.teacherId,subject:entry.subject,date,periodNo:entry.periodNo,academicYear:String(m.school?.year||""),meetingProvider,punctuality,firstJoinDelayMinutes:delayMinutes,schoolTimeZone:clock.timeZone,firstJoinAt:now,lastJoinAt:now,joinCount:1,lastIp:clientIp(req),source:"student-app-v74"};m.onlineJoinEvents.push(row);}m.audit=Array.isArray(m.audit)?m.audit:[];m.audit.unshift({id:makeId("log"),userId:student.id,action:"ورود به کلاس آنلاین",details:`${entry.subject} · ${entry.day} · زنگ ${entry.periodNo}`,at:faNow()});return row;});
      await securityAudit({type:"online_class_join",userId:student.id,role:student.role,success:true,ip:clientIp(req),details:`${entry.id}:${date}:${activeSession?.id||"schedule"}`});
      return sendJson(res,200,{ok:true,join:saved.result,onlineSessionId:activeSession?.id||"",sessionStatus:activeSession?.status||"schedule",meetingUrl,meetingProvider,effectiveMode:publicEntry.effectiveMode,instructions:publicEntry.onlineInstructions});
    }

    if (req.method === "GET" && url.pathname === "/api/student/dashboard") {

      const attempts = (db.attempts || []).filter(a => a.studentId === student.id);
      const submissions = (db.submissions || []).filter(s => s.studentId === student.id);
      const grades = (db.grades || []).filter(g => submissions.some(s => s.id === g.submissionId));
      const appeals = (db.appeals || []).filter(a => a.studentId === student.id);
      const baseNotifications = (db.notifications || []).filter(n => n.userId === student.id).slice(0, 30);
      const visibleExams = (db.exams || []).filter(e => studentCanSeeExam(db, e, student));
      const visibleHomework = (db.homework || []).filter(h => studentCanSeeHomework(db, h, student));
      const existingExamNotice = new Set(baseNotifications.filter(n => n.type === "exam" && n.targetId).map(n => String(n.targetId)));
      const existingHomeworkNotice = new Set(baseNotifications.filter(n => n.type === "homework" && n.targetId).map(n => String(n.targetId)));
      const derivedNotifications = [
        ...visibleExams.filter(e => !existingExamNotice.has(String(e.id))).slice(0, 15).map(e => ({
          id: `auto_exam_${e.id}_${student.id}`, userId: student.id, type: "exam",
          title: "آزمون جدید", message: e.title || "آزمون جدید برای شما منتشر شده است.",
          target: "exams", targetId: e.id, priority: "normal", at: e.publishedAt || e.lifecycleUpdatedAt || e.createdAt || new Date().toISOString(), auto: true
        })),
        ...visibleHomework.filter(h => !existingHomeworkNotice.has(String(h.id))).slice(0, 15).map(h => ({
          id: `auto_homework_${h.id}_${student.id}`, userId: student.id, type: "homework",
          title: "تکلیف جدید", message: h.title || "تکلیف جدید برای شما ثبت شده است.",
          target: "homework", targetId: h.id, priority: "normal", at: h.publishedAt || h.updatedAt || h.createdAt || new Date().toISOString(), auto: true
        }))
      ];
      const notifications = [...baseNotifications, ...derivedNotifications].slice(0, 50);
      const exams = visibleExams.map(e => ({ ...sanitizeExam(e), ...examAvailabilityV62(e), ...examAvailabilityForStudentV66(db,e,student), studentStatus: studentExamStatus(db, e, student.id), submissionInfo: studentSubmissionInfo(db,e,student.id), questions: undefined }));
      const homework = visibleHomework.map(h => ({ ...h, submission: (db.homeworkSubmissions || []).find(x => x.homeworkId === h.id && x.studentId === student.id) || null }));
      const resources = (db.resources || []).filter(r => r.classId === student.classId);
      const attendance = attendanceSummaryForStudent(db, student.id);
      const continuousAssessments = (db.continuousAssessments || []).filter(x => x.studentId === student.id && x.visibleToStudent !== false && (!x.academicYear || String(x.academicYear)===String(db.school?.year||""))).slice().sort((a,b)=>String(b.date||b.at||"").localeCompare(String(a.date||a.at||""))).slice(0,50);
      const interventions = (db.interventions || []).filter(x => x.studentId === student.id && x.visibleToStudent !== false && x.status !== "archived" && (!x.academicYear || String(x.academicYear)===String(db.school?.year||""))).slice().sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||""))).slice(0,20);
      const announcements = visibleAnnouncementsForStudent(db, student);
      const behaviorRecords = (db.behaviorRecords || []).filter(x => x.studentId === student.id && x.visibleToStudent !== false && (!x.academicYear || String(x.academicYear)===String(db.school?.year||""))).slice().sort((a,b)=>String(b.date||b.at||"").localeCompare(String(a.date||a.at||""))).slice(0,30);
      const lessonLogs = (db.lessonLogs || []).filter(x => x.classId === student.classId && x.visibleToStudent !== false && x.status !== "cancelled" && (!x.academicYear || String(x.academicYear)===String(db.school?.year||""))).slice().sort((a,b)=>String(b.date||"").localeCompare(String(a.date||""))).slice(0,20);
      const schedule = (db.schedule || []).filter(x => !x.classId || x.classId === student.classId);
      const scheduleDayOrderV79={"شنبه":0,"یکشنبه":1,"دوشنبه":2,"سه‌شنبه":3,"چهارشنبه":4,"پنجشنبه":5,"جمعه":6};
      const weeklySchedule=(db.weeklySchedule||[]).filter(x=>x.active!==false&&x.classId===student.classId&&String(x.academicYear||db.school?.year||"")===String(db.school?.year||"")).map(x=>{const row=publicOnlineScheduleEntryV74(db,x),t=(db.users||[]).find(u=>u.id===x.teacherId),shift=(db.school?.shiftDefinitions||[]).find(sh=>sh.id===x.shiftId);return {...row,teacherName:t?`${t.firstName||""} ${t.lastName||""}`.trim():"",shiftName:shift?.name||x.shiftId||""};}).sort((a,b)=>(scheduleDayOrderV79[a.day]??99)-(scheduleDayOrderV79[b.day]??99)||(hmMinutesV74(a.startTime)??9999)-(hmMinutesV74(b.startTime)??9999)||Number(a.periodNo||0)-Number(b.periodNo||0));
      const scheduleClockV79=schoolClockV74(),todaySchedule=weeklySchedule.filter(x=>x.day===scheduleClockV79.dayName);
      const scheduleRevisionV79=(db.scheduleRevisions||[]).filter(x=>x.classId===student.classId&&String(x.academicYear||db.school?.year||"")===String(db.school?.year||"")).sort((a,b)=>String(b.changedAt||"").localeCompare(String(a.changedAt||"")))[0]||null;
      const onlineClassSessions=(db.onlineClassSessions||[]).filter(x=>x.classId===student.classId&&String(x.academicYear||db.school?.year||"")===String(db.school?.year||"")&&x.status!=="cancelled").map(x=>({id:x.id,scheduleEntryId:x.scheduleEntryId,classId:x.classId,subject:x.subject,teacherId:x.teacherId,date:x.date,periodNo:x.periodNo,deliveryMode:x.deliveryMode,meetingProvider:x.meetingProvider,meetingUrl:x.meetingUrl,status:x.status,startedAt:x.startedAt||"",endedAt:x.endedAt||"",title:x.title||x.subject||""}));
      const onlineJoinEvents=(db.onlineJoinEvents||[]).filter(x=>x.studentId===student.id&&String(x.academicYear||db.school?.year||"")===String(db.school?.year||"")).slice().sort((a,b)=>String(b.lastJoinAt||"").localeCompare(String(a.lastJoinAt||""))).slice(0,100);
      const consentForms = (db.consentForms || []).filter(x => x.status === "active" && (!x.academicYear || String(x.academicYear)===String(db.school?.year||"")) && (!x.classId || x.classId === student.classId) && (!Array.isArray(x.studentIds) || !x.studentIds.length || x.studentIds.includes(student.id))).map(x => { const { responses = [], ...form } = x; return { ...form, response: responses.find(r => r.studentId === student.id) || null }; });
      const progressReports = (db.progressReports || []).filter(x => x.studentId === student.id && x.status === "published" && (!x.academicYear || String(x.academicYear)===String(db.school?.year||""))).slice().sort((a,b)=>String(b.publishedAt||b.createdAt||"").localeCompare(String(a.publishedAt||a.createdAt||""))).slice(0,12);
      const calendarEvents=publicCalendarForStudentV76(db,student),academicYearModel=publicActiveAcademicYearV76(db);
      return sendJson(res, 200, { student: publicStudent(student, db), exams, attempts, submissions, grades, appeals, notifications, announcements, homework, continuousAssessments, interventions, behaviorRecords, lessonLogs, schedule, weeklySchedule, todaySchedule, scheduleUpdatedAt:scheduleRevisionV79?.changedAt||"", onlineLearning:publicOnlineSettingsV74(db), onlineClassSessions, onlineJoinEvents, resources, consentForms, progressReports, attendance, calendarEvents, academicYearModel, deliveryRecoveryRequests:deliveryRecoveryRowsV65(db).filter(r=>r.studentId===student.id).slice().sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0,30), examIncidents:examIncidentRowsV66(db).filter(r=>r.studentId===student.id).slice().sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0,50), fairnessAdjustments:fairnessRowsV66(db).filter(r=>r.studentId===student.id).slice().sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0,30), studentGoals:(db.studentGoals||[]).filter(x=>x.studentId===student.id), masteryRecords:(db.masteryRecords||[]).filter(x=>x.studentId===student.id), studyPlans:(db.studyPlans||[]).filter(x=>x.studentId===student.id), achievements:(db.achievements||[]).filter(x=>x.studentId===student.id), report: studentReport(db, student.id), termReport: studentTermReportV185(db, student.id,"semester2"), termReports:{semester1:studentTermReportV185(db,student.id,"semester1"),semester2:studentTermReportV185(db,student.id,"semester2"),annual:studentTermReportV185(db,student.id,"annual")}, dailySnapshots:{semester1:stage09SnapshotForStudent(db,student.id,"semester1"),semester2:stage09SnapshotForStudent(db,student.id,"semester2")}, riskSnapshots:{semester1:stage10RiskForStudent(db,student.id,"semester1"),semester2:stage10RiskForStudent(db,student.id,"semester2")}, serverTime: Date.now() });
    }

    if (req.method === "GET" && url.pathname === "/api/student/exams") {
      const exams = (db.exams || []).filter(e => studentCanSeeExam(db, e, student)).map(e => ({ ...sanitizeExam(e), ...examAvailabilityV62(e), ...examAvailabilityForStudentV66(db,e,student), questions: undefined, studentStatus: studentExamStatus(db, e, student.id), submissionInfo: studentSubmissionInfo(db,e,student.id) }));
      return sendJson(res, 200, { exams });
    }

    let match = url.pathname.match(/^\/api\/student\/exams\/([^/]+)\/download$/);
    if (req.method === "GET" && match) {
      const exam = (db.exams || []).find(e => e.id === decodeURIComponent(match[1]) && studentCanSeeExam(db, e, student));
      if (!exam) throw Object.assign(new Error("آزمون فعال پیدا نشد."), { status: 404 });
      const availabilityV66=examAvailabilityForStudentV66(db,exam,student);
      if (!availabilityV66.canStart) {
        const state=availabilityV66.availabilityState;
        throw Object.assign(new Error(state==="scheduled"?"زمان شروع آزمون هنوز نرسیده است.":"زمان آزمون به پایان رسیده است."), { status: 409 });
      }
      if (studentExamStatus(db, exam, student.id) === "submitted") throw Object.assign(new Error("این آزمون قبلاً تحویل داده شده است."), { status: 409 });
      const packageVersion = examPackageVersion(exam); const fairness=activeFairnessV66(db,student.id,exam.id); const allowedDurationSeconds=fairness?Math.max(60,Math.floor((Number(fairness.expiresAt)-Date.now())/1000)):Math.max(60,Number(exam.duration||0)*60); const grant = await createExamGrant(student, exam, packageVersion, allowedDurationSeconds);
      const sheetCode = studentSheetCode(auth.security.serverSecret, student, exam);
      await securityAudit({ type: "exam_download", userId: student.id, role: student.role, ip: clientIp(req), details: `${exam.title} | ${sheetCode}` });
      return sendJson(res, 200, { exam: { ...sanitizeExam(exam), ...(fairness?{duration:Math.max(1,Math.ceil(allowedDurationSeconds/60))}:{}), ...availabilityV66, sheetCode }, downloadedAt: Date.now(), packageVersion, availability: availabilityV66, ...grant });
    }

    match = url.pathname.match(/^\/api\/student\/exams\/([^/]+)\/submit$/);
    if (req.method === "POST" && match) {
      const examId = decodeURIComponent(match[1]);
      const body = await readJson(req);
      const grantExam = (db.exams || []).find(e => e.id === examId && studentCanSeeExam(db, e, student));
      if (!grantExam || grantExam.type !== "mcq") throw Object.assign(new Error("آزمون تستی فعال پیدا نشد."), { status: 404 });
      const submissionKey=submissionKeyV63(body);
      const duplicate=existingExamSubmissionV63(db,grantExam,student,submissionKey);
      if(duplicate){await noteDuplicateDeliveryV64(grantExam.id,student.id,submissionKey);return sendJson(res,200,{...duplicateReceiptV63(duplicate,grantExam,db),deliveryDiagnostics:duplicate.record.deliveryDiagnostics||null});}
      if ((db.attempts || []).some(a => a.examId === grantExam.id && a.studentId === student.id)) throw Object.assign(new Error("این آزمون قبلاً تحویل داده شده است."), { status: 409 });
      const grantV63=await validateExamGrantOrRecoveryV65(student, grantExam, body, db);
      const result = await mutateDb(async mutable => {
        const exam = (mutable.exams || []).find(e => e.id === examId && e.classId === student.classId && e.status === "active");
        if (!exam || exam.type !== "mcq") throw Object.assign(new Error("آزمون تستی فعال پیدا نشد."), { status: 404 });
        const duplicateInside=existingExamSubmissionV63(mutable,exam,student,submissionKey);
        if(duplicateInside)return {duplicate:duplicateInside,exam};
        if ((mutable.attempts || []).some(a => a.examId === exam.id && a.studentId === student.id)) throw Object.assign(new Error("این آزمون قبلاً تحویل داده شده است."), { status: 409 });
        const currentPackageVersion = examPackageVersion(exam);
        if (body.packageVersion && body.packageVersion !== currentPackageVersion) throw Object.assign(new Error("نسخه آزمون روی گوشی قدیمی است؛ سؤال‌ها را دوباره دانلود کنید."), { status: 409 });
        const answers = body.answers && typeof body.answers === "object" ? body.answers : {};
        let score = 0, correctCount = 0, answeredCount = 0;
        const durationSeconds = Number(body.durationSeconds || 0);
        const secondsPerQuestion = (exam.questions || []).length ? durationSeconds / exam.questions.length : 0;
        for (const q of exam.questions || []) {
          const hasAnswer = Object.prototype.hasOwnProperty.call(answers, q.id);
          if (hasAnswer) answeredCount += 1;
          const correct = hasAnswer && Number(answers[q.id]) === Number(q.answer);
          if (correct) { score += Number(q.score || 0); correctCount += 1; }
          if (q.sourceQuestionId) {
            const source = (mutable.questionBank || []).find(item => item.id === q.sourceQuestionId);
            if (source) {
              source.stats ||= {};
              const oldN = Number(source.stats.answerCount || 0);
              source.stats.answerCount = oldN + 1;
              if (correct) source.stats.correctCount = Number(source.stats.correctCount || 0) + 1;
              source.stats.avgSeconds = Math.round(((Number(source.stats.avgSeconds || 0) * oldN) + secondsPerQuestion) / (oldN + 1) * 10) / 10;
              source.lastAnsweredAt = faNow();
            }
          }
        }
        const total = examTotalScore(exam);
        const roundedScore = Math.round(score * 100) / 100;
        const attempt = {
          id: makeId("att"), examId: exam.id, studentId: student.id, answers,
          score: roundedScore, total,
          percent: total ? Math.round((roundedScore / total) * 1000) / 10 : 0,
          correctCount, answeredCount, questionCount: (exam.questions || []).length,
          status: "final", gradingStatus: "final", gradedAt: Date.now(),
          startedAt: Number(body.startedAt || Date.now()), submittedAt: Date.now(),
          durationSeconds, packageVersion: currentPackageVersion, submissionKey, clientFinalizedAt:Number(body.finalizedAt||0), deliveredAt:Date.now(), deliveryMode:examScheduleStateV6111(exam)==="running"?"live":"offline_late", deliveryDiagnostics:deliveryDiagnosticsV64(body,exam), source: "student-app-v64", at: faNow()
        };
        mutable.attempts ||= []; mutable.attempts.push(attempt);
        mutable.audit ||= []; mutable.audit.unshift({ id: makeId("log"), userId: student.id, action: "تحویل و تصحیح خودکار آزمون تستی", details: `${exam.title} · نمره ${attempt.score} از ${attempt.total}`, at: faNow() });
        mutable.notifications ||= [];
        mutable.notifications.unshift({
          id: makeId("not"), userId: student.id, title: "نمره آزمون ثبت شد",
          body: `${exam.title}: ${attempt.score} از ${attempt.total}`,
          read: false, at: faNow()
        });
        return { attempt, exam };
      });
      if(result.result.duplicate){await markExamGrantUsedV63(body.attemptId,submissionKey);await noteDuplicateDeliveryV64(grantExam.id,student.id,submissionKey);return sendJson(res,200,duplicateReceiptV63(result.result.duplicate,result.result.exam,result.db||db));}
      const attempt = result.result.attempt, exam = result.result.exam;
      await markExamGrantUsedV63(body.attemptId,submissionKey);
      await consumeRecoveryV65(grantV63?.request?.id||body.recoveryRequestId,submissionKey);
      const receiptHash = crypto.createHash("sha256").update(`${attempt.id}|${student.id}|${exam.id}|${attempt.submittedAt}|${attempt.score}`).digest("hex");
      await securityAudit({ type: "exam_submit", userId: student.id, role: student.role, ip: clientIp(req), details: `${exam.title} | ${receiptHash.slice(0, 12)} | ${attempt.score}/${attempt.total}` });
      return sendJson(res, 200, {
        ok: true,
        receiptId: attempt.id,
        receiptHash,
        submittedAt: attempt.submittedAt,
        gradingStatus: "final",
        reportCardUpdated: true,
        result: {
          status: "final",
          score: attempt.score,
          total: attempt.total,
          percent: attempt.percent,
          correctCount: attempt.correctCount,
          answeredCount: attempt.answeredCount,
          questionCount: attempt.questionCount
        }
      });
    }

    match = url.pathname.match(/^\/api\/student\/exams\/([^/]+)\/submit-mixed$/);
    if (req.method === "POST" && match) {
      const examId = decodeURIComponent(match[1]);
      const body = await readJson(req);
      const current = await ensureStateInitialized();
      const exam = (current.db.exams || []).find(e => e.id === examId && e.classId === student.classId && e.status === "active");
      if (!exam || exam.type !== "mixed") throw Object.assign(new Error("آزمون ترکیبی فعال پیدا نشد."), { status: 404 });
      const submissionKey=submissionKeyV63(body);
      const duplicate=existingExamSubmissionV63(current.db,exam,student,submissionKey);
      if(duplicate){await noteDuplicateDeliveryV64(exam.id,student.id,submissionKey);return sendJson(res,200,{...duplicateReceiptV63(duplicate,exam,current.db),deliveryDiagnostics:duplicate.record.deliveryDiagnostics||null});}
      if (body.packageVersion && body.packageVersion !== examPackageVersion(exam)) throw Object.assign(new Error("نسخه آزمون روی گوشی قدیمی است؛ سؤال‌ها را دوباره دانلود کنید."), { status: 409 });
      if ((current.db.submissions || []).some(x => x.examId === exam.id && x.studentId === student.id) || (current.db.attempts || []).some(x => x.examId === exam.id && x.studentId === student.id)) throw Object.assign(new Error("این آزمون قبلاً تحویل داده شده است."), { status:409 });
      const recoveryGrantV65=await validateExamGrantOrRecoveryV65(student, exam, body, current.db);
      const answers = mixedAnswerMapV54(body.answers || {});
      const autoQuestions = (exam.questions || []).filter(isAutoGradableQuestionV54);
      const manualQuestions = (exam.questions || []).filter(q => !isAutoGradableQuestionV54(q));
      const autoBundle = buildAutoGradingCore(exam, answers);
      const autoRows = autoBundle.questions;
      const autoScore = autoBundle.score;
      const autoTotal = autoBundle.total;
      const manualTotal = autoBundle.manualTotal;
      const submissionId = makeId("sub");
      const write = await mutateDb(async mutable => {
        const duplicateInside=existingExamSubmissionV63(mutable,exam,student,submissionKey);
        if(duplicateInside)return {duplicate:duplicateInside,grade:null};
        if ((mutable.submissions || []).some(x => x.examId === exam.id && x.studentId === student.id)) throw Object.assign(new Error("این آزمون قبلاً تحویل داده شده است."), { status:409 });
        const submission = { id:submissionId, examId:exam.id, studentId:student.id, typedAnswers:answers, files:[], fileKeys:[], status:manualQuestions.length?"submitted":"final", gradingMode:"hybrid", autoGrading:{ score:autoScore,total:autoTotal,manualTotal,questions:autoRows,gradedAt:Date.now(),engine:"v54-server" }, ai:null, submissionKey, clientFinalizedAt:Number(body.finalizedAt||0), deliveredAt:Date.now(), deliveryMode:examScheduleStateV6111(exam)==="running"?"live":"offline_late", deliveryDiagnostics:deliveryDiagnosticsV64(body,exam), source:"student-app-v64", startedAt:Number(body.startedAt||Date.now()), durationSeconds:Number(body.durationSeconds||0), submittedAt:Date.now(), at:faNow() };
        mutable.submissions ||= []; mutable.submissions.push(submission);
        for (const row of autoRows) { const q=(exam.questions||[]).find(x=>String(x.id)===String(row.questionId)); if(!q?.sourceQuestionId) continue; const source=(mutable.questionBank||[]).find(x=>x.id===q.sourceQuestionId); if(!source) continue; source.stats ||= {}; source.stats.answerCount=Number(source.stats.answerCount||0)+1; if(row.correct)source.stats.correctCount=Number(source.stats.correctCount||0)+1; source.lastAnsweredAt=faNow(); }
        let grade = null;
        if (!manualQuestions.length) { grade={ id:makeId("gr"),submissionId:submission.id,examId:exam.id,teacherId:null,gradingVersion:54,gradingSource:"server-auto-mixed",teacherScore:autoScore,finalScore:autoScore,questionScores:autoRows.map(x=>({questionId:x.questionId,teacherScore:x.earnedScore,score:x.earnedScore,gradingSource:"server-auto"})),feedback:"تصحیح خودکار کامل شد.",gradedAt:Date.now(),at:faNow() }; mutable.grades ||= []; mutable.grades.push(grade); }
        mutable.notifications ||= []; mutable.notifications.unshift({ id:makeId("not"), userId:exam.createdBy, title:manualQuestions.length?"آزمون ترکیبی برای تکمیل تصحیح":"آزمون ترکیبی تحویل شد", body:manualQuestions.length?`${student.firstName} ${student.lastName} آزمون «${exam.title}» را تحویل داد؛ بخش عینی ${autoScore} از ${autoTotal} تصحیح شد.`:`${student.firstName} ${student.lastName} آزمون «${exam.title}» را تحویل داد و خودکار تصحیح شد.`, read:false, at:faNow() });
        mutable.audit ||= []; mutable.audit.unshift({ id:makeId("log"),userId:student.id,action:"تحویل آزمون ترکیبی",details:`${exam.title} · خودکار ${autoScore}/${autoTotal} · دستی ${manualTotal}`,at:faNow() });
        return { submission, grade };
      });
      if(write.result.duplicate){await markExamGrantUsedV63(body.attemptId,submissionKey);await noteDuplicateDeliveryV64(exam.id,student.id,submissionKey);return sendJson(res,200,duplicateReceiptV63(write.result.duplicate,exam,current.db));}
      await markExamGrantUsedV63(body.attemptId,submissionKey);
      await consumeRecoveryV65(recoveryGrantV65?.request?.id||body.recoveryRequestId,submissionKey);
      const receiptHash = crypto.createHash("sha256").update(`${submissionId}|${student.id}|${exam.id}|${write.result.submission.submittedAt}|${autoScore}`).digest("hex");
      await securityAudit({ type:"mixed_exam_submit",userId:student.id,role:student.role,ip:clientIp(req),details:`${exam.title} | ${receiptHash.slice(0,12)} | auto ${autoScore}/${autoTotal}` });
      const final = Boolean(write.result.grade);
      return sendJson(res,200,{ok:true,receiptId:submissionId,receiptHash,submittedAt:write.result.submission.submittedAt,gradingStatus:final?"final":"pending_manual",result:{status:final?"final":"pending",score:final?autoScore:null,total:examTotalScore(exam),autoScore,autoTotal,manualTotal,questionCount:(exam.questions||[]).length}});
    }

    match = url.pathname.match(/^\/api\/student\/exams\/([^/]+)\/submit-descriptive$/);
    if (req.method === "POST" && match) {
      const examId = decodeURIComponent(match[1]);
      const body = await readJson(req);
      const current = await ensureStateInitialized();
      const exam = (current.db.exams || []).find(e => e.id === examId && e.classId === student.classId && e.status === "active");
      if (!exam || exam.type !== "descriptive") throw Object.assign(new Error("آزمون تشریحی فعال پیدا نشد."), { status: 404 });
      const submissionKey=submissionKeyV63(body);
      const duplicate=existingExamSubmissionV63(current.db,exam,student,submissionKey);
      if(duplicate){await noteDuplicateDeliveryV64(exam.id,student.id,submissionKey);return sendJson(res,200,{...duplicateReceiptV63(duplicate,exam,current.db),deliveryDiagnostics:duplicate.record.deliveryDiagnostics||null});}
      if (body.packageVersion && body.packageVersion !== examPackageVersion(exam)) throw Object.assign(new Error("نسخه آزمون روی گوشی قدیمی است؛ سؤال‌ها را دوباره دانلود کنید."), { status: 409 });
      if ((current.db.submissions || []).some(s => s.examId === exam.id && s.studentId === student.id)) throw Object.assign(new Error("این آزمون قبلاً تحویل داده شده است."), { status: 409 });
      const recoveryGrantV65=await validateExamGrantOrRecoveryV65(student, exam, body, current.db);
      const files = Array.isArray(body.files) ? body.files : [];
      const typedAnswers = normalizeTypedAnswers(body.answers || body.typedAnswers);
      if ((!files.length && !Object.keys(typedAnswers).length && !body.autoSubmitted) || files.length > 12) throw Object.assign(new Error("حداقل یک پاسخ تایپی یا تصویر پاسخ لازم است؛ حداکثر ۱۲ تصویر مجاز است."), { status: 400 });
      const submissionId = makeId("sub");
      const sheetCode = studentSheetCode(auth.security.serverSecret, student, exam);
      const fileRecords = files.length ? await saveStudentFiles(submissionId, files) : [];
      const write = await mutateDb(async mutable => {
        const duplicateInside=existingExamSubmissionV63(mutable,exam,student,submissionKey);
        if(duplicateInside)return {duplicate:duplicateInside};
        if ((mutable.submissions || []).some(s => s.examId === exam.id && s.studentId === student.id)) throw Object.assign(new Error("این آزمون قبلاً تحویل داده شده است."), { status: 409 });
        const submission = { id: submissionId, examId: exam.id, studentId: student.id, sheetCode, files: fileRecords, fileKeys: fileRecords.map(f => f.key), typedAnswers, status: "submitted", ai: null, submissionKey, clientFinalizedAt:Number(body.finalizedAt||0), deliveredAt:Date.now(), deliveryMode:examScheduleStateV6111(exam)==="running"?"live":"offline_late", deliveryDiagnostics:deliveryDiagnosticsV64(body,exam), source: "student-app-v64", submittedAt: Date.now(), at: faNow() };
        mutable.submissions ||= []; mutable.submissions.push(submission);
        mutable.notifications ||= []; mutable.notifications.unshift({ id: makeId("not"), userId: exam.createdBy, title: "برگه جدید برای تصحیح", body: `${student.firstName} ${student.lastName} برگه «${exam.title}» را ارسال کرد.`, read: false, at: faNow() });
        mutable.audit ||= []; mutable.audit.unshift({ id: makeId("log"), userId: student.id, action: "ارسال پاسخ تشریحی از اپ", details: exam.title, at: faNow() });
        return submission;
      });
      if(write.result.duplicate){await markExamGrantUsedV63(body.attemptId,submissionKey);await noteDuplicateDeliveryV64(exam.id,student.id,submissionKey);return sendJson(res,200,duplicateReceiptV63(write.result.duplicate,exam,current.db));}
      await markExamGrantUsedV63(body.attemptId,submissionKey);
      await consumeRecoveryV65(recoveryGrantV65?.request?.id||body.recoveryRequestId,submissionKey);
      const receiptHash = crypto.createHash("sha256").update(`${write.result.id}|${student.id}|${exam.id}|${write.result.submittedAt}`).digest("hex");
      await securityAudit({ type: "descriptive_submit", userId: student.id, role: student.role, ip: clientIp(req), details: `${exam.title} | ${receiptHash.slice(0, 12)}` });
      return sendJson(res, 200, { ok: true, receiptId: write.result.id, receiptHash, submittedAt: write.result.submittedAt, sheetCode: write.result.sheetCode, gradingStatus: "awaiting_package_export" });
    }

    if (req.method === "GET" && url.pathname === "/api/student/results") {
      const attempts = (db.attempts || []).filter(a => a.studentId === student.id);
      const submissions = (db.submissions || []).filter(s => s.studentId === student.id);
      const results = [];
      for (const attempt of attempts) {
        const exam = (db.exams || []).find(e => e.id === attempt.examId); if (!exam) continue;
        const meta = examCurriculumMeta(db, exam);
        results.push({ id: attempt.id, examId: exam.id, title: exam.title, subject: exam.subject, bookId: meta.bookId, bookTitle: meta.bookTitle, chapterId: meta.chapterId, chapter: meta.chapterTitle, type: exam.type, score: attempt.score, total: attempt.total || examTotalScore(exam), percent: Number(attempt.percent ?? ((attempt.total || examTotalScore(exam)) ? Math.round(Number(attempt.score||0) / Number(attempt.total || examTotalScore(exam)) * 1000) / 10 : 0)), correctCount: Number(attempt.correctCount||0), answeredCount: Number(attempt.answeredCount||0), questionCount: Number(attempt.questionCount || (exam.questions||[]).length), gradingStatus: "final", status: "final", resultRevision: Number(attempt.resultRevision||1), resultUpdatedAt: Number(attempt.resultUpdatedAt||attempt.submittedAt||0), submittedAt: attempt.submittedAt, canAppeal: true });
      }
      for (const submission of submissions) {
        const exam = (db.exams || []).find(e => e.id === submission.examId); if (!exam) continue;
        const grade = (db.grades || []).find(g => g.submissionId === submission.id);
        const meta = examCurriculumMeta(db, exam);
        results.push({ id: submission.id, examId: exam.id, title: exam.title, subject: exam.subject, bookId: meta.bookId, bookTitle: meta.bookTitle, chapterId: meta.chapterId, chapter: meta.chapterTitle, type: exam.type, score: grade?.finalScore ?? null, total: examTotalScore(exam), status: grade ? "final" : "pending", resultRevision: grade ? Number(grade.resultRevision||1) : 0, resultUpdatedAt: grade ? Number(grade.publishedAt||grade.gradedAt||0) : 0, submittedAt: submission.submittedAt || 0, feedback: grade?.feedback || "", aiSuggestedScore: submission.ai?.totalSuggestedScore ?? null, canAppeal: Boolean(grade) });
      }
      return sendJson(res, 200, { results: results.sort((a, b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0)), report: studentReport(db, student.id) });
    }

    match = url.pathname.match(/^\/api\/student\/results\/([^/]+)\/details$/);
    if (req.method === "GET" && match) {
      const examId = decodeURIComponent(match[1]);
      const exam = (db.exams || []).find(e => e.id === examId && e.classId === student.classId);
      if (!exam) throw Object.assign(new Error("آزمون پیدا نشد."), { status: 404 });
      const meta = examCurriculumMeta(db, exam);
      const common = { examId: exam.id, title: exam.title, subject: exam.subject, bookId: meta.bookId, bookTitle: meta.bookTitle, chapterId: meta.chapterId, chapter: meta.chapterTitle, type: exam.type, total: examTotalScore(exam) };
      if (exam.type === "mcq") {
        const attempt = (db.attempts || []).find(a => a.examId === exam.id && a.studentId === student.id);
        if (!attempt) throw Object.assign(new Error("هنوز نتیجه‌ای برای این آزمون ثبت نشده است."), { status: 404 });
        const questions = (exam.questions || []).map((q, index) => {
          const source = q.sourceQuestionId ? (db.questionBank || []).find(item => item.id === q.sourceQuestionId) : null;
          const rawAnswer = attempt.answers?.[q.id]; const answered = rawAnswer !== undefined && rawAnswer !== null && rawAnswer !== "";
          const selectedIndex = answered ? Number(rawAnswer) : null; const correctIndex = Number(q.answer); const correct = answered && selectedIndex === correctIndex;
          return { questionId: q.id, number: index + 1, text: q.text, maxScore: Number(q.score || 0), earnedScore: correct ? Number(q.score || 0) : 0, answered, correct, selectedIndex, selectedAnswer: answered ? String((q.choices || [])[selectedIndex] ?? "") : "", correctIndex, correctAnswer: String((q.choices || [])[correctIndex] ?? ""), choices: (q.choices || []).map(String), explanation: String(q.explanation || source?.explanation || "پاسخ صحیح را با متن درس دوباره مرور کنید.") };
        });
        return sendJson(res, 200, { ...common, status: "final", resultRevision: Number(attempt.resultRevision||1), resultUpdatedAt: Number(attempt.resultUpdatedAt||attempt.submittedAt||0), score: Number(attempt.score || 0), submittedAt: attempt.submittedAt || 0, questions });
      }
      const submission = (db.submissions || []).find(item => item.examId === exam.id && item.studentId === student.id);
      if (!submission) throw Object.assign(new Error("هنوز برگه‌ای برای این آزمون ثبت نشده است."), { status: 404 });
      const grade = (db.grades || []).find(item => item.submissionId === submission.id && String(item.publishStatus || "published") === "published");
      if (!grade) return sendJson(res, 200, { ...common, status: "pending", score: null, submittedAt: submission.submittedAt || 0, feedback: "برگه در انتظار ثبت نمره نهایی معلم است.", questions: [] });
      const questions = (exam.questions || []).map((raw, index) => {
        const q = normalizeDescriptiveQuestion(raw); const gradeQ = (grade.questionScores || []).find(item => String(item.questionId) === String(q.id)) || {}; const aiQ = (submission.ai?.questions || []).find(item => String(item.questionId) === String(q.id)) || {};
        const earned = Number(gradeQ.teacherScore ?? gradeQ.score ?? 0); const max = Number(q.score || 0); const status = earned >= max - 0.001 ? "correct" : earned > 0 ? "partial" : "incorrect"; const typed = String(submission.typedAnswers?.[q.id] || "").trim();
        const autoQ=(submission.autoGrading?.questions||[]).find(item=>String(item.questionId)===String(q.id));
        if(exam.type==="mixed"&&autoQ?.autoGraded){
          const qType=String(raw.type||q.type||"");
          if(qType==="mcq"){const selectedIndex=Number(autoQ.studentAnswer),correctIndex=Number(autoQ.correctAnswer);return {questionId:q.id,number:index+1,text:q.text,maxScore:max,earnedScore:earned,autoGraded:true,type:qType,answered:Boolean(autoQ.answered),correct:Boolean(autoQ.correct),selectedIndex,selectedAnswer:String((raw.choices||[])[selectedIndex]??""),correctIndex,correctAnswer:String((raw.choices||[])[correctIndex]??""),choices:(raw.choices||[]).map(String),explanation:String(raw.explanation||"")};}
          if(qType==="true_false"){const label=v=>(v===true||v===1||String(v)==="1")?"صحیح":"غلط";return {questionId:q.id,number:index+1,text:q.text,maxScore:max,earnedScore:earned,autoGraded:true,type:qType,answered:Boolean(autoQ.answered),correct:Boolean(autoQ.correct),studentAnswer:label(autoQ.studentAnswer),correctAnswer:label(autoQ.correctAnswer),explanation:String(raw.explanation||"")};}
          if(qType==="fill_blank"){return {questionId:q.id,number:index+1,text:q.text,maxScore:max,earnedScore:earned,autoGraded:true,type:qType,answered:Boolean(autoQ.answered),correct:Boolean(autoQ.correct),studentAnswer:String(autoQ.studentAnswer??""),correctAnswer:Array.isArray(autoQ.correctAnswer)?autoQ.correctAnswer.join(" / "):String(autoQ.correctAnswer??""),explanation:String(raw.explanation||"")};}
        }
        return { questionId: q.id, number: index + 1, text: q.text, maxScore: max, earnedScore: earned, autoGraded:false, status, studentAnswer: typed || (submission.files?.length ? "پاسخ در تصویر برگه ثبت شده است." : "پاسخی ثبت نشده است."), teacherFeedback: String(gradeQ.feedback || ""), referenceAnswer: String(q.referenceAnswer || ""), criteria: (gradeQ.criterionScores || []).map(item => ({ title: String(item.title || "معیار"), score: Number(item.teacherScore ?? item.score ?? 0), maxScore: Number(item.maxScore || 0) })) };
      });
      return sendJson(res, 200, { ...common, status: "final", resultRevision: Number(grade.resultRevision||1), resultUpdatedAt: Number(grade.publishedAt||grade.gradedAt||0), score: Number(grade.finalScore || 0), submittedAt: submission.submittedAt || 0, feedback: String(grade.feedback || ""), questions });
    }

    if (req.method === "GET" && url.pathname === "/api/student/appeals") return sendJson(res, 200, { appeals: (db.appeals || []).filter(a => a.studentId === student.id) });
    if (req.method === "POST" && url.pathname === "/api/student/appeals") {
      const body = await readJson(req);
      const message = String(body.message || "").trim();
      if (message.length < 10) throw Object.assign(new Error("توضیح اعتراض باید کامل‌تر باشد."), { status: 400 });
      const write = await mutateDb(async mutable => {
        const exam = (mutable.exams || []).find(e => e.id === body.examId && e.classId === student.classId);
        if (!exam) throw Object.assign(new Error("آزمون پیدا نشد."), { status: 404 });
        const questionId = body.questionId ? String(body.questionId) : "";
        if (questionId && !(exam.questions || []).some(q => String(q.id) === questionId)) throw Object.assign(new Error("سؤال انتخاب‌شده متعلق به این آزمون نیست."), { status: 400 });
        const attempt = (mutable.attempts || []).find(a => a.examId === exam.id && a.studentId === student.id);
        const submission = (mutable.submissions || []).find(s => s.examId === exam.id && s.studentId === student.id);
        const grade = submission ? (mutable.grades || []).find(g => g.submissionId === submission.id && String(g.publishStatus || "published") === "published") : null;
        const hasPublishedResult = exam.type === "mcq" ? Boolean(attempt && (attempt.submittedAt || attempt.status === "submitted")) : Boolean(grade);
        if (!hasPublishedResult) throw Object.assign(new Error("اعتراض فقط پس از انتشار نتیجه نهایی قابل ثبت است."), { status: 409 });
        const appealedResultRevision = exam.type === "mcq" ? Number(attempt.resultRevision || 1) : Number(grade.resultRevision || 1);
        mutable.appeals ||= [];
        const sameOpen = mutable.appeals.find(a => a.examId === exam.id && a.studentId === student.id && String(a.questionId || "") === questionId && ["open", "reviewing"].includes(a.status));
        if (sameOpen) throw Object.assign(new Error("برای این مورد یک اعتراض باز وجود دارد."), { status: 409 });
        const createdAtFa = faNow();
        const appeal = { id: makeId("app"), examId: exam.id, questionId: questionId || null, studentId: student.id, appealedResultRevision, message, status: "open", at: createdAtFa, createdAt: Date.now(), teacherResponse: "", history: [{ status: "open", note: `اعتراض به نسخه ${appealedResultRevision} نتیجه توسط دانش‌آموز ثبت شد`, resultRevision: appealedResultRevision, at: createdAtFa, by: student.id }] };
        mutable.appeals.push(appeal);
        mutable.notifications ||= []; mutable.notifications.unshift({ id: makeId("not"), userId: exam.createdBy, title: "اعتراض جدید به نمره", body: `${student.firstName} ${student.lastName} برای «${exam.title}» درخواست بررسی ثبت کرد.`, read: false, at: faNow() });
        return appeal;
      });
      return sendJson(res, 201, { appeal: write.result });
    }

    if (req.method === "POST" && url.pathname === "/api/student/homework/submit") {
      const body = await readJson(req); const homeworkId = String(body.homeworkId || "");
      const result = await mutateDb(async mutable => {
        const homework = (mutable.homework || []).find(h => h.id === homeworkId && studentCanSeeHomework(db, h, student));
        if (!homework) throw Object.assign(new Error("تکلیف فعال پیدا نشد."), { status: 404 });
        const text = String(body.text || "").trim();
        if (text.length < 2) throw Object.assign(new Error("پاسخ یا توضیح تحویل را وارد کنید."), { status: 400 });
        mutable.homeworkSubmissions ||= [];
        let submission = mutable.homeworkSubmissions.find(x => x.homeworkId === homework.id && x.studentId === student.id);
        if (submission && submission.status === "graded") throw Object.assign(new Error("این تکلیف نمره‌گذاری شده و قابل تغییر نیست."), { status: 409 });
        const due=String(homework.dueAt||"").slice(0,10),today=new Date().toISOString().slice(0,10),isLate=Boolean(due&&today>due),status=isLate?"late":"submitted",attachmentIds=Array.isArray(body.attachmentIds)?body.attachmentIds.map(String).slice(0,10):[];
        if(isLate&&homework.allowLate===false)throw Object.assign(new Error("مهلت تحویل این تکلیف پایان یافته است."),{status:409});
        if (submission) Object.assign(submission, { text, attachmentIds, status, submittedAt: faNow(), submittedAtIso:new Date().toISOString(), updatedAt: new Date().toISOString() });
        else { submission = { id: makeId("hwsub"), homeworkId: homework.id, studentId: student.id, text, attachmentIds, status, submittedAt: faNow(), submittedAtIso:new Date().toISOString(), createdAt: new Date().toISOString() }; mutable.homeworkSubmissions.push(submission); }
        mutable.notifications ||= []; mutable.notifications.unshift({ id: makeId("not"), userId: homework.createdBy, title: "تحویل تکلیف جدید", body: `${student.firstName} ${student.lastName} تکلیف «${homework.title}» را تحویل داد.`, read: false, at: faNow() });
        mutable.audit ||= []; mutable.audit.unshift({ id: makeId("log"), userId: student.id, action: "تحویل تکلیف", details: homework.title, at: faNow() });
        return submission;
      });
      return sendJson(res, 200, { ok: true, submission: result.result });
    }


    if (req.method === "GET" && url.pathname === "/api/student/learning-center") {
      const activeYear=String(db.school?.year||""),academicPeriod=normalizeAcademicPeriod(url.searchParams.get("academicPeriod")||"semester2",{allowAnnual:false});
      const homework=(db.homework||[]).filter(h=>studentCanSeeHomework(db,h,student)).slice().sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||""))).map(h=>({...h,submission:(db.homeworkSubmissions||[]).find(x=>x.homeworkId===h.id&&x.studentId===student.id)||null}));
      const subjects=[...new Set((db.teachingAssignments||[]).filter(a=>a.classId===student.classId&&a.active!==false&&String(a.academicYear||activeYear)===activeYear).map(a=>a.subject).filter(Boolean))];
      const continuous=subjects.map(subject=>({subject,...gradebookContinuousV75(db,{studentId:student.id,classId:student.classId,subject,academicYear:activeYear,academicPeriod}),lock:termLockV75(db,{classId:student.classId,subject,academicYear:activeYear,academicPeriod})}));
      const reportCards=(db.reportCards||[]).filter(r=>r.studentId===student.id&&String(r.academicYear||"")===activeYear&&r.status==="published").slice().sort((a,b)=>String(b.publishedAt||"").localeCompare(String(a.publishedAt||"")));
      const notifications=(db.notifications||[]).filter(n=>n.userId===student.id).slice(0,100);
      return sendJson(res,200,{ok:true,academicYear:activeYear,academicPeriod,homework,continuous,reportCards,notifications});
    }

    if (req.method === "POST" && url.pathname === "/api/student/consents/respond") {
      return sendJson(res, 403, { error: "پاسخ رضایت‌نامه فقط توسط ولی احرازشده در پنل اولیا مجاز است.", code: "GUARDIAN_CONSENT_REQUIRED" });
    }

    if (req.method === "POST" && url.pathname === "/api/student/progress/acknowledge") {
      const body = await readJson(req); const reportId = String(body.reportId || "");
      const result = await mutateDb(async mutable => {
        const report = (mutable.progressReports || []).find(x => x.id === reportId && x.studentId === student.id && x.status === "published");
        if (!report) throw Object.assign(new Error("گزارش پیشرفت پیدا نشد."), { status: 404 });
        report.acknowledgedAt = faNow(); report.acknowledgedAtIso = new Date().toISOString();
        mutable.audit ||= []; mutable.audit.unshift({ id: makeId("log"), userId: student.id, action: "تأیید مشاهده گزارش پیشرفت", details: report.title || report.period || report.id, at: faNow() });
        return report;
      });
      return sendJson(res, 200, { ok: true, report: result.result });
    }

    if (req.method === "POST" && url.pathname === "/api/student/notifications/read") {
      const body = await readJson(req);
      await mutateDb(async mutable => {
        for (const item of mutable.notifications || []) if (item.userId === student.id && (!body.id || item.id === body.id)) item.read = true;
      });
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: "مسیر اپ دانش‌آموز پیدا نشد." });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || "خطای سرویس دانش‌آموز", code:error.code||undefined });
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

async function ensureDataDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(FILES_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(BACKUPS_DIR, { recursive: true, mode: 0o700 });
  // Existing directories can predate the hardened permissions. Best-effort tighten them.
  for (const dir of [DATA_DIR, FILES_DIR, BACKUPS_DIR]) { try { await fs.chmod(dir, 0o700); } catch {} }
}

function safeKey(value) {
  const key = String(value || "");
  if (!/^[a-zA-Z0-9_-]{1,180}$/.test(key)) throw Object.assign(new Error("شناسه فایل معتبر نیست."), { status: 400 });
  return key;
}

function localIpv4Addresses() {
  const values = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) values.push(item.address);
    }
  }
  return [...new Set(values)];
}

function mobileUrls() {
  return localIpv4Addresses().map(ip => `http://${ip}:${PORT}`);
}

async function atomicWriteText(filePath, text, mode = 0o600) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmp, "w", mode);
    await handle.writeFile(String(text), "utf8");
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(tmp, filePath);
    try { await fs.chmod(filePath, mode); } catch {}
    try { const dir = await fs.open(path.dirname(filePath), "r"); await dir.sync(); await dir.close(); } catch {}
  } catch (error) {
    try { if (handle) await handle.close(); } catch {}
    try { await fs.rm(tmp, { force: true }); } catch {}
    throw error;
  }
}

async function appendRecoveryLog(event) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    await fs.appendFile(RECOVERY_LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) { console.warn("Recovery log failed", error.message); }
}
async function readRecoveryLog(limit = 20) {
  try {
    const lines=(await fs.readFile(RECOVERY_LOG_FILE,"utf8")).trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1,Number(limit)||20)).reverse().map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
  } catch { return []; }
}

async function cleanupStaleAtomicTemps() {
  const targets = [DATA_DIR, BACKUPS_DIR];
  for (const dir of targets) {
    try {
      for (const name of await fs.readdir(dir)) {
        if (!name.endsWith(".tmp")) continue;
        try { await fs.rm(path.join(dir, name), { force: true }); } catch {}
      }
    } catch {}
  }
}

async function readStateEnvelope() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { initialized: false, updatedAt: null, db: null };
    const wrapped = new Error("فایل اطلاعات اصلی سامانه آسیب دیده یا JSON معتبر نیست؛ بازیابی ایمن از آخرین نسخه سالم بررسی می‌شود.");
    wrapped.code = "STATE_DATA_CORRUPT";
    wrapped.cause = error;
    throw wrapped;
  }
}


function validateServerState(db) {
  const curriculum = Array.isArray(db.curriculum) ? db.curriculum : [];
  const progress = Array.isArray(db.chapterProgress) ? db.chapterProgress : [];
  for (const exam of db.exams || []) {
    const total=(exam.questions||[]).reduce((a,q)=>a+Number(q.score||0),0),target=Number(exam.targetScore)>0?Number(exam.targetScore):total;
    if(total>target+0.001)throw Object.assign(new Error(`جمع بارم سؤال‌های آزمون «${exam.title||""}» از نمره کل بیشتر است.`),{status:400});
    if (exam.status !== "active") continue;
    if(target<=0||Math.abs(total-target)>0.001)throw Object.assign(new Error(`انتشار آزمون «${exam.title||""}» فقط پس از تکمیل دقیق بارم مجاز است.`),{status:400});
    // P67.8: continuous (مستمر) exams are permitted during chapter instruction.
    // Chapter-completion remains a prerequisite only for final-term exams;
    // never make progress completion a global prerequisite for continuous assessments.
    if (String(exam.examCategory || "ongoing").toLowerCase() !== "final") continue;
    const book = curriculum.find(b => b.id === exam.bookId) || curriculum.find(b => b.subject === exam.subject);
    const chapter = book?.chapters?.find(c => c.id === exam.chapterId || c.title === exam.chapter);
    if (!book || !chapter) continue;
    const completed = progress.some(p => p.classId === exam.classId && p.bookId === book.id && p.chapterId === chapter.id && p.status === "completed");
    if (!completed) throw Object.assign(new Error(`انتشار آزمون «${exam.title}» قبل از پایان تدریس فصل مجاز نیست.`), { status: 400 });
  }
  return true;
}
let lastAutoSnapshotAt = 0;
function safeBackupName(value) {
  const name = String(value || "");
  if (!/^[a-zA-Z0-9_.-]{1,180}\.json$/.test(name)) throw Object.assign(new Error("نام نسخه پشتیبان معتبر نیست."), { status: 400 });
  return name;
}
async function pruneStateSnapshots(retention = 20, settings = {}) {
  await fs.mkdir(BACKUPS_DIR, { recursive: true, mode: 0o700 });
  try { await fs.chmod(BACKUPS_DIR, 0o700); } catch {}
  const rows=await listStateSnapshots();
  const daily=rows.filter(r=>String(r.label||"").startsWith("daily-"));
  const weekly=rows.filter(r=>String(r.label||"").startsWith("weekly-"));
  const auto=rows.filter(r=>r.label==="auto");
  const protectedNames=new Set([
    ...daily.slice(0,Math.max(1,Number(settings.dailyBackupRetention||7))).map(r=>r.name),
    ...weekly.slice(0,Math.max(1,Number(settings.weeklyBackupRetention||4))).map(r=>r.name),
    ...auto.slice(0,Math.max(1,Number(retention)||20)).map(r=>r.name)
  ]);
  const manualAndSafety=rows.filter(r=>!String(r.label||"").startsWith("daily-")&&!String(r.label||"").startsWith("weekly-")&&r.label!=="auto");
  for(const r of manualAndSafety.slice(0,Math.max(5,Number(retention)||20)))protectedNames.add(r.name);
  for(const r of rows)if(!protectedNames.has(r.name))await fs.rm(path.join(BACKUPS_DIR,r.name),{force:true});
}
async function createStateSnapshot(label = "manual", options = {}) {
  const current = await readStateEnvelope();
  if (!current.initialized || !current.db) return null;
  await fs.mkdir(BACKUPS_DIR, { recursive: true, mode: 0o700 });
  try { await fs.chmod(BACKUPS_DIR, 0o700); } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = String(label || "snapshot").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "snapshot";
  const nonce = crypto.randomBytes(3).toString("hex");
  const name = `${stamp}-${safeLabel}-${nonce}.json`;
  const payload = { app: "madreseyar-local-state", version: APP_VERSION, release:APP_RELEASE, createdAt: new Date().toISOString(), label, envelope: current };
  await atomicWriteText(path.join(BACKUPS_DIR, name), JSON.stringify(payload), 0o600);
  if(!options.skipPrune){const settings=current.db?.school?.settings||{};await pruneStateSnapshots(Number(settings.backupRetention||20),settings);}
  return { name, createdAt: payload.createdAt, label };
}
async function listStateSnapshots() {
  await fs.mkdir(BACKUPS_DIR, { recursive: true, mode: 0o700 });
  try { await fs.chmod(BACKUPS_DIR, 0o700); } catch {}
  const rows = [];
  for (const name of await fs.readdir(BACKUPS_DIR)) {
    if (!name.endsWith(".json")) continue;
    try { const filePath=path.join(BACKUPS_DIR,name),stat=await fs.stat(filePath),payload=JSON.parse(await fs.readFile(filePath,"utf8"));rows.push({name,createdAt:payload.createdAt||stat.mtime.toISOString(),label:payload.label||"snapshot",size:stat.size}); } catch {}
  }
  return rows.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function validatedRecoveryCandidate(filePath, source) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    const envelope = (source === "previous" || source === "mirror") ? raw : raw?.envelope;
    if (!envelope?.initialized || !envelope?.db) return null;
    const db = upgradeServerDbRespectingReset(structuredClone(envelope.db));
    validateServerState(db);
    const stat = await fs.stat(filePath);
    return { source, filePath, envelope: { initialized: true, updatedAt: envelope.updatedAt || stat.mtime.toISOString(), db }, mtimeMs: stat.mtimeMs };
  } catch { return null; }
}

async function recoverCorruptState() {
  const candidates = [];
  const mirror = await validatedRecoveryCandidate(STATE_MIRROR_FILE, "mirror");
  if (mirror) candidates.push(mirror);
  const prev = await validatedRecoveryCandidate(STATE_PREVIOUS_FILE, "previous");
  if (prev) candidates.push(prev);
  try {
    for (const row of await listStateSnapshots()) {
      const item = await validatedRecoveryCandidate(path.join(BACKUPS_DIR, row.name), `backup:${row.name}`);
      if (item) candidates.push(item);
    }
  } catch {}
  candidates.sort((a,b)=>b.mtimeMs-a.mtimeMs);
  const chosen = candidates[0];
  if (!chosen) {
    await appendRecoveryLog({ type: "recovery_failed", reason: "no_valid_candidate" });
    const error = new Error("فایل اطلاعات اصلی سامانه آسیب دیده و هیچ نسخه پشتیبان سالمی برای بازیابی پیدا نشد؛ سرویس برای جلوگیری از از دست رفتن داده متوقف شد.");
    error.code = "STATE_RECOVERY_UNAVAILABLE";
    throw error;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantine = path.join(DATA_DIR, `state.corrupt-${stamp}-${crypto.randomBytes(3).toString("hex")}.json`);
  try { await fs.rename(STATE_FILE, quarantine); } catch {}
  await atomicWriteText(STATE_FILE, JSON.stringify(chosen.envelope), 0o600);
  await appendRecoveryLog({ type: "state_auto_recovered", source: chosen.source, quarantine: path.basename(quarantine), updatedAt: chosen.envelope.updatedAt });
  return chosen.envelope;
}
function isoWeekKeyV4515(date=new Date()) {const d=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()));const day=d.getUTCDay()||7;d.setUTCDate(d.getUTCDate()+4-day);const y0=new Date(Date.UTC(d.getUTCFullYear(),0,1));const week=Math.ceil((((d-y0)/86400000)+1)/7);return `${d.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;}
async function maybeCreateTieredBackupsV4515() {
  const current=await readStateEnvelope();if(!current.initialized||!current.db)return;
  const rows=await listStateSnapshots(),today=new Date().toISOString().slice(0,10),week=isoWeekKeyV4515();
  if(!rows.some(r=>r.label===`daily-${today}`))await createStateSnapshot(`daily-${today}`,{skipPrune:true});
  if(!rows.some(r=>r.label===`weekly-${week}`))await createStateSnapshot(`weekly-${week}`,{skipPrune:true});
  const st=current.db?.school?.settings||{};await pruneStateSnapshots(Number(st.backupRetention||20),st);
}
async function writeStateEnvelope(db, options = {}) {
  if (!db || typeof db !== "object") throw Object.assign(new Error("ساختار اطلاعات سامانه معتبر نیست."), { status: 400 });
  const now=Date.now(),intervalMinutes=Number(db?.school?.settings?.autoBackupMinutes||5);
  if(!options.skipSnapshot&&now-lastAutoSnapshotAt>=Math.max(1,intervalMinutes)*60000){try{const snapshot=await createStateSnapshot("auto");if(snapshot)lastAutoSnapshotAt=now;}catch(error){console.warn("Auto snapshot failed",error.message);}}
  db=upgradeServerDbRespectingReset(db);validateServerState(db);const envelope={initialized:true,updatedAt:new Date().toISOString(),db};
  // Keep an immediate last-known-good state before replacing the primary file.
  try { const current=await readStateEnvelope(); if(current?.initialized&&current?.db) await atomicWriteText(STATE_PREVIOUS_FILE, JSON.stringify(current), 0o600); }
  catch(error){ if(error?.code!=="STATE_DATA_CORRUPT") console.warn("Previous state snapshot failed",error.message); }
  await atomicWriteText(STATE_FILE,JSON.stringify(envelope),0o600);
  // Latest committed mirror gives zero-transaction RPO when only the primary state file is damaged.
  try{await atomicWriteText(STATE_MIRROR_FILE,JSON.stringify(envelope),0o600);}catch(error){console.warn("State mirror failed",error.message);}
  if(!options.skipTiered){try{await maybeCreateTieredBackupsV4515();}catch(error){console.warn("Tiered backup failed",error.message);}}
  return envelope;
}

async function handleLocalBackupApi(req, res, url, auth) {
  try {
    if (!["admin", "superadmin"].includes(auth.user.role)) throw Object.assign(new Error("مدیریت نسخه‌های پشتیبان فقط برای ادمین مجاز است."), { status: 403 });
    if (req.method === "GET" && url.pathname === "/api/admin/local-backups") return sendJson(res, 200, { backups: await listStateSnapshots() });
    if (req.method === "POST" && url.pathname === "/api/admin/local-backups") {
      const row = await createStateSnapshot("manual");
      await securityAudit({ type: "local_snapshot_create", userId: auth.user.id, role: auth.user.role, ip: clientIp(req), details: row?.name || "" });
      return sendJson(res, 200, { ok: true, backup: row, backups: await listStateSnapshots() });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/local-backups/restore") {
      const body = await readJson(req); const name = safeBackupName(body.name);
      const saved = await enqueueStateOperation(async () => {
        let payload;
        try { payload = JSON.parse(await fs.readFile(path.join(BACKUPS_DIR, name), "utf8")); }
        catch (error) { if(error?.code==="ENOENT") throw error; throw Object.assign(new Error("نسخه پشتیبان انتخاب‌شده خراب یا JSON نامعتبر است."), { status: 400 }); }
        if (payload.app !== "madreseyar-local-state" || !payload.envelope?.db) throw Object.assign(new Error("نسخه پشتیبان انتخاب‌شده معتبر نیست."), { status: 400 });
        const candidate=upgradeServerDbRespectingReset(structuredClone(payload.envelope.db)); validateServerState(candidate);
        await createStateSnapshot("before-restore");
        return writeStateEnvelope(candidate, { skipSnapshot: true });
      });
      await ensureSecurityInitialized(saved.db);
      await securityAudit({ type: "local_snapshot_restore", userId: auth.user.id, role: auth.user.role, ip: clientIp(req), details: name });
      return sendJson(res, 200, { ok: true, updatedAt: saved.updatedAt, db: scopedDbForStaff(saved.db, auth.user) });
    }
    return sendJson(res, 404, { error: "مسیر نسخه پشتیبان پیدا نشد." });
  } catch (error) {
    return sendJson(res, error.code === "ENOENT" ? 404 : error.status || 500, { error: error.code === "ENOENT" ? "نسخه پشتیبان پیدا نشد." : error.message });
  }
}

async function handleState(req, res, auth) {
  try {
    if (req.method === "GET") {
      const envelope = await ensureStateInitialized();
      await securityAudit({ type: "state_read", userId: auth.user.id, role: auth.user.role, ip: clientIp(req) });
      return sendJson(res, 200, { initialized: true, updatedAt: envelope.updatedAt, db: scopedDbForStaff(envelope.db, auth.user) });
    }
    const payload = await readJson(req); const incoming = payload.db, baseUpdatedAt = String(payload.baseUpdatedAt || "");
    if (!incoming || typeof incoming !== "object") throw Object.assign(new Error("ساختار اطلاعات معتبر نیست."), { status: 400 });
    if (!baseUpdatedAt) throw Object.assign(new Error("نسخه مبنای ذخیره مشخص نیست؛ ابتدا اطلاعات را دوباره از سرور دریافت کنید."), { status: 428, code: "STATE_PRECONDITION_REQUIRED" });
    const saved = await enqueueStateOperation(async () => {
      const latestEnvelope = await ensureStateInitialized();
      if (String(latestEnvelope.updatedAt || "") !== baseUpdatedAt) {
        const conflict = Object.assign(new Error("اطلاعات سامانه پس از آخرین دریافت شما تغییر کرده است؛ ذخیره برای جلوگیری از حذف تغییرات همزمان متوقف شد."), {
          status: 409, code: "STATE_CONFLICT",
          latestUpdatedAt: latestEnvelope.updatedAt,
          latestDb: scopedDbForStaff(latestEnvelope.db, auth.user)
        });
        throw conflict;
      }
      const latest = latestEnvelope.db;
      const next = auth.user.role === "teacher"
        ? mergeTeacherDb(latest, incoming, auth.user)
        : validateAdminState(latest, incoming, auth.user);
      return writeStateEnvelope(next);
    });
    const beforeUserIds=new Set((auth.db?.users||[]).map(u=>String(u.id)));
    const afterUsers=saved.db?.users||[];
    const securityNeedsSync=afterUsers.length!==beforeUserIds.size||afterUsers.some(u=>!beforeUserIds.has(String(u.id)));
    if(securityNeedsSync) await ensureSecurityInitialized(saved.db);
    await securityAudit({ type: "state_write", userId: auth.user.id, role: auth.user.role, ip: clientIp(req), details: "ذخیره تغییرات سامانه" });
    return sendJson(res, 200, { initialized: true, updatedAt: saved.updatedAt, db: scopedDbForStaff(saved.db, auth.user) });
  } catch (error) {
    return sendJson(res, error.status || 500, {
      error: error.message || "ذخیره اطلاعات ناموفق بود.",
      code: error.code || undefined,
      latestUpdatedAt: error.latestUpdatedAt || undefined,
      db: error.latestDb || undefined
    });
  }
}

async function handleFiles(req, res, pathname, auth) {
  try {
    await ensureDataDirs();
    if (pathname === "/api/files" && req.method === "GET") {
      const names = (await fs.readdir(FILES_DIR)).filter(name => name.endsWith(".json"));
      const records = [];
      for (const name of names) {
        try { records.push(JSON.parse(await fs.readFile(path.join(FILES_DIR, name), "utf8"))); } catch {}
      }
      let visible = records;
      if (auth.user.role === "teacher") {
        const scope = teacherScope(auth.db, auth.user);
        const allowedSubmissions = new Set((auth.db.submissions || []).filter(s => scope.examIds.has(s.examId) && scope.studentIds.has(s.studentId)).map(s => s.id));
        visible = records.filter(r => {
          if (r.submissionId) return allowedSubmissions.has(r.submissionId);
          if (r.studentId) return scope.studentIds.has(r.studentId);
          return false;
        });
      }
      return sendJson(res, 200, { records: visible });
    }
    if (pathname === "/api/files" && req.method === "POST") {
      const record = await readJson(req);
      const key = safeKey(record.key);
      const dataUrl = String(record.dataUrl || "");
      if (!/^data:(?:image\/(?:jpeg|png|webp)|application\/pdf);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl)) throw Object.assign(new Error("فقط تصویر JPG/PNG/WebP یا PDF معتبر قابل ذخیره است."), { status: 400 });
      const maxUploadMb = Number(auth.db?.school?.settings?.maxUploadMb || 12);
      const estimatedBytes = Math.ceil(dataUrl.slice(dataUrl.indexOf(",") + 1).length * 0.75);
      if (estimatedBytes > maxUploadMb * 1024 * 1024) throw Object.assign(new Error(`حجم فایل از سقف ${maxUploadMb} مگابایت بیشتر است.`), { status: 413 });
      const clean = { ...record, key, savedAt: Number(record.savedAt || Date.now()) };
      if (auth.user.role === "teacher") {
        const scope = teacherScope(auth.db, auth.user);
        if (clean.submissionId) {
          const submission = (auth.db.submissions || []).find(x => x.id === clean.submissionId);
          if (!submission || !scope.examIds.has(submission.examId) || !scope.studentIds.has(submission.studentId)) throw Object.assign(new Error("به این فایل دسترسی ندارید."), { status: 403 });
        } else if (clean.studentId) {
          if (!scope.studentIds.has(clean.studentId)) throw Object.assign(new Error("به پرونده این دانش‌آموز دسترسی ندارید."), { status: 403 });
        } else {
          throw Object.assign(new Error("ذخیره این نوع فایل برای حساب معلم مجاز نیست."), { status: 403 });
        }
      }
      await atomicWriteText(path.join(FILES_DIR, `${key}.json`), JSON.stringify(clean), 0o600);
      return sendJson(res, 200, { ok: true, key });
    }
    if (pathname === "/api/files" && req.method === "DELETE") {
      if (auth.user.role === "teacher") throw Object.assign(new Error("پاک‌کردن همه فایل‌ها فقط برای مدیر مجاز است."), { status: 403 });
      await fs.rm(FILES_DIR, { recursive: true, force: true });
      await fs.mkdir(FILES_DIR, { recursive: true, mode: 0o700 });
      try { await fs.chmod(FILES_DIR, 0o700); } catch {}
      return sendJson(res, 200, { ok: true });
    }
    const match = pathname.match(/^\/api\/files\/([a-zA-Z0-9_-]+)$/);
    if (!match) return sendJson(res, 404, { error: "فایل پیدا نشد." });
    const key = safeKey(match[1]);
    const filePath = path.join(FILES_DIR, `${key}.json`);
    const record = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (auth.user.role === "teacher") {
      const scope = teacherScope(auth.db, auth.user);
      if (record.submissionId) {
        const submission = (auth.db.submissions || []).find(x => x.id === record.submissionId);
        if (!submission || !scope.examIds.has(submission.examId) || !scope.studentIds.has(submission.studentId)) throw Object.assign(new Error("به این فایل دسترسی ندارید."), { status: 403 });
      } else if (record.studentId) {
        if (!scope.studentIds.has(record.studentId)) throw Object.assign(new Error("به پرونده این دانش‌آموز دسترسی ندارید."), { status: 403 });
      } else {
        throw Object.assign(new Error("به این فایل دسترسی ندارید."), { status: 403 });
      }
    }
    if (req.method === "GET") return sendJson(res, 200, record);
    if (req.method === "DELETE") { await fs.rm(filePath, { force: true }); return sendJson(res, 200, { ok: true }); }
    return sendJson(res, 405, { error: "روش درخواست پشتیبانی نمی‌شود." });
  } catch (error) {
    return sendJson(res, error.code === "ENOENT" ? 404 : error.status || 500, { error: error.code === "ENOENT" ? "فایل پیدا نشد." : error.message });
  }
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Permitted-Cross-Domain-Policies": "none",
    "Strict-Transport-Security": "max-age=15552000",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  };
}
function studentFrameHeaders() {
  const headers = { ...securityHeaders() };
  delete headers["X-Frame-Options"];
  headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://committees.javanrood.invalid";
  return headers;
}

// P67.19.3: ONLY the independent teacher exam-center page may be framed by
// this SAME origin. All other application pages retain X-Frame-Options: DENY
// and frame-ancestors 'none'. Does not broaden API or cross-origin access.
function p67193ExamCenterFrameHeaders() {
  const headers = { ...securityHeaders(), "X-Frame-Options": "SAMEORIGIN" };
  headers["Content-Security-Policy"] = headers["Content-Security-Policy"]
    .replace("frame-ancestors 'none'", "frame-ancestors 'self'");
  return headers;
}
function corsHeaders() {
  return {
    ...securityHeaders(),
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Language",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("حجم درخواست بیشتر از حد مجاز است."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("بدنه درخواست JSON معتبر نیست."), { status: 400 });
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function roundQuarter(value) {
  return Math.round(Number(value || 0) * 4) / 4;
}


function textList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || "").trim()).filter(Boolean);
  return String(value || "").split(/\r?\n|[|؛]/).map(item => item.trim()).filter(Boolean);
}

function normalizeRubricCriterion(raw, index, questionScore) {
  const item = typeof raw === "string" ? { title: raw } : { ...(raw || {}) };
  const title = String(item.title || item.criterion || item.name || `معیار ${index + 1}`).trim();
  let weightPercent = Number(item.weightPercent ?? item.weight_percent ?? item.weight ?? 0);
  let maxScore = Number(item.maxScore ?? item.max_score ?? item.score ?? 0);
  if (!weightPercent && maxScore && questionScore) weightPercent = maxScore / questionScore * 100;
  if (!maxScore && weightPercent && questionScore) maxScore = questionScore * weightPercent / 100;
  return {
    id: String(item.id || `criterion_${index + 1}`),
    title,
    criterion: String(item.criterion || title).trim(),
    weightPercent: Math.max(0, weightPercent),
    maxScore: roundQuarter(Math.max(0, maxScore)),
    score: roundQuarter(Math.max(0, maxScore)),
    examples: textList(item.examples || item.acceptableExamples || item.acceptable_examples),
    essential: item.essential !== false,
    teacherNote: String(item.teacherNote || item.teacher_note || "").trim()
  };
}

function normalizeMisconception(raw, index) {
  const item = typeof raw === "string" ? { text: raw } : { ...(raw || {}) };
  return {
    id: String(item.id || `misconception_${index + 1}`),
    text: String(item.text || item.misconception || item.title || "").trim(),
    penaltyPercent: clamp(item.penaltyPercent ?? item.penalty_percent ?? item.penalty ?? 0, 0, 100),
    examples: textList(item.examples || item.evidenceExamples || item.evidence_examples)
  };
}

function normalizeDescriptiveQuestion(raw) {
  const q = { ...(raw || {}) };
  q.text = String(q.text || q.question || "").trim();
  q.score = Number(q.score ?? q.maxScore ?? q.max_score ?? 0);
  q.referenceAnswer = String(q.referenceAnswer || q.reference_answer || q.answer || "").trim();
  q.acceptableAlternatives = textList(q.acceptableAlternatives || q.acceptable_alternatives);
  q.teacherNotes = String(q.teacherNotes || q.teacher_notes || q.teacherNote || "").trim();
  q.minimumConfidenceForAutoGrade = clamp(q.minimumConfidenceForAutoGrade ?? q.minimum_confidence_for_auto_grade ?? 0.85, 0, 1);
  q.gradingMode = String(q.gradingMode || q.grading_mode || "semantic_rubric");
  q.requireTeacherApproval = (q.requireTeacherApproval ?? q.teacherApprovalRequired ?? q.teacher_approval_required) !== false;
  let rubric = Array.isArray(q.rubric) ? q.rubric : Array.isArray(q.criteria) ? q.criteria : [];
  rubric = rubric.map((item, index) => normalizeRubricCriterion(item, index, q.score)).filter(item => item.title);
  if (!rubric.length && q.referenceAnswer) rubric = [normalizeRubricCriterion({ title: "پوشش پاسخ مرجع", weightPercent: 100 }, 0, q.score)];
  let totalWeight = rubric.reduce((sum, item) => sum + Number(item.weightPercent || 0), 0);
  if (!totalWeight && rubric.length) {
    const share = 100 / rubric.length;
    rubric = rubric.map(item => ({ ...item, weightPercent: share }));
    totalWeight = 100;
  }
  if (rubric.length && Math.abs(totalWeight - 100) > 0.01) {
    rubric = rubric.map(item => ({ ...item, weightPercent: item.weightPercent / totalWeight * 100 }));
  }
  rubric = rubric.map(item => {
    const maxScore = roundQuarter(q.score * item.weightPercent / 100);
    return { ...item, maxScore, score: maxScore };
  });
  // Keep the exact question total despite quarter rounding.
  if (rubric.length) {
    const delta = roundQuarter(q.score - rubric.reduce((sum, item) => sum + item.maxScore, 0));
    rubric[rubric.length - 1].maxScore = roundQuarter(rubric[rubric.length - 1].maxScore + delta);
    rubric[rubric.length - 1].score = rubric[rubric.length - 1].maxScore;
  }
  q.rubric = rubric;
  q.misconceptions = (Array.isArray(q.misconceptions) ? q.misconceptions : []).map(normalizeMisconception).filter(item => item.text);
  return q;
}

function normalizeTypedAnswers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, answer]) => [String(key), String(answer || "").trim()]).filter(([, answer]) => answer));
}




function guardianTokenSign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function guardianTokenVerify(token, secret) {
  try { const [body,sig]=String(token||"").split("."); if(!body||!sig)return null; const expected=crypto.createHmac("sha256",secret).update(body).digest("base64url"); if(!safeEqualText(sig,expected))return null; const p=JSON.parse(Buffer.from(body,"base64url").toString("utf8")); if(Number(p.exp||0)<Date.now())return null; return p; } catch { return null; }
}
function publicGuardianV4520(g){return g?{id:g.id,name:g.guardianName||g.name||"ولی دانش‌آموز",nationalId:g.nationalId||"",mobile:g.mobile||"",active:g.active!==false}:null;}
async function guardianAuth(req) {
  const authHeader=String(req.headers.authorization||"");
  const token=authHeader.startsWith("Bearer ")?authHeader.slice(7).trim():"";
  const security=await readSecurity();
  const claims=guardianTokenVerify(token,security.serverSecret);
  if(!claims||claims.kind!=="guardian")throw Object.assign(new Error("نشست ولی معتبر نیست."),{status:401});
  const env=await ensureStateInitialized();
  if(claims.guardianId){
    const guardian=(env.db.guardians||[]).find(g=>g.id===claims.guardianId&&g.active!==false);
    if(!guardian)throw Object.assign(new Error("حساب ولی غیرفعال شده است."),{status:403});
    const credential=security.guardianCredentials?.[guardian.id];
    if(!credential)throw Object.assign(new Error("اطلاعات امنیتی حساب ولی پیدا نشد."),{status:401});
    if(Number(claims.credentialVersion||0)!==Number(credential.credentialVersion||1))throw Object.assign(new Error("نشست ولی منقضی شده است؛ دوباره وارد شوید."),{status:401});
    const link=(env.db.guardianLinks||[]).find(x=>x.guardianId===guardian.id&&x.active!==false)||null;
    return {db:env.db,guardian,link,claims,credential,legacy:false};
  }
  // سازگاری با نشست‌ها و کدهای دسترسی نسخه‌های قبلی تا زمان مهاجرت حساب والدین.
  const link=(env.db.guardianLinks||[]).find(x=>x.id===claims.linkId&&x.active!==false);
  if(!link)throw Object.assign(new Error("دسترسی ولی غیرفعال شده است."),{status:403});
  return {db:env.db,guardian:null,link,claims,credential:null,legacy:true};
}
async function handleGuardianApi(req,res,url){
 try{
  if(req.method==="POST"&&url.pathname==="/api/guardian/login"){
    const body=await readJson(req);
    const guardianNid=normalizeNationalId(body.guardianNationalId||body.nationalId||body.identifier);
    const password=String(body.password||body.initialPassword||"");
    if(guardianNid||password){
      const rate=await loginRateStatus(req,`guardian:${guardianNid}`);
      if(rate.blocked)throw Object.assign(new Error(`تلاش‌های ناموفق زیاد بوده است؛ ${rate.retryAfter} ثانیه بعد دوباره امتحان کنید.`),{status:429});
      const env=await ensureStateInitialized();
      const guardian=(env.db.guardians||[]).find(g=>g.active!==false&&normalizeNationalId(g.nationalId)===guardianNid);
      const security=await readSecurity();
      const credential=guardian?security.guardianCredentials?.[guardian.id]:null;
      const ok=/^\d{10}$/.test(guardianNid)&&guardian&&credential&&await passwordVerify(password,credential.passwordHash);
      if(!ok){await recordLoginFailure(rate.key);await securityAudit({type:"guardian_login",success:false,ip:clientIp(req),details:"کد ملی ولی یا رمز عبور نادرست"});throw Object.assign(new Error("کد ملی ولی یا رمز عبور صحیح نیست."),{status:401});}
      await recordLoginSuccess(rate.key);
      const lifetime=process.env.NODE_ENV==="production"?7*24*60*60*1000:30*24*60*60*1000;
      const token=guardianTokenSign({kind:"guardian",guardianId:guardian.id,credentialVersion:Number(credential.credentialVersion||1),exp:Date.now()+lifetime},security.serverSecret);
      await mutateSecurity(sec=>{const c=sec.guardianCredentials?.[guardian.id];if(c){c.lastLoginAt=new Date().toISOString();c.lastLoginIp=clientIp(req);c.lastLoginUserAgent=String(req.headers["user-agent"]||"").slice(0,250);}});
      await securityAudit({type:"guardian_login",userId:guardian.id,role:"guardian",success:true,ip:clientIp(req),details:guardianNid});
      return sendJson(res,200,{token,guardian:publicGuardianV4520(guardian),mustChangePassword:Boolean(credential.mustChangePassword)});
    }
    // ورود قدیمی فقط برای حساب‌هایی که هنوز به مدل جدید مهاجرت نکرده‌اند.
    const nid=normalizeNationalId(body.studentNationalId),code=String(body.accessCode||"");
    const rate=await loginRateStatus(req,`guardian-legacy:${nid}`);
    if(rate.blocked)throw Object.assign(new Error(`تلاش‌های ناموفق زیاد بوده است؛ ${rate.retryAfter} ثانیه بعد دوباره امتحان کنید.`),{status:429});
    const env=await ensureStateInitialized();
    const student=(env.db.users||[]).find(u=>u.role==="student"&&normalizeNationalId(u.nationalId)===nid&&u.active!==false);
    const links=student?(env.db.guardianLinks||[]).filter(x=>x.studentId===student.id&&x.active!==false&&x.accessHash):[];
    let link=null; for(const item of links){if(await passwordVerify(code,item.accessHash)){link=item;break;}}
    if(!student||!link){await recordLoginFailure(rate.key);await securityAudit({type:"guardian_login",success:false,ip:clientIp(req),details:"اطلاعات ورود قدیمی خانواده نادرست"});throw Object.assign(new Error("اطلاعات ورود ولی صحیح نیست."),{status:401});}
    await recordLoginSuccess(rate.key); const security=await readSecurity(); const lifetime=process.env.NODE_ENV==="production"?7*24*60*60*1000:30*24*60*60*1000;
    const token=guardianTokenSign({kind:"guardian",linkId:link.id,studentId:student.id,exp:Date.now()+lifetime},security.serverSecret);
    await securityAudit({type:"guardian_login_legacy",userId:student.id,role:"guardian",success:true,ip:clientIp(req),details:link.id});
    return sendJson(res,200,{token,guardian:{name:link.guardianName,relation:link.relation},student:publicStudent(student,env.db),mustChangePassword:false,legacy:true});
  }
  const auth=await guardianAuth(req); const {db,guardian,link,credential,legacy}=auth;
  if(req.method==="POST"&&url.pathname==="/api/guardian/change-password"){
    if(legacy||!guardian||!credential)throw Object.assign(new Error("ابتدا حساب ولی را از مدرسه به مدل جدید ارتقا دهید."),{status:400});
    const body=await readJson(req),currentPassword=String(body.currentPassword||""),nextPassword=String(body.newPassword||"");const policy=guardianPasswordPolicy(nextPassword);if(policy)throw Object.assign(new Error(policy),{status:400});
    const changed=await mutateSecurity(async sec=>{sec.guardianCredentials||={};const c=sec.guardianCredentials[guardian.id];if(!c)throw Object.assign(new Error("حساب امنیتی ولی پیدا نشد."),{status:404});if(!await passwordVerify(currentPassword,c.passwordHash))return {error:"current"};if(await passwordVerify(nextPassword,c.passwordHash))return {error:"same"};c.passwordHash=await passwordHash(nextPassword);c.mustChangePassword=false;c.passwordChangedAt=new Date().toISOString();c.credentialVersion=Number(c.credentialVersion||1)+1;return {credentialVersion:c.credentialVersion};});
    if(changed.result?.error==="current")throw Object.assign(new Error("رمز فعلی ولی صحیح نیست."),{status:401});
    if(changed.result?.error==="same")throw Object.assign(new Error("رمز جدید باید با رمز قبلی متفاوت باشد."),{status:400});
    const lifetime=process.env.NODE_ENV==="production"?7*24*60*60*1000:30*24*60*60*1000;const token=guardianTokenSign({kind:"guardian",guardianId:guardian.id,credentialVersion:changed.result.credentialVersion,exp:Date.now()+lifetime},changed.security.serverSecret);
    await securityAudit({type:"guardian_password_change",userId:guardian.id,role:"guardian",success:true,ip:clientIp(req)});
    return sendJson(res,200,{ok:true,token,guardian:publicGuardianV4520(guardian),mustChangePassword:false});
  }
  if(!legacy&&credential?.mustChangePassword)throw Object.assign(new Error("برای ادامه، رمز اولیه را به رمز شخصی جدید تغییر دهید."),{status:428,code:"GUARDIAN_PASSWORD_CHANGE_REQUIRED"});
  const linkedIds=new Set(legacy?(db.guardianLinks||[]).filter(x=>x.guardianKey===link.guardianKey&&x.active!==false).map(x=>x.studentId):(db.guardianLinks||[]).filter(x=>x.guardianId===guardian.id&&x.active!==false).map(x=>x.studentId));
  if(req.method==="GET"&&url.pathname==="/api/guardian/continuous-p11"){
    const sid=String(url.searchParams.get("studentId")||""),eid=String(url.searchParams.get("examId")||"");
    if(!linkedIds.has(sid))throw Object.assign(new Error("دسترسی به این دانش‌آموز مجاز نیست."),{status:403});
    return sendJson(res,200,continuousP11(db,sid,eid));
  }
  if(req.method==="GET"&&url.pathname==="/api/guardian/student-analysis"){
    const sid=String(url.searchParams.get("studentId")||""),period=String(url.searchParams.get("period")||"month"),subject=String(url.searchParams.get("subject")||"").trim();if(!linkedIds.has(sid))throw Object.assign(new Error("دسترسی به این دانش‌آموز مجاز نیست."),{status:403});const analysis=academicAnalyticsV4518(db,sid,period,subject,{guardianOnly:true});if(!analysis)throw Object.assign(new Error("دانش‌آموز پیدا نشد."),{status:404});return sendJson(res,200,{ok:true,analysis});
  }
  if(req.method==="GET"&&url.pathname==="/api/guardian/student-dossier"){
    const sid=String(url.searchParams.get("studentId")||"");if(!linkedIds.has(sid))throw Object.assign(new Error("دسترسی به این دانش‌آموز مجاز نیست."),{status:403});const dossier=buildStudentDossierV4521(db,sid,{guardianOnly:true});if(!dossier)throw Object.assign(new Error("پرونده دانش‌آموز پیدا نشد."),{status:404});dossier.photoDataUrl=await readStudentProfilePhoto(sid);return sendJson(res,200,{ok:true,dossier});
  }
  if(req.method==="GET"&&url.pathname==="/api/guardian/attendance-day"){
    const sid=String(url.searchParams.get("studentId")||""),date=String(url.searchParams.get("date")||"").trim();
    if(!linkedIds.has(sid))throw Object.assign(new Error("دسترسی به این دانش‌آموز مجاز نیست."),{status:403});
    if(date&&!validSchoolDateV80(date))throw Object.assign(new Error("تاریخ حضور و غیاب معتبر نیست."),{status:400});
    const student=(db.users||[]).find(u=>u.id===sid&&u.role==="student"&&u.profileStatus!=="deleted");if(!student)throw Object.assign(new Error("دانش‌آموز پیدا نشد."),{status:404});
    return sendJson(res,200,{ok:true,attendance:guardianAttendanceDayV80(db,student,date)});
  }
  if(req.method==="GET"&&url.pathname==="/api/guardian/dashboard"){
    const activeYear=String(db.school?.year||"");
    const children=(db.users||[]).filter(u=>linkedIds.has(u.id)&&u.role==="student"&&u.profileStatus!=="deleted").map(s=>({student:publicStudent(s,db),attendance:attendanceSummaryForStudent(db,s.id),attendanceToday:guardianAttendanceDayV80(db,s,schoolClockV74().date),report:studentReport(db,s.id),termReport:studentTermReportV185(db,s.id,"semester2"),termReports:{semester1:studentTermReportV185(db,s.id,"semester1"),semester2:studentTermReportV185(db,s.id,"semester2"),annual:studentTermReportV185(db,s.id,"annual")},dailySnapshots:{semester1:stage09SnapshotForStudent(db,s.id,"semester1"),semester2:stage09SnapshotForStudent(db,s.id,"semester2")},riskSnapshots:{semester1:stage10RiskForStudent(db,s.id,"semester1"),semester2:stage10RiskForStudent(db,s.id,"semester2")},homework:(db.homework||[]).filter(h=>h.classId===s.classId&&String(h.academicYear||activeYear)===activeYear).slice().sort((a,b)=>String(b.createdAt||b.dueAt||"").localeCompare(String(a.createdAt||a.dueAt||""))).slice(0,20),homeworkSubmissions:(db.homeworkSubmissions||[]).filter(x=>x.studentId===s.id).slice(-30),progressReports:(db.progressReports||[]).filter(r=>r.studentId===s.id&&String(r.academicYear||activeYear)===activeYear&&r.status==="published"&&r.guardianVisible!==false).slice(-12),analysisSubjects:[...new Set((db.exams||[]).filter(e=>e.classId===s.classId&&String(e.academicYear||activeYear)===activeYear).map(e=>e.subject).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"fa")),notifications:(db.notifications||[]).filter(n=>n.userId===s.id).slice(0,20),weeklySchedule:(db.weeklySchedule||[]).filter(x=>x.active!==false&&x.classId===s.classId&&String(x.academicYear||activeYear)===activeYear).map(x=>{const row=publicOnlineScheduleEntryV74(db,x),t=(db.users||[]).find(u=>u.id===x.teacherId);return {...row,teacherName:t?`${t.firstName||""} ${t.lastName||""}`.trim():""};}),onlineLearning:publicOnlineSettingsV74(db),onlineClassSessions:(db.onlineClassSessions||[]).filter(x=>x.classId===s.classId&&String(x.academicYear||activeYear)===activeYear&&x.status!=="cancelled").map(x=>({id:x.id,scheduleEntryId:x.scheduleEntryId,subject:x.subject,date:x.date,periodNo:x.periodNo,status:x.status,deliveryMode:x.deliveryMode,meetingProvider:x.meetingProvider,meetingUrl:x.meetingUrl||""})),calendarEvents:publicCalendarForStudentV76(db,s),academicYearModel:publicActiveAcademicYearV76(db)}));
    const childIds=new Set(children.map(ch=>ch.student.id));
    const consentForms=(db.consentForms||[]).filter(c=>c.status==="active"&&String(c.academicYear||activeYear)===activeYear&&children.some(ch=>(!c.classId||ch.student.classId===c.classId)&&(!Array.isArray(c.studentIds)||!c.studentIds.length||c.studentIds.includes(ch.student.id)))).map(c=>({...c,responses:undefined,childResponses:children.filter(ch=>(!c.classId||ch.student.classId===c.classId)&&(!Array.isArray(c.studentIds)||!c.studentIds.length||c.studentIds.includes(ch.student.id))).map(ch=>({studentId:ch.student.id,response:(c.responses||[]).find(r=>r.studentId===ch.student.id)||null}))}));
    const requests=(db.parentRequests||[]).filter(r=>childIds.has(r.studentId)&&(legacy?!r.guardianId:r.guardianId===guardian?.id)).slice().sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||""))).slice(0,30);
    const guardianView=guardian?publicGuardianV4520(guardian):{name:link.guardianName,relation:link.relation}; return sendJson(res,200,{guardian:guardianView,children,consentForms,requests,academicYear:activeYear,serverTime:Date.now(),legacy});
  }
  if(req.method==="POST"&&url.pathname==="/api/guardian/consents/respond"){
    const b=await readJson(req),sid=String(b.studentId||""),consentId=String(b.consentId||""),decision=String(b.decision||""),note=String(b.note||"").trim();
    if(!linkedIds.has(sid))throw Object.assign(new Error("دسترسی به این دانش‌آموز مجاز نیست."),{status:403});
    if(!["approved","declined"].includes(decision))throw Object.assign(new Error("پاسخ رضایت‌نامه معتبر نیست."),{status:400});
    const guardianName=guardian?.guardianName||guardian?.name||link.guardianName||"ولی دانش‌آموز";
    const result=await mutateDb(m=>{const student=(m.users||[]).find(u=>u.id===sid&&u.role==="student");const activeYear=String(m.school?.year||"");const form=(m.consentForms||[]).find(x=>x.id===consentId&&x.status==="active"&&String(x.academicYear||activeYear)===activeYear&&(!x.classId||x.classId===student?.classId)&&(!Array.isArray(x.studentIds)||!x.studentIds.length||x.studentIds.includes(sid)));if(!form)throw Object.assign(new Error("رضایت‌نامه فعال پیدا نشد."),{status:404});form.responses=Array.isArray(form.responses)?form.responses:[];let response=form.responses.find(x=>x.studentId===sid);const payload={studentId:sid,guardianId:guardian?.id||null,decision,guardianName,note,respondedAt:faNow(),respondedAtIso:new Date().toISOString()};if(response)Object.assign(response,payload);else{response={id:makeId("consentresp"),...payload};form.responses.push(response);}m.audit||=[];m.audit.unshift({id:makeId("log"),userId:guardian?.id||sid,action:"ثبت پاسخ رضایت‌نامه توسط ولی",details:`${form.title||form.id} — ${decision}`,at:faNow()});return response;});
    return sendJson(res,200,{ok:true,response:result.result});
  }
  if(req.method==="POST"&&url.pathname==="/api/guardian/meeting-request"){
    const b=await readJson(req); const sid=String(b.studentId||""); if(!linkedIds.has(sid))throw Object.assign(new Error("دسترسی به این دانش‌آموز مجاز نیست."),{status:403}); const guardianName=guardian?.guardianName||guardian?.name||link.guardianName||"ولی دانش‌آموز";const r=await mutateDb(m=>{m.parentRequests||=[];const row={id:makeId("preq"),studentId:sid,guardianId:guardian?.id||null,guardianName,kind:"meeting",message:String(b.message||"").slice(0,1000),status:"open",academicYear:String(m.school?.year||""),createdAt:faNow()};m.parentRequests.unshift(row);return row;}); return sendJson(res,200,{ok:true,request:r.result});
  }
  return sendJson(res,404,{error:"مسیر خانواده پیدا نشد."});
 }catch(e){return sendJson(res,e.status||500,{error:e.message||"خطای خانواده",code:e.code||undefined});}
}
async function handleGuardianAdminApi(req,res,url,auth){
 try{
   if(!isAdminRole(auth.user.role))throw Object.assign(new Error("فقط ادمین مجاز است."),{status:403});
   if(req.method==="POST"&&url.pathname==="/api/admin/guardian-access"){
     const b=await readJson(req),studentId=String(b.studentId||""),guardianNid=normalizeNationalId(b.guardianNationalId),guardianName=String(b.guardianName||"").trim(),relation=String(b.relation||"ولی").trim()||"ولی",initialPassword=String(b.initialPassword||b.accessCode||"");
     if(!/^\d{10}$/.test(guardianNid))throw Object.assign(new Error("کد ملی ولی باید ۱۰ رقمی باشد."),{status:400});
     if(guardianName.length<3)throw Object.assign(new Error("نام و نام خانوادگی ولی را وارد کنید."),{status:400});
     if(initialPassword){const p=guardianPasswordPolicy(initialPassword);if(p)throw Object.assign(new Error(p),{status:400});}
     const currentSecurity=await readSecurity(); const existingGuardian=(auth.db.guardians||[]).find(g=>normalizeNationalId(g.nationalId)===guardianNid&&g.active!==false); const existingCred=existingGuardian?currentSecurity.guardianCredentials?.[existingGuardian.id]:null;
     if(!existingCred&&!initialPassword)throw Object.assign(new Error("برای ساخت حساب جدید ولی، رمز اولیه را وارد کنید."),{status:400});
     const saved=await mutateDb(m=>{
       const st=(m.users||[]).find(u=>u.id===studentId&&u.role==="student"&&u.profileStatus!=="deleted");if(!st)throw Object.assign(new Error("دانش‌آموز پیدا نشد."),{status:404});
       m.guardians=Array.isArray(m.guardians)?m.guardians:[];m.guardianLinks=Array.isArray(m.guardianLinks)?m.guardianLinks:[];
       let g=m.guardians.find(x=>normalizeNationalId(x.nationalId)===guardianNid);if(g)Object.assign(g,{guardianName,nationalId:guardianNid,active:true,updatedAt:faNow()});else{g={id:makeId("guardian"),guardianName,nationalId:guardianNid,mobile:normalizePhone(b.mobile||""),active:true,createdAt:faNow()};m.guardians.push(g);}
       let row=m.guardianLinks.find(x=>x.studentId===studentId&&(x.guardianId===g.id||normalizeNationalId(x.guardianKey)===guardianNid));if(row)Object.assign(row,{guardianId:g.id,guardianName,relation,guardianKey:g.id,active:true,updatedAt:faNow()});else{row={id:makeId("glink"),studentId,guardianId:g.id,guardianName,relation,guardianKey:g.id,active:true,createdAt:faNow()};m.guardianLinks.push(row);}
       m.audit=Array.isArray(m.audit)?m.audit:[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"ایجاد/اتصال حساب ولی",details:`${guardianName} · ${guardianNid} · ${studentId}`,at:faNow()});
       return {guardian:{...g},link:{...row,accessHash:undefined}};
     });
     const guardianId=saved.result.guardian.id;
     if(initialPassword||!currentSecurity.guardianCredentials?.[guardianId])await mutateSecurity(async sec=>{sec.guardianCredentials||={};const old=sec.guardianCredentials[guardianId]||{};sec.guardianCredentials[guardianId]={...old,passwordHash:await passwordHash(initialPassword),mustChangePassword:true,failedLoginCount:0,lockedUntil:0,passwordChangedAt:null,credentialVersion:Number(old.credentialVersion||0)+1};});
     await securityAudit({type:existingGuardian?"guardian_link_update":"guardian_account_create",userId:guardianId,role:"guardian",success:true,ip:clientIp(req),details:`student=${studentId}; reset=${Boolean(initialPassword)}`});
     return sendJson(res,200,{ok:true,guardian:publicGuardianV4520(saved.result.guardian),link:saved.result.link,passwordReset:Boolean(initialPassword),existingAccount:Boolean(existingGuardian)});
   }
   return sendJson(res,404,{error:"مسیر دسترسی خانواده پیدا نشد."});
 }catch(e){return sendJson(res,e.status||500,{error:e.message||"خطای دسترسی خانواده"});}
}


function profileChangeSummaryV76(before,after){
  const labels={firstName:"نام",lastName:"نام خانوادگی",birthDate:"تاریخ تولد",studentCode:"کد دانش‌آموزی",classId:"کلاس",studentMobile:"موبایل دانش‌آموز",guardianMobile:"موبایل ولی",homePhone:"تلفن منزل",emergencyGuardianName:"نام تماس اضطراری",emergencyGuardianRelation:"نسبت تماس اضطراری",emergencyGuardianMobile:"موبایل اضطراری",address:"نشانی",postalCode:"کدپستی",fatherName:"نام پدر",motherName:"نام مادر",placeOfBirth:"محل تولد",identityNumber:"شماره شناسنامه",adminNote:"یادداشت اداری"};
  const out=[];for(const key of Object.keys(labels)){if(String(before?.[key]??"")!==String(after?.[key]??""))out.push({field:key,label:labels[key],from:String(before?.[key]??""),to:String(after?.[key]??"")});}return out;
}
function publicAcademicYearCenterV76(db){
  const years=ensureAcademicYearModel(db.school||{}),current=years.find(y=>y.active)||years.find(y=>y.label===db.school?.year)||null;
  const enrollments=normalizeEnrollments(db);const year=String(db.school?.year||"");
  return {current,years,enrollmentStats:{active:enrollments.filter(x=>x.active!==false&&String(x.academicYear||"")===year).length,total:enrollments.length},calendarCount:(db.calendarEvents||[]).filter(x=>x.active!==false&&String(x.academicYear||year)===year).length};
}
function publicCalendarForStudentV76(db,student){
  const year=String(db.school?.year||"");
  return (db.calendarEvents||[]).map(x=>normalizeCalendarEvent(x,year)).filter(x=>x.active!==false&&String(x.academicYear||year)===year&&calendarAffectsStudent(x,student)).sort((a,b)=>String(a.startDate||"").localeCompare(String(b.startDate||""))||String(a.title||"").localeCompare(String(b.title||""),"fa")).map(x=>({id:x.id,title:x.title,type:x.type,startDate:x.startDate,endDate:x.endDate,scope:x.scope,grade:x.grade,classId:x.classId,note:x.note,blocksAttendance:x.blocksAttendance,blocksTeaching:x.blocksTeaching}));
}
function publicActiveAcademicYearV76(db){const years=ensureAcademicYearModel(db.school||{});return years.find(y=>y.active)||years.find(y=>y.label===db.school?.year)||null;}
async function handleAdminV76Api(req,res,url,auth){
  try{
    if(!["admin","superadmin"].includes(auth.user.role))throw Object.assign(new Error("این بخش فقط برای مدیر مجاز است."),{status:403});
    if(req.method==="GET"&&url.pathname==="/api/admin/v76/academic-year")return sendJson(res,200,{ok:true,...publicAcademicYearCenterV76(auth.db)});
    if(req.method==="POST"&&url.pathname==="/api/admin/v76/academic-year"){
      const body=await readJson(req);const currentLabel=String(auth.db.school?.year||"");const config=validateAcademicYearConfig(body,currentLabel);
      const saved=await mutateDb(m=>{m.school||={};m.school.academicYears=ensureAcademicYearModel(m.school);const index=m.school.academicYears.findIndex(y=>y.label===currentLabel);const old=index>=0?m.school.academicYears[index]:null;const row={...(old||{}),...config,label:currentLabel,active:true,status:"active",updatedAt:new Date().toISOString(),updatedBy:auth.user.id};if(index>=0)m.school.academicYears[index]=row;else m.school.academicYears.unshift(row);m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"تنظیم تقویم سال تحصیلی",details:`${currentLabel} · ${row.startDate||"—"} تا ${row.endDate||"—"}`,at:faNow()});return row;});
      return sendJson(res,200,{ok:true,current:saved.result,years:ensureAcademicYearModel(saved.db.school)});
    }
    if(req.method==="GET"&&url.pathname==="/api/admin/v76/calendar"){
      const year=String(url.searchParams.get("academicYear")||auth.db.school?.year||"");const rows=(auth.db.calendarEvents||[]).map(x=>normalizeCalendarEvent(x,year)).filter(x=>x.active!==false&&(!year||String(x.academicYear||year)===year)).sort((a,b)=>String(a.startDate).localeCompare(String(b.startDate))||String(a.title).localeCompare(String(b.title),"fa"));return sendJson(res,200,{ok:true,academicYear:year,events:rows});
    }
    if(req.method==="POST"&&url.pathname==="/api/admin/v76/calendar"){
      const body=await readJson(req);const row=validateCalendarEvent(body,auth.db);const saved=await mutateDb(m=>{m.calendarEvents=Array.isArray(m.calendarEvents)?m.calendarEvents:[];let current=body.id?m.calendarEvents.find(x=>x.id===String(body.id)):null;const payload={...row,id:current?.id||makeId("cal"),academicYear:String(row.academicYear||m.school?.year||""),createdAt:current?.createdAt||new Date().toISOString(),createdBy:current?.createdBy||auth.user.id,updatedAt:new Date().toISOString(),updatedBy:auth.user.id};if(current)Object.assign(current,payload);else{current=payload;m.calendarEvents.push(current);}m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"ثبت رویداد تقویم آموزشی",details:`${current.title} · ${current.startDate}${current.endDate!==current.startDate?` تا ${current.endDate}`:""}`,at:faNow()});return {...current};});return sendJson(res,200,{ok:true,event:saved.result});
    }
    const calendarDelete=url.pathname.match(/^\/api\/admin\/v76\/calendar\/([^/]+)$/);
    if(req.method==="DELETE"&&calendarDelete){const id=decodeURIComponent(calendarDelete[1]);const saved=await mutateDb(m=>{const row=(m.calendarEvents||[]).find(x=>x.id===id);if(!row)throw Object.assign(new Error("رویداد پیدا نشد."),{status:404});row.active=false;row.deletedAt=new Date().toISOString();row.deletedBy=auth.user.id;m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"حذف رویداد تقویم آموزشی",details:row.title||id,at:faNow()});return row;});return sendJson(res,200,{ok:true,event:saved.result});}
    if(req.method==="GET"&&url.pathname==="/api/admin/v76/calendar/check-date"){
      const date=String(url.searchParams.get("date")||"");const studentId=String(url.searchParams.get("studentId")||"");const student=studentId?(auth.db.users||[]).find(x=>x.id===studentId&&x.role==="student"):null;return sendJson(res,200,{ok:true,date,events:activeCalendarForDate(auth.db,date,student)});
    }
    if(req.method==="POST"&&url.pathname==="/api/admin/v76/student-profile"){
      const body=await readJson(req),studentId=String(body.studentId||"");const saved=await mutateDb(m=>{const st=(m.users||[]).find(x=>x.id===studentId&&x.role==="student"&&x.profileStatus!=="deleted");if(!st)throw Object.assign(new Error("دانش‌آموز پیدا نشد."),{status:404});const before={...st};const classId=String(body.classId ?? st.classId ?? "");if(classId&&!(m.school?.classes||[]).some(c=>c.id===classId&&c.active!==false))throw Object.assign(new Error("کلاس انتخاب‌شده معتبر نیست."),{status:400});const fields={firstName:String(body.firstName ?? st.firstName ?? "").trim().slice(0,80),lastName:String(body.lastName ?? st.lastName ?? "").trim().slice(0,100),birthDate:String(body.birthDate ?? st.birthDate ?? "").trim().slice(0,20),studentCode:String(body.studentCode ?? st.studentCode ?? "").trim().slice(0,40),classId,studentMobile:normalizePhone(body.studentMobile ?? st.studentMobile),guardianMobile:normalizePhone(body.guardianMobile ?? st.guardianMobile),homePhone:normalizePhone(body.homePhone ?? st.homePhone),emergencyGuardianName:String(body.emergencyGuardianName ?? st.emergencyGuardianName ?? "").trim().slice(0,120),emergencyGuardianRelation:String(body.emergencyGuardianRelation ?? st.emergencyGuardianRelation ?? "").trim().slice(0,60),emergencyGuardianMobile:normalizePhone(body.emergencyGuardianMobile ?? st.emergencyGuardianMobile),address:String(body.address ?? st.address ?? "").trim().slice(0,600),postalCode:normalizeNationalId(body.postalCode ?? st.postalCode).slice(0,10),fatherName:String(body.fatherName ?? st.fatherName ?? "").trim().slice(0,120),motherName:String(body.motherName ?? st.motherName ?? "").trim().slice(0,120),placeOfBirth:String(body.placeOfBirth ?? st.placeOfBirth ?? "").trim().slice(0,120),identityNumber:String(body.identityNumber ?? st.identityNumber ?? "").trim().slice(0,40),adminNote:String(body.adminNote ?? st.adminNote ?? "").trim().slice(0,1500)};Object.assign(st,fields,{profileUpdatedAt:new Date().toISOString(),profileUpdatedBy:auth.user.id});
        if(before.classId!==st.classId){const year=String(m.school?.year||"");m.enrollments=normalizeEnrollments(m);const enr=(m.enrollments||[]).find(e=>e.studentId===st.id&&String(e.academicYear||"")===year&&e.active!==false);if(enr){enr.previousClassId=enr.classId;enr.classId=st.classId;enr.updatedAt=new Date().toISOString();enr.updatedBy=auth.user.id;}}
        const cls=(m.school?.classes||[]).find(c=>c.id===st.classId);if(cls){st.grade=Number(cls.grade);const meta=gradeMeta(st.grade);st.gradeId=meta.id;st.gradeName=meta.name;}
        const changes=profileChangeSummaryV76(before,st);m.studentExtendedProfiles=Array.isArray(m.studentExtendedProfiles)?m.studentExtendedProfiles:[];const oldExtended=studentExtendedProfileV734(m,st.id),nextExtended=normalizeExtendedProfileV734(body.extendedProfile||oldExtended,st.id),extendedChanges=profileDiffV734(oldExtended,nextExtended);let extRow=m.studentExtendedProfiles.find(x=>x.studentId===st.id&&x.active!==false);if(!extRow){extRow={id:makeId("sprof"),studentId:st.id,active:true,createdAt:new Date().toISOString(),createdBy:auth.user.id};m.studentExtendedProfiles.unshift(extRow);}Object.assign(extRow,nextExtended,{updatedAt:new Date().toISOString(),updatedBy:auth.user.id});
        m.recordHistory=Array.isArray(m.recordHistory)?m.recordHistory:[];const allChanges=[...changes,...extendedChanges];if(allChanges.length)m.recordHistory.unshift({id:makeId("hist"),studentId:st.id,academicYear:String(m.school?.year||""),type:"profile_update",changes:allChanges,createdAt:new Date().toISOString(),createdBy:auth.user.id});m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"ویرایش پرونده حرفه‌ای دانش‌آموز",details:`${st.firstName||""} ${st.lastName||""} · ${allChanges.length} تغییر`,at:faNow()});return {student:publicStudent(st,m),extendedProfile:safeExtendedProfileV734(extRow,{includeSensitive:true}),profileCompleteness:profileCompletenessV734(m,st,extRow)};});return sendJson(res,200,{ok:true,...saved.result});
    }
    if(req.method==="POST"&&url.pathname==="/api/admin/v76/student-photo"){
      const body=await readJson(req),studentId=String(body.studentId||"");const st=(auth.db.users||[]).find(x=>x.id===studentId&&x.role==="student"&&x.profileStatus!=="deleted");if(!st)throw Object.assign(new Error("دانش‌آموز پیدا نشد."),{status:404});const record=await saveStudentProfilePhoto(studentId,body.dataUrl);await mutateDb(m=>{const target=(m.users||[]).find(x=>x.id===studentId);if(target){target.profilePhotoUpdatedAt=new Date().toISOString();target.profileUpdatedAt=target.profileUpdatedAt||target.profilePhotoUpdatedAt;}m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"بروزرسانی عکس پرونده دانش‌آموز",details:studentId,at:faNow()});return true;});return sendJson(res,200,{ok:true,key:record.key,updatedAt:new Date().toISOString()});
    }
    if(req.method==="POST"&&url.pathname==="/api/admin/v76/student-document"){
      const body=await readJson(req),studentId=String(body.studentId||"");const saved=await mutateDb(m=>{const st=(m.users||[]).find(x=>x.id===studentId&&x.role==="student"&&x.profileStatus!=="deleted");if(!st)throw Object.assign(new Error("دانش‌آموز پیدا نشد."),{status:404});m.studentDocuments=Array.isArray(m.studentDocuments)?m.studentDocuments:[];const title=String(body.title||"").trim().slice(0,160);if(!title)throw Object.assign(new Error("عنوان مدرک الزامی است."),{status:400});const row={id:makeId("sdoc"),studentId,title,documentType:String(body.documentType||"other").trim().slice(0,60),fileKey:String(body.fileKey||"").trim().slice(0,180),issuedAt:String(body.issuedAt||"").slice(0,20),expiresAt:String(body.expiresAt||"").slice(0,20),verificationStatus:["pending","verified","rejected"].includes(String(body.verificationStatus))?String(body.verificationStatus):"pending",verifiedAt:String(body.verificationStatus)==="verified"?new Date().toISOString():"",verifiedBy:String(body.verificationStatus)==="verified"?auth.user.id:"",note:String(body.note||"").trim().slice(0,1000),academicYear:String(m.school?.year||""),active:true,createdAt:new Date().toISOString(),createdBy:auth.user.id};m.studentDocuments.unshift(row);m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"افزودن مدرک پرونده دانش‌آموز",details:`${studentId} · ${title}`,at:faNow()});return row;});return sendJson(res,200,{ok:true,document:saved.result});
    }
    const docDelete=url.pathname.match(/^\/api\/admin\/v76\/student-document\/([^/]+)$/);
    if(req.method==="DELETE"&&docDelete){const id=decodeURIComponent(docDelete[1]);const saved=await mutateDb(m=>{const row=(m.studentDocuments||[]).find(x=>x.id===id&&x.active!==false);if(!row)throw Object.assign(new Error("مدرک پیدا نشد."),{status:404});row.active=false;row.deletedAt=new Date().toISOString();row.deletedBy=auth.user.id;m.audit||=[];m.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"حذف مدرک پرونده دانش‌آموز",details:row.title||id,at:faNow()});return row;});return sendJson(res,200,{ok:true,document:saved.result});}
    return sendJson(res,404,{error:"مسیر مدیریت آموزشی نسخه 72.26 پیدا نشد."});
  }catch(error){return sendJson(res,error.status||500,{error:error.message||"خطای مدیریت آموزشی",code:error.code||undefined});}
}


function classGradeV4515Server(db,classId){return Number((db.school?.classes||[]).find(c=>c.id===classId)?.grade||0);}
function destinationClassV4515Server(db,fromClassId,toGrade){const classes=(db.school?.classes||[]).filter(c=>c.active!==false&&Number(c.grade)===Number(toGrade));if(!classes.length)return null;const from=(db.school?.classes||[]).find(c=>c.id===fromClassId),suffix=String(from?.name||"").split(/[-–—]/).pop().trim();return classes.find(c=>String(c.name||"").endsWith(suffix))||classes[0];}
function rolloverPreviewV4515(db,newYear){const activeStudents=(db.users||[]).filter(u=>u.role==="student"&&u.active!==false&&u.profileStatus!=="deleted"),rows=[];for(const s of activeStudents){const g=Number(s.grade||classGradeV4515Server(db,s.classId));if(g===7||g===8){const dest=destinationClassV4515Server(db,s.classId,g+1);rows.push({studentId:s.id,name:`${s.firstName||""} ${s.lastName||""}`.trim(),fromGrade:g,toGrade:g+1,fromClassId:s.classId,toClassId:dest?.id||"",toClassName:dest?.name||"بدون کلاس مقصد",action:dest?"promote":"blocked"});}else if(g===9)rows.push({studentId:s.id,name:`${s.firstName||""} ${s.lastName||""}`.trim(),fromGrade:9,toGrade:null,fromClassId:s.classId,toClassId:"",toClassName:"فارغ‌التحصیل",action:"graduate"});}return {fromYear:db.school?.year||"",newYear,students:rows,blocked:rows.filter(r=>r.action==="blocked").length,promote:rows.filter(r=>r.action==="promote").length,graduate:rows.filter(r=>r.action==="graduate").length};}
async function handleAdminV4515Api(req,res,url,auth){
 try{if(!["admin","superadmin"].includes(auth.user.role))throw Object.assign(new Error("این بخش فقط برای ادمین مجاز است."),{status:403});
  if(req.method==="GET"&&url.pathname==="/api/admin/v4515/audit"){const limit=Math.min(2000,Math.max(50,Number(url.searchParams.get("limit")||500)));return sendJson(res,200,{activity:(auth.db.audit||[]).slice(0,limit),security:await readSecurityAudit(limit)});}
  if(req.method==="POST"&&url.pathname==="/api/admin/v4515/academic-rollover"){
    const body=await readJson(req),newYear=String(body.newYear||"").trim();if(newYear.length<5||newYear.length>30)throw Object.assign(new Error("عنوان سال تحصیلی جدید معتبر نیست."),{status:400});const preview=rolloverPreviewV4515(auth.db,newYear);if(body.preview!==false)return sendJson(res,200,{preview});if(preview.blocked)throw Object.assign(new Error("برای بعضی دانش‌آموزان کلاس مقصد تعریف نشده است."),{status:400});
    const saved=await enqueueStateOperation(async()=>{const latest=(await ensureStateInitialized()).db,livePreview=rolloverPreviewV4515(latest,newYear),oldYear=latest.school.year||"";
      for(const key of ["attendanceSessions","attendance","onlineClassSessions","onlineJoinEvents","homework","homeworkSubmissions","continuousAssessments","behaviorRecords","interventions","lessonLogs","consentForms","progressReports","termGrades","exams","submissions","grades","appeals"]){
        if(!Array.isArray(latest[key]))continue;
        latest[key]=latest[key].map(row=>row&&typeof row==="object"&&!row.academicYear?{...row,academicYear:oldYear}:row);
      }
      await createStateSnapshot(`before-year-rollover-${String(oldYear).replace(/[^0-9A-Za-z_-]/g,"-")}`);
      latest.yearArchives=Array.isArray(latest.yearArchives)?latest.yearArchives:[];
      const gp=gradingPolicyV200(latest),oldEnrollments=(latest.enrollments||[]).filter(e=>String(e.academicYear||oldYear)===oldYear).map(e=>({...e}));
      latest.yearArchives.unshift({id:makeId("yeararc"),label:oldYear,closedAt:new Date().toISOString(),closedBy:auth.user.id,gradingPolicy:{mode:gp.mode,continuousWeight:gp.continuousWeight,finalWeight:gp.finalWeight,scoreScale:gp.scoreScale},summary:{students:(latest.users||[]).filter(u=>u.role==="student"&&u.active!==false).length,exams:(latest.exams||[]).filter(e=>!e.academicYear||e.academicYear===oldYear).length,grades:(latest.grades||[]).length,enrollments:oldEnrollments.length},classes:(latest.school?.classes||[]).map(c=>({id:c.id,name:c.name,grade:c.grade,gradeName:c.gradeName||""})),enrollments:oldEnrollments});
      const rolloverAt=new Date().toISOString();
      for(const row of livePreview.students){
        const st=latest.users.find(u=>u.id===row.studentId);if(!st)continue;
        if(row.action==="promote"){
          const dest=(latest.school.classes||[]).find(c=>c.id===row.toClassId);if(!dest)continue;
          closeAndCreateEnrollment({db:latest,student:st,oldYear,newYear,toClassId:dest.id,action:"promote",nowIso:rolloverAt});
          st.classId=dest.id;st.grade=Number(dest.grade);const meta=gradeMeta(st.grade);st.gradeId=meta.id;st.gradeName=meta.name;st.academicYear=newYear;st.profileStatus="active";st.active=true;
        }else if(row.action==="graduate"){
          closeAndCreateEnrollment({db:latest,student:st,oldYear,newYear,toClassId:"",action:"graduate",nowIso:rolloverAt});
          st.active=false;st.profileStatus="graduated";st.graduatedAt=rolloverAt;st.graduationYear=oldYear;
        }
      }
      latest.school.academicYears=ensureAcademicYearModel(latest.school);
      for(const y of latest.school.academicYears){y.active=false;if(y.label===oldYear){y.status="closed";y.closedAt=rolloverAt;y.closedBy=auth.user.id;}}
      latest.school.year=newYear;
      let next=latest.school.academicYears.find(y=>y.label===newYear);
      if(!next){next={id:makeId("year"),label:newYear,active:true,status:"active",createdAt:faNow(),terms:[{id:"semester1",title:"نیم‌سال اول",status:"active",startDate:"",endDate:""},{id:"semester2",title:"نیم‌سال دوم",status:"planned",startDate:"",endDate:""}]};latest.school.academicYears.unshift(next);}else{next.active=true;next.status="active";next.closedAt="";next.closedBy="";}
      latest.school.academicYears=ensureAcademicYearModel(latest.school);
      latest.enrollments=normalizeEnrollments(latest);
      latest.audit.unshift({id:makeId("log"),userId:auth.user.id,action:"بستن سال تحصیلی و ارتقای دانش‌آموزان",details:`${oldYear} -> ${newYear}; ارتقا ${livePreview.promote}; فارغ‌التحصیل ${livePreview.graduate}`,at:faNow()});return writeStateEnvelope(latest,{skipSnapshot:true});});
    await securityAudit({type:"academic_year_rollover",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:`${preview.fromYear}->${newYear}`});return sendJson(res,200,{ok:true,preview,db:scopedDbForStaff(saved.db,auth.user)});
  }
  return sendJson(res,404,{error:"مسیر مدیریتی نسخه 45.15 پیدا نشد."});
 }catch(error){return sendJson(res,error.status||500,{error:error.message||"خطای مدیریت نسخه 45.15"});}
}


async function releaseDiagnostics(db){
 const health=await systemHealthSnapshot(db); const required=["users","curriculum","exams","questionBank","attendance","homework","guardianLinks","reportCards","assets","migrationHistory"]; const schema=Object.fromEntries(required.map(k=>[k,Array.isArray(db[k])])); return {version:APP_VERSION,release:APP_RELEASE,ok:health.integrity.ok&&Object.values(schema).every(Boolean),schema,health,policies:db.systemPolicies,releaseInfo:db.releaseInfo,time:new Date().toISOString()};
}
async function handleReleaseApi(req,res,url,auth){
 try{if(!["admin","superadmin"].includes(auth.user.role))throw Object.assign(new Error("فقط ادمین مجاز است."),{status:403});
   if(req.method==="GET"&&url.pathname==="/api/admin/release-diagnostics")return sendJson(res,200,await releaseDiagnostics(auth.db));
   if(req.method==="POST"&&url.pathname==="/api/admin/encrypted-backup/export"){const b=await readJson(req),pass=String(b.passphrase||"");if(pass.length<10)throw Object.assign(new Error("عبارت رمز باید حداقل ۱۰ نویسه باشد."),{status:400});const env=await ensureStateInitialized(),sec=await readSecurity();const securityBackup={version:sec.version,credentialPresetVersion:sec.credentialPresetVersion,serverSecret:sec.serverSecret,credentials:sec.credentials,guardianCredentials:sec.guardianCredentials,createdAt:sec.createdAt};const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),key=await scryptAsync(pass,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024}),cipher=crypto.createCipheriv("aes-256-gcm",key,iv);const plain=Buffer.from(JSON.stringify({app:"madreseyar-encrypted-backup",version:APP_VERSION,createdAt:new Date().toISOString(),db:env.db,security:securityBackup}),"utf8");const enc=Buffer.concat([cipher.update(plain),cipher.final()]),tag=cipher.getAuthTag();return sendJson(res,200,{app:"madreseyar-aes-gcm",version:APP_VERSION,kdf:"scrypt",salt:salt.toString("base64"),iv:iv.toString("base64"),tag:tag.toString("base64"),payload:enc.toString("base64")});}
   if(req.method==="POST"&&url.pathname==="/api/admin/encrypted-backup/restore"){const b=await readJson(req),pass=String(b.passphrase||""),pack=b.package;if(pass.length<10)throw Object.assign(new Error("عبارت رمز باید حداقل ۱۰ نویسه باشد."),{status:400});if(!pack||pack.app!=="madreseyar-aes-gcm"||!pack.salt||!pack.iv||!pack.tag||!pack.payload)throw Object.assign(new Error("بسته پشتیبان معتبر نیست."),{status:400});let parsed;try{const salt=Buffer.from(pack.salt,"base64"),iv=Buffer.from(pack.iv,"base64"),tag=Buffer.from(pack.tag,"base64"),key=await scryptAsync(pass,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024}),dec=crypto.createDecipheriv("aes-256-gcm",key,iv);dec.setAuthTag(tag);const plain=Buffer.concat([dec.update(Buffer.from(pack.payload,"base64")),dec.final()]);parsed=JSON.parse(plain.toString("utf8"));}catch{throw Object.assign(new Error("عبارت رمز یا فایل پشتیبان صحیح نیست."),{status:400});}if(!parsed?.db)throw Object.assign(new Error("داده پشتیبان ناقص است."),{status:400});const saved=await enqueueStateOperation(async()=>{await createStateSnapshot("before-encrypted-restore");return writeStateEnvelope(upgradeServerDbRespectingReset(parsed.db),{skipSnapshot:true});});if(parsed.security&&validSecurityShape(parsed.security)){const restoredSecurity={...parsed.security,sessions:{},examGrants:{}};await writeSecurity(restoredSecurity);}await ensureSecurityInitialized(saved.db);await securityAudit({type:"encrypted_backup_restore",userId:auth.user.id,role:auth.user.role,ip:clientIp(req),details:`version ${saved.db.version}`});return sendJson(res,200,{ok:true,version:saved.db.version,updatedAt:saved.updatedAt});}
   return sendJson(res,404,{error:"مسیر انتشار پیدا نشد."});
 }catch(e){return sendJson(res,e.status||500,{error:e.message||"خطای انتشار"});}
}

function isPublicStaticPath(urlPath) {
  const value = String(urlPath || "/");
  if (["/", "/index.html", "/styles.css", "/app.js", "/continuous-p11.js"].includes(value)) return true;
  return ["/assets/", "/student/", "/guardian/", "/teacher/", "/attendance/", "/shared/"].some(prefix => value.startsWith(prefix));
}

async function serveStatic(req, res, urlPath) {
  if (!isPublicStaticPath(urlPath)) return sendJson(res, 404, { error: "فایل پیدا نشد." });
  const requested = urlPath === "/" ? "/index.html" : urlPath.endsWith("/") ? `${urlPath}index.html` : urlPath;
  let decoded;
  try { decoded = decodeURIComponent(requested); }
  catch { return sendJson(res, 400, { error: "آدرس درخواست معتبر نیست." }); }
  const normalizedUrlPath = path.posix.normalize(String(decoded).replace(/\\/g, "/"));
  if (!isPublicStaticPath(normalizedUrlPath)) return sendJson(res, 404, { error: "فایل پیدا نشد." });
  const relativePath = normalizedUrlPath.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT, relativePath);
  const rootPrefix = `${path.resolve(ROOT)}${path.sep}`;
  if (filePath !== path.resolve(ROOT) && !filePath.startsWith(rootPrefix)) return sendJson(res, 403, { error: "دسترسی غیرمجاز" });
  try {
    const data = await fs.readFile(filePath);
    const staticHeaders = normalizedUrlPath === "/shared/p635-teacher.html"
      ? p67193ExamCenterFrameHeaders()
      : normalizedUrlPath.startsWith("/student/") ? studentFrameHeaders() : securityHeaders();
    res.writeHead(200, { ...staticHeaders, "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    if (req.method === "HEAD") return res.end();
    res.end(data);
  } catch (error) {
    if (error?.code === "EACCES") return sendJson(res, 403, { error: "دسترسی غیرمجاز" });
    return sendJson(res, 404, { error: "فایل پیدا نشد." });
  }
}

function stripConfiguredBasePath(pathname) {
  const value = String(pathname || "/");
  if (!APP_BASE_PATH) return value;
  if (value === APP_BASE_PATH) return "/";
  if (value.startsWith(`${APP_BASE_PATH}/`)) return value.slice(APP_BASE_PATH.length) || "/";
  return value;
}


// p62 — protected digital library. Files live under DATA_DIR, never public static.
const P62_DIR=path.join(DATA_DIR,'library-p62');
const P62_TYPES={'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png','image/webp':'webp','text/plain':'txt'};
function p62Err(message,status=400){return Object.assign(new Error(message),{status});}
function p62Visible(db,user,row){if(row.active===false)return false;if(user.role==='student')return String(row.classId)===String(user.classId);if(['admin','superadmin'].includes(user.role))return true;return teacherCanAssigned(db,user,{classId:row.classId,subject:row.subject});}
function p62Meta(row){const {dataUrl,...rest}=row;return rest;}
async function handleLibraryP62(req,res,url){
 try{
  const auth=await authenticate(req,['student','teacher','admin','superadmin']);const db=auth.db,user=auth.user;
  const staff=user.role!=='student';
  if(req.method==='GET'&&url.pathname==='/api/library/p62/assignments'){
   if(!staff)throw p62Err('دسترسی غیرمجاز',403);
   const assignments=activeTeachingAssignments(db,user).filter(a=>a.active!==false).map(a=>({classId:a.classId,subject:a.subject||'',className:(db.school?.classes||[]).find(c=>c.id===a.classId)?.name||a.classId})).filter(a=>a.classId&&a.subject);
   if(['admin','superadmin'].includes(user.role))for(const cls of db.school?.classes||[])for(const sub of (db.school?.subjects||[])){const name=typeof sub==='string'?sub:sub.name||sub.title;if(name&&!assignments.some(a=>a.classId===cls.id&&a.subject===name))assignments.push({classId:cls.id,subject:name,className:cls.name||cls.id});}
   return sendJson(res,200,{ok:true,assignments});
  }
  if(req.method==='GET'&&url.pathname==='/api/library/p62/list'){
   return sendJson(res,200,{ok:true,items:(db.libraryP62||[]).filter(r=>p62Visible(db,user,r)).map(p62Meta).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))});
  }
  if(req.method==='POST'&&url.pathname==='/api/library/p62/create'){
   if(!staff)throw p62Err('فقط معلم یا مدیر می‌تواند جزوه منتشر کند.',403);
   const b=await readJson(req),classId=String(b.classId||''),subject=String(b.subject||'').trim(),title=String(b.title||'').trim().slice(0,140),description=String(b.description||'').trim().slice(0,600);
   if(!title||!classId||!subject)throw p62Err('عنوان، کلاس و درس الزامی است.');
   if(!(db.school?.classes||[]).some(c=>c.id===classId))throw p62Err('کلاس معتبر نیست.');
   if(!teacherCanAssigned(db,user,{classId,subject}))throw p62Err('این درس و کلاس به شما تخصیص داده نشده است.',403);
   const mime=String(b.mime||'').toLowerCase();if(!P62_TYPES[mime])throw p62Err('فقط PDF، تصویر یا متن ساده مجاز است.');
   const encoded=String(b.data||'');if(!encoded||encoded.length>17*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw p62Err('فایل معتبر نیست یا حجم آن بیش از حد مجاز است.',413);
   const bytes=Buffer.from(encoded,'base64');if(bytes.length>12*1024*1024||bytes.length<1)throw p62Err('حجم فایل باید کمتر از ۱۲ مگابایت باشد.',413);
   if(mime==='application/pdf'&&bytes.subarray(0,5).toString()!=='%PDF-')throw p62Err('ساختار فایل PDF معتبر نیست.');
   if(mime==='image/png'&&bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw p62Err('تصویر PNG معتبر نیست.');
   if(mime==='image/jpeg'&&bytes.subarray(0,3).toString('hex')!=='ffd8ff')throw p62Err('تصویر JPEG معتبر نیست.');
   if(mime==='image/webp'&&bytes.subarray(0,4).toString()!=='RIFF')throw p62Err('تصویر WebP معتبر نیست.');
   const id=makeId('lib62'),fileName=id+'.'+P62_TYPES[mime];await fs.mkdir(P62_DIR,{recursive:true,mode:0o700});
   await fs.writeFile(path.join(P62_DIR,fileName),bytes,{flag:'wx',mode:0o600});
   try{const saved=await mutateDb(m=>{m.libraryP62=Array.isArray(m.libraryP62)?m.libraryP62:[];const row={id,classId,subject,title,description,mime,fileName,size:bytes.length,originalName:String(b.name||'').replace(/[\\/]/g,'').slice(0,120),createdBy:user.id,teacherName:[user.firstName,user.lastName].filter(Boolean).join(' '),createdAt:new Date().toISOString(),active:true};m.libraryP62.unshift(row);return row;});return sendJson(res,200,{ok:true,item:p62Meta(saved.result)});}catch(e){await fs.rm(path.join(P62_DIR,fileName),{force:true});throw e;}
  }
  const match=url.pathname.match(/^\/api\/library\/p62\/(file|item)\/([a-zA-Z0-9_-]+)$/);
  if(match){const row=(db.libraryP62||[]).find(r=>r.id===match[2]&&r.active!==false);if(!row)throw p62Err('جزوه پیدا نشد.',404);if(!p62Visible(db,user,row))throw p62Err('اجازه دسترسی به جزوه را ندارید.',403);
   if(match[1]==='item'&&req.method==='PATCH'){
    if(!staff||(!['admin','superadmin'].includes(user.role)&&row.createdBy!==user.id))throw p62Err('فقط منتشرکننده می‌تواند جزوه را ویرایش کند.',403);
    const b=await readJson(req),title=String(b.title||'').trim().slice(0,140);if(!title)throw p62Err('عنوان الزامی است.');const saved=await mutateDb(m=>{const r=(m.libraryP62||[]).find(x=>x.id===row.id);r.title=title;r.description=String(b.description||'').trim().slice(0,600);return r;});return sendJson(res,200,{ok:true,item:p62Meta(saved.result)});
   }
   if(match[1]==='item'&&req.method==='DELETE'){
    if(!staff||(!['admin','superadmin'].includes(user.role)&&row.createdBy!==user.id))throw p62Err('فقط منتشرکننده می‌تواند جزوه را حذف کند.',403);
    await mutateDb(m=>{const r=(m.libraryP62||[]).find(x=>x.id===row.id);r.active=false;r.deletedAt=new Date().toISOString();return true;});return sendJson(res,200,{ok:true});
   }
   if(match[1]==='file'&&req.method==='GET'){
    if(!P62_TYPES[row.mime]||row.fileName!==row.id+'.'+P62_TYPES[row.mime])throw p62Err('فایل معتبر نیست.',400);
    let data;try{data=await fs.readFile(path.join(P62_DIR,row.fileName));}catch{throw p62Err('فایل روی سرور پیدا نشد.',404);}
    const filename=encodeURIComponent(row.originalName||row.title+'.'+P62_TYPES[row.mime]);res.writeHead(200,{...corsHeaders(),'Content-Type':row.mime,'Content-Length':data.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`${url.searchParams.get('download')==='1'?'attachment':'inline'}; filename*=UTF-8''${filename}`});return res.end(data);
   }
  }
  return sendJson(res,404,{error:'مسیر کتابخانه پیدا نشد.'});
 }catch(e){return sendJson(res,e.status||500,{error:e.message||'خطای کتابخانه'});}
}

// p63.5 — separate self-assessment domain; never reads/writes official exams, attempts, grades or homework.
async function handlePracticeCenterP635(req,res,url){
 try{
  const auth=await authenticate(req,['student','teacher','admin','superadmin']);
  const {user,db}=auth,year=String(db.school?.year||'');
  const fail=(msg,status=400)=>{throw Object.assign(new Error(msg),{status});};
  const isStudent=user.role==='student';
  const allowed=q=>q&&q.active!==false&&String(q.academicYear||year)===year&&(q.ownerType==='personal'?(isStudent&&q.ownerId===user.id):(isStudent?q.classId===user.classId:(user.role!=='teacher'||teacherCanAssigned(db,user,{classId:q.classId,subject:q.subject}))));
  // p64.6 — optional controls; older quizzes retain their original unrestricted behavior.
  const policy=q=>q?.ownerType==='teacher'?(q.practicePolicy||{}):{};
  const within=(q,now=Date.now())=>{const p=policy(q);return (!p.startAt||now>=Date.parse(p.startAt))&&(!p.endAt||now<Date.parse(p.endAt));};
  const attemptsFor=(q,uid)=> (db.p635Attempts||[]).filter(a=>a.quizId===q.id&&a.studentId===uid);
  const remaining=(q,uid)=>{const n=Number(policy(q).maxAttempts||0);return n?Math.max(0,n-attemptsFor(q,uid).length):null;};
  const visibleResult=(q)=>{const p=policy(q);return p.resultMode!=='afterEnd'||(p.endAt&&Date.now()>=Date.parse(p.endAt));};
  const qs=(db.p635Quizzes||[]).filter(allowed);
  if(req.method==='GET'&&url.pathname==='/api/p635/quizzes'){
   return sendJson(res,200,{quizzes:qs.map(q=>({id:q.id,title:q.title,subject:q.subject,chapter:q.chapter,ownerType:q.ownerType,questionCount:q.questions.length,createdAt:q.createdAt,attemptCount:(db.p635Attempts||[]).filter(a=>a.quizId===q.id&&a.studentId===user.id).length,practicePolicy:policy(q),canStart:within(q)&&remaining(q,user.id)!==0,remainingAttempts:remaining(q,user.id)})),subjects:(()=>{const cls=(db.school?.classes||[]).find(c=>c.id===user.classId),grade=Number(user.grade||cls?.grade||0),gradeId=String(cls?.gradeId||(db.school?.grades||[]).find(g=>Number(g.grade)===grade)?.id||'');const books=(db.curriculum||[]).filter(b=>b.active!==false&&(grade?(Number(b.grade)===grade||(gradeId&&String(b.gradeId||'')===gradeId)):false));const official=books.map(b=>String(b.subject||'').trim()).filter(Boolean);return [...new Set(official.length?official:(db.school?.subjects||[]).map(x=>String(x||'').trim()).filter(Boolean))];})(),subjectChapters:[...new Map((db.p635Questions||[]).filter(q=>q.active!==false&&String(q.academicYear||year)===year&&(q.scope==='public'||(q.scope==='class'&&q.classId===user.classId)||(q.createdBy===user.id))).map(q=>[q.subject+'\u0000'+(q.chapter||''),{subject:q.subject,chapter:q.chapter||''}])).values()]});
  }
  if(req.method==='GET'&&url.pathname==='/api/p635/history'){
   if(!isStudent)fail('فقط دانش‌آموز مجاز است.',403);
   return sendJson(res,200,{attempts:(db.p635Attempts||[]).filter(a=>a.studentId===user.id).map(a=>{const q=(db.p635Quizzes||[]).find(x=>x.id===a.quizId);return {id:a.id,quizId:a.quizId,title:a.title,subject:a.subject,score:q&&!visibleResult(q)?null:a.score,total:a.total,percent:q&&!visibleResult(q)?null:a.percent,submittedAt:a.submittedAt,details:q&&!visibleResult(q)?[]:a.details,resultPending:!!q&&!visibleResult(q)};}).reverse().slice(0,100)});
  }
  if(req.method==='GET'&&url.pathname==='/api/p635/assignments'){
   if(isStudent)fail('این بخش مخصوص کارکنان است.',403);
   const rows=user.role==='teacher'?(db.teachingAssignments||[]).filter(a=>a.teacherId===user.id&&teacherAssignmentIsActive(db,a)):(db.teachingAssignments||[]).filter(a=>teacherAssignmentIsActive(db,a));
   const classes=db.school?.classes||[];
   const unique=new Map();
   for(const a of rows){if(!a.classId||!a.subject)continue;const cls=classes.find(c=>c.id===a.classId);if(!cls)continue;const key=a.classId+'\u0000'+a.subject;unique.set(key,{classId:a.classId,className:String(cls.name||cls.title||cls.label||a.classId),subject:a.subject});}
   return sendJson(res,200,{assignments:[...unique.values()].sort((a,b)=>a.className.localeCompare(b.className,'fa')||a.subject.localeCompare(b.subject,'fa'))});
  }
  // p64.8 — small, validated embedded image for independent practice questions only.
  const p648Image = value => {
   if(value===null||value===undefined||value==='')return '';
   if(typeof value!=='string'||value.length>220000)fail('حجم تصویر بیش از حد مجاز است (حداکثر ۱۵۰ کیلوبایت).');
   const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
   if(!match)fail('فقط تصویر PNG، JPG یا WEBP مجاز است.');
   const bytes=Buffer.from(match[2],'base64');
   if(!bytes.length||bytes.length>150*1024)fail('حداکثر حجم تصویر ۱۵۰ کیلوبایت است.');
   const sig=bytes.subarray(0,16);
   const valid=match[1]==='png'?sig.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):match[1]==='jpeg'?(sig[0]===255&&sig[1]===216&&sig[2]===255):(sig.toString('ascii',0,4)==='RIFF'&&sig.toString('ascii',8,12)==='WEBP');
   if(!valid)fail('محتوای تصویر با فرمت انتخاب‌شده سازگار نیست.');
   return value;
  };
  // p64.9 — attachments restricted to the independent practice bank.
  const p649Attachment = value => {
   if(value===null||value===undefined||value==='')return null;
   if(!value||typeof value!=='object'||typeof value.name!=='string'||typeof value.data!=='string')fail('پیوست معتبر نیست.');
   const name=value.name.trim().slice(0,120);
   if(!name||/[\\/\x00-\x1f]/.test(name))fail('نام پیوست معتبر نیست.');
   const ext=name.split('.').pop().toLowerCase();
   const mime=ext==='pdf'?'application/pdf':ext==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'';
   if(!mime)fail('فقط PDF و DOCX مجاز است.');
   const prefix='data:'+mime+';base64,';
   if(!value.data.startsWith(prefix)||value.data.length>700000)fail('نوع یا حجم پیوست نامعتبر است.');
   const encoded=value.data.slice(prefix.length);
   if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))fail('ساختار پیوست نامعتبر است.');
   const bytes=Buffer.from(encoded,'base64');
   if(!bytes.length||bytes.length>500*1024)fail('پیوست باید حداکثر ۵۰۰ کیلوبایت باشد.');
   if(ext==='pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))fail('فایل PDF معتبر نیست.');
   if(ext==='docx'&&!(bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===0x03&&bytes[3]===0x04))fail('فایل DOCX معتبر نیست.');
   return {name,data:value.data};
  };
  if(req.method==='GET'&&url.pathname==='/api/p635/questions'){
   if(isStudent)fail('دسترسی به بانک سؤال مجاز نیست.',403);
   return sendJson(res,200,{questions:(db.p635Questions||[]).filter(q=>q.active!==false&&q.createdBy===user.id&&String(q.academicYear||year)===year).map(q=>({id:q.id,classId:q.classId,subject:q.subject,chapter:q.chapter,text:q.text,options:q.options,correctIndex:q.correctIndex,explanation:q.explanation||'',image:q.image||'',attachment:q.attachment||null,createdAt:q.createdAt}))});
  }
  if(req.method==='POST'&&url.pathname==='/api/p635/questions'){
   if(isStudent)fail('فقط معلم یا مدیر می‌تواند سؤال ثبت کند.',403);
   const b=await readJson(req),subject=String(b.subject||'').trim().slice(0,100),classId=String(b.classId||'').trim(),chapter=String(b.chapter||'').trim().slice(0,120),text=String(b.text||'').trim().slice(0,1000),options=Array.isArray(b.options)?b.options.map(x=>String(x||'').trim().slice(0,300)):[],correctIndex=Number(b.correctIndex);
   if(!subject||!text||options.length!==4||options.some(x=>!x)||!Number.isInteger(correctIndex)||correctIndex<0||correctIndex>3)fail('سؤال چهارگزینه‌ای معتبر نیست.');
   if(user.role==='teacher'&&!teacherCanAssigned(db,user,{classId,subject}))fail('دسترسی تدریس به این کلاس و درس ندارید.',403);
   const row={id:makeId('p635q'),subject,classId,chapter,text,options,correctIndex,explanation:String(b.explanation||'').slice(0,1200),image:p648Image(b.image),attachment:p649Attachment(b.attachment),scope:classId?'class':'public',createdBy:user.id,academicYear:year,active:true,createdAt:new Date().toISOString()};
   const saved=await mutateDb(m=>{m.p635Questions||=[];m.p635Questions.push(row);return row;});return sendJson(res,201,{ok:true,id:saved.result.id});
  }
  // p63.16 — edit/delete only the authenticated author's own independent-center questions.
  const questionMatch=url.pathname.match(/^\/api\/p635\/questions\/([a-zA-Z0-9_-]+)$/);
  if(questionMatch&&(req.method==='PATCH'||req.method==='DELETE')){
   if(isStudent)fail('دسترسی به بانک سؤال مجاز نیست.',403);
   const id=questionMatch[1];
   const original=(db.p635Questions||[]).find(q=>q.id===id&&q.active!==false&&q.createdBy===user.id&&String(q.academicYear||year)===year);
   if(!original)fail('سؤال متعلق به شما پیدا نشد.',404);
   if(user.role==='teacher'&&!teacherCanAssigned(db,user,{classId:original.classId,subject:original.subject}))fail('تخصیص تدریس این سؤال دیگر فعال نیست.',403);
   if(req.method==='DELETE'){
    await mutateDb(m=>{const row=(m.p635Questions||[]).find(q=>q.id===id&&q.createdBy===user.id&&q.active!==false);if(!row)fail('سؤال پیدا نشد.',404);row.active=false;row.deletedAt=new Date().toISOString();return true;});
    return sendJson(res,200,{ok:true});
   }
   const b=await readJson(req);
   const text=String(b.text||'').trim().slice(0,1000),chapter=String(b.chapter||'').trim().slice(0,120),options=Array.isArray(b.options)?b.options.map(x=>String(x||'').trim().slice(0,300)):[],correctIndex=Number(b.correctIndex),explanation=String(b.explanation||'').slice(0,1200);
   if(!text||options.length!==4||options.some(x=>!x)||!Number.isInteger(correctIndex)||correctIndex<0||correctIndex>3)fail('اطلاعات سؤال معتبر نیست.');
   await mutateDb(m=>{const row=(m.p635Questions||[]).find(q=>q.id===id&&q.createdBy===user.id&&q.active!==false);if(!row)fail('سؤال پیدا نشد.',404);Object.assign(row,{text,chapter,options,correctIndex,explanation,image:Object.hasOwn(b,'image')?p648Image(b.image):(row.image||''),attachment:Object.hasOwn(b,'attachment')?p649Attachment(b.attachment):(row.attachment||null),updatedAt:new Date().toISOString()});return true;});
   return sendJson(res,200,{ok:true});
  }
  if(req.method==='POST'&&url.pathname==='/api/p635/quizzes'){
   const b=await readJson(req),subject=String(b.subject||'').trim().slice(0,100),chapter=String(b.chapter||'').trim().slice(0,120),count=Number(b.count||10),title=String(b.title||'').trim().slice(0,140),classId=isStudent?user.classId:String(b.classId||'').trim();
   if(!subject||!Number.isInteger(count)||count<1||count>40)fail('درس و تعداد سؤال معتبر نیست.');
   if(isStudent){const cls=(db.school?.classes||[]).find(c=>c.id===user.classId),grade=Number(user.grade||cls?.grade||0),gradeId=String(cls?.gradeId||(db.school?.grades||[]).find(g=>Number(g.grade)===grade)?.id||'');const books=(db.curriculum||[]).filter(b=>b.active!==false&&(grade?(Number(b.grade)===grade||(gradeId&&String(b.gradeId||'')===gradeId)):false));const official=books.map(b=>String(b.subject||'').trim()).filter(Boolean);const valid=new Set(official.length?official:(db.school?.subjects||[]).map(x=>String(x||'').trim()).filter(Boolean));if(!valid.has(subject))fail('درس انتخاب‌شده متعلق به پایه شما نیست.',403);const choices=(db.p635Questions||[]).filter(q=>q.active!==false&&String(q.academicYear||year)===year&&(q.scope==='public'||(q.scope==='class'&&q.classId===user.classId)||(q.createdBy===user.id)));if(chapter&&!choices.some(q=>q.subject===subject&&q.chapter===chapter))fail('فصل انتخاب‌شده برای این درس معتبر نیست.',403);}
   if(!isStudent&&user.role==='teacher'&&!teacherCanAssigned(db,user,{classId,subject}))fail('دسترسی به کلاس و درس ندارید.',403);
   if(!isStudent&&!(db.school?.classes||[]).some(c=>c.id===classId))fail('کلاس معتبر نیست.');
   const pool=(db.p635Questions||[]).filter(q=>q.active!==false&&q.subject===subject&&(!chapter||q.chapter===chapter)&&(q.scope==='public'||q.classId===classId)&&String(q.academicYear||year)===year);
   let chosen;
   if(!isStudent&&Array.isArray(b.questionIds)){
    const ids=b.questionIds.map(String);
    if(!ids.length||ids.length>40||new Set(ids).size!==ids.length||ids.length!==count)fail('فهرست سؤال‌های انتخابی معتبر نیست.');
    const own=(db.p635Questions||[]).filter(q=>q.active!==false&&q.createdBy===user.id&&q.classId===classId&&q.subject===subject&&String(q.academicYear||year)===year);
    const byId=new Map(own.map(q=>[String(q.id),q]));chosen=ids.map(id=>byId.get(id));
    if(chosen.some(q=>!q))fail('سؤال انتخابی متعلق به بانک مستقل شما نیست.',403);
   }else{
    if(pool.length<count)fail(`بانک سؤال مستقل فقط ${pool.length} سؤال مناسب دارد.`,409);
    chosen=pool.slice().sort(()=>Math.random()-.5).slice(0,count);
   }
   const settings=b.practicePolicy&&typeof b.practicePolicy==='object'?b.practicePolicy:{};
   const durationMinutes=Number(settings.durationMinutes||0),maxAttempts=Number(settings.maxAttempts||0);
   if(!isStudent&&(!Number.isInteger(durationMinutes)||durationMinutes<0||durationMinutes>240||!Number.isInteger(maxAttempts)||maxAttempts<0||maxAttempts>20))fail('مدت آزمون یا تعداد دفعات مجاز معتبر نیست.');
   const startAt=String(settings.startAt||''),endAt=String(settings.endAt||'');
   if(!isStudent&&((startAt&&!Number.isFinite(Date.parse(startAt)))||(endAt&&!Number.isFinite(Date.parse(endAt)))||(startAt&&endAt&&Date.parse(endAt)<=Date.parse(startAt))))fail('بازه زمانی آزمون معتبر نیست.');
   const resultMode=settings.resultMode==='afterEnd'?'afterEnd':'immediate';
   if(!isStudent&&resultMode==='afterEnd'&&!endAt)fail('برای نمایش نتیجه پس از پایان، زمان پایان آزمون را تعیین کنید.');
   const quiz={id:makeId('p635quiz'),title:title||`خودآزمایی ${subject}${chapter?' - '+chapter:''}`,subject,chapter,classId,ownerType:isStudent?'personal':'teacher',ownerId:user.id,questions:chosen.map(q=>({id:q.id,text:q.text,options:q.options,correctIndex:q.correctIndex,explanation:q.explanation||'',image:q.image||'',attachment:q.attachment||null})),academicYear:year,active:true,createdAt:new Date().toISOString(),practicePolicy:isStudent?undefined:{durationMinutes,maxAttempts,startAt:startAt||null,endAt:endAt||null,resultMode}};
   await mutateDb(m=>{m.p635Quizzes||=[];m.p635Quizzes.push(quiz);return true;});return sendJson(res,201,{ok:true,id:quiz.id});
  }
  // p63.22: teacher-owned independent practice quizzes only; no official exam/grade mutations.
  if(req.method==='GET'&&url.pathname==='/api/p635/teacher/quizzes'){
   if(isStudent)fail('این بخش مخصوص کارکنان است.',403);
   const owned=(db.p635Quizzes||[]).filter(q=>q.ownerType==='teacher'&&q.ownerId===user.id&&String(q.academicYear||year)===year);
   return sendJson(res,200,{quizzes:owned.slice().sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).map(q=>({
    id:q.id,title:q.title,subject:q.subject,chapter:q.chapter||'',classId:q.classId,
    className:String((db.school?.classes||[]).find(c=>c.id===q.classId)?.name||(db.school?.classes||[]).find(c=>c.id===q.classId)?.title||q.classId),
    questionCount:Array.isArray(q.questions)?q.questions.length:0,createdAt:q.createdAt,active:q.active!==false,practicePolicy:policy(q),
    participantCount:new Set((db.p635Attempts||[]).filter(a=>a.quizId===q.id).map(a=>a.studentId)).size,
    attemptCount:(db.p635Attempts||[]).filter(a=>a.quizId===q.id).length
   }))});
  }
  // p64: read-only, owner-scoped independent practice performance; never touches official gradebook.
  const practiceResultsMatch=url.pathname.match(/^\/api\/p635\/teacher\/quizzes\/([a-zA-Z0-9_-]+)\/results$/);
  if(req.method==='GET'&&practiceResultsMatch){
   if(isStudent)fail('این بخش مخصوص کارکنان است.',403);
   const id=practiceResultsMatch[1];
   const quiz=(db.p635Quizzes||[]).find(q=>q.id===id&&q.ownerType==='teacher'&&q.ownerId===user.id&&String(q.academicYear||year)===year);
   if(!quiz)fail('آزمون متعلق به شما پیدا نشد.',404);
   const attempts=(db.p635Attempts||[]).filter(a=>a.quizId===id&&String(a.academicYear||quiz.academicYear||year)===year);
   const byStudent=new Map();
   for(const a of attempts){if(!a.studentId)continue;const key=String(a.studentId),rows=byStudent.get(key)||[];rows.push(a);byStudent.set(key,rows);}
   const participants=[...byStudent].map(([studentId,rows])=>{
    rows.sort((a,b)=>String(b.submittedAt||'').localeCompare(String(a.submittedAt||'')));
    const student=(db.users||[]).find(u=>u.id===studentId&&u.role==='student');
    const name=student?`${student.firstName||''} ${student.lastName||''}`.trim():'';
    return {studentId,studentName:name||'دانش‌آموز بدون نام',attemptCount:rows.length,
     latest:rows[0]?{score:rows[0].score,total:rows[0].total,percent:rows[0].percent,submittedAt:rows[0].submittedAt}:null,
     bestPercent:Math.max(...rows.map(a=>Number(a.percent)||0)),
     attempts:rows.map(a=>({id:a.id,score:a.score,total:a.total,percent:a.percent,submittedAt:a.submittedAt,
      details:(Array.isArray(a.details)?a.details:[]).map(d=>({questionId:d.questionId,text:d.text,options:d.options,answer:d.answer,correctIndex:d.correctIndex,correct:d.correct,explanation:d.explanation||''}))}))};
   }).sort((a,b)=>a.studentName.localeCompare(b.studentName,'fa'));
   const percentages=attempts.map(a=>Number(a.percent)).filter(Number.isFinite);
   return sendJson(res,200,{quiz:{id:quiz.id,title:quiz.title,subject:quiz.subject,chapter:quiz.chapter||'',active:quiz.active!==false,questionCount:Array.isArray(quiz.questions)?quiz.questions.length:0},
    stats:{participantCount:participants.length,attemptCount:attempts.length,averagePercent:percentages.length?Math.round(percentages.reduce((sum,n)=>sum+n,0)/percentages.length):null,
     highestPercent:percentages.length?Math.max(...percentages):null,lowestPercent:percentages.length?Math.min(...percentages):null},participants});
  }
  const teacherQuizMatch=url.pathname.match(/^\/api\/p635\/teacher\/quizzes\/([a-zA-Z0-9_-]+)$/);
  if(req.method==='PATCH'&&teacherQuizMatch){
   if(isStudent)fail('این بخش مخصوص کارکنان است.',403);
   const id=teacherQuizMatch[1],body=await readJson(req);
   if(body.active!==false)fail('فقط غیرفعال‌سازی آزمون پشتیبانی می‌شود.');
   const owned=(db.p635Quizzes||[]).find(q=>q.id===id&&q.ownerType==='teacher'&&q.ownerId===user.id&&String(q.academicYear||year)===year);
   if(!owned)fail('آزمون متعلق به شما پیدا نشد.',404);
   if(owned.active===false)fail('این آزمون قبلاً غیرفعال شده است.',409);
   await mutateDb(m=>{const q=(m.p635Quizzes||[]).find(x=>x.id===id&&x.ownerId===user.id&&x.ownerType==='teacher');if(!q)fail('آزمون پیدا نشد.',404);q.active=false;q.deactivatedAt=new Date().toISOString();q.deactivatedBy=user.id;return true;});
   return sendJson(res,200,{ok:true});
  }
  const detail=url.pathname.match(/^\/api\/p635\/quizzes\/([^/]+)$/);
  if(req.method==='GET'&&detail){
   if(!isStudent)fail('این بخش مخصوص دانش‌آموز است.',403);
   const q=qs.find(x=>x.id===decodeURIComponent(detail[1]));if(!q)fail('آزمون پیدا نشد.',404);
   if(!within(q))fail('آزمون خارج از بازه زمانی مجاز است.',409);
   if(remaining(q,user.id)===0)fail('تعداد دفعات مجاز شرکت در این آزمون تمام شده است.',409);
   let startedAt=null;const duration=Number(policy(q).durationMinutes||0);
   if(duration){
    const key=q.id+'::'+user.id;
    const found=(db.p635Sessions||[]).find(x=>x.key===key);
    if(found)startedAt=found.startedAt;
    else {const now=new Date().toISOString();await mutateDb(m=>{m.p635Sessions||=[];if(!m.p635Sessions.some(x=>x.key===key))m.p635Sessions.push({key,quizId:q.id,studentId:user.id,startedAt:now});return true;});startedAt=now;}
    if(Date.now()>Date.parse(startedAt)+duration*60000)fail('زمان پاسخ‌دهی به این آزمون به پایان رسیده است.',409);
   }
   return sendJson(res,200,{quiz:{id:q.id,title:q.title,subject:q.subject,chapter:q.chapter,questions:q.questions.map(({id,text,options,image,attachment})=>({id,text,options,image:image||'',attachment:attachment||null})),durationMinutes:duration,startedAt}});
  }
  const submit=url.pathname.match(/^\/api\/p635\/quizzes\/([^/]+)\/submit$/);
  if(req.method==='POST'&&submit){
   if(!isStudent)fail('فقط دانش‌آموز می‌تواند پاسخ ثبت کند.',403);
   const q=qs.find(x=>x.id===decodeURIComponent(submit[1]));if(!q)fail('آزمون پیدا نشد.',404);
   const b=await readJson(req),answers=b.answers&&typeof b.answers==='object'&&!Array.isArray(b.answers)?b.answers:{};
   const details=q.questions.map(x=>{const value=answers[x.id],answer=Number.isInteger(value)?value:null;return {questionId:x.id,text:x.text,options:x.options,answer,correctIndex:x.correctIndex,correct:answer===x.correctIndex,explanation:x.explanation};});
   const score=details.filter(x=>x.correct).length,total=details.length;
   const record={id:makeId('p635attempt'),quizId:q.id,studentId:user.id,title:q.title,subject:q.subject,score,total,percent:Math.round(score/total*100),details,academicYear:year,submittedAt:new Date().toISOString()};
   let showResult=true;
   await mutateDb(m=>{
    const live=(m.p635Quizzes||[]).find(x=>x.id===q.id);
    if(!live||live.active===false||String(live.academicYear||year)!==year||live.classId!==user.classId||(live.ownerType==='personal'&&live.ownerId!==user.id))fail('این آزمون دیگر برای شما فعال نیست؛ پاسخ ثبت نشد.',409);
    const p=live.ownerType==='teacher'?(live.practicePolicy||{}):{},now=Date.now();
    if((p.startAt&&now<Date.parse(p.startAt))||(p.endAt&&now>=Date.parse(p.endAt)))fail('بازه زمانی شرکت در آزمون به پایان رسیده یا هنوز شروع نشده است.',409);
    m.p635Attempts||=[];
    if(p.maxAttempts&&m.p635Attempts.filter(a=>a.quizId===live.id&&a.studentId===user.id).length>=p.maxAttempts)fail('تعداد دفعات مجاز شرکت تمام شده است.',409);
    if(p.durationMinutes){const session=(m.p635Sessions||[]).find(x=>x.key===live.id+'::'+user.id);if(!session)fail('ابتدا آزمون را باز کنید.',409);if(now>Date.parse(session.startedAt)+Number(p.durationMinutes)*60000)fail('زمان آزمون به پایان رسیده است.',409);}
    m.p635Attempts.push(record);
    showResult=p.resultMode!=='afterEnd'||(p.endAt&&now>=Date.parse(p.endAt));
    return true;
   });
   return sendJson(res,200,{ok:true,result:showResult?{id:record.id,score,total,percent:record.percent,details}:{id:record.id,pending:true,message:'پاسخ شما ثبت شد؛ نتیجه پس از پایان بازه آزمون قابل مشاهده است.'}});
  }
  fail('مسیر پیدا نشد.',404);
 }catch(e){return sendJson(res,e.status||500,{error:e.status?e.message:'خطای داخلی مرکز آزمون'});}
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  url.pathname = stripConfiguredBasePath(url.pathname);
  if (req.method === "OPTIONS") {
    if (!url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "مسیر پیدا نشد." });
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  if (url.pathname.startsWith("/api/p635/")) return await handlePracticeCenterP635(req,res,url);
  if (req.method === "GET" && url.pathname === "/api/network") {
    try { await authenticate(req, ["teacher", "admin", "superadmin"]); }
    catch (error) { return sendJson(res, error.status || 401, { error: error.message }); }
    const urls = process.env.NODE_ENV === "production" ? [] : mobileUrls();
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
    const protocol = forwardedProto || (req.socket?.encrypted ? "https" : "http");
    const requestHost = forwardedHost || String(req.headers.host || "");
    const publicBase = requestHost ? `${protocol}://${requestHost}${APP_BASE_PATH}`.replace(/\/+$/, "") : "";
    const localBases = urls.map(base => `${base}${APP_BASE_PATH}`);
    return sendJson(res, 200, {
      localUrl: process.env.NODE_ENV === "production" ? "" : `http://127.0.0.1:${PORT}${APP_BASE_PATH}`,
      publicUrl: publicBase,
      mobileUrls: localBases,
      studentAppUrls: [...(publicBase ? [`${publicBase}/student/`] : []), ...localBases.map(base => `${base}/student/`)],
      guardianUrls: [...(publicBase ? [`${publicBase}/guardian/`] : []), ...localBases.map(base => `${base}/guardian/`)],
      teacherAppUrls: [...(publicBase ? [`${publicBase}/teacher/`] : []), ...localBases.map(base => `${base}/teacher/`)],
      attendanceMonitorUrls: [...(publicBase ? [`${publicBase}/attendance/`] : []), ...localBases.map(base => `${base}/attendance/`)],
      port: PORT,
      basePath: APP_BASE_PATH
    });
  }
  if (req.method === "GET" && url.pathname === "/api/ping") return sendJson(res, 200, { ok: true, app: "madreseyar", version: APP_VERSION, release: APP_RELEASE, basePath: APP_BASE_PATH, school: SCHOOL_NAME, gradingWorkflow: "offline-package-import", security: "rbac-scrypt-password", localSnapshots: true, time: new Date().toISOString() });
  if (req.method === "GET" && url.pathname === "/api/branding") {
    try {
      const env = await ensureStateInitialized();
      const db = env.db; const b = db.school?.uiBranding || {};
      return sendJson(res, 200, {ok:true,version:APP_VERSION,school:{name:db.school?.name||"مدرسه",year:db.school?.year||""},branding:{primaryColor:b.primaryColor||"#14233f",accentColor:b.accentColor||"#4f7cff",logoDataUrl:b.logoDataUrl||"",updatedAt:b.updatedAt||"",headers:b.headers||{}}});
    } catch(error){ return sendJson(res,500,{error:error.message}); }
  }
  if(req.method==="GET"&&url.pathname==="/api/admin/continuous-p11/roster"){
    try{
      const auth=await authenticate(req,["admin","superadmin"]),db=auth.db;
      const classes=(db.school?.classes||[]).filter(c=>c.active!==false).map(c=>({id:String(c.id),name:String(c.name||""),grade:String(c.grade||"")}));
      const classIds=new Set(classes.map(c=>c.id));
      const students=(db.users||[]).filter(u=>u.role==="student"&&u.active!==false&&!['deleted','graduated'].includes(String(u.profileStatus||''))&&classIds.has(String(u.classId||''))).map(u=>({id:String(u.id),name:`${u.firstName||""} ${u.lastName||""}`.trim(),studentCode:String(u.studentCode||""),classId:String(u.classId||"")}));
      return sendJson(res,200,{ok:true,classes,students});
    }catch(e){return sendJson(res,e.status||500,{error:e.message});}
  }
  if(req.method==="GET"&&url.pathname==="/api/admin/continuous-p11"){
    try{const auth=await authenticate(req,["admin","superadmin"]);return sendJson(res,200,continuousP11(auth.db,String(url.searchParams.get("studentId")||""),String(url.searchParams.get("examId")||"")));}
    catch(e){return sendJson(res,e.status||500,{error:e.message});}
  }
  if (url.pathname.startsWith("/api/guardian/")) return await handleGuardianApi(req, res, url);
  if (url.pathname === "/api/admin/guardian-access") { try { const auth=await authenticate(req,["admin","superadmin"]); return await handleGuardianAdminApi(req,res,url,auth); } catch(error){ return sendJson(res,error.status||500,{error:error.message}); } }
  if (url.pathname.startsWith("/api/admin/release-diagnostics") || url.pathname.startsWith("/api/admin/encrypted-backup/")) { try { const auth=await authenticate(req,["admin","superadmin"]); return await handleReleaseApi(req,res,url,auth); } catch(error){ return sendJson(res,error.status||500,{error:error.message}); } }
  if (url.pathname.startsWith("/api/practice/p59/")) return await handlePracticeP59(req,res,url);
  if (url.pathname.startsWith("/api/academic-messages/p58/")) return await handleAcademicMessagesP58(req,res,url);
  if (url.pathname.startsWith("/api/library/p62/")) return await handleLibraryP62(req,res,url);
  if (url.pathname.startsWith("/api/student/")) return await handleStudentApi(req, res, url);
  if (url.pathname.startsWith("/api/workbench/")) return await handleWorkbenchV38Api(req, res, url);
  if (url.pathname.startsWith("/api/admin/v76/")) { try { const auth=await authenticate(req,["admin","superadmin"]); return await handleAdminV76Api(req,res,url,auth); } catch(error){ return sendJson(res,error.status||500,{error:error.message}); } }
  if (url.pathname.startsWith("/api/admin/v4515/")) { try { const auth=await authenticate(req,["admin","superadmin"]); return await handleAdminV4515Api(req,res,url,auth); } catch(error){ return sendJson(res,error.status||500,{error:error.message}); } }
  if (url.pathname.startsWith("/api/teacher/")) return await handleTeacherAppApi(req, res, url);
  if (["/api/admin/attendance/live","/api/admin/attendance/review"].includes(url.pathname)) return await handleAdminAttendanceLiveV78(req, res, url);
  if (url.pathname.startsWith("/api/staff/") || url.pathname === "/api/security/audit") return await handleStaffApi(req, res, url);
  if(url.pathname==="/api/admin/reset-data"){try{const auth=await authenticate(req,["superadmin"]);return await handleAdminResetData(req,res,auth);}catch(error){return sendJson(res,error.status||500,{error:error.message,code:error.code||undefined});}}
  if (url.pathname.startsWith("/api/admin/system-health") || url.pathname === "/api/admin/sessions/revoke") {
    try { const auth = await authenticate(req, ["admin", "superadmin"]); return await handleSystemHealthApi(req, res, url, auth); }
    catch (error) { return sendJson(res, error.status || 500, { error: error.message, code: error.code || undefined }); }
  }
  if (url.pathname.startsWith("/api/admin/local-backups")) {
    try { const auth = await authenticate(req, ["admin", "superadmin"]); return await handleLocalBackupApi(req, res, url, auth); }
    catch (error) { return sendJson(res, error.status || 500, { error: error.message, code: error.code || undefined }); }
  }
  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/state") {
    try { const auth = await authenticate(req, ["teacher", "admin", "superadmin"]); return await handleState(req, res, auth); }
    catch (error) { return sendJson(res, error.status || 500, { error: error.message, code: error.code || undefined }); }
  }
  if (url.pathname === "/api/files" || url.pathname.startsWith("/api/files/")) {
    try { const auth = await authenticate(req, ["teacher", "admin", "superadmin"]); return await handleFiles(req, res, url.pathname, auth); }
    catch (error) { return sendJson(res, error.status || 500, { error: error.message, code: error.code || undefined }); }
  }
  if ((req.method === "GET" || req.method === "HEAD") && ["/student", "/guardian"].includes(url.pathname)) {
    const location = `${APP_BASE_PATH}${url.pathname}/` || `${url.pathname}/`;
    res.writeHead(308, { ...securityHeaders(), Location: location });
    return res.end();
  }
    if (req.method === "GET" || req.method === "HEAD") return await serveStatic(req, res, url.pathname);
    return sendJson(res, 405, { error: "روش درخواست پشتیبانی نمی‌شود." });
  } catch (error) {
    console.error("Request handling failed:", error?.stack || error);
    if (res.headersSent) { try { res.end(); } catch {} return; }
    const explicitStatus = Number(error?.status);
    const malformedRequest = error?.code === "ERR_INVALID_URL" || error instanceof URIError;
    const status = explicitStatus >= 400 && explicitStatus < 600 ? explicitStatus : malformedRequest ? 400 : 500;
    return sendJson(res, status, { error: status === 400 ? "درخواست معتبر نیست." : "خطای داخلی سامانه." });
  }
});

await ensureDataDirs();
await cleanupStaleAtomicTemps();
await loadLoginAttempts();
let securityAlreadyInitialized=false;try{securityAlreadyInitialized=Boolean((await fs.stat(SECURITY_FILE)).isFile());}catch{}
const initialEnvelope = await ensureStateInitialized();
if(process.env.NODE_ENV==="production"&&!securityAlreadyInitialized){
  const users=Array.isArray(initialEnvelope.db?.users)?initialEnvelope.db.users:[];
  const missing=[];
  if(users.some(u=>u.id==="sys1"&&u.active!==false)&&!process.env.MADRESEYAR_SUPERADMIN_PASSWORD)missing.push("MADRESEYAR_SUPERADMIN_PASSWORD");
  if(users.some(u=>u.id==="tea1"&&u.active!==false)&&!process.env.MADRESEYAR_TEACHER_PASSWORD)missing.push("MADRESEYAR_TEACHER_PASSWORD");
  if(missing.length)throw new Error(`در اولین اجرای Production متغیرهای Bootstrap زیر الزامی هستند: ${missing.join(", ")}. پس از ایجاد فایل امنیتی، نگهداری دائمی آن‌ها الزامی نیست.`);
}
await ensureSecurityInitialized(initialEnvelope.db);

// 72.11 — optional one-time superadmin recovery.
// Set MADRESEYAR_ADMIN_RECOVERY_PASSWORD temporarily in cPanel, restart once,
// login and change the password, then remove the variable.
// A marker keyed to the recovery value prevents repeated resets on later restarts.
const adminRecoveryPassword = String(process.env.MADRESEYAR_ADMIN_RECOVERY_PASSWORD || "");
if (adminRecoveryPassword) {
  const policyError = passwordPolicy(adminRecoveryPassword, "superadmin");
  if (policyError) throw new Error(`MADRESEYAR_ADMIN_RECOVERY_PASSWORD نامعتبر است: ${policyError}`);
  const marker = path.join(DATA_DIR, ".admin-recovery-applied");
  const fingerprint = crypto.createHash("sha256").update(adminRecoveryPassword).digest("hex");
  let applied = "";
  try { applied = String(await fs.readFile(marker, "utf8")).trim(); } catch {}
  if (applied !== fingerprint) {
    await mutateSecurity(async security => {
      const credential = security.credentials?.sys1;
      if (!credential) throw new Error("حساب ادمین فنی sys1 در فایل امنیتی پیدا نشد.");
      credential.passwordHash = await passwordHash(adminRecoveryPassword);
      credential.mustChangePassword = true;
      credential.passwordChangedAt = new Date().toISOString();
      credential.credentialVersion = Number(credential.credentialVersion || 1) + 1;
      credential.failedLoginCount = 0;
      credential.lockedUntil = 0;
      for (const [hash, session] of Object.entries(security.sessions || {})) {
        if (session?.userId === "sys1") delete security.sessions[hash];
      }
    });
    await fs.writeFile(marker, fingerprint, {encoding:"utf8",mode:0o600});
    console.warn("Madreseyar: one-time superadmin recovery password applied. Remove MADRESEYAR_ADMIN_RECOVERY_PASSWORD after login.");
  }
}
// v45.15: پشتیبان روزانه/هفتگی حتی در روزهای بدون تغییر داده نیز بررسی می‌شود.
try { await maybeCreateTieredBackupsV4515(); } catch (error) { console.warn("Startup tiered backup failed", error.message); }
const tieredBackupTimerV4515 = setInterval(() => { maybeCreateTieredBackupsV4515().catch(error => console.warn("Scheduled tiered backup failed", error.message)); }, 60 * 60 * 1000);
tieredBackupTimerV4515.unref?.();
let shutdownStarted = false;
async function gracefulShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`Madreseyar received ${signal}; stopping new connections...`);
  const forceTimer = setTimeout(() => {
    console.error("Madreseyar graceful shutdown timed out.");
    process.exit(1);
  }, 10000);
  forceTimer.unref?.();
  server.close(error => {
    clearTimeout(forceTimer);
    if (error) {
      console.error("Madreseyar shutdown failed:", error);
      process.exitCode = 1;
    }
  });
  try {
    await Promise.allSettled([stateOperationQueue, securityOperationQueue, securityWriteQueue]);
    if (!server.listening) process.exit(process.exitCode || 0);
  } catch (error) {
    console.error("Madreseyar shutdown queue drain failed:", error);
    process.exit(1);
  }
}
process.once("SIGTERM", () => { gracefulShutdown("SIGTERM"); });
process.once("SIGINT", () => { gracefulShutdown("SIGINT"); });

server.listen(PORT, HOST, async () => {
  const urls = mobileUrls();
  const lines = [
    `مدرسه‌یار نسخه ${APP_RELEASE}؛ آماده استقرار cPanel و مسیر /app`,
    `روی کامپیوتر: http://127.0.0.1:${PORT}`,
    ...(urls.length ? urls.flatMap(url => [`پنل کامل در شبکه: ${url}${APP_BASE_PATH}`, `اپ حرفه‌ای دانش‌آموز: ${url}${APP_BASE_PATH}/student/`]) : ["آدرس شبکه پیدا نشد؛ اتصال Wi-Fi کامپیوتر را بررسی کنید."]),
    "در پنجره Firewall ویندوز، دسترسی Private networks را فعال کنید.",
    "هیچ اتصال مستقیمی به سرویس هوش مصنوعی در برنامه وجود ندارد."
  ];
  console.log(`\n${lines.join("\n")}\n`);
  if (process.env.MADRESEYAR_SKIP_RUNTIME_FILES !== "1") {
    try { await fs.writeFile(path.join(ROOT, "MOBILE-ADDRESS.txt"), lines.join("\r\n"), { encoding: "utf8", mode: 0o600 }); } catch {}
  }
});
