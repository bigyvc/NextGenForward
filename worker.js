// Next Gen Forward v1.6.1
// 基于 Cloudflare Workers 部署的 Telegram 双向私聊机器人。
// 通过群组话题管理私聊，人机验证模块支持 Cloudflare Turnstile & 本地题库 可随时切换。
// 项目地址 https://github.com/mole404/NextGenForward
// 本项目基于 https://github.com/jikssha/telegram_private_chatbot 修改
// 在此对原项目作者 Vaghr (Github@jikssha) ，以及我的好兄弟 打钱 & 逆天 表示特别感谢！

// Copyright (c) 2026 Frost
// Released under the MIT License. See LICENSE in the project root.

const BOT_VERSION = "v1.6.1";

// --- 配置常量 ---
const CONFIG = {
    // 用户速率限制
    RATE_LIMIT_VERIFY: 3,              // 用户5分钟内最多可尝试人机验证次数，不可设为0
    RATE_LIMIT_MESSAGE: 45,            // 用户私聊消息发送速率限制，不可设为0
    RATE_LIMIT_WINDOW: 60,             // 用户私聊消息速率限制窗口（秒），不可设为0
    
    // 人机验证配置
    VERIFY_BUTTON_TEXT: "🤖 点击进行人机验证",     // 人机验证按钮文本
    VERIFY_EXPIRE_SECONDS: 300,        // 人机验证链接有效期（秒）
    VERIFY_FINALIZE_EXPIRE_SECONDS: 600, // 通过网页验证后，点击完成激活按钮的有效期（秒）
    VERIFIED_GRACE_SECONDS: 300,        // 完成验证后宽限窗口（秒），用于兜底 KV 跨 PoP 传播/负缓存
    VERIFIED_TTL_SECONDS_DEFAULT: 0,    // verified 键默认不过期；可用环境变量 VERIFIED_TTL_SECONDS 覆盖（>0 生效）
    KV_CRITICAL_CACHE_TTL: 60,           // 关键键 KV.get 的 cacheTtl（秒），Cloudflare KV 最小为 60；不要设为 0
    TURNSTILE_ACTION: "tg_verify",      // Turnstile action（前端 render + 服务端校验），可留空禁用
    PENDING_MAX_MESSAGES: 10,          // 人机验证期间最多暂存消息数量，不可设为0
    
    PENDING_QUEUE_TTL_SECONDS: 86400,   // 暂存消息队列 TTL（秒），用于跨验证会话保留首条触发消息
    VERIFY_PROMPT_TTL_SECONDS: 86400,   // 验证按钮消息ID列表 TTL（秒），用于验证完成后移除旧按钮
    VERIFY_PROMPT_MAX_IDS: 6,           // 每个用户最多记录多少条“验证按钮消息”message_id
    // 媒体组消息处理配置
    MEDIA_GROUP_EXPIRE_SECONDS: 60,    // 媒体组消息过期时间（秒），用于清理KV中的相册/组图消息暂存数据
    MEDIA_GROUP_DELAY_MS: 3000,        // 媒体组消息发送延迟（毫秒），用于等待同一媒体组的所有消息到达
    
    // 缓存配置
    ADMIN_CACHE_TTL_SECONDS: 300,      // 管理员权限缓存时间（秒），减少频繁的权限检查
    THREAD_HEALTH_TTL_MS: 60000,       // 线程健康检查缓存时间（毫秒），减少频繁的话题探测
    
    // API调用配置
    API_TIMEOUT_MS: 10000,             // Telegram API 调用超时时间（毫秒）
    API_MAX_RETRY_ATTEMPTS: 3,         // Telegram API最大重试次数
    API_RETRY_BASE_DELAY_MS: 1000,     // Telegram API重试基础延迟（毫秒），用于指数退避
    API_RETRY_MAX_DELAY_MS: 5000,      // Telegram API最大重试延迟（毫秒）
    
    // 话题限制
    MAX_TITLE_LENGTH: 128,             // 话题标题最大长度，Telegram论坛话题标题限制
    MAX_NAME_LENGTH: 30,               // 用户名称最大长度，用于构建话题标题
    MAX_RETRY_ATTEMPTS: 3,             // 最大重试尝试次数，用于话题创建等操作
    
    // Webhook路径配置
    WEBHOOK_PATH: '/',         // Webhook路径，Telegram webhook 的接收端点
    VERIFY_PATH: '/verify',            // 人机验证页面路径
    VERIFY_CALLBACK_PATH: '/verify-callback',   // 人机验证回调
    VERIFY_EVENT_PATH: '/verify-event',         // Turnstile 失败/超时等事件上报（用于让旧按钮消失 + 重新下发新按钮）路径，用于处理Turnstile验证结果
    
    // KV存储操作配置
    KV_LIST_BATCH_SIZE: 100,           // KV存储列表操作批量大小，用于分页获取KV键
    KV_SCAN_CONCURRENCY: 8,            // 扫描 user:* 等键时的并发 GET 数量
    KV_DELETE_BATCH_SIZE: 50,          // KV存储删除操作批量大小，批量删除时的每批数量
    KV_DELETE_DELAY_MS: 500,           // KV存储删除操作延迟（毫秒），避免速率限制
    KV_OPERATION_MAX_ITEMS: 1000,       // KV操作最大项目数，防止一次操作过多数据
    
    // 话题删除配置
    TOPIC_DELETE_MAX_PER_BATCH: 10,    // 批量删除话题时每批最大数量
    TOPIC_DELETE_DELAY_MS: 500,        // 批量删除话题时的延迟（毫秒），避免Telegram API速率限制
    TOPIC_DELETE_RETRY_ATTEMPTS: 2,    // 话题删除重试次数
    TOPIC_DELETE_RETRY_DELAY_MS: 1000, // 话题删除重试延迟（毫秒）
};

const VERIFY_MODE_DEFAULT = "local_quiz"; // 默认：本地题库验证（Turnstile 可选）


// Turnstile 是否已配置（同时需要 Site Key 与 Secret Key）
function hasTurnstileBinding(env) {
  const site = (env && env.CF_TURNSTILE_SITE_KEY ? String(env.CF_TURNSTILE_SITE_KEY) : "").trim();
  const secret = (env && env.CF_TURNSTILE_SECRET_KEY ? String(env.CF_TURNSTILE_SECRET_KEY) : "").trim();
  return !!(site && secret);
}


// KV key：全局验证模式（仅影响新会话）
const GLOBAL_VERIFY_MODE_KEY = "global_verify:mode";


// --- 垃圾消息过滤（v1.1b）---
// KV key：全局垃圾过滤开关（仅影响新消息；缺省=开启，v1.1.1b）
const GLOBAL_SPAM_FILTER_ENABLED_KEY = "global_spam_filter:enabled";
// KV key：全局垃圾过滤规则（JSON）
const GLOBAL_SPAM_FILTER_RULES_KEY = "global_spam_filter:rules";
// KV key：全局垃圾过滤规则提示词（可读可写文本，v1.1.1b）
const GLOBAL_SPAM_FILTER_RULES_PROMPT_KEY = "global_spam_filter:rules_prompt";
// KV key：管理员编辑规则会话
const SPAM_RULES_EDIT_SESSION_KEY_PREFIX = "spam_rules_edit_session:";



// 纯 Telegram 内联按钮本地题库（20 题），难度参照 worker.js
const LOCAL_QUIZ_QUESTIONS = [
  { q: "冰融化后会变成什么？", opts: ["水", "火", "石头", "空气"], a: 0 },
  { q: "星期一后面是星期几？", opts: ["星期二", "星期日", "星期五", "星期一"], a: 0 },
  { q: "2 + 3 等于几？", opts: ["4", "5", "6", "8"], a: 1 },
  { q: "太阳从哪边升起？", opts: ["东", "西", "南", "北"], a: 0 },
  { q: "1 分钟有多少秒？", opts: ["30", "60", "90", "120"], a: 1 },
  { q: "水的沸点在标准大气压下约是多少摄氏度？", opts: ["50℃", "80℃", "100℃", "120℃"], a: 2 },
  { q: "下列哪个是水果？", opts: ["土豆", "苹果", "黄瓜", "洋葱"], a: 1 },
  { q: "“上”与哪个方向相反？", opts: ["左", "右", "下", "前"], a: 2 },
  { q: "10 - 7 等于几？", opts: ["1", "2", "3", "4"], a: 2 },
  { q: "一周有几天？", opts: ["5", "6", "7", "8"], a: 2 },
  { q: "下列哪个不是颜色？", opts: ["红", "蓝", "快", "绿"], a: 2 },
  { q: "把灯关掉后，房间通常会变得？", opts: ["更亮", "更暗", "更热", "更冷"], a: 1 },
  { q: "猫通常有几条腿？", opts: ["2", "3", "4", "6"], a: 2 },
  { q: "地球绕着什么转？", opts: ["月亮", "太阳", "星星", "云朵"], a: 1 },
  { q: "下列哪个是交通工具？", opts: ["桌子", "汽车", "枕头", "雨伞"], a: 1 },
  { q: "“你好”的相反含义更接近？", opts: ["再见", "谢谢", "请", "对不起"], a: 0 },
  { q: "5 × 2 等于几？", opts: ["7", "8", "9", "10"], a: 3 },
  { q: "下列哪个是动物？", opts: ["石头", "杯子", "狗", "椅子"], a: 2 },
  { q: "水在 0℃ 附近会？", opts: ["结冰", "沸腾", "变油", "发光"], a: 0 },
  { q: "字母表中 A 的下一个字母是？", opts: ["B", "C", "D", "Z"], a: 0 },
];


// 本地题库：单题有效期与触发频率限制
const LOCAL_QUIZ_CHALLENGE_TTL_SECONDS = 60;          // 单题 1 分钟有效期（KV 最小 60）
const LOCAL_QUIZ_CHALLENGE_VALID_MS = 60 * 1000;      // 单题有效期（毫秒）
const LOCAL_QUIZ_TRIGGER_WINDOW_SECONDS = 300;        // 5 分钟窗口
const LOCAL_QUIZ_TRIGGER_LIMIT = 3;                   // 5 分钟最多触发 3 次
const LOCAL_QUIZ_TRIGGER_KEY_PREFIX = "quiz_trig:";   // KV 记录：触发次数

// 触发频率限制：5分钟最多3次（写入频率很低，使用 KV 以跨 PoP 一致）
async function consumeLocalQuizTrigger(userId, env) {
  const key = `${LOCAL_QUIZ_TRIGGER_KEY_PREFIX}${userId}`;
  const now = Date.now();
  const winMs = LOCAL_QUIZ_TRIGGER_WINDOW_SECONDS * 1000;

  let arr = await kvGetJSON(env, key, [], {}); // 不使用 cacheTtl，避免边缘缓存导致误判
  if (!Array.isArray(arr)) arr = [];

  arr = arr
    .map(x => Number(x))
    .filter(x => Number.isFinite(x) && (now - x) < winMs);

  if (arr.length >= LOCAL_QUIZ_TRIGGER_LIMIT) {
    return { allowed: false, count: arr.length };
  }

  arr.push(now);

  // TTL 取窗口期的两倍，防止边缘延迟与最小 TTL 影响
  await kvPut(env, key, JSON.stringify(arr), { expirationTtl: Math.max(LOCAL_QUIZ_TRIGGER_WINDOW_SECONDS * 2, 600) });

  return { allowed: true, count: arr.length };
}


// 读取全局验证模式（仅影响新会话）

async function getGlobalVerifyMode(env) {
  const raw = await kvGetText(env, GLOBAL_VERIFY_MODE_KEY, CONFIG.KV_CRITICAL_CACHE_TTL);
  const mode = (raw || "").toString().trim();

  if (mode === "local_quiz") return "local_quiz";
  if (mode === "turnstile") return hasTurnstileBinding(env) ? "turnstile" : "local_quiz";

  // 未设置 / 非法值：回落默认值
  return VERIFY_MODE_DEFAULT;
}

// 设置全局验证模式

async function setGlobalVerifyMode(env, mode) {
  const m = (mode || "").toString().trim();
  if (m !== "turnstile" && m !== "local_quiz") return false;

  // turnstile 作为可选能力：未配置则拒绝切换
  if (m === "turnstile" && !hasTurnstileBinding(env)) {
    return false;
  }

  await kvPut(env, GLOBAL_VERIFY_MODE_KEY, m);
  return true;
}



// 默认垃圾规则（可在 /settings 中编辑）
const DEFAULT_SPAM_RULES = {
  version: 1,
  max_links: 3,                 // 文本中链接数 >= max_links 判定为 spam；0 表示不启用
  keywords: [
    "加群", "进群", "推广", "广告", "返利", "博彩", "代投", "套利",
    "USDT", "BTC", "ETH", "币圈", "空投", "交易所", "稳赚", "客服", "开户链接"
  ],
  regexes: [
    "\\b(?:usdt|btc|eth|trx|bnb)\\b",
    "(?:t\\.me\\/\\w+|telegram\\.me\\/\\w+)",
    "(?:免费|稳赚|日赚|高回报|带单|私聊我)"
  ],
  allow_keywords: [],
  allow_regexes: [],
  ai: {
    enabled: true,
    model: "@cf/google/gemma-4-26b-a4b-it",
    // v1.6.1: AI 阈值默认更激进（更愿意拦截）
    threshold: 0.65
  }
};

function hasWorkersAIBinding(env) {
  return !!(env && env.AI && typeof env.AI.run === "function");
}

async function getGlobalSpamFilterEnabled(env) {
  const raw = await kvGetText(env, GLOBAL_SPAM_FILTER_ENABLED_KEY, CONFIG.KV_CRITICAL_CACHE_TTL);
  if (raw === null || raw === undefined) return true; // 默认开启（v1.1.1b）
  const v = String(raw).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on") return true;
  if (v === "0" || v === "false" || v === "off") return false;
  return false;
}

async function setGlobalSpamFilterEnabled(env, enabled) {
  await kvPut(env, GLOBAL_SPAM_FILTER_ENABLED_KEY, enabled ? "1" : "0");
}

function sanitizeStringArray(arr, maxLen = 50) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    if (typeof x !== "string") continue;
    const s = x.trim();
    if (!s) continue;
    if (s.length > 256) continue;
    out.push(s);
    if (out.length >= maxLen) break;
  }
  return out;
}
// 数组工具：去重追加并限制长度（保留末尾 N 个）
function pushUniqueLimited(arr, value, limit) {
    const out = Array.isArray(arr) ? arr.slice() : [];
    if (value !== null && value !== undefined) {
        if (!out.includes(value)) out.push(value);
    }
    const lim = Math.max(0, Math.floor(Number(limit || 0)));
    if (lim > 0 && out.length > lim) return out.slice(-lim);
    return out;
}


function sanitizeSpamRules(rules) {
  const r = (rules && typeof rules === "object") ? rules : {};
  const maxLinks = Math.floor(Number(r.max_links));
  // v1.6.0: 统一使用新的默认阈值（0.65），避免旧 KV 配置残留导致阈值仍为 0.85
  const AI_THRESHOLD = 0.65;
  const safe = {
    version: 1,
    max_links: Number.isFinite(maxLinks) && maxLinks >= 0 && maxLinks <= 10 ? maxLinks : DEFAULT_SPAM_RULES.max_links,
    keywords: sanitizeStringArray(r.keywords ?? DEFAULT_SPAM_RULES.keywords, 80),
    regexes: sanitizeStringArray(r.regexes ?? DEFAULT_SPAM_RULES.regexes, 80),
    allow_keywords: sanitizeStringArray(r.allow_keywords ?? DEFAULT_SPAM_RULES.allow_keywords, 80),
    allow_regexes: sanitizeStringArray(r.allow_regexes ?? DEFAULT_SPAM_RULES.allow_regexes, 80),
    ai: {
      enabled: !!(r.ai && typeof r.ai === "object" ? r.ai.enabled : DEFAULT_SPAM_RULES.ai.enabled),
      model: (r.ai && typeof r.ai === "object" && typeof r.ai.model === "string" && r.ai.model.trim())
        ? r.ai.model.trim()
        : DEFAULT_SPAM_RULES.ai.model,
      // v1.6.0: 统一阈值为 0.65（不再从 KV 读取旧值），避免升级后仍沿用 0.85
      threshold: AI_THRESHOLD
    }
  };
  return safe;
}

async function getGlobalSpamFilterRules(env) {
  const raw = await kvGetText(env, GLOBAL_SPAM_FILTER_RULES_KEY, CONFIG.KV_CRITICAL_CACHE_TTL);
  if (!raw) return sanitizeSpamRules(DEFAULT_SPAM_RULES);
  try {
    return sanitizeSpamRules(JSON.parse(raw));
  } catch (_) {
    return sanitizeSpamRules(DEFAULT_SPAM_RULES);
  }
}

async function setGlobalSpamFilterRules(env, rulesObj) {
  const safe = sanitizeSpamRules(rulesObj);
  await kvPut(env, GLOBAL_SPAM_FILTER_RULES_KEY, JSON.stringify(safe));
  return safe;
}


// --- 垃圾规则“提示词”编辑（v1.1.1b）---
// 说明：为了降低上手难度，管理员可在 /settings 里用“提示词”方式编辑规则。
// 我们把提示词解析成 JSON 规则并写入 GLOBAL_SPAM_FILTER_RULES_KEY，供规则引擎直接使用。
// 同时保存原始提示词到 GLOBAL_SPAM_FILTER_RULES_PROMPT_KEY 以便再次编辑。

async function getGlobalSpamFilterRulesPrompt(env) {
  const raw = await kvGetText(env, GLOBAL_SPAM_FILTER_RULES_PROMPT_KEY, CONFIG.KV_CRITICAL_CACHE_TTL);
  return raw ? String(raw) : "";
}

async function setGlobalSpamFilterRulesPrompt(env, promptText) {
  const t = (promptText || "").trim();
  await kvPut(env, GLOBAL_SPAM_FILTER_RULES_PROMPT_KEY, t);
  return t;
}

function tokenizeLooseKeywords(line) {
  if (!line) return [];
  return String(line)
    .split(/[,，、;；|\n\t]+/g)
    .map(s => s.trim())
    .filter(Boolean);
}

function parsePromptRegexToken(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  // 支持 /pattern/flags 形式
  if (t.startsWith("/") && t.lastIndexOf("/") > 0) {
    const last = t.lastIndexOf("/");
    const body = t.slice(1, last);
    const flags = t.slice(last + 1);
    if (!body) return null;
    try {
      // 验证正则可编译（不实际使用返回对象，存字符串）
      // eslint-disable-next-line no-new
      new RegExp(body, flags);
      return `/${body}/${flags}`;
    } catch (_) {
      return null;
    }
  }
  // 允许直接写 pattern（默认 i）
  try {
    // eslint-disable-next-line no-new
    new RegExp(t, "i");
    return `/${t}/i`;
  } catch (_) {
    return null;
  }
}

function mergeUnique(arr, add) {
  const set = new Set((arr || []).filter(Boolean).map(x => String(x)));
  for (const a of (add || [])) {
    if (!a) continue;
    set.add(String(a));
  }
  return Array.from(set);
}

/**
 * 把“规则提示词”解析为 SpamRules JSON
 * 支持的行格式（大小写不敏感）：
 * - max_links=2 / max_links:2
 * - block: 兼职,加群,返利
 * - allow: 你好,谢谢
 * - block_re: /二维码|扫码/i
 * - allow_re: /回执/i
 * - 其他不带前缀的行：按关键词列表处理（用逗号/顿号分隔）
 * - 写一行 “清空默认”/“CLEAR_DEFAULTS”：表示不使用默认规则（仅使用提示词解析出的规则）
 */
function promptToSpamRules(promptText, baseRules) {
  const raw = (promptText || "").toString().replace(/\u200b/g, "").trim();

  const lines = raw
    ? raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    : [];

  // 仅当存在“单独一行”的清空指令时才不继承默认，避免说明文字里出现“清空默认”导致误判
  const clearDefaults = lines.some(l => /^(清空默认|clear_defaults)$/i.test(String(l).trim()));
  const useDefaults = !clearDefaults;

  // v1.6.0: “清空默认”只清空本地规则（关键词/正则/链接数），不再误把 AI 一起关掉。
  // 同时：AI 是否启用由是否存在 env.AI 绑定决定（见 classifySpamOptional / aiSpamVerdict），这里仅保留 model/threshold 配置。
  const base = sanitizeSpamRules(baseRules || DEFAULT_SPAM_RULES);
  let rules = sanitizeSpamRules(useDefaults ? base : {
    version: 1,
    max_links: 0,
    keywords: [],
    regexes: [],
    allow_keywords: [],
    allow_regexes: [],
    ai: base.ai
  });

  if (!raw) return rules;

  for (const line0 of lines) {
    const line = String(line0 || "").trim();
    if (!line) continue;

    // 指令行：不参与规则内容（避免把“清空默认”本身当成关键词）
    if (/^(清空默认|clear_defaults)$/i.test(line)) continue;

    // 忽略注释/说明行（用户复制模板时常见），避免把说明文字当成关键词
    if (line.startsWith("#") || /^[-•]\s*/.test(line)) continue;

    // 额外忽略“xxx：”这种明显标题行
    if ((/^(编辑说明|写法示例|当前规则提示词|说明)\s*[:：]?/).test(line)) continue;

    const low = line.toLowerCase();

    // max_links
    const ml = line.match(/max_links\s*[:=]\s*(\d+)/i);
    if (ml) {
      rules.max_links = Math.max(0, Math.min(20, parseInt(ml[1], 10)));
      continue;
    }

    // allow keywords
    if (low.startsWith("allow:") || low.startsWith("允许:") || low.startsWith("放行:")) {
      const rest = line.split(/[:：]/).slice(1).join(":").trim();
      rules.allow_keywords = mergeUnique(rules.allow_keywords, tokenizeLooseKeywords(rest));
      continue;
    }

    // block keywords
    if (low.startsWith("block:") || low.startsWith("spam:") || low.startsWith("垃圾:") || low.startsWith("屏蔽:")) {
      const rest = line.split(/[:：]/).slice(1).join(":").trim();
      rules.keywords = mergeUnique(rules.keywords, tokenizeLooseKeywords(rest));
      continue;
    }

    // allow regex
    if (low.startsWith("allow_re:") || low.startsWith("allow_regex:") || low.startsWith("允许正则:")) {
      const rest = line.split(/[:：]/).slice(1).join(":").trim();
      const tokens = tokenizeLooseKeywords(rest);
      const regs = tokens.map(parsePromptRegexToken).filter(Boolean);
      rules.allow_regexes = mergeUnique(rules.allow_regexes, regs);
      continue;
    }

    // block regex
    if (low.startsWith("block_re:") || low.startsWith("block_regex:") || low.startsWith("正则:") || low.startsWith("垃圾正则:")) {
      const rest = line.split(/[:：]/).slice(1).join(":").trim();
      const tokens = tokenizeLooseKeywords(rest);
      const regs = tokens.map(parsePromptRegexToken).filter(Boolean);
      rules.regexes = mergeUnique(rules.regexes, regs);
      continue;
    }

    // 裸行：按关键词处理（可用逗号/顿号分隔）
    rules.keywords = mergeUnique(rules.keywords, tokenizeLooseKeywords(line));
  }

  return sanitizeSpamRules(rules);
}

function rulesToFriendlyPrompt(rules) {
  const r = sanitizeSpamRules(rules || DEFAULT_SPAM_RULES);
  const lines = [];
  lines.push(`📝 当前规则内容：`);
  lines.push(``);
  lines.push(`max_links=${r.max_links}`);
  if ((r.keywords || []).length) lines.push(`block: ${(r.keywords || []).slice(0, 30).join("、")}`);
  if ((r.allow_keywords || []).length) lines.push(`allow: ${(r.allow_keywords || []).slice(0, 30).join("、")}`);
  if ((r.regexes || []).length) lines.push(`block_re: ${(r.regexes || []).slice(0, 10).join(", ")}`);
  if ((r.allow_regexes || []).length) lines.push(`allow_re: ${(r.allow_regexes || []).slice(0, 10).join(", ")}`);
  lines.push(``);
  return lines.join("\n");
}

function extractTextFromTelegramMessage(msg) {
  const text = (msg && (msg.text || msg.caption)) ? String(msg.text || msg.caption) : "";
  return text.trim();
}

function countUrls(text) {
  if (!text) return 0;
  const m = text.match(/https?:\/\/\S+|t\.me\/\S+|telegram\.me\/\S+/gi);
  return m ? m.length : 0;
}

function safeRegexTest(patternOrToken, text) {
  try {
    const s = String(patternOrToken ?? "");
    let body = s;
    let flags = "i";

    // 支持管理员面板配置的 /body/flags 形式（例如 /hello/i）
    const m = s.match(/^\/(.+)\/([a-z]*)$/i);
    if (m) {
      body = m[1];
      flags = m[2] || "";
    }

    // 默认不区分大小写；并避免重复追加 i
    if (!flags.includes("i")) flags += "i";

    const re = new RegExp(body, flags);
    return re.test(String(text ?? ""));
  } catch (_) {
    return false;
  }
}

function ruleBasedSpamVerdict(text, rules) {
  const t = (text || "").trim();
  if (!t) return { is_spam: false, score: 0.0, reason: "empty" };

  // allowlist 先过：一旦命中 allow，就直接放行
  for (const kw of (rules.allow_keywords || [])) {
    if (kw && t.toLowerCase().includes(kw.toLowerCase())) {
      return { is_spam: false, score: 0.0, reason: `allow_keyword:${kw}` };
    }
  }
  for (const pat of (rules.allow_regexes || [])) {
    if (pat && safeRegexTest(pat, t)) {
      return { is_spam: false, score: 0.0, reason: `allow_regex:${pat}` };
    }
  }

  const urlCount = countUrls(t);
  if (rules.max_links > 0 && urlCount >= rules.max_links) {
    return { is_spam: true, score: 0.9, reason: `rule:max_links:${urlCount}` };
  }

  for (const kw of (rules.keywords || [])) {
    if (kw && t.toLowerCase().includes(kw.toLowerCase())) {
      return { is_spam: true, score: 0.7, reason: `rule:keyword:${kw}` };
    }
  }

  for (const pat of (rules.regexes || [])) {
    if (pat && safeRegexTest(pat, t)) {
      return { is_spam: true, score: 0.75, reason: `rule:regex:${pat}` };
    }
  }

  return { is_spam: false, score: 0.0, reason: "rule:no_match" };
}

async function aiSpamVerdict(env, text, rules) {
  // v1.6.0: AI 是否启用只取决于是否绑定了 Workers AI（env.AI.run 可用），不再受 rules.ai.enabled 影响
  if (!hasWorkersAIBinding(env)) return null;

  const t = String(text || "").trim();
  if (!t) return null;

  const aiCfg = (rules && rules.ai && typeof rules.ai === "object") ? rules.ai : DEFAULT_SPAM_RULES.ai;
  const model = (aiCfg && typeof aiCfg.model === "string" && aiCfg.model.trim()) ? aiCfg.model.trim() : DEFAULT_SPAM_RULES.ai.model;

  // JSON Mode 可能无法稳定满足严格 schema（缺字段、格式错误、直接抛错），所以：
  // 1) schema 只强制 is_spam，其他字段给默认值
  // 2) json_schema 失败后回退 json_object，再失败则尝试从文本里提取 JSON
  const schema = {
    type: "object",
    additionalProperties: true,
    properties: {
      is_spam: { type: "boolean" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      category: { type: "string" },
      signals: { type: "array", items: { type: "string" }, maxItems: 8 }
    },
    required: ["is_spam"]
  };

  const systemPrompt =
    "你是垃圾消息分类器。判断文本是否为垃圾消息（广告/引流/诈骗/推广/刷单/兼职/币圈/USDT 等）。" +
    "必须只输出 JSON 对象，至少包含键 is_spam(boolean)。可选键：confidence(0-1), category(string), signals(string[]).";

  const userPayload = { text: t.slice(0, 2000) };

  function normalizeVerdict(obj) {
    if (!obj || typeof obj !== "object") return null;
    const isSpam = (typeof obj.is_spam === "boolean") ? obj.is_spam : null;
    if (isSpam === null) return null;
    const conf = Number(obj.confidence);
    // 若模型未给出 confidence：根据 is_spam 给一个保守但可用的默认值，避免“只返回 is_spam 导致永远过不了阈值”
    const confidence = (Number.isFinite(conf) && conf >= 0 && conf <= 1) ? conf : (isSpam ? 0.75 : 0.25);
    const category = (typeof obj.category === "string" && obj.category.trim()) ? obj.category.trim() : "unknown";
    const signals = Array.isArray(obj.signals) ? obj.signals.filter(x => typeof x === "string").slice(0, 8) : [];
    return {
      is_spam: !!isSpam,
      score: confidence,
      reason: `ai:${category}`,
      signals
    };
  }

  function tryParseJsonFromText(s) {
    const str = String(s || "").trim();
    if (!str) return null;
    // 去掉 ```json ... ``` 包裹
    const cleaned = str
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch (_) {
      // 尝试截取第一个 { ... }
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try {
        return JSON.parse(m[0]);
      } catch (_) {
        return null;
      }
    }
  }

  // 1) 首选：json_schema
  try {
    const out = await env.AI.run(model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) }
      ],
      response_format: { type: "json_schema", json_schema: schema }
    });

    const r = out && out.response ? out.response : null;
    const parsed = (typeof r === "string") ? tryParseJsonFromText(r) : r;
    const verdict = normalizeVerdict(parsed);
    if (verdict) return verdict;
  } catch (e) {
    try {
      console.warn("[spam-ai] json_schema failed; fallback to json_object", String(e && (e.message || e)));
    } catch (_) {}
  }

  // 2) 回退：json_object
  try {
    const out2 = await env.AI.run(model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) }
      ],
      response_format: { type: "json_object" }
    });

    const r2 = out2 && out2.response ? out2.response : null;
    const parsed2 = (typeof r2 === "string") ? tryParseJsonFromText(r2) : r2;
    const verdict2 = normalizeVerdict(parsed2);
    if (verdict2) return verdict2;
  } catch (e2) {
    try {
      console.warn("[spam-ai] json_object failed; fallback to free-form parse", String(e2 && (e2.message || e2)));
    } catch (_) {}
  }

  // 3) 最后兜底：不指定 response_format（模型可能输出自然语言，尽量提取 JSON）
  try {
    const out3 = await env.AI.run(model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) }
      ]
    });
    const r3 = out3 && out3.response ? out3.response : null;
    const parsed3 = (typeof r3 === "string") ? tryParseJsonFromText(r3) : r3;
    const verdict3 = normalizeVerdict(parsed3);
    if (verdict3) return verdict3;
  } catch (_) {
    // 静默失败：最终回落为 null（放行）
  }

  return null;
}

async function classifySpamOptional(env, msg) {
  const enabled = await getGlobalSpamFilterEnabled(env);
  if (!enabled) return { is_spam: false, score: 0.0, reason: "spam_filter_disabled", ai_used: false };

  const rules = await getGlobalSpamFilterRules(env);
  const text = extractTextFromTelegramMessage(msg);
  const ruleVerdict = ruleBasedSpamVerdict(text, rules);
  if (ruleVerdict.is_spam) {
    return { ...ruleVerdict, ai_used: false };
  }

  const ai = await aiSpamVerdict(env, text, rules);
  if (ai) {
    // v1.6.0: 阈值统一为 0.65（sanitizeSpamRules 已固定），这里继续沿用 rules.ai.threshold 以保持一致
    const isSpam = ai.is_spam && ai.score >= (rules && rules.ai ? rules.ai.threshold : DEFAULT_SPAM_RULES.ai.threshold);
    return { is_spam: !!isSpam, score: ai.score, reason: ai.reason, ai_used: true };
  }

  return { is_spam: false, score: 0.0, reason: "rule:no_match", ai_used: false };
}

