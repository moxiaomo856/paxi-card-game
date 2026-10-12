// 本轮改动（A1+A3+A4+E+R12）：getSessionClient 直接传 Uint8Array 并缓存 + 传 gasPrice；
//   enableSeamlessMode 改用 cosmjs-types Feegrant；sendTxWithSession 修正 Feegrant
//   （granter 必须写进 StdFee，而非 signAndBroadcast 的第 6 个参数——E 修复）；
//   R12：Session.sign 改 async + await；🟢 第十六轮（2026-09-18）真根因修复：
//   noble v2.1.0 sign() 返回 Signature 对象（非 Uint8Array），必须 toCompactRawBytes()
//   再转 hex —— 详见 Session.sign 内注释。
/**
 * 会话密钥 —— 生成 / 存储 / 注册 / 签名 / nonce 链上同步
 *
 * ⚠️ 与合约 src/games/mod.rs::validate_and_consume_session 严格对齐：
 *    签名原文 = "{chain_id}:{contract}:{game_id}:{action}:{round_id}:{amount_or_payout}:{nonce}:{pubkey}"
 *    哈希     = 裸 SHA-256（不是 ADR-36，不要走钱包 signArbitrary）
 *    签名     = secp256k1 compact 64 字节，必须 low-S（Cosmos SDK 强制）
 *
 * 依赖 window.nobleSecp / nobleSha256 / nobleRipemd160（index.html 里的 ESM 注入）
 */

// noble 是异步 ESM，等它就绪 + 🔴 双保险注入 hmacSha256Sync
//   index.html 的 ESM 已经注入了一遍；这里再加一次运行时 fallback，
//   防止 github pages 缓存旧版 HTML 时 nobleSecp.sign() 抛 "etc.hmacSha256Sync not set"。
function waitForNoble(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ready = () => {
      if (!window.nobleSecp || !window.nobleSha256 || !window.nobleRipemd160) return false;
      // 🔴 运行时 fallback：如果 index.html 没注入 hmac，这里补上
      if (!window.nobleSecp.etc?.hmacSha256Sync) {
        // 动态 import hmac（ESM 模块异步加载）
        import('https://cdn.jsdelivr.net/npm/@noble/hashes@1.5.0/hmac/+esm')
          .then(({ hmac }) => {
            window.nobleSecp.etc.hmacSha256Sync = (key, ...msgs) =>
              hmac(window.nobleSha256, key, window.nobleSecp.etc.concatBytes(...msgs));
            console.warn('[noble] hmacSha256Sync fallback injected');
            resolve();
          })
          .catch(() => resolve()); // hmac 导入也失败就只能让后续 sign() 自己报错了
      } else {
        resolve();
      }
      return true;
    };
    if (ready()) return;
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error('加密库加载超时，请检查网络'));
      }
    }, 50);
  });
}

// ---- 会话私钥本地加密（AES-GCM + PBKDF2，密码不落盘、不上链） ----
// ⚠️ 依赖 window.crypto.subtle：安全上下文（https 或 localhost）可用；纯 file:// 打开不可用。
//    作用：私钥在 localStorage 中只以密文存放，XSS 即使读到 localStorage 也拿不到明文，
//    必须先在页面里用密码解锁（解锁后明文短暂留在内存用于签名，关页即清）。
async function deriveKey(passphrase, saltB64) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const salt = fromBase64(saltB64);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
async function encryptPriv(privBytes, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, toBase64(salt));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, privBytes);
  return JSON.stringify({ v: 1, salt: toBase64(salt), iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) });
}
async function decryptPriv(blobStr, passphrase) {
  const o = JSON.parse(blobStr);
  if (!o || o.v !== 1) throw new Error('unsupported key blob');
  const key = await deriveKey(passphrase, o.salt);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(o.iv) }, key, fromBase64(o.ct));
  return new Uint8Array(pt);
}

// 🟢 多钱包支持（2026-09-19）：按钱包地址隔离会话存储。
//   之前 localStorage 是全局单份，切钱包后会沿用别人注册的会话，
//   导致抽卡/对战/奖励全记到别人名下（见 2026-09-18 那次线上事故）。
//   现在每个钱包各自保存/恢复自己的 session 密钥，互不干扰。
function _sk(base) {
  const a = (typeof state !== 'undefined' && state.wallet && state.wallet.address) || '';
  return a ? `${base}__${a}` : base;
}

