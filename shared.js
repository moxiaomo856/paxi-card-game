/**
 * Paxi Game Hub - 公共模块
 * 网络配置 / 合约地址 / 交易构建·签名·广播 / 合约查询 / 错误映射 / 工具函数
 *
 * 写法参考 paxi-toolbox 的 shared.js（simulate gas + 分块 base64 + 错误码映射）
 */

// ============================================================
// 合约地址
//
// ⚠️ 游戏合约还没编译部署，所以这里【不写死】，留空占位。
//    合约 instantiate 拿到地址后，任选一种方式填，都不用改代码：
//
//   ① 改下面 DEFAULT_GAME_CONTRACT   ← 正式上线推荐，改一次永久生效
//   ② 访问 index.html?contract=paxi1xxx...
//      （自动记住，之后不带参数打开也一样生效，方便手机上调试）
//   ③ App 内「我的 → 合约地址」填一次
//
//    优先级：URL 参数 > localStorage（②③ 写入的） > ① 的默认值
// ============================================================

/** 游戏合约：合约 instantiate 后把地址填到这里；当前留空，部署后用 ② URL ?contract= 或 ③「我的」填 */
const DEFAULT_GAME_CONTRACT = 'paxi1n6ykwpzl5aandw0233xq42m79u8cemp0t9eh5hxfx8jme9hrkzystrqmg8';

/** TKCC 代币合约（已部署的 PRC-20）。想换或清空：用 ?tkcc=paxi1… 或「钱包 → 添加代币」 */
const DEFAULT_TKCC_CONTRACT = 'paxi1s353hkvev2xtv5076wr5l2v6wy4tl9ph872g0puupakcx2p6rkls8q3vms';

/** Swap 模块地址（Paxi 官方固定值，全链唯一，不要改） */
const SWAP_MODULE = 'paxi1mfru9azs5nua2wxcd4sq64g5nt7nn4n80r745t';

// ---- 地址解析：URL 参数 > localStorage > 默认值 ----
const CONTRACT_LS_PREFIX = 'paxi_hub_contract_';
const ADDR_RE = /^paxi1[a-z0-9]{20,}$/;

function resolveContract(key, fallback) {
  // ① URL 参数：命中则记住，之后裸开也生效
  try {
    const q = new URLSearchParams(location.search).get(key);
    if (q && ADDR_RE.test(q)) {
      try { localStorage.setItem(CONTRACT_LS_PREFIX + key, q); } catch (e) {}
      return q;
    }
  } catch (e) {}
  // ② localStorage
  try {
    const v = localStorage.getItem(CONTRACT_LS_PREFIX + key);
    if (v && ADDR_RE.test(v)) return v;
  } catch (e) {}
  // ③ 代码里的默认值
  return fallback || '';
}

/** 运行时改地址（「我的 → 合约地址」用），写入 localStorage 全站生效 */
function setContract(key, addr) {
  addr = String(addr || '').trim();
  if (!addr) {
    try { localStorage.removeItem(CONTRACT_LS_PREFIX + key); } catch (e) {}
    return false;
  }
  if (!ADDR_RE.test(addr)) throw new Error('地址格式不对，应以 paxi1 开头');
  try { localStorage.setItem(CONTRACT_LS_PREFIX + key, addr); } catch (e) {}
  return true;
}

const CONTRACTS = {
  get game() { return resolveContract('contract', DEFAULT_GAME_CONTRACT); },
  get tkcc() { return resolveContract('tkcc', DEFAULT_TKCC_CONTRACT); },
  swapModule: SWAP_MODULE,
};

/** 是否已经配好游戏合约地址（没配就别发请求，白报错） */
function hasGameContract() {
  return ADDR_RE.test(CONTRACTS.game || '');
}

// ============================================================
// 网络配置
// ============================================================
const NETWORK = {
  rpc: 'https://mainnet-rpc.paxinet.io',
  lcd: 'https://mainnet-lcd.paxinet.io',
  prefix: 'paxi',
  denom: 'upaxi',
  denomDisplay: 'PAXI',
  decimals: 6,
  // 🔴 第十八轮真根因修复（2026-09-18）：paxi-mainnet 链上
  //    minimum_gas_price = 0.05 upaxi/gas
  //    （实测 GET /cosmos/base/node/v1beta1/config ->
  //      {"minimum_gas_price":"0.050000000000000000upaxi"}）
  //
  //    此前这里写 0.025，**低于链下限一半**。会话交易在 CheckTx 的
  //    checkTxFeeWithValidatorMinGasPrices 阶段就被拒（ErrInsufficientFee /
  //    insufficient fees），连 mempool 都进不去 —— 所以会话地址在链上
  //    「一笔交易都查不到」，而前端却只会抛一句含混的"gas 不足"。
  //    主钱包通道一直用 0.05（见 sendTx 里的 gasPrice=0.05），所以它没事。
  gasPrice: '0.05upaxi',
};

/** 无感通道 gas 上限。与主钱包通道一致（实测链上 game 操作 gasUsed 137k~452k，
 *  主钱包通道 600k 从未 out of gas）。此前写 1_500_000 会让每笔手续费翻 2.5 倍，
 *  白白烧掉 Feegrant 的 30 PAXI 额度。 */
const SEAMLESS_GAS_LIMIT = 600_000;

/**
 * 取链上真实的最低 gas 价（upaxi/gas）。
 * 链升级调高 minimum_gas_price 时前端自动跟随，不用再改代码。
 * 查询失败时回落到 NETWORK.gasPrice。
 */