async function notifyUserSpamDropped(env, userId) {
  try {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "🗑️ 您刚发送的消息被系统识别为垃圾信息，已被拦截丢弃，您可联系管理员将您加入白名单即可绕过拦截。"
    });
  } catch (_) {}
}



async function getOrCreateUserTopicRecByUserId(env, userId) {
  const userKey = `user:${userId}`;
  let rec = await kvGetJSON(env, userKey, null);

  if (rec && rec.thread_id) {
    const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "user_topic_probe" });
    if (probe && probe.status === "ok") return rec;
  }

  // 取用户信息用于标题
  let userInfo = null;
  try {
    const chatRes = await tgCall(env, "getChat", { chat_id: userId });
    if (chatRes.ok && chatRes.result) userInfo = chatRes.result;
  } catch (_) {}

  const title = buildTopicTitle(userInfo || { id: userId });

  const topicRes = await tgCall(env, "createForumTopic", {
    chat_id: env.SUPERGROUP_ID,
    name: title
  });

  if (!topicRes || !topicRes.ok || !topicRes.result) {
    throw new Error(`createForumTopic failed: ${topicRes?.description || "unknown"}`);
  }

  rec = {
    thread_id: topicRes.result.message_thread_id,
    title
  };

  await kvPut(env, userKey, JSON.stringify(rec));
  await kvPut(env, `thread:${rec.thread_id}`, String(userId));
  return rec;
}

// 统一发起“人机验证”（根据：已有会话 provider > 全局模式）
async function sendHumanVerification(userId, env, pendingMsgId = null, origin = null, isStartCommand = false) {
  const sessionKey = `verify_session:${userId}`;
  // 仅用于判定“是否已有会话/使用哪个 provider”，不在此处读全局开关，避免引入额外状态。
  // 若已有 verify_session，则按会话内 provider 继续完成（切换不影响正在验证的用户）。
  let sessionData = await kvGetJSON(env, sessionKey, null, { cacheTtl: CONFIG.KV_CRITICAL_CACHE_TTL });

  // 若存在会话但缺 provider（旧版本迁移），默认按 Turnstile 继续，确保不影响正在验证的用户
  let provider = sessionData && sessionData.provider ? String(sessionData.provider) : null;
  if (!provider && sessionData) {
    provider = VERIFY_MODE_DEFAULT;
    try {
      sessionData.provider = provider;
      await kvPut(env, sessionKey, JSON.stringify(sessionData), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
    } catch (_) {}
  }

  if (!provider) {
    provider = await getGlobalVerifyMode(env);
  }

  // turnstile 作为可选能力：未配置则自动回落到本地题库
  if (provider === "turnstile" && !hasTurnstileBinding(env)) {
    provider = "local_quiz";
  }

  if (provider === "local_quiz") {
    return await sendLocalQuizVerification(userId, env, pendingMsgId, isStartCommand);
  }

  // turnstile
  let workerOrigin = origin;
  if (!workerOrigin) {
    workerOrigin = await getWorkerOrigin(env);
  }
  if (!workerOrigin) {
    Logger.error('sendHumanVerification_no_origin_for_turnstile', { userId });
    await tgCall(env, "sendMessage", { chat_id: userId, text: ERROR_MESSAGES.worker_origin_error });
    return;
  }
  return await sendTurnstileVerification(userId, env, pendingMsgId, workerOrigin, isStartCommand);
}


// 发送本地题库验证（纯 Telegram 内联按钮）
// 规则：单题 1 分钟有效；超时后用户再次发消息或 /start 才触发下一题；5 分钟内最多触发 3 次
async function sendLocalQuizVerification(userId, env, pendingMsgId = null, isStartCommand = false, opts = null) {
  const forceNewQuestion = !!(opts && opts.forceNewQuestion);
  let enableStorage;
  const sessionKey = `verify_session:${userId}`;

  // 不使用 cacheTtl，避免边缘缓存导致 pending_ids 丢失/读到旧值
  let sessionData = await kvGetJSON(env, sessionKey, null, {});
  enableStorage = true;

  // 若已有会话但 provider 不是 local_quiz，则保持原会话完成（不受全局切换影响）
  if (sessionData && sessionData.provider && sessionData.provider !== "local_quiz") {
    const origin = await getWorkerOrigin(env);
    if (origin) return await sendTurnstileVerification(userId, env, pendingMsgId, origin, isStartCommand);
  }

  const now = Date.now();

  // 已存在本地题库会话：单题 1 分钟内不重复发题，只做消息暂存 + 提示一次
  const existingVerifyId = sessionData?.quiz?.verifyId;
  const issuedAt = Number(sessionData?.quiz?.issuedAt || 0);
  const hasActiveQuestion = !!(existingVerifyId && Number.isFinite(issuedAt) && (now - issuedAt) < LOCAL_QUIZ_CHALLENGE_VALID_MS);

  if (!forceNewQuestion && sessionData && sessionData.provider === "local_quiz" && hasActiveQuestion) {
    if (enableStorage && pendingMsgId) {
      sessionData.pending_ids = pushUniqueLimited(sessionData.pending_ids, pendingMsgId, CONFIG.PENDING_MAX_MESSAGES);
let shouldSendNotice = false;
      if (!sessionData.hasSentStorageNotice) {
        sessionData.hasSentStorageNotice = true;
        shouldSendNotice = true;
      }

      await kvPut(env, sessionKey, JSON.stringify(sessionData), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });

      if (shouldSendNotice) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: USER_NOTIFICATIONS.first_message_stored });
      }
      return;
    }

    // 避免刷屏：同一题目有效期内最多提示一次
    const noticeKey = `quiz_notice_sent:${userId}`;
    const noticeSent = await cacheGetText(noticeKey);
    if (!noticeSent) {
      await tgCall(env, "sendMessage", { chat_id: userId, text: "⏳ 题目已发送，请在 1 分钟内作答。" });
      await cachePutText(noticeKey, "1", 60);
    }
    return;
  }

  // 需要发新题（首次或上一题超时）
  // 5分钟内最多触发 3 次；超过则提示频繁
  const trig = await consumeLocalQuizTrigger(userId, env);
  if (!trig.allowed) {
    await tgCall(env, "sendMessage", { chat_id: userId, text: ERROR_MESSAGES.rate_limit });
    return;
  }

  // 清理旧题（best-effort）
  if (existingVerifyId) {
    try { await kvDelete(env, `quiz_chal:${existingVerifyId}`); } catch (_) {}
  }

  if (!sessionData) {
    sessionData = {
      userId,
      pending_ids: [],
      timestamp: now,
      sessionId: secureRandomId(16),
      verificationSent: true,
      enableStorage,
      provider: "local_quiz",
      quiz: {}
    };
  } else {
    sessionData.verificationSent = true;
    sessionData.enableStorage = enableStorage;
    sessionData.provider = "local_quiz";
    if (!sessionData.quiz) sessionData.quiz = {};
    if (!Array.isArray(sessionData.pending_ids)) sessionData.pending_ids = [];
  }

  // 将触发验证的消息加入 pending_ids（KV 持久）
  if (pendingMsgId && enableStorage) {
    sessionData.pending_ids = pushUniqueLimited(sessionData.pending_ids, pendingMsgId, CONFIG.PENDING_MAX_MESSAGES);
  }

  const verifyId = secureRandomId(10);
  sessionData.quiz.verifyId = verifyId;
  sessionData.quiz.issuedAt = now;

  await kvPut(env, sessionKey, JSON.stringify(sessionData), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
  await kvPut(env, `pending_verify:${userId}`, "1", { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });

  // 随机出题
  const item = LOCAL_QUIZ_QUESTIONS[Math.floor(Math.random() * LOCAL_QUIZ_QUESTIONS.length)];
  const chalKey = `quiz_chal:${verifyId}`;
  const chal = {
    userId,
    q: item.q,
    opts: item.opts,
    a: item.a,
    createdAt: now
  };
  await kvPut(env, chalKey, JSON.stringify(chal), { expirationTtl: LOCAL_QUIZ_CHALLENGE_TTL_SECONDS });

  const keyboard = [];
  for (let i = 0; i < item.opts.length; i += 2) {
    const row = [{
      text: item.opts[i],
      callback_data: `vq|${verifyId}|${i}`
    }];
    if (i + 1 < item.opts.length) {
      row.push({
        text: item.opts[i + 1],
        callback_data: `vq|${verifyId}|${i + 1}`
      });
    }
    keyboard.push(row);
  }

  const intro = isStartCommand
    ? "🤖 请先完成一次人机验证。"
    : "🤖 需要验证后才能继续，请回答下面的问题：";

  // 去掉 Markdown 符号，避免出现多余的 **
  await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: `${intro}

📝 题目：${item.q}

请选择一个答案：`,
    reply_markup: { inline_keyboard: keyboard }
  });
}


// 处理本地题库回调（vq|verifyId|idx）
async function handleLocalQuizCallback(callbackQuery, env, ctx) {
  const data = (callbackQuery && callbackQuery.data) ? String(callbackQuery.data) : "";
  const userId = callbackQuery?.from?.id;
  if (!userId) return;

  // 立即 ACK
  try {
    const ack = tgCall(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id });
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(ack);
    else await ack;
  } catch (_) {}

  const parts = data.split("|");
  if (parts.length < 3) return;

  const verifyId = parts[1];
  const idx = parseInt(parts[2], 10);
  if (!verifyId || !Number.isFinite(idx)) return;

  // 幂等：若已验证，直接提示并移除按钮
  const verifiedKey = `verified:${userId}`;
  const alreadyVerified = await kvGetText(env, verifiedKey, CONFIG.KV_CRITICAL_CACHE_TTL);
  if (alreadyVerified) {
    try { await tgCall(env, "sendMessage", { chat_id: userId, text: USER_NOTIFICATIONS.verified_success }); } catch (_) {}
    try {
      if (callbackQuery.message) {
        const chatId = callbackQuery.message.chat?.id;
        const messageId = callbackQuery.message.message_id;
        if (chatId && messageId) {
          const p = tgCall(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
          if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p); else await p;
        }
      }
    } catch (_) {}
    return;
  }

  const chalKey = `quiz_chal:${verifyId}`;
  const chal = await kvGetJSON(env, chalKey, null, {});
  if (!chal || chal.userId !== userId || !Array.isArray(chal.opts) || typeof chal.a !== "number") {
    try { await tgCall(env, "sendMessage", { chat_id: userId, text: "⏳ 题目已过期，请重新验证。" }); } catch (_) {}
    return;
  }

  // 单题 1 分钟有效期：即便 KV 还没过期，也按 createdAt 强制判过期
  if (chal.createdAt && (Date.now() - Number(chal.createdAt) > LOCAL_QUIZ_CHALLENGE_VALID_MS)) {
    try { await tgCall(env, "sendMessage", { chat_id: userId, text: "⏳ 题目已过期，请重新验证。" }); } catch (_) {}
    return;
  }

  // 读会话，确保 provider 绑定（切换不影响正在验证的人）
  const sessionKey = `verify_session:${userId}`;
  const sessionData = await kvGetJSON(env, sessionKey, null, {});

  // 每题仅 1 次作答机会：答错一次就换题
  const correct = (idx === chal.a);
  if (!correct) {
    // 失效当前题目，避免重复点击
    await kvDelete(env, chalKey);

    // 移除按钮（best-effort）
    try {
      if (callbackQuery.message) {
        const chatId = callbackQuery.message.chat?.id;
        const messageId = callbackQuery.message.message_id;
        if (chatId && messageId) {
          const p = tgCall(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
          if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p); else await p;
        }
      }
    } catch (_) {}

    await tgCall(env, "sendMessage", { chat_id: userId, text: "❌ 答案不正确，已为您更换题目。" });

    // 立即下发新题（强制跳过 1 分钟内不重复发题的逻辑）
    await sendLocalQuizVerification(userId, env, null, false, { forceNewQuestion: true });
    return;
  }

  // 正确：写 verified + grace，并清理会话/挑战
  const verifiedTtl = getVerifiedTtlSeconds(env);
  if (verifiedTtl > 0) await kvPut(env, verifiedKey, "1", { expirationTtl: verifiedTtl });
  else await kvPut(env, verifiedKey, "1");

  const graceTtl = normalizeKvExpirationTtl(CONFIG.VERIFIED_GRACE_SECONDS);
  if (graceTtl) await kvPut(env, `verified_grace:${userId}`, "1", { expirationTtl: graceTtl });

  await kvDelete(env, `pending_verify:${userId}`);
  await kvDelete(env, sessionKey);
  await kvDelete(env, chalKey);

  // 移除按钮
  try {
    if (callbackQuery.message) {
      const chatId = callbackQuery.message.chat?.id;
      const messageId = callbackQuery.message.message_id;
      if (chatId && messageId) {
        const p = tgCall(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p); else await p;
      }
    }
  } catch (_) {}

  // 补转发暂存消息（KV pending_ids）
  await processPendingMessagesAfterVerification(userId, sessionData, env);

  Logger.info("local_quiz_verified_success", { userId });
}



// 错误信息映射表
const ERROR_MESSAGES = {
    topic_not_found: "⚠️ 对话通道暂时不可用，已为您创建新的对话",
    rate_limit: "⏳ 请求过于频繁，请稍后再试",
    system_error: "🔧 系统维护中，请稍后再试",
    kv_quota_exceeded: "⚠️ Cloudflare KV 操作被限制（可能是对同一 key 写入过于频繁触发 429，或已达账户/免费额度上限）。请稍后重试；若一直无法恢复，请在 Cloudflare 后台检查 KV 用量与限流情况。",
    verification_required: "🛡 请先完成人机验证才能发送消息",
    verification_expired: "🔄 验证已过期，请重新验证",
    message_too_long: "📝 消息过长，请缩短后重试",
    media_unsupported: "📸 暂不支持此类型媒体文件",
    
    admin_only: "🚫 仅管理员可执行此操作",
    reset_in_progress: "⏳ 已有重置操作正在进行，请稍后再试",
    reset_not_triggered: "❌ 您尚未触发重置操作",
    reset_session_expired: "⏳ 重置会话已过期，请重新触发重置操作",
    reset_admin_mismatch: "🚫 只能确认自己触发的重置操作",
    
    network_error: "📡 网络连接不稳定，请稍后重试",
    server_error: "⚙️ 服务器暂时繁忙，请稍后再试",
    
    worker_origin_error: "🔗 系统配置错误：无法获取Worker域名，请联系管理员",
    
    bot_closed: "⛔ 私聊机器人已关闭，请稍后再试",
    bot_closed_reply: "⛔ 机器人已关闭，请开启总开关后使用（在 General 话题使用 /settings 开启）。",
    already_closed: "❌ 私聊机器人已关闭，不要重复使用该指令",
    already_opened: "❌ 私聊机器人已开启，不要重复使用该指令",
    
    info_command_error: `❌ 命令使用错误

/info 命令只能在用户话题中使用。`,
    clean_command_error: `❌ 命令使用错误

/clean 命令只能在用户话题中使用。`,
    trust_command_error: `❌ 命令使用错误

/trust 命令只能在用户话题中使用。`,
    off_command_error: `❌ 命令使用错误

/off 命令只能在 General 话题中使用。`,
    on_command_error: `❌ 命令使用错误

/on 命令只能在 General 话题中使用。`,
    settings_command_error: `❌ 命令使用错误

/settings 命令只能在 General 话题中使用。`
};

// 用户提示信息
const USER_NOTIFICATIONS = {
    verified_success: "✅ 激活完成！您可以直接发送消息给管理员了",
    pending_forwarded: (count) => `📩 刚才的 ${count} 条消息已帮您送达`,
    welcome: "👋 欢迎使用！请先完成人机验证",
    retry_limit: "❌ 系统繁忙，请稍后再试",
    verification_sent: "🛡 为了防止垃圾消息，请在5分钟内点击下方按钮完成人机验证",
    already_verifying: "⏳ 验证已发送，请完成验证后继续发送消息",
    message_stored: "📝 消息已暂存，完成验证后会自动发送",
    first_message_stored: `📝 消息已暂存，完成验证后会自动发送（最多暂存${CONFIG.PENDING_MAX_MESSAGES}条，超出发送最后${CONFIG.PENDING_MAX_MESSAGES}条）`,
    verification_required_no_storage: "🛡 请在5分钟内完成人机验证，才能发送消息",
    verification_button_disabled: "☁️ Cloudflare 验证成功",
    verification_button_failed: "☁️ Cloudflare 验证失败，请稍后再试",
};

// 线程健康检查缓存，减少频繁探测请求
// --- 实例内缓存保护：防止 Map 长期增长导致内存膨胀（仅影响缓存命中率，不影响功能）---
const LOCAL_CACHE_LIMITS = {
    threadHealth: 5000,
    adminStatus: 2000,
    topicCreateInFlight: 1000
};

function mapGetFresh(map, key, ttlMs = undefined) {
    const v = map.get(key);
    if (!v) return null;

    if (ttlMs !== undefined && v && typeof v === "object" && typeof v.ts === "number") {
        const now = Date.now();
        if (now - v.ts > ttlMs) {
            map.delete(key);
            return null;
        }
    }
    // 触碰以维持近似 LRU（Map 按插入顺序迭代）
    map.delete(key);
    map.set(key, v);
    return v;
}

function mapSetBounded(map, key, value, maxSize) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    const lim = Math.max(0, Math.floor(Number(maxSize || 0)));
    if (lim > 0) {
        while (map.size > lim) {
            const oldest = map.keys().next().value;
            if (oldest === undefined) break;
            map.delete(oldest);
        }
    }
}

const threadHealthCache = new Map();
// 同一实例内的并发保护：避免同一用户短时间内重复创建话题
const topicCreateInFlight = new Map();
// 管理员权限缓存（实例内）
const adminStatusCache = new Map();

// --- 辅助工具函数 ---

// 结构化日志系统
const Logger = {
    info(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            action,
            ...data
        };
        console.log(JSON.stringify(log));
    },

    warn(action, errorOrData = {}, data = {}) {
        // support calling warn(action, error, data) or warn(action, data)
        let payload = {};
        if (errorOrData instanceof Error) {
            payload = { error: errorOrData.message, stack: errorOrData.stack, ...data };
        } else {
            payload = { ...errorOrData, ...data };
        }
        const log = {
            timestamp: new Date().toISOString(),
            level: 'WARN',
            action,
            ...payload
        };
        console.warn(JSON.stringify(log));
    },

    error(action, error, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            action,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            ...data
        };
        console.error(JSON.stringify(log));
    },

    debug(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'DEBUG',
            action,
            ...data
        };
        console.log(JSON.stringify(log));
    }
};

// 加密安全的随机数生成


function secureRandomId(length = 16) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// 安全的 JSON 获取
// 安全的 JSON 获取（支持 cacheTtl，用于降低 KV 负缓存窗口）
/**
 * 记录用户基础资料（仅来自已收到的 Update，不做任何额外 Telegram API 拉取）
 * username 是可选字段：部分用户没有设置 username。
 * 仅用于 /blacklist 展示增强。
 */
async function upsertUserProfileFromUpdate(env, user) {
    try {
        if (!user || !user.id) return;

        const cooldownKey = `profile:cooldown:${user.id}`;
        const cooldown = await cacheGetText(cooldownKey);
        if (cooldown) return;

        // 6 小时内同一用户最多尝试一次 profile 更新
        await cachePutText(cooldownKey, "1", 6 * 3600);

        const newProfile = {
            user_id: user.id,
            first_name: user.first_name || "",
            last_name: user.last_name || "",
            username: user.username || "",
            updated_at: Date.now()
        };

        const existing = await kvGetJSON(env, `profile:${user.id}`, null, { cacheTtl: CONFIG.KV_CRITICAL_CACHE_TTL });

        const stale = !existing || !existing.updated_at || (Date.now() - Number(existing.updated_at) > 7 * 24 * 3600 * 1000);
        const changed = !existing ||
            existing.first_name !== newProfile.first_name ||
            existing.last_name !== newProfile.last_name ||
            existing.username !== newProfile.username;

        if (stale || changed) {
            await kvPut(env, `profile:${user.id}`, JSON.stringify(newProfile));
        }
    } catch (e) {
        Logger.warn('upsertUserProfile_failed', e);
    }
}


// KV TTL 规范化：Cloudflare KV expirationTtl 最小为 60 秒
function normalizeKvExpirationTtl(ttlSeconds) {
    const n = Math.floor(Number(ttlSeconds));
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.max(60, n);
}


// KV cacheTtl 规范化：Cloudflare KV cacheTtl 最小为 60 秒（不满足则不传 options，使用默认行为）
function normalizeKvCacheTtl(cacheTtlSeconds) {
    if (cacheTtlSeconds === undefined || cacheTtlSeconds === null) return undefined;
    const n = Math.floor(Number(cacheTtlSeconds));
    if (!Number.isFinite(n)) return undefined;
    if (n < 60) return undefined;
    return n;
}

function normalizeKvGetOptions(options) {
    if (!options || typeof options !== "object") return undefined;
    const out = { ...options };
    if (out.cacheTtl !== undefined) {
        const ttl = normalizeKvCacheTtl(out.cacheTtl);
        if (ttl !== undefined) out.cacheTtl = ttl;
        else delete out.cacheTtl;
    }
    return Object.keys(out).length ? out : undefined;
}


function getVerifiedTtlSeconds(env) {
    const raw = env?.VERIFIED_TTL_SECONDS ?? CONFIG.VERIFIED_TTL_SECONDS_DEFAULT;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(60, n);
}


// --- 人机验证：跨会话暂存消息队列 & 验证按钮消息追踪（v1.2）---
function pendingQueueKey(userId) {
    return `pending_queue:${userId}`;
}

function verifyPromptMsgsKey(userId) {
    return `verify_prompt_msgs:${userId}`;
}

async function getPendingQueue(env, userId) {
    const arr = await kvGetJSON(env, pendingQueueKey(userId), [], {});
    return Array.isArray(arr) ? arr : [];
}

function normalizeMessageIdList(ids) {
    if (!Array.isArray(ids)) return [];
    const seen = new Set();
    const out = [];
    for (const x of ids) {
        const n = Number(x);
        if (!Number.isFinite(n)) continue;
        const nn = Math.floor(n);
        if (nn <= 0) continue;
        if (seen.has(nn)) continue;
        seen.add(nn);
        out.push(nn);
    }
    out.sort((a, b) => a - b);
    return out;
}

async function overwritePendingQueue(env, userId, ids) {
    const cleaned = normalizeMessageIdList(ids);
    const trimmed = cleaned.length > CONFIG.PENDING_MAX_MESSAGES
        ? cleaned.slice(-CONFIG.PENDING_MAX_MESSAGES)
        : cleaned;
    if (trimmed.length === 0) {
        await kvDelete(env, pendingQueueKey(userId));
        return [];
    }
    await kvPut(env, pendingQueueKey(userId), JSON.stringify(trimmed), {
        expirationTtl: CONFIG.PENDING_QUEUE_TTL_SECONDS
    });
    return trimmed;
}

async function appendPendingQueue(env, userId, messageId) {
    const mid = Math.floor(Number(messageId));
    if (!Number.isFinite(mid) || mid <= 0) return await getPendingQueue(env, userId);
    let arr = await getPendingQueue(env, userId);
    if (!arr.includes(mid)) {
        arr.push(mid);
    }
    if (arr.length > CONFIG.PENDING_MAX_MESSAGES) {
        arr = arr.slice(-CONFIG.PENDING_MAX_MESSAGES);
    }
    await kvPut(env, pendingQueueKey(userId), JSON.stringify(arr), {
        expirationTtl: CONFIG.PENDING_QUEUE_TTL_SECONDS
    });
    return arr;
}

async function addVerifyPromptMsgId(env, userId, messageId) {
    const mid = Math.floor(Number(messageId));
    if (!Number.isFinite(mid) || mid <= 0) return;
    const key = verifyPromptMsgsKey(userId);
    let arr = await kvGetJSON(env, key, [], {});
    if (!Array.isArray(arr)) arr = [];
    if (!arr.includes(mid)) arr.push(mid);
    const maxIds = Math.max(1, Math.floor(Number(CONFIG.VERIFY_PROMPT_MAX_IDS || 6)));
    if (arr.length > maxIds) arr = arr.slice(-maxIds);
    await kvPut(env, key, JSON.stringify(arr), {
        expirationTtl: CONFIG.VERIFY_PROMPT_TTL_SECONDS
    });
}

async function removeVerifyPromptKeyboardsBestEffort(env, userId, ctx, overrideText = null) {
    try {
        const key = verifyPromptMsgsKey(userId);
        // v1.3：这里不要用 cacheTtl（KV 的 cacheTtl 最小 60s），否则可能读到旧值导致“按钮没被取消”
        let arr = await kvGetJSON(env, key, [], {});
        if (!Array.isArray(arr) || arr.length === 0) {
            await kvDelete(env, key);
            return;
        }

        const chatId = userId;
        const disabledText = (overrideText || USER_NOTIFICATIONS.verification_button_disabled || "✅ 人机验证已通过，此按钮已失效。");

        // 方式 B：使用 editMessageText 重新编辑文本且不带 reply_markup，
        // Telegram 客户端会移除原先的 inline keyboard（避免用户验证后继续点旧按钮）
        const tasks = arr.map(mid => (async () => {
            try {
                await tgCall(env, "editMessageText", {
                    chat_id: chatId,
                    message_id: mid,
                    text: disabledText,
                    disable_web_page_preview: true
                    // 注意：这里刻意不传 reply_markup
                });
            } catch (_) {}
        })());

        const p = Promise.allSettled(tasks);
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
        else await p;

        await kvDelete(env, key);
    } catch (_) {}
}



// 方案B：除 banned:* 外，所有 KV 键统一写入 data:* 命名空间。
// 这样 /resetkv 可以仅保留 banned:*，其余全部删除。
const KV_DATA_PREFIX = "data:";

// Cache API（caches.default）key 构造
function cacheKeyUrl(key) {
    // 使用固定域名避免泄露真实 Worker 域名；Cache API 仅使用 URL 作为 key
    return `https://cache.local/${encodeURIComponent(key)}`;
}

async function cacheGetText(key) {
    const req = new Request(cacheKeyUrl(key));
    const hit = await caches.default.match(req);
    if (!hit) return null;
    return await hit.text();
}

async function cachePutText(key, value, ttlSeconds) {
    const ttl = Math.max(1, Math.floor(Number(ttlSeconds || 0)));
    const req = new Request(cacheKeyUrl(key));
    const res = new Response(String(value), {
        headers: {
            // Cache API 不受 KV cacheTtl 最小 60 的限制，但这里仍保留合理 TTL
            "Cache-Control": `max-age=${ttl}`
        }
    });
    await caches.default.put(req, res);
}

async function cacheDelete(key) {
    const req = new Request(cacheKeyUrl(key));
    await caches.default.delete(req);
}

async function cacheGetJSON(key, defaultValue = null) {
    try {
        const t = await cacheGetText(key);
        if (t === null) return defaultValue;
        return JSON.parse(t);
    } catch {
        return defaultValue;
    }
}

async function cachePutJSON(key, obj, ttlSeconds) {
    return cachePutText(key, JSON.stringify(obj), ttlSeconds);
}

// --- KV 配额熔断（避免超额后持续触发 KV 错误导致机器人无法使用）---
const KV_QUOTA_BREAKER_KEY = "__kv_quota_exceeded_v7_0g1__";
const KV_QUOTA_NOTICE_COOLDOWN_PREFIX = "__kv_quota_notice__:";

function secondsUntilNextUtcMidnight() {
    const now = new Date();
    const next = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0, 0, 0, 0
    ));
    const diffMs = next.getTime() - now.getTime();
    const sec = Math.ceil(diffMs / 1000);
    // 避免过短 TTL
    return Math.max(60, sec);
}

function isKvQuotaError(err) {
    // 只将“明确来自 KV 的 429”视为 KV 配额/限流错误，避免把 Telegram / 外部接口的 429 误判为 KV 超限
    const msgRaw = (err && (err.message || err.toString())) ? String(err.message || err.toString()) : "";
    const msg = msgRaw.toLowerCase();
    const status = err && typeof err === "object" ? (err.status || err.statusCode) : undefined;

    // KV 常见错误为：`KV PUT failed: 429 Too Many Requests` / `KV GET failed: 429 ...`
    const looksLikeKv = msg.includes("kv put") || msg.includes("kv get") || msg.includes("kv list") || msg.includes("workers kv") ||
                        (msg.includes("kv") && (msg.includes("namespace") || msg.includes("key-value") || msg.includes("key value")));

    if (!looksLikeKv) return false;

    return status === 429 ||
        msg.includes("kv put failed: 429") ||
        msg.includes("kv get failed: 429") ||
        msg.includes("kv list failed: 429") ||
        (msg.includes("429") && (msg.includes("too many requests") || msg.includes("rate") || msg.includes("quota") || msg.includes("limit") || msg.includes("exceeded")));
}

async function tripKvQuotaBreaker() {
    const ttl = secondsUntilNextUtcMidnight(); // 对齐免费额度每天 UTC 00:00 重置 => UTC+8 早上 08:00
    await cachePutText(KV_QUOTA_BREAKER_KEY, "1", ttl);
    return ttl;
}

async function isKvQuotaBreakerTripped() {
    const v = await cacheGetText(KV_QUOTA_BREAKER_KEY);
    return v === "1";
}

async function shouldSendKvQuotaNotice(chatId) {
    const key = `${KV_QUOTA_NOTICE_COOLDOWN_PREFIX}${chatId}`;
    const v = await cacheGetText(key);
    if (v) return false;
    // 冷却 60s，避免刷屏
    await cachePutText(key, "1", 60);
    return true;
}

async function sendKvQuotaExceededNotice(env, chatId, threadId) {
    try {
        if (!(await shouldSendKvQuotaNotice(chatId))) return;
        const payload = withMessageThreadId({
            chat_id: chatId,
            text: ERROR_MESSAGES.kv_quota_exceeded
        }, threadId);
        await tgCall(env, "sendMessage", payload);
    } catch (e) {
        Logger.warn("kv_quota_notice_send_failed", e, { chatId, threadId });
    }
}

// --- KV Keyspace 映射 ---
function kvIsBannedKey(key) {
    if (typeof key !== "string") return false;
    const legacy = key.startsWith(KV_DATA_PREFIX) ? key.slice(KV_DATA_PREFIX.length) : key;

    // 永久保留：黑名单 key
    if (legacy.startsWith("banned:") || legacy.startsWith("data:banned:")) return true;

    // 永久保留：/trust 白名单 key（不会被 /clean 和 resetkv 清掉）
    if (legacy.startsWith("trusted:") || legacy.startsWith("data:trusted:")) return true;

    // 保留：关键全局开关/模式（“清空并重置所有聊天数据”不会清掉它们）
    if (legacy === "global_switch:enabled" ||
        legacy === GLOBAL_VERIFY_MODE_KEY ||
        legacy === "global_pending_storage:enabled") {
        return true;
    }
// 保留：垃圾过滤设置/规则（“清空并重置所有聊天数据”不会清掉它们，v1.1.1b）
    if (legacy === GLOBAL_SPAM_FILTER_ENABLED_KEY ||
        legacy === GLOBAL_SPAM_FILTER_RULES_KEY ||
        legacy === GLOBAL_SPAM_FILTER_RULES_PROMPT_KEY) {
        return true;
    }
    return false;
}