const Session = {
  async load() {
    const raw = localStorage.getItem(_sk(LS.sessPriv));
    if (!raw) return false;
    if (raw.startsWith('{')) {
      // 加密存储：先保留密文，等 unlock() 用密码解开（内存中私钥保持 null）
      try {
        const o = JSON.parse(raw);
        if (o && o.v === 1) {
          state.encBlob = raw;
          state.sessPriv = null;
          state.legacyPlain = false;
        }
      } catch (e) { /* 解析失败 → 走下方明文兜底 */ }
    }
    if (!state.encBlob) {
      // 兼容旧版：明文 hex 直接读入内存（后续 ensure 会提示升级为加密）
      state.sessPriv = hexToBytes(raw);
      state.legacyPlain = true;
    }
    state.sessPubHex = localStorage.getItem(_sk(LS.sessPub)) || '';
    state.sessAddr = localStorage.getItem(_sk(LS.sessAddr)) || '';
    state.sessNonce = Number(localStorage.getItem(_sk(LS.sessNonce)) || '0');
    return !!(state.sessAddr && state.sessPubHex);
  },

  async generate(pw) {
    await waitForNoble();
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('当前环境不支持 Web Crypto，请用 https 或 localhost 访问（不要用 file:// 直接打开）');
    }
    const priv = window.nobleSecp.utils.randomPrivateKey();
    const pub = window.nobleSecp.getPublicKey(priv, true); // 33 字节压缩
    const pubHex = bytesToHex(pub);
    const h160 = window.nobleRipemd160(window.nobleSha256(pub));
    const addr = window.bech32Encode(NETWORK.prefix, h160);

    state.sessPriv = priv;
    state.sessPubHex = pubHex;
    state.sessAddr = addr;
    state.sessNonce = 0;
    state.legacyPlain = false;
    state.encBlob = null;

    if (pw) {
      // 用密码加密后只落盘密文（推荐路径）
      const blob = await encryptPriv(priv, pw);
      localStorage.setItem(_sk(LS.sessPriv), blob);
      state.encBlob = blob;
    } else {
      // 无密码兜底（不推荐）：仍以明文存储，保持旧行为
      localStorage.setItem(_sk(LS.sessPriv), bytesToHex(priv));
    }
    localStorage.setItem(_sk(LS.sessPub), pubHex);
    localStorage.setItem(_sk(LS.sessAddr), addr);
    localStorage.setItem(_sk(LS.sessNonce), '0');
    return addr;
  },

  /** 用密码解密本地密文到内存（不落盘） */
  async unlock(pw) {
    if (!state.encBlob) return !!state.sessPriv;
    try {
      const priv = await decryptPriv(state.encBlob, pw);
      state.sessPriv = priv;
      return true;
    } catch (e) {
      return false;
    }
  },

  /** 清空内存中的私钥（保留密文，等同退出登录式锁屏） */
  lock() {
    state.sessPriv = null;
  },

  /**
   * ⚠️ 关键：nonce 永远以链上为准。
   * localStorage 只是缓存。一旦偏差（换设备 / 清缓存 / 上笔失败但本地已自增 /
   * 多标签页并发），合约报 InvalidNonce，而失败交易不会回滚本地计数，
   * 结果就是会话永久卡死。所以每次用之前都拉一次真实 nonce。
   */
  async syncFromChain() {
    if (!state.sessAddr) throw new Error('本地没有会话密钥');
    let r;
    try {
      r = await queryContract({ session_info: { session_addr: state.sessAddr } });
    } catch (e) {
      return { registered: false };
    }
    if (!r || !r.info) return { registered: false };

    const info = r.info;
    state.sessNonce = Number(info.nonce);
    state.sessInfo = info;
    localStorage.setItem(_sk(LS.sessNonce), String(state.sessNonce));

    return {
      registered: true,
      pubMatches: info.pubkey === state.sessPubHex,
      expired: Number(info.expires_at) < Math.floor(Date.now() / 1000),
      expiresAt: Number(info.expires_at),
      dailyLimit: info.daily_limit,
      dailyUsed: info.daily_used,
      user: info.user || '',   // 🟢 会话归属（哪个钱包注册的），用于换钱包检测
    };
  },

  async register() {
    if (!state.sessAddr || !state.sessPriv) await this.ensure();
    if (!state.connected) throw new Error('请先连接钱包');
    const hash = await execContract({
      register_session: {
        session_addr: state.sessAddr,
        pubkey_hex: state.sessPubHex,
        daily_limit: SESSION_DAILY_LIMIT,
      },
    });
    await waitForTx(hash);
    await this.syncFromChain();
    return hash;
  },

  buildMessage({ gameId, action, roundId, amountPayout, nonce, extra }) {
    const chainId = state.chainId;
    const parts = [chainId, CONTRACTS.game, gameId, action, roundId, amountPayout, nonce, state.sessPubHex];
    // 🎁 赠送系统：把 extra 绑定串追加为消息第 9 字段，与合约 validate_and_consume_session 完全一致
    if (extra !== undefined && extra !== null && extra !== '') {
      parts.push(extra);
    }
    return parts.join(':');
  },

  /**
   * 裸 SHA-256 + secp256k1，返回 128 hex（64 字节 compact）
   * 🔴 真根因修复（2026-09-18，第十六轮）：@noble/secp256k1@2.1.0 的 sign() 返回的是
   *   **Signature 对象（r/s 两个 BigInt）**，不是 Uint8Array！此前注释误以为 v2 返回
   *   Uint8Array，所以即使补了 await，bytesToHex(Signature 对象) 仍得到空串
   *   （Array.from(非可迭代对象) = []）→ 签名永远为空 → 守卫报"签名为空"。
   *   本机 node + 同版本 2.1.0 复现确认；sig.toCompactRawBytes() → Uint8Array(64)
   *   → 128 hex，lowS 生效，verify 通过。
   *   兼容写法：如果未来换成返回 Uint8Array 的版本/替代实现，直接透传。
   */
  async sign(message) {
    const hash = window.nobleSha256(new TextEncoder().encode(message));
    const sig = await window.nobleSecp.sign(hash, state.sessPriv, { lowS: true });
    // 🟢 1A：防御第三方/未来版本返回 hex string 的极端情况
    //   若 sig 是 string，直接走 hex 校验分支，避免 bytesToHex(string) → 空串
    if (typeof sig === 'string') {
      const s = sig.toLowerCase();
      if (!/^[0-9a-f]{128}$/.test(s)) {
        throw new Error('会话签名格式异常（非 128 位 hex）');
      }
      return s;
    }
    const bytes = (sig instanceof Uint8Array) ? sig : sig.toCompactRawBytes();
    return bytesToHex(bytes);   // Uint8Array(64) compact 签名 → 128 hex
  },

  bumpNonce() {
    state.sessNonce = Number(state.sessNonce) + 1;
    localStorage.setItem(_sk(LS.sessNonce), String(state.sessNonce));
  },

  /**
   * 确保会话可用，不可用则返回原因
   * @returns {{ok:boolean, needRegister:boolean, reason?:string}}
   */
  async ensure() {
    await waitForNoble();
    const loaded = await this.load();

    if (!loaded || state.encBlob) {
      // 🔴 零密码策略（老板旧版模式）：
      //   - 从未创建过会话 → 直接 generate(null)，明文存 localStorage
      //   - 旧版用户有加密 blob（设过密码）→ 清掉密文重新生成，彻底告别密码
      if (state.encBlob) {
        console.warn('[Session] 检测到旧版加密会话，自动清除并重新生成（零密码模式）');
        localStorage.removeItem(_sk(LS.sessPriv));
        state.encBlob = null;
      }
      await this.generate(null);  // null = 明文，不加密
    }

    const chain = await this.syncFromChain();
    if (!chain.registered) return { ok: false, needRegister: true, reason: '会话尚未在链上注册' };
    if (!chain.pubMatches) return { ok: false, needRegister: true, reason: '本地密钥与链上注册的不一致' };
    if (chain.expired) return { ok: false, needRegister: true, reason: '会话已过期，需续期' };
    // 🟢 修复（2026-09-19）：会话归属校验。
    //   localStorage 的 session 是全局单份，不区分钱包。换钱包登录后若沿用旧会话，
    //   合约会把游戏行为（抽卡/对战/奖励）记到【会话注册者】名下，而不是当前钱包 ——
    //   表现为：抽卡"不加卡"、合约余额"不动"、PVP 报 Card not found（校验的是别人的卡）。
    //   现在检测到会话 user ≠ 当前钱包 → 判定 needRegister，由 requireSanguo 自动重新注册绑定。
    const myAddr = state.wallet && state.wallet.address;
    if (myAddr && chain.user && chain.user !== myAddr) {
      return { ok: false, needRegister: true, reason: '会话属于其他钱包，将为当前钱包重新绑定' };
    }
    return { ok: true, needRegister: false, info: chain };
  },
};