let _minGasPriceCache = null;
async function fetchMinGasPrice() {
  if (_minGasPriceCache) return _minGasPriceCache;
  const fallback = parseFloat(String(NETWORK.gasPrice).replace(/[^0-9.]/g, '')) || 0.05;
  try {
    const r = await lcdGet(`${NETWORK.lcd}/cosmos/base/node/v1beta1/config`);
    if (r.ok) {
      const d = await r.json();
      const v = parseFloat(String(d.minimum_gas_price || '').replace(/[a-z/]+/gi, ''));
      if (v > 0) { _minGasPriceCache = v; return v; }
    }
  } catch (e) {
    console.warn('[fetchMinGasPrice] 查询失败，用兜底值', fallback, e && e.message);
  }
  _minGasPriceCache = fallback;
  return fallback;
}

/**
 * 按链上最低 gas 价算手续费。Math.ceil 只会多给 1 upaxi，
 * 保证算出来的 gasPrice 严格 >= 链下限（浮点 0.05*600000 会得到 30000.000000000004）。
 */
async function computeSeamlessFee(gasLimit = SEAMLESS_GAS_LIMIT) {
  const price = await fetchMinGasPrice();
  return {
    gasLimit,
    gasPrice: price,
    amount: String(Math.ceil(price * gasLimit)),
    denom: NETWORK.denom,
  };
}

/** 会话密钥每日额度（必须 <= 合约的 SESSION_DAILY_LIMIT_CAP）。
 *  1000 万 TKCC/天，与链上 set_session_daily_limit_cap = 1e13 对齐。 */
const SESSION_DAILY_LIMIT = '10000000000000';

// localStorage 键
const LS = {
  sessPriv: 'paxi_hub_sess_priv',
  sessPub: 'paxi_hub_sess_pub',
  sessAddr: 'paxi_hub_sess_addr',
  sessNonce: 'paxi_hub_sess_nonce',
};

// ============================================================
// 代币（原生 PAXI / TKCC / 任意 PRC-20）
// ============================================================
const NATIVE_TOKEN = {
  key: 'native', type: 'native', denom: 'upaxi',
  symbol: 'PAXI', decimals: 6, name: 'Paxi',
};

const TOKEN_LS_KEY = 'paxi_hub_extra_tokens';   // 用户手动添加的 PRC-20 地址

function extraTokens() {
  try { return JSON.parse(localStorage.getItem(TOKEN_LS_KEY) || '[]'); } catch (e) { return []; }
}
function addExtraToken(addr) {
  addr = String(addr || '').trim();
  if (!ADDR_RE.test(addr)) throw new Error('地址格式不对，应以 paxi1 开头');
  const list = extraTokens();
  if (!list.includes(addr)) list.push(addr);
  localStorage.setItem(TOKEN_LS_KEY, JSON.stringify(list));
  return list;
}
function removeExtraToken(addr) {
  const list = extraTokens().filter((a) => a !== addr);
  localStorage.setItem(TOKEN_LS_KEY, JSON.stringify(list));
  return list;
}

const tokenMetaCache = {};   // addr -> { symbol, decimals, name }

/** 拉某个 PRC-20 的 symbol / decimals（cw20 标准的 token_info） */
async function getTokenMeta(addr) {
  if (tokenMetaCache[addr]) return tokenMetaCache[addr];
  let meta = { symbol: shortAddr(addr, 4), decimals: 6, name: '' };
  try {
    const info = await queryTokenInfo(addr);
    meta = {
      symbol: info.symbol || meta.symbol,
      decimals: Number(info.decimals ?? 6),
      name: info.name || '',
    };
  } catch (e) { /* 查不到就显示短地址 + 6 位小数 */ }
  tokenMetaCache[addr] = meta;
  return meta;
}

/**
 * 可用代币列表 = 原生 PAXI + 合约白名单里的 PRC-20 + 配置的 TKCC + 手动添加的
 * 没连上或查询失败也不影响，至少返回原生 PAXI
 */
async function loadTokenList() {
  const addrs = new Set();
  if (CONTRACTS.tkcc) addrs.add(CONTRACTS.tkcc);
  extraTokens().forEach((a) => addrs.add(a));
  try {
    const r = await queryContract({ list_prc20: {} });
    (r.tokens || []).forEach((a) => addrs.add(a));
  } catch (e) {
    console.warn('list_prc20 失败（合约可能是旧版，还没这个接口）', e.message);
  }

  const list = [{ ...NATIVE_TOKEN }];
  for (const addr of addrs) {
    const meta = await getTokenMeta(addr);
    list.push({
      key: 'cw20:' + addr, type: 'cw20', contract: addr,
      symbol: meta.symbol, decimals: meta.decimals, name: meta.name,
    });
  }
  return list;
}

/** 从列表里按 key 找代币，找不到就当原生 */
function findToken(tokens, key) {
  return tokens.find((t) => t.key === key) || tokens[0] || NATIVE_TOKEN;
}

/** 合约内余额（原生走 balance 查询，PRC-20 传 token 地址） */
async function queryGameBalance(token) {
  const r = await queryContract({
    balance: { address: state.wallet.address, token: token.type === 'native' ? null : token.contract },
  });
  return fromRawUnits(r.amount || '0', token.decimals);
}

/** 钱包里的链上余额 */
async function queryWalletBalance(token) {
  if (token.type === 'native') {
    const r = await fetchAPI(`/cosmos/bank/v1beta1/balances/${state.wallet.address}`);
    const c = (r.balances || []).find((x) => x.denom === NETWORK.denom);
    return fromRawUnits(c ? c.amount : '0', token.decimals);
  }
  return fromRawUnits(await queryPrc20Balance(token.contract, state.wallet.address), token.decimals);
}

// ============================================================
// 全局状态
// ============================================================
const state = {
  wallet: null,        // { address, public_key }
  connected: false,
  chainBalance: '0',   // 链上 PAXI
  gameBalance: '0',    // 合约内 PAXI
  tkccBalance: '0',    // 合约内 TKCC
  sessAddr: '',
  sessPubHex: '',
  sessNonce: 0,
  sessInfo: null,      // 链上会话信息
  games: [],           // 合约里的游戏列表
  chainId: '',
  tokens: [],          // 可用代币（原生 + PRC-20）
  selToken: 'native',  // 当前选中的代币 key
  walletBal: '0',      // 当前代币在钱包里的余额
  gameBal: '0',        // 当前代币在合约内的余额
};