function kvToPhysicalKey(key) {
    if (typeof key !== "string") return key;
    if (key.startsWith(KV_DATA_PREFIX)) return key;
    if (key.startsWith("banned:")) return key; // 物理键保持 banned:*
    return KV_DATA_PREFIX + key;
}

async function kvGetInternal(env, key, options) {
    try {
        const physical = kvToPhysicalKey(key);
        const v = await env.TOPIC_MAP.get(physical, options);
        if ((v === null || v === undefined) && typeof key === "string" && !key.startsWith(KV_DATA_PREFIX) && !key.startsWith("banned:")) {
            // 兼容旧版（未使用 data: 前缀）的键
            return await env.TOPIC_MAP.get(key, options);
        }
        return v;
    } catch (e) {
        if (isKvQuotaError(e)) {
            await tripKvQuotaBreaker();
        }
        throw e;
    }
}

async function kvPut(env, key, value, options = undefined) {
    try {
        const physical = kvToPhysicalKey(key);
        // 规范化 expirationTtl（Cloudflare KV 最小 60）
        if (options && typeof options === "object" && options.expirationTtl !== undefined) {
            const ttl = normalizeKvExpirationTtl(options.expirationTtl);
            if (ttl !== undefined) {
                options = { ...options, expirationTtl: ttl };
            } else {
                const { expirationTtl, ...rest } = options;
                options = Object.keys(rest).length ? rest : undefined;
            }
        }
        await env.TOPIC_MAP.put(physical, value, options);
    } catch (e) {
        if (isKvQuotaError(e)) {
            await tripKvQuotaBreaker();
        }
        throw e;
    }
}

async function kvDelete(env, key) {
    const physical = kvToPhysicalKey(key);
    await kvDeletePhysical(env, physical);

    if (typeof key !== "string") return;

    // 兼容清理：防止删除 data:* 后旧版未加 data: 前缀的键“复活”
    // - banned:* 同时尝试删除 data:banned:*（历史遗留）
    // - data:* 同时尝试删除去掉 data: 前缀的 legacy 键
    // - 其他键同时尝试删除其 legacy 物理键
    if (key.startsWith("banned:")) {
        const legacyPhysical = KV_DATA_PREFIX + key;
        if (legacyPhysical !== physical) {
            try { await kvDeletePhysical(env, legacyPhysical); } catch { }
        }
        return;
    }

    if (key.startsWith(KV_DATA_PREFIX)) {
        const legacy = key.slice(KV_DATA_PREFIX.length);
        if (legacy && !kvIsBannedKey(legacy) && legacy !== physical) {
            try { await kvDeletePhysical(env, legacy); } catch { }
        }
        return;
    }

    if (!kvIsBannedKey(key) && key !== physical) {
        try { await kvDeletePhysical(env, key); } catch { }
    }
}
// 删除“物理 key”（来自 list 的 key.name），不要做 data: 前缀映射
async function kvDeletePhysical(env, physicalKey) {
    try {
        await env.TOPIC_MAP.delete(physicalKey);
    } catch (e) {
        if (isKvQuotaError(e)) {
            await tripKvQuotaBreaker();
        }
        throw e;
    }
}


async function kvGetPhysical(env, physicalKey, options) {
    try {
        const opts = { ...(options || {}) };
        if (typeof opts === "object" && opts.cacheTtl !== undefined) {
            const ttl = normalizeKvCacheTtl(opts.cacheTtl);
            if (ttl !== undefined) {
                opts.cacheTtl = ttl;
            } else {
                delete opts.cacheTtl;
            }
        }
        return await env.TOPIC_MAP.get(String(physicalKey), opts);
    } catch (e) {
        if (isKvQuotaError(e)) {
            await tripKvQuotaBreaker();
        }
        throw e;
    }
}

async function kvListPhysical(env, options) {
    try {
        const opts = { ...(options || {}) };
        return await env.TOPIC_MAP.list(opts);
    } catch (e) {
        if (isKvQuotaError(e)) {
            await tripKvQuotaBreaker();
        }
        throw e;
    }
}

async function safePutJSON(env, key, valueObj, options = undefined) {
    // Helper to store JSON in KV with the same TTL normalization as kvPut.
    const payload = JSON.stringify(valueObj === undefined ? null : valueObj);
    await kvPut(env, key, payload, options);
}
async function safeGetJSONPhysical(env, physicalKey, defaultValue, options) {
    try {
        const raw = await kvGetPhysical(env, physicalKey, options);
        if (!raw) return defaultValue;
        return JSON.parse(raw);
    } catch (e) {
        if (isKvQuotaError(e)) {
            await tripKvQuotaBreaker();
            return defaultValue;
        }
        Logger.error("kv_parse_failed_physical", e, { key: physicalKey });
        return defaultValue;
    }
}



async function kvList(env, options) {
    try {
        const opts = { ...(options || {}) };
        if (opts.prefix !== undefined) {
            opts.prefix = kvToPhysicalKey(String(opts.prefix));
        }
        return await env.TOPIC_MAP.list(opts);
    } catch (e) {
        if (isKvQuotaError(e)) {
            await tripKvQuotaBreaker();
        }
        throw e;
    }
}

async function kvGetText(env, key, cacheTtl = undefined) {
    const opts = normalizeKvGetOptions(cacheTtl !== undefined ? { cacheTtl } : undefined);
    return kvGetInternal(env, key, opts);
}

async function kvGetJSON(env, key, defaultValue = null, options = {}) {
    try {
        /** @type {{ type: 'json', cacheTtl?: number }} */
        const getOptions = { type: "json" };
        const optAny = /** @type {any} */ (options);
        const normalized = normalizeKvGetOptions(optAny);
        if (normalized && normalized.cacheTtl !== undefined) {
            getOptions.cacheTtl = normalized.cacheTtl;
        }
        const data = await kvGetInternal(env, key, getOptions);
        if (data === null || data === undefined) return defaultValue;
        if (typeof data !== "object") return defaultValue;
        return data;
    } catch (e) {
        if (isKvQuotaError(e)) {
            await tripKvQuotaBreaker();
        }
        Logger.error("kv_parse_failed", e, { key });
        return defaultValue;
    }
}

// 便于统一“正在超限”时的提前短路（不触碰 KV）
function extractChatAndThreadFromUpdate(update) {
    try {
        if (update?.callback_query) {
            const cq = update.callback_query;
            const chatId = cq?.message?.chat?.id ?? cq?.from?.id;
            const threadId = cq?.message?.message_thread_id ?? null;
            return { chatId, threadId };
        }
        const msg = update?.message || update?.edited_message;
        if (msg?.chat?.id) {
            return { chatId: msg.chat.id, threadId: msg.message_thread_id ?? null };
        }
    } catch { }
    return { chatId: null, threadId: null };
}


function extractCommand(text) {
    if (!text || typeof text !== 'string') return null;
    
    // 匹配 /command 或 /command@bot_username 格式
    // 支持字母、数字和下划线，不匹配参数部分
    const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/);
    return match ? match[1].toLowerCase() : null;
}

function extractCommandArgs(text) {
    if (!text || typeof text !== 'string') return '';
    
    // 移除指令部分（包括@bot_username），返回剩余部分
    const match = text.match(/^\/(?:[a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?\s*(.*)$/);
    return match ? match[1].trim() : '';
}

function normalizeTgDescription(description) {
    return (description || "").toString().toLowerCase();
}

function isTopicMissingOrDeleted(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("thread not found") ||
           desc.includes("topic not found") ||
           desc.includes("message thread not found") ||
           desc.includes("topic deleted") ||
           desc.includes("thread deleted") ||
           desc.includes("forum topic not found") ||
           desc.includes("topic closed permanently");
}

function isTestMessageInvalid(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("message text is empty") ||
           desc.includes("bad request: message text is empty");
}

function isEntityParseError(description) {
    const desc = normalizeTgDescription(description);
    // Telegram 常见格式错误：Markdown/HTML 实体解析失败
    return desc.includes("can't parse entities") ||
           desc.includes("cant parse entities") ||
           desc.includes("can't find end of the entity") ||
           desc.includes("unsupported start tag") ||
           desc.includes("bad request: can't parse entities");
}


async function getOrCreateUserTopicRec(from, key, env, userId) {
    const existing = await kvGetJSON(env, key, null);
    if (existing && existing.thread_id) return existing;

    const inflight = topicCreateInFlight.get(String(userId));
    if (inflight) return await inflight;

    const p = (async () => {
        const again = await kvGetJSON(env, key, null);
        if (again && again.thread_id) return again;
        return await createTopic(from, key, env, userId);
    })();

    mapSetBounded(topicCreateInFlight, String(userId), p, LOCAL_CACHE_LIMITS.topicCreateInFlight);
    try {
        return await p;
    } finally {
        if (topicCreateInFlight.get(String(userId)) === p) {
            topicCreateInFlight.delete(String(userId));
        }
    }
}

function withMessageThreadId(body, threadId) {
    // 统一清理调用方不小心传入的 null/undefined message_thread_id
    const out = { ...body };
    if (out.message_thread_id === null || out.message_thread_id === undefined) {
        delete out.message_thread_id;
    }
    if (threadId === undefined || threadId === null) return out;
    return { ...out, message_thread_id: threadId };
}

function extractUserIdFromUserKeyName(keyName) {
    // 兼容：user:123 与 data:user:123 等形式
    if (keyName === undefined || keyName === null) return null;
    const s = String(keyName);
    const last = s.split(":").pop();
    const n = Number(last);
    return Number.isFinite(n) ? n : null;
}

async function resolveUserIdByThreadId(env, threadId, limit = CONFIG.KV_OPERATION_MAX_ITEMS) {
    const tid = Number(threadId);
    if (!Number.isFinite(tid) || tid <= 0 || tid === 1) return null;

    const mappedUser = await kvGetText(env, `thread:${tid}`);
    if (mappedUser) {
        const uid = Number(mappedUser);
        return Number.isFinite(uid) ? uid : null;
    }

    const maxItems = (limit && Number.isFinite(Number(limit))) ? Number(limit) : CONFIG.KV_OPERATION_MAX_ITEMS;
    const batchSize = Math.max(10, Math.min(CONFIG.KV_LIST_BATCH_SIZE, maxItems));
    const concurrency = Math.max(1, Math.min(16, CONFIG.KV_SCAN_CONCURRENCY || 8));

    const seen = new Set();
    let scanned = 0;

    async function scanWith(listFn, prefix) {
        let cursor = undefined;
        do {
            const remaining = maxItems - scanned;
            if (remaining <= 0) break;

            const result = await listFn({
                prefix,
                cursor,
                limit: Math.min(batchSize, remaining)
            });

            cursor = result?.cursor;
            const keys = Array.isArray(result?.keys) ? result.keys : [];
            const names = [];
            for (const k of keys) {
                const name = k && k.name ? String(k.name) : null;
                if (!name || seen.has(name)) continue;
                seen.add(name);
                names.push(name);
            }

            scanned += names.length;

            for (let i = 0; i < names.length; i += concurrency) {
                const chunk = names.slice(i, i + concurrency);
                const recs = await Promise.all(chunk.map(async (name) => ({
                    name,
                    rec: await safeGetJSONPhysical(env, name, null, { cacheTtl: CONFIG.KV_CRITICAL_CACHE_TTL })
                })));

                for (const { name, rec } of recs) {
                    if (rec && Number(rec.thread_id) === tid) {
                        const uid = extractUserIdFromUserKeyName(name);
                        if (uid) {
                            // 修复索引：下次避免全量扫描
                            try { await kvPut(env, `thread:${tid}`, String(uid)); } catch { }
                            return uid;
                        }
                    }
                }
            }

            if (!cursor) break;
        } while (cursor);

        return null;
    }

    // 先扫描 data:user:*（kvList 会自动映射到 data: 前缀）
    const foundPrimary = await scanWith((opts) => kvList(env, opts), "user:");
    if (foundPrimary) return foundPrimary;

    // 再扫描 legacy user:*（不做 data: 前缀映射）
    return await scanWith((opts) => kvListPhysical(env, opts), "user:");
}


const GROUP_COMMANDS = [
    { command: "help", description: "显示使用说明" },
    { command: "trust", description: "将当前用户加入白名单" },
    { command: "ban", description: "封禁用户（可加用户ID）" },
    { command: "unban", description: "解封用户（可加用户ID）" },
    { command: "blacklist", description: "查看黑名单" },
    { command: "info", description: "查看当前用户信息" },
    { command: "settings", description: "打开设置面板" },
    { command: "clean", description: "⚠️删除当前话题用户的所有数据" }
];

function commandsEqual(commandsA, commandsB) {
    if (!Array.isArray(commandsA) || !Array.isArray(commandsB)) {
        return false;
    }
    if (commandsA.length !== commandsB.length) {
        return false;
    }
    
    // 排序后比较，不依赖顺序
    const sortCommands = (cmds) => 
        [...cmds].sort((a, b) => a.command.localeCompare(b.command));
    
    const sortedA = sortCommands(commandsA);
    const sortedB = sortCommands(commandsB);
    
    return sortedA.every((cmd, i) => 
        cmd.command === sortedB[i].command && 
        cmd.description === sortedB[i].description
    );
}

async function tgCall(env, method, body, options = {}) {
    const {
        timeout = CONFIG.API_TIMEOUT_MS,
        // 兼容：maxRetries 表示“额外重试次数”（不含首次尝试）；也可显式传 maxAttempts（总尝试次数）
        maxAttempts,
        maxRetries = CONFIG.API_MAX_RETRY_ATTEMPTS,
        retryBaseDelay = CONFIG.API_RETRY_BASE_DELAY_MS,
        retryMaxDelay = CONFIG.API_RETRY_MAX_DELAY_MS
    } = options;

    const resolvedMaxAttempts = Number.isFinite(Number(maxAttempts))
        ? Math.max(1, Math.floor(Number(maxAttempts)))
        : Math.max(1, Math.floor(Number(maxRetries)) + 1);


    let base = env.API_BASE || "https://api.telegram.org";

    if (base.startsWith("http://")) {
        Logger.warn('api_http_upgraded', { originalBase: base });
        base = base.replace("http://", "https://");
    }

    try {
        new URL(`${base}/test`);
    } catch (e) {
        Logger.error('api_base_invalid', e, { base });
        base = "https://api.telegram.org";
    }

    const url = `${base}/bot${env.BOT_TOKEN}/${method}`;
    
    // 重试逻辑
    let lastError;
    for (let attempt = 0; attempt < resolvedMaxAttempts; attempt++) {
        const isLastAttempt = attempt === (resolvedMaxAttempts - 1);
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const startTime = Date.now();
            
            const resp = await fetch(url, {
                method: "POST",
                headers: { 
                    "content-type": "application/json",
                    "user-agent": "Telegram-Bot/6.9.12g (Cloudflare Worker)"
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            const responseTime = Date.now() - startTime;

            let result;
            try {
                result = await resp.json();
            } catch (parseError) {
                Logger.error('telegram_api_json_parse_failed', parseError, { 
                    method,
                    status: resp.status,
                    statusText: resp.statusText
                });
                throw new Error(`Failed to parse response: ${parseError.message}`);
            }

            // 处理成功响应
            if (resp.ok && result.ok) {
                Logger.debug('telegram_api_success', {
                    method,
                    attempt,
                    responseTime,
                    retryCount: attempt
                });
                return result;
            }

            // 处理 429 限流
            if (resp.status === 429) {
                const retryAfter = result.parameters?.retry_after || 
                                 parseInt(resp.headers.get('retry-after')) || 
                                 5;
                
                Logger.warn('telegram_api_rate_limit', {
                    method,
                    attempt,
                    retryAfter,
                    description: result.description,
                    responseTime
                });

                if (!isLastAttempt) {
                    const delay = Math.min(retryAfter * 1000, retryMaxDelay);
                    Logger.info('telegram_api_retry_after_rate_limit', {
                        method,
                        attempt,
                        delay,
                        retryAfter
                    });
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
            }

            // 处理 5xx 服务器错误
            if (resp.status >= 500 && resp.status < 600) {
                Logger.warn('telegram_api_server_error', {
                    method,
                    attempt,
                    status: resp.status,
                    description: result.description,
                    responseTime
                });

                if (!isLastAttempt) {
                    // 指数退避延迟
                    const delay = Math.min(
                        retryBaseDelay * Math.pow(2, attempt),
                        retryMaxDelay
                    );
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
            }

            // 其他错误
            Logger.warn('telegram_api_error', {
                method,
                attempt,
                status: resp.status,
                description: result.description,
                responseTime
            });

            // 兜底：若因为 Markdown/HTML 格式导致 sendMessage / editMessageText 失败，
            // 自动去掉 parse_mode 再试一次，避免“前台没有任何反馈消息”。
            if ((method === "sendMessage" || method === "editMessageText") &&
                body && body.parse_mode && isEntityParseError(result.description)) {

                try {
                    const bodyFallback = { ...body };
                    delete bodyFallback.parse_mode;

                    const controller2 = new AbortController();
                    const timeoutId2 = setTimeout(() => controller2.abort(), timeout);

                    const startTime2 = Date.now();
                    const resp2 = await fetch(url, {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            "user-agent": "Telegram-Bot/6.9.12g (Cloudflare Worker)"
                        },
                        body: JSON.stringify(bodyFallback),
                        signal: controller2.signal
                    });

                    clearTimeout(timeoutId2);
                    const responseTime2 = Date.now() - startTime2;

                    let result2;
                    try {
                        result2 = await resp2.json();
                    } catch (parseError2) {
                        Logger.error('telegram_api_fallback_json_parse_failed', parseError2, {
                            method,
                            status: resp2.status,
                            statusText: resp2.statusText
                        });
                        return result;
                    }

                    if (resp2.ok && result2.ok) {
                        Logger.warn('telegram_api_parse_error_fallback_ok', {
                            method,
                            attempt,
                            responseTime: responseTime2
                        });
                        return result2;
                    }

                    Logger.warn('telegram_api_parse_error_fallback_failed', {
                        method,
                        attempt,
                        status: resp2.status,
                        description: result2.description,
                        responseTime: responseTime2
                    });
                } catch (e2) {
                    Logger.warn('telegram_api_parse_error_fallback_exception', e2, {
                        method,
                        attempt
                    });
                }
            }

            return result;

        } catch (e) {
            lastError = e;
            
            // 超时或网络错误
            if (e.name === 'AbortError' || e.name === 'TypeError' || 
                e.message?.includes('fetch') || e.message?.includes('network')) {
                
                Logger.warn('telegram_api_network_error', e, {
                    method,
                    attempt,
                    isLastAttempt
                });

                if (!isLastAttempt) {
                    // 指数退避延迟
                    const delay = Math.min(
                        retryBaseDelay * Math.pow(2, attempt),
                        retryMaxDelay
                    );
                    Logger.info('telegram_api_retry_after_network_error', {
                        method,
                        attempt,
                        delay
                    });
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
            }

            // 其他类型的错误不重试
            Logger.error('telegram_api_unexpected_error', e, {
                method,
                attempt
            });
            break;
        }
    }

    // 所有重试都失败
    Logger.error('telegram_api_all_retries_failed', lastError, {
        method,
        maxRetries,
        resolvedMaxAttempts,
        body: JSON.stringify(body).substring(0, 500) // 限制日志长度
    });

    return { 
        ok: false, 
        description: lastError?.message || ERROR_MESSAGES.network_error 
    };
}

// ---------------- 修改：自动同步指令菜单函数（带差分更新） ----------------

async function ensureCommandsSynced(env) {
    // 不使用 KV 旗标；依赖 Worker isolate 生命周期（全局内存）保证每个实例只执行一次。
    // 目标：用户私聊不再显示命令菜单；群内仅管理员可见命令。
    try {
        // 1) 设置：仅群管理员可见
        // 注意：如果有多个管理群，建议扩展为多个 chat_id 的管理员 scope 设置。
        const adminScope = { type: "chat_administrators", chat_id: env.SUPERGROUP_ID };
        const setRes = await tgCall(env, "setMyCommands", {
            scope: adminScope,
            commands: GROUP_COMMANDS
        });
        if (!setRes.ok) {
            Logger.warn('setMyCommands_admin_scope_failed', { description: setRes.description });
        } else {
            Logger.info('setMyCommands_admin_scope_ok', { chatId: env.SUPERGROUP_ID });
        }

        // 2) 删除：默认 scope（会影响所有非更细 scope 的命令菜单）
        // 这样可避免“回退到 default 仍显示旧命令”的情况。
        const delDefault = await tgCall(env, "deleteMyCommands", {});
        if (!delDefault.ok) {
            Logger.warn('deleteMyCommands_default_failed', { description: delDefault.description });
        } else {
            Logger.info('deleteMyCommands_default_ok');
        }

        // 3) 删除：所有私聊 scope（私聊用户命令菜单）
        const delPrivate = await tgCall(env, "deleteMyCommands", { scope: { type: "all_private_chats" } });
        if (!delPrivate.ok) {
            Logger.warn('deleteMyCommands_all_private_chats_failed', { description: delPrivate.description });
        } else {
            Logger.info('deleteMyCommands_all_private_chats_ok');
        }
    } catch (e) {
        Logger.error('ensureCommandsSynced_failed', e);
    }
}

async function probeForumThread(env, expectedThreadId, opts = {}) {
    const { userId, reason, doubleCheckOnMissingThreadId = true } = opts;
    const attemptReadOnlyProbe = async () => {
        try {
            const res = await tgCall(env, "getForumTopic", {
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: expectedThreadId
            });

            if (res.ok) {
                return { status: "ok" };
            } else {
                if (isTopicMissingOrDeleted(res.description)) {
                    return { status: "missing", description: res.description };
                }
                return { status: "unknown_error", description: res.description };
            }
        } catch (e) {
            Logger.error('readonly_probe_failed', e, { expectedThreadId, userId, reason });
            return { status: "unknown_error", description: e.message };
        }
    };

    const readOnlyResult = await attemptReadOnlyProbe();
    if (readOnlyResult.status === "ok" || readOnlyResult.status === "missing") {
        return readOnlyResult;
    }

    Logger.debug('fallback_to_message_probe', { 
        expectedThreadId, 
        userId, 
        reason,
        error: readOnlyResult.description 
    });
    
    const attemptMessageProbe = async () => {
        const res = await tgCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: expectedThreadId,
            text: " "
        });

        const actualThreadId = res.result?.message_thread_id;
        const probeMessageId = res.result?.message_id;

        if (res.ok && probeMessageId) {
            try {
                await tgCall(env, "deleteMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: probeMessageId
                });
            } catch (e) {
            }
        }

        if (!res.ok) {
            if (isTopicMissingOrDeleted(res.description)) {
                return { status: "missing", description: res.description };
            }
            if (isTestMessageInvalid(res.description)) {
                return { status: "probe_invalid", description: res.description };
            }
            return { status: "unknown_error", description: res.description };
        }

        if (actualThreadId === undefined || actualThreadId === null) {
            return { status: "missing_thread_id" };
        }

        if (Number(actualThreadId) !== Number(expectedThreadId)) {
            return { status: "redirected", actualThreadId };
        }

        return { status: "ok" };
    };

    const first = await attemptMessageProbe();
    if (first.status !== "missing_thread_id" || !doubleCheckOnMissingThreadId) return first;

    const second = await attemptMessageProbe();
    if (second.status === "missing_thread_id") {
        Logger.warn('thread_probe_missing_thread_id', { userId, expectedThreadId, reason });
    }
    return second;
}

async function handleTopicLossAndRecreate(env, { userId, userKey, oldThreadId, pendingMsgId, reason, from = null }) {
    const verified = await kvGetText(env, `verified:${userId}`);
    
    if (verified) {
        Logger.info('topic_recreating_for_verified_user', {
            userId,
            oldThreadId,
            reason
        });
        
        if (oldThreadId !== undefined && oldThreadId !== null) {
            await kvDelete(env, `thread:${oldThreadId}`);
            await kvDelete(env, `thread_ok:${oldThreadId}`);
            threadHealthCache.delete(oldThreadId);
        }
        
        let newRec;
        if (from) {
            newRec = await createTopic(from, userKey, env, userId);
        } else {
            try {
                const userInfoRes = await tgCall(env, "getChat", { chat_id: userId });
                if (userInfoRes.ok && userInfoRes.result) {
                    newRec = await createTopic(userInfoRes.result, userKey, env, userId);
                } else {
                    throw new Error("无法获取用户信息");
                }
            } catch (e) {
                Logger.error('failed_to_get_user_info_for_recreate', e, { userId });
                newRec = await createTopic({ 
                    first_name: `User${userId}`,
                    last_name: '',
                    username: ''
                }, userKey, env, userId);
            }
        }
        
        return newRec;
    } else {
        Logger.info('verification_reset_due_to_topic_loss', {
            userId,
            oldThreadId,
            pendingMsgId,
            reason
        });
        
        await kvDelete(env, `verified:${userId}`);
        await kvDelete(env, `pending_verify:${userId}`);
        await kvDelete(env, `retry:${userId}`);
        await kvDelete(env, `verify_session:${userId}`);
        
        if (userKey) {
            await kvDelete(env, userKey);
        }
        
        if (oldThreadId !== undefined && oldThreadId !== null) {
            await kvDelete(env, `thread:${oldThreadId}`);
            await kvDelete(env, `thread_ok:${oldThreadId}`);
            threadHealthCache.delete(oldThreadId);
        }
        
        const origin = await getWorkerOrigin(env);
        if (!origin) {
            Logger.error('failed_to_get_origin_for_verification', { userId });
            await tgCall(env, "sendMessage", {
                chat_id: userId,
                text: ERROR_MESSAGES.worker_origin_error
            });
            return null;
        }
        await sendHumanVerification(userId, env, pendingMsgId || null, origin, false);
        return null;
    }
}

function parseAdminIdAllowlist(env) {
    const raw = (env.ADMIN_IDS || "").toString().trim();
    if (!raw) return null;
    const ids = raw.split(/[,;\s]+/g).map(s => s.trim()).filter(Boolean);
    const set = new Set();
    for (const id of ids) {
        const n = Number(id);
        if (!Number.isFinite(n)) continue;
        set.add(String(n));
    }
    return set.size > 0 ? set : null;
}

async function isAdminUser(env, userId) {
    const allowlist = parseAdminIdAllowlist(env);
    if (allowlist && allowlist.has(String(userId))) return true;

    const cacheKey = String(userId);
    const now = Date.now();
    const cached = mapGetFresh(adminStatusCache, cacheKey, CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000);
    if (cached && (now - cached.ts < CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000)) {
        return cached.isAdmin;
    }

    try {
        const res = await tgCall(env, "getChatMember", {
            chat_id: env.SUPERGROUP_ID,
            user_id: userId
        });

        const status = res.result?.status;
        const isAdmin = res.ok && (status === "creator" || status === "administrator");
        
        mapSetBounded(adminStatusCache, cacheKey, { ts: now, isAdmin }, LOCAL_CACHE_LIMITS.adminStatus);
        return isAdmin;
    } catch (e) {
        Logger.warn('admin_check_failed', { userId });
        return false;
    }
}

function isUserInAdminWhitelist(env, userId) {
    const allowlist = parseAdminIdAllowlist(env);
    return allowlist && allowlist.has(String(userId));
}

async function getAllKeys(env, prefix, limit = CONFIG.KV_LIST_BATCH_SIZE) {
    // 兼容：同时列出 data:* 与旧版未加 data: 前缀的键（仅对非 banned 前缀做补充）
    const merged = [];
    const seen = new Set();

    const maxItems = (limit && Number.isFinite(Number(limit))) ? Number(limit) : CONFIG.KV_LIST_BATCH_SIZE;

    async function listAll(listFn, listPrefix, remainingLimit, label) {
        const out = [];
        let cursor = undefined;
        let count = 0;

        do {
            const result = await listFn({
                prefix: listPrefix,
                cursor,
                limit: Math.min(CONFIG.KV_LIST_BATCH_SIZE, remainingLimit - count)
            });

            const keys = result.keys || [];
            out.push(...keys);
            count += keys.length;
            cursor = result.list_complete ? undefined : result.cursor;

            if (remainingLimit && count >= remainingLimit) {
                Logger.debug('kv_list_limit_reached', {
                    prefix: listPrefix,
                    limit: remainingLimit,
                    actualCount: count,
                    label
                });
                break;
            }

            if (count > CONFIG.KV_OPERATION_MAX_ITEMS) {
                Logger.warn('kv_list_max_items_exceeded', {
                    prefix: listPrefix,
                    count,
                    maxItems: CONFIG.KV_OPERATION_MAX_ITEMS,
                    label
                });
                break;
            }
        } while (cursor);

        return out;
    }

    // 1) 先按“当前物理命名空间”列出（kvList 会将 prefix 映射到 data: 前缀；banned:* 除外）
    const primaryKeys = await listAll((opts) => kvList(env, opts), prefix, maxItems, "primary");
    for (const k of primaryKeys) {
        const name = k && k.name ? String(k.name) : null;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        merged.push(k);
        if (merged.length >= maxItems) break;
    }

    // 2) 再补充列出“旧版未加 data: 前缀”的键（只对明确的前缀，且排除 banned:* 与已是 data:* 的前缀）
    const shouldListLegacy = (typeof prefix === "string") &&
                             prefix.length > 0 &&
                             !prefix.startsWith(KV_DATA_PREFIX) &&
                             !prefix.startsWith("banned:");

    if (shouldListLegacy && merged.length < maxItems) {
        const legacyKeys = await listAll((opts) => env.TOPIC_MAP.list(opts), prefix, maxItems - merged.length, "legacy");
        for (const k of legacyKeys) {
            const name = k && k.name ? String(k.name) : null;
            if (!name || seen.has(name)) continue;
            seen.add(name);
            merged.push(k);
            if (merged.length >= maxItems) break;
        }
    }

    Logger.debug('kv_list_completed', {
        prefix,
        count: merged.length
    });

    return merged;
}

async function checkRateLimit(userId, env, action = 'message', limit = 20, window = 60) {
    const key = `ratelimit:${action}:${userId}`;
    const now = Date.now();
    const winMs = Math.max(1, Math.floor(Number(window))) * 1000;

    let rec = await cacheGetJSON(key, null);
    if (!rec || typeof rec !== 'object' || !rec.resetAt || now >= rec.resetAt) {
        rec = { count: 0, resetAt: now + winMs };
    }

    if (rec.count >= limit) {
        return { allowed: false, remaining: 0 };
    }

    rec.count += 1;

    // Cache TTL：至少 60 秒（避免过短导致边缘频繁写入），同时覆盖窗口期
    const ttl = Math.max(60, Math.ceil((rec.resetAt - now) / 1000));
    await cachePutJSON(key, rec, ttl);

    return { allowed: true, remaining: Math.max(0, limit - rec.count) };
}

async function getWorkerOrigin(env) {
    if (env.WORKER_URL) {
        try {
            const url = new URL(env.WORKER_URL);
            return url.origin;
        } catch (e) {
            Logger.warn('invalid_worker_url', { 
                url: env.WORKER_URL, 
                error: e.message 
            });
        }
    }
    
    Logger.error('worker_url_not_set', { 
        message: 'WORKER_URL environment variable not set, origin detection may fail' 
    });
    
    return null;
}

async function isBotEnabled(env) {
    const enabled = await kvGetText(env, 'global_switch:enabled');
    return enabled !== "0";
}

async function setBotEnabled(env, enabled) {
    if (enabled) {
        await kvDelete(env, 'global_switch:enabled');
    } else {
        await kvPut(env, 'global_switch:enabled', "0");
    }
    Logger.info('bot_switch_changed', { enabled });
}

async function sendTurnstileVerification(userId, env, pendingMsgId = null, origin = null, isStartCommand = false) {
    let workerOrigin = origin || await getWorkerOrigin(env);
    if (!workerOrigin) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: ERROR_MESSAGES.worker_origin_error });
        return;
    }

    try {
        new URL(workerOrigin);
    } catch (e) {
        Logger.error('turnstile_verification_invalid_origin', {
            userId,
            origin: workerOrigin,
            error: e.message
        });
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: ERROR_MESSAGES.worker_origin_error
        });
        return;
    }
    let enableStorage;

    const sessionKey = `verify_session:${userId}`;
    let sessionData = await kvGetJSON(env, sessionKey, null, { cacheTtl: CONFIG.KV_CRITICAL_CACHE_TTL });
    enableStorage = true;

    // pending_verify:*（KV）用于跨实例判断“正在验证”（由上层逻辑维护）

    // 避免刷屏：同一用户 60 秒内最多提示一次
    const verifyTtl = 60;
    const noticeKey = `verify_notice_sent:${userId}`;

    if (isStartCommand || !sessionData) {
        const verifyLimit = await checkRateLimit(userId, env, 'verify', CONFIG.RATE_LIMIT_VERIFY, 300);
        if (!verifyLimit.allowed) {
            await tgCall(env, "sendMessage", { chat_id: userId, text: ERROR_MESSAGES.rate_limit });
            return;
        }

// v1.2：pending_queue:* 用于跨验证会话保留暂存消息（避免首条触发消息丢失）
let queueIds = enableStorage ? await getPendingQueue(env, userId) : [];

// 将首条触发验证的消息加入 pending_queue（KV 持久，避免会话过期导致漏转发）
if (enableStorage && pendingMsgId) {
    queueIds = await appendPendingQueue(env, userId, pendingMsgId);
}

sessionData = {
    userId,
    // 仍保留 pending_ids 快照（用于兼容旧逻辑），但真实队列以 pending_queue 为准
    pending_ids: Array.isArray(queueIds) ? queueIds : [],
    timestamp: Date.now(),
    sessionId: secureRandomId(16),
    verificationSent: true,
    provider: "turnstile",
    enableStorage: enableStorage
};

        await kvPut(env, sessionKey, JSON.stringify(sessionData), {
            expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS
        });

        await kvPut(env, `pending_verify:${userId}`, "1", {
            expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS
        });
        // pending_ids 已改为存放在 verify_session(KV) 中；不再使用 Cache 暂存列表
        const ps = (!isStartCommand && enableStorage && Array.isArray(queueIds) && queueIds.length > 0) ? "1" : "0";
        const verifyUrl = `${workerOrigin}${CONFIG.VERIFY_PATH}?sid=${sessionData.sessionId}&uid=${userId}&ps=${ps}`;

        Logger.debug('new_verification_session_created', {
            userId,
            sessionId: sessionData.sessionId,
            isStartCommand,
            enableStorage,
            verifyUrl
        });

        const verificationText = enableStorage ?
            USER_NOTIFICATIONS.verification_sent :
            USER_NOTIFICATIONS.verification_required_no_storage;

        const sent = await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: verificationText,
            reply_markup: {
                inline_keyboard: [[
                    {
                        text: CONFIG.VERIFY_BUTTON_TEXT,
                        web_app: { url: verifyUrl }
                    }
                ]]
            }
        });
        try {
            if (sent && sent.ok && sent.result && sent.result.message_id) {
                await addVerifyPromptMsgId(env, userId, sent.result.message_id);
            }
        } catch (_) {}

        Logger.info('turnstile_verification_sent', {
            userId,
            sessionId: sessionData.sessionId,
            pendingCount: (Array.isArray(sessionData.pending_ids) ? sessionData.pending_ids.length : 0),
            isStartCommand,
            enableStorage
        });
        return;
    }