// ============================================================================
// 🟢 无感签名核心函数（基于 Feegrant + 会话私钥 + CosmJS Stargate）
//
// 合约侧零改动：
//   - 所有 Play/Sanguo* 入口通过 sanguo_auth / validate_and_consume_session
//     返回 session.user（主钱包）作为 player
//   - info.sender 是谁不影响资产扣减（走 BALANCES[(player, token)]）
//   - payload 里的 session_addr/nonce/signature 保留，用于合约二次验证
//
// 前提条件（用户需先手动做一次）：
//   1. 主钱包 RegisterSession → 合约绑定 session_addr → main_wallet
//   2. 主钱包 MsgGrantAllowance → 授权会话地址用主钱包余额付 gas（7 天）
//
// 之后所有游戏写操作：
//   - sender = 会话地址
//   - feeGranter = 主钱包地址（Feegrant pay gas）
//   - 会话私钥直接签 Cosmos SignDoc（不弹主钱包）
// ============================================================================

// 等待 index.html 中赋值的 window.CosmJSSigning 就绪
function waitForCosmJS(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (window.CosmJSSigning) return resolve();
    const timer = setTimeout(() => reject(new Error('CosmJS 加载超时')), timeoutMs);
    window.addEventListener('cosmjs-ready', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// ============================================================================
// 🟢 第十八轮（2026-09-18）：无感通道可用性判定 —— 一律以【链上事实】为准
//
// 为什么必须改：旧实现用 localStorage 的 'paxi_hub_feegrant_expires' 时间戳
// 当作"Feegrant 有效"的证据。那是本机自己写的，只能证明"这台机器点过按钮"，
// 证明不了"链上真的有授权"。一旦链上授权过期/被撤，前端仍会发一笔注定失败的
// 会话交易，再回退弹主钱包 —— 用户看到的就是"莫名其妙弹钱包 + 报 gas 不足"。
//
// 另外旧注释说「PAXI LCD 不支持 /cosmos/feegrant/v1beta1/*」是误判：
//   实测单点接口 /allowance/{granter}/{grantee} 完全可用；
//   真正不可靠的是列表接口 /allowances/{granter}（恒返回空数组，别信它）。
// ============================================================================

/** 会话账户在链上的原生 PAXI 余额（upaxi 字符串） */
Session.getSessionBalance = async function () {
  if (!state.sessAddr) return '0';
  const r = await lcdGet(`${NETWORK.lcd}/cosmos/bank/v1beta1/balances/${state.sessAddr}`);
  if (!r.ok) throw new Error(`查询会话余额失败 HTTP ${r.status}`);
  const d = await r.json();
  const c = (d.balances || []).find((x) => x.denom === NETWORK.denom);
  return c ? c.amount : '0';
};

/**
 * 链上真实查询 Feegrant（granter = 主钱包，grantee = 会话地址），60 秒缓存
 * @returns {Promise<{ok:boolean, exists:boolean, expiration:number, spendLimit:string, reason:string, unknown:boolean}>}
 */
Session._fgCache = { at: 0, granter: '', data: null };
Session.getFeegrant = async function (force) {
  const granter = state.wallet && state.wallet.address;
  if (!granter || !state.sessAddr) {
    return { ok: false, exists: false, expiration: 0, spendLimit: '0', reason: '主钱包或会话地址未就绪', unknown: false };
  }
  const c = Session._fgCache;
  if (!force && c.data && c.granter === granter && Date.now() - c.at < 60000) return c.data;

  let data;
  try {
    const r = await lcdGet(`${NETWORK.lcd}/cosmos/feegrant/v1beta1/allowance/${granter}/${state.sessAddr}`);
    if (r.ok) {
      const d = await r.json();
      const a = d.allowance;
      if (a) {
        const basic = a.allowance || {};
        const expMs = basic.expiration ? Date.parse(basic.expiration) : 0;
        const limit = (basic.spend_limit || []).find((x) => x.denom === NETWORK.denom);
        const alive = !!expMs && expMs > Date.now() + 60000;   // 至少还剩 1 分钟才算有效
        data = {
          ok: alive,
          exists: true,
          expiration: expMs || 0,
          spendLimit: limit ? limit.amount : '0',
          reason: !expMs ? 'gas 代付授权缺少到期时间（异常数据）'
            : alive ? ''
            : `gas 代付授权已于 ${new Date(expMs).toLocaleString()} 过期`,
          unknown: false,
        };
      } else {
        data = { ok: false, exists: false, expiration: 0, spendLimit: '0', reason: '从未开启 gas 代付（Feegrant）授权', unknown: false };
      }
    } else if (r.status === 404) {
      data = { ok: false, exists: false, expiration: 0, spendLimit: '0', reason: '从未开启 gas 代付（Feegrant）授权', unknown: false };
    } else {
      data = { ok: false, exists: false, expiration: 0, spendLimit: '0', reason: `Feegrant 查询失败 HTTP ${r.status}`, unknown: true };
    }
  } catch (e) {
    // 🟢 网络异常标 unknown（而不是"没有授权"）——否则一次网络抖动就会把
    //    本来可用的无感通道误判关闭，白白弹一次主钱包。
    data = { ok: false, exists: false, expiration: 0, spendLimit: '0', reason: `Feegrant 查询异常：${(e && e.message) || e}`, unknown: true };
  }
  Session._fgCache = { at: Date.now(), granter, data };
  return data;
};

/** upaxi → 人类可读 PAXI 字符串 */
function fmtPaxi(upaxi) {
  try {
    const n = Number(upaxi) / 1e6;
    return String(Number(n.toFixed(6)));
  } catch (e) { return String(upaxi); }
}
Session.fmtPaxi = fmtPaxi;

/**
 * 🟢 无感通道可用性判定（权威版本，会查链，60 秒缓存）
 *   1) 链上 Feegrant 有效（主钱包代付 gas）        → mode='feegrant'
 *   2) 会话账户自身 PAXI 余额 >= 本次手续费        → mode='balance'
 *   3) 两者都不行                                  → ok:false + 人类可读原因
 * @returns {Promise<{ok:boolean, mode:string, reason:string, fee:object, balance:(string|null)}>}
 */
Session.verifySeamless = async function (force) {
  if (!state.sessPriv) return { ok: false, mode: 'none', reason: '本地没有会话私钥（请重新开启无感模式）' };
  if (!state.sessAddr) return { ok: false, mode: 'none', reason: '本地没有会话地址' };
  if (!state.wallet || !state.wallet.address) return { ok: false, mode: 'none', reason: '主钱包未连接' };

  const fee = await computeSeamlessFee();          // shared.js：按链上 minimum_gas_price 算

  const fg = await Session.getFeegrant(force);
  // _forceRegrant：上一次交易被链上以 feegrant 相关原因拒绝（额度用尽/已撤销），
  // 此时即使接口仍显示授权有效也不能再走代付，必须重新授权。
  if (fg.ok && !Session._forceRegrant) return { ok: true, mode: 'feegrant', reason: '', fee, balance: null };

  let balance = '0';
  try { balance = await Session.getSessionBalance(); } catch (e) { /* 查不到当 0 */ }
  if (BigInt(balance) >= BigInt(fee.amount)) {
    return { ok: true, mode: 'balance', reason: '', fee, balance };
  }

  if (Session._forceRegrant) {
    return { ok: false, mode: 'none', reason: 'gas 代付被链上拒绝（额度可能已用尽），需要重新授权无感模式', fee, balance };
  }
  return {
    ok: false,
    mode: 'none',
    reason: fg.unknown
      ? `无法确认 gas 代付状态（${fg.reason}），且会话账户余额仅 ${fmtPaxi(balance)} PAXI，不够付 ${fmtPaxi(fee.amount)} PAXI 手续费`
      : `${fg.reason || '未开启 gas 代付'}，且会话账户余额不足（${fmtPaxi(balance)} PAXI < ${fmtPaxi(fee.amount)} PAXI）`,
    fee,
    balance,
  };
};

/**
 * 🟢 给 fee 挂上 gas 代付方（granter）—— 确定性策略，不依赖 verifySeamless 的 mode。
 *
 *    为什么必须这样：
 *    会话地址只是一个一次性签名 key，余额恒为 0。一旦这笔交易没写 granter，
 *    cosmos-sdk v0.53 的 ante handler 会在 CheckTx 阶段直接拒收，原文是
 *      "spendable balance 0upaxi is smaller than 30000upaxi: insufficient funds"
 *    而 CheckTx 失败【不写入交易索引】，所以链上查不到任何痕迹，前端只看到
 *    一句被关键词表含糊过的"Gas 费用不足"。
 *
 *    策略（🔴 已改为无条件写入）：
 *      只要主钱包地址存在就写 granter，不再依赖任何前置查询的结果。
 *      理由：这个节点的 feegrant 列表接口恒返回空、单点接口偶发超时，
 *      任何"先查再决定"的写法都有可能在抖动时漏写 granter——
 *      而漏写的代价是【无声的 CheckTx 拒收】，链上不留痕迹，最难排查。
 *
 *      若授权其实不存在，节点会明确回 "feegrant not found"，
 *      这是"看得见的失败"，比 "insufficient funds"（会被误读成余额不足）好得多。
 */
Session._attachGranter = async function (fee) {
  const granter = state.wallet && state.wallet.address;
  if (!granter) return fee;

  // 只用于日志，不参与决策（查询失败也照写）
  try {
    const fg = await Promise.race([
      Session.getFeegrant(),
      new Promise((r) => setTimeout(() => r({ unknown: true, reason: '查询超时' }), 6000)),
    ]);
    console.log(`[无感] Feegrant 链上状态：${fg && fg.ok ? '有效（代付可用）' : (fg && fg.unknown ? '未知（' + fg.reason + '）' : '无效')}`);
  } catch (e) {
    console.warn('[无感] Feegrant 查询异常（不影响 granter 写入）:', e && e.message);
  }

  fee.granter = granter;
  return fee;
};

/** 「我的」页用的简化状态：链上 Feegrant 是否有效 */
Session.hasFeegrant = async function () {
  if (!state.sessAddr || !state.wallet) return false;
  const fg = await Session.getFeegrant();
  return !!fg.ok;
};


// 🟢 同步快检（不查链）：只做"值不值得尝试"的粗筛，链上 60 秒缓存由
//    Session.getFeegrant() 负责；execAnyContract 真正用来分流的判定是 verifySeamless()。
//    ⚠️ 不要再用它当"无感已开通"的证据（历史事故就是被这个本地时间戳骗了）。
Session.LS_FEEGRANT = 'paxi_hub_feegrant_expires';
Session.hasFeegrantFlag = function () {
  try {
    const exp = Number(localStorage.getItem(Session.LS_FEEGRANT) || '0');
    if (!exp) return false;                     // 从没点过"开启无感模式"
    if (exp < Date.now()) {                     // 过期则清掉，避免下次误判
      localStorage.removeItem(Session.LS_FEEGRANT);
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
};

// 🟢 自动确保无感模式可用（本页只尝试一次，失败静默回落主钱包通道）
//    用于游戏写操作前：若会话未注册或 Feegrant 未建立，自动调用 enableSeamlessMode
//    （首次会弹 1~2 次主钱包完成 RegisterSession + MsgGrantAllowance，之后即免密）。
//    若自动开通失败（用户取消 / 链不支持 feegrant），置 _seamlessFailedOnce 本页不再重试，
//    让调用方走主钱包通道（仍可用，只是要弹签名）。
Session._seamlessFailedOnce = false;
Session._forceRegrant = false;     // 链上以 feegrant 原因拒过 → 下次必须撤销+重授权
Session.ensureSeamless = async function () {
  // _forceRegrant 时即使本页已放弃过，也要再给一次机会（这是可自动修复的故障）
  if (Session._seamlessFailedOnce && !Session._forceRegrant) return false;
  if (!state.connected || !state.wallet) return false;
  try {
    // 🟢 先用链上事实判断：能用就什么都不做（不查多余接口、绝不弹窗）
    const v = await Session.verifySeamless();
    if (v.ok) return true;

    // 不能用 → 一键开通：RegisterSession + 撤销旧授权/重新授权 + 余额兜底
    //   合并成【一笔交易】，全程只弹一次主钱包（旧实现分 2~3 笔，弹 2~3 次，体验很糟）。
    Session._seamlessFailedOnce = false;
    await Session.enableSeamlessMode();

    const v2 = await Session.verifySeamless(true);
    if (!v2.ok) {
      Session._seamlessFailedOnce = true;   // 开通了却仍不可用（链不支持/被拒），本页不再重试
      Session._lastSeamlessError = v2.reason;
    }
    return v2.ok;
  } catch (e) {
    Session._seamlessFailedOnce = true;     // 用户取消或失败，本页不再自动重试
    Session._lastSeamlessError = (e && e.message) || '未知原因';
    console.warn('[ensureSeamless] 自动开通失败，将走主钱包通道:', Session._lastSeamlessError);
    return false;
  }
};

// 🟢 无感广播（第十七轮，2026-09-18 重写）：彻底去掉对 Tendermint RPC websocket 的依赖。
//
// 旧实现用 SigningStargateClient.connectWithSigner(NETWORK.rpc) 直连 RPC（26657 端口）。
//   问题：手机钱包内置浏览器对 RPC 的 WebSocket/CORS 极不友好，要么连不上、要么广播被拦，
//   结果 sendTxWithSession 抛错 → 上层 execAnyContract 静默回退主钱包（即用户看到的"弹钱包 + gas 不足"）。
//
// 新实现（纯 LCD REST，零 RPC）：
//   1) DirectSecp256k1Wallet.fromKey(会话私钥) 离线持有会话密钥
//   2) SigningStargateClient.offline(wallet) —— 不连任何 RPC
//   3) 账户 accNum/seq 从 LCD REST 取（与主钱包通道同源，移动端可用）
//   4) client.sign(..., explicitSignerData) 离线签 SignDoc（fee.granter = 主钱包 → Feegrant 代付 gas）
//   5) 用 PaxiCosmJS.TxRaw 组装 + 编码 → base64 → POST 到 LCD /cosmos/tx/v1beta1/txs 广播
//
// 为什么能绕过弹钱包？
//   会话私钥本地签 SignDoc，不调用 window.paxihub.paxi.signAndSendTransaction。
// 为什么 gas 由主钱包付？
//   StdFee.granter = 主钱包地址，链上 Feegrant ante handler 据此扣主钱包余额。
Session.sendTxWithSession = async function(messages, memo = '', gasLimitOpt) {
  // 🟢 串行队列：会话账户只有一把 sequence 锁，连续两笔若都取同一 sequence 必冲突。
  //    用 Promise 链串行化。🔴 修复（2026-09-29）：一笔失败后不能让整条队列变成
  //    rejected —— 否则后续所有无感交易全部挂死。改为：把本次 run 单独返回给调用方
  //    （让它拿到真实错误去提示用户），而队列指针用 run.catch(()=>{}) 吞掉错误继续往后走。
  if (!Session._txQueue) Session._txQueue = Promise.resolve();
  const run = Session._txQueue.then(() => Session._sendTxWithSessionCore(messages, memo, gasLimitOpt));
  Session._txQueue = run.catch(() => {}); // 队列继续，错误交给调用方
  return run;
};

Session._sendTxWithSessionCore = async function(messages, memo = '', gasLimitOpt) {
  const CJ = window.CosmJSSigning;
  if (!CJ) throw new Error('CosmJS 未加载（无感签名需要 CosmJS）');
  const { DirectSecp256k1Wallet, SigningStargateClient, GasPrice } = CJ;

  if (!state.wallet || !state.wallet.address) {
    throw new Error('主钱包未连接，无法确认 gas 支付方');
  }
  if (!state.sessPriv) throw new Error('会话私钥未生成');

  // 0. 确保 chainId 正确（优先用已缓存；否则经 LCD 取真实 chainId，最后兜底）
  if (!state.chainId) state.chainId = await fetchChainId();
  const chainId = state.chainId || 'paxi-mainnet';

  // 1. 🔴 决定 gas 由谁付 —— 以链上事实为准（第十八轮）
  //    mode='feegrant'：链上授权有效 → 写 fee.granter，由主钱包余额代付
  //    mode='balance' ：授权无效但会话账户自己有 PAXI → 自己付（仍然免密）
  const v = await Session.verifySeamless();
  if (!v.ok) throw new Error(`无感通道不可用：${v.reason}`);
  let plan = v.fee;

  // 🟢 迁移等重操作可以带更高的 gas 上限（老合约迁移要批量铸造全部卡牌，
  //    管理员钱包有 15 张 → 600k 默认上限会被撑爆报 out of gas）。
  //    这里必须【连同手续费一起重算】：只改 gasLimit 而 fee.amount 仍按 600k 算的话，
  //    链上会判 "insufficient fees"（手续费低于 gasLimit × 链下限 0.05）。
  //    只换 fee plan，不动验签/付费方/granter 逻辑。
  if (gasLimitOpt && Number(gasLimitOpt) > 0) {
    plan = await computeSeamlessFee(Number(gasLimitOpt));
    console.log(`[无感] 本次使用自定义 gas 上限=${plan.gasLimit}，手续费=${plan.amount}${plan.denom}`);
  }

  // 2. 取会话账户 accNum/seq（LCD REST，不走 RPC）
  const acctRes = await lcdGet(`${NETWORK.lcd}/cosmos/auth/v1beta1/accounts/${state.sessAddr}`);
  if (!acctRes.ok) throw new Error(`获取会话账户失败 HTTP ${acctRes.status}`);
  const acctData = await acctRes.json();
  const acct = acctData.account?.base_account || acctData.account;
  if (!acct) throw new Error('会话账户不存在（请先注册会话）');
  const accountNumber = Number(acct.account_number);
  const sequence = Number(acct.sequence);

  // 3. StdFee
  // 🔴 gasPrice 必须 >= 链上 minimum_gas_price（实测 0.05 upaxi/gas）。
  //    此前这里写死 0.025 —— 连 mempool 都进不去，CheckTx 直接
  //    "insufficient fees"。这是无感通道一直失败的真根因。
  const fee = {
    amount: [{ denom: plan.denom, amount: plan.amount }],
    gas: String(plan.gasLimit),
  };
  // 🔴 确定性修复（2026-09-18）：**只要主钱包可用，就无条件写 granter**。
  //    会话地址余额恒为 0（它只是个一次性签名 key，从不持有资金）。一旦漏写
  //    granter，cosmos-sdk v0.53 的 ante handler 会直接报
  //      "spendable balance 0upaxi is smaller than 30000upaxi: insufficient funds"
  //    而 CheckTx 阶段的失败【不会写入交易索引】—— 链上查不到任何痕迹，
  //    前端只会看到一句被关键词表含糊过的"Gas 费用不足"。这一整天就是被它拖住的。
  //    所以这里不看 mode 取值：mode 只是"是否有 better 选择"的建议，
  //    写 granter 本身永远安全（授权不存在时节点会明确报 feegrant 错误，不会误扣钱）。
  await Session._attachGranter(fee);

  // 🔴 最后一道防线：没有 granter 且会话余额付不起时，这笔交易必定被 CheckTx 拒收，
  //    而 CheckTx 失败**不会写进交易索引** —— 发出去等于石沉大海，链上查不到、
  //    前端只剩一句含糊提示。这种情况直接本地拦下，把原因说清楚。
  if (!fee.granter) {
    let bal = '0';
    try { bal = await Session.getSessionBalance(); } catch (e) { bal = '0'; }
    if (BigInt(bal) < BigInt(plan.amount)) {
      throw new Error(
        `无感交易无法支付手续费：会话账户余额 ${fmtPaxi(bal)} PAXI < 需要 ${fmtPaxi(plan.amount)} PAXI，`
        + '且主钱包没有建立 gas 代付授权（granter 为空）。请到「我的」页重新开启无感模式。',
      );
    }
  }
  console.log(
    `[无感] gas 支付方=${fee.granter ? '主钱包代付 ' + fee.granter : '⚠️ 会话自付（余额为 0，必被 CheckTx 拒收）'}`
    + ` | 手续费=${plan.amount}${plan.denom} gas=${plan.gasLimit} @${plan.gasPrice}/gas (链下限)`
    + ` | 判定模式=${v.mode}`,
  );
  if (!fee.granter) {
    console.warn('[无感] 本次交易没有 granter，会话余额为 0 → 预计 CheckTx 阶段被拒且链上不留痕');
  }

  // 4. 离线签名（不连 RPC，也【不走】SigningStargateClient —— 原因见下）
  const wallet = await DirectSecp256k1Wallet.fromKey(state.sessPriv, NETWORK.prefix);
  const sessAccount = (await wallet.getAccounts())[0];
  const sessPubKey = sessAccount && sessAccount.pubkey;      // 33 字节压缩格式
  if (!sessPubKey || sessPubKey.length !== 33) {
    throw new Error('会话公钥异常（期望 33 字节压缩格式）');
  }

  // 🔴 这里【不能】用 SigningStargateClient.sign()，两个致命原因（都已被实验证实）：
  //    ① 它内部走 Registry 编码消息，而默认 Registry 没有 wasm 类型，
  //       传入 bytes 形式的 MsgExecuteContract 会直接抛 "Unregistered type url"，
  //       会话通道从未真正走到过签名这一步，全部静默 fallback 到了主钱包。
  //    ② 即使编码过去，SignerData.pubKey 是可选字段，不传则 SignerInfo 里没有
  //       public_key；会话账户从未上过链（链上 pub_key=null），节点验签时两头
  //       都拿不到 pubkey → 报 "invalid pubkey"，且 CheckTx 拒收不留任何痕迹。
  //    所以这里手工构造全部字节：全部用 UMD 已在链上验证过的编码器，
  //    签名用 DirectSecp256k1Wallet.signDirect（noble，纯本地）。
  //    ⚠️ simulate 会跳过验签层，对照实验测不到这一层——这是它漏网的原因。
  const pubKeyAny = {
    typeUrl: '/cosmos.crypto.secp256k1.PubKey',
    value: new Uint8Array([0x0a, sessPubKey.length, ...sessPubKey]), // proto field1(bytes)
  };

  const bodyBytes = PaxiCosmJS.TxBody.encode(
    PaxiCosmJS.TxBody.fromPartial({ messages, memo }),
  ).finish();

  const authInfo = PaxiCosmJS.AuthInfo.fromPartial({
    signerInfos: [{
      publicKey: pubKeyAny,                          // 🔴 必须带！否则链上 invalid pubkey
      modeInfo: { single: { mode: 1 } },             // SIGN_MODE_DIRECT
      sequence: BigInt(sequence),
    }],
    fee: {
      amount: fee.amount,
      gasLimit: BigInt(fee.gas),
      granter: fee.granter || '',                    // 主钱包代付（Feegrant）
      payer: '',
    },
  });
  const authInfoBytes = PaxiCosmJS.AuthInfo.encode(authInfo).finish();

  // SignDoc 用普通对象传给钱包签名器（CDN proto-signing 内部会做 fromPartial 归一化，
  // 不依赖 UMD/CDN 两套生成代码的 int64 类型差异）
  const { signature } = await wallet.signDirect(state.sessAddr, {
    bodyBytes,
    authInfoBytes,
    chainId,
    accountNumber: accountNumber,                  // number，signDirect 内部归一化
  });
  if (!signature || !signature.signature) throw new Error('会话签名失败（signDirect 无返回）');

  // 5. 组装 TxRaw 并 base64 编码（签名对应的就是上面的 bodyBytes/authInfoBytes）
  const txRaw = PaxiCosmJS.TxRaw.fromPartial({
    bodyBytes,
    authInfoBytes,
    signatures: [fromBase64(signature.signature)],   // CosmJS 返回的 signature 是 base64 串
  });
  const txBase64 = toBase64(PaxiCosmJS.TxRaw.encode(txRaw).finish());

  // 6. LCD REST 广播（BROADCAST_MODE_SYNC：CheckTx 通过即返回，上链确认由 waitForTx 轮询）
  //    🟢 改用带超时的 lcdPost（移动端 LCD 偶发挂起会让广播永久 pending → 一直「处理中…」）
  const res = await lcdPost(`${NETWORK.lcd}/cosmos/tx/v1beta1/txs`, { tx_bytes: txBase64, mode: 'BROADCAST_MODE_SYNC' });
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`广播失败 HTTP ${res.status}：${bodyText.slice(0, 300)}`);
  let txResp;
  try { txResp = JSON.parse(bodyText); } catch (e) {
    throw new Error('广播返回非 JSON：' + bodyText.slice(0, 200));
  }
  const txr = txResp.tx_response || txResp;
  const code = txr && txr.code !== undefined ? Number(txr.code) : 0;
  if (code !== 0) {
    const rawLog = (txr && txr.raw_log) || bodyText.slice(0, 300);
    // 🟢 gas 代付被链上拒绝（额度用尽 / 已被撤销）：标记需要"撤销+重授权"，
    //    并作废 60 秒缓存，否则前端永远认为授权有效、每次都失败一遍。
    if (/feegrant|allowance|fee limit|fee allowance|does not allow to pay/i.test(rawLog)) {
      Session._forceRegrant = true;
      Session._fgCache = { at: 0, granter: '', data: null };
    }
    // 🔴 直接把链上原始错误抛出去。历史上这里走 mapError 的关键词表，把
    //    "insufficient fees"（手续费低于链下限）含糊地吞成一句"gas 费不足"，
    //    导致真因连续几轮都查不出来。诊断阶段宁可难看也要准确。
    throw new Error(`链上拒绝（code=${code}）：${rawLog}`);
  }
  const hash = (txr && txr.txhash) || txResp.txhash;
  if (!hash) throw new Error('广播未返回 txhash：' + bodyText.slice(0, 200));
  return hash;
};

// ============================================================================
// 手写 protobuf 工具
// PaxiCosmJS UMD 的 Registry 里没有 feegrant 的 encoder，所以 MsgGrantAllowance /
// MsgRevokeAllowance 只能手写 wire format。结构固定，实测已在链上成功执行过 4 笔。
// ============================================================================
const _pe = new TextEncoder();

/** 无符号 varint（BigInt，不限制长度） */
function _varint(n) {
  let x = BigInt(n);
  const buf = [];
  while (x > 0x7fn) { buf.push(Number((x & 0x7fn) | 0x80n)); x >>= 7n; }
  buf.push(Number(x));
  return new Uint8Array(buf);
}
/** 长度分隔字段（wiretype 2）：tag = (num<<3)|2 */
function _field(num, val) { return new Uint8Array([(num << 3) | 2, ..._varint(val.length), ...val]); }
/** 字符串字段 */
function _str(num, s) { return _field(num, _pe.encode(s)); }

/**
 * MsgGrantAllowance{ granter=1, grantee=2, allowance=3(Any) }
 *   Any{ type_url=1, value=2 } -> BasicAllowance{ spend_limit=1(repeated Coin), expiration=2(Timestamp) }
 *   Coin{ denom=1, amount=2 } / Timestamp{ seconds=1(varint, wiretype 0) }
 */
function grantAllowanceMsg(granter, grantee, spendLimit = '30000000', days = 7) {
  const secs = Math.floor(Date.now() / 1000) + days * 86400;
  const timestamp = new Uint8Array([0x08, ..._varint(secs)]);        // Timestamp 只有 seconds 字段
  const coinBytes = new Uint8Array([..._str(1, NETWORK.denom), ..._str(2, spendLimit)]);
  const basicBytes = new Uint8Array([..._field(1, coinBytes), ..._field(2, timestamp)]);
  const anyBytes = new Uint8Array([
    ..._str(1, '/cosmos.feegrant.v1beta1.BasicAllowance'),
    ..._field(2, basicBytes),
  ]);
  return {
    typeUrl: '/cosmos.feegrant.v1beta1.MsgGrantAllowance',
    value: new Uint8Array([..._str(1, granter), ..._str(2, grantee), ..._field(3, anyBytes)]),
  };
}

/** MsgRevokeAllowance{ granter=1, grantee=2 } */
function revokeAllowanceMsg(granter, grantee) {
  return {
    typeUrl: '/cosmos.feegrant.v1beta1.MsgRevokeAllowance',
    value: new Uint8Array([..._str(1, granter), ..._str(2, grantee)]),
  };
}

/** bank MsgSend{ from_address=1, to_address=2, amount=3(repeated Coin) } */
function topUpMsg(from, to, amount) {
  const v = PaxiCosmJS.MsgSend.fromPartial({
    fromAddress: from,
    toAddress: to,
    amount: [{ denom: NETWORK.denom, amount: String(amount) }],
  });
  return { typeUrl: PaxiCosmJS.MsgSend.typeUrl, value: PaxiCosmJS.MsgSend.encode(v).finish() };
}

/** 合约 register_session（必须由主钱包 sender 发送） */
function registerSessionMsg() {
  const exec = PaxiCosmJS.MsgExecuteContract.fromPartial({
    sender: state.wallet.address,
    contract: CONTRACTS.game,
    msg: _pe.encode(JSON.stringify({
      register_session: {
        session_addr: state.sessAddr,
        pubkey_hex: state.sessPubHex,
        daily_limit: SESSION_DAILY_LIMIT,
      },
    })),
    funds: [],
  });
  return { typeUrl: PaxiCosmJS.MsgExecuteContract.typeUrl, value: PaxiCosmJS.MsgExecuteContract.encode(exec).finish() };
}

// ============================================================================
// 开启 / 续期无感模式（第十八轮重写）
//
// 旧实现的三个硬伤：
//   ① 分 2~3 笔交易 → 弹 2~3 次主钱包；
//   ② 已存在（哪怕已过期）的 Feegrant 直接重复 grant → 链上报
//      "fee allowance already exists"，整笔失败（历史日志 02:53/03:42/07:01）；
//   ③ 发完不等确认就写 localStorage 标记 → "本地已开通、链上什么都没有"，
//      之后每笔游戏操作都先失败一次再弹钱包。
//
// 现在：按需拼装消息 → 合并成【一笔】交易（一次弹窗）→ 等上链确认 → 链上复核 → 才落标记。
// ============================================================================
Session.enableSeamlessMode = async function () {
  if (!state.wallet || !state.wallet.address) throw new Error('钱包未连接');
  if (!state.sessAddr || !state.sessPriv) await Session.ensure();
  if (!state.sessAddr || !state.sessPriv) throw new Error('会话密钥创建失败，请强制刷新页面后重试');

  const msgs = [];
  const actions = [];

  // ---- ① 合约侧会话注册：只在缺失 / 过期 / 公钥不匹配时才发 ----
  let info = { registered: false };
  try { info = await Session.syncFromChain(); } catch (e) { /* 查不到就当未注册 */ }
  if (!info.registered || info.expired || info.pubMatches === false) {
    msgs.push(registerSessionMsg());
    actions.push('注册会话');
  }

  // ---- ② 链上 Feegrant（gas 代付）----
  //    needGrant：授权缺失/已过期（fg.ok=false），或上次被链上以 feegrant 原因拒绝
  //    （_forceRegrant，典型是额度用尽 —— 接口里查不出来，只能靠拒绝反推）。
  const fg = await Session.getFeegrant(true);
  const needGrant = !fg.ok || Session._forceRegrant;
  if (needGrant) {
    // ⚠️ 已存在的授权必须先撤销：MsgGrantAllowance 对同一个 (granter, grantee)
    //    会直接报 "fee allowance already exists"，整笔交易（含注册/充值）一起失败。
    if (fg.exists) {
      msgs.push(revokeAllowanceMsg(state.wallet.address, state.sessAddr));
      actions.push('撤销旧的 gas 代付授权');
    }
    msgs.push(grantAllowanceMsg(state.wallet.address, state.sessAddr));
    actions.push('授权 gas 代付 7 天');
  }

  // ---- ③ 余额兜底：授权不可用时，让会话账户自己也能付 gas ----
  let bal = '0';
  try { bal = await Session.getSessionBalance(); } catch (e) { /* 当 0 */ }
  const plan = await computeSeamlessFee();
  if (!fg.ok) {
    const need = BigInt(plan.amount) * 30n;          // 至少够 30 笔
    if (BigInt(bal) < need) {
      let top = need - BigInt(bal);
      if (top > 2_000_000n) top = 2_000_000n;        // 单次最多 2 PAXI，别占用户太多钱
      if (top < 500_000n) top = 500_000n;            // 单次最少 0.5 PAXI
      msgs.push(topUpMsg(state.wallet.address, state.sessAddr, top.toString()));
      actions.push(`充值 ${fmtPaxi(top.toString())} PAXI 作 gas 兜底`);
    }
  }

  // ---- ④ 链上已经一切完好：不弹窗、不发交易 ----
  if (!msgs.length) {
    if (fg.ok) localStorage.setItem(Session.LS_FEEGRANT, String(fg.expiration));
    Session._forceRegrant = false;
    return '(already-enabled)';
  }

  // ---- ⑤ 合并成一笔交易 → 全程只弹一次主钱包 ----
  const hash = await sendTx(msgs, 'Seamless setup: ' + actions.join(' + '));

  // 🔴 必须等上链确认。BROADCAST_MODE_SYNC 只保证 CheckTx 通过，
  //    DeliverTx 仍可能失败（gas 不够、合约报错…），旧实现在这里直接写标记，
  //    于是"本地以为开通了、链上其实没有"，后续每笔操作都先失败一次再弹钱包。
  await waitForTx(hash);

  // ---- ⑥ 链上复核通过后，才落本地标记 ----
  Session._forceRegrant = false;
  const after = await Session.verifySeamless(true);
  if (!after.ok) throw new Error(`无感模式开通未生效：${after.reason}`);
  const fg2 = await Session.getFeegrant(true);
  if (fg2.ok) localStorage.setItem(Session.LS_FEEGRANT, String(fg2.expiration));
  else localStorage.removeItem(Session.LS_FEEGRANT);
  return hash;
};

// ============================================================================
// 无感自检：一次性把整条链路的关键状态打印出来（「我的」页有按钮）
// 以后再出问题，看这一份报告就能定位到底断在哪一环，不必再靠猜。
// ============================================================================
Session.selfCheck = async function () {
  // 🟢 2026-09-29：自检条目改走大厅 i18n（hubT 由 app.js 全局提供；session.js 先加载，
  //    故这里做安全兜底，取不到就原样返回 key，不影响功能）。
  const T = (k, ...args) => {
    try {
      if (typeof window !== 'undefined' && typeof window.hubT === 'function') {
        const v = window.hubT(k);
        return typeof v === 'function' ? v(...args) : (v != null ? v : k);
      }
    } catch (e) {}
    return k;
  };
  const r = { build: (typeof window !== 'undefined' && window.HUB_BUILD) || T('sc_unknown'), items: [] };
  const add = (name, ok, detail) => r.items.push({ name, ok: ok === null ? 'warn' : (ok ? 'ok' : 'fail'), detail });

  add(T('sc_build'), !!window.HUB_BUILD, r.build + (window.HUB_BUILD === '20260930-1' ? '' : T('sc_build_old', r.build)));
  add(T('sc_cosmjs'), !!window.CosmJSSigning, window.CosmJSSigning ? T('sc_loaded') : T('sc_notloaded'));
  add(T('sc_noble'), !!(window.nobleSecp && window.nobleSha256 && window.nobleRipemd160), '');
  add(T('sc_wallet'), !!(state.wallet && state.wallet.address), (state.wallet && state.wallet.address) || T('sc_notconnected'));

  let chainId = state.chainId;
  try { chainId = await fetchChainId(); } catch (e) {}
  add(T('sc_chainid'), chainId === 'paxi-mainnet', chainId || T('sc_unknown'));

  let mgp = null;
  try { mgp = await fetchMinGasPrice(); } catch (e) {}
  add(T('sc_mingas'), mgp >= 0.05, T('sc_mingas_detail', mgp));

  const plan = await computeSeamlessFee().catch(() => null);
  add(T('sc_feerate'), !!plan, plan ? T('sc_feerate_detail', plan.amount, plan.denom, plan.gasLimit) : T('sc_calc_fail'));

  add(T('sc_sesskey'), !!state.sessPriv, state.sessPriv ? T('sc_sesskey_detail', shortAddr(state.sessAddr, 10)) : T('sc_sesskey_none'));

  let info = null;
  try { info = await Session.syncFromChain(); } catch (e) {}
  add(T('sc_sessreg'), !!(info && info.registered), info && info.registered
    ? T('sc_sessreg_detail', info.pubMatches, (((info.expiresAt || 0) - Date.now() / 1000) / 3600).toFixed(1), state.sessNonce)
    : T('sc_sessreg_none'));

  let bal = '0';
  try { bal = await Session.getSessionBalance(); } catch (e) {}
  add(T('sc_sessbal'), null, T('sc_sessbal_detail', fmtPaxi(bal)));

  const fg = await Session.getFeegrant(true).catch(() => null);
  add(T('sc_feegrant'), !!(fg && fg.ok), fg
    ? (fg.ok ? T('sc_fg_valid_detail', fmtPaxi(fg.spendLimit), new Date(fg.expiration).toLocaleString())
             : `${fg.reason || T('sc_invalid')}${fg.unknown ? T('sc_fg_unknown') : ''}`)
    : T('sc_fg_queryfail'));

  const v = await Session.verifySeamless(true).catch((e) => ({ ok: false, reason: (e && e.message) || T('sc_exception') }));
  add(T('sc_verdict'), !!v.ok, v.ok
    ? (v.mode === 'feegrant' ? T('sc_verdict_feegrant') : T('sc_verdict_selfpay'))
    : T('sc_verdict_fail', v.reason));

  if (Session._lastSeamlessError) add(T('sc_lasterr'), false, Session._lastSeamlessError);
  return r;
};

/**
 * 🟢 合规版：主钱包 → 会话地址转 PAXI（买卡/买碎片的资金来源）
 *    这是用户偶尔做的一次性操作（会话地址 PAXI 不足时），弹 1 次主钱包。
 *    游戏内购买本身仍走会话免密通道（合约 collect_paxi_payment 优先收 info.funds）。
 * @param {string} amountRaw 原始单位（upaxi）金额
 * @returns {Promise<string>} txhash
 */
Session.topUpSession = async function (amountRaw) {
  if (!state.wallet || !state.sessAddr) throw new Error('尚未连接钱包或会话未初始化');
  const amt = BigInt(amountRaw);
  if (amt <= 0n) throw new Error('充值金额必须大于 0');
  const hash = await sendTx(
    [topUpMsg(state.wallet.address, state.sessAddr, amt.toString())],
    'Top up session PAXI'
  );
  await waitForTx(hash);
  return hash;
};

window.Session = Session;