// ============================================================
// 工具函数
// ============================================================

/** 分块 base64，避免大交易栈溢出 */
function toBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/**
 * HTML 转义 —— 所有来自链上 / 用户输入、要写进 innerHTML 的字符串都必须过一遍。
 * 防止链上数据（卡名 / 提案名 / token symbol / 错误串）携带 <script> / <img onerror> 造成 XSS。
 * 设计为可安全作用于任意类型（数字 / undefined 都直接转字符串，不会抛错）。
 */
function esc(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
window.esc = esc;

/** "1.5" -> "1500000"（纯字符串 + BigInt，不经过浮点） */
function toRawUnits(amountStr, decimals = 6) {
  const str = String(amountStr || '').trim();
  if (!str || !/^\d*\.?\d*$/.test(str)) return '0';
  const dot = str.indexOf('.');
  let intPart = dot === -1 ? str : str.substring(0, dot) || '0';
  let decPart = dot === -1 ? '' : str.substring(dot + 1);
  if (decPart.length < decimals) decPart = decPart.padEnd(decimals, '0');
  else if (decPart.length > decimals) decPart = decPart.substring(0, decimals);
  try {
    return (BigInt(intPart || '0') * BigInt(10) ** BigInt(decimals) + BigInt(decPart || '0')).toString();
  } catch (e) {
    return '0';
  }
}

/** "1500000" -> "1.5" */
function fromRawUnits(rawStr, decimals = 6) {
  const s = String(rawStr || '0').padStart(decimals + 1, '0');
  const intPart = s.slice(0, -decimals);
  const decPart = s.slice(-decimals).replace(/0+$/, '');
  return decPart ? intPart + '.' + decPart : intPart;
}

function shortAddr(a, n = 6) {
  if (!a) return '';
  return a.length > 16 ? a.slice(0, n + 2) + '…' + a.slice(-n) : a;
}

function showToast(msg, type = '') {
  let wrap = document.getElementById('toastWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toastWrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  // 队列上限 4 条，避免堆叠过多遮挡界面
  while (wrap.children.length > 4) wrap.removeChild(wrap.firstChild);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

/**
 * 密码输入框（用于本地加密会话私钥）。纯 DOM 实现，不依赖任何外部 CSS/库。
 * 返回 Promise<string|null>：用户输入的密码，或取消时 null。
 * 标题/提示本身经过 esc() 处理，避免提示文案被注入。
 */
function promptSecret(title, hint) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.setAttribute('style', 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999');
    overlay.innerHTML =
      '<div style="background:#0f1626;border:1px solid #2a3756;border-radius:14px;padding:18px;width:300px;max-width:90vw;box-shadow:0 10px 40px rgba(0,0,0,.5)">'
      + '<div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:4px">' + esc(title) + '</div>'
      + '<div style="font-size:12px;color:#9fb3d1;margin-bottom:10px;line-height:1.4">' + esc(hint) + '</div>'
      + '<input type="password" id="psInput" style="width:100%;padding:9px 10px;border-radius:8px;border:1px solid #2a3756;background:#0a0f1b;color:#fff;font-size:14px;box-sizing:border-box" placeholder="••••••••" autocomplete="off">'
      + '<div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">'
      + '<button id="psCancel" style="padding:8px 14px;border-radius:8px;border:1px solid #2a3756;background:transparent;color:#9fb3d1;cursor:pointer">取消</button>'
      + '<button id="psOk" style="padding:8px 14px;border-radius:8px;border:none;background:#6ee7b7;color:#052e1e;font-weight:700;cursor:pointer">确定</button>'
      + '</div></div>';
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#psInput');
    const close = (val) => { overlay.remove(); resolve(val); };
    input.focus();
    overlay.querySelector('#psOk').onclick = () => close(input.value);
    overlay.querySelector('#psCancel').onclick = () => close(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') close(input.value);
      else if (e.key === 'Escape') close(null);
    };
  });
}
window.promptSecret = promptSecret;

// ============================================================
// 错误码映射
// ============================================================
const ERROR_CODE_MAP = {
  // 🟢 修正：代码 5 此前标为"消息序列化失败"是误判——CosmWasm 执行回退统一返回代码 5，
  //    真实错误藏在 raw_log 里（如 SanguoMigrationNotAllowed / invalid nonce / already migrated /
  //    insufficient funds），码值本身只当兜底，必须以 raw_log 关键词为准（见 mapError）。
  5: '交易执行失败',
  9: '地址无效',
  11: 'Gas 不足（请调高 Gas Limit）',
  13: '合约内部逻辑错误',
  19: '账户序列号不匹配，请稍后重试',
  20: '签名不匹配',
  22: 'Gas 不足',
  24: '签名无效',
  28: '合约执行失败（业务逻辑报错）',
};

const ERROR_KEYWORDS = [
  [/invalid ?nonce|invalidnonce/i, '会话 nonce 不匹配，已自动同步链上最新值，请重试'],
  [/session.*(not|un).*regist|no session/i, '会话密钥未注册，请先注册会话'],
  [/session.*expire/i, '会话已过期，请重新注册（续期 24 小时）'],
  // 🟡 修正（2026-09-18）：此前用 /insufficient.*(bankroll|fund)/i 会误伤银行模块的
  //    "insufficient funds"（Gas 不足），把它错标成"庄家准备金不足"。
  //    合约自身的 bankroll 错误文案是 "House bankroll insufficient ..."（bankroll 在 insufficient 之前），
  //    必须用更精确的 /house bankroll insufficient/i 才命中，避免与 Gas 错误混淆。
  [/house bankroll insufficient/i, '庄家准备金不足，请联系管理员注资'],
  [/payout.*too.*high|payouttoohigh/i, '派彩超过该游戏上限，请联系管理员调整 max_payout_multiplier'],
  [/daily.*limit|exceed.*limit/i, '超出每日限额'],
  [/below.*min.*bet|minbet/i, '低于最小下注额'],
  [/exceed.*max.*bet|maxbet/i, '超过最大下注额'],
  [/game.*(disabled|not.*enabled)/i, '该游戏已被停用'],
  [/unauthorized|not admin/i, '权限不足'],
  [/out of gas|gas.*exhausted/i, 'Gas 不足'],
  // 🟢 2026-09-18 致命误导修复。此前只有下面那条 /insufficient fund/i，
  //    它把**所有**含 "insufficient funds" 的错误都吞成同一句"Gas 费用不足"，于是：
  //      · 会话账户没钱付 gas（CheckTx 拒收，链上不留痕）
  //          → "spendable balance 0upaxi is smaller than 30000upaxi: insufficient funds"
  //      · 合约内 PAXI 存款不够抽卡
  //          → "Insufficient PAXI: expected 30000000, got 10000000"
  //    两者在界面上长得一模一样，把排查方向整整带偏了一天。
  //    现在按真实来源拆开，且**精确规则必须排在下面的通用规则之前**（命中即 return）。
  [/spendable balance.*is smaller than/i, '手续费支付方余额不足：会话账户没有 PAXI，应由主钱包代付 gas（fee.granter 未生效）'],
  [/insufficient fees/i, '手续费出价低于链上最低 gas 价（0.05 upaxi/gas），请调高 Gas Price'],
  [/Insufficient PAXI:/i, '合约内 PAXI 存款不足（抽卡扣的是合约内部余额，请先在合约内充值）'],
  // 🟡 Gas/费用不足：银行模块 "insufficient funds"（主钱包/代付地址没有 PAXI 付 Gas）。
  //    此前被上面的 bankroll 正则抢标，现已让位给正确文案。
  [/insufficient fund/i, '余额不足（Gas 费用不足，请确认主钱包/代付地址有足够 PAXI）'],
  [/account sequence mismatch/i, '账户序列号不匹配，请稍后重试'],
  [/rejected|denied|cancell?ed/i, '已在钱包中取消'],
  [/timeout|timed out/i, '网络超时，请重试'],
];

function mapError(code, rawLog) {
  // 🟢 已知错误码不再吞掉原始 raw_log：CosmWasm 执行回退统一返回代码 5，
  //    真实错误（如 SanguoMigrationNotAllowed / invalid nonce / already migrated）
  //    藏在 raw_log 里。把 raw_log 一并展示，便于定位（例如老合约迁移"消息序列化失败"实为白名单/已迁移）。
  const base = (code !== undefined && code !== 0 && ERROR_CODE_MAP[code])
    ? `${ERROR_CODE_MAP[code]}（代码 ${code}）`
    : null;
    if (rawLog && typeof rawLog === 'string') {
      for (const [re, msg] of ERROR_KEYWORDS) {
        // 🟢 关键词命中即以 raw_log 结论为准，不再拼 ERROR_CODE_MAP 的兜底前缀
        //    （此前"消息序列化失败（代码5）：庄家准备金不足"前半句是误导）。
        if (re.test(rawLog)) return msg;
      }
    const cleaned = rawLog
      .replace(/^.*?:\s*/, '')          // 去掉 "execute wasm contract failed: " 前缀
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    if (cleaned) return base ? `${base}：${cleaned}` : cleaned;
  }
  return base || (rawLog ? String(rawLog).slice(0, 160) : '未知错误');
}

// ============================================================
// LCD / RPC
// ============================================================
async function fetchAPI(path) {
  // 🟢 带超时：移动端经 LCD 查询偶发挂起（连接不返回也不报错），会导致上层
  //    waitForTx / loadSanguoCards 永久 pending → UI 一直「处理中…」卡死。
  //    这里用 AbortController 强制 15s 上限，超时即抛错，由上层重试/兜底，
  //    绝不无限等待（这是「点升星卡在处理中、不能升星」的根因之一）。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${NETWORK.lcd}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 🟢 带超时的 LCD POST（广播交易用）。移动端 LCD 偶发挂起，未带超时会让签名后
//    的广播步骤永久 pending → 一直「处理中…」。统一用这个助手，15s 必返回或报错。
async function lcdPost(url, bodyObj, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// 🟢 带超时的 LCD GET（查询用，返回 Response 对象）。同上，避免移动端查询挂起
//    导致 verifySeamless / syncFromChain / 取账户 等步骤永久 pending。
async function lcdGet(url, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 查询任意合约（返回反序列化后的 JSON） */
async function queryAnyContract(contractAddr, msg) {
  const b64 = toBase64(new TextEncoder().encode(JSON.stringify(msg)));
  const data = await fetchAPI(
    `/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${encodeURIComponent(b64)}`,
  );
  return data.data ?? data;
}

/** 查询游戏合约 */
async function queryContract(msg) {
  return queryAnyContract(CONTRACTS.game, msg);
}

// 🟢 2026-09-29 P0-4：短 TTL 查询缓存，减少重复 LCD 往返（配置类查询受益最大）。
//   只用于【结构性、会话内不变】的查询（game_config / game_limit / list_games /
//   sanguo_templates / token_info / list_prc20 等）。余额、会话、round 等易变查询
//   仍走 queryContract（不缓存），避免下注后看到过期余额。
const _qCache = new Map();
async function queryContractCached(msg, ttl = 5000) {
  const key = JSON.stringify(msg);
  const now = Date.now();
  const hit = _qCache.get(key);
  if (hit && now - hit.at < ttl) return hit.data;
  const data = await queryContract(msg);
  _qCache.set(key, { at: now, data });
  if (_qCache.size > 200) _qCache.clear(); // 防止内存无限增长
  return data;
}

/** PRC-20：代币元信息 { name, symbol, decimals, total_supply } */
async function queryTokenInfo(tokenContract) {
  return queryAnyContract(tokenContract, { token_info: {} });
}

/** PRC-20：钱包里的链上余额 */
async function queryPrc20Balance(tokenContract, owner) {
  const r = await queryAnyContract(tokenContract, { balance: { address: owner } });
  return r.balance || '0';
}

/** PRC-20：owner 授权给 spender 的额度 */
async function queryPrc20Allowance(tokenContract, owner, spender) {
  try {
    const r = await queryAnyContract(tokenContract, {
      allowance: { owner, spender },
    });
    return r.allowance || '0';
  } catch (e) {
    // 有些实现查不到会直接报错，当作 0
    return '0';
  }
}

/** 取链上最新区块时间（秒）。
 *
 *  round_id = {action}_{blockTime}_{nonce}_{rand}，其中 blockTime 仅用于增强唯一性：
 *  合约验签时直接取消息里下发的 round_id 原值
 *  （games/mod.rs::validate_and_consume_session 第 6 段），并不依赖 env.block.time，
 *  所以缓存若干秒不会影响验签通过。
 *
 *  🟢 修复（低危 3）：原先每个操作都要多一次 HTTP 往返，现缓存 5 秒。
 *  注意：本地时间回落值不进缓存，避免把不准的值固化。
 */
let _blockTimeCache = { t: 0, at: 0 };
const BLOCK_TIME_TTL_MS = 5000;
async function getBlockTime() {
  const now = Date.now();
  if (_blockTimeCache.t && now - _blockTimeCache.at < BLOCK_TIME_TTL_MS) {
    return _blockTimeCache.t;
  }
  try {
    const r = await fetchAPI('/cosmos/base/tendermint/v1beta1/blocks/latest');
    const t = r?.block?.header?.time || r?.result?.block?.header?.time;
    if (t) {
      const s = Math.floor(Date.parse(t) / 1000);
      if (!Number.isNaN(s)) {
        _blockTimeCache = { t: s, at: now };
        return s;
      }
    }
  } catch (e) {
    console.warn('[getBlockTime] 取区块时间失败，回落本地时间', e.message);
  }
  return Math.floor(Date.now() / 1000);
}

async function fetchChainId() {
  if (state.chainId) return state.chainId;
  try {
    const r = await lcdGet(`${NETWORK.rpc}/status`).then((x) => x.json());
    state.chainId = r.result?.node_info?.network || '';
  } catch (e) {}
  if (!state.chainId) {
    const r = await fetchAPI('/cosmos/base/tendermint/v1beta1/node_info');
    state.chainId = r.default_node_info?.network || 'paxi-mainnet';
  }
  return state.chainId;
}

// ============================================================
// 交易：simulate → 签名 → 广播
// ============================================================
function getPubKeyBytes(wallet) {
  const pk = wallet.public_key || wallet.publicKey;
  if (!pk) throw new Error('钱包公钥缺失');
  return typeof pk === 'string' ? fromBase64(pk) : new Uint8Array(pk);
}

/** 空签名模拟，让节点告诉我们真实 gas */
async function simulateGas(messages, memo, accountNumber, sequence, wallet) {
  const pubkeyAny = {
    typeUrl: '/cosmos.crypto.secp256k1.PubKey',
    value: PaxiCosmJS.PubKey.encode({ key: getPubKeyBytes(wallet) }).finish(),
  };
  const dummyGas = 900000;
  const txBody = PaxiCosmJS.TxBody.fromPartial({ messages, memo: memo || '' });
  const authInfo = PaxiCosmJS.AuthInfo.fromPartial({
    signerInfos: [{ publicKey: pubkeyAny, modeInfo: { single: { mode: 1 } }, sequence: BigInt(sequence) }],
    fee: { amount: [PaxiCosmJS.coins('25000', NETWORK.denom)[0]], gasLimit: BigInt(dummyGas) },
  });
  const txRaw = PaxiCosmJS.TxRaw.fromPartial({
    bodyBytes: PaxiCosmJS.TxBody.encode(txBody).finish(),
    authInfoBytes: PaxiCosmJS.AuthInfo.encode(authInfo).finish(),
    signatures: [new Uint8Array(64)],
  });
  const res = await lcdPost(`${NETWORK.lcd}/cosmos/tx/v1beta1/simulate`, { tx_bytes: toBase64(PaxiCosmJS.TxRaw.encode(txRaw).finish()) });
  if (!res.ok) throw new Error(`simulate HTTP ${res.status}`);
  const d = await res.json();
  const gas = d.gas_info?.gas_used || d.gasUsed;
  if (gas && Number(gas) > 0) return Number(gas);
  throw new Error('simulate 无有效 gas');
}

/**
 * 动态估算 gas 上限（复用 simulateGas）：
 *   - 调节点 simulate 拿到真实 gas_used，×1.5 缓冲作为 gas_limit；
 *   - 任何失败（LCD 不可达 / simulate 路由被墙 / 节点不支持）都【静默回退】到 fallback，
 *     绝不阻断广播；fallback 由调用方按操作类型给定（见 sanguo.js 的 SG_GAS_LIMIT 表）。
 * ⚠️ 安全边界：simulate 用零签名跑、跳过验签层，所以【只用于估 gas】，
 *    绝不把它当作"交易合法"的依据——真正的合法性由广播时的钱包签名决定。
 *    这就是之前动态 simulate 漏掉签名层 bug 的根因：当时用 simulate 成功来"证明"
 *    交易能上链，而 simulate 不验签。现已隔离：simulate 成功/失败都不影响广播路径，
 *    签名流程原样保留，simulate 仅在 gas 维度提供精确值。
 */
async function estimateGasLimit(messages, memo = '', fallback = 600_000) {
  try {
    if (!window.paxihub || !window.paxihub.paxi) throw new Error('钱包未就绪');
    const sender = await window.paxihub.paxi.getAddress();
    const acctRes = await lcdGet(`${NETWORK.lcd}/cosmos/auth/v1beta1/accounts/${sender.address}`);
    if (!acctRes.ok) throw new Error(`获取账户失败 HTTP ${acctRes.status}`);
    const acctData = await acctRes.json();
    const acct = acctData.account?.base_account || acctData.account;
    const accountNumber = Number(acct.account_number);
    const sequence = Number(acct.sequence);
    const gasUsed = await simulateGas(messages, memo, accountNumber, sequence, state.wallet);
    const gasLimit = Math.ceil(Number(gasUsed) * 1.5);
    console.log(`[gas] simulate gasUsed=${gasUsed} → limit=${gasLimit} (×1.5 buffer), fee=${Math.ceil(gasLimit * 0.05)}upaxi`);
    return gasLimit;
  } catch (e) {
    console.warn('[gas] simulate 失败，回退固定上限:', e && e.message);
    return Number(fallback) || 600_000;
  }
}

/**
 * 构造一笔 MsgExecuteContract 交易并签名广播
 * @returns txhash
 */
// 🟢 无感签名：execAnyContract 自动分流
//
// 判断规则（无感走会话签名器，否则走主钱包）：
//   1. 会话已注册（state.sessPriv / state.sessAddr 存在）
//   2. Feegrant 有效（主钱包 → 会话地址的授权未过期）
//   3. 非强制主钱包的操作（资产进出 / 管理员 / 授权操作）
async function execAnyContract(contractAddr, msg, funds = [], memo = '', opts = {}) {
  if (!state.connected || !state.wallet) throw new Error('钱包未连接');

  // 🟢 无感通道白名单：只有明确列出的游戏消息才走会话签名，其余一律主钱包
  // （资产进出 / 注册 / 授权 / Swap 等敏感操作默认走主钱包，避免误用会话地址）
  // 🟢 2026-10-14 合并 API 同步：战斗入口已合并为 sanguo_battle_pvp / sanguo_battle_ai，
  //    旧多消息变体（create_pvp/accept_pvp/create_royale/…/ai_battle/ranked_battle）
  //    与已删除入口（提案 4 个、buy_fragments）全部移除——白名单必须与合约
  //    ExecuteMsg 一一对应，否则战斗会静默跌回主钱包签名、无感通道失效。
  const SEAMLESS_VARIANTS = new Set([
    'play', 'sanguo_draw', 'sanguo_claim_reward',
    'sanguo_set_battle_order', 'sanguo_star_up', 'sanguo_decompose',
    'sanguo_upgrade', 'sanguo_craft',
    // 🟢 战斗（合并 API：PVP 单挑/混战 8 动作 + AI 休闲/天梯）
    'sanguo_battle_pvp', 'sanguo_battle_ai',
    // 🟢 老合约迁移也走无感通道：合约 migrate_from_old 同样走 sanguo_auth 会话验签
    //    （action="migrate", spend=0），与抽卡/对战同机制，应享受免密。
    'sanguo_migrate_from_old',
    // 🟢 商店付费：买卡 / 关卡批量提交（带 funds 或内部余额扣款，仍由会话地址发 tx）
    'sanguo_buy_card', 'sanguo_submit_stage_batch',
    // 🆕 体力 / 皮肤 / 赛季通行证 / 每日任务（全部走 sanguo_auth 无感验签）
    'sanguo_buy_stamina', 'sanguo_buy_skin', 'sanguo_buy_season_pass',
    'sanguo_claim_season_tier', 'sanguo_claim_daily_task',
    // 🟢 4A：赠送系统（合约侧已走 sanguo_auth，白名单补齐后享受免密）
    'sanguo_gift_card', 'sanguo_gift_fragments', 'sanguo_gift_skin',
  ]);
  const variantKey = Object.keys(msg)[0] || '';
  const isSeamlessVariant = SEAMLESS_VARIANTS.has(variantKey);

  // 🟢 自动确保无感模式：命中无感白名单时，先尝试一键开通
  //    （首次会弹 1 次主钱包完成会话注册 + Feegrant 授权，之后即免密）。
  //    开通失败不影响主流程，下方 useSession 自动降级为主钱包通道。
  if (isSeamlessVariant) {
    try { await Session.ensureSeamless(); } catch (e) { /* 失败时走主钱包 */ }
  }

  // 🟢 第十八轮修复：无感通道可用性以【链上事实】为准，不再只看 localStorage 标记。
  //    旧实现只看 'paxi_hub_feegrant_expires' 这个本地时间戳，它只能证明
  //    「本机点过开启按钮」，证明不了「链上真的有授权」。标记还在、链上授权
  //    已过期/被撤销时，会先发一笔注定失败的会话交易，再回退主钱包弹窗 ——
  //    用户看到的就是"莫名其妙弹钱包 + 报 gas 不足"。
  //    现在：feegrant 链上有效 → 无感；否则会话账户余额够付 gas → 无感；
  //          两者都没有 → 直接走主钱包，并且把原因说清楚。
  let useSession = false;
  let seamlessReason = '';
  if (isSeamlessVariant && state.sessPriv && state.sessAddr && state.wallet) {
    try {
      const v = await Session.verifySeamless();
      useSession = !!(v && v.ok);
      seamlessReason = (v && v.reason) || '';
    } catch (e) {
      useSession = false;
      seamlessReason = (e && e.message) || '检查失败';
    }
  }

  const sender = useSession ? state.sessAddr : state.wallet.address;

  const value = PaxiCosmJS.MsgExecuteContract.fromPartial({
    sender,
    contract: contractAddr,
    msg: new TextEncoder().encode(JSON.stringify(msg)),
    funds: funds.length ? funds : [],
  });
  const messages = [{
    typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
    value: PaxiCosmJS.MsgExecuteContract.encode(value).finish(),
  }];

  if (useSession) {
    try {
      return await Session.sendTxWithSession(messages, memo, opts.gasLimit);
    } catch (e) {
      const why = (e && e.message) || '未知原因';
      console.warn('[execAnyContract] 无感通道失败，自动 fallback 主钱包:', why);
      // 🟢 回退不再静默：把【链上原始错误】一并抛出，避免再出现"只报一句 gas 不足、
      //    查不出到底哪一步错"的情况（本次排障就是被这种含混提示拖了好几轮）。
      Session._lastSeamlessError = why;
      if (typeof showToast === 'function' && !execAnyContract._fallbackToasted) {
        execAnyContract._fallbackToasted = true;
        try {
          showToast(`无感通道失败，本次改用钱包签名。原因：${why}`, 'error');
        } catch (_) { /* UI 未就绪时忽略 */ }
      }
    }
  } else if (isSeamlessVariant && typeof showToast === 'function'
             && !execAnyContract._skipToasted && seamlessReason) {
    // 根本没走无感通道也没弹钱包提示时，说明是本地判定拦下的，提示一次原因
    execAnyContract._skipToasted = true;
    try { showToast(`本次未走无感通道（${seamlessReason}），改用钱包签名`, 'error'); } catch (_) {}
  }
  return sendTx(messages, memo, opts.gasLimit);
}

/** 执行游戏合约 */
async function execContract(msg, funds = [], memo = '', opts = {}) {
  return execAnyContract(CONTRACTS.game, msg, funds, memo, opts);
}

/**
 * PRC-20 授权：把 amount 授权给游戏合约（deposit 前必须先有 allowance）
 * 已经是 cw20 标准消息，直接发到代币合约
 */
async function approvePrc20(tokenContract, amount, spender) {
  return execAnyContract(tokenContract, {
    increase_allowance: {
      spender: spender || CONTRACTS.game,
      amount: String(amount),
      expires: undefined,   // 不过期
    },
  });
}

/**
 * 通用：构造 + 钱包签名 + 广播（主钱包通道）
 * ✅ 复刻老板旧版 buildAndSendTx 的签名/广播路径（生产验证）
 * ✅ gas 改为【动态 simulate 估算 ×1.5 缓冲】；simulate 不可用时回退到调用方给定
 *    上限（默认 600000 gas，迁移等重操作传更高值），fee 始终 = gasLimit × 0.05
 * ✅ 公钥直接从钱包 paxihub.getAddress() 拿（Uint8Array），不用 state 里缓存的
 *
 * @param {Array} messages  Any[] protobuf 消息数组
 * @param {string} memo    备注
 * @param {number} [gasLimitOpt]  simulate 失败时的回退 gas 上限（由 sanguo.js 按操作类型给定）
 * @returns {Promise<string>} txhash
 */
async function sendTx(messages, memo = '', gasLimitOpt) {
  // 1. chainId —— 🟢 改用 fetchChainId()（带 LCD 兜底 + 默认链 ID），
  //    不再直接 fetch(NETWORK.rpc + '/status')：RPC（26657 端口）在手机钱包浏览器常因
  //    CORS / 端口被墙而失败，会直接让主钱包通道也崩。
  const chainId = await fetchChainId();

  // 2. sender — 直接从 paxihub 拿（和老板旧版一致，确保 public_key 是 Uint8Array）
  const sender = await window.paxihub.paxi.getAddress();
  const senderAddr = sender.address;

  // 3. account + sequence（老板旧版 buildCommon）
  const acctRes = await lcdGet(`${NETWORK.lcd}/cosmos/auth/v1beta1/accounts/${senderAddr}`);
  if (!acctRes.ok) throw new Error(`获取账户失败 HTTP ${acctRes.status}`);
  const acctData = await acctRes.json();
  const acct = acctData.account?.base_account || acctData.account;
  const accountNumber = Number(acct.account_number);
  const sequence = Number(acct.sequence);

  // 4. TxBody
  const txBody = PaxiCosmJS.TxBody.fromPartial({ messages, memo });

  // 5. Fee — 优先动态 simulate 估算真实 gas（×1.5 缓冲），失败回退到调用方给定的
  //    上限（迁移等重操作传更高值，避免 600k 被撑爆；其余玩法走默认 600k）。
  //    ⚠️ 实测 Cosmos 未用完 gas 会退还，实际只按 gasUsed 计费；
  //       但 Feegrant 代付额度按【声明 fee】扣减，所以声明值不宜过大——
  //       动态 simulate 让每笔只声明真实所需，最省代付额度，也不会再 out of gas。
  const gasPrice = 0.05;
  const gasLimit = await estimateGasLimit(messages, memo, Number(gasLimitOpt) || 600_000);
  const feeAmount = Math.ceil(gasLimit * gasPrice);
  const fee = {
    amount: [PaxiCosmJS.coins(String(feeAmount), NETWORK.denom)[0]],
    gasLimit,
  };

  // 6. PubKey Any — 关键！用 sender.public_key（paxihub 返回的是 Uint8Array）
  //    老板旧版：new Uint8Array(sender.public_key)
  const pubkeyBytes = new Uint8Array(sender.public_key);
  const pubkeyAny = {
    typeUrl: '/cosmos.crypto.secp256k1.PubKey',
    value: PaxiCosmJS.PubKey.encode({ key: pubkeyBytes }).finish(),
  };

  // 7. AuthInfo
  const authInfo = PaxiCosmJS.AuthInfo.fromPartial({
    signerInfos: [{
      publicKey: pubkeyAny,
      modeInfo: { single: { mode: 1 } },
      sequence: BigInt(sequence),
    }],
    fee,
  });

  // 8. SignDoc
  const signDoc = PaxiCosmJS.SignDoc.fromPartial({
    bodyBytes: PaxiCosmJS.TxBody.encode(txBody).finish(),
    authInfoBytes: PaxiCosmJS.AuthInfo.encode(authInfo).finish(),
    chainId,
    accountNumber: BigInt(accountNumber),
  });

  // 9. 让钱包签名（DApp 指南 3.4 格式）
  const txObj = {
    bodyBytes: toBase64(signDoc.bodyBytes),
    authInfoBytes: toBase64(signDoc.authInfoBytes),
    chainId,
    accountNumber: signDoc.accountNumber.toString(),
  };
  const result = await window.paxihub.paxi.signAndSendTransaction(txObj);
  if (!result || !result.success) throw new Error(result?.message || '钱包签名失败或被拒绝');

  // 10. 组装 TxRaw + 广播
  const sigBytes = Uint8Array.from(atob(result.success), (c) => c.charCodeAt(0));
  const txRaw = PaxiCosmJS.TxRaw.fromPartial({
    bodyBytes: signDoc.bodyBytes,
    authInfoBytes: signDoc.authInfoBytes,
    signatures: [sigBytes],
  });
  const base64Tx = toBase64(PaxiCosmJS.TxRaw.encode(txRaw).finish());

  const bc = await lcdPost(`${NETWORK.lcd}/cosmos/tx/v1beta1/txs`, { tx_bytes: base64Tx, mode: 'BROADCAST_MODE_SYNC' }).then((r) => r.json());

  // 11. 检查结果
  const tx = bc.tx_response || bc;
  if (tx.code && tx.code !== 0) {
    throw new Error(mapError(tx.code, tx.raw_log));
  }
  if (!tx.txhash) throw new Error(mapError(tx.code || 13, bc.message || tx.raw_log));
  return tx.txhash;
}

/** 轮询上链结果（BROADCAST_MODE_SYNC 只保证进 mempool） */
async function waitForTx(txhash, timeoutMs = 30000) {
  const t0 = Date.now();
  // 🟢 2026-09-29 P0-4：指数退避（1s → 1.5s → 2s → 3s…），减少无意义高频轮询，
  //    首发确认更快、移动端弱网下更省电。
  const delays = [1000, 1500, 2000, 3000, 3000, 3000];
  let attempt = 0;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const d = await fetchAPI(`/cosmos/tx/v1beta1/txs/${txhash}`);
      const tx = d.tx_response || d;
      if (tx && tx.height && parseInt(tx.height) > 0) {
        if (tx.code !== 0) throw new Error(mapError(tx.code, tx.raw_log));
        return tx;
      }
    } catch (e) {
      if (e.message && !/API 404|API 400/.test(e.message)) throw e;
    }
    const wait = delays[Math.min(attempt, delays.length - 1)];
    attempt++;
    if (Date.now() - t0 + wait >= timeoutMs) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error('交易确认超时，请稍后在浏览器中查看该哈希');
}

/** 解析交易事件属性（兼容 base64 编码的 value） */
function parseTxEvents(tx, wantedKeys) {
  const out = {};
  const events = [...(tx.events || [])];
  for (const log of tx.logs || []) events.push(...(log.events || []));

  const decode = (v) => {
    if (v == null) return v;
    try {
      const dec = atob(v);
      // 只有解码后是可打印 ASCII 才采用，避免误判
      if (/^[\x20-\x7e]*$/.test(dec)) return dec;
    } catch (e) {}
    return v;
  };

  for (const ev of events) {
    for (const a of ev.attributes || []) {
      const k = decode(a.key);
      if (wantedKeys.includes(k)) {
        (out[k] = out[k] || []).push(decode(a.value));
      }
    }
  }
  return out;
}

// ============================================================
// bech32 编码（会话地址派生用）
// ============================================================
(function bech32Encode() {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  function polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const b = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  }
  function hrpExpand(hrp) {
    return [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0)
      .concat([...hrp].map((c) => c.charCodeAt(0) & 31));
  }
  function convertBits(data, from, to) {
    let acc = 0, bits = 0, ret = [];
    const maxv = (1 << to) - 1;
    for (const value of data) {
      acc = (acc << from) | value;
      bits += from;
      while (bits >= to) { bits -= to; ret.push((acc >> bits) & maxv); }
    }
    if (bits) ret.push((acc << (to - bits)) & maxv);
    return ret;
  }
  window.bech32Encode = function (hrp, data) {
    const values = hrpExpand(hrp).concat(convertBits(data, 8, 5));
    const chk = polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ 1;
    const checksum = [];
    for (let i = 0; i < 6; i++) checksum.push((chk >> (5 * (5 - i))) & 31);
    // 🔴 修复（致命）：切片偏移原来是 hrp.length + 1。
    //    values = hrpExpand(hrp) + convertBits(data,8,5)，而 hrpExpand 的长度是
    //    **2*len(hrp)+1**（高位部分 len(hrp) 个 + 分隔的 1 个 0 + 低位部分 len(hrp) 个），
    //    bech32 编码要求结果 = hrp + '1' + (去掉 hrpExpand 的 data 部分 + 6 位校验)。
    //    用 len(hrp)+1 会把 (len(hrp)-1) 个 hrpExpand 的残留值混进 data，
    //    导致产出地址校验和非法（实测 hrp='paxi' 时得到 47 字符、polymod≠1），
    //    被 addr_validate 拒绝 → 会话注册失败 → 全站不可玩。
    return hrp + '1' + values.concat(checksum).slice(hrp.length * 2 + 1)
      .map((v) => CHARSET[v]).join('');
  };
})();