// 已存在会话：将消息加入 pending_queue（KV 持久，跨会话保留）
if (enableStorage && pendingMsgId) {
    const queueIds = await appendPendingQueue(env, userId, pendingMsgId);
    // 同步快照（兼容旧逻辑）
    sessionData.pending_ids = Array.isArray(queueIds) ? queueIds : (Array.isArray(sessionData.pending_ids) ? sessionData.pending_ids : []);

    let shouldSendNotice = false;
    if (!sessionData.hasSentStorageNotice) {
        sessionData.hasSentStorageNotice = true;
        shouldSendNotice = true;
    }

    await kvPut(env, sessionKey, JSON.stringify(sessionData), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });

    if (shouldSendNotice) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: USER_NOTIFICATIONS.first_message_stored });
    }

    Logger.debug('message_added_to_existing_session_kv', {
        userId,
        messageId: pendingMsgId,
        sessionId: sessionData.sessionId,
        pendingCount: Array.isArray(sessionData.pending_ids) ? sessionData.pending_ids.length : 0
    });
    return;
}


    // 非暂存场景：提示一次即可（避免刷屏）
    const noticeSent = await cacheGetText(noticeKey);
    if (!noticeSent) {
        const noticeText = enableStorage ?
            USER_NOTIFICATIONS.already_verifying :
            USER_NOTIFICATIONS.verification_required_no_storage;

        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: noticeText
        });

        await cachePutText(noticeKey, "1", verifyTtl);
    }
}


async function handleVerifyCallback(request, env, ctx) {
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    // Turnstile 未配置：直接返回失败（保持消息暂存/会话逻辑不受影响）
    if (!hasTurnstileBinding(env)) {
        return new Response(JSON.stringify({ success: false, error: ['turnstile_not_configured'] }), {
            status: 503,
            headers: { 'content-type': 'application/json' }
        });
    }

    try {
        const { token, sid, uid } = await request.json();

        if (!token || !sid || !uid) {
            return new Response('Missing token, session ID or user ID', { status: 400 });
        }

        const userId = parseInt(uid);
        if (isNaN(userId)) {
            return new Response('Invalid user ID', { status: 400 });
        }

        const sessionKey = `verify_session:${userId}`;
        const sessionData = await kvGetJSON(env, sessionKey, null, {});
        
        if (!sessionData || sessionData.sessionId !== sid) {
            return new Response('Invalid or expired session', { status: 400 });
        }

        // Turnstile 未配置时，直接返回失败（避免 FormData.append 传入 undefined 导致异常）
        if (!hasTurnstileBinding(env)) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Turnstile not configured'
            }), {
                status: 400,
                headers: { 'content-type': 'application/json' }
            });
        }

        const formData = new FormData();
        formData.append('secret', String(env.CF_TURNSTILE_SECRET_KEY || ''));
        formData.append('response', token);

        // Turnstile 可选：绑定 remoteip（若可用）
        const remoteip = request.headers.get('CF-Connecting-IP');
        if (remoteip) formData.append('remoteip', remoteip);

        const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: formData
        }).then(r => r.json());

        const allowedHostnames = (env.TURNSTILE_ALLOWED_HOSTNAMES || '')
            .toString()
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

        if (result.success && allowedHostnames.length && result.hostname && !allowedHostnames.includes(result.hostname)) {
            Logger.warn('turnstile_hostname_mismatch', { userId, hostname: result.hostname, allowedHostnames });
            result.success = false;
            result['error-codes'] = (result['error-codes'] || []).concat(['hostname-mismatch']);
        }

        const expectedAction = (env.TURNSTILE_ACTION || CONFIG.TURNSTILE_ACTION || '').toString().trim();
        if (result.success && expectedAction && result.action && result.action !== expectedAction) {
            Logger.warn('turnstile_action_mismatch', { userId, action: result.action, expectedAction });
            result.success = false;
            result['error-codes'] = (result['error-codes'] || []).concat(['action-mismatch']);
        }

        if (result.success) {
            const finalizeTtl = normalizeKvExpirationTtl(Math.max(CONFIG.VERIFY_EXPIRE_SECONDS, CONFIG.VERIFY_FINALIZE_EXPIRE_SECONDS));
            sessionData.turnstile = {
                verifiedAt: Date.now(),
                hostname: result.hostname,
                action: result.action,
                remoteipPresent: !!remoteip
            };
            if (finalizeTtl) {
                await kvPut(env, sessionKey, JSON.stringify(sessionData), { expirationTtl: finalizeTtl });
                await kvPut(env, `pending_verify:${userId}`, "1", { expirationTtl: finalizeTtl });
            } else {
                await kvPut(env, sessionKey, JSON.stringify(sessionData));
            }

            const enableStorage = sessionData.enableStorage !== false;

            // 生成 Telegram 回调中的“完成验证”令牌（HMAC 签名，避免依赖 KV 跨 PoP 传播）
            const exp = Math.floor(Date.now() / 1000) + CONFIG.VERIFY_FINALIZE_EXPIRE_SECONDS;
            const signSecret = (env.VERIFY_SIGNING_SECRET || env.CF_TURNSTILE_SECRET_KEY || '').toString();
            const sig = await signVerificationFinalizeToken(signSecret, userId, exp, sessionData.sessionId);
            const callbackData = `vf:${exp}.${sig}`; // 1-64 bytes（Telegram Bot API 限制）

            await tgCall(env, "sendMessage", {
                chat_id: userId,
                text: "验证已通过！请点击下方按钮完成激活（完成后即可正常发送消息）",
                reply_markup: {
                    inline_keyboard: [[
                        { text: "🔴 完成激活", callback_data: callbackData }
                    ]]
                }
            });

            // v1.3：网页验证通过后，立即取消历史“人机验证”按钮（方式 B：editMessageText 不带 reply_markup）
            await removeVerifyPromptKeyboardsBestEffort(env, userId, null);


            Logger.info('turnstile_verification_passed_wait_finalize', {
                userId,
                sessionId: sid,
                exp,
                enableStorage
            });

            return new Response(JSON.stringify({
                success: true,
                needFinalize: true,
                enableStorage
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        } else {
            Logger.warn('turnstile_verification_failed', {
                userId,
                sessionId: sid,
                errorCodes: result['error-codes']
            });

            // v1.4：验证失败/超时时，让 Telegram 里的旧验证按钮消失，并把文案改为“验证失败，请重试”
            await removeVerifyPromptKeyboardsBestEffort(
                env,
                userId,
                ctx,
                USER_NOTIFICATIONS.verification_button_failed
            );

            // v1.4（方案 4）：失败后立即再发一条新的验证消息（带新按钮），同时做短期防抖避免刷屏
            try {
                const lockKey = `verify_resend_lock:${userId}`;
                const locked = await cacheGetText(lockKey);
                if (!locked) {
                    await cachePutText(lockKey, "1", 20);
                    const origin = await getWorkerOrigin(env);
                    if (origin) await renewTurnstileSessionAndSend(userId, env, origin, sessionData);
                }
            } catch (_) {}

            return new Response(JSON.stringify({ 
                success: false, 
                error: result['error-codes'] 
            }), {
                status: 400,
                headers: { 'content-type': 'application/json' }
            });
        }
    } catch (e) {
        Logger.error('verify_callback_error', e);
        return new Response(e.message, { status: 500 });
    }
}

/**
 * v1.4：Turnstile 失败/超时等事件上报。
 * - 用 editMessageText（不带 reply_markup）把 Telegram 里的旧验证按钮“消掉”
 * - 同时按需重新下发一条新的验证消息（带新按钮）
 */
async function handleVerifyEvent(request, env, ctx) {
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    let payload = null;
    try {
        payload = await request.json();
    } catch (_) {
        return new Response('Bad request', { status: 400 });
    }

    const userId = Number(payload?.uid);
    const sid = String(payload?.sid || '').trim();
    const reason = String(payload?.reason || '').trim() || 'unknown';

    if (!Number.isInteger(userId) || userId <= 0 || !sid) {
        return new Response('Bad request', { status: 400 });
    }

    const sessionKey = `verify_session:${userId}`;
    const sessionData = await kvGetJSON(env, sessionKey, null, {});

    // 安全：只有 sid 与当前会话匹配时，才触发“消旧按钮 + 重新下发”。
    if (!sessionData || sessionData.sessionId !== sid) {
        return new Response(JSON.stringify({ ok: false, ignored: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    }

    try {
        await removeVerifyPromptKeyboardsBestEffort(
            env,
            userId,
            ctx,
            USER_NOTIFICATIONS.verification_button_failed
        );
    } catch (_) {}

    // 失败后立即再发一条新的验证消息（带新按钮），并做短期防抖避免刷屏
    try {
        const lockKey = `verify_resend_lock:${userId}`;
        const locked = await cacheGetText(lockKey);
        if (!locked) {
            await cachePutText(lockKey, "1", 20);
            const origin = await getWorkerOrigin(env);
            if (origin) await renewTurnstileSessionAndSend(userId, env, origin, sessionData);
        }
    } catch (_) {}

    Logger.info('verify_event_handled', { userId, sessionId: sid, reason });
    return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}


/**
 * - verify-callback 仅负责 Turnstile 校验，通过后给用户发一个 callback_data 按钮
 * - 用户点按钮后，由 webhook 处理 callback_query，写入 verified 并转发暂存消息
 * 这样 verified 的“最终写入”发生在 Telegram webhook 的同一路径/同一 PoP，更稳定。
 */

// --- HMAC & base64url 工具 ---
function base64urlEncode(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let out = 0;
    for (let i = 0; i < a.length; i++) out |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    return out === 0;
}

async function signVerificationFinalizeToken(secret, userId, exp, sessionId) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const msg = `${userId}.${exp}.${sessionId}`;
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
    // 截断到较短长度以满足 callback_data 1-64 bytes 限制
    return base64urlEncode(sigBuf).slice(0, 16);
}

async function signCleanConfirmToken(secret, adminId, userId, threadId, exp) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const msg = `${adminId}.${userId}.${threadId}.${exp}`;
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
    // 截断到较短长度以满足 callback_data 1-64 bytes 限制
    return base64urlEncode(sigBuf).slice(0, 16);
}


async function signSettingsActionToken(secret, adminId, action, exp) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const msg = `${adminId}.${action}.${exp}`;
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
    // 截断到较短长度以满足 callback_data 1-64 bytes 限制
    return base64urlEncode(sigBuf).slice(0, 16);
}


async function buildSettingsPanel(env, adminId, botEnabled, opts = {}) {
    const note = (opts && opts.note) ? String(opts.note) : "";
    const hideReset = !!(opts && opts.hideReset);

    const now = Math.floor(Date.now() / 1000);
    const exp = now + 600; // 设置面板按钮有效期（秒）

    const signSecret = (env.VERIFY_SIGNING_SECRET || env.CF_TURNSTILE_SECRET_KEY || env.BOT_TOKEN || "").toString();

    const makeData = async (action) => {
        let sig = "0";
        if (signSecret) {
            try {
                sig = await signSettingsActionToken(signSecret, adminId, action, exp);
            } catch (_) {
                sig = "0";
            }
        }
        const raw = `st|${action}|${adminId}|${exp}|${sig}`;
        // callback_data 1-64 bytes；极端情况下兜底降级（仍会做 admin 校验 + 过期校验）
        return (raw.length <= 64) ? raw : `st|${action}|${adminId}|${exp}|0`;
    };

    const statusText = botEnabled ? "✅ 已开启" : "⛔ 已关闭";
    const verifyMode = await getGlobalVerifyMode(env);
    const verifyModeText = (verifyMode === "local_quiz") ? "📚 本地题库验证" : "☁️ Cloudflare 验证";
    const spamEnabled = await getGlobalSpamFilterEnabled(env);
    const spamText = spamEnabled ? "✅ 已开启" : "⛔ 已关闭";
    const aiText = hasWorkersAIBinding(env) ? "✅ 可用" : "⛔ 未绑定";
    const tsReady = hasTurnstileBinding(env);
    const tsText = tsReady ? "✅ 已配置" : "⛔ 未配置";
    let panelText = `⚙️ **设置面板**

机器人总开关：${statusText}
垃圾消息拦截：${spamText}
Workers AI：${aiText}
Turnstile：${tsText}
验证方式：${verifyModeText}

通过下方按钮进行操作。`;
    if (note) {
        panelText += `

${note}`;
    }

    const toggleAction = botEnabled ? "off" : "on";
    const toggleBtnText = botEnabled ? "⛔ 关闭机器人" : "✅ 开启机器人";

    const page = (!hideReset && opts && typeof opts.page !== "undefined") ? Number(opts.page) : 1;
    const currentPage = (page === 2 && !hideReset) ? 2 : 1;

    const rows = [];

    if (currentPage === 1) {

        if (tsReady) {
            const verifyToggleAction = (verifyMode === "local_quiz") ? "v_t" : "v_q";
            const verifyToggleText = (verifyMode === "local_quiz") ? "☁️ 切换为 Cloudflare 验证" : "📚 切换为本地题库验证";
            rows.push([{ text: verifyToggleText, callback_data: await makeData(verifyToggleAction) }]);
        }

        const spamToggleAction = spamEnabled ? "sf_off" : "sf_on";
        const spamToggleText = spamEnabled ? "🗑️ 关闭垃圾消息拦截" : "🗑️ 开启垃圾消息拦截";
        rows.push([{ text: spamToggleText, callback_data: await makeData(spamToggleAction) }]);

        rows.push([{ text: "✏️ 编辑垃圾消息规则", callback_data: await makeData("sf_rules") }]);

        if (!hideReset) {
            rows.push([{ text: "➡️ 下一页", callback_data: await makeData("p2") }]);
        }

        rows.push([{ text: "✖️ 关闭面板", callback_data: await makeData("close") }]);
    } else {
        // Page 2
        rows.push([{ text: toggleBtnText, callback_data: await makeData(toggleAction) }]);
        rows.push([{ text: "⚠️ 重置黑名单", callback_data: await makeData("reset_blacklist") }]);
        rows.push([{ text: "⚠️ 清空并重置所有聊天数据", callback_data: await makeData("reset") }]);
        rows.push([{ text: "⬅️ 上一页", callback_data: await makeData("p1") }]);
        rows.push([{ text: "✖️ 关闭面板", callback_data: await makeData("close") }]);
    }

return {
        text: panelText,
        reply_markup: { inline_keyboard: rows },
        exp
    };
}


async function processPendingMessagesAfterVerification(userId, sessionData, env) {
    const queueIds = await getPendingQueue(env, userId);
    const pendingIds = (Array.isArray(queueIds) && queueIds.length > 0)
        ? queueIds
        : ((sessionData && Array.isArray(sessionData.pending_ids)) ? sessionData.pending_ids : []);
    const enableStorage = sessionData ? (sessionData.enableStorage !== false) : true;

    // 统一给用户一个“已通过”的确认
    await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: USER_NOTIFICATIONS.verified_success
    });

    let hamForwardedCount = 0;
    const failedMessages = [];

    if (!pendingIds || pendingIds.length === 0) {
        return { hamForwardedCount, spamForwardedCount: 0, totalPending: 0, failedCount: 0, enableStorage };
    }

    // 去重、排序
    const sortedIds = Array.from(new Set(pendingIds)).sort((a, b) => a - b);

    let userRec = null;

    // 仅当存在待转发消息才创建/确保用户话题
    try {
        userRec = await getOrCreateUserTopicRecByUserId(env, userId);
        if (userRec && userRec.thread_id) {
            const mappedUser = await kvGetText(env, `thread:${userRec.thread_id}`);
            if (!mappedUser) {
                await kvPut(env, `thread:${userRec.thread_id}`, String(userId));
            }
        }
    } catch (e) {
        Logger.error('failed_to_create_topic_for_pending', e, { userId });
        failedMessages.push(...sortedIds);
        userRec = null;
    }

    if (userRec && userRec.thread_id) {
        for (const pendingId of sortedIds) {
            try {
                const res = await tgCall(env, "forwardMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    from_chat_id: userId,
                    message_id: pendingId,
                    message_thread_id: userRec.thread_id
                });

                if (res.ok) {
                    hamForwardedCount++;
                } else {
                    // 兜底 copyMessage
                    const copyRes = await tgCall(env, "copyMessage", {
                        chat_id: env.SUPERGROUP_ID,
                        from_chat_id: userId,
                        message_id: pendingId,
                        message_thread_id: userRec.thread_id
                    });
                    if (copyRes.ok) hamForwardedCount++;
                    else failedMessages.push(pendingId);
                }
            } catch (e) {
                Logger.error('pending_message_forward_exception', e, { userId, messageId: pendingId });
                failedMessages.push(pendingId);
            }

            if (sortedIds.length > 1) {
                await new Promise(r => setTimeout(r, 200));
            }
        }
    }

    // 给用户：提示已送达（仅统计成功的转发）
    if (hamForwardedCount > 0) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: USER_NOTIFICATIONS.pending_forwarded(hamForwardedCount)
        });
    }

    if (failedMessages.length > 0) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: `⚠️ ${failedMessages.length} 条消息自动转发失败，请重新发送这些消息。`
        });
    }

    // 更新暂存队列：仅保留失败项，否则清空
    try {
        if (failedMessages.length > 0) {
            await overwritePendingQueue(env, userId, failedMessages);
        } else {
            await kvDelete(env, pendingQueueKey(userId));
        }
    } catch (_) {}

    return {
        hamForwardedCount,
        spamForwardedCount: 0,
        totalPending: sortedIds.length,
        failedCount: failedMessages.length,
        enableStorage
    };
}



async function handleCleanConfirmCallback(callbackQuery, env, ctx) {
    const data = (callbackQuery && callbackQuery.data) ? String(callbackQuery.data) : "";
    const fromId = callbackQuery?.from?.id;
    if (!fromId) return;

    // 注意：同一个 callback_query 只能 answer 一次；否则后续提示可能被客户端忽略
    let _answered = false;
    async function answerOnce(text = null, showAlert = false) {
        if (_answered) return;
        _answered = true;
        const payload = { callback_query_id: callbackQuery.id };
        if (text !== null && text !== undefined && String(text).length > 0) payload.text = String(text);
        if (showAlert) payload.show_alert = true;
        try {
            const p = tgCall(env, "answerCallbackQuery", payload);
            if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
            else await p;
        } catch (_) {}
    }

    const parts = data.split("|");
    if (parts.length !== 6) {
        await answerOnce("无效请求", true);
        return;
    }

    const action = parts[0] === "cY" ? "yes" : (parts[0] === "cN" ? "no" : null);
    if (!action) {
        await answerOnce("无效请求", true);
        return;
    }

    const threadId = Number(parts[1]);
    const userId = Number(parts[2]);
    const adminId = Number(parts[3]);
    const exp = Number(parts[4]);
    const sig = String(parts[5] || "");

    if (!threadId || !userId || !adminId || !exp) {
        await answerOnce("无效请求", true);
        return;
    }

    // 仅允许发起 /clean 的管理员确认
    if (Number(fromId) !== Number(adminId)) {
        await answerOnce("无权限", true);
        return;
    }

    // 再次校验管理员身份（避免被误触 / 账号变更）
    if (!(await isAdminUser(env, adminId))) {
        await answerOnce("无权限", true);
        return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (exp < now) {
        // 过期：移除按钮并提示（并把原消息改成“已自动取消”更清晰）
        try {
            if (callbackQuery.message) {
                const chatId = callbackQuery.message.chat?.id;
                const messageId = callbackQuery.message.message_id;
                if (chatId && messageId) {
                    await tgCall(env, "editMessageReplyMarkup", {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: { inline_keyboard: [] }
                    });
                    try {
                        await tgCall(env, "editMessageText", {
                            chat_id: chatId,
                            message_id: messageId,
                            text: "⏳ 操作超时，已自动取消",
                        });
                    } catch (_) {}
                }
            }
        } catch (_) {}

        // 仅需 ACK 回调以停止客户端加载动画；不需要弹窗/气泡提示
        await answerOnce();
        return;
    }

    // 签名校验（sig=0 时表示兜底降级，不做签名校验，但仍有 admin 校验 + 过期校验）
    const signSecret = (env.VERIFY_SIGNING_SECRET || env.CF_TURNSTILE_SECRET_KEY || env.BOT_TOKEN || "").toString();
    if (sig !== "0" && signSecret) {
        const expectedSig = await signCleanConfirmToken(signSecret, adminId, userId, threadId, exp);
        if (!timingSafeEqual(sig, expectedSig)) {
            Logger.warn('clean_confirm_signature_mismatch', { adminId, userId, threadId });
            await answerOnce("请求无效", true);
            return;
        }
    }

    // 尝试移除按钮，避免重复点击
    try {
        if (callbackQuery.message) {
            const chatId = callbackQuery.message.chat?.id;
            const messageId = callbackQuery.message.message_id;
            if (chatId && messageId) {
                const p = tgCall(env, "editMessageReplyMarkup", {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: { inline_keyboard: [] }
                });
                if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
                else await p;
            }
        }
    } catch (_) {}

    if (action === "no") {
        // 取消：尽量把原消息改成“已取消”（失败也无所谓）
        try {
            if (callbackQuery.message) {
                const chatId = callbackQuery.message.chat?.id;
                const messageId = callbackQuery.message.message_id;
                if (chatId && messageId) {
                    await tgCall(env, "editMessageText", {
                        chat_id: chatId,
                        message_id: messageId,
                        text: "✅ 已取消清理操作",
                    });
                }
            }
        } catch (_) {}
        await answerOnce("已取消", false);
        Logger.info('clean_confirm_cancelled', { adminId, userId, threadId });
        return;
    }

    // 幂等：避免重复触发（有效窗口 10 秒）
    // 注意：Cloudflare KV 的 expiration/expirationTtl 都不支持 <60 秒，因此这里用“写入时间戳 + 逻辑判断”实现 10 秒有效窗口。
    const CLEAN_ONCE_EFFECTIVE_TTL_SECONDS = 10;
    const onceKey = `clean_once:${threadId}:${userId}`;
    const nowSec = Math.floor(Date.now() / 1000);

    const already = await kvGetText(env, onceKey, 30);
    if (already) {
        const ts = Math.floor(Number(already));
        // 兼容旧版本写入的 "1"：判定为无效时间戳，删除后继续走新逻辑
        if (!Number.isFinite(ts) || ts < 1_000_000_000) {
            try { await kvDelete(env, onceKey); } catch (_) {}
        } else if ((nowSec - ts) < CLEAN_ONCE_EFFECTIVE_TTL_SECONDS) {
            Logger.info('clean_confirm_duplicate_ignored', { adminId, userId, threadId });
            await answerOnce("已处理", false);
            return;
        }
    }
    try {
        // KV 侧实际最短只能 60 秒；但功能上只拦 10 秒内的重复点击/重试。
        await kvPut(env, onceKey, String(nowSec), { expirationTtl: 60 });
    } catch (_) {}

    // 立即在当前话题提示“已开始”，随后后台清理并在 General 话题通知结果
    try {
        if (callbackQuery.message) {
            const chatId = callbackQuery.message.chat?.id;
            const messageId = callbackQuery.message.message_id;
            if (chatId && messageId) {
                await tgCall(env, "editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: "🧹 已确认，开始清理…（完成后会在 General 话题提示结果）",
                });
            }
        }
    } catch (_) {}

    // 先答复 callback，避免客户端转圈（清理逻辑放到 waitUntil）
    await answerOnce("已开始清理", false);

    Logger.info('clean_confirm_accepted', { adminId, userId, threadId });

    const task = (async () => {
        try {
            const results = await silentCleanUserDataAndTopic(env, userId, threadId, adminId);
            Logger.info('clean_confirm_clean_completed', { adminId, userId, threadId, ...results });

            // 删除话题成功后无法再在该 thread 发消息，因此统一发到 General（不带 message_thread_id）
            const summary = [
                "✅ /clean 清理完成",
                `用户ID：${userId}`,
                `原话题ID：${threadId}`,
                `KV 删除：${results.kvDeleted}（失败 ${results.kvFailed}）`,
                `话题删除：${results.topicDeleted ? "成功" : "失败"}`,
                `耗时：${results.duration}ms`
            ].join("\n");

            await tgCall(env, "sendMessage", {
                chat_id: env.SUPERGROUP_ID,
                text: summary
            });
        } catch (error) {
            Logger.error('clean_confirm_clean_failed', error, { adminId, userId, threadId });
            try {
                await tgCall(env, "sendMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    text: `❌ /clean 清理失败\n用户ID：${userId}\n原话题ID：${threadId}`
                });
            } catch (_) {}
        } finally {
            // 清理结束后尽快移除幂等键，避免 KV 里残留（即使 KV 最短 TTL 是 60s）
            try { await kvDelete(env, onceKey); } catch (_) {}
        }
    })();

    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
    else await task;
}



async function handleSettingsCallback(callbackQuery, env, ctx) {
    const data = (callbackQuery && callbackQuery.data) ? String(callbackQuery.data) : "";
    const fromId = callbackQuery?.from?.id;
    if (!fromId) return;

    // 立即 ACK，避免 Telegram 客户端一直转圈
    try {
        const ack = tgCall(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id });
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(ack);
        else await ack;
    } catch (_) {}

    const parts = data.split("|");
    if (parts.length !== 5) return;

    const action = String(parts[1] || "");
    const adminId = Number(parts[2]);
    const exp = Number(parts[3]);
    const sig = String(parts[4] || "");

    if (!adminId || !exp) return;

    // 仅允许召唤面板的管理员点击
    if (Number(fromId) !== Number(adminId)) {
        try {
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: callbackQuery.id,
                text: "无权限",
                show_alert: true
            });
        } catch (_) {}
        return;
    }

    // 再次校验管理员身份（避免误触/账号变更）
    if (!(await isAdminUser(env, adminId))) return;

    // settings 面板所在的话题（论坛群里不同话题 thread_id 不同；默认回退到 1）
    const settingsThreadId = callbackQuery?.message?.message_thread_id;

    const now = Math.floor(Date.now() / 1000);
    if (exp < now) {
        // 过期：移除按钮并提示
        try {
            if (callbackQuery.message) {
                const chatId = callbackQuery.message.chat?.id;
                const messageId = callbackQuery.message.message_id;
                if (chatId && messageId) {
                    await tgCall(env, "editMessageReplyMarkup", {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: { inline_keyboard: [] }
                    });
                }
            }
        } catch (_) {}
        try {
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: callbackQuery.id,
                text: "面板已过期，请重新 /settings",
                show_alert: true
            });
        } catch (_) {}
        return;
    }

    // 签名校验（sig=0 时表示兜底降级，不做签名校验，但仍有 admin 校验 + 过期校验）
    const signSecret = (env.VERIFY_SIGNING_SECRET || env.CF_TURNSTILE_SECRET_KEY || env.BOT_TOKEN || "").toString();
    if (sig !== "0" && signSecret) {
        const expectedSig = await signSettingsActionToken(signSecret, adminId, action, exp);
        if (!timingSafeEqual(sig, expectedSig)) {
            Logger.warn('settings_callback_signature_mismatch', { adminId, action });
            return;
        }
    }

    const chatId = callbackQuery?.message?.chat?.id;
    const messageId = callbackQuery?.message?.message_id;
    if (!chatId || !messageId) return;

    if (action === "close") {
        // 优先尝试删除整条设置面板消息（更干净）；若因 Telegram 限制（例如超出 Telegram 删除限制）删除失败，则回退为“移除按钮 + 保留摘要信息”
        let deleteOk = false;
        let deleteDesc = null;

        try {
            const delRes = await tgCall(env, "deleteMessage", {
                chat_id: chatId,
                message_id: messageId
            });
            deleteOk = !!(delRes && delRes.ok);
            deleteDesc = delRes ? (delRes.description || null) : null;
        } catch (e) {
            deleteOk = false;
            deleteDesc = (e && e.message) ? String(e.message) : null;
        }

        if (deleteOk) {
            Logger.info('settings_panel_closed', { adminId, deleted: true });
            return;
        }

        // 删除失败：回退为“保留关键状态 + 移除按钮”
        const botEnabled = await isBotEnabled(env);
        const statusText = botEnabled ? "✅ 已开启" : "⛔ 已关闭";
        const verifyMode = await getGlobalVerifyMode(env);
        const verifyModeText = (verifyMode === "local_quiz") ? "📚 本地题库验证" : "☁️ Cloudflare 验证";
        const spamEnabled = await getGlobalSpamFilterEnabled(env);
        const spamText = spamEnabled ? "✅ 已开启" : "⛔ 已关闭";
        const aiText = hasWorkersAIBinding(env) ? "✅ 可用" : "⛔ 未绑定";

        const tsText = hasTurnstileBinding(env) ? "✅ 已配置" : "⛔ 未配置";

        const closedText = `⚙️ **设置面板**

机器人总开关：${statusText}
垃圾消息拦截：${spamText}
Workers AI：${aiText}
Turnstile：${tsText}
验证方式：${verifyModeText}

✅ 面板已关闭`;

        try {
            await tgCall(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: closedText,
                parse_mode: "Markdown"
            });
        } catch (_) {}

        try {
            await tgCall(env, "editMessageReplyMarkup", {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: [] }
            });
        } catch (_) {}

        Logger.info('settings_panel_closed', { adminId, deleted: false, deleteDesc });
        return;
    }

    
    if (action === "p2" || action === "p1") {
        const botEnabled = await isBotEnabled(env);
        const page = (action === "p2") ? 2 : 1;
        const panel = await buildSettingsPanel(env, adminId, botEnabled, { page });

        try {
            await tgCall(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: panel.text,
                parse_mode: "Markdown",
                reply_markup: panel.reply_markup
            });
        } catch (_) {}

        return;
    }

if (action === "on" || action === "off") {
        const desired = (action === "on");
        const current = await isBotEnabled(env);

        if (current !== desired) {
            await setBotEnabled(env, desired);
        }

        const panel = await buildSettingsPanel(env, adminId, desired, { page: 2 });

        try {
            await tgCall(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: panel.text,
                parse_mode: "Markdown"
            });
            await tgCall(env, "editMessageReplyMarkup", {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: panel.reply_markup
            });
        } catch (_) {}

        Logger.info('bot_toggle_via_settings', { adminId, desired });
        return;
    }



if (action === "v_q" || action === "v_t") {
        const desired = (action === "v_q") ? "local_quiz" : "turnstile";

        let noteMsg = "";
        let finalMode = desired;

        if (desired === "turnstile" && !hasTurnstileBinding(env)) {
            finalMode = "local_quiz";
            await setGlobalVerifyMode(env, "local_quiz");
            noteMsg = "⛔ 未检测到 Turnstile 配置（CF_TURNSTILE_SITE_KEY / CF_TURNSTILE_SECRET_KEY），已保持为本地题库验证";
        } else {
            const ok = await setGlobalVerifyMode(env, desired);
            if (!ok && desired === "turnstile") {
                finalMode = "local_quiz";
                await setGlobalVerifyMode(env, "local_quiz");
                noteMsg = "⛔ 未检测到 Turnstile 配置（CF_TURNSTILE_SITE_KEY / CF_TURNSTILE_SECRET_KEY），已保持为本地题库验证";
            } else {
                const modeText = (desired === "local_quiz") ? "📚 本地题库验证" : "☁️ Cloudflare 验证";
                noteMsg = `✅ 已切换验证方式为：${modeText}`;
            }
        }

        const botEnabled = await isBotEnabled(env);
        const showModeText = (finalMode === "local_quiz") ? "📚 本地题库验证" : "☁️ Cloudflare 验证";
        const panel = await buildSettingsPanel(env, adminId, botEnabled, { note: noteMsg || `✅ 当前验证方式：${showModeText}` });
        try {
            await tgCall(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: panel.text,
                parse_mode: "Markdown"
            });
            await tgCall(env, "editMessageReplyMarkup", {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: panel.reply_markup
            });
        } catch (_) {}

        Logger.info("verify_mode_changed_via_settings", { adminId, mode: finalMode });
        return;
    }


    if (action === "sf_on" || action === "sf_off") {
        const enabled = (action === "sf_on");
        await setGlobalSpamFilterEnabled(env, enabled);

        const botEnabled = await isBotEnabled(env);
        const text = enabled ? "✅ 开启" : "⛔ 关闭";
        const panel = await buildSettingsPanel(env, adminId, botEnabled, { note: `✅ 已切换垃圾消息拦截为：${text}` });

        try {
            await tgCall(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: panel.text,
                parse_mode: "Markdown",
                reply_markup: panel.reply_markup
            });
        } catch (_) {}

        Logger.info('spam_filter_toggle_via_settings', { adminId, enabled });
        return;
    }

    if (action === "sf_rules") {
        // 发送“请回复提交 规则提示词”的提示，并记录编辑会话（v1.1.1b+）
        const currentRules = await getGlobalSpamFilterRules(env);
        const currentPrompt = await getGlobalSpamFilterRulesPrompt(env);
        const enabled = await getGlobalSpamFilterEnabled(env);
        const aiAvail = hasWorkersAIBinding(env);

        const header = [
            "✏️ 编辑垃圾消息规则",
            "",
            `垃圾消息拦截：${enabled ? "✅ 已开启" : "⛔ 已关闭"}`,
            `Workers AI：${aiAvail ? "✅ 可用" : "⛔ 未绑定（将不会调用 AI 兜底）"}`,
            "",
            "请【回复】本条消息，发送新的规则。",
            "每次提交会在现有规则基础上【追加】（不会删除旧项）。",
            "发送后立即生效，建议使用PC端编辑。",
            "",
            "以下为编辑说明",
            "",
            "带前缀写法（使用英文标点）：",
            "block: xxx, yyy    （屏蔽关键词）",
            "allow: xxx, yyy    （放行关键词）",
            "block_re: /.../i   （屏蔽正则，支持 /pat/flags 或纯 pat）",
            "allow_re: /.../i   （放行正则）",
            "max_links=3        （修改允许链接数，0-20）",
            "不带任何前缀会直接当作【屏蔽关键词】添加（此时可用中文逗号或顿号分隔）。",
            "",
            "若需从空规则开始（去除默认规则）：请在任意一行单独写 清空默认 或 CLEAR_DEFAULTS",
            "若需恢复默认规则：请只回复 恢复默认 或 RESET_DEFAULTS",
            ""
        ].join("\n");

        const template = rulesToFriendlyPrompt(currentRules);
        const payloadText = header + "\n\n" + template;

        // 取消编辑按钮（callback_data 需 <= 64 bytes）
        const cancelExp = Math.floor(Date.now() / 1000) + 1800; // 30min
        let cancelSig = "0";
        if (signSecret) {
            try {
                cancelSig = await signSettingsActionToken(signSecret, adminId, "sf_rules_cancel", cancelExp);
            } catch (_) {
                cancelSig = "0";
            }
        }
        let cancelCb = `st|sf_rules_cancel|${adminId}|${cancelExp}|${cancelSig}`;
        if (cancelCb.length > 64) cancelCb = `st|sf_rules_cancel|${adminId}|${cancelExp}|0`;

        let prompt;
        try {
            prompt = await tgCall(env, "sendMessage", {
                chat_id: chatId,
                ...(settingsThreadId ? { message_thread_id: settingsThreadId } : {}),
                text: payloadText,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✖️ 取消编辑", callback_data: cancelCb }]
                    ]
                }
            });
        } catch (e) {
            Logger.warn('spam_filter_rules_edit_prompt_send_failed', e, { adminId, chatId, settingsThreadId });
            try {
                await tgCall(env, "sendMessage", {
                    chat_id: chatId,
                    ...(settingsThreadId ? { message_thread_id: settingsThreadId } : {}),
                    text: "❌ 发送规则编辑说明失败：请检查机器人在群里的权限（发送消息/管理话题）以及该群是否为 forum supergroup。"
                });
            } catch (_) {}
            return;
        }

        // 记录编辑会话（30 分钟过期）
        const sessKey = `${SPAM_RULES_EDIT_SESSION_KEY_PREFIX}${adminId}`;
        const sessVal = {
            admin_id: adminId,
            chat_id: chatId,
            thread_id: settingsThreadId || 1,
            prompt_message_id: (prompt && prompt.result && prompt.result.message_id) ? prompt.result.message_id : prompt.message_id,
            started_at: Date.now()
        };
        await safePutJSON(env, sessKey, sessVal, { expirationTtl: 1800 });

        // 让设置菜单消失：优先直接删除面板消息；若因 Telegram 限制删除失败，则回退为“移除按钮 + 留一句提示”
        try {
            const delRes = await tgCall(env, "deleteMessage", {
                chat_id: chatId,
                message_id: messageId
            });

            if (!(delRes && delRes.ok)) {
                try {
                    await tgCall(env, "editMessageText", {
                        chat_id: chatId,
                        message_id: messageId,
                        text: "✅ 已进入垃圾消息规则编辑：请查看提示消息，并回复提交新的规则。"
                    });
                } catch (_) {}

                try {
                    await tgCall(env, "editMessageReplyMarkup", {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: { inline_keyboard: [] }
                    });
                } catch (_) {}
            }
        } catch (_) {
            try {
                await tgCall(env, "editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: "✅ 已进入垃圾消息规则编辑：请查看提示消息，并回复提交新的规则。"
                });
            } catch (_) {}

            try {
                await tgCall(env, "editMessageReplyMarkup", {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: { inline_keyboard: [] }
                });
            } catch (_) {}
        }

        Logger.info('spam_filter_rules_edit_prompt_sent', { adminId });
        return;
    }

    if (action === "sf_rules_cancel") {
        const sessKey = `${SPAM_RULES_EDIT_SESSION_KEY_PREFIX}${adminId}`;
        let sess = null;

        try {
            sess = await kvGetJSON(env, sessKey, null, {});
        } catch (_) {
            sess = null;
        }

        try {
            await kvDelete(env, sessKey);
        } catch (_) {}

        // 优先删除那条“规则编辑提示消息”；若删除失败则编辑为已取消并移除按钮
        const targetChatId = (sess && sess.chat_id) ? Number(sess.chat_id) : chatId;
        const targetMsgId = (sess && sess.prompt_message_id) ? Number(sess.prompt_message_id) : messageId;

        try {
            const delRes = await tgCall(env, "deleteMessage", {
                chat_id: targetChatId,
                message_id: targetMsgId
            });

            if (!(delRes && delRes.ok)) {
                try {
                    await tgCall(env, "editMessageText", {
                        chat_id: chatId,
                        message_id: messageId,
                        text: "✖️ 已取消编辑垃圾消息规则。"
                    });
                } catch (_) {}

                try {
                    await tgCall(env, "editMessageReplyMarkup", {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: { inline_keyboard: [] }
                    });
                } catch (_) {}
            }
        } catch (_) {
            try {
                await tgCall(env, "editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: "✖️ 已取消编辑垃圾消息规则。"
                });
            } catch (_) {}

            try {
                await tgCall(env, "editMessageReplyMarkup", {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: { inline_keyboard: [] }
                });
            } catch (_) {}
        }

        Logger.info('spam_filter_rules_edit_canceled', { adminId });
        return;
    }

if (action === "reset") {
        // 删除设置面板消息（best-effort）
        try {
            const panelChatId = callbackQuery?.message?.chat?.id;
            const panelMsgId = callbackQuery?.message?.message_id;
            if (panelChatId && panelMsgId) {
                await tgCall(env, "deleteMessage", { chat_id: panelChatId, message_id: panelMsgId });
            }
        } catch (e) {
            try {
                const panelChatId = callbackQuery?.message?.chat?.id;
                const panelMsgId = callbackQuery?.message?.message_id;
                if (panelChatId && panelMsgId) {
                    await tgCall(env, "editMessageReplyMarkup", { chat_id: panelChatId, message_id: panelMsgId, reply_markup: { inline_keyboard: [] } });
                }
            } catch (_) {}
        }

        // 触发 resetkv 流程：保持原本“文字指令二次确认”
        await kvDelete(env, `reset_session:${adminId}`);

        const sessionData = {
            adminId,
            timestamp: Date.now(),
            threadId: settingsThreadId,
            confirmed: false,
            resetType: "all_chats"
        };

        await kvPut(env, `reset_session:${adminId}`, JSON.stringify(sessionData), {
            expirationTtl: 60
        });

        const confirmationText = `⚠️ **危险操作：清空并重置所有聊天数据**

` +
                                `**这将执行:**
` +
                                `• 删除所有聊天记录和话题（General除外）
` +
                                `• 重置所有用户数据（黑名单、白名单和垃圾消息规则除外）\n\n` +
                                `**影响：**
` +
                                `• 所有聊天记录将会丢失
` +
                                `• 非白名单用户需要重新验证

` +
                                `**确认执行？**
` +
                                `发送 \`/reset_confirm\` 继续操作
` +
                                `或发送 \`/cancel\` 取消操作

⏳ 超时60秒后自动取消操作`;

        await tgCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: settingsThreadId,
            text: confirmationText,
            parse_mode: "Markdown"
        });

        Logger.info('resetkv_triggered_via_settings', { adminId });
        return;
    }

    if (action === "reset_blacklist") {
        // 删除设置面板消息（best-effort）
        try {
            const panelChatId = callbackQuery?.message?.chat?.id;
            const panelMsgId = callbackQuery?.message?.message_id;
            if (panelChatId && panelMsgId) {
                await tgCall(env, "deleteMessage", { chat_id: panelChatId, message_id: panelMsgId });
            }
        } catch (e) {
            try {
                const panelChatId = callbackQuery?.message?.chat?.id;
                const panelMsgId = callbackQuery?.message?.message_id;
                if (panelChatId && panelMsgId) {
                    await tgCall(env, "editMessageReplyMarkup", { chat_id: panelChatId, message_id: panelMsgId, reply_markup: { inline_keyboard: [] } });
                }
            } catch (_) {}
        }

        // 触发“重置黑名单”流程：文字指令二次确认
        await kvDelete(env, `reset_session:${adminId}`);

        const sessionData = {
            adminId,
            timestamp: Date.now(),
            threadId: settingsThreadId,
            confirmed: false,
            resetType: "blacklist"
        };

        await kvPut(env, `reset_session:${adminId}`, JSON.stringify(sessionData), {
            expirationTtl: 60
        });

        const confirmationText = `⚠️ **危险操作：重置黑名单**

` +
                                `**这将执行:**
` +
                                `• 清空所有黑名单记录

` +
                                `**影响：**
` +
                                `• 被拉黑用户将全部解除拉黑

` +
                                `**确认执行？**
` +
                                `发送 \`/reset_confirm\` 继续操作
` +
                                `或发送 \`/cancel\` 取消操作

⏳ 超时60秒后自动取消操作`;

        await tgCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: settingsThreadId,
            text: confirmationText,
            parse_mode: "Markdown"
        });

        Logger.info('reset_blacklist_triggered_via_settings', { adminId });
        return;
    }

    // 未识别 action：忽略
    Logger.debug('settings_callback_unhandled_action', { adminId, action });
}


async function handleCallbackQuery(callbackQuery, env, ctx) {
    const data = (callbackQuery && callbackQuery.data) ? String(callbackQuery.data) : "";
    const userId = callbackQuery?.from?.id;

    if (!userId) return;

    // 处理 /clean 二次确认按钮（cY|... / cN|...）
    if (data.startsWith("cY|") || data.startsWith("cN|")) {
        await handleCleanConfirmCallback(callbackQuery, env, ctx);
        return;
    }

    // 处理 /settings 面板按钮（st|...）
    if (data.startsWith("st|")) {
        await handleSettingsCallback(callbackQuery, env, ctx);
        return;
    }

    // 处理本地题库验证回调（vq|verifyId|idx）
    if (data.startsWith("vq|")) {
        await handleLocalQuizCallback(callbackQuery, env, ctx);
        return;
    }

    // 只处理验证完成按钮
    if (!data.startsWith("vf:")) {
        Logger.debug('callback_query_unhandled', {
            from: userId,
            data
        });
        return;
    }

    // 立即 ACK，避免 Telegram 客户端一直转圈
    try {
        const ack = tgCall(env, "answerCallbackQuery", {
            callback_query_id: callbackQuery.id,
            text: "处理中…",
            show_alert: false
        });
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(ack);
        else await ack;
    } catch (e) {
        // 忽略 ACK 失败
    }

    const verifiedKey = `verified:${userId}`;
    const alreadyVerified = await kvGetText(env, verifiedKey, CONFIG.KV_CRITICAL_CACHE_TTL);
    if (alreadyVerified) {
        try {
            await tgCall(env, "sendMessage", { chat_id: userId, text: USER_NOTIFICATIONS.verified_success });
        } catch (_) {}
        // 尝试移除按钮（避免继续点）
        try {
            if (callbackQuery.message) {
                const chatId = callbackQuery.message.chat?.id;
                const messageId = callbackQuery.message.message_id;
                if (chatId && messageId) {
                    const p = tgCall(env, "editMessageReplyMarkup", {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: { inline_keyboard: [] }
                    });
                    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
                    else await p;
                }
            }
        } catch (_) {}
        await removeVerifyPromptKeyboardsBestEffort(env, userId, ctx);
        Logger.info('verify_finalize_already_verified', { userId });
        return;
    }

    const tokenPart = data.slice(3);
    const parts = tokenPart.split(".");
    if (parts.length !== 2) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "⚠️ 验证参数错误，请重新验证。" });
        return;
    }

    const exp = parseInt(parts[0], 10);
    const sig = parts[1];

    if (!exp || !sig) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "⚠️ 验证参数错误，请重新验证。" });
        return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (exp < now) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "⏰ 完成验证按钮已过期，请重新进行人机验证。" });

        // 尝试移除当前“完成验证”按钮，避免重复点击
        try {
            if (callbackQuery.message) {
                const chatId = callbackQuery.message.chat?.id;
                const messageId = callbackQuery.message.message_id;
                if (chatId && messageId) {
                    const p = tgCall(env, "editMessageReplyMarkup", {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: { inline_keyboard: [] }
                    });
                    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
                    else await p;
                }
            }
        } catch (_) {}

        // v1.2：同时清理旧的“验证按钮消息”，避免用户点到旧 WebApp 按钮造成状态紊乱
        await removeVerifyPromptKeyboardsBestEffort(env, userId, ctx);

        // 重新下发验证链接（不存 pendingMsgId，避免重复暂存）
        const origin = await getWorkerOrigin(env);
        if (origin) await sendTurnstileVerification(userId, env, null, origin, false);
        return;
    }

    const sessionKey = `verify_session:${userId}`;
    const sessionData = await kvGetJSON(env, sessionKey, null, {});

    if (!sessionData || !sessionData.sessionId) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "⏳ 验证会话已失效，请重新验证。" });
        const origin = await getWorkerOrigin(env);
        if (origin) await sendTurnstileVerification(userId, env, null, origin, false);
        return;
    }

    const signSecret = (env.VERIFY_SIGNING_SECRET || env.CF_TURNSTILE_SECRET_KEY || '').toString();
    if (!signSecret) {
        Logger.error('verify_finalize_missing_secret');
        await tgCall(env, "sendMessage", { chat_id: userId, text: "🔧 系统配置错误，请联系管理员。" });
        return;
    }

    const expectedSig = await signVerificationFinalizeToken(signSecret, userId, exp, sessionData.sessionId);
    if (!timingSafeEqual(sig, expectedSig)) {
        Logger.warn('verify_finalize_signature_mismatch', { userId });
        await tgCall(env, "sendMessage", { chat_id: userId, text: "⚠️ 完成验证失败，请重新验证。" });
        const origin = await getWorkerOrigin(env);
        if (origin) await sendTurnstileVerification(userId, env, null, origin, false);
        return;
    }

    // --- finalize：在 webhook 链路写入 verified，并清理会话 ---
    // --- finalize：在 webhook 链路写入 verified，并清理会话 ---
    const verifiedTtl = getVerifiedTtlSeconds(env);
    if (verifiedTtl > 0) {
        await kvPut(env, verifiedKey, "1", { expirationTtl: verifiedTtl });
    } else {
        await kvPut(env, verifiedKey, "1");
    }
    // 宽限窗口：用于兜底 KV 跨 PoP 传播/负缓存导致的“刚验证完仍不放行”
    const graceTtl = normalizeKvExpirationTtl(CONFIG.VERIFIED_GRACE_SECONDS);
    if (graceTtl) await kvPut(env, `verified_grace:${userId}`, "1", { expirationTtl: graceTtl });

    await kvDelete(env, `pending_verify:${userId}`);
    await kvDelete(env, sessionKey);

    await cacheDelete(`verify_pending_ids:${userId}`);
    await cacheDelete(`verify_notice_sent:${userId}`);

    // 可选：移除按钮（编辑消息）
    try {
        if (callbackQuery.message) {
            const chatId = callbackQuery.message.chat?.id;
            const messageId = callbackQuery.message.message_id;
            if (chatId && messageId) {
                const p = tgCall(env, "editMessageReplyMarkup", {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: { inline_keyboard: [] }
                });
                if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
                else await p;
            }
        }
    } catch (_) {}

    // v1.2：移除所有历史“验证按钮消息”的按钮，避免用户验证后误点旧按钮造成状态紊乱
    await removeVerifyPromptKeyboardsBestEffort(env, userId, ctx);


    // 处理暂存消息（如果有）
    await processPendingMessagesAfterVerification(userId, sessionData, env);

    Logger.info('verify_finalize_success', { userId });
}


function renderMiniAppNoticePage({
    title = "提示",
    message = "请返回 Telegram 继续操作",
    autoCloseMs = 1200
} = {}) {
    const safeTitle = String(title || "提示");
    const safeMsg = String(message || "");
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#0b1220;color:#e5e7eb;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
    .card{max-width:520px;width:100%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:22px 20px;box-shadow:0 10px 30px rgba(0,0,0,0.25);}
    h1{margin:0 0 10px;font-size:20px;}
    p{margin:0 0 14px;line-height:1.55;color:#d1d5db;}
    .btn{display:inline-block;padding:10px 14px;border-radius:12px;background:rgba(59,130,246,0.2);border:1px solid rgba(59,130,246,0.35);color:#e5e7eb;text-decoration:none;cursor:pointer;user-select:none;}
    .muted{font-size:12px;color:#9ca3af;margin-top:10px;}
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMsg}</p>
    <a class="btn" href="javascript:void(0)" onclick="try{Telegram.WebApp.close();}catch(e){}">返回 Telegram</a>
    <div class="muted">若未自动返回，请手动关闭此页面。</div>
  </div>
  <script>
    try {
      if (window.Telegram && Telegram.WebApp) {
        Telegram.WebApp.ready();
        const ms = Number(${autoCloseMs});
        if (Number.isFinite(ms) && ms > 0) setTimeout(() => { try { Telegram.WebApp.close(); } catch (e) {} }, ms);
      }
    } catch (e) {}
  </script>
</body>
</html>`;

    return new Response(html, {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store"
        }
    });
}

async function renewTurnstileSessionAndSend(userId, env, origin, previousSessionData = null) {
    // 与 sendTurnstileVerification 的行为保持一致：也受 verify 速率限制约束
    const verifyLimit = await checkRateLimit(userId, env, 'verify', CONFIG.RATE_LIMIT_VERIFY, 300);
    if (!verifyLimit.allowed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: ERROR_MESSAGES.rate_limit });
        return;
    }

    const enableStorage = true;

// v1.2：优先使用 pending_queue:*（跨会话暂存），并合并旧会话快照（若存在）
let pendingIds = enableStorage ? await getPendingQueue(env, userId) : [];
if (enableStorage && previousSessionData && Array.isArray(previousSessionData.pending_ids)) {
    pendingIds = pendingIds.concat(previousSessionData.pending_ids);
}
if (!Array.isArray(pendingIds)) pendingIds = [];

    // 仅保留数字 message_id，去重并裁剪
    const seen = new Set();
    const cleaned = [];
    for (const x of pendingIds) {
        const n = Number(x);
        if (!Number.isFinite(n)) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        cleaned.push(n);
    }
    const trimmed = cleaned.length > CONFIG.PENDING_MAX_MESSAGES
        ? cleaned.slice(-CONFIG.PENDING_MAX_MESSAGES)
        : cleaned;

    const sessionKey = `verify_session:${userId}`;
    const sessionData = {
        userId,
        pending_ids: trimmed,
        timestamp: Date.now(),
        sessionId: secureRandomId(16),
        verificationSent: true,
        provider: "turnstile",
        enableStorage: enableStorage
    };

    await kvPut(env, sessionKey, JSON.stringify(sessionData), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
    await kvPut(env, `pending_verify:${userId}`, "1", { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
    await cacheDelete(`verify_notice_sent:${userId}`);

    const ps = (enableStorage && trimmed.length > 0) ? "1" : "0";
    const verifyUrl = `${origin}${CONFIG.VERIFY_PATH}?sid=${sessionData.sessionId}&uid=${userId}&ps=${ps}`;
    const verificationText = enableStorage ? USER_NOTIFICATIONS.verification_sent : USER_NOTIFICATIONS.verification_required_no_storage;

    const sent = await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: verificationText,
        reply_markup: {
            inline_keyboard: [[
                { text: CONFIG.VERIFY_BUTTON_TEXT, web_app: { url: verifyUrl } }
            ]]
        }
    });
    try {
        if (sent && sent.ok && sent.result && sent.result.message_id) {
            await addVerifyPromptMsgId(env, userId, sent.result.message_id);
        }
    } catch (_) {}
}

async function renderVerifyPage(request, env, ctx) {
    const url = new URL(request.url);
    const sid = url.searchParams.get('sid');
    const uid = url.searchParams.get('uid');
    const ps = url.searchParams.get('ps');
    if (!sid || !uid) {
        return new Response('Missing session ID or user ID', { status: 400 });
    }

    const userId = Number(uid);
    if (!Number.isFinite(userId) || userId <= 0) {
        return new Response('Invalid user ID', { status: 400 });
    }

    // Turnstile 未配置时，直接提示并引导回 Telegram 使用本地题库验证
    if (!hasTurnstileBinding(env)) {
        const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>验证不可用</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    body{
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Noto Sans","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
      margin:0;padding:24px;background:#0b1220;color:#e5e7eb;
    }
    .card{
      max-width:520px;margin:0 auto;background:rgba(255,255,255,.06);
      border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:20px;
    }
    h1{font-size:20px;margin:0 0 10px 0;}
    p{margin:0 0 14px 0;line-height:1.5;color:#cbd5e1;}
    code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:6px;}
    a.btn{
      display:inline-block;padding:10px 14px;border-radius:12px;background:rgba(255,255,255,.12);
      border:1px solid rgba(255,255,255,.18);color:#fff;text-decoration:none;
    }
    .small{font-size:12px;color:#94a3b8;margin-top:12px;line-height:1.4;}
  </style>
</head>
<body>
  <div class="card">
    <h1>Turnstile 未配置</h1>
    <p>管理员尚未在环境变量中配置 <code>CF_TURNSTILE_SITE_KEY</code> 与 <code>CF_TURNSTILE_SECRET_KEY</code>，因此网页验证暂不可用。</p>
    <p>请返回 Telegram，在对话中使用 <b>本地题库验证</b> 完成人机验证。</p>
    <a class="btn" href="#" onclick="try{Telegram.WebApp.close();}catch(e){};return false;">返回 Telegram</a>
    <div class="small">提示：如果你是管理员，请在 Cloudflare Workers 的 Variables/Secrets 中配置上述两项后再启用 Turnstile。</div>
  </div>
</body>
</html>`;
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 503 });
    }

    const currentOrigin = url.origin;
    const callbackUrl = `${currentOrigin}${CONFIG.VERIFY_CALLBACK_PATH}`;
    const eventUrl = `${currentOrigin}${CONFIG.VERIFY_EVENT_PATH}`;

    let verified = await kvGetText(env, `verified:${userId}`, CONFIG.KV_CRITICAL_CACHE_TTL);
    if (!verified) {
        const grace = await kvGetText(env, `verified_grace:${userId}`, CONFIG.KV_CRITICAL_CACHE_TTL);
        if (grace) verified = "1";
    }
    if (verified) {
        return renderMiniAppNoticePage({
            title: "已验证",
            message: "✅ 您已完成验证，可以返回 Telegram。",
            autoCloseMs: 900
        });
    }

    // 方案 A：在打开 /verify 页面时先判断会话是否仍有效
    const sessionKey = `verify_session:${userId}`;
    let sessionData = await kvGetJSON(env, sessionKey, null, {});
    const now = Date.now();
    const maxAgeMs = CONFIG.VERIFY_EXPIRE_SECONDS * 1000;
    const sessionAgeMs = (sessionData && sessionData.timestamp) ? (now - Number(sessionData.timestamp)) : Number.POSITIVE_INFINITY;

    const provider = sessionData && sessionData.provider ? String(sessionData.provider) : null;
    const isTurnstileSession = !!(sessionData && provider === "turnstile");
    const isLinkValid = !!(
        sessionData &&
        isTurnstileSession &&
        sessionData.sessionId &&
        String(sessionData.sessionId) === String(sid) &&
        sessionAgeMs <= maxAgeMs
    );

    if (!isLinkValid) {
        // v1.4：链接失效/超时后，先把 Telegram 里的旧验证按钮消掉，并更新文案
        try {
            await removeVerifyPromptKeyboardsBestEffort(
                env,
                userId,
                ctx,
                USER_NOTIFICATIONS.verification_button_failed
            );
        } catch (_) {}

        // 防刷：同一用户短时间内只重发一次
        const lockKey = `verify_resend_lock:${userId}`;
        const locked = await cacheGetText(lockKey);
        if (!locked) {
            await cachePutText(lockKey, "1", 20);

            // 1) 先提示超时
            const timeoutNotice = "⏰ 您的验证链接已超时，请重新进行验证";
            const pNotice = tgCall(env, "sendMessage", { chat_id: userId, text: timeoutNotice });
            if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(pNotice);
            else await pNotice;

            // 2) 再发一个新的验证（尽量不影响暂存消息）
            if (sessionAgeMs > maxAgeMs) {
                // 若确实已过期，先清理，避免 sendHumanVerification 误判“仍在验证”
                await checkAndCleanExpiredSession(env, userId);
                sessionData = null;
            }

            if (isTurnstileSession) {
                await renewTurnstileSessionAndSend(userId, env, currentOrigin, sessionData);
            } else {
                // 无会话或会话非 Turnstile：按当前全局/会话规则重新发起验证
                await sendHumanVerification(userId, env, null, currentOrigin, false);
            }
        }

        return renderMiniAppNoticePage({
            title: "验证链接已超时",
            message: "已在 Telegram 重新发送验证，请返回 Telegram 点击最新按钮完成验证。",
            autoCloseMs: 1200
        });
    }
    
    const siteKey = (env.CF_TURNSTILE_SITE_KEY || '').toString();
    const turnstileAction = (env.TURNSTILE_ACTION || CONFIG.TURNSTILE_ACTION || '').toString().trim();
    let infoBoxHtml = `
        <div class="info-box">
            <p>🔒 您的隐私受到保护，验证过程不会收集个人信息</p>
            <p>⚡ 验证成功后会自动返回 Telegram</p>
                ${ps === '1' ? '<p>📩 您刚才发送的消息已暂存，验证通过后会自动转发</p>' : ''}
`;
    infoBoxHtml += `</div>`;
    
    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>人机验证</title>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        :root {
            --primary-color: #3b82f6;
            --success-color: #10b981;
            --error-color: #ef4444;
            --background-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            --card-bg: rgba(255, 255, 255, 0.95);
            --text-primary: #1f2937;
            --text-secondary: #6b7280;
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: var(--background-gradient);
            color: var(--text-primary);
            padding: 20px;
        }
        
        .container {
            background: var(--card-bg);
            border-radius: 20px;
            padding: 2.5rem;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            max-width: 480px;
            width: 100%;
            text-align: center;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .logo {
            font-size: 3rem;
            margin-bottom: 1.5rem;
            animation: bounce 2s infinite;
        }
        
        h1 {
            font-size: 1.75rem;
            font-weight: 700;
            margin-bottom: 0.75rem;
            color: var(--text-primary);
            line-height: 1.3;
        }
        
        .subtitle {
            color: var(--text-secondary);
            margin-bottom: 2rem;
            font-size: 1rem;
            line-height: 1.5;
        }
        
        .turnstile-container {
            margin: 2rem 0;
            display: flex;
            justify-content: center;
        }
        
        .status-message {
            padding: 1rem;
            border-radius: 12px;
            margin: 1.5rem 0;
            display: none;
            animation: fadeIn 0.5s ease-in-out;
            font-weight: 500
        }
        
        .success {
            background-color: rgba(16, 185, 129, 0.1);
            color: var(--success-color);
            border: 1px solid rgba(16, 185, 129, 0.2);
        }
        
        .error {
            background-color: rgba(239, 68, 68, 0.1);
            color: var(--error-color);
            border: 1px solid rgba(239, 68, 68, 0.2);
        }
        
        .info-box {
            background-color: rgba(59, 130, 246, 0.1);
            border-left: 4px solid var(--primary-color);
            padding: 1rem;
            margin: 1.5rem 0;
            text-align: left;
            border-radius: 8px;
        }
        
        .info-box p {
            margin: 0.5rem 0;
            font-size: 0.9rem;
        }
        
        .footer {
            margin-top: 2rem;
            color: var(--text-secondary);
            font-size: 0.875rem;
        }
        
        .loading {
            display: none;
            margin: 1rem 0;
        }
        
        .loading-spinner {
            width: 40px;
            height: 40px;
            border: 4px solid rgba(59, 130, 246, 0.2);
            border-top: 4px solid var(--primary-color);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto;
        }
        
        @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        @media (max-width: 480px) {
            .container {
                padding: 1.5rem;
            }
            
            h1 {
                fontSize: 1.5rem;
            }
            
            .logo {
                fontSize: 2.5rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">🤖</div>
        <h1>请完成安全验证</h1>
        <p class="subtitle">为了保护系统安全，请完成下方的人机验证以继续操作</p>
        
        ${infoBoxHtml}
        
        <div class="turnstile-container" id="turnstile-widget">
            <!-- Turnstile 验证组件将在这里加载 -->
        </div>
        
        <div class="loading" id="loading">
            <div class="loading-spinner"></div>
            <p style="margin-top: 0.5rem;">正在验证，请稍候...</p>
        </div>
        
        <div class="status-message success" id="success-msg">
            ✅ 验证成功！正在返回 Telegram...
        </div>
        
        <div class="status-message error" id="error-msg">
            ❌ 验证失败，请刷新页面重试
        </div>
        
        <div class="footer">
            <p>Powered by Cloudflare</p>
            <p>此验证用于防止自动化请求</p>
        </div>
    </div>

    <script>
        const tg = window.Telegram?.WebApp;
        if (tg) {
            tg.ready();
            tg.expand();
        }

        const EVENT_URL = '${eventUrl}';
        let widgetId = null;

        function reportFail(reason, errorCode) {
            try {
                const urlParams = new URLSearchParams(window.location.search);
                const sid = urlParams.get('sid');
                const uid = urlParams.get('uid');
                if (!sid || !uid) return;

                fetch(EVENT_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sid, uid, reason, errorCode: errorCode || null }),
                    keepalive: true
                }).catch(() => {});
            } catch (_) {}
        }

        function onFail(reason, errorCode) {
            console.warn('Turnstile fail:', reason, errorCode || '');
            reportFail(reason, errorCode);
            document.getElementById('loading').style.display = 'none';
            showError("☁️ Cloudflare 验证失败，请返回 Telegram 点击最新按钮重试");
            try {
                if (window.turnstile && widgetId !== null) {
                    window.turnstile.reset(widgetId);
                }
            } catch (_) {}
        }

        function onVerify(token) {
            const urlParams = new URLSearchParams(window.location.search);
            const sid = urlParams.get('sid');
            const uid = urlParams.get('uid');
            
            if (!sid || !uid) {
                showError("错误：缺少会话参数");
                return;
            }

            document.getElementById('turnstile-widget').style.display = 'none';
            document.getElementById('loading').style.display = 'block';
            
            fetch('${callbackUrl}', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, sid, uid })
            })
            .then(response => {
                if (response.ok) {
                    return response.json();
                }
                throw new Error('验证失败');
            })
            .then(data => {
                if (data.success) {
                    showSuccess();
                    
                    if (data.enableStorage && data.forwardedCount > 0) {
                        document.getElementById('success-msg').textContent = 
                            '✅ 验证成功！已自动转发 ' + data.forwardedCount + ' 条消息。正在返回 Telegram...';
                    }
                    
                    setTimeout(() => {
                        if (tg) {
                            tg.close();
                        } else {
                            alert('验证成功！请返回 Telegram 继续。');
                        }
                    }, 2000);
                } else {
                    throw new Error(data.error || '验证失败');
                }
            })
            .catch(err => {
                console.error('验证错误:', err);
                onFail('verify_failed');
            });
        }

        function showError(message) {
            const errorEl = document.getElementById('error-msg');
            errorEl.textContent = message;
            errorEl.style.display = 'block';
            document.getElementById('turnstile-widget').style.display = 'block';
        }

        function showSuccess() {
            document.getElementById('loading').style.display = 'none';
            const successEl = document.getElementById('success-msg');
            successEl.style.display = 'block';
        }

        function initTurnstile() {
            if (window.turnstile) {
                widgetId = window.turnstile.render('#turnstile-widget', {
                    sitekey: '${siteKey}',
                    callback: onVerify,
                    'error-callback': function(errorCode) { onFail('error', errorCode); },
                    'expired-callback': function() { onFail('expired'); },
                    'timeout-callback': function() { onFail('timeout'); },
                    ${turnstileAction ? "action: '" + turnstileAction + "'," : ""}
                    theme: 'light',
                    size: 'normal',
                    language: 'zh-CN'
                });
            } else {
                setTimeout(initTurnstile, 100);
            }
        }

        document.addEventListener('DOMContentLoaded', initTurnstile);
    </script>
</body>
</html>`;
    
    return new Response(html, {
        headers: { 
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': 'no-cache, no-store, must-revalidate'
        }
    });
}

async function checkAndCleanExpiredSession(env, userId) {
    try {
        const sessionKey = `verify_session:${userId}`;
        const sessionData = await kvGetJSON(env, sessionKey, null, {});
        
        if (!sessionData || !sessionData.timestamp) {
            const pendingVerify = await kvGetText(env, `pending_verify:${userId}`, CONFIG.KV_CRITICAL_CACHE_TTL);
            if (pendingVerify) {
                await kvDelete(env, `pending_verify:${userId}`);
                Logger.debug('orphaned_pending_cleaned_at_entry', { userId });
            }
            return false;
        }
        
        const sessionAge = Date.now() - sessionData.timestamp;
        if (sessionAge > CONFIG.VERIFY_EXPIRE_SECONDS * 1000) {
            await kvDelete(env, sessionKey);
            await kvDelete(env, `pending_verify:${userId}`);
            
            Logger.info('expired_session_cleaned_at_entry', {
                userId,
                sessionAge,
                sessionId: sessionData.sessionId
            });
            
            return true;
        }
        
        return false;
    } catch (e) {
        Logger.error('check_expired_session_failed', e, { userId });
        return false;
    }
}

function getOriginFromRequest(request) {
    try {
        return new URL(request.url).origin;
    } catch (e) {
        Logger.error('failed_to_get_origin_from_request', e);
        return null;
    }
}

async function deleteAllUserTopics(env, threadId, adminId) {
    const startTime = Date.now();
    const stats = {
        totalTopics: 0,
        deletedTopics: 0,
        failedTopics: 0,
        skippedTopics: 0,
        topicsDeletedFromKV: [],
        topicsNotInKV: [],
        duration: 0
    };
    
    try {
        Logger.info('delete_all_user_topics_started', {
            adminId,
            threadId
        });
        
        // 首先收集所有用户话题
        // 从KV中的user记录获取thread_id
        const userKeys = await getAllKeys(env, "user:", CONFIG.KV_OPERATION_MAX_ITEMS);
        const topicsFromKV = new Set();
        
        {
            const concurrency = Math.max(1, Math.min(16, CONFIG.KV_SCAN_CONCURRENCY || 8));
            for (let i = 0; i < userKeys.length; i += concurrency) {
                const chunk = userKeys.slice(i, i + concurrency).map(k => k && k.name ? String(k.name) : null).filter(Boolean);
                const recs = await Promise.all(chunk.map(name =>
                    safeGetJSONPhysical(env, name, null, { cacheTtl: CONFIG.KV_CRITICAL_CACHE_TTL })
                ));
                for (const userRec of recs) {
                    if (userRec && userRec.thread_id && userRec.thread_id !== 1) {
                        topicsFromKV.add(userRec.thread_id);
                    }
                }
            }
        }
// 从thread记录获取thread_id
        const threadKeys = await getAllKeys(env, "thread:", CONFIG.KV_OPERATION_MAX_ITEMS);
        for (const { name } of threadKeys) {
            try {
                const match = name.match(/^thread:(\d+)$/);
                if (match) {
                    const threadId = parseInt(match[1]);
                    if (threadId && threadId !== 1) {
                        topicsFromKV.add(threadId);
                    }
                }
            } catch (e) {
                Logger.warn('failed_to_parse_thread_key', e, { key: name });
            }
        }
        
        stats.totalTopics = topicsFromKV.size;
        stats.topicsDeletedFromKV = Array.from(topicsFromKV);
        
        if (stats.totalTopics === 0) {
            Logger.info('no_user_topics_found', { adminId });
            stats.duration = Date.now() - startTime;
            return stats;
        }
        
        // 发送进度报告
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: `🗑️ **开始删除用户话题**\n\n找到 ${stats.totalTopics} 个用户话题，正在批量删除...`,
            parse_mode: "Markdown"
        }, threadId));
        
        // 批量删除话题
        const topicIds = Array.from(topicsFromKV);
        const batchSize = CONFIG.TOPIC_DELETE_MAX_PER_BATCH;
        
        for (let i = 0; i < topicIds.length; i += batchSize) {
            const batch = topicIds.slice(i, i + batchSize);
            const batchNumber = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(topicIds.length / batchSize);
            
            // 报告当前批次进度
            const progressPercent = Math.round((i / topicIds.length) * 100);
            if (progressPercent % 20 === 0 || i + batchSize >= topicIds.length) {
                await tgCall(env, "sendMessage", withMessageThreadId({
                    chat_id: env.SUPERGROUP_ID,
                    message_thread_id: threadId,
                    text: `🗑️ **删除进度**: ${progressPercent}%\n批次 ${batchNumber}/${totalBatches}\n已删除 ${stats.deletedTopics} 个话题`,
                    parse_mode: "Markdown"
                }, threadId));
            }
            
            // 批量删除当前批次的话题
            for (const topicId of batch) {
                try {
                    // 重试机制
                    let retryCount = 0;
                    let deleted = false;
                    
                    while (retryCount < CONFIG.TOPIC_DELETE_RETRY_ATTEMPTS && !deleted) {
                        try {
                            const deleteResult = await tgCall(env, "deleteForumTopic", {
                                chat_id: env.SUPERGROUP_ID,
                                message_thread_id: topicId
                            });
                            
                            if (deleteResult.ok) {
                                stats.deletedTopics++;
                                deleted = true;
                                Logger.debug('topic_deleted_successfully', {
                                    topicId,
                                    adminId,
                                    retryCount
                                });
                            } else {
                                if (retryCount < CONFIG.TOPIC_DELETE_RETRY_ATTEMPTS - 1) {
                                    retryCount++;
                                    Logger.warn('topic_delete_failed_retrying', {
                                        topicId,
                                        adminId,
                                        error: deleteResult.description,
                                        retryCount
                                    });
                                    await new Promise(r => setTimeout(r, CONFIG.TOPIC_DELETE_RETRY_DELAY_MS));
                                } else {
                                    stats.failedTopics++;
                                    Logger.warn('topic_delete_failed_final', {
                                        topicId,
                                        adminId,
                                        error: deleteResult.description
                                    });
                                    break;
                                }
                            }
                        } catch (deleteError) {
                            if (retryCount < CONFIG.TOPIC_DELETE_RETRY_ATTEMPTS - 1) {
                                retryCount++;
                                Logger.warn('topic_delete_exception_retrying', deleteError, {
                                    topicId,
                                    adminId,
                                    retryCount
                                });
                                await new Promise(r => setTimeout(r, CONFIG.TOPIC_DELETE_RETRY_DELAY_MS));
                            } else {
                                stats.failedTopics++;
                                Logger.error('topic_delete_exception_final', deleteError, {
                                    topicId,
                                    adminId
                                });
                                break;
                            }
                        }
                    }
                    
                    // 批次间延迟，避免触发速率限制
                    if (batch.length > 1) {
                        await new Promise(r => setTimeout(r, CONFIG.TOPIC_DELETE_DELAY_MS));
                    }
                    
                } catch (e) {
                    stats.failedTopics++;
                    Logger.error('topic_delete_unexpected_error', e, {
                        topicId,
                        adminId
                    });
                }
            }
        }
        
        // 清理内存缓存中的话题信息
        for (const topicId of topicIds) {
            threadHealthCache.delete(topicId);
        }
        
        stats.duration = Date.now() - startTime;
        
        // 发送完成报告
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: `🗑️ **话题删除完成**\n\n✅ 成功删除: ${stats.deletedTopics} 个\n❌ 删除失败: ${stats.failedTopics} 个\n⏱️ 耗时: ${Math.round(stats.duration / 1000)} 秒`,
            parse_mode: "Markdown"
        }, threadId));
        
        Logger.info('delete_all_user_topics_completed', stats);
        
        return stats;
    } catch (e) {
        Logger.error('delete_all_user_topics_failed', e, {
            adminId,
            threadId
        });
        
        stats.duration = Date.now() - startTime;
        stats.error = e.message;
        
        return stats;
    }
}

// 主 fetch 处理器
export default {
    async fetch(request, env, ctx) {

        const url = new URL(request.url);
        const cfColo = request.cf?.colo;
        const cfRay = request.headers.get('CF-Ray');
        Logger.debug('request_meta', { path: url.pathname, method: request.method, colo: cfColo, ray: cfRay });

        // --- Webhook Secret 验证 ---
        if (request.method === 'POST' && env.WEBHOOK_SECRET && url.pathname === CONFIG.WEBHOOK_PATH) {
            const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
            if (secretToken !== env.WEBHOOK_SECRET) {
                Logger.warn('webhook_secret_mismatch', {
                    received: secretToken ? '***' + secretToken.slice(-4) : 'null',
                    expected: '***' + env.WEBHOOK_SECRET.slice(-4)
                });
                return new Response('Forbidden: Invalid secret token', { status: 403 });
            }
            Logger.debug('webhook_secret_verified');
        }

        if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
        if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
        if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");
        const normalizedEnv = {
            ...env,
            SUPERGROUP_ID: String(env.SUPERGROUP_ID),
            BOT_TOKEN: String(env.BOT_TOKEN),
            CF_TURNSTILE_SITE_KEY: env.CF_TURNSTILE_SITE_KEY ? String(env.CF_TURNSTILE_SITE_KEY) : "",
            CF_TURNSTILE_SECRET_KEY: env.CF_TURNSTILE_SECRET_KEY ? String(env.CF_TURNSTILE_SECRET_KEY) : "",
            WORKER_URL: env.WORKER_URL ? String(env.WORKER_URL) : null,
            WEBHOOK_SECRET: env.WEBHOOK_SECRET ? String(env.WEBHOOK_SECRET) : null
        };
        // 强制在每次部署后第一次运行时同步指令菜单（只执行一次 per instance）
        if (!globalThis.__commandsInitialized) {
            globalThis.__commandsInitialized = true;
            try {
                await ensureCommandsSynced(normalizedEnv);
            } catch (e) {
                Logger.error('ensureCommandsSynced_initial_run_failed', e);
            }
        }
if (!normalizedEnv.SUPERGROUP_ID.startsWith("-100")) {
            return new Response("Error: SUPERGROUP_ID must start with -100");
        }

        
        if (url.pathname === CONFIG.VERIFY_PATH) {
            return await renderVerifyPage(request, normalizedEnv, ctx);
        }
        
        if (url.pathname === CONFIG.VERIFY_CALLBACK_PATH) {
            return handleVerifyCallback(request, normalizedEnv, ctx);
        }

        if (url.pathname === CONFIG.VERIFY_EVENT_PATH) {
            return handleVerifyEvent(request, normalizedEnv, ctx);
        }


        // 只允许在 WEBHOOK_PATH 上处理 Telegram webhook（/verify* 已在上方提前处理）
        if (request.method === 'POST' && url.pathname !== CONFIG.WEBHOOK_PATH) {
            return new Response('Not Found', { status: 404 });
        }

        if (request.method !== "POST") {
            Logger.debug('non_post_request_ignored', {
                method: request.method,
                path: url.pathname
            });
            return new Response("OK");
        }

        const contentType = request.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
            Logger.warn('invalid_content_type', { contentType });
            return new Response("OK");
        }

        let update;
        try {
            update = await request.json();

            if (!update || typeof update !== 'object') {
                Logger.warn('invalid_json_structure', { update: typeof update });
                return new Response("OK");
            }
        } catch (e) {
            Logger.error('json_parse_failed', e);
            return new Response("OK");
        }

        // --- 限制可处理的 Update 类型 ---
        const updateId = update.update_id;
        const updateTypes = [];
        
        if (update.message) updateTypes.push('message');
        if (update.edited_message) updateTypes.push('edited_message');
        if (update.callback_query) updateTypes.push('callback_query');
        // 只处理这几种类型，其他类型忽略
        if (update.channel_post) updateTypes.push('channel_post');
        if (update.edited_channel_post) updateTypes.push('edited_channel_post');
        if (update.inline_query) updateTypes.push('inline_query');
        if (update.chosen_inline_result) updateTypes.push('chosen_inline_result');
        if (update.shipping_query) updateTypes.push('shipping_query');
        if (update.pre_checkout_query) updateTypes.push('pre_checkout_query');
        if (update.poll) updateTypes.push('poll');
        if (update.poll_answer) updateTypes.push('poll_answer');
        if (update.my_chat_member) updateTypes.push('my_chat_member');
        if (update.chat_member) updateTypes.push('chat_member');
        if (update.chat_join_request) updateTypes.push('chat_join_request');
        
        // 记录所有 update 类型（调试用）
        Logger.debug('update_received', {
            updateId,
            types: updateTypes,
            hasMessage: !!update.message,
            hasCallbackQuery: !!update.callback_query
        });

        // 只处理我们关心的类型
        if (!update.message && !update.edited_message && !update.callback_query) {
            Logger.debug('unhandled_update_type_ignored', {
                updateId,
                types: updateTypes
            });
            return new Response("OK");
        }


        // --- 处理 callback_query ---
        if (update.callback_query) {
            try {
                await handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
            } catch (e) {
                if (isKvQuotaError(e)) {
                    await tripKvQuotaBreaker();
                    const { chatId, threadId } = extractChatAndThreadFromUpdate({ callback_query: update.callback_query });
                    if (chatId) await sendKvQuotaExceededNotice(normalizedEnv, chatId, threadId);
                } else {
                    Logger.error('handle_callback_query_failed', e);
                }
            }
            return new Response("OK");
        }

        // --- 处理消息 ---
        const msg = update.message || update.edited_message;
        if (!msg) return new Response("OK");

        // 记录消息来源
        Logger.debug('message_received', {
            updateId,
            messageId: msg.message_id,
            chatId: msg.chat?.id,
            chatType: msg.chat?.type,
            hasText: !!msg.text,
            textPreview: msg.text ? msg.text.substring(0, 100) : null,
            fromId: msg.from?.id,
            isEdited: !!update.edited_message
        });

        

        if (msg.chat && msg.chat.type === "private") {
            try {
                const botEnabled = await isBotEnabled(normalizedEnv);
                if (!botEnabled) {
                    await tgCall(normalizedEnv, "sendMessage", {
                        chat_id: msg.chat.id,
                        text: ERROR_MESSAGES.bot_closed
                    });
                    return new Response("OK");
                }
                
                const origin = getOriginFromRequest(request) || await getWorkerOrigin(normalizedEnv);
                await handlePrivateMessage(msg, normalizedEnv, ctx, origin);
            } catch (e) {
                if (isKvQuotaError(e)) {
                    await tripKvQuotaBreaker();
                    await sendKvQuotaExceededNotice(normalizedEnv, msg.chat.id, msg.message_thread_id ?? null);
                    return new Response("OK");
                }
                const errText = ERROR_MESSAGES.system_error;
                await tgCall(normalizedEnv, "sendMessage", { chat_id: msg.chat.id, text: errText });
                Logger.error('handle_private_message_failed', e, { userId: msg.chat.id });
                return new Response("OK");
            }

        }

        if (msg.chat && String(msg.chat.id) === normalizedEnv.SUPERGROUP_ID) {
            const text = (msg.text || "").trim();
            const command = extractCommand(text);

            // 处理管理员消息：
            // - 命令消息
            // - forum topic 内消息（message_thread_id 存在）
            // - 回复机器人消息（用于规则编辑等会话，即使不在 topic 内也要能触发）
            const isReplyToBot = !!(msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot);

            if (command || msg.message_thread_id || isReplyToBot) {
                await handleAdminReply(msg, normalizedEnv, ctx);
                return new Response("OK");
            }
        }

        // 忽略其他消息（频道消息、其他群组等）
        Logger.debug('message_from_other_chat_ignored', {
            chatId: msg.chat?.id,
            chatType: msg.chat?.type,
            supergroupId: normalizedEnv.SUPERGROUP_ID
        });

        return new Response("OK");
    }
};

// ---------------- 核心业务逻辑 ----------------

async function handlePrivateMessage(msg, env, ctx, origin = null) {
    const userId = msg.chat.id;
    const key = `user:${userId}`;
    // 记录用户资料（用于 /blacklist 展示 @username；不做额外拉取）
    await upsertUserProfileFromUpdate(env, msg.from);


    const sessionExpired = await checkAndCleanExpiredSession(env, userId);
    if (sessionExpired) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: ERROR_MESSAGES.verification_expired
        });
    }

    const command = extractCommand(msg.text);
    const isStartCommand = command === "start";
    

    if (command && command !== "start") {
        return;
    }

    const isBanned = await kvGetText(env, `banned:${userId}`, CONFIG.KV_CRITICAL_CACHE_TTL);
    if (isBanned) return;

    const trusted = await isTrustedUser(env, userId);
    if (trusted) {
        // 白名单用户：跳过人机验证与垃圾识别检查
        // best-effort 清理遗留的验证会话状态，避免出现“已验证仍提示验证”的死循环
        try {
            const p1 = kvDelete(env, `pending_verify:${userId}`);
            const p2 = kvDelete(env, `verify_session:${userId}`);
            const p3 = kvDelete(env, `verified_grace:${userId}`);
            if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(Promise.allSettled([p1, p2, p3]));
        } catch (_) {}

        if (isStartCommand) {
            await tgCall(env, "sendMessage", {
                chat_id: userId,
                text: "😉 欢迎回来！您现在可以直接发送消息给管理员了。"
            });
            return;
        }

        await forwardToTopic(msg, userId, key, env, ctx);
        return;
    }

    let verified = await kvGetText(env, `verified:${userId}`, CONFIG.KV_CRITICAL_CACHE_TTL);

    if (!verified) {
        const grace = await kvGetText(env, `verified_grace:${userId}`, CONFIG.KV_CRITICAL_CACHE_TTL);
        if (grace) {
            verified = "1";
            // best-effort 重新写入 verified（若之前在别的 PoP 写入未传播/被负缓存）
            const verifiedTtl = getVerifiedTtlSeconds(env);
            const p = (verifiedTtl > 0)
                ? kvPut(env, `verified:${userId}`, "1", { expirationTtl: verifiedTtl })
                : kvPut(env, `verified:${userId}`, "1");
            if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
        }
    }

    if (!verified) {
        if (isStartCommand) {
            if (!origin) {
                Logger.error('handlePrivateMessage_no_origin', { userId });
                await tgCall(env, "sendMessage", {
                    chat_id: userId,
                    text: ERROR_MESSAGES.worker_origin_error
                });
                return;
            }
            await sendHumanVerification(userId, env, null, origin, true);
            return;
        }
        
        const pendingMsgId = msg.message_id;

        // 未验证用户：若命中垃圾规则或 AI 判定为垃圾，则丢弃消息并提示用户（不触发转发，也不触发暂存）
        try {
            const verdict = await classifySpamOptional(env, msg);
            if (verdict && verdict.is_spam) {
                await notifyUserSpamDropped(env, userId);
                return;
            }
        } catch (_) {}

        if (!origin) {
            Logger.error('handlePrivateMessage_no_origin_for_verification', { userId });
            await tgCall(env, "sendMessage", {
                chat_id: userId,
                text: ERROR_MESSAGES.worker_origin_error
            });
            return;
            }
        await sendHumanVerification(userId, env, pendingMsgId, origin, false);
        return;
    }

    if (isStartCommand) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "😉 欢迎回来！您现在可以直接发送消息给管理员了。"
        });
        return;
    }

    await forwardToTopic(msg, userId, key, env, ctx);
}

async function forwardToTopic(msg, userId, key, env, ctx) {
    const command = extractCommand(msg.text);
    const isStartCommand = command === "start";
    
    if (isStartCommand) {
        return;
    }

    const trusted = await isTrustedUser(env, userId);
    if (trusted) {
        // 白名单用户：跳过 pending_verify 检查（并清理残留状态）
        try {
            const p1 = kvDelete(env, `pending_verify:${userId}`);
            const p2 = kvDelete(env, `verify_session:${userId}`);
            const p3 = kvDelete(env, `verified_grace:${userId}`);
            if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(Promise.allSettled([p1, p2, p3]));
        } catch (_) {}
    }

    const pendingVerify = trusted ? null : await kvGetText(env, `pending_verify:${userId}`, CONFIG.KV_CRITICAL_CACHE_TTL);
if (pendingVerify) {
    // v1.2：若已验证（或处于 grace），但 pending_verify 仍残留，则直接清理并继续放行，避免“验证后仍要求验证”的死循环
    let verified = await kvGetText(env, `verified:${userId}`, CONFIG.KV_CRITICAL_CACHE_TTL);
    if (!verified) {
        const grace = await kvGetText(env, `verified_grace:${userId}`, CONFIG.KV_CRITICAL_CACHE_TTL);
        if (grace) verified = "1";
    }
    if (verified) {
        await kvDelete(env, `pending_verify:${userId}`);
        await kvDelete(env, `verify_session:${userId}`);
        await cacheDelete(`verify_notice_sent:${userId}`);
        // 继续走正常转发逻辑
    } else {
        const sessionExpired = await checkAndCleanExpiredSession(env, userId);
        if (sessionExpired) {
            await tgCall(env, "sendMessage", {
                chat_id: userId,
                text: ERROR_MESSAGES.verification_expired
            });
            
            const origin = await getWorkerOrigin(env);
            if (!origin) {
                Logger.error('forwardToTopic_no_origin_for_expired_session', { userId });
                await tgCall(env, "sendMessage", {
                    chat_id: userId,
                    text: ERROR_MESSAGES.worker_origin_error
                });
                return;
            }
            await sendHumanVerification(userId, env, msg.message_id, origin, false);
            return;
        }
        const sessionKey = `verify_session:${userId}`;
        const sessionData = await kvGetJSON(env, sessionKey, null, {});
        const enableStorage = true;

        if (enableStorage) {

// v1.2：暂存消息写入 pending_queue（跨会话保留）
const msgId = msg.message_id;
 // 若命中垃圾规则或 AI 判定为垃圾，则丢弃消息并提示用户（不暂存）
 try {
     const verdict = await classifySpamOptional(env, msg);
     if (verdict && verdict.is_spam) {
         await notifyUserSpamDropped(env, userId);
         return;
     }
 } catch (_) {}
const queueIds = await appendPendingQueue(env, userId, msgId);

// 同步到 session 快照（若存在），并仅在首次暂存时提示一次
let shouldSendNotice = false;
if (sessionData && sessionData.sessionId) {
    sessionData.pending_ids = Array.isArray(queueIds) ? queueIds : [];
    if (!sessionData.hasSentStorageNotice) {
        sessionData.hasSentStorageNotice = true;
        shouldSendNotice = true;
    }
    await kvPut(env, sessionKey, JSON.stringify(sessionData), {
        expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS
    });
} else {
    // sessionData 缺失：用缓存键避免重复提示
    const noticeKey = `pending_queue_notice:${userId}`;
    const noticed = await cacheGetText(noticeKey);
    if (!noticed) {
        await cachePutText(noticeKey, "1", 300);
        shouldSendNotice = true;
    }
}

if (shouldSendNotice) {
    await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: USER_NOTIFICATIONS.first_message_stored
    });

    Logger.debug('storage_notice_sent_first_message_in_forward', {
        userId,
        messageId: msgId,
        sessionId: sessionData && sessionData.sessionId ? sessionData.sessionId : null,
        pendingCount: Array.isArray(queueIds) ? queueIds.length : 0
    });
} else {
    Logger.debug('message_added_to_pending_during_verification', {
        userId,
        messageId: msgId,
        sessionId: sessionData && sessionData.sessionId ? sessionData.sessionId : null,
        pendingCount: Array.isArray(queueIds) ? queueIds.length : 0
    });
}
        } else {
            await tgCall(env, "sendMessage", {
                chat_id: userId,
                text: USER_NOTIFICATIONS.verification_required_no_storage
            });
        }
        return;
    }
}

    // 已验证用户：若命中垃圾规则或 AI 判定为垃圾，则丢弃消息并提示用户（不转发）
    if (!trusted) {
        try {
            const verdict = await classifySpamOptional(env, msg);
            if (verdict && verdict.is_spam) {
                await notifyUserSpamDropped(env, userId);
                return;
            }
        } catch (_) {}
    }


    let rec = await kvGetJSON(env, key, null);

    const retryKey = `retry:${userId}`;
    let retryCount = parseInt(await kvGetText(env, retryKey) || "0");

    if (retryCount > CONFIG.MAX_RETRY_ATTEMPTS) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: USER_NOTIFICATIONS.retry_limit
        });
        await kvDelete(env, retryKey);
        return;
    }

    if (!rec || !rec.thread_id) {
        rec = await getOrCreateUserTopicRec(msg.from, key, env, userId);
        if (!rec || !rec.thread_id) {
            throw new Error(ERROR_MESSAGES.topic_not_found);
        }
    }

    if (rec && rec.thread_id) {
        const mappedUser = await kvGetText(env, `thread:${rec.thread_id}`);
        if (!mappedUser) {
            await kvPut(env, `thread:${rec.thread_id}`, String(userId));
        }
    }

    if (rec && rec.thread_id) {
        const cacheKey = rec.thread_id;
        const now = Date.now();
        const cached = mapGetFresh(threadHealthCache, cacheKey, CONFIG.THREAD_HEALTH_TTL_MS);
        const withinTTL = cached && (now - cached.ts < CONFIG.THREAD_HEALTH_TTL_MS);

        if (!withinTTL) {
            const kvHealthKey = `thread_ok:${rec.thread_id}`;
            const kvHealthOk = await kvGetText(env, kvHealthKey);
            if (kvHealthOk === "1") {
                mapSetBounded(threadHealthCache, cacheKey, { ts: now, ok: true }, LOCAL_CACHE_LIMITS.threadHealth);
            } else {
                const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "health_check" });

                if (probe.status === "redirected" || probe.status === "missing" || probe.status === "missing_thread_id") {
                    const verified = await kvGetText(env, `verified:${userId}`);
                    
                    if (verified) {
                        Logger.info('topic_recreating_due_to_health_check', {
                            userId,
                            oldThreadId: rec.thread_id,
                            probeStatus: probe.status
                        });
                        
                        const newRec = await handleTopicLossAndRecreate(env, {
                            userId,
                            userKey: key,
                            oldThreadId: rec.thread_id,
                            pendingMsgId: msg.message_id,
                            reason: `health_check:${probe.status}`,
                            from: msg.from
                        });
                        
                        if (newRec) {
                            rec = newRec;
                            
                            await kvDelete(env, retryKey);
                            
                            mapSetBounded(threadHealthCache, rec.thread_id, { ts: now, ok: true }, LOCAL_CACHE_LIMITS.threadHealth);
                            await kvPut(env, `thread_ok:${rec.thread_id}`, "1", { 
                                expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) 
                            });
                        } else {
                            return;
                        }
                    } else {
                        await handleTopicLossAndRecreate(env, {
                            userId,
                            userKey: key,
                            oldThreadId: rec.thread_id,
                            pendingMsgId: msg.message_id,
                            reason: `health_check:${probe.status}`,
                            from: msg.from
                        });
                        return;
                    }
                } else if (probe.status === "probe_invalid") {
                    Logger.warn('topic_health_probe_invalid_message', {
                        userId,
                        threadId: rec.thread_id,
                        errorDescription: probe.description
                    });

                    mapSetBounded(threadHealthCache, cacheKey, { ts: now, ok: true }, LOCAL_CACHE_LIMITS.threadHealth);
                    await kvPut(env, kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
                } else if (probe.status === "unknown_error") {
                    Logger.warn('topic_test_failed_unknown', {
                        userId,
                        threadId: rec.thread_id,
                        errorDescription: probe.description
                    });
                } else {
                    await kvDelete(env, retryKey);
                    mapSetBounded(threadHealthCache, cacheKey, { ts: now, ok: true }, LOCAL_CACHE_LIMITS.threadHealth);
                    await kvPut(env, kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
                }
            }
        }
    }

    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, {
            direction: "p2t",
            targetChat: env.SUPERGROUP_ID,
            threadId: rec.thread_id
        });
        return;
    }

    const res = await tgCall(env, "forwardMessage", {
        chat_id: env.SUPERGROUP_ID,
        from_chat_id: userId,
        message_id: msg.message_id,
        message_thread_id: rec.thread_id,
    });

    const resThreadId = res.result?.message_thread_id;
    if (res.ok && resThreadId !== undefined && resThreadId !== null && Number(resThreadId) !== Number(rec.thread_id)) {
        Logger.warn('forward_redirected_to_general', {
            userId,
            expectedThreadId: rec.thread_id,
            actualThreadId: resThreadId
        });

        if (res.result?.message_id) {
            try {
                await tgCall(env, "deleteMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: res.result.message_id
                });
            } catch (e) {
            }
        }
        
        const verified = await kvGetText(env, `verified:${userId}`);
        if (verified) {
            Logger.info('topic_recreating_due_to_redirect', {
                userId,
                oldThreadId: rec.thread_id,
                actualThreadId: resThreadId
            });
            
            const newRec = await handleTopicLossAndRecreate(env, {
                userId,
                userKey: key,
                oldThreadId: rec.thread_id,
                pendingMsgId: msg.message_id,
                reason: "forward_redirected_to_general",
                from: msg.from
            });
            
            if (newRec) {
                await tgCall(env, "forwardMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    from_chat_id: userId,
                    message_id: msg.message_id,
                    message_thread_id: newRec.thread_id,
                });
            }
        } else {
            await handleTopicLossAndRecreate(env, {
                userId,
                userKey: key,
                oldThreadId: rec.thread_id,
                pendingMsgId: msg.message_id,
                reason: "forward_redirected_to_general"
            });
        }
        return;
    }

    if (res.ok && (resThreadId === undefined || resThreadId === null)) {
        const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "forward_result_missing_thread_id" });
        if (probe.status !== "ok") {
            Logger.warn('forward_suspected_redirect_or_missing', {
                userId,
                expectedThreadId: rec.thread_id,
                probeStatus: probe.status,
                probeDescription: probe.description
            });

            if (res.result?.message_id) {
                try {
                    await tgCall(env, "deleteMessage", {
                        chat_id: env.SUPERGROUP_ID,
                        message_id: res.result.message_id
                    });
                } catch (e) {
                }
            }
            
            const verified = await kvGetText(env, `verified:${userId}`);
            if (verified) {
                Logger.info('topic_recreating_due_to_missing_thread_id', {
                    userId,
                    oldThreadId: rec.thread_id,
                    probeStatus: probe.status
                });
                
                const newRec = await handleTopicLossAndRecreate(env, {
                    userId,
                    userKey: key,
                    oldThreadId: rec.thread_id,
                    pendingMsgId: msg.message_id,
                    reason: `forward_missing_thread_id:${probe.status}`,
                    from: msg.from
                });
                
                if (newRec) {
                    await tgCall(env, "forwardMessage", {
                        chat_id: env.SUPERGROUP_ID,
                        from_chat_id: userId,
                        message_id: msg.message_id,
                        message_thread_id: newRec.thread_id,
                    });
                }
            } else {
                await handleTopicLossAndRecreate(env, {
                    userId,
                    userKey: key,
                    oldThreadId: rec.thread_id,
                    pendingMsgId: msg.message_id,
                    reason: `forward_missing_thread_id:${probe.status}`
                });
            }
            return;
        }
    }

    if (!res.ok) {
        const desc = normalizeTgDescription(res.description);
        if (isTopicMissingOrDeleted(desc)) {
            Logger.warn('forward_failed_topic_missing', {
                userId,
                threadId: rec.thread_id,
                errorDescription: res.description
            });
            
            const verified = await kvGetText(env, `verified:${userId}`);
            if (verified) {
                Logger.info('topic_recreating_due_to_forward_failure', {
                    userId,
                    oldThreadId: rec.thread_id
                });
                
                const newRec = await handleTopicLossAndRecreate(env, {
                    userId,
                    userKey: key,
                    oldThreadId: rec.thread_id,
                    pendingMsgId: msg.message_id,
                    reason: "forward_failed_topic_missing",
                    from: msg.from
                });
                
                if (newRec) {
                    await tgCall(env, "forwardMessage", {
                        chat_id: env.SUPERGROUP_ID,
                        from_chat_id: userId,
                        message_id: msg.message_id,
                        message_thread_id: newRec.thread_id,
                    });
                }
            } else {
                await handleTopicLossAndRecreate(env, {
                    userId,
                    userKey: key,
                    oldThreadId: rec.thread_id,
                    pendingMsgId: msg.message_id,
                    reason: "forward_failed_topic_missing"
                });
            }
            return;
        }

        if (desc.includes("chat not found")) throw new Error(`群组ID错误: ${env.SUPERGROUP_ID}`);
        if (desc.includes("not enough rights")) throw new Error("机器人权限不足 (需 Manage Topics)");

        await tgCall(env, "copyMessage", {
            chat_id: env.SUPERGROUP_ID,
            from_chat_id: userId,
            message_id: msg.message_id,
            message_thread_id: rec.thread_id
        });
    }
}


function trustedUserKey(userId) {
    return `trusted:${userId}`;
}

async function isTrustedUser(env, userId) {
    const v = await kvGetText(env, trustedUserKey(userId), CONFIG.KV_CRITICAL_CACHE_TTL);
    return !!v;
}

async function setTrustedUser(env, userId) {
    await kvPut(env, trustedUserKey(userId), "1");
}

async function deleteTrustedUser(env, userId) {
    try {
        await kvDelete(env, trustedUserKey(userId));
    } catch (_) {}
}

async function banUser(env, userId, adminId, threadId) {
    await kvPut(env, `banned:${userId}`, "1");

    // /ban 触发时，若该用户在 /trust 白名单中，则立刻移除（并在返回消息中提示）
    const wasTrusted = !!(await kvGetText(env, trustedUserKey(userId)));
    if (wasTrusted) {
        await deleteTrustedUser(env, userId);
    }

    Logger.info('user_banned', { 
        targetUserId: userId,
        adminId,
        threadId,
        wasTrusted
    });

    return { userId, wasTrusted };
}

async function unbanUser(env, userId, adminId, threadId) {
    await kvDelete(env, `banned:${userId}`);
    Logger.info('user_unbanned', { 
        targetUserId: userId,
        adminId,
        threadId
    });
    
    return userId;
}

async function getUserInfo(env, userId) {
    try {
        const userKey = `user:${userId}`;
        const userRec = await kvGetJSON(env, userKey, null);
        
        if (userRec && userRec.title) {
            return { name: userRec.title, title: userRec.title };
        }
        
        const userRes = await tgCall(env, "getChat", { chat_id: userId });
        if (userRes.ok && userRes.result) {
            const user = userRes.result;
            const name = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 
                       (user.username ? `@${user.username}` : `User${userId}`);
            return { name, title: name };
        }
        
        return { name: `未知用户`, title: `未知用户` };
    } catch (error) {
        Logger.warn('failed_to_get_user_info', error, { userId });
        return { name: `未知用户`, title: `未知用户` };
    }
}

async function getUserKvKeys(env, userId, threadId) {
    // ⚠️ v1.4.2b：严格按“已知键模式”删除，避免用 includes(userId) 误删其他用户（例如 12 会匹配 312）
    const uid = Math.floor(Number(userId));
    const tid = (threadId === undefined || threadId === null) ? null : Math.floor(Number(threadId));
    if (!Number.isFinite(uid) || uid <= 0) return [];

    const set = new Set();
    const add = (k) => { if (k) set.add(String(k)); };

    // 用户主记录 & profile
    add(`user:${uid}`);
    add(`profile:${uid}`);

    // 验证/会话相关
    add(`verified:${uid}`);
    add(`verified_grace:${uid}`);
    add(`pending_verify:${uid}`);
    add(`verify_session:${uid}`);
    add(`retry:${uid}`);

    // 暂存队列 + 验证按钮追踪
    try { add(pendingQueueKey(uid)); } catch (_) { add(`pending_queue:${uid}`); }
    try { add(verifyPromptMsgsKey(uid)); } catch (_) { add(`verify_prompt_msgs:${uid}`); }

    // 本地题库触发限频（KV）
    add(`${LOCAL_QUIZ_TRIGGER_KEY_PREFIX}${uid}`);

    // thread 索引与健康键（仅当 caller 提供 threadId）
    if (tid && Number.isFinite(tid) && tid > 0) {
        add(`thread:${tid}`);
        add(`thread_ok:${tid}`);
    }

    return Array.from(set).map(name => ({ name }));
}



async function silentCleanUserDataAndTopic(env, userId, threadId, adminId) {
    const startTime = Date.now();
    const results = {
        kvDeleted: 0,
        kvFailed: 0,
        topicDeleted: false,
        topicDeleteError: null,
        duration: 0
    };
    
    try {
        Logger.info('silent_clean_started', {
            userId,
            threadId,
            adminId
        });
        
        // 步骤1: 清理用户KV数据
        const userKeys = await getUserKvKeys(env, userId, threadId);
        
        const batchSize = CONFIG.KV_DELETE_BATCH_SIZE;
        for (let i = 0; i < userKeys.length; i += batchSize) {
            const batch = userKeys.slice(i, i + batchSize);
            const deletePromises = batch.map(key => 
                kvDelete(env, key.name).then(() => true).catch(() => false)
            );
            
            const batchResults = await Promise.allSettled(deletePromises);
            const successfulDeletes = batchResults.filter(r => r.status === 'fulfilled' && r.value === true).length;
            const failedDeletes = batchResults.filter(r => r.status === 'fulfilled' && r.value === false).length;
            
            results.kvDeleted += successfulDeletes;
            results.kvFailed += failedDeletes;
            
            if (i + batchSize < userKeys.length) {
                await new Promise(r => setTimeout(r, CONFIG.KV_DELETE_DELAY_MS));
            }
        }
        
        // 清理内存缓存
        if (threadId) threadHealthCache.delete(threadId);
        topicCreateInFlight.delete(String(userId));
        adminStatusCache.delete(String(userId));
        
        // 步骤2: 删除话题页面
        try {
            const deleteResult = await tgCall(env, "deleteForumTopic", {
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId
            });
            
            if (deleteResult.ok) {
                results.topicDeleted = true;
                Logger.info('topic_deleted_silently', {
                    userId,
                    threadId,
                    adminId
                });
            } else {
                results.topicDeleteError = deleteResult.description;
                Logger.warn('topic_delete_failed_silently', {
                    userId,
                    threadId,
                    adminId,
                    error: deleteResult.description
                });
            }
        } catch (deleteError) {
            results.topicDeleteError = deleteError.message;
            Logger.error('topic_delete_exception_silently', deleteError, {
                userId,
                threadId,
                adminId
            });
        }
        
        results.duration = Date.now() - startTime;
        
        Logger.info('silent_clean_completed', results);
        
        return results;
    } catch (error) {
        Logger.error('silent_clean_failed', error, {
            userId,
            threadId,
            adminId
        });
        
        results.duration = Date.now() - startTime;
        results.error = error.message;
        
        return results;
    }
}

async function handleAdminReply(msg, env, ctx) {
    const threadId = msg.message_thread_id;
    const text = (msg.text || "").trim();
    const senderId = msg.from?.id;

    if (!senderId || !(await isAdminUser(env, senderId))) {
        return;
    }

    // v1.4.2b：处理“编辑垃圾消息规则”会话（仅允许：回复提示消息）
    try {
        const sessKey = `${SPAM_RULES_EDIT_SESSION_KEY_PREFIX}${senderId}`;
        const sess = await kvGetJSON(env, sessKey, null, {});
        if (sess && sess.prompt_message_id) {
            const chatId = msg.chat?.id || env.SUPERGROUP_ID;
            const curThread = (threadId === undefined || threadId === null) ? null : Number(threadId);
            const sessThread = (sess.thread_id === undefined || sess.thread_id === null) ? null : Number(sess.thread_id);

            const sameChat = (sess.chat_id === undefined || sess.chat_id === null) ? true : (Number(sess.chat_id) === Number(chatId));
            const isReplyMatch = !!(msg.reply_to_message && msg.reply_to_message.message_id &&
                Number(sess.prompt_message_id) === Number(msg.reply_to_message.message_id));
            const sameThread = (sessThread === null) ? true : (curThread !== null && Number(curThread) === Number(sessThread));

            if (sameChat && isReplyMatch) {
                if (!msg.text) {
                    await tgCall(env, "sendMessage", withMessageThreadId({
                        chat_id: chatId,
                        message_thread_id: threadId,
                        text: "❌ 请发送纯文本规则（支持多行），或发送“恢复默认”。"
                    }, (curThread && Number(curThread) !== 1) ? curThread : null));
                    return;
                }

let rawPrompt = (msg.text || "").replace(/\u200b/g, "").trim();

                // 一键恢复默认规则
                const resetDefaults = /^(恢复默认|默认|reset_defaults|reset|default)$/i.test(rawPrompt);
                if (resetDefaults) rawPrompt = "";

                // “清空默认”：允许放在任意一行（从空规则开始，不继承默认）
                const promptLines = rawPrompt ? rawPrompt.split(/\r?\n/) : [];
                const clearDefaults = promptLines.some(l => /^(清空默认|clear_defaults)$/i.test(String(l).trim()));

                // 存储用的提示词：去掉“清空默认”这一类控制行，避免把它当成规则内容展示
                const promptToStore = clearDefaults
                    ? promptLines.filter(l => !/^(清空默认|clear_defaults)$/i.test(String(l).trim())).join("\n").trim()
                    : rawPrompt;

                // 保存提示词（可为空：表示恢复默认规则）
                await setGlobalSpamFilterRulesPrompt(env, promptToStore);
                // 把提示词解析成 JSON 规则并保存
                // 追加模式：以当前已生效规则为 base，新的提交会合并/追加（不会删除旧项）
                const currentRules = await getGlobalSpamFilterRules(env);

                let saved;
                try {
                    const derivedRules = resetDefaults
                        ? sanitizeSpamRules(DEFAULT_SPAM_RULES)
                        : promptToSpamRules(rawPrompt, currentRules);
                    saved = await setGlobalSpamFilterRules(env, derivedRules);
                } catch (err) {
                    // 保存失败：给管理员反馈，但不清理会话，方便继续回复修正
                    const feedbackChatId = (sess.chat_id ? Number(sess.chat_id) : (msg.chat?.id || env.SUPERGROUP_ID));
                    const feedbackThreadId = ((curThread && Number(curThread) !== 1) ? curThread : ((sessThread && Number(sessThread) !== 1) ? sessThread : null));
                    await tgCall(env, "sendMessage", withMessageThreadId({
                        chat_id: feedbackChatId,
                        message_thread_id: feedbackThreadId,
                        text: `❌ 保存失败：${err?.message || "unknown error"}

请再次回复那条提示消息，发送修正后的规则文本；或回复“恢复默认”。`,
                        reply_to_message_id: msg.message_id
                    }, feedbackThreadId));
                    return;
                }

                // 清理会话
                await kvDelete(env, sessKey);

                // 给管理员反馈：展示完整规则（纯文本，不使用 Markdown）
                // 关键词/正则尽量按“多项一行”展示，避免一项一行过长。
                const formatInlineList = (arr, { sep = "、", maxLineLen = 120 } = {}) => {
                    const a = Array.isArray(arr) ? arr.filter(Boolean).map(x => String(x).trim()).filter(Boolean) : [];
                    if (!a.length) return "（无）";

                    const lines = [];
                    let cur = "";
                    for (const item of a) {
                        const next = cur ? (cur + sep + item) : item;
                        if (next.length > maxLineLen && cur) {
                            lines.push(cur);
                            cur = item;
                        } else if (next.length > maxLineLen && !cur) {
                            // 单项本身就很长：直接单独一行
                            lines.push(item);
                            cur = "";
                        } else {
                            cur = next;
                        }
                    }
                    if (cur) lines.push(cur);
                    return lines.join("\n");
                };
                const splitTelegramText = (t, maxLen = 4096) => {
                    const s = String(t || "");
                    if (s.length <= maxLen) return [s];
                    const lines = s.split(/\n/);
                    const parts = [];
                    let cur = "";
                    for (const line of lines) {
                        const next = cur ? (cur + "\n" + line) : line;
                        if (next.length > maxLen) {
                            if (cur) parts.push(cur);
                            if (line.length > maxLen) {
                                // 极端长行：硬切
                                for (let i = 0; i < line.length; i += maxLen) {
                                    parts.push(line.slice(i, i + maxLen));
                                }
                                cur = "";
                            } else {
                                cur = line;
                            }
                        } else {
                            cur = next;
                        }
                    }
                    if (cur) parts.push(cur);
                    return parts;
                };

                const detailLines = [
                    "✅ 已保存垃圾消息规则，立即生效。",
                    "",
                    `max_links=${saved.max_links}`,
                    "",
                    `block_keywords (${(saved.keywords || []).length}):`,
                    formatInlineList(saved.keywords),
                    "",
                    `allow_keywords (${(saved.allow_keywords || []).length}):`,
                    formatInlineList(saved.allow_keywords),
                    "",
                    `block_regexes (${(saved.regexes || []).length}):`,
                    formatInlineList(saved.regexes, { sep: " | ", maxLineLen: 140 }),
                    "",
                    `allow_regexes (${(saved.allow_regexes || []).length}):`,
                    formatInlineList(saved.allow_regexes, { sep: " | ", maxLineLen: 140 }),
                ];

                const fullText = detailLines.join("\n");

                const feedbackChatId = (sess.chat_id ? Number(sess.chat_id) : (msg.chat?.id || env.SUPERGROUP_ID));
                const feedbackThreadId = ((curThread && Number(curThread) !== 1) ? curThread : ((sessThread && Number(sessThread) !== 1) ? sessThread : null));

                const parts = splitTelegramText(fullText, 4096);

                for (let i = 0; i < parts.length; i++) {
                    await tgCall(env, "sendMessage", withMessageThreadId({
                        chat_id: feedbackChatId,
                        message_thread_id: feedbackThreadId,
                        text: parts[i],
                        ...(i === 0 ? { reply_to_message_id: msg.message_id } : {})
                    }, feedbackThreadId));
                }

                // 删除那条“巨长的规则编辑提示消息”
                try {
                    if (sess.chat_id && sess.prompt_message_id) {
                        await tgCall(env, "deleteMessage", {
                            chat_id: Number(sess.chat_id),
                            message_id: Number(sess.prompt_message_id)
                        });
                    }
                } catch (_) {}

                return;

            } else if (sameChat && sameThread && msg.text && !text.startsWith("/")) {
                // 规则编辑：必须“回复提示消息”触发（不要在同一话题里直接发送规则文本）
                await tgCall(env, "sendMessage", withMessageThreadId({
                    chat_id: chatId,
                    message_thread_id: threadId,
                    text: "❌ 请回复那条“编辑垃圾消息规则”提示消息提交规则（不要在话题里直接发送）。",
                    reply_to_message_id: msg.message_id
                }, (curThread && Number(curThread) !== 1) ? curThread : null));
                return;

            } else if (msg.reply_to_message && msg.reply_to_message.message_id) {
                // 只有当“确实在回复某条消息，但不是那条提示消息/不在同话题”时才提示，避免打扰
                await tgCall(env, "sendMessage", withMessageThreadId({
                    chat_id: chatId,
                    message_thread_id: threadId,
                    text: "❌ 请在同一话题下回复那条“编辑垃圾消息规则”提示消息提交规则。"
                }, (curThread && Number(curThread) !== 1) ? curThread : null));
                return;
            }
        }
    } catch (e) {
        Logger.warn('spam_rules_edit_session_failed', e, { adminId: senderId });
    }

    const command = extractCommand(text);
    const args = extractCommandArgs(text);
    
    // 如果不是命令消息，并且机器人已关闭，且是在用户话题中（threadId存在且不为1）
    if (!command && threadId && threadId !== 1) {
        const botEnabled = await isBotEnabled(env);
        if (!botEnabled) {
            // 发送错误提示，告知机器人已关闭
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.bot_closed_reply,
                parse_mode: "Markdown"
            }, threadId));
            
            Logger.info('admin_reply_blocked_bot_disabled', {
                adminId: senderId,
                threadId,
                messageId: msg.message_id
            });
            return; // 阻止消息转发
        }
    }

    if (command === "help") {
        const helpText = `⚙️ 版本: ${BOT_VERSION}\n` +
		                 `📖 **使用说明**\n` +                 
                         `💡 所有指令均不会被转发到用户私聊\n\n` +
                         `/help 显示使用说明\n` +
                         `/trust 将当前用户加入白名单，加入白名单的用户可以绕过垃圾消息识别，并且永不再需要进行人机验证，若对黑名单用户使用将自动移除黑名单\n` +
                         `/ban 封禁用户，可加用户ID，例如/ban 或/ban 123456，若对白名单用户使用将自动移除白名单\n` +
                         `/unban 解封用户，可加用户ID，例如/unban 或/unban 123456\n` +
                         `/blacklist 查看黑名单\n` +
                         `/info 查看当前用户信息\n` +
                         `/settings 打开设置面板\n` +
                         `/clean ⚠️ 危险操作：删除当前话题用户的所有数据，将会删除该用户话题，清空该用户的聊天记录，并重置他的人机验证，但不会改变该用户的封禁状态或白名单状态`;


        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: helpText,
            parse_mode: "Markdown"
        }, threadId));
        return;
    }

if (command === "settings") {
        const adminId = msg.from?.id;
        if (!adminId || !(await isAdminUser(env, adminId))) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.admin_only,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }

        // 仅允许在 General 话题中使用
        if (threadId && threadId !== 1) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.settings_command_error,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }

        const botEnabled = await isBotEnabled(env);
        const panel = await buildSettingsPanel(env, adminId, botEnabled);

        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: panel.text,
            parse_mode: "Markdown",
            reply_markup: panel.reply_markup
        }, threadId));

        return;
    }

    if (command === "trust") {
        const adminId = msg.from?.id;
        if (!adminId || !(await isAdminUser(env, adminId))) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.admin_only
            }, threadId));
            return;
        }

        // 仅允许在用户话题中使用（General 话题的 message_thread_id 可能缺失或为 1；这里必须确保报错能显示在 General）


        if (!threadId || Number(threadId) === 1) {


            await tgCall(env, "sendMessage", withMessageThreadId({


                chat_id: env.SUPERGROUP_ID,


                text: ERROR_MESSAGES.trust_command_error


            }, null)); // null => 不传 message_thread_id，确保落在 General


            return;


        }
// 解析该话题对应的用户 ID
        let userId = null;
        const mappedUser = await kvGetText(env, `thread:${threadId}`);
        if (mappedUser) {
            userId = Number(mappedUser);
        } else {
            userId = await resolveUserIdByThreadId(env, threadId);
        }

        if (!userId) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: "❌ 找不到用户\n\n无法确定该话题对应的用户，请确认该话题是否为用户话题。"
                }, threadId));
            return;
        }


        // v1.5.3b：若该用户已在黑名单中，/trust 需自动解除封禁（白名单优先）
        let wasBanned = false;
        try {
            wasBanned = !!(await kvGetText(env, `banned:${userId}`));
            if (wasBanned) {
                await unbanUser(env, userId, adminId, threadId);
            }
        } catch (_) {}


        await setTrustedUser(env, userId);

        // best-effort：清理该用户的验证状态，让其立即生效
        try {
            await kvDelete(env, `pending_verify:${userId}`);
            await kvDelete(env, `verify_session:${userId}`);
            await kvDelete(env, `verified_grace:${userId}`);
        } catch (_) {}

        const userInfo = await getUserInfo(env, userId);
        const unbanNote = wasBanned ? "\n\n🟢 已自动解除黑名单状态" : "";

        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: `✅ 已加入白名单

用户: ${userInfo.name}
用户ID: ${userId}${unbanNote}

该用户后续发送的任何消息都将绕过垃圾消息识别，并且永不再需要人机验证。`
        }, threadId));

        Logger.info('trust_user_added', { adminId, userId, threadId });
        return;
    }



    if (command === "off") {
        const adminId = msg.from?.id;
        if (!adminId || !(await isAdminUser(env, adminId))) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.admin_only,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        if (threadId && threadId !== 1) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.off_command_error,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        const botEnabled = await isBotEnabled(env);
        if (!botEnabled) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.already_closed,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        await setBotEnabled(env, false);
        
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: "⛔ **私聊机器人已关闭**\n\n用户将无法使用机器人，管理员也无法通过机器人回复用户，直到重新开启。",
            parse_mode: "Markdown"
        }, threadId));
        
        Logger.info('bot_closed_by_admin', { adminId });
        return;
    }
    
    if (command === "on") {
        const adminId = msg.from?.id;
        if (!adminId || !(await isAdminUser(env, adminId))) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.admin_only,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        if (threadId && threadId !== 1) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.on_command_error,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        const botEnabled = await isBotEnabled(env);
        if (botEnabled) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.already_opened,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        await setBotEnabled(env, true);
        
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: "✅ **私聊机器人已开启**\n\n用户可以继续使用机器人，管理员也可以通过机器人回复用户。",
            parse_mode: "Markdown"
        }, threadId));
        
        Logger.info('bot_opened_by_admin', { adminId });
        return;
    }

    if (command === "clean") {
        const adminId = msg.from?.id;
        if (!adminId || !(await isAdminUser(env, adminId))) {
            return; // 静默失败，不发送消息
        }
        
        if (!threadId || threadId === 1) {
            // 在 General 话题下使用时返回错误提示
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.clean_command_error,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        Logger.info('clean_command_triggered_silent', { 
            adminId, 
            threadId 
        });
        
        const userId = await resolveUserIdByThreadId(env, threadId);

if (!userId) {
            return; // 静默失败，不发送消息
        }

        // 二次确认：发送“是/否”按钮（60秒内有效）
        try {
            const now = Math.floor(Date.now() / 1000);
            const exp = now + 60;

            const signSecret = (env.VERIFY_SIGNING_SECRET || env.CF_TURNSTILE_SECRET_KEY || env.BOT_TOKEN || "").toString();
            const sig = signSecret ? await signCleanConfirmToken(signSecret, adminId, userId, threadId, exp) : "0";

            const yesData = `cY|${threadId}|${userId}|${adminId}|${exp}|${sig}`;
            const noData  = `cN|${threadId}|${userId}|${adminId}|${exp}|${sig}`;

            // callback_data 1-64 bytes；极端情况下兜底降级（仍会做管理员校验 + 过期校验）
            const safeYes = (yesData.length <= 64) ? yesData : `cY|${threadId}|${userId}|${adminId}|${exp}|0`;
            const safeNo  = (noData.length <= 64) ? noData  : `cN|${threadId}|${userId}|${adminId}|${exp}|0`;

            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
	                text: `⚠️ *危险操作确认*\n\n这将删除该用户的话题和所有聊天记录，并重置他的人机验证，用户的封禁状态或白名单状态不会受到影响。\n\n用户ID：\`${userId}\`\n话题ID：\`${threadId}\`\n\n请在 60 秒内选择：\n\n⏳ 超时60秒后自动取消操作`,
	                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [[
                        { text: "是", callback_data: safeYes },
                        { text: "否", callback_data: safeNo }
                    ]]
                }
            }, threadId));
        } catch (e) {
            Logger.error('clean_confirm_prompt_failed', e, { adminId, userId, threadId });
            // 失败时保持静默，避免刷屏
        }

        return;

    }
    
    if (command === "info") {
        const adminId = msg.from?.id;
        if (!adminId || !(await isAdminUser(env, adminId))) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.admin_only
}, threadId));
            return;
        }
        
        if (!threadId || threadId === 1) {
            // 在 General 话题下使用时返回错误提示
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.info_command_error
}, threadId));
            return;
        }
        
        // 获取用户ID
        let userId = null;
        const mappedUser = await kvGetText(env, `thread:${threadId}`);
        if (mappedUser) {
            userId = Number(mappedUser);
        } else {
            userId = await resolveUserIdByThreadId(env, threadId);
}

        if (!userId) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: "❌ 找不到用户\n\n无法确定该话题对应的用户。"
}, threadId));
            return;
        }
        const userKey = `user:${userId}`;
        const userRec = await kvGetJSON(env, userKey, null);
        const verifyStatus = await kvGetText(env, `verified:${userId}`);
        const banStatus = await kvGetText(env, `banned:${userId}`);
        const trustedStatus = await isTrustedUser(env, userId);

        const info = `👤 用户信息
UID: ${userId}
Topic ID: ${threadId}
话题标题: ${userRec?.title || "未知"}
验证状态: ${verifyStatus ? '✅ 已验证' : '❌ 未验证'}
封禁状态: ${banStatus ? '🚫 已封禁' : '✅ 正常'}
白名单用户: ${trustedStatus ? '✅ 是' : '❌ 否'}`;

        await tgCall(env, "sendMessage"
, withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: info,
            reply_markup: {
                inline_keyboard: [[{ text: "点击私聊", url: `tg://user?id=${userId}` }]]
            }
        }, threadId));
        return;
    }
    
    if (command === "blacklist") {
        const adminId = msg.from?.id;
        if (!adminId || !(await isAdminUser(env, adminId))) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.admin_only,}, threadId));
            return;
        }
        
        Logger.info('blacklist_command_triggered', { adminId, threadId });
        
        const processingMsg = await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: "📋 正在获取黑名单列表...\n\n可能需要几秒钟时间获取用户信息。",}, threadId));
        
        try {
            const bannedKeys = await getAllKeys(env, "banned:", CONFIG.KV_OPERATION_MAX_ITEMS);
            
            if (bannedKeys.length === 0) {
                await tgCall(env, "editMessageText", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: processingMsg.result.message_id,
                    text: "📋 黑名单列表\n\n当前黑名单为空，没有封禁的用户。",});
                return;
            }
            
            const bannedUserIds = bannedKeys
                .map(key => {
                    const match = key.name.match(/^banned:(\d+)$/);
                    return match ? match[1] : null;
                })
                .filter(id => id !== null)
                .sort((a, b) => parseInt(a) - parseInt(b));
            
            if (bannedUserIds.length === 0) {
                await tgCall(env, "editMessageText", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: processingMsg.result.message_id,
                    text: "📋 黑名单列表\n\n未找到有效的黑名单用户ID。",});
                return;
            }
            
            let message = `📋 黑名单列表\n`;
            message += `总计: ${bannedUserIds.length} 个用户\n\n`;
            
            const displayLimit = 20;
            const displayIds = bannedUserIds.slice(0, displayLimit);
            const hasMore = bannedUserIds.length > displayLimit;
            
            const userInfoPromises = displayIds.map(async (userId) => {
                try {
                    // 1) 用户话题记录（可能存在 title）
                    const userKey = `user:${userId}`;
                    const userRec = await kvGetJSON(env, userKey, null);

                    // 2) 用户资料缓存（仅来自已收到的 Update，不做任何 Telegram API 拉取）
                    const profile = await kvGetJSON(env, `profile:${userId}`, null);

                    const displayName = (() => {
                        const n = `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim();
                        if (n) return n;
                        if (userRec && userRec.title) return userRec.title;
                        return "未知用户";
                    })();

                    const uname = (profile && profile.username) ? `@${profile.username}` : "未知";
                    return `• ${displayName} (${uname}) ${userId}`;
                } catch (error) {
                    Logger.warn('failed_to_get_user_info_for_blacklist', error, { userId });
                    return `• 未知用户 (未知) ${userId}`;
                }
            });

            const userInfos = await Promise.all(userInfoPromises);
            
            message += `黑名单用户:\n`;
            message += userInfos.join('\n');
            
            if (hasMore) {
                const remaining = bannedUserIds.length - displayLimit;
                message += `\n\n... 还有 ${remaining} 个用户未显示`;
            }

            
            if (message.length > 4096) {
                const simplifiedMessage = `📋 黑名单列表\n总计: ${bannedUserIds.length} 个用户\n\n用户ID列表:\n${bannedUserIds.slice(0, 30).join(' ')}\n\n${hasMore ? `... 还有 ${bannedUserIds.length - 30} 个用户未显示` : ''}`;
                
                await tgCall(env, "editMessageText", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: processingMsg.result.message_id,
                    text: simplifiedMessage.length > 4096 ? simplifiedMessage.substring(0, 4093) + "..." : simplifiedMessage,});
            } else {
                await tgCall(env, "editMessageText", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: processingMsg.result.message_id,
                    text: message,});
            }
            
            Logger.info('blacklist_command_completed', { 
                adminId, 
                threadId, 
                count: bannedUserIds.length,
                displayed: Math.min(bannedUserIds.length, displayLimit)
            });
            
        } catch (error) {
            Logger.error('blacklist_command_failed', error, { adminId, threadId });
            
            await tgCall(env, "editMessageText", {
                chat_id: env.SUPERGROUP_ID,
                message_id: processingMsg.result.message_id,
                text: "❌ 获取黑名单列表时发生错误\n\n请检查日志或稍后重试。",});
        }
        return;
    }
    
    if (command === "ban") {
        const adminId = msg.from?.id;
        if (!adminId || !(await isAdminUser(env, adminId))) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.admin_only
}, threadId));
            return;
        }
        
        if (args) {
            const argStr = String(args).trim();
            const targetUserId = (/^\d+$/.test(argStr)) ? Number(argStr) : NaN;
            if (isNaN(targetUserId)) {
                await tgCall(env, "sendMessage", withMessageThreadId({
                    chat_id: env.SUPERGROUP_ID,
                    message_thread_id: threadId,
                    text: "❌ 参数错误\n\n请提供有效的用户ID，例如：/ban 123456"
}, threadId));
                return;
            }
            
            if (targetUserId === adminId) {
                await tgCall(env, "sendMessage", withMessageThreadId({
                    chat_id: env.SUPERGROUP_ID,
                    message_thread_id: threadId,
                    text: "❌ 无法操作\n\n不能封禁自己。"
}, threadId));
                return;
            }
            
            const isTargetInAdminWhitelist = isUserInAdminWhitelist(env, targetUserId);
            if (isTargetInAdminWhitelist) {
                await tgCall(env, "sendMessage", withMessageThreadId({
                    chat_id: env.SUPERGROUP_ID,
                    message_thread_id: threadId,
                    text: "❌ 无法操作\n\n不能封禁管理员白名单中的用户。"
}, threadId));
                return;
            }
            
            
            const alreadyBanned = await kvGetText(env, `banned:${targetUserId}`);
            if (alreadyBanned) {
                const userInfo = await getUserInfo(env, targetUserId);
                await tgCall(env, "sendMessage", withMessageThreadId({
                    chat_id: env.SUPERGROUP_ID,
                    message_thread_id: threadId,
                    text: `⚠️ 用户已封禁\n\n用户: ${userInfo.name}\n用户ID: ${targetUserId}\n\n该用户已在黑名单中，无需重复封禁。`
                }, threadId));
                return;
            }
const userInfo = await getUserInfo(env, targetUserId);
            
            const banRes = await banUser(env, targetUserId, adminId, threadId);
            const extraNote = (banRes && banRes.wasTrusted) ? "\n\n🔴 已自动解除白名单状态" : "";
            
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: `🚫 用户已封禁

用户: ${userInfo.name}
用户ID: ${targetUserId}${extraNote}`
}, threadId));
            
            Logger.info('ban_with_param_completed', {
                adminId,
                targetUserId,
                threadId,
                userName: userInfo.name
            });
            return;
        }
        
        if (!threadId || threadId === 1) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: "❌ 缺少参数\n\n在General话题中，请指定要封禁的用户ID，例如：/ban 123456"
}, threadId));
            return;
        }
        
        let userId = null;
        const mappedUser = await kvGetText(env, `thread:${threadId}`);
        if (mappedUser) {
            userId = Number(mappedUser);
        } else {
            userId = await resolveUserIdByThreadId(env, threadId);
}

        if (!userId) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: "❌ 找不到用户\n\n无法确定该话题对应的用户，请使用 /ban 用户ID 格式手动封禁。"
}, threadId));
            return;
        }
        
        if (userId === adminId) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: "❌ 无法操作\n\n不能封禁自己。"
}, threadId));
            return;
        }
        
        const isTargetInAdminWhitelist = isUserInAdminWhitelist(env, userId);
        if (isTargetInAdminWhitelist) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: "❌ 无法操作\n\n不能封禁管理员白名单中的用户。"
}, threadId));
            return;
        }
        
        
        const alreadyBanned = await kvGetText(env, `banned:${userId}`);
        if (alreadyBanned) {
            const userInfo = await getUserInfo(env, userId);
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: `⚠️ 用户已封禁\n\n用户: ${userInfo.name}\n用户ID: ${userId}\n\n该用户已在黑名单中，无需重复封禁。`
            }, threadId));
            return;
        }
const userInfo = await getUserInfo(env, userId);
        
        const banRes = await banUser(env, userId, adminId, threadId);
        const extraNote = (banRes && banRes.wasTrusted) ? "\n\n已将该用户移除白名单" : "";
        
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: `🚫 用户已封禁

用户: ${userInfo.name}
用户ID: ${userId}${extraNote}`
}, threadId));
        
        Logger.info('ban_without_param_completed', {
            adminId,
            targetUserId: userId,
            threadId,
            userName: userInfo.name
        });
        return;
    }
    
    if (command === "unban") {
        const adminId = msg.from?.id;
        if (!adminId || !(await isAdminUser(env, adminId))) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.admin_only
}, threadId));
            return;
        }
        
        if (args) {
            const argStr = String(args).trim();
            const targetUserId = (/^\d+$/.test(argStr)) ? Number(argStr) : NaN;
            if (isNaN(targetUserId)) {
                await tgCall(env, "sendMessage", withMessageThreadId({
                    chat_id: env.SUPERGROUP_ID,
                    message_thread_id: threadId,
                    text: "❌ 参数错误\n\n请提供有效的用户ID，例如：/unban 123456"
}, threadId));
                return;
            }
            
            const isBanned = await kvGetText(env, `banned:${targetUserId}`);
            if (!isBanned) {
                await tgCall(env, "sendMessage", withMessageThreadId({
                    chat_id: env.SUPERGROUP_ID,
                    message_thread_id: threadId,
                    text: `⚠️ 用户未封禁\n\n用户ID: ${targetUserId} 不在封禁列表中。`
}, threadId));
                return;
            }
            
            const userInfo = await getUserInfo(env, targetUserId);
            
            await unbanUser(env, targetUserId, adminId, threadId);
            
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: `✅ 用户已解封\n\n用户: ${userInfo.name}\n用户ID: ${targetUserId}`
}, threadId));
            
            Logger.info('unban_with_param_completed', {
                adminId,
                targetUserId,
                threadId,
                userName: userInfo.name
            });
            return;
        }
        
        if (!threadId || threadId === 1) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: "❌ 缺少参数\n\n在General话题中，请指定要解封的用户ID，例如：/unban 123456"
}, threadId));
            return;
        }
        
        let userId = null;
        const mappedUser = await kvGetText(env, `thread:${threadId}`);
        if (mappedUser) {
            userId = Number(mappedUser);
        } else {
            userId = await resolveUserIdByThreadId(env, threadId);
}

        if (!userId) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: "❌ 找不到用户\n\n无法确定该话题对应的用户，请使用 /unban 用户ID 格式手动解封。"
}, threadId));
            return;
        }
        
        const isBanned = await kvGetText(env, `banned:${userId}`);
        if (!isBanned) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: `⚠️ 用户未封禁\n\n用户ID: ${userId} 不在封禁列表中。`
}, threadId));
            return;
        }
        
        const userInfo = await getUserInfo(env, userId);
        
        await unbanUser(env, userId, adminId, threadId);
        
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: `✅ 用户已解封\n\n用户: ${userInfo.name}\n用户ID: ${userId}`
}, threadId));
        
        Logger.info('unban_without_param_completed', {
            adminId,
            targetUserId: userId,
            threadId,
            userName: userInfo.name
        });
        return;
    }
    
    if (command === "resetkv") {
        const adminId = msg.from?.id;
        if (!adminId || !(await isAdminUser(env, adminId))) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.admin_only,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        if (threadId && threadId !== 1) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: "❌ **命令使用错误**\n\n`/resetkv` 命令只能在 General 话题中使用。",
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        await kvDelete(env, `reset_session:${adminId}`);
        
        const sessionData = {
            adminId,
            timestamp: Date.now(),
            threadId,
            confirmed: false,
            resetType: "all_chats"
        };
        
        await kvPut(env, `reset_session:${adminId}`, JSON.stringify(sessionData), {
            expirationTtl: 60
        });
        
        const confirmationText = `⚠️ **危险操作：清空并重置所有聊天数据**\n\n` +
                                `**这将执行:**\n` +
                                `• 删除所有用户的聊天记录\n` +
                                `• 重置所有用户的数据（黑名单、白名单、垃圾消息规则数据除外）
` +
                                `**影响：**\n` +
                                `• 所有聊天记录将会丢失\n` +
                                `• 非白名单用户需要重新验证\n\n` +
                                `**确认执行？**\n` +
                                `发送 \`/reset_confirm\` 继续操作\n` +
                                `或发送 \`/cancel\` 取消操作\n\n⏳ 超时60秒后自动取消操作`;
        
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: confirmationText,
            parse_mode: "Markdown"
        }, threadId));
        return;
    }

    if (command === "reset_confirm") {
        const adminId = msg.from?.id;
        if (!adminId || !(await isAdminUser(env, adminId))) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.admin_only,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        if (threadId && threadId !== 1) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: "❌ **命令使用错误**\n\n`/reset_confirm` 命令只能在 General 话题中使用。",
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        const sessionKey = `reset_session:${adminId}`;
        const sessionData = await kvGetJSON(env, sessionKey, null, {});
        
        if (!sessionData) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.reset_not_triggered,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        const sessionAge = Date.now() - sessionData.timestamp;
        if (sessionAge > 1 * 60 * 1000) {
            await kvDelete(env, sessionKey);
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.reset_session_expired,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        if (sessionData.adminId !== adminId) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.reset_admin_mismatch,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }
        
        const resetLockKey = "resetkv:lock";
        const resetLock = await kvGetText(env, resetLockKey);
        if (resetLock) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.reset_in_progress,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }

        await kvPut(env, resetLockKey, "1", { 
            expirationTtl: 1800
        });

        await kvDelete(env, sessionKey);

        const resetType = (sessionData && sessionData.resetType) ? String(sessionData.resetType) : "all_chats";

        await logResetOperation(env, adminId, threadId);

        if (resetType === "blacklist") {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: `🔄 **开始重置黑名单...**

请稍候...`,
                parse_mode: "Markdown"
            }, threadId));

            ctx.waitUntil((async () => {
                try {
                    const blResults = await resetBlacklistStorage(env, threadId, adminId);

                    let finalReport = `✅ **重置黑名单完成**

`;
                    finalReport += `👤 **操作员**: ${adminId}

`;
                    finalReport += `🧹 **黑名单清理结果**
`;
                    finalReport += `• 删除的黑名单项: ${blResults.totalDeleted}
`;
                    finalReport += `• 处理的KV数量: ${blResults.processedKeysCount}
`;
                    finalReport += `• 操作耗时: ${blResults.duration} 秒

`;
                    finalReport += `💡 **提示**
`;
                    finalReport += `• ✅ 黑名单已清空
`;
                    finalReport += `• ⚠️ 如需继续限制用户，请重新拉黑
`;

                    await tgCall(env, "sendMessage", withMessageThreadId({
                        chat_id: env.SUPERGROUP_ID,
                        message_thread_id: threadId,
                        text: finalReport,
                        parse_mode: "Markdown"
                    }, threadId));

                    Logger.info('reset_blacklist_completed_v6_9_13g', {
                        adminId,
                        threadId,
                        blResults
                    });
                } catch (error) {
                    Logger.error('reset_blacklist_operation_failed', error, { adminId, threadId });

                    await tgCall(env, "sendMessage", withMessageThreadId({
                        chat_id: env.SUPERGROUP_ID,
                        message_thread_id: threadId,
                        text: `❌ **重置黑名单失败**

错误信息: \`${error.message}\`

请检查日志或稍后重试。`,
                        parse_mode: "Markdown"
                    }));
                } finally {
                    await kvDelete(env, resetLockKey);
                    Logger.debug('resetkv_lock_released', { adminId, threadId });
                }
            })());

            return;
        }

        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: `🔄 **开始重置所有聊天...**

**步骤1: 删除所有用户话题**
请稍候...`,
            parse_mode: "Markdown"
        }, threadId));

        ctx.waitUntil((async () => {
            try {
                const topicDeletionResults = await deleteAllUserTopics(env, threadId, adminId);

                // 第二步，重置KV存储
                const kvResults = await resetKVStorage(env, threadId, adminId);

                let finalReport = `✅ **重置操作完成**

`;
                finalReport += `👤 **操作员**: ${adminId}

`;
                finalReport += `🗑️ **话题删除结果**
`;
                finalReport += `• 找到话题: ${topicDeletionResults.totalTopics}
`;
                finalReport += `• 成功删除: ${topicDeletionResults.deletedTopics}
`;
                finalReport += `• 删除失败: ${topicDeletionResults.failedTopics}

`;
                finalReport += `📊 **数据清理结果**
`;
                finalReport += `• 处理的KV数量: ${kvResults.processedKeysCount}
`;
                finalReport += `• 操作耗时: ${kvResults.duration} 秒

`;
                finalReport += `💡 **系统状态**
`;
                finalReport += `• ✅ 用户话题已删除
`;
                finalReport += `• ✅ 聊天数据已清空
`;
                finalReport += `• 🔄 所有用户需要重新验证
`;
                finalReport += `• 🔄 新用户会创建新话题
`;

                await tgCall(env, "sendMessage", withMessageThreadId({
                    chat_id: env.SUPERGROUP_ID,
                    message_thread_id: threadId,
                    text: finalReport,
                    parse_mode: "Markdown"
                }, threadId));

                Logger.info('resetkv_completed_v5_4_1', {
                    adminId,
                    threadId,
                    topicDeletionResults,
                    kvResults
                });
            } catch (error) {
                Logger.error('resetkv_operation_failed', error, { adminId, threadId });

                await tgCall(env, "sendMessage", withMessageThreadId({
                    chat_id: env.SUPERGROUP_ID,
                    message_thread_id: threadId,
                    text: `❌ **重置操作失败**

错误信息: \`${error.message}\`

请检查日志或稍后重试。`,
                    parse_mode: "Markdown"
                }));
            } finally {
                await kvDelete(env, resetLockKey);
                Logger.debug('resetkv_lock_released', { adminId, threadId });
            }
        })());

        return;
    }

    if (command === "cancel") {
        const adminId = msg.from?.id;
        if (!adminId || !(await isAdminUser(env, adminId))) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.admin_only,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }

        if (threadId && threadId !== 1) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: "❌ **命令使用错误**\n\n`/cancel` 命令只能在 General 话题中使用。",
                parse_mode: "Markdown"
            }, threadId));
            return;
        }

        const sessionKey = `reset_session:${adminId}`;
        const sessionData = await kvGetJSON(env, sessionKey, null, {});

        if (!sessionData) {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.reset_not_triggered,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }

        const sessionAge = Date.now() - sessionData.timestamp;
        if (sessionAge > 1 * 60 * 1000) {
            await kvDelete(env, sessionKey);
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                message_thread_id: threadId,
                text: ERROR_MESSAGES.reset_session_expired,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }

        await kvDelete(env, sessionKey);

        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: "❌ **操作已取消**",
            parse_mode: "Markdown"
        }, threadId));
        return;
    }


    if (!threadId) {
        return;
    }

    let userId = null;
    const mappedUser = await kvGetText(env, `thread:${threadId}`);
    if (mappedUser) {
        userId = Number(mappedUser);
    } else {
        userId = await resolveUserIdByThreadId(env, threadId);
}

    if (!userId) return; 

    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: undefined });
        return;
    }
    await tgCall(env, "copyMessage", { chat_id: userId, from_chat_id: env.SUPERGROUP_ID, message_id: msg.message_id });
}

// ---------------- 其他辅助函数 ----------------

async function createTopic(from, key, env, userId) {
    const title = buildTopicTitle(from);
    if (!env.SUPERGROUP_ID.toString().startsWith("-100")) throw new Error("SUPERGROUP_ID必须以-100开头");
    const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
    if (!res.ok) throw new Error(`创建话题失败: ${res.description}`);
    const rec = { thread_id: res.result.message_thread_id, title };
    await kvPut(env, key, JSON.stringify(rec));
    if (userId) {
        await kvPut(env, `thread:${rec.thread_id}`, String(userId));
    }
    return rec;
}

function buildTopicTitle(from) {
    const firstName = (from.first_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
    const lastName = (from.last_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);

    let username = "";
    if (from.username) {
        username = from.username
            .replace(/[^\w]/g, '')
            .substring(0, 20);
    }

    const cleanName = (firstName + " " + lastName)
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const name = cleanName || "User";
    const usernameStr = username ? ` @${username}` : "";

    const title = (name + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);

    return title;
}

async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
    const groupId = msg.media_group_id;
    const key = `mg:${direction}:${groupId}`;
    const item = extractMedia(msg);
    if (!item) {
        await tgCall(env, "copyMessage", withMessageThreadId({
            chat_id: targetChat,
            from_chat_id: msg.chat.id,
            message_id: msg.message_id
        }, threadId));
        return;
    }

    let rec = await cacheGetJSON(key, null);
    if (!rec) {
        rec = {
            direction,
            targetChat,
            threadId: (threadId === null ? undefined : threadId),
            items: [],
            last_ts: Date.now()
        };
    }

    rec.items.push({ ...item, msg_id: msg.message_id });
    rec.last_ts = Date.now();

    await cachePutJSON(key, rec, Math.max(60, CONFIG.MEDIA_GROUP_EXPIRE_SECONDS));
    const p = delaySend(env, key, rec.last_ts);
    if (ctx?.waitUntil) ctx.waitUntil(p);
    else await p;
}

function extractMedia(msg) {
    if (msg.photo && msg.photo.length > 0) {
        const highestResolution = msg.photo[msg.photo.length - 1];
        return {
            type: "photo",
            id: highestResolution.file_id,
            cap: msg.caption || ""
        };
    }

    if (msg.video) {
        return {
            type: "video",
            id: msg.video.file_id,
            cap: msg.caption || ""
        };
    }

    if (msg.document) {
        return {
            type: "document",
            id: msg.document.file_id,
            cap: msg.caption || ""
        };
    }

    if (msg.audio) {
        return {
            type: "audio",
            id: msg.audio.file_id,
            cap: msg.caption || ""
        };
    }
return null;
}


async function delaySend(env, key, ts) {
    await new Promise(r => setTimeout(r, CONFIG.MEDIA_GROUP_DELAY_MS));

    const rec = await cacheGetJSON(key, null);

    if (rec && rec.last_ts === ts) {
        if (!rec.items || rec.items.length === 0) {
            Logger.warn('media_group_empty', { key });
            await cacheDelete(key);
            return;
        }

        const media = rec.items.map((it, i) => {
            if (!it.type || !it.id) {
                Logger.warn('media_group_invalid_item', { key, item: it });
                return null;
            }
            const caption = i === 0 ? (it.cap || "").substring(0, 1024) : "";
            return {
                type: it.type,
                media: it.id,
                caption
            };
        }).filter(Boolean);

        if (media.length > 0) {
            try {
                const result = await tgCall(env, "sendMediaGroup", withMessageThreadId({
                    chat_id: rec.targetChat,
                    media
                }, rec.threadId));

                if (!result.ok) {
                    Logger.error('media_group_send_failed', result.description, {
                        key,
                        mediaCount: media.length
                    });
                } else {
                    Logger.info('media_group_sent', {
                        key,
                        mediaCount: media.length,
                        targetChat: rec.targetChat
                    });
                }
            } catch (e) {
                Logger.error('media_group_send_exception', e, { key });
            }
        }

        await cacheDelete(key);
    }
}

async function logResetOperation(env, adminId, threadId) {
    try {
        const auditPrefix = "audit:reset:";
        let deletedAuditCount = 0;
        let cursor = undefined;
        
        do {
            const result = await kvList(env, { 
                prefix: auditPrefix, 
                cursor,
                limit: CONFIG.KV_DELETE_BATCH_SIZE
            });
            
            const keys = result.keys || [];
            if (keys.length > 0) {
                const deletePromises = keys.map(key => 
                    kvDeletePhysical(env, key.name).catch(e => {
                        Logger.warn('audit_log_delete_failed', e, { key: key.name });
                        return false;
                    })
                );
                
                const results = await Promise.allSettled(deletePromises);
                deletedAuditCount += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
            }
            
            cursor = result.list_complete ? undefined : result.cursor;
            
            if (keys.length > 0) {
                await new Promise(r => setTimeout(r, CONFIG.KV_DELETE_DELAY_MS));
            }
            
            if (deletedAuditCount > CONFIG.KV_OPERATION_MAX_ITEMS) {
                Logger.warn('audit_log_cleanup_max_items', { 
                    deletedCount: deletedAuditCount,
                    maxItems: CONFIG.KV_OPERATION_MAX_ITEMS 
                });
                break;
            }
            
        } while (cursor);
        
        if (deletedAuditCount > 0) {
            Logger.info('all_audit_logs_cleaned', { 
                deletedCount: deletedAuditCount,
                adminId,
                threadId 
            });
        }
        
        Logger.info('resetkv_operation_logged_no_audit', {
            adminId,
            threadId,
            deletedAuditCount
        });
        
    } catch (e) {
        Logger.error('resetkv_log_failed', e, { adminId, threadId });
    }
}



async function resetKVStorage(env, threadId, adminId) {
    const startTime = Date.now();
    let processedKeysCount = 0;
    const batchSize = CONFIG.KV_DELETE_BATCH_SIZE;
    const hardMaxItems = Math.max(CONFIG.KV_OPERATION_MAX_ITEMS, 10000);

    try {
        Logger.info('resetkv_started_v6_9_8g', {
            adminId,
            threadId,
            keepPrefix: "banned:"
        });

        let cursor = undefined;
        let totalListed = 0;
        let totalDeleted = 0;

        do {
            const result = await kvList(env, {
                cursor,
                limit: batchSize
            });

            const keys = result.keys || [];
            if (keys.length === 0) break;

            totalListed += keys.length;

            const deletable = keys
                .map(k => k.name)
                .filter(name => typeof name === "string" && !kvIsBannedKey(name));

            if (deletable.length > 0) {
                const deletePromises = deletable.map(name =>
                    kvDeletePhysical(env, name).catch(e => {
                        Logger.error('resetkv_delete_failed', e, { key: name });
                        return false;
                    })
                );

                const delResults = await Promise.allSettled(deletePromises);
                totalDeleted += delResults.filter(r => r.status === "fulfilled" && r.value !== false).length;
            }

            processedKeysCount += keys.length;

            cursor = result.list_complete ? undefined : result.cursor;

            if (keys.length > 0) {
                await new Promise(r => setTimeout(r, CONFIG.KV_DELETE_DELAY_MS));
            }

            if (processedKeysCount > hardMaxItems) {
                Logger.warn('resetkv_max_items_exceeded', {
                    processedKeysCount,
                    hardMaxItems
                });
                break;
            }
        } while (cursor);

        // 清理内存缓存
        try {
            threadHealthCache.clear();
            topicCreateInFlight.clear();
            adminStatusCache.clear();
            Logger.debug('resetkv_cache_cleared', {
                threadHealthCache: threadHealthCache.size,
                topicCreateInFlight: topicCreateInFlight.size,
                adminStatusCache: adminStatusCache.size
            });
        } catch (cacheError) {
            Logger.error('resetkv_cache_clear_failed', cacheError);
        }

        const duration = Math.round((Date.now() - startTime) / 1000);

        Logger.info('resetkv_storage_completed_v6_9_8g', {
            adminId,
            threadId,
            duration,
            totalListed,
            totalDeleted
        });

        return { processedKeysCount, duration };
    } catch (e) {
        Logger.error('resetkv_failed', e, {
            adminId,
            threadId,
            processedKeysCount
        });
        throw e;
    }
}

async function resetBlacklistStorage(env, threadId, adminId) {
    const startTime = Date.now();
    let processedKeysCount = 0;
    const batchSize = CONFIG.KV_DELETE_BATCH_SIZE;
    const hardMaxItems = Math.max(CONFIG.KV_OPERATION_MAX_ITEMS, 10000);

    const prefixes = ["banned:", "data:banned:"];
    let totalListed = 0;
    let totalDeleted = 0;

    try {
        Logger.info('reset_blacklist_started_v6_9_13g', {
            adminId,
            threadId,
            prefixes
        });

        for (const prefix of prefixes) {
            let cursor = undefined;

            do {
                const result = await kvList(env, {
                    prefix,
                    cursor,
                    limit: batchSize
                });

                const keys = result.keys || [];
                if (keys.length === 0) break;

                totalListed += keys.length;

                const deletable = keys
                    .map(k => k.name)
                    .filter(name => typeof name === "string" && name.startsWith(prefix));

                if (deletable.length > 0) {
                    const deletePromises = deletable.map(name =>
                        kvDeletePhysical(env, name).catch(e => {
                            Logger.error('reset_blacklist_delete_failed', e, { key: name });
                            return false;
                        })
                    );

                    const delResults = await Promise.allSettled(deletePromises);
                    totalDeleted += delResults.filter(r => r.status === "fulfilled" && r.value !== false).length;
                }

                processedKeysCount += keys.length;

                cursor = result.list_complete ? undefined : result.cursor;

                if (keys.length > 0) {
                    await new Promise(r => setTimeout(r, CONFIG.KV_DELETE_DELAY_MS));
                }

                if (processedKeysCount > hardMaxItems) {
                    Logger.warn('reset_blacklist_max_items_exceeded', {
                        processedKeysCount,
                        hardMaxItems
                    });
                    break;
                }
            } while (cursor);
        }

        const duration = Math.round((Date.now() - startTime) / 1000);

        Logger.info('reset_blacklist_completed_v6_9_13g', {
            adminId,
            threadId,
            duration,
            totalListed,
            totalDeleted
        });

        return { processedKeysCount, duration, totalDeleted };
    } catch (e) {
        Logger.error('reset_blacklist_failed', e, {
            adminId,
            threadId,
            processedKeysCount
        });
        throw e;
    }
}
